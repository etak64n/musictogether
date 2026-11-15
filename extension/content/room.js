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
  const OPTIMISTIC_MS = 2000;
  const RECONNECT_DELAYS = [1, 2, 4, 8, 15, 30]; // seconds
  const REQUEST_TIMEOUT_MS = 10000;
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
        addFromMenu(message.track);
        break;
    }
  });

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
  }

  callChrome(() =>
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.language && pageReady) sendLanguage();
    }),
  );

  // --- server ---

  // The room server from the settings page: its address, which starts with
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

  // A request that has no answer within REQUEST_TIMEOUT_MS fails as "timeout",
  // so that the popup never waits forever. Chrome holds a request to this
  // computer while it asks in the tab whether YouTube Music may reach it, so a
  // server on this computer gets a message that says so. The limit covers the
  // wait for the answer only: the body of an event stream can last for hours.
  async function request(server, path, body, signal) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(server.url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization(server) },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
      });
    } catch (e) {
      if (timeout.signal.aborted) throw new ServerError(isLoopback(server) ? 'timeout_local' : 'timeout');
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
      } else if (e.code === 'bad_request' || e.code === 'room_full' || e.code === 'unauthorized' || (busy && !c.retry)) {
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
      return;
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
    } catch (e) {
      if (conn === c) showNotice(e.code || 'network');
    }
  }

  // A song added from YouTube Music's own menu. The page shows the result,
  // because the popup is usually closed at that moment.
  async function addFromMenu(track) {
    if (!conn || status !== 'connected' || !conn.sessionId) {
      toPage({ type: 'toast', code: 'failed' });
      return;
    }
    const c = conn;
    try {
      await request(c.server, `/api/rooms/${c.roomId}/commands`, { sessionId: c.sessionId, type: 'add', track });
      toPage({ type: 'toast', code: 'added' });
    } catch (e) {
      toPage({ type: 'toast', code: e.code === 'queue_full' ? 'queue_full' : 'failed' });
    }
  }

  // The room plays while anyone listens. Listening again to a room that
  // nobody was listening to starts it, which is shown at once. The server is
  // told even when nothing changed here, in case it missed the last time.
  function setListening(value) {
    if (value && !listening) alignedVideo = '';
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
  function moveSong(itemId, index) {
    if (!room) return;
    if (!canControl()) {
      showNotice('host_only');
      return;
    }
    command({ type: 'move', itemId, index }, (r) => {
      const from = r.queue.findIndex((item) => item.id === itemId);
      if (from < 0) return;
      const [item] = r.queue.splice(from, 1);
      r.queue.splice(Math.min(index, r.queue.length), 0, item);
    });
  }

  const isHost = () => Boolean(room && conn && room.hostId === conn.memberId);
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
    // A listener who paused their own player is left alone until they play again.
    if (!listening) {
      stalledSince = 0;
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
      listening,
      room,
      notice: notice && notice.until > Date.now() ? { id: notice.id, code: notice.code } : null,
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

  function showNotice(code) {
    notice = { id: ++noticeSeq, code, until: Date.now() + NOTICE_MS };
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
        if (!busy) createRoom(message.name);
        break;
      case 'join':
        if (!busy) startJoin(message.roomId, message.name);
        break;
      case 'leave':
        leaveRoom();
        break;
      case 'search':
        startSearch(port, message);
        break;
      case 'add':
        command({ type: 'add', track: message.track });
        break;
      case 'remove':
        command({ type: 'remove', itemId: message.itemId }, (r) => {
          r.queue = r.queue.filter((item) => item.id !== message.itemId);
        });
        break;
      case 'move':
        moveSong(message.itemId, message.index);
        break;
      case 'toggle':
        toggle();
        break;
      case 'next':
        if (!room || !room.current) break;
        if (canControl()) sendNext(room.current.id);
        else showNotice('host_only');
        break;
      case 'participantControl':
        command({ type: 'participantControl', value: Boolean(message.value) }, (r) => {
          r.participantControl = Boolean(message.value);
        });
        break;
      case 'close':
        // Every member, the host included, is told by a "closed" event.
        command({ type: 'close' });
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

  // The service worker asks this tab to leave when another tab joins a room.
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'leave-room') leaveRoom();
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

  // --- start ---

  toPage({ type: 'hello' });

  // A tab that was in a room before the page reloaded joins the room again.
  (async () => {
    try {
      const answer = await chrome.runtime.sendMessage({ type: 'which-room' });
      if (!answer || !answer.roomId) return;
      const { name } = await chrome.storage.local.get('name');
      const server = await loadServer();
      if (name && server) joinRoom(answer.roomId, name, true, server);
    } catch {
      // The extension was reloaded or updated.
    }
  })();
})();
