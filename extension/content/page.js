// Runs in YouTube Music's own JavaScript world, where the player API can be
// reached. It drives the player for content/room.js and reports what the
// player does. The two scripts talk through DOM events that carry JSON strings.
(() => {
  'use strict';

  const TO_PAGE = 'musictogether:to-page';
  const TO_CONTENT = 'musictogether:to-content';

  // The search filter behind YouTube Music's "Songs" chip.
  const SONGS_FILTER = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';

  // Player states of the YouTube player API.
  const ENDED = 0;
  const PLAYING = 1;
  const PAUSED = 2;

  // Pausing this long before the end keeps YouTube Music from moving on to a
  // song of its own choosing. The room decides what plays next.
  const HOLD_BEFORE_END = 0.3;
  // A position that moves this many seconds more or less than the clock did is a seek.
  const SEEK_JUMP = 1.5;
  // State changes this soon after one of our own commands are its result,
  // not something the listener did.
  const OWN_WINDOW_MS = 1500;
  const LOAD_TIMEOUT_MS = 8000;
  const TICK_MS = 500;

  const TIME_PATTERN = /^\d+(?::\d{2}){1,2}$/;

  const MENU_ITEM_CLASS = 'musictogether-menu-item';
  const TOAST_ID = 'musictogether-toast';
  const TOAST_MS = 3000;
  // The words that this script shows, in each language of the extension.
  // content/room.js says which language, from the settings.
  const STRINGS = {
    ja: {
      menu: 'Music Together に追加',
      added: 'Music Together のキューに追加しました',
      queue_full: 'Music Together のキューがいっぱいです',
      failed: 'Music Together に追加できませんでした',
    },
    en: {
      menu: 'Add to Music Together',
      added: 'Added to the queue of Music Together',
      queue_full: 'The queue of Music Together is full',
      failed: 'Could not add the song to Music Together',
    },
  };
  let strings = STRINGS.en;

  // Styles for the menu item and the toast. The menu item copies the size of
  // YouTube Music's own menu items.
  const STYLE = `
    .${MENU_ITEM_CLASS} {
      display: flex;
      align-items: center;
      height: 48px;
      padding: 0 8px;
      color: #ffffff;
      font: 14px/22.4px Roboto, "Noto Naskh Arabic UI", Arial, sans-serif;
      cursor: pointer;
      outline: none;
    }
    .${MENU_ITEM_CLASS}:hover,
    .${MENU_ITEM_CLASS}:focus-visible {
      background: rgba(255, 255, 255, 0.1);
    }
    .${MENU_ITEM_CLASS} svg {
      flex: none;
      width: 18px;
      height: 18px;
      margin: 8px;
      fill: currentColor;
    }
    .${MENU_ITEM_CLASS} span {
      margin: 0 8px;
      white-space: nowrap;
    }
    #${TOAST_ID} {
      position: fixed;
      bottom: 88px;
      left: 50%;
      z-index: 10000;
      max-width: calc(100vw - 32px);
      padding: 12px 16px;
      border-radius: 6px;
      background: #212121;
      color: #ffffff;
      font: 500 14px/20px Roboto, Arial, sans-serif;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      transform: translateX(-50%);
      pointer-events: none;
    }
  `;

  let player = null;
  let app = null;
  let roomMode = false;
  let ownUntil = 0;
  let pendingLoad = null; // { videoId, playing, until }
  let held = ''; // the song that was paused just before its end
  let holdTimer = 0;
  let last = null; // { videoId, position, state, at } at the previous check
  let lastSteady = null; // PLAYING or PAUSED, whichever the player was in most recently
  let keepAliveTimer = 0;

  function send(message) {
    document.dispatchEvent(new CustomEvent(TO_CONTENT, { detail: JSON.stringify(message) }));
  }

  function status() {
    const data = player.getVideoData() || {};
    const progress = typeof player.getProgressState === 'function' ? player.getProgressState() : null;
    // seekableEnd is the exact length; getDuration() is rounded, and while a
    // song is still loading it can report only the part loaded so far.
    const end = progress && progress.seekableEnd > 0 ? progress.seekableEnd : player.getDuration();
    const response = typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
    const forThisSong = response && response.videoDetails && response.videoDetails.videoId === data.video_id;
    const playability = forThisSong && response.playabilityStatus ? response.playabilityStatus.status : 'OK';
    return {
      videoId: data.video_id || '',
      state: player.getPlayerState(),
      position: player.getCurrentTime() || 0,
      end: end || 0,
      ad: player.classList.contains('ad-showing'),
      held: held !== '' && held === data.video_id,
      loading: pendingLoad !== null,
      playable: data.isPlayable !== false && !data.errorCode && playability === 'OK',
    };
  }

  function report() {
    send({ type: 'status', status: status() });
  }

  function markOwn() {
    ownUntil = performance.now() + OWN_WINDOW_MS;
  }

  function load({ videoId, position, playing }) {
    held = '';
    last = null;
    pendingLoad = { videoId, playing, until: performance.now() + LOAD_TIMEOUT_MS };
    ownUntil = pendingLoad.until;
    // This is the navigation YouTube Music itself performs when a song is
    // clicked, so its player bar and queue show the song as usual.
    app.dispatchEvent(new CustomEvent('yt-navigate', {
      bubbles: true,
      composed: true,
      detail: {
        endpoint: { watchEndpoint: { videoId, startTimeSeconds: Math.max(0, Math.floor(position)) } },
      },
    }));
  }

  function settleLoad() {
    if (!pendingLoad) return;
    const data = player.getVideoData() || {};
    if (data.video_id === pendingLoad.videoId) {
      const { playing } = pendingLoad;
      pendingLoad = null;
      markOwn();
      // A song opened this way is cued, not started.
      if (playing) player.playVideo();
      else player.pauseVideo();
      report();
    } else if (performance.now() > pendingLoad.until) {
      pendingLoad = null;
      report();
    }
  }

  function play() {
    markOwn();
    player.playVideo();
  }

  function pause() {
    markOwn();
    player.pauseVideo();
  }

  function seek(position) {
    markOwn();
    held = '';
    last = null;
    player.seekTo(position, true);
  }

  function hold(videoId) {
    held = videoId;
    markOwn();
    player.pauseVideo();
    send({ type: 'ended', videoId });
    report();
  }

  function onStateChange(state) {
    settleLoad();
    if (state === PLAYING || state === PAUSED) {
      const previous = lastSteady;
      lastSteady = state;
      const s = status();
      // Only a change between playing and paused that we did not cause is the
      // listener's own action. Recovering from buffering is not one.
      if (roomMode && previous !== null && previous !== state && performance.now() > ownUntil && !s.ad && !s.held) {
        send({ type: 'intent', action: state === PLAYING ? 'play' : 'pause', videoId: s.videoId, position: s.position });
      }
    } else if (state === ENDED && roomMode) {
      // The hold before the end was missed, as can happen when timers in a
      // background tab run late. YouTube Music is moving on by itself.
      send({ type: 'ended', videoId: status().videoId });
    }
    report();
  }

  function checkJump() {
    const now = performance.now();
    const s = status();
    if (roomMode && last && last.videoId === s.videoId && now > ownUntil && !pendingLoad && !s.ad) {
      const moved = last.state === PLAYING && s.state === PLAYING ? (now - last.at) / 1000 : 0;
      if (Math.abs(s.position - (last.position + moved)) > SEEK_JUMP) {
        send({ type: 'intent', action: 'seek', videoId: s.videoId, position: s.position });
      }
    }
    last = { videoId: s.videoId, position: s.position, state: s.state, at: now };
  }

  function checkEnd() {
    clearTimeout(holdTimer);
    if (!roomMode || pendingLoad) return;
    const s = status();
    if (s.ad || s.held || s.state !== PLAYING || !s.videoId || !(s.end > 0)) return;
    const remaining = s.end - s.position;
    if (remaining <= HOLD_BEFORE_END + 0.05) {
      hold(s.videoId);
    } else if (remaining < 2) {
      holdTimer = setTimeout(checkEnd, (remaining - HOLD_BEFORE_END) * 1000);
    }
  }

  function setRoomMode(on) {
    roomMode = on;
    held = '';
    last = null;
    clearTimeout(holdTimer);
    clearInterval(keepAliveTimer);
    decorateMenu();
    if (on) {
      // After a long time without input, YouTube Music pauses to ask whether
      // anyone is still listening. In a room that would pause everyone, so the
      // last-activity time it checks is kept fresh.
      keepAliveTimer = setInterval(() => {
        if (typeof window._lact === 'number') window._lact = Date.now();
      }, 60_000);
    }
  }

  async function search({ reqId, query }) {
    try {
      const response = await app.networkManager.fetch('/search', { query, params: SONGS_FILTER });
      send({ type: 'search-result', reqId, results: parseSongs(response) });
    } catch {
      send({ type: 'search-result', reqId, error: 'search_failed' });
    }
  }

  function parseSongs(response) {
    const songs = [];
    const seen = new Set();
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node.musicResponsiveListItemRenderer) {
        const song = toSong(node.musicResponsiveListItemRenderer);
        if (song && !seen.has(song.videoId)) {
          seen.add(song.videoId);
          songs.push(song);
        }
        return;
      }
      Object.values(node).forEach(walk);
    };
    walk(response);
    return songs;
  }

  function toSong(item) {
    const runsOf = (i) => item.flexColumns?.[i]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const titleRun = runsOf(0)[0];
    const videoId = item.playlistItemData?.videoId || titleRun?.navigationEndpoint?.watchEndpoint?.videoId;
    if (!videoId || !titleRun?.text) return null;
    // The second line reads "artists • album • 3:34".
    const parts = runsOf(1)
      .map((run) => run.text)
      .join('')
      .split(' • ')
      .map((part) => part.trim())
      .filter(Boolean);
    const durationText = parts.find((part) => TIME_PATTERN.test(part)) || '';
    const names = parts.filter((part) => part !== durationText);
    const thumbnails = item.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
    return {
      videoId,
      title: titleRun.text,
      artists: names[0] || '',
      album: names[1] || '',
      duration: parseDuration(durationText),
      thumbnail: thumbnails.length ? thumbnails[thumbnails.length - 1].url : '',
    };
  }

  function parseDuration(text) {
    if (!TIME_PATTERN.test(text)) return 0;
    return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  }

  // --- "Add to Music Together" in YouTube Music's song menus ---

  // Every menu opens in one shared popup, whose data lists the menu's items.
  // A song's menu has an "Add to queue" item that names the song.
  function songInMenu(popup) {
    const items = popup && popup.data && Array.isArray(popup.data.items) ? popup.data.items : [];
    for (let i = 0; i < items.length; i++) {
      const renderer = Object.values(items[i])[0] || {};
      const add = renderer.serviceEndpoint && renderer.serviceEndpoint.queueAddEndpoint;
      const videoId = add && add.queueTarget && add.queueTarget.videoId;
      if (videoId && add.queueInsertPosition === 'INSERT_AT_END') return { videoId, index: i };
    }
    return null;
  }

  // Puts the item right after "Add to queue" while in a room, and takes it
  // out otherwise. YouTube Music re-renders the menu for every song, so this
  // runs whenever the popup changes.
  function decorateMenu() {
    const popup = document.querySelector('ytmusic-popup-container ytmusic-menu-popup-renderer');
    const list = popup && popup.querySelector('#items');
    if (!list) return;
    const existing = list.querySelector(':scope > .' + MENU_ITEM_CLASS);
    const song = roomMode ? songInMenu(popup) : null;
    const anchor = song ? [...list.children].filter((child) => child !== existing)[song.index] : null;
    if (!song || !anchor) {
      if (existing) existing.remove();
      return;
    }
    if (existing && existing.dataset.videoId === song.videoId && existing.previousElementSibling === anchor) return;
    if (existing) existing.remove();
    anchor.after(menuItem(song.videoId, popup));
  }

  function menuItem(videoId, popup) {
    const item = document.createElement('div');
    item.className = MENU_ITEM_CLASS;
    item.dataset.videoId = videoId;
    item.setAttribute('role', 'menuitem');
    item.tabIndex = 0;
    const label = document.createElement('span');
    label.textContent = strings.menu;
    item.append(noteIcon(), label);
    const activate = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const dropdown = popup.closest('tp-yt-iron-dropdown');
      if (dropdown && typeof dropdown.close === 'function') dropdown.close();
      addToRoom(videoId);
    };
    item.addEventListener('click', activate);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    });
    return item;
  }

  // Two beamed eighth notes, the extension's mark.
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

  // The menu knows only the song's ID; YouTube Music's queue lookup gives its
  // title, artists, length and artwork, as when it adds a song to its own queue.
  async function addToRoom(videoId) {
    let track = null;
    try {
      const response = await app.networkManager.fetch('/music/get_queue', { videoIds: [videoId] });
      track = trackFromQueue(response, videoId);
    } catch {
      // Reported below.
    }
    if (track) send({ type: 'menu-add', track });
    else showToast('failed');
  }

  function trackFromQueue(response, videoId) {
    const content = response?.queueDatas?.[0]?.content;
    const r = content?.playlistPanelVideoRenderer || content?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
    if (!r || r.videoId !== videoId) return null;
    const text = (value) => (value?.runs || []).map((run) => run.text).join('');
    // The byline reads "artists • album • year" for songs and "artists • views • year" for videos.
    const artists = text(r.longBylineText || r.shortBylineText).split(' • ')[0].trim();
    const thumbnails = r.thumbnail?.thumbnails || [];
    const thumbnail = thumbnails.find((t) => t.width >= 120) || thumbnails[thumbnails.length - 1];
    return {
      videoId,
      title: text(r.title),
      artists,
      album: '',
      duration: parseDuration(text(r.lengthText)),
      thumbnail: thumbnail ? thumbnail.url : '',
    };
  }

  let toastTimer = 0;

  function showToast(code) {
    let box = document.getElementById(TOAST_ID);
    if (!box) {
      box = document.createElement('div');
      box.id = TOAST_ID;
      box.setAttribute('role', 'status');
      document.body.append(box);
    }
    box.textContent = strings[code] || strings.failed;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      box.hidden = true;
    }, TOAST_MS);
  }

  function watchMenus() {
    const container = document.querySelector('ytmusic-popup-container');
    if (!container) return;
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.append(style);
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        decorateMenu();
      });
    }).observe(container, { childList: true, subtree: true });
  }

  document.addEventListener(TO_PAGE, (event) => {
    let message;
    try {
      message = JSON.parse(event.detail);
    } catch {
      return;
    }
    // Until the player is found, "ready" has not been sent and nothing else is asked.
    if (!player) return;
    switch (message.type) {
      case 'hello':
        send({ type: 'ready' });
        report();
        break;
      case 'language':
        strings = STRINGS[message.value] || STRINGS.en;
        break;
      case 'mode':
        setRoomMode(Boolean(message.on));
        report();
        break;
      case 'load':
        load(message);
        break;
      case 'play':
        play();
        break;
      case 'pause':
        pause();
        break;
      case 'seek':
        seek(message.position);
        break;
      case 'search':
        search(message);
        break;
      case 'toast':
        showToast(message.code);
        break;
    }
  });

  // In a room, the player bar's next button moves the whole room on instead
  // of moving YouTube Music's own queue.
  window.addEventListener('click', (event) => {
    if (!roomMode) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !target.closest('ytmusic-player-bar .next-button')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    send({ type: 'intent', action: 'next' });
  }, true);

  function attach() {
    const foundPlayer = document.getElementById('movie_player');
    const foundApp = document.querySelector('ytmusic-app');
    if (!foundPlayer || typeof foundPlayer.getPlayerState !== 'function' || !foundApp || !foundApp.networkManager) {
      return false;
    }
    player = foundPlayer;
    app = foundApp;
    player.addEventListener('onStateChange', onStateChange);
    player.addEventListener('videodatachange', () => {
      settleLoad();
      report();
    });
    // timeupdate does not bubble, but a capturing listener on the document still receives it.
    document.addEventListener('timeupdate', () => checkEnd(), true);
    watchMenus();
    setInterval(() => {
      settleLoad();
      checkJump();
      checkEnd();
      report();
    }, TICK_MS);
    send({ type: 'ready' });
    report();
    return true;
  }

  if (!attach()) {
    const timer = setInterval(() => {
      if (attach()) clearInterval(timer);
    }, TICK_MS);
  }
})();
