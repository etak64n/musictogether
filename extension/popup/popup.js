// The toolbar popup. It finds the YouTube Music tab to work with, shows that
// tab's room, and passes what the listener does to the tab's content script.
// The room itself lives in the tab, so closing the popup changes nothing.

import { hasString, loadLanguage, localize, translator } from '../i18n.js';

const YTM_URL = 'https://music.youtube.com/';
const ROOM_ID_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/;
const TOAST_MS = 3000;
const CLOSE_CONFIRM_MS = 4000;

const $ = (id) => document.getElementById(id);

// The words in the language of the settings, from the start of the popup.
const language = await loadLanguage();
const t = translator(language);
document.documentElement.lang = language;
localize(document, t);

// What the tab or the room server reports, in words.
const message = (code) => t(hasString(code) ? code : 'network');

// The room server and its token come from the settings page. Without them,
// the popup asks for them in place of creating or joining a room.
const { server, token, display, update } = await chrome.storage.local.get(['server', 'token', 'display', 'update']);
const configured = Boolean(server && token);

// A newer release, which the service worker found on GitHub, is shown above
// everything else until the extension is updated.
if (update && update.version && update.url) {
  $('update-text').textContent = t('updateAvailable', { version: update.version });
  $('update').hidden = false;
  $('update').addEventListener('click', () => chrome.tabs.create({ url: update.url }));
}

// The same page opens as a mini window under the button or in Chrome's side
// panel, as the settings say. The side panel fills the width that Chrome gives
// it, and stays open while the listener moves between tabs.
const inPanel = display === 'panel';
document.documentElement.classList.toggle('panel', inPanel);

let tabId = null;
let port = null;
let unreachable = false;
let view = null;
let localError = '';
let shownNotice = 0;
let toastTimer = 0;
let searchSeq = 0;
let closeArmedUntil = 0;
let rendered = { now: '', queue: '' };

function isHost() {
  return Boolean(view && view.room && view.room.hostId === view.memberId);
}

function canControl() {
  return isHost() || Boolean(view && view.room && view.room.participantControl);
}

// --- finding the tab ---

// The tab in a room comes first; otherwise the YouTube Music tab in front,
// otherwise the YouTube Music tab used most recently.
async function findTab() {
  const { roomTab } = await chrome.storage.session.get('roomTab');
  if (roomTab) {
    const tab = await chrome.tabs.get(roomTab.tabId).catch(() => null);
    if (tab && tab.url && tab.url.startsWith(YTM_URL)) return tab;
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && active.url && active.url.startsWith(YTM_URL)) return active;
  const tabs = await chrome.tabs.query({ url: YTM_URL + '*' });
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return tabs[0] || null;
}

// The popup follows the tab that findTab picks: when the active tab changes,
// when a tab loads or closes, and when a tab joins or leaves a room. Calls
// that arrive during one search are folded into one more search after it.
let refreshing = false;
let refreshAgain = false;

async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    do {
      refreshAgain = false;
      await refreshOnce();
    } while (refreshAgain);
  } finally {
    refreshing = false;
  }
}

async function refreshOnce() {
  const tab = await findTab();
  if (!tab) {
    disconnect();
    tabId = null;
    render();
    return;
  }
  if (tab.id === tabId && port) return;
  disconnect();
  tabId = tab.id;
  unreachable = false;
  // A tab that is still loading has no content script yet; it is connected once it has loaded.
  if (tab.status !== 'loading') connect(tab.id);
  render();
}

function connect(id) {
  const p = chrome.tabs.connect(id, { name: 'popup', frameId: 0 });
  port = p;
  view = null;
  p.onMessage.addListener((message) => {
    if (port === p) onMessage(message);
  });
  p.onDisconnect.addListener(() => {
    // Reading lastError keeps Chrome from logging it as unchecked.
    void chrome.runtime.lastError;
    if (port !== p) return;
    port = null;
    // A tab that never answered has no content script: it was open before
    // the extension was installed or updated.
    if (view === null) {
      unreachable = true;
      render();
    } else {
      view = null;
      refresh();
    }
  });
}

function disconnect() {
  if (port) {
    const p = port;
    port = null;
    p.disconnect();
  }
  view = null;
}

chrome.tabs.onActivated.addListener(() => refresh());
chrome.tabs.onRemoved.addListener(() => refresh());
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === 'complete' || info.url) refresh();
});
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.roomTab) refresh();
});

function post(message) {
  if (port) port.postMessage(message);
}

function onMessage(message) {
  if (message.type === 'view') {
    view = message.view;
    unreachable = false;
    render();
  } else if (message.type === 'search-result') {
    showResults(message);
  }
}

// --- rendering ---

function render() {
  let section = null;
  if (tabId === null) section = 'no-tab';
  else if (unreachable) section = 'reload';
  else if (view && view.status !== 'idle') section = 'room';
  else if (view) section = configured ? 'lobby' : 'setup';
  for (const name of ['no-tab', 'reload', 'setup', 'lobby', 'room']) $(name).hidden = name !== section;
  $('leave').hidden = section !== 'room';

  if (section === 'lobby') renderLobby();
  if (section === 'room') renderRoom();
  if (section !== 'room') rendered = { now: '', queue: '' };

  if (view && view.notice && view.notice.id !== shownNotice) {
    shownNotice = view.notice.id;
    toast(message(view.notice.code));
  }
}

function renderLobby() {
  $('create').disabled = view.busy;
  $('join').disabled = view.busy;
  const text = localError || (view.error ? message(view.error) : '');
  $('lobby-error').textContent = text;
  $('lobby-error').hidden = !text;
}

function renderRoom() {
  const room = view.room;
  $('room-id-text').textContent = view.roomId || '';
  $('conn').hidden = view.status === 'connected';
  $('conn').textContent = t(view.status === 'reconnecting' ? 'reconnecting' : 'connecting');
  $('control-row').hidden = !isHost();
  $('participant-control').checked = Boolean(room && room.participantControl);
  renderLeave();
  renderMembers(room ? room.members : [], room ? room.hostId : '');
  renderNow(room);
  renderQueue(room ? room.queue : []);
}

// The host leaving closes the room for everyone, so the host presses twice.
function renderLeave() {
  const host = isHost();
  const armed = host && Date.now() < closeArmedUntil;
  $('leave').textContent = t(!host ? 'leave' : armed ? 'closeConfirm' : 'closeRoom');
  $('leave').classList.toggle('danger', armed);
}

// One line for the host and one for everyone else. A host who has closed
// the tab is not in the list.
function renderMembers(members, hostId) {
  const host = members.find((member) => member.id === hostId);
  const guests = members.filter((member) => member.id !== hostId);
  $('host-member').textContent = host ? host.name : t('hostAbsent');
  $('host-member').classList.toggle('absent', !host);
  // Everyone else is in a list that is closed until it is opened.
  $('guests').hidden = guests.length === 0;
  $('guest-list').replaceChildren(...guests.map((member) => {
    const li = document.createElement('li');
    li.textContent = member.name;
    return li;
  }));
}

// Everyone pauses and plays their own player; skipping is the room's.
function renderNow(room) {
  const item = room && room.current;
  $('now').hidden = !item;
  $('next').hidden = !canControl();
  viz.playing = Boolean(item && view.listening && room.playback.playing);
  const toggle = $('toggle');
  toggle.classList.toggle('playing', view.listening);
  const label = t(view.listening ? 'pauseOwn' : 'playFromRoom');
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  const key = item ? item.id : '';
  if (key === rendered.now) return;
  rendered.now = key;
  if (!item) return;
  $('now-art').replaceChildren(artwork(item.thumbnail));
  stopMarquee($('now'));
  setLine($('now-title'), item.title);
  setLine($('now-sub'), item.artists);
  showAddedBy($('now-by'), item.addedBy);
}

function renderQueue(queue) {
  // The rows stay as they are while a song is being dragged.
  if (drag) return;
  // Members remove the songs they added; the host removes any song.
  const removable = (item) => isHost() || item.addedById === view.memberId;
  // Changing the order needs the same permission as skipping.
  const movable = canControl();
  const key = JSON.stringify([movable, queue.map((item) => [item.id, removable(item)])]);
  if (key === rendered.queue) return;
  rendered.queue = key;
  $('queue-panel').hidden = queue.length === 0;
  $('queue').replaceChildren(...queue.map((item) => {
    let action = document.createElement('span');
    if (removable(item)) {
      action = iconButton('icon-remove', t('remove'));
      action.classList.add('remove-button');
      action.addEventListener('click', () => post({ type: 'remove', itemId: item.id }));
    }
    const li = songRow(item, item.artists, action, item.addedBy);
    li.dataset.itemId = item.id;
    li.classList.toggle('movable', movable);
    return li;
  }));
}

// --- reordering the queue ---

// A song in Up next is dragged up or down: the row follows the pointer, the
// others slide aside to make room, and the room gets the new order when the
// row is let go. This uses pointer events rather than the browser's drag and
// drop, so that the row itself moves instead of a faded copy of it.
const DRAG_THRESHOLD = 4; // px the pointer moves before a press becomes a drag
const DRAG_EDGE = 24; // px from the list's top or bottom where the list scrolls
const DRAG_SCROLL = 6; // px the list scrolls per frame there
const SETTLE_MS = 150;

let drag = null; // { li, pointerId, startY, y, active, rows, from, to, tops, heights, origin, frame }

function startDrag() {
  const list = $('queue');
  const rows = [...list.children];
  const listTop = list.getBoundingClientRect().top;
  drag.active = true;
  drag.rows = rows;
  drag.from = rows.indexOf(drag.li);
  drag.to = drag.from;
  // Positions within the list's content, which scrolling the list does not change.
  drag.tops = rows.map((row) => row.getBoundingClientRect().top - listTop + list.scrollTop);
  drag.heights = rows.map((row) => row.offsetHeight);
  drag.origin = drag.startY - listTop + list.scrollTop;
  stopMarquee(drag.li);
  list.classList.add('sorting');
  drag.li.classList.add('dragging');
  drag.frame = requestAnimationFrame(dragFrame);
}

// Near the list's top or bottom, the list scrolls under the dragged row.
function dragFrame() {
  const list = $('queue');
  const box = list.getBoundingClientRect();
  if (drag.y < box.top + DRAG_EDGE) list.scrollTop -= DRAG_SCROLL;
  else if (drag.y > box.bottom - DRAG_EDGE) list.scrollTop += DRAG_SCROLL;
  layoutDrag();
  drag.frame = requestAnimationFrame(dragFrame);
}

function layoutDrag() {
  const list = $('queue');
  const { rows, from, tops, heights } = drag;
  const last = rows.length - 1;
  const y = drag.y - list.getBoundingClientRect().top + list.scrollTop;
  // The row stays within the list, so that it cannot make the list scroll further.
  const shift = Math.min(Math.max(y - drag.origin, tops[0] - tops[from]), tops[last] + heights[last] - tops[from] - heights[from]);
  // A row gives way once the dragged row's edge passes its middle, so the
  // first and last places can be reached with the row held inside the list.
  const top = tops[from] + shift;
  const bottom = top + heights[from];
  let to = from;
  while (to > 0 && top < tops[to - 1] + heights[to - 1] / 2) to -= 1;
  while (to < last && bottom > tops[to + 1] + heights[to + 1] / 2) to += 1;
  drag.to = to;
  rows.forEach((row, i) => {
    let offset = 0;
    if (i === from) offset = shift;
    else if (from < i && i <= to) offset = -heights[from];
    else if (to <= i && i < from) offset = heights[from];
    row.style.transform = offset ? `translateY(${offset}px)` : '';
  });
}

// A dropped song takes its new place in the popup at once, and in the room
// through the tab. A cancelled drag puts the rows back.
function finishDrag(drop) {
  const d = drag;
  drag = null;
  if (!d.active) {
    if (view && view.room) renderQueue(view.room.queue);
    return;
  }
  cancelAnimationFrame(d.frame);
  const itemId = d.li.dataset.itemId;
  const droppedTop = d.li.getBoundingClientRect().top;
  // The song lands before the rows below the drop point. They are found by ID,
  // in case the queue changed during the drag: when the first of them has left
  // the queue, for example because it started playing, the next one counts.
  const below = d.rows.slice(d.to < d.from ? d.to : d.to + 1).filter((row) => row !== d.li).map((row) => row.dataset.itemId);
  $('queue').classList.remove('sorting');
  d.li.classList.remove('dragging');
  for (const row of d.rows) row.style.transform = '';
  if (!view || !view.room) return;
  if (drop && d.to !== d.from) moveSong(itemId, below);
  renderQueue(view.room.queue);
  settle(itemId, droppedTop);
}

// The song goes before the first of the given songs still in the queue, or
// last when none of them is.
function moveSong(itemId, beforeIds) {
  const queue = view.room.queue;
  const item = queue.find((it) => it.id === itemId);
  if (!item) return;
  const rest = queue.filter((it) => it !== item);
  const found = rest.findIndex((it) => beforeIds.includes(it.id));
  const index = found < 0 ? rest.length : found;
  rest.splice(index, 0, item);
  view.room.queue = rest;
  post({ type: 'move', itemId, index });
}

// The dropped row glides from where it was let go into its place.
function settle(itemId, fromTop) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const li = [...$('queue').children].find((row) => row.dataset.itemId === itemId);
  if (!li) return;
  const offset = fromTop - li.getBoundingClientRect().top;
  if (Math.abs(offset) < 1) return;
  li.animate([{ transform: `translateY(${offset}px)` }, { transform: 'none' }], { duration: SETTLE_MS, easing: 'ease-out' });
}

$('queue').addEventListener('pointerdown', (event) => {
  const li = event.target.closest('li.movable');
  if (!li || drag || event.button !== 0 || event.target.closest('button')) return;
  drag = { li, pointerId: event.pointerId, startY: event.clientY, y: event.clientY, active: false };
  $('queue').setPointerCapture(event.pointerId);
});

$('queue').addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.y = event.clientY;
  if (!drag.active && Math.abs(drag.y - drag.startY) >= DRAG_THRESHOLD) startDrag();
});

$('queue').addEventListener('pointerup', (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.y = event.clientY;
  if (drag.active) layoutDrag();
  finishDrag(true);
});

for (const type of ['pointercancel', 'lostpointercapture']) {
  $('queue').addEventListener(type, (event) => {
    if (drag && event.pointerId === drag.pointerId) finishDrag(false);
  });
}

// --- visualizer ---

// An LED equalizer: each column is a stack of small segments. A column jumps
// up at once and drops at a steady rate, and the segment at its recent peak
// stays lit for a moment before it falls. The sound is not measured: while
// this listener's song plays, the columns move to a made-up beat, which
// keeps them moving whatever happens in the YouTube Music tab.
const VIZ_BARS = 32;
const VIZ_ROWS = 11;
const VIZ_GAP = 2; // px between columns
const VIZ_FALL = 2.5; // of the full height per second
const VIZ_PEAK_HOLD_MS = 450;
const VIZ_PEAK_FALL = 1.2; // of the full height per second
// Lit segments go from deep teal at the bottom to light teal at the top; the
// held peak is deep teal, and unlit segments are a faint grid.
const VIZ_LIT_BOTTOM = [5, 102, 114];
const VIZ_LIT_TOP = [56, 196, 196];
const VIZ_ROW_COLORS = Array.from({ length: VIZ_ROWS }, (_, row) => {
  const t = row / (VIZ_ROWS - 1);
  return `rgb(${VIZ_LIT_BOTTOM.map((v, k) => Math.round(v + (VIZ_LIT_TOP[k] - v) * t)).join(', ')})`;
});
const VIZ_PEAK_COLOR = '#056672';
const VIZ_OFF_COLOR = '#e6ece8';

const viz = {
  heights: new Float32Array(VIZ_BARS),
  peaks: new Float32Array(VIZ_BARS),
  peakAt: new Float64Array(VIZ_BARS),
  lastFrameAt: 0,
  playing: false,
  still: matchMedia('(prefers-reduced-motion: reduce)').matches,
};

// A random value from 0 to 1 for a band and a step of time.
function hash(i, n) {
  const s = Math.sin(i * 127.1 + n * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// The made-up beat takes new values eight times a second, as music does: a
// kick on every beat in the low bands, a voice-like hump in the middle, and
// hi-hats between the beats in the high bands.
function beat(i, t) {
  const x = i / (VIZ_BARS - 1);
  const step = Math.floor(t * 8);
  const phase = (t * 2) % 1;
  const kick = phase < 0.125 ? 1 : 0;
  const hat = Math.abs(phase - 0.5) < 0.0625 ? 1 : 0;
  const bass = Math.max(0, 1 - x * 4);
  const voice = Math.exp(-(((x - 0.32) / 0.16) ** 2));
  const treble = Math.max(0, (x - 0.6) / 0.4);
  let level = 0.1 + 0.6 * hash(i, step) * (0.5 + 0.6 * voice);
  level += bass * (0.2 + 0.75 * kick) + treble * 0.7 * hat * hash(i + 50, step);
  return Math.min(1, (level * (1 - x * 0.2) * 1.3) ** 1.4);
}

function drawViz(now) {
  requestAnimationFrame(drawViz);
  const canvas = $('viz');
  if (canvas.offsetParent === null) return;
  const elapsed = viz.lastFrameAt ? Math.min(0.1, (now - viz.lastFrameAt) / 1000) : 0;
  viz.lastFrameAt = now;
  // The canvas is drawn in device pixels, so that every segment has sharp edges.
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  for (let i = 0; i < VIZ_BARS; i++) {
    const target = viz.playing ? beat(i, viz.still ? 0 : now / 1000) : 0;
    // Jump up at once and fall at a steady rate, as LED meters do.
    viz.heights[i] = viz.still ? target : Math.max(target, viz.heights[i] - VIZ_FALL * elapsed);
    if (viz.still || viz.heights[i] >= viz.peaks[i]) {
      viz.peaks[i] = viz.heights[i];
      viz.peakAt[i] = now;
    } else if (now - viz.peakAt[i] > VIZ_PEAK_HOLD_MS) {
      viz.peaks[i] = Math.max(viz.heights[i], viz.peaks[i] - VIZ_PEAK_FALL * elapsed);
    }
  }

  const g = canvas.getContext('2d');
  g.clearRect(0, 0, width, height);
  const gap = Math.max(1, Math.round(VIZ_GAP * dpr));
  const column = (width - gap * (VIZ_BARS - 1)) / VIZ_BARS;
  const pitch = height / VIZ_ROWS;
  const segment = Math.max(1, Math.round(pitch * 0.6));
  // Row 0 is at the bottom.
  const draw = (i, row) => {
    const left = Math.round(i * (column + gap));
    const bottom = Math.round(height - row * pitch);
    g.fillRect(left, bottom - segment, Math.round(i * (column + gap) + column) - left, segment);
  };
  // While the room plays, the bottom segment stays lit as a base line.
  const lit = Array.from(viz.heights, (h) => Math.max(viz.playing ? 1 : 0, Math.round(h * VIZ_ROWS)));
  const peak = Array.from(viz.peaks, (p, i) => {
    const row = Math.round(p * VIZ_ROWS) - 1;
    return viz.playing && row >= lit[i] ? row : -1;
  });

  g.fillStyle = VIZ_OFF_COLOR;
  for (let i = 0; i < VIZ_BARS; i++) {
    for (let row = lit[i]; row < VIZ_ROWS; row++) if (row !== peak[i]) draw(i, row);
  }
  for (let row = 0; row < VIZ_ROWS; row++) {
    g.fillStyle = VIZ_ROW_COLORS[row];
    for (let i = 0; i < VIZ_BARS; i++) if (row < lit[i]) draw(i, row);
  }
  g.fillStyle = VIZ_PEAK_COLOR;
  for (let i = 0; i < VIZ_BARS; i++) if (peak[i] >= 0) draw(i, peak[i]);
}

function songRow(track, subtitle, action, addedBy) {
  const li = document.createElement('li');
  const art = document.createElement('div');
  art.className = 'art';
  art.append(artwork(track.thumbnail));
  const text = document.createElement('div');
  text.className = 'text';
  const title = document.createElement('p');
  title.className = 'title';
  setLine(title, track.title);
  const subRow = document.createElement('div');
  subRow.className = 'sub-row';
  const sub = document.createElement('p');
  sub.className = 'sub';
  setLine(sub, subtitle);
  subRow.append(sub);
  if (addedBy) {
    const by = document.createElement('span');
    by.className = 'by';
    showAddedBy(by, addedBy);
    subRow.append(by);
  }
  text.append(title, subRow);
  li.append(art, text, action);
  li.addEventListener('mouseenter', () => startMarquee(li));
  li.addEventListener('mouseleave', () => stopMarquee(li));
  return li;
}

// Who added the song, after the artists: a small person and the name.
function showAddedBy(element, name) {
  element.hidden = !name;
  if (!name) return;
  const span = document.createElement('span');
  span.className = 'name';
  span.textContent = name;
  element.replaceChildren(icon('icon-person'), span);
  element.title = t('addedBy', { name });
}

// --- long titles ---

// A line of text sits in a span, so that it shows an ellipsis at rest and can
// slide as one piece when pointed at.
function setLine(element, text) {
  const span = document.createElement('span');
  span.textContent = text;
  element.replaceChildren(span);
}

// Lines cut short by the width slide to the left while the song is pointed
// at, so a long title can be read without making the popup wider. A line
// waits at its start, slides until its end shows, waits, and starts over,
// fading out and back in at the restart.
const MARQUEE_SPEED = 40; // px per second
const MARQUEE_HOLD_MS = 1000; // at the start, and at least at the end
const MARQUEE_FADE_MS = 200;

function startMarquee(container) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // Widths are compared to a fraction of a pixel: a line cut by even a
  // sliver shows an ellipsis in place of its last letters.
  const lines = [...container.querySelectorAll('.title:not(.marquee), .sub:not(.marquee)')]
    .filter((line) => line.firstElementChild)
    .map((line) => ({ line, distance: line.firstElementChild.getBoundingClientRect().width - line.getBoundingClientRect().width }))
    .filter(({ distance }) => distance > 0);
  if (lines.length === 0) return;
  // The lines of a song start over together, so the longest one sets the
  // pace and the others wait longer at their end.
  const longest = Math.max(...lines.map(({ distance }) => distance));
  const total = MARQUEE_HOLD_MS * 2 + (longest / MARQUEE_SPEED) * 1000;
  const at = (ms) => ms / total;
  for (const { line, distance } of lines) {
    line.classList.add('marquee');
    const slide = (distance / MARQUEE_SPEED) * 1000;
    const end = `translateX(${-distance}px)`;
    const keyframes = [
      { offset: 0, transform: 'none', opacity: 0 },
      { offset: at(MARQUEE_FADE_MS), transform: 'none', opacity: 1 },
      { offset: at(MARQUEE_HOLD_MS), transform: 'none', opacity: 1 },
      { offset: at(MARQUEE_HOLD_MS + slide), transform: end, opacity: 1 },
      { offset: at(total - MARQUEE_FADE_MS), transform: end, opacity: 1 },
      { offset: 1, transform: end, opacity: 0 },
    ];
    // The first round starts after the fade-in, since the line is already shown.
    line.firstElementChild.animate(keyframes, { duration: total, iterations: Infinity, iterationStart: at(MARQUEE_FADE_MS) });
  }
}

function stopMarquee(container) {
  for (const line of container.querySelectorAll('.marquee')) {
    line.classList.remove('marquee');
    for (const animation of line.firstElementChild.getAnimations()) animation.cancel();
  }
}

function artwork(url) {
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    return img;
  }
  return icon('icon-logo');
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}

function iconButton(id, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(id));
  return button;
}

function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, TOAST_MS);
}

// --- search ---

function hideResults() {
  searchSeq += 1;
  $('results').hidden = true;
  $('results').replaceChildren();
  $('results-message').hidden = true;
}

function showResultsMessage(text) {
  $('results').hidden = true;
  $('results-message').textContent = text;
  $('results-message').hidden = false;
}

function showResults(message) {
  if (message.reqId !== searchSeq) return;
  if (message.error) {
    showResultsMessage(t('searchFailed'));
    return;
  }
  if (message.results.length === 0) {
    showResultsMessage(t('noResults'));
    return;
  }
  $('results-message').hidden = true;
  $('results').hidden = false;
  $('results').replaceChildren(...message.results.map((track) => {
    const add = iconButton('icon-add', t('add'));
    add.addEventListener('click', () => {
      post({ type: 'add', track });
      add.replaceChildren(icon('icon-check'));
      add.disabled = true;
      add.setAttribute('aria-label', t('added'));
      add.title = t('added');
    });
    const subtitle = [track.artists, formatDuration(track.duration)].filter(Boolean).join(' • ');
    return songRow(track, subtitle, add);
  }));
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const s = Math.round(seconds);
  const parts = s >= 3600 ? [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60] : [Math.floor(s / 60), s % 60];
  return parts.map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, '0'))).join(':');
}

$('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = $('search').value.trim();
  if (!query) {
    hideResults();
    return;
  }
  searchSeq += 1;
  showResultsMessage(t('searching'));
  post({ type: 'search', reqId: searchSeq, query });
});

// The clear button of a search field fires "search" with an empty value.
$('search').addEventListener('search', () => {
  if (!$('search').value) hideResults();
});

// --- lobby ---

// Creating and joining are two tabs. The name is one setting, shown in both.
function showLobbyTab(name) {
  const create = name === 'create';
  $('tab-create').setAttribute('aria-selected', String(create));
  $('tab-join').setAttribute('aria-selected', String(!create));
  $('create-form').hidden = !create;
  $('join-form').hidden = create;
  localError = '';
  if (view) renderLobby();
  try {
    localStorage.setItem('lobbyTab', name);
  } catch {
    // Remembering the tab is only a convenience.
  }
}

// Shows what is wrong with a field and puts the cursor in it.
function refuse(input, key) {
  localError = t(key);
  renderLobby();
  input.focus();
  return null;
}

function readName(input) {
  const name = input.value.trim();
  if (!name) return refuse(input, 'enterName');
  return name;
}

for (const input of document.querySelectorAll('input.name')) {
  input.addEventListener('input', () => {
    for (const other of document.querySelectorAll('input.name')) {
      if (other !== input) other.value = input.value;
    }
    chrome.storage.local.set({ name: input.value.trim() });
  });
}

$('tab-create').addEventListener('click', () => showLobbyTab('create'));
$('tab-join').addEventListener('click', () => showLobbyTab('join'));

$('create-form').addEventListener('submit', (event) => {
  event.preventDefault();
  localError = '';
  const name = readName($('host-name'));
  if (name) post({ type: 'create', name });
  renderLobby();
});

$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  localError = '';
  const name = readName($('guest-name'));
  if (!name) return;
  const roomId = $('room-id').value.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!ROOM_ID_PATTERN.test(roomId)) return refuse($('room-id'), 'roomIdFormat');
  post({ type: 'join', roomId, name });
  renderLobby();
});

// --- settings ---

// The settings page opens in a tab of its own, which closes the popup.
for (const id of ['settings', 'open-settings']) {
  $(id).addEventListener('click', () => chrome.runtime.openOptionsPage());
}

// --- room ---

$('copy-id').addEventListener('click', async () => {
  if (!view || !view.roomId) return;
  try {
    await navigator.clipboard.writeText(view.roomId);
    toast(t('copied'));
  } catch {
    toast(t('copyFailed'));
  }
});

$('leave').addEventListener('click', () => {
  if (isHost() && Date.now() >= closeArmedUntil) {
    closeArmedUntil = Date.now() + CLOSE_CONFIRM_MS;
    renderLeave();
    setTimeout(renderLeave, CLOSE_CONFIRM_MS + 50);
    return;
  }
  closeArmedUntil = 0;
  hideResults();
  post({ type: isHost() ? 'close' : 'leave' });
});

$('participant-control').addEventListener('change', () => {
  post({ type: 'participantControl', value: $('participant-control').checked });
});

$('now').addEventListener('mouseenter', () => startMarquee($('now')));
$('now').addEventListener('mouseleave', () => stopMarquee($('now')));
$('toggle').addEventListener('click', () => post({ type: 'toggle' }));
$('next').addEventListener('click', () => post({ type: 'next' }));

// --- no tab, reload ---

$('open-ytm').addEventListener('click', () => {
  chrome.tabs.create({ url: YTM_URL });
});

$('reload-tab').addEventListener('click', () => {
  if (tabId !== null) chrome.tabs.reload(tabId);
  // The side panel stays, and connects to the tab once it has loaded.
  if (!inPanel) window.close();
});

// --- start ---

let lobbyTab = 'create';
try {
  if (localStorage.getItem('lobbyTab') === 'join') lobbyTab = 'join';
} catch {
  // Start on creating a room.
}
showLobbyTab(lobbyTab);

chrome.storage.local.get(['name', 'lastRoomId']).then(({ name, lastRoomId }) => {
  for (const input of document.querySelectorAll('input.name')) input.value = name || '';
  if (lastRoomId) $('room-id').value = lastRoomId;
});

requestAnimationFrame(drawViz);
refresh();
