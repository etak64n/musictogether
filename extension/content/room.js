// Keeps this YouTube Music tab in a Music Together room. It talks to the room
// server, makes the player follow the room's queue and timeline through
// content/page.js, and serves the popup.
(() => {
  'use strict';

  const TO_PAGE = 'musictogether:to-page';
  const TO_CONTENT = 'musictogether:to-content';

  // Player states of the YouTube player API.
  const PLAYING = 1;
  const BUFFERING = 3;

  // How many seconds the player may be off the room's timeline before it is moved.
  const DRIFT_PLAYING = 1.0;
  const DRIFT_PAUSED = 0.5;
  // Right after a song loads, it is lined up once more precisely than that.
  const DRIFT_AFTER_LOAD = 0.25;
  // A song is over for the room when the timeline is this close to its end.
  const END_MARGIN = 0.5;
  // When the player leaves the room's song this close to its end, the song
  // simply finished and YouTube Music moved on.
  const NATURAL_END = 3;

  const LOAD_WAIT_MS = 8000;
  const MAX_LOADS = 3;
  const NEXT_RETRY_MS = 3000;
  const STALL_NOTICE_MS = 5000;
  const NOTICE_MS = 5000;
  // How long the host has to take back ending the room.
  const END_DELAY_MS = 5000;
  const OPTIMISTIC_MS = 2000;
  // A pause of the listener's own takes this long to reach the player, which
  // plays on until then.
  const PAUSE_SETTLE_MS = 2000;
  const RECONNECT_DELAYS = [1, 2, 4, 8, 15, 30]; // seconds
  const REQUEST_TIMEOUT_MS = 10000;
  // How long a request to this computer waits while Chrome asks for the permission.
  const LOOPBACK_PROMPT_MS = 60000;
  const CLOCK_SAMPLES = 5;
  const CLOCK_INTERVAL_MS = 10 * 60 * 1000;

  // Connection
  let conn = null; // { roomId, name, retry, server, controller, sessionId, memberId }
  let status = 'idle'; // idle | connecting | connected | reconnecting
  let busy = false; // creating or joining, until the first answer
  let error = null; // reason code shown in the popup
  let reconnectAttempt = 0;
  let reconnectTimer = 0;
  let clockTimer = 0;
  let clockOffset = 0; // the server's clock minus this browser's clock, in ms
  let clockMeasured = false;

  // Room
  let room = null; // the latest snapshot, with our own changes applied ahead of the server
  let optimistic = null; // { version, at, apply }
  // Whether this tab follows the room. The listener pausing their own player
  // makes it false, and playing again joins the room where it is now.
  let listening = true;
  let pausedAt = 0; // when listening last became false

  // Player
  let page = null; // the latest status from page.js
  let pageReady = false;
  let loading = null; // { videoId, at, count }
  let alignedVideo = ''; // the room's song, once it has been lined up after loading
  let lastOnRoomSong = null; // the player's status the last time it was on the room's song
  let pendingNext = null; // { itemId, at }
  let unplayable = '';
  let stalledSince = 0;
  let stallNoticed = '';

  // Popup
  // The room that an invite link named, while this tab waits for the name or
  // the server to join it.
  let invite = null;
  const ports = new Set();
  const searches = new Map(); // our request ID -> { port, reqId }
  let searchSeq = 0;
  let notice = null; // { id, code, until }
  let noticeSeq = 0;

  class ServerError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  // --- page.js ---

  function toPage(message) {
    document.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(message) }));
  }

  document.addEventListener(TO_CONTENT, (event) => {
    let message;
    try {
      message = JSON.parse(event.detail);
    } catch {
      return;
    }
    switch (message.type) {
      case 'ready':
        pageReady = true;
        sendLanguage();
        sendMenuState();
        if (conn) toPage({ type: 'mode', on: true });
        publish();
        break;
      case 'status':
        page = message.status;
        sync();
        break;
      case 'intent':
        onIntent(message);
        break;
      case 'ended':
        onEnded(message.videoId);
        break;
      case 'search-result':
        deliverSearch(message);
        break;
      case 'menu-add':
        addFromMenu({ track: message.track, list: listOf(message), index: placeOf(message) }, message.source);
        break;
      case 'menu-add-list':
        addFromMenu({ tracks: message.tracks, list: listOf(message), index: placeOf(message) }, message.source);
        break;
      case 'drop-failed':
        showNotice('drop_failed');
        break;
      case 'playlist-created':
        finishPlaylist(message);
        break;
    }
  });

  // Every tab of YouTube Music offers "Add to Music Together" in its menus while
  // a tab of this Chrome is in a room, whether or not it is this tab.
  let browserInRoom = false;

  function sendMenuState() {
    if (pageReady) toPage({ type: 'menu', on: browserInRoom || Boolean(conn) });
  }

  // page.js shows a menu item and short notices in YouTube Music, in the
  // language of the settings. Until the language is set, it is Chrome's:
  // Japanese in a Chrome in Japanese, and English in any other.
  async function sendLanguage() {
    let value;
    try {
      ({ language: value } = await chrome.storage.local.get('language'));
    } catch {
      // The extension was reloaded or updated.
      return;
    }
    if (value !== 'ja' && value !== 'en') value = navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
    toPage({ type: 'language', value });
    labelPipButton(value);
  }

  callChrome(() =>
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.language && pageReady) sendLanguage();
    }),
  );

  // --- server ---

  // The room server from the settings: its address, which starts with
  // https://, or http:// for a server on this computer, and its token. A room
  // keeps the server it was joined on.
  async function loadServer() {
    const { server, token } = await chrome.storage.local.get(['server', 'token']);
    if (typeof server !== 'string' || !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]?)/.test(server)) return null;
    if (typeof token !== 'string' || !token) return null;
    return { url: server, token };
  }

  const authorization = (server) => `Bearer ${server.token}`;

  const isLoopback = (server) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]?/.test(server.url);

  // Chrome lets a page on the internet, such as YouTube Music, reach a server
  // on this computer only with the site's permission "loopback-network". Until
  // it is granted, Chrome holds the request and asks for it in the tab, behind
  // the popup, so a request that times out checks the permission, and the popup
  // tells where to grant it.
  async function loopbackPermission() {
    try {
      return (await navigator.permissions.query({ name: 'loopback-network' })).state;
    } catch {
      // A Chrome without the permission does not hold the request.
      return 'granted';
    }
  }

  // A request that has no answer within REQUEST_TIMEOUT_MS fails as "timeout",
  // so that the popup never waits forever. The limit covers the wait for the
  // answer only: the body of an event stream can last for hours.
  async function request(server, path, body, signal) {
    const loopback = isLoopback(server);
    const permission = loopback ? await loopbackPermission() : 'granted';
    if (permission === 'denied') throw new ServerError('loopback_permission');
    // While Chrome asks, the popup says where to answer, and the request waits longer.
    if (permission === 'prompt' && busy) {
      error = 'loopback_prompt';
      publish();
    }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), permission === 'prompt' ? LOOPBACK_PROMPT_MS : REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(server.url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization(server) },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
        // Chrome requires this mark on a request from an HTTPS page to HTTP on this computer.
        ...(loopback ? { targetAddressSpace: 'loopback' } : {}),
      });
    } catch (e) {
      if (timeout.signal.aborted) {
        if (loopback && (await loopbackPermission()) !== 'granted') throw new ServerError('loopback_permission');
        throw new ServerError('timeout');
      }
      if (e.name === 'AbortError') throw e;
      throw new ServerError('network');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new ServerError(data.error || 'network');
    }
    return response;
  }

  // The room's timeline is in server time. A few round trips tell how far this
  // browser's clock is from the server's; the fastest one is the most accurate.
  async function syncClock(server) {
    let best = null;
    for (let i = 0; i < CLOCK_SAMPLES; i++) {
      const sent = Date.now();
      const response = await fetch(server.url + '/api/time', {
        headers: { Authorization: authorization(server) },
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(isLoopback(server) ? { targetAddressSpace: 'loopback' } : {}),
      });
      if (!response.ok) throw new ServerError('network');
      const { now } = await response.json();
      const received = Date.now();
      if (!best || received - sent < best.rtt) {
        best = { rtt: received - sent, offset: now - (sent + received) / 2 };
      }
    }
    clockOffset = best.offset;
    clockMeasured = true;
  }

  function measureClock() {
    clearTimeout(clockTimer);
    const c = conn;
    if (!c) return;
    syncClock(c.server)
      .catch(() => {})
      .finally(() => {
        if (conn === c && status === 'connected') clockTimer = setTimeout(measureClock, CLOCK_INTERVAL_MS);
      });
  }

  const serverNow = () => Date.now() + clockOffset;

  async function createRoom(name) {
    busy = true;
    error = null;
    publish();
    const server = await loadServer().catch(() => null);
    if (!server) {
      busy = false;
      error = 'no_server';
      publish();
      return;
    }
    let roomId;
    try {
      // The browser that creates the room is its host.
      const response = await request(server, '/api/rooms', { clientId: await getClientId() });
      ({ roomId } = await response.json());
    } catch (e) {
      busy = false;
      error = e.code || 'network';
      publish();
      return;
    }
    await joinRoom(roomId, name, false, server);
  }

  // Joining from the popup uses the server that the popup has just saved.
  async function startJoin(roomId, name) {
    busy = true;
    error = null;
    publish();
    const server = await loadServer().catch(() => null);
    if (!server) {
      busy = false;
      error = 'no_server';
      publish();
      return;
    }
    await joinRoom(roomId, name, false, server);
  }

  async function joinRoom(roomId, name, retry, server) {
    leaveRoom();
    conn = { roomId, name, retry, server, controller: null, sessionId: null, memberId: null };
    status = 'connecting';
    busy = true;
    error = null;
    reconnectAttempt = 0;
    publish();
    await connect(conn);
  }

  async function connect(c) {
    const controller = new AbortController();
    c.controller = controller;
    let response;
    try {
      const clientId = await getClientId();
      response = await request(c.server, `/api/rooms/${c.roomId}/stream`, { clientId, name: c.name, listening }, controller.signal);
    } catch (e) {
      if (conn !== c) return;
      if (e.code === 'room_not_found') {
        endRoom(c, c.sessionId ? 'room_gone' : 'room_not_found');
      } else if (e.code === 'bad_request' || e.code === 'room_full' || e.code === 'unauthorized' || e.code === 'loopback_permission' || (busy && !c.retry)) {
        // A first attempt that fails is reported instead of being retried, and
        // so is a wrong token, which trying again does not fix.
        endRoom(c, e.code || 'network');
      } else {
        scheduleReconnect(c);
      }
      return;
    }
    if (conn !== c) {
      controller.abort();
      return;
    }
    await readStream(c, response.body);
    if (conn === c) scheduleReconnect(c);
  }

  async function readStream(c, body) {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (conn !== c) return;
          handleFrame(c, frame);
        }
      }
    } catch {
      // Cancelled by leaving, or the connection broke; the caller decides what follows.
    }
  }

  function handleFrame(c, frame) {
    let name = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return; // a heartbeat
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (name === 'hello') onHello(c, payload);
    else if (name === 'room') onRoom(payload);
    else if (name === 'closed') endRoom(c, isHost() ? null : 'room_closed');
    // The room server tells of the latest release of Music Together as soon as
    // it finds one, and the service worker keeps it for the popup's notice.
    else if (name === 'release') callChrome(() => chrome.runtime.sendMessage({ type: 'release', version: payload.version, url: payload.url }));
  }

  function onHello(c, hello) {
    c.sessionId = hello.sessionId;
    c.memberId = hello.memberId;
    status = 'connected';
    busy = false;
    error = null;
    reconnectAttempt = 0;
    callChrome(() => chrome.storage.local.set({ lastRoomId: c.roomId }));
    // The service worker counts the queue only for the tab it knows is in the
    // room, so the count is told again once it knows.
    callChrome(() => chrome.runtime.sendMessage({ type: 'room-joined', roomId: c.roomId }).then(() => showQueueCount(true)));
    if (pageReady) toPage({ type: 'mode', on: true });
    measureClock();
    publish();
  }

  function onRoom(snapshot) {
    if (!clockMeasured) clockOffset = snapshot.serverTime - Date.now();
    // A snapshot the server sent before it saw our latest command would undo
    // that command on screen for a moment, so the command is applied again.
    if (optimistic && snapshot.version <= optimistic.version && Date.now() - optimistic.at < OPTIMISTIC_MS) {
      optimistic.apply(snapshot);
    } else {
      optimistic = null;
    }
    const previous = room && room.current ? room.current.id : null;
    room = snapshot;
    const current = room.current ? room.current.id : null;
    if (current !== previous) {
      alignedVideo = '';
      loading = null;
      unplayable = '';
      stalledSince = 0;
      lastOnRoomSong = null;
    }
    if (pendingNext && pendingNext.itemId !== current) pendingNext = null;
    publish();
    sync();
  }

  function scheduleReconnect(c) {
    if (conn !== c) return;
    status = 'reconnecting';
    publish();
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    reconnectAttempt += 1;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (conn === c) connect(c);
    }, delay * 1000);
  }

  function leaveRoom() {
    if (!conn) return;
    const c = conn;
    conn = null;
    if (c.controller) c.controller.abort();
    clearTimeout(reconnectTimer);
    clearTimeout(clockTimer);
    if (ending) clearTimeout(ending.timer);
    ending = null;
    status = 'idle';
    busy = false;
    room = null;
    optimistic = null;
    listening = true;
    loading = null;
    pendingNext = null;
    alignedVideo = '';
    unplayable = '';
    lastOnRoomSong = null;
    stalledSince = 0;
    stallNoticed = '';
    clockMeasured = false;
    if (pageReady) toPage({ type: 'mode', on: false });
    callChrome(() => chrome.runtime.sendMessage({ type: 'room-left' }));
    publish();
  }

  function endRoom(c, code) {
    if (conn !== c) return;
    leaveRoom();
    error = code;
    publish();
  }

  async function command(body, apply) {
    if (!conn || status !== 'connected' || !conn.sessionId) {
      showNotice('disconnected');
      return false;
    }
    const c = conn;
    if (apply && room) {
      optimistic = { version: room.version, at: Date.now(), apply };
      apply(room);
      publish();
      sync();
    }
    try {
      await request(c.server, `/api/rooms/${c.roomId}/commands`, { sessionId: c.sessionId, ...body });
      return true;
    } catch (e) {
      if (conn === c) showNotice(e.code || 'network');
      return false;
    }
  }

  // Songs wait in the queue, or in the standby queue, which plays once the
  // queue is empty. A message names the standby queue as list: 'standby'.
  const listOf = (message) => (message && message.list === 'standby' ? 'standby' : 'queue');
  // The queue is left unnamed, which servers before the standby queue take too.
  const listField = (list) => (list === 'standby' ? { list } : {});
  // A song dropped at a place among the songs carries that place; others go to
  // the end of the queue, or to a random place in the standby queue.
  const placeOf = (message) => (Number.isInteger(message && message.index) && message.index >= 0 ? message.index : undefined);
  const placeField = (songs) => ({ ...listField(songs.list), ...(songs.index === undefined ? {} : { index: songs.index }) });

  // Adds what was chosen in a menu of YouTube Music, in this tab or in another
  // one: { track } for a song, or { tracks } for the songs of an album or a
  // playlist, with the list they go to. Tells how it went as { code, count }:
  // the code is added, partly_added when the list took only some of the songs,
  // queue_full, or failed, and count is the number of songs added.
  async function addSongs(songs) {
    if (!conn || status !== 'connected' || !conn.sessionId) return { code: 'failed', count: 0 };
    const c = conn;
    const list = placeField(songs);
    try {
      if (songs.track) {
        await request(c.server, `/api/rooms/${c.roomId}/commands`, { sessionId: c.sessionId, type: 'add', track: songs.track, ...list });
        return { code: 'added', count: 1 };
      }
      const response = await request(c.server, `/api/rooms/${c.roomId}/commands`, { sessionId: c.sessionId, type: 'addTracks', tracks: songs.tracks, ...list });
      const { added } = await response.json();
      return { code: added < songs.tracks.length ? 'partly_added' : 'added', count: added };
    } catch (e) {
      return { code: e.code === 'queue_full' ? 'queue_full' : 'failed', count: 0 };
    }
  }

  // Songs added from YouTube Music's own menu, or dropped on the popup. The
  // page shows the result of the menu, because the popup is usually closed at
  // that moment; the popup shows the result of a drop.
  async function addFromMenu(songs, source) {
    let result = { code: 'failed', count: 0 };
    if (conn) {
      result = await addSongs(songs);
    } else {
      // A tab outside the room passes the songs to the tab in the room.
      try {
        const answer = await chrome.runtime.sendMessage({ type: 'add-to-room', songs });
        if (answer && answer.code) result = answer;
      } catch {
        // The extension was reloaded or updated.
      }
    }
    const list = listOf(songs);
    if (source !== 'drop') {
      toPage({ type: 'toast', code: result.code, count: result.count, list });
      return;
    }
    const codes = { added: result.count > 1 ? 'drop_added_list' : 'drop_added', partly_added: 'drop_partly_added', queue_full: 'queue_full' };
    const code = codes[result.code] || 'drop_failed';
    showNotice(list === 'standby' && code !== 'drop_failed' ? `${code}_standby` : code, result.count);
  }

  // The room plays while anyone listens. Listening again to a room that
  // nobody was listening to starts it, which is shown at once. The server is
  // told even when nothing changed here, in case it missed the last time.
  function setListening(value) {
    if (value && !listening) alignedVideo = '';
    if (!value) pausedAt = Date.now();
    listening = value;
    if (conn && status === 'connected' && conn.sessionId) {
      command({ type: 'listening', value }, (r) => {
        if (value && r.current && !r.playback.playing) {
          r.playback = { playing: true, position: r.playback.position, updatedAt: serverNow() };
        }
      });
    } else {
      // The next connection says so when it joins.
      publish();
    }
  }

  function seekTo(position) {
    command({ type: 'seek', position }, (r) => {
      if (r.current) r.playback = { playing: r.playback.playing, position, updatedAt: serverNow() };
    });
  }

  // Skipping needs the host or the host's permission.
  function sendNext(itemId) {
    pendingNext = { itemId, at: Date.now() };
    command({ type: 'next', itemId });
  }

  // Reporting that the song finished needs no permission; the server only
  // takes it near the end of the song.
  function sendEnded(itemId) {
    pendingNext = { itemId, at: Date.now() };
    command({ type: 'ended', itemId });
  }

  // Reordering the queue needs the host or the host's permission, as skipping does.
  // The song is taken out and put back at index, so 0 plays it next.
  // A song moves within its list, or to the list that the popup names.
  function moveSong(itemId, index, list) {
    if (!room) return;
    if (!canControl()) {
      showNotice('host_only');
      return;
    }
    const target = list === 'standby' || list === 'queue' ? { list } : {};
    command({ type: 'move', itemId, index, ...target }, (r) => {
      r.standby = r.standby || [];
      const fromName = r.queue.some((item) => item.id === itemId) ? 'queue' : 'standby';
      const from = r[fromName];
      const at = from.findIndex((item) => item.id === itemId);
      if (at < 0) return;
      const [item] = from.splice(at, 1);
      const to = r[target.list || fromName];
      to.splice(Math.min(index, to.length), 0, item);
    });
  }

  // Shuffling the main queue needs the host or the host's permission, as moving does.
  async function shuffleQueue() {
    if (!room || room.queue.length < 2) return;
    if (!canControl()) {
      showNotice('host_only');
      return;
    }
    const c = conn;
    if ((await command({ type: 'shuffle' })) && conn === c) {
      showNotice('queue_shuffled');
    }
  }

  const isHost = () => Boolean(room && conn && room.hostId === conn.memberId);

  // The host ends the room with one click, and the room ends END_DELAY_MS later,
  // so that the host can take it back until then. The others notice nothing
  // in that time. A tab that closes or reloads before then leaves the room as
  // it is.
  let ending = null; // { until, timer }

  function startEnding() {
    if (!conn || status !== 'connected' || !isHost() || ending) return;
    const c = conn;
    const timer = setTimeout(() => {
      if (conn !== c) return;
      ending = null;
      // Every member, the host included, is told by a "closed" event.
      command({ type: 'close' });
      publish();
    }, END_DELAY_MS);
    ending = { until: Date.now() + END_DELAY_MS, timer };
    publish();
  }

  function cancelEnding() {
    if (!ending) return;
    clearTimeout(ending.timer);
    ending = null;
    publish();
  }
  const canControl = () => isHost() || Boolean(room && room.participantControl);

  // --- following the room ---

  function wanted() {
    const item = room && room.current;
    if (!item) return null;
    const { playback } = room;
    let position = playback.position;
    if (playback.playing) position += (serverNow() - playback.updatedAt) / 1000;
    if (item.duration > 0) position = Math.min(position, item.duration);
    return { item, videoId: item.videoId, playing: playback.playing, position: Math.max(0, position) };
  }

  const isPlaying = (state) => state === PLAYING || state === BUFFERING;

  // sync runs whenever the room or the player changes, and makes the player
  // match the room. An idle room leaves the tab alone.
  function sync() {
    if (!conn || status !== 'connected' || !pageReady || !page || !room) return;
    // A listener who paused their own player is left alone until they play
    // again. Playing again counts however the player starts: from the buttons
    // of YouTube Music, from a song held at its end while the room moved on, or
    // from YouTube Music moving on to a song of its own. The tab then plays the
    // room's song where the room is.
    if (!listening) {
      stalledSince = 0;
      if (room.current && page.state === PLAYING && !page.ad && Date.now() - pausedAt > PAUSE_SETTLE_MS) {
        setListening(true);
      }
      return;
    }
    const want = wanted();
    if (!want || page.ad || unplayable === want.videoId) {
      stalledSince = 0;
      return;
    }
    const now = Date.now();

    if (pendingNext && pendingNext.itemId === want.item.id) {
      // Waiting for the server to move the room on.
      if (now - pendingNext.at > NEXT_RETRY_MS) sendEnded(want.item.id);
      return;
    }

    if (page.videoId !== want.videoId) {
      if (page.loading || (loading && loading.videoId === want.videoId && now - loading.at < LOAD_WAIT_MS)) return;
      if (lastOnRoomSong && lastOnRoomSong.videoId === want.videoId) {
        if (lastOnRoomSong.end > 0 && lastOnRoomSong.end - lastOnRoomSong.position < NATURAL_END) {
          onEnded(want.videoId);
          return;
        }
        // The listener started another song; in a room the tab plays the room's song.
        showNotice('returned');
      }
      lastOnRoomSong = null;
      const count = loading && loading.videoId === want.videoId ? loading.count + 1 : 1;
      if (count > MAX_LOADS) {
        markUnplayable(want.videoId);
        return;
      }
      loading = { videoId: want.videoId, at: now, count };
      toPage({ type: 'load', videoId: want.videoId, position: want.position, playing: want.playing });
      return;
    }

    if (!page.playable) {
      markUnplayable(want.videoId);
      return;
    }
    lastOnRoomSong = { videoId: page.videoId, position: page.position, end: page.end };

    const playing = isPlaying(page.state);
    const end = page.end > 0 ? page.end : want.item.duration;
    if (end > 0 && want.position >= end - END_MARGIN) {
      // The song is over on the room's timeline: stop here and let the room move on.
      if (playing) toPage({ type: 'pause' });
      sendEnded(want.item.id);
      return;
    }

    if (want.playing && !playing && !page.held) toPage({ type: 'play' });
    else if (!want.playing && playing) toPage({ type: 'pause' });

    const drift = Math.abs(page.position - want.position);
    if (alignedVideo !== want.videoId) {
      alignedVideo = want.videoId;
      loading = null;
      if (drift > DRIFT_AFTER_LOAD) toPage({ type: 'seek', position: want.position });
    } else if (drift > (want.playing ? DRIFT_PLAYING : DRIFT_PAUSED)) {
      toPage({ type: 'seek', position: want.position });
    }

    watchForStall(want, playing, now);
  }

  // Chrome can refuse to start sound in a tab the listener has not clicked.
  function watchForStall(want, playing, now) {
    if (!want.playing || playing) {
      stalledSince = 0;
      return;
    }
    if (!stalledSince) {
      stalledSince = now;
    } else if (now - stalledSince > STALL_NOTICE_MS && stallNoticed !== want.item.id) {
      stallNoticed = want.item.id;
      showNotice('stalled');
    }
  }

  function markUnplayable(videoId) {
    if (unplayable === videoId) return;
    unplayable = videoId;
    loading = null;
    showNotice('unplayable');
  }

  function onIntent(message) {
    if (!conn || !room || !room.current) return;
    // Pausing and playing are the listener's own and do not stop anyone else.
    // They count while reconnecting too, and the next connection says so.
    if (message.action === 'pause' || message.action === 'play') {
      setListening(message.action === 'play');
      return;
    }
    if (status !== 'connected') return;
    // While paused, moving around in the song is the listener's own too.
    if (message.action === 'seek' && !listening) return;
    // Something done to another song is not about the room.
    if (message.action !== 'next' && message.videoId !== room.current.videoId) return;
    if (!canControl()) {
      // The player goes back to the room's playback on the next sync.
      showNotice('host_only');
      return;
    }
    if (message.action === 'next') sendNext(room.current.id);
    else if (message.action === 'seek') seekTo(message.position);
  }

  function onEnded(videoId) {
    if (!room || !room.current || room.current.videoId !== videoId) return;
    if (pendingNext && pendingNext.itemId === room.current.id) return;
    sendEnded(room.current.id);
  }

  // --- popup ---

  function view() {
    return {
      status,
      busy,
      error,
      roomId: conn ? conn.roomId : null,
      memberId: conn ? conn.memberId : null,
      invite,
      listening,
      room,
      notice: notice && notice.until > Date.now() ? { id: notice.id, code: notice.code, count: notice.count } : null,
      endingUntil: ending ? ending.until : null,
      // The popup's seek bar reads the room's timeline by the server's clock.
      clockOffset,
    };
  }

  // The toolbar button shows how many songs wait in the queue.
  let shownCount = 0;

  function showQueueCount(again) {
    const count = room ? room.queue.length : 0;
    if (count === shownCount && !again) return;
    shownCount = count;
    callChrome(() => chrome.runtime.sendMessage({ type: 'queue-count', count }));
  }

  function publish() {
    showQueueCount(false);
    const message = { type: 'view', view: view() };
    for (const port of ports) {
      try {
        port.postMessage(message);
      } catch {
        ports.delete(port);
      }
    }
  }

  function showNotice(code, count) {
    notice = { id: ++noticeSeq, code, count, until: Date.now() + NOTICE_MS };
    publish();
  }

  // The popup's play button: it pauses only this player, and playing again
  // joins the room where it is now.
  function toggle() {
    if (!room || !room.current) return;
    if (listening && pageReady) toPage({ type: 'pause' });
    setListening(!listening);
  }

  function startSearch(port, message) {
    if (!pageReady) {
      port.postMessage({ type: 'search-result', reqId: message.reqId, error: 'not_ready' });
      return;
    }
    const id = ++searchSeq;
    searches.set(id, { port, reqId: message.reqId });
    toPage({ type: 'search', reqId: id, query: message.query });
  }

  function deliverSearch(message) {
    const entry = searches.get(message.reqId);
    if (!entry) return;
    searches.delete(message.reqId);
    try {
      entry.port.postMessage({ type: 'search-result', reqId: entry.reqId, results: message.results, error: message.error });
    } catch {
      // The popup was closed.
    }
  }

  function onPopupMessage(port, message) {
    switch (message.type) {
      case 'create':
        invite = null;
        if (!busy) createRoom(message.name);
        break;
      case 'join':
        invite = null;
        if (!busy) startJoin(message.roomId, message.name);
        break;
      case 'leave':
        leaveRoom();
        break;
      case 'search':
        startSearch(port, message);
        break;
      case 'add':
        command({ type: 'add', track: message.track, ...listField(message.list) });
        break;
      case 'remove':
        command({ type: 'remove', itemId: message.itemId }, (r) => {
          r.queue = r.queue.filter((item) => item.id !== message.itemId);
          if (r.standby) r.standby = r.standby.filter((item) => item.id !== message.itemId);
        });
        break;
      case 'move':
        moveSong(message.itemId, message.index, message.list);
        break;
      case 'shuffle':
        shuffleQueue();
        break;
      case 'toggle':
        toggle();
        break;
      case 'next':
        if (!room || !room.current) break;
        if (canControl()) sendNext(room.current.id);
        else showNotice('host_only');
        break;
      case 'seek':
        if (!room || !room.current || !Number.isFinite(message.position)) break;
        if (canControl()) seekTo(message.position);
        else showNotice('host_only');
        break;
      case 'participantControl':
        command({ type: 'participantControl', value: Boolean(message.value) }, (r) => {
          r.participantControl = Boolean(message.value);
        });
        break;
      case 'close':
        startEnding();
        break;
      case 'undo-close':
        cancelEnding();
        break;
      case 'save-playlist':
        savePlaylist(port, message);
        break;
      case 'drop':
        {
          // Several songs dropped at a place keep their order from there.
          const start = placeOf(message);
          const items = (Array.isArray(message.items) ? message.items.slice(0, MAX_DROPPED) : []).filter(validDrop);
          items.forEach((item, i) => {
            toPage({ type: 'add-dropped', item, list: listOf(message), index: start === undefined ? undefined : start + i });
          });
        }
        break;
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'popup') return;
    ports.add(port);
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      for (const [id, entry] of searches) {
        if (entry.port === port) searches.delete(id);
      }
    });
    port.onMessage.addListener((message) => onPopupMessage(port, message));
    port.postMessage({ type: 'view', view: view() });
  });

  // The service worker asks this tab to leave when another tab joins a room,
  // tells it whether this Chrome is in a room, and passes it the songs that
  // other tabs add from their menus.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return false;
    if (message.type === 'leave-room') leaveRoom();
    if (message.type === 'room-state') {
      browserInRoom = Boolean(message.inRoom);
      sendMenuState();
    }
    if (message.type === 'add-from-menu') {
      addSongs(message.songs).then(sendResponse);
      return true;
    }
    return false;
  });

  // --- helpers ---

  async function getClientId() {
    const { clientId } = await chrome.storage.local.get('clientId');
    if (clientId) return clientId;
    const created = crypto.randomUUID();
    await chrome.storage.local.set({ clientId: created });
    return created;
  }

  // After the extension is reloaded or updated, this script keeps running but
  // can no longer reach the extension, and chrome.* calls throw.
  function callChrome(fn) {
    try {
      const result = fn();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Nothing to tell anymore.
    }
  }

  // --- saving the songs as a playlist ---

  // Main becomes a playlist of this listener's own YouTube Music: every song
  // that played that the room server keeps, oldest first, the song that plays,
  // and the songs that wait in Main, each once. Standby stays out. page.js
  // makes the playlist, and the popup that asked hears how it went.
  const playlists = new Map(); // our request ID -> { reply, title }
  let playlistSeq = 0;

  async function savePlaylist(port, message) {
    const reply = (fields) => {
      try {
        port.postMessage({ type: 'playlist-result', reqId: message.reqId, ...fields });
      } catch {
        // The popup was closed.
      }
    };
    if (!conn || status !== 'connected' || !conn.sessionId || !pageReady || !room) {
      reply({ error: 'failed' });
      return;
    }
    const c = conn;
    let history;
    try {
      const response = await request(c.server, `/api/rooms/${c.roomId}/history`, { sessionId: c.sessionId });
      ({ history } = await response.json());
    } catch {
      // A server before this request has only the songs that the room sends.
      history = room.history;
    }
    const songs = [...(Array.isArray(history) ? history : []), ...(room.current ? [room.current] : []), ...room.queue];
    const videoIds = [...new Set(songs.map((item) => item.videoId))];
    if (videoIds.length === 0) {
      reply({ error: 'nothing' });
      return;
    }
    const id = ++playlistSeq;
    const title = String(message.title || 'Music Together').slice(0, 150);
    playlists.set(id, { reply, title });
    toPage({ type: 'create-playlist', reqId: id, title, description: String(message.description || ''), videoIds });
  }

  function finishPlaylist(message) {
    const entry = playlists.get(message.reqId);
    if (!entry) return;
    playlists.delete(message.reqId);
    entry.reply(message.playlistId ? { playlistId: message.playlistId, title: entry.title } : { error: 'failed' });
  }

  // --- the window on top ---

  // A button in the top bar of YouTube Music opens Music Together in a window
  // that stays on top of the others: Chrome's picture-in-picture window, which
  // only a click in the page can open. The window shows the popup's page for
  // this tab, and closes with the tab. YouTube Music installed as an app, in a
  // window of its own, has no button: there, the extension's button in the
  // title bar opens the mini window.
  const PIP_BUTTON_ID = 'musictogether-pip-button';
  const PIP_WIDTH = 360;
  const PIP_HEIGHT = 640;
  const PIP_LABELS = {
    ja: 'Music Together を手前の窓で開く',
    en: 'Open Music Together in a window on top',
  };
  const PIP_STYLE = `
    #${PIP_BUTTON_ID} {
      display: inline-grid;
      flex: none;
      place-items: center;
      width: 40px;
      height: 40px;
      margin: 0 4px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: #ffffff;
      cursor: pointer;
    }
    #${PIP_BUTTON_ID}:hover,
    #${PIP_BUTTON_ID}:focus-visible {
      background: rgba(255, 255, 255, 0.1);
      outline: none;
    }
    #${PIP_BUTTON_ID} svg {
      width: 24px;
      height: 24px;
      fill: currentColor;
    }
  `;

  function labelPipButton(language) {
    const button = document.getElementById(PIP_BUTTON_ID);
    const label = PIP_LABELS[language] || PIP_LABELS.en;
    if (button) {
      button.title = label;
      button.setAttribute('aria-label', label);
    }
  }

  // Two beamed eighth notes, the mark of the extension.
  function noteIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const shapes = [
      ['path', { d: 'M9 5.2 19 3.2v3L9 8.2z' }],
      ['rect', { x: '9', y: '7', width: '1.6', height: '10' }],
      ['rect', { x: '17.4', y: '5', width: '1.6', height: '10' }],
      ['ellipse', { cx: '7.9', cy: '17.4', rx: '2.9', ry: '2.2', transform: 'rotate(-20 7.9 17.4)' }],
      ['ellipse', { cx: '16.3', cy: '15.4', rx: '2.9', ry: '2.2', transform: 'rotate(-20 16.3 15.4)' }],
    ];
    for (const [name, attributes] of shapes) {
      const shape = document.createElementNS(ns, name);
      for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
      svg.append(shape);
    }
    return svg;
  }

  // The button sits before the cast button, at the right of the top bar.
  // YouTube Music builds the bar after this script starts, and may build it
  // again, so the bar is watched.
  function placePipButton() {
    const right = document.querySelector('ytmusic-nav-bar #right-content');
    if (!right) return false;
    let button = document.getElementById(PIP_BUTTON_ID);
    if (button && button.parentElement === right) return true;
    if (!button) {
      button = document.createElement('button');
      button.id = PIP_BUTTON_ID;
      button.type = 'button';
      button.append(noteIcon());
      button.addEventListener('click', togglePip);
    }
    const cast = right.querySelector('ytmusic-cast-button');
    right.insertBefore(button, cast || right.firstChild);
    sendLanguage();
    return true;
  }

  function watchTopBar() {
    if (!('documentPictureInPicture' in window)) return;
    const style = document.createElement('style');
    style.textContent = PIP_STYLE;
    document.head.append(style);
    const timer = setInterval(() => {
      if (!placePipButton()) return;
      clearInterval(timer);
      new MutationObserver(() => placePipButton()).observe(document.querySelector('ytmusic-nav-bar'), { childList: true, subtree: true });
    }, 500);
  }

  // A second click closes the window. The window opens at once, while the
  // click still allows it, and gets the popup's page once the tab's ID is known.
  async function togglePip() {
    if (documentPictureInPicture.window) {
      documentPictureInPicture.window.close();
      return;
    }
    let pip;
    try {
      pip = await documentPictureInPicture.requestWindow({ width: PIP_WIDTH, height: PIP_HEIGHT });
    } catch {
      return;
    }
    let tabId;
    try {
      ({ tabId } = await chrome.runtime.sendMessage({ type: 'which-tab' }));
    } catch {
      pip.close();
      return;
    }
    const doc = pip.document;
    doc.title = 'Music Together';
    const style = doc.createElement('style');
    style.textContent = 'html, body { height: 100%; margin: 0; background: #f6f7f5; } iframe { display: block; width: 100%; height: 100%; border: 0; }';
    const frame = doc.createElement('iframe');
    frame.src = `${chrome.runtime.getURL('popup/popup.html')}?pip=1&tab=${tabId}`;
    frame.allow = 'clipboard-write';
    doc.head.append(style);
    doc.body.append(frame);
  }

  // --- dropped songs ---

  // The popup passes what was dropped on it: songs by their IDs, playlists by
  // theirs, and albums by the IDs of their pages, which the page script turns
  // into their lists of songs.
  const MAX_DROPPED = 20;

  function validDrop(item) {
    if (!item || typeof item !== 'object') return false;
    if (typeof item.videoId === 'string') return /^[A-Za-z0-9_-]{11}$/.test(item.videoId);
    if (typeof item.playlistId === 'string') return /^[A-Za-z0-9_-]{2,64}$/.test(item.playlistId);
    if (typeof item.browseId === 'string') return /^MPREb_[A-Za-z0-9_-]+$/.test(item.browseId);
    return false;
  }

  // --- invite links ---

  // An invite link opens YouTube Music with the room's ID in the address, as in
  // https://music.youtube.com/?musictogether=K7QMX. YouTube Music takes it out
  // of the address before this script runs, so content/invite.js, which runs
  // first, leaves it here.
  const ROOM_ID_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/;

  function takeInvite() {
    const value = typeof globalThis.musictogetherInvite === 'string' ? globalThis.musictogetherInvite : '';
    delete globalThis.musictogetherInvite;
    const roomId = value.toUpperCase().replace(/[^0-9A-Z]/g, '');
    return ROOM_ID_PATTERN.test(roomId) ? roomId : null;
  }

  // --- start ---

  toPage({ type: 'hello' });
  // An app's window shows the page in another display mode than the browser's.
  if (matchMedia('(display-mode: browser)').matches) watchTopBar();
  else callChrome(() => chrome.runtime.sendMessage({ type: 'app-window' }));

  // A tab opened from an invite link joins that room under the name and with the
  // server of the settings. Without them, the popup's lobby shows the room until
  // the name is entered and Join is clicked. A tab that was in a room before the
  // page reloaded joins the room again.
  (async () => {
    const invited = takeInvite();
    try {
      const answer = await chrome.runtime.sendMessage({ type: 'which-room' });
      browserInRoom = Boolean(answer && answer.inRoom);
      sendMenuState();
      const roomId = invited || (answer && answer.roomId);
      if (!roomId) return;
      const { name } = await chrome.storage.local.get('name');
      const server = await loadServer();
      if (name && server) {
        joinRoom(roomId, name, !invited, server);
      } else if (invited) {
        invite = invited;
        publish();
      }
    } catch {
      // The extension was reloaded or updated.
    }
  })();
})();
