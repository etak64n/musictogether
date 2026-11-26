// The toolbar popup. It finds the YouTube Music tab to work with, shows that
// tab's room, and passes what the listener does to the tab's content script.
// The room itself lives in the tab, so closing the popup changes nothing.

import { LANGUAGES, hasString, loadLanguage, localize, translator } from '../i18n.js';

const YTM_URL = 'https://music.youtube.com/';
const ROOM_ID_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/;
const TOAST_MS = 3000;

const $ = (id) => document.getElementById(id);

// The words in the language of the settings, from the start of the popup.
const language = await loadLanguage();
const t = translator(language);
document.documentElement.lang = language;
localize(document, t);

// What the tab or the room server reports, in words. A notice about added
// songs carries their number.
const message = (code, count) => t(hasString(code) ? code : 'network', { count });

// The room server and its token come from the settings. Without them, the
// popup asks for them in place of creating or joining a room.
const { server, token, display, update } = await chrome.storage.local.get(['server', 'token', 'display', 'update']);
let configured = Boolean(server && token);

// The settings show in the popup in place of everything else. A popup that
// reloads to change its language opens on them again, with #settings.
let settingsOpen = location.hash === '#settings';
let settingsTransition = null;
if (settingsOpen) history.replaceState(null, '', location.pathname + location.search);

// A newer release, which the room server or GitHub told of, is shown above
// everything else on every screen until the extension is updated, also when it
// comes while the popup is open.
let updateUrl = '';
function isNewerVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const difference = (pa[i] || 0) - (pb[i] || 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}
function showUpdate(found) {
  const current = typeof chrome.runtime?.getManifest === 'function' ? chrome.runtime.getManifest().version : '';
  const known = Boolean(found && found.version && found.url && (!current || isNewerVersion(found.version, current)));
  $('update').hidden = !known;
  if (!known) return;
  updateUrl = found.url;
  $('update-text').textContent = t('updateAvailable', { version: found.version });
}
$('update').addEventListener('click', () => {
  if (updateUrl) chrome.tabs.create({ url: updateUrl });
});
showUpdate(update);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.update) showUpdate(changes.update.newValue);
});
// Ask the service worker to check GitHub when the popup opens, so every screen
// (outside a room, lobby, setup, settings, or no YouTube Music tab) shows an
// available update without waiting to join a room.
chrome.runtime.sendMessage?.({ type: 'check-update' })?.catch?.(() => {});

// The same page opens as a mini window under the button or in Chrome's side
// panel, as the settings say. The side panel fills the width that Chrome gives
// it, and stays open while the listener moves between tabs.
// A button in YouTube Music also opens this page in a window on top of the
// others, for the tab that has the button: ?pip=1&tab=ID. That window is laid
// out as the side panel is, at its own height. The mini window carries
// ?mini=1, as it opens in YouTube Music installed as an app whatever the
// settings choose.
const pageParameters = new URLSearchParams(location.search);
const pipTab = pageParameters.has('pip') ? Number(pageParameters.get('tab')) : NaN;
const inPip = Number.isInteger(pipTab);
const inPanel = inPip || (!pageParameters.has('mini') && display === 'panel');
document.documentElement.classList.toggle('panel', inPanel);

// Chrome lets the window on top be made as narrow as 240px, and gives the page
// no say in it, while the page needs 320px. Narrower than that, the page is
// scaled down to the width, so that nothing is cut off or out of place; its
// height still fills the window.
const MIN_WIDTH = 320;
function fitWidth() {
  const scale = Math.min(1, window.innerWidth / MIN_WIDTH);
  document.documentElement.style.zoom = scale < 1 ? String(scale) : '';
  if (scale < 1) document.documentElement.style.setProperty('--available', `${window.innerHeight / scale}px`);
  else document.documentElement.style.removeProperty('--available');
}
if (inPip) {
  fitWidth();
  window.addEventListener('resize', fitWidth);
}

// The folded lists share the height that the rest of the popup leaves (popup.css).
// In the mini window, that height is the room from the popup's top to the bottom
// of the browser window, up to the 600px that Chrome allows a popup, so that the
// popup fits a short window too. The side panel uses its own height.
const POPUP_MAX_HEIGHT = 600;
if (!inPanel) {
  try {
    const browser = await chrome.windows.getCurrent();
    // A popup that cannot tell where it is assumes the usual height of the toolbars.
    const top = window.screenY > browser.top ? window.screenY : browser.top + 90;
    const room = browser.top + browser.height - top - 8;
    if (room > 0) {
      document.documentElement.style.setProperty('--available', `${Math.min(POPUP_MAX_HEIGHT, room)}px`);
    }
  } catch {
    // The height stays at the 600px of popup.css.
  }
}

let tabId = null;
let port = null;
let unreachable = false;
let view = null;
let localError = '';
let shownNotice = 0;
let toastTimer = 0;
let searchSeq = 0;
let rendered = { now: '', queue: '', standby: '', played: '', current: '' };

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
  // The window on top stays with the tab that opened it.
  if (inPip) return chrome.tabs.get(pipTab).catch(() => null);
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
  } else if (message.type === 'playlist-result') {
    onPlaylistResult(message);
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
  for (const name of ['no-tab', 'reload', 'setup', 'lobby', 'room']) {
    const el = $(name);
    const keepLeaving = settingsTransition && settingsTransition.leaving === el;
    el.hidden = !keepLeaving && (settingsOpen || name !== section);
  }
  const settingsEl = $('settings-view');
  const keepSettingsLeaving = settingsTransition && settingsTransition.leaving === settingsEl;
  settingsEl.hidden = !keepSettingsLeaving && !settingsOpen;
  $('settings').setAttribute('aria-pressed', String(settingsOpen));
  $('leave').hidden = settingsOpen || section !== 'room';

  if (section === 'lobby') renderLobby();
  if (section === 'room') renderRoom();
  if (section !== 'room') rendered = { now: '', queue: '', standby: '', played: '', current: '' };

  if (view && view.notice && view.notice.id !== shownNotice) {
    shownNotice = view.notice.id;
    toast(message(view.notice.code, view.notice.count));
  }
}

// A tab opened from an invite link waits in the lobby with the room's ID, on the
// tab that joins, until the name is entered and Join is clicked.
let shownInvite = '';

function renderLobby() {
  if (view.invite && view.invite !== shownInvite) {
    shownInvite = view.invite;
    $('room-id').value = view.invite;
    showLobbyTab('join');
    return;
  }
  $('invite-note').hidden = !view.invite;
  $('invite-note').textContent = view.invite ? t('invited', { roomId: view.invite }) : '';
  $('create').disabled = view.busy;
  $('join').disabled = view.busy;
  const text = localError || (view.error ? message(view.error) : '');
  $('lobby-error').textContent = text;
  $('lobby-error').hidden = !text;
  $('open-site-settings').hidden = Boolean(localError) || view.error !== 'loopback_permission';
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
  renderSeek();
  const queue = room ? room.queue : [];
  // A server older than the history sends none.
  const history = room && room.history ? room.history : [];
  const playedChanged = renderPlayed(history);
  renderCurrent(room ? room.current : null);
  renderQueue(queue, { animate: true });
  // A server older than the standby queue sends none.
  renderStandby(room && room.standby ? room.standby : []);
  $('shuffle-queue').hidden = !canControl() || queue.length < 2;
  $('save-playlist').hidden = history.length === 0 && !(room && room.current) && queue.length === 0;
  // When another song has finished, the queue scrolls so that the last one that
  // played is at its top, with the song that plays and the songs that wait below
  // it. The rows below must be in place first, or there is nothing to scroll.
  if (playedChanged) {
    const last = $('played').lastElementChild;
    $('queue-scroll').scrollTop = last ? last.offsetTop : 0;
  }
}

// The song that plays, framed between the songs that played and the songs that wait.
function renderCurrent(item) {
  const key = item ? item.id : '';
  if (key === rendered.current) return;
  rendered.current = key;
  $('current').replaceChildren(...(item ? [songRow(item, item.artists, emptyAction(), item.addedBy)] : []));
}

// The songs that played, in gray above the song that plays, each with a button
// that adds it to the queue again. Tells whether they changed.
function renderPlayed(history) {
  const key = JSON.stringify(history.map((item) => item.id));
  if (key === rendered.played) return false;
  rendered.played = key;
  $('played').replaceChildren(...history.map((item) => songRow(item, item.artists, addButton(trackOf(item), 'addAgain'), item.addedBy)));
  return true;
}

// The song of an item in the room, without what the room added to it.
function trackOf(item) {
  const { videoId, title, artists, album, duration, thumbnail } = item;
  return { videoId, title, artists, album, duration, thumbnail };
}

// The host ends the room for everyone with one click, and can take it back while
// the tab counts down; the button then says so.
function renderLeave() {
  const host = isHost();
  const ending = Boolean(host && view.endingUntil);
  $('leave').textContent = t(!host ? 'leave' : ending ? 'undoEnd' : 'endRoom');
  renderEnding();
}

function renderEnding() {
  const until = view && view.endingUntil;
  $('ending').hidden = !until;
  // The count stops at 1: the room ends then, and the popup moves to the lobby.
  if (until) $('ending').textContent = t('endingIn', { seconds: Math.max(1, Math.ceil((until - Date.now()) / 1000)) });
}

setInterval(() => {
  if (view && view.endingUntil) renderEnding();
}, 250);

// One line for the host and one for everyone else. A host who has closed
// the tab is not in the list.
function renderMembers(members, hostId) {
  const host = members.find((member) => member.id === hostId);
  const guests = members.filter((member) => member.id !== hostId);
  if (host) $('host-member').replaceChildren(memberLine(host));
  else $('host-member').textContent = t('hostAbsent');
  $('host-member').classList.toggle('absent', !host);
  // Everyone else is in a list that is closed until it is opened.
  $('guests').hidden = guests.length === 0;
  $('guest-list').replaceChildren(...guests.map((member) => {
    const li = document.createElement('li');
    li.append(memberLine(member));
    return li;
  }));
}

// A member's name, after a mark that tells whether the member listens: bars
// while their player plays, and a pause while it does not. A server older than
// this mark does not say, and the name stands alone.
function memberLine(member) {
  const line = document.createElement('span');
  line.className = 'member';
  const name = document.createElement('span');
  name.className = 'member-name';
  name.textContent = member.name;
  if (typeof member.listening === 'boolean') {
    const mark = icon(member.listening ? 'icon-listening' : 'icon-pause');
    mark.classList.add('presence', member.listening ? 'on' : 'off');
    const label = t(member.listening ? 'memberListening' : 'memberPaused', { name: member.name });
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', label);
    line.title = label;
    line.append(mark);
  }
  line.append(name);
  return line;
}

// Everyone pauses and plays their own player; skipping is the room's.
// The block stays while nothing plays, with its lines empty and its buttons off,
// so that nothing below it moves when a song starts.
function renderNow(room) {
  const item = room && room.current;
  $('next').hidden = !canControl();
  $('next').disabled = !item;
  const toggle = $('toggle');
  toggle.disabled = !item;
  toggle.classList.toggle('playing', Boolean(item) && view.listening);
  const label = t(view.listening ? 'pauseOwn' : 'playFromRoom');
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  const key = item ? item.id : '';
  if (key === rendered.now) return;
  rendered.now = key;
  stopMarquee($('now'));
  $('now-art').replaceChildren(...(item ? [artwork(item.thumbnail)] : []));
  setLine($('now-title'), item ? item.title : '');
  setLine($('now-sub'), item ? item.artists : '');
  showAddedBy($('now-by'), item ? item.addedBy : '');
}

// The songs that wait, in Main or in Standby. Members remove the songs they
// added; the host removes any song. Changing the order needs the same
// permission as skipping. The rows stay as they are while a song is dragged.
const SHUFFLE_MIN_MS = 240;
const SHUFFLE_TIMEOUT_MS = 2000;
const REFRESH_ENTER_MS = 280;
const REFRESH_STAGGER_MS = 45;
const REFRESH_MAX_DELAY_MS = 225;

let shuffleWait = null; // { until, timer, pending }

function clearShuffleWait() {
  if (!shuffleWait) return;
  clearTimeout(shuffleWait.timer);
  shuffleWait = null;
  $('queue').classList.remove('shuffling');
}

function startShuffleFeedback() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const button = $('shuffle-queue');
  button.classList.remove('shuffling');
  void button.offsetWidth;
  button.classList.add('shuffling');
  clearShuffleWait();
  const list = $('queue');
  list.classList.remove('shuffling');
  void list.offsetWidth;
  list.classList.add('shuffling');
  shuffleWait = {
    until: Date.now() + SHUFFLE_MIN_MS,
    pending: null,
    timer: setTimeout(clearShuffleWait, SHUFFLE_TIMEOUT_MS),
  };
}

function renderWaiting(name, items, { animate = false } = {}) {
  if (drag) return false;
  const removable = (item) => isHost() || item.addedById === view.memberId;
  const movable = canControl();
  const key = JSON.stringify([movable, items.map((item) => [item.id, removable(item)])]);
  if (key === rendered[name]) return false;
  const list = $(name);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reordered = animate && !reduced && isReordered(list, items);

  // Keep the shimmer visible briefly before revealing the shuffled order so
  // even a fast local server feels like a clear refresh.
  if (name === 'queue' && shuffleWait && reordered) {
    const remaining = shuffleWait.until - Date.now();
    if (remaining > 0) {
      shuffleWait.pending = items;
      clearTimeout(shuffleWait.timer);
      shuffleWait.timer = setTimeout(() => {
        const next = shuffleWait && shuffleWait.pending;
        clearShuffleWait();
        if (next && view && view.room) renderQueue(view.room.queue, { animate: true });
      }, remaining);
      return false;
    }
    clearShuffleWait();
  } else if (name === 'queue' && shuffleWait && !animate) {
    clearShuffleWait();
  }

  rendered[name] = key;
  list.replaceChildren(...items.map((item) => {
    let action = emptyAction();
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
  if (reordered) animateQueueRefresh(list);
  return true;
}

// Reports whether the shared songs actually changed their relative order.
function isReordered(list, items) {
  const prevRows = [...list.children];
  if (prevRows.length < 2 || items.length < 2) return false;
  const prevOrder = prevRows.map((li) => li.dataset.itemId);
  const nextOrder = items.map((item) => item.id);
  const nextSet = new Set(nextOrder);
  const prevSet = new Set(prevOrder);
  const prevCommon = prevOrder.filter((id) => nextSet.has(id));
  const nextCommon = nextOrder.filter((id) => prevSet.has(id));
  return prevCommon.length >= 2 && prevCommon.some((id, i) => id !== nextCommon[i]);
}

// Reveals the refreshed queue order with a clean top-to-bottom fade-in.
function animateQueueRefresh(list) {
  [...list.children].forEach((li, index) => {
    li.animate(
      [
        { opacity: 0, transform: 'translateY(6px)' },
        { opacity: 1, transform: 'none' },
      ],
      {
        duration: REFRESH_ENTER_MS,
        delay: Math.min(index * REFRESH_STAGGER_MS, REFRESH_MAX_DELAY_MS),
        easing: 'ease-out',
        fill: 'backwards',
      }
    );
  });
}

function renderQueue(queue, options) {
  $('queue-count').textContent = queue.length === 1 ? t('standbyCountOne') : t('standbyCount', { count: queue.length });
  renderWaiting('queue', queue, options);
}

// Standby, the songs that play once Main is empty, sits folded below Main with
// the number of its songs, and opens with a click on its heading.
function renderStandby(standby) {
  $('standby-count').textContent = standby.length === 1 ? t('standbyCountOne') : t('standbyCount', { count: standby.length });
  renderWaiting('standby', standby);
}

// The empty row of Standby says so in the language of the popup.
$('standby').dataset.empty = t('standbyEmpty');

let standbyOpen = false;
try {
  standbyOpen = localStorage.getItem('standbyFold') === 'open';
} catch {
  // Standby starts folded.
}

function applyStandbyFold() {
  $('standby-scroll').hidden = !standbyOpen;
  $('standby-head').setAttribute('aria-expanded', String(standbyOpen));
  const label = t(standbyOpen ? 'foldList' : 'expandList');
  $('standby-head').title = label;
}

$('standby-head').addEventListener('click', () => {
  standbyOpen = !standbyOpen;
  applyStandbyFold();
  try {
    localStorage.setItem('standbyFold', standbyOpen ? 'open' : 'folded');
  } catch {
    // Remembering it is only a convenience.
  }
});
applyStandbyFold();

// --- reordering the queue ---

// A waiting song is dragged up or down: within Main, within Standby, or from
// one to the other across the heading of Standby. The row follows the
// pointer, the others slide aside to make room, and the room gets the new
// place when the row is let go: in the list on its side of the heading. Over a
// folded Standby, the song goes to the end of Standby. This uses pointer
// events rather than the browser's drag and drop, so that the row itself moves
// instead of a faded copy of it.
const DRAG_THRESHOLD = 4; // px the pointer moves before a press becomes a drag
const DRAG_EDGE = 24; // px from the list's top or bottom where the list scrolls
const DRAG_SCROLL = 6; // px the list scrolls per frame there
const SETTLE_MS = 150;

let drag = null; // { li, pointerId, startY, y, active, zoom, height, fromList, fromIndex, toList, toIndex, placeholder, frame }

function listScroller(name) {
  return name === 'standby' ? $('standby-scroll') : $('queue-scroll');
}

function listSiblings(name) {
  return [...$(name).children].filter((row) => row !== drag.li && row !== drag.placeholder);
}

function startDrag() {
  const zoom = Number(document.documentElement.style.zoom) || 1;
  const rect = drag.li.getBoundingClientRect();
  const fromList = drag.li.parentElement.id;
  const siblings = [...drag.li.parentElement.children];
  const fromIndex = siblings.indexOf(drag.li);
  const placeholder = document.createElement('li');
  placeholder.className = 'drag-placeholder';
  placeholder.style.height = `${drag.li.offsetHeight}px`;
  drag.li.before(placeholder);
  drag.active = true;
  drag.zoom = zoom;
  drag.height = drag.li.offsetHeight;
  drag.rect = rect;
  drag.fromList = fromList;
  drag.fromIndex = fromIndex;
  drag.toList = fromList;
  drag.toIndex = fromIndex;
  drag.placeholder = placeholder;
  stopMarquee(drag.li);
  $('queue-body').classList.add('sorting');
  drag.li.classList.add('dragging');
  drag.li.style.top = `${rect.top / zoom}px`;
  drag.li.style.left = `${rect.left / zoom}px`;
  drag.li.style.width = `${rect.width / zoom}px`;
  drag.frame = requestAnimationFrame(dragFrame);
}

// Near the top or bottom of either scrollable list, that list scrolls under the dragged row.
function dragFrame() {
  for (const scroller of [$('queue-scroll'), $('standby-scroll')]) {
    if (scroller.hidden) continue;
    const box = scroller.getBoundingClientRect();
    if (drag.y < box.top || drag.y > box.bottom) continue;
    if (drag.y < box.top + DRAG_EDGE) scroller.scrollTop -= DRAG_SCROLL;
    else if (drag.y > box.bottom - DRAG_EDGE) scroller.scrollTop += DRAG_SCROLL;
  }
  layoutDrag();
  drag.frame = requestAnimationFrame(dragFrame);
}

// Returns the target insertion index among a list's siblings based on unshifted layout positions.
function dragIndexIn(name, y) {
  const scroller = listScroller(name);
  const scrollerTop = scroller.getBoundingClientRect().top;
  const rows = listSiblings(name);
  let index = 0;
  for (const row of rows) {
    const mid = scrollerTop + (row.offsetTop - scroller.scrollTop + row.offsetHeight / 2) * drag.zoom;
    if (y > mid) index += 1;
  }
  return index;
}

function layoutDrag() {
  const bodyRect = $('queue-body').getBoundingClientRect();
  const minShift = bodyRect.top - drag.rect.top;
  const maxShift = bodyRect.bottom - drag.rect.bottom;
  const shift = Math.min(Math.max(drag.y - drag.startY, minShift), maxShift);
  drag.li.style.transform = `translateY(${shift / drag.zoom}px)`;

  const headRect = $('standby-head').getBoundingClientRect();
  const standbyOpenNow = !$('standby-scroll').hidden;
  const pointerY = drag.rect.top + shift + drag.rect.height / 2;

  if (pointerY >= headRect.top) {
    drag.toList = 'standby';
    if (!standbyOpenNow) {
      drag.toIndex = -1;
      $('standby-section').classList.add('drop-target');
    } else {
      $('standby-section').classList.remove('drop-target');
      drag.toIndex = pointerY < headRect.bottom ? 0 : dragIndexIn('standby', pointerY);
    }
  } else {
    $('standby-section').classList.remove('drop-target');
    drag.toList = 'queue';
    drag.toIndex = dragIndexIn('queue', pointerY);
  }

  for (const name of ['queue', 'standby']) {
    const rows = listSiblings(name);
    rows.forEach((row, i) => {
      let offset = 0;
      if (name === drag.fromList && name === drag.toList) {
        if (drag.fromIndex <= i && i < drag.toIndex) offset = -drag.height;
        else if (drag.toIndex <= i && i < drag.fromIndex) offset = drag.height;
      } else if (name === drag.fromList) {
        if (i >= drag.fromIndex) offset = -drag.height;
      } else if (name === drag.toList && drag.toIndex >= 0) {
        if (i >= drag.toIndex) offset = drag.height;
      }
      row.style.transform = offset ? `translateY(${offset}px)` : '';
    });
  }
}

// A dropped song takes its new place in the popup at once, and in the room
// through the tab. A cancelled drag puts the rows back.
function finishDrag(drop) {
  const d = drag;
  drag = null;
  if (!d.active) {
    if (view && view.room) renderLists();
    return;
  }
  cancelAnimationFrame(d.frame);
  const itemId = d.li.dataset.itemId;
  const droppedTop = d.li.getBoundingClientRect().top;
  const targetRows = [...$(d.toList).children].filter((row) => row !== d.li && row !== d.placeholder);
  const below = d.toIndex < 0 ? [] : targetRows.slice(d.toIndex).map((row) => row.dataset.itemId);
  d.placeholder.remove();
  $('queue-body').classList.remove('sorting');
  $('standby-section').classList.remove('drop-target');
  d.li.classList.remove('dragging');
  d.li.style.top = '';
  d.li.style.left = '';
  d.li.style.width = '';
  d.li.style.transform = '';
  for (const row of [...$('queue').children, ...$('standby').children]) row.style.transform = '';
  if (!view || !view.room) return;
  if (drop && (d.toList !== d.fromList || d.toIndex !== d.fromIndex)) moveSong(itemId, below, d.toList);
  renderLists();
  settle(itemId, droppedTop);
}

function renderLists() {
  rendered.queue = '';
  rendered.standby = '';
  renderQueue(view.room.queue);
  renderStandby(view.room.standby || []);
}

// The song goes into the list, before the first of the given songs still in
// it, or last when none of them is.
function moveSong(itemId, beforeIds, list) {
  const room = view.room;
  room.standby = room.standby || [];
  const fromName = room.queue.some((it) => it.id === itemId) ? 'queue' : 'standby';
  const item = room[fromName].find((it) => it.id === itemId);
  if (!item) return;
  room[fromName] = room[fromName].filter((it) => it !== item);
  const rest = room[list];
  const found = rest.findIndex((it) => beforeIds.includes(it.id));
  const index = found < 0 ? rest.length : found;
  rest.splice(index, 0, item);
  post({ type: 'move', itemId, index, list });
}

// The dropped row glides from where it was let go into its place.
function settle(itemId, fromTop) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const li = [...$('queue').children, ...$('standby').children].find((row) => row.dataset.itemId === itemId);
  if (!li) return;
  const offset = fromTop - li.getBoundingClientRect().top;
  if (Math.abs(offset) < 1) return;
  li.animate([{ transform: `translateY(${offset}px)` }, { transform: 'none' }], { duration: SETTLE_MS, easing: 'ease-out' });
}

$('queue-body').addEventListener('pointerdown', (event) => {
  const li = event.target.closest('li.movable');
  if (!li || drag || event.button !== 0 || event.target.closest('button')) return;
  drag = { li, pointerId: event.pointerId, startY: event.clientY, y: event.clientY, active: false };
  $('queue-body').setPointerCapture(event.pointerId);
});

$('queue-body').addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.y = event.clientY;
  if (!drag.active && Math.abs(drag.y - drag.startY) >= DRAG_THRESHOLD) startDrag();
});

$('queue-body').addEventListener('pointerup', (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.y = event.clientY;
  if (drag.active) layoutDrag();
  finishDrag(true);
});

for (const type of ['pointercancel', 'lostpointercapture']) {
  $('queue-body').addEventListener(type, (event) => {
    if (drag && event.pointerId === drag.pointerId) finishDrag(false);
  });
}

// --- seek bar ---

// The bar shows where the room is in its song, by the clock of the room
// server, which the tab measures. The host, and participants with the
// permission, drag it; the room moves there when the bar is let go.
let seeking = false; // while the bar is held

function roomPosition(room) {
  const item = room && room.current;
  if (!item) return 0;
  const playback = room.playback;
  const now = Date.now() + (view.clockOffset || 0);
  const position = playback.playing ? playback.position + (now - playback.updatedAt) / 1000 : playback.position;
  return Math.max(0, item.duration > 0 ? Math.min(position, item.duration) : position);
}

// Minutes and seconds, as 1:05, or with hours, as 1:02:05.
function clock(seconds) {
  const s = Math.floor(seconds);
  const parts = s >= 3600 ? [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60] : [Math.floor(s / 60), s % 60];
  return parts.map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, '0'))).join(':');
}

// The part of the bar up to the position takes the accent.
function paintSeek() {
  const bar = $('seek');
  const max = Number(bar.max) || 1;
  bar.style.setProperty('--progress', `${(Number(bar.value) / max) * 100}%`);
}

function renderSeek() {
  const room = view && view.room;
  const item = room && room.current;
  const bar = $('seek');
  const known = Boolean(item && item.duration > 0);
  bar.disabled = !known || !canControl();
  $('seek-end').textContent = known ? clock(item.duration) : '';
  if (seeking) return;
  const position = roomPosition(room);
  bar.max = String(known ? item.duration : 1);
  bar.value = String(known ? position : 0);
  $('seek-at').textContent = item ? clock(position) : '';
  paintSeek();
}

setInterval(() => {
  if (view && view.room && !seeking) renderSeek();
}, 250);

$('seek').addEventListener('pointerdown', () => {
  seeking = true;
});
window.addEventListener('pointerup', () => {
  seeking = false;
});
$('seek').addEventListener('input', () => {
  seeking = true;
  $('seek-at').textContent = clock(Number($('seek').value));
  paintSeek();
});
$('seek').addEventListener('change', () => {
  seeking = false;
  post({ type: 'seek', position: Number($('seek').value) });
});

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

// The place of a row's button, in a row that has none.
function emptyAction() {
  const slot = document.createElement('span');
  slot.className = 'action-slot';
  return slot;
}

// Who added the song, at the end of the line of the artists: a small person and the name.
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

// A short message at the bottom of the popup. One with an action, such as
// opening a playlist, stays longer, so that there is time to click it.
const TOAST_ACTION_MS = 8000;

function toast(text, action) {
  const box = $('toast');
  const words = document.createElement('span');
  words.textContent = text;
  box.replaceChildren(words);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      box.hidden = true;
      action.run();
    });
    box.append(button);
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, action ? TOAST_ACTION_MS : TOAST_MS);
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
    const subtitle = [track.artists, formatDuration(track.duration)].filter(Boolean).join(' • ');
    const actions = document.createElement('span');
    actions.className = 'row-actions';
    actions.append(addButton(track, 'addStandby', 'standby', 'icon-standby'), addButton(track, 'add'));
    return songRow(track, subtitle, actions);
  }));
}

// A button that adds a song to Main, or to Standby, and then shows that it did.
function addButton(track, label, list = 'queue', iconId = 'icon-add') {
  const button = iconButton(iconId, t(label));
  button.addEventListener('click', () => {
    post({ type: 'add', track, list });
    button.replaceChildren(icon('icon-check'));
    button.disabled = true;
    button.setAttribute('aria-label', t('added'));
    button.title = t('added');
  });
  return button;
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

// --- dropping songs ---

// A song, an album, or a playlist dragged from YouTube Music onto the room
// goes to the end of the queue. This works in the side panel and in the window
// on top; the mini window closes as soon as the page is touched. A link that
// is dropped anywhere else does nothing, rather than open in this page.
function droppedItems(transfer) {
  const text = transfer.getData('text/uri-list') || transfer.getData('text/plain') || '';
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    let url;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    const host = url.hostname.replace(/^(www|m)\./, '');
    if (host === 'youtu.be') {
      items.push({ videoId: url.pathname.slice(1) });
    } else if (host === 'music.youtube.com' || host === 'youtube.com') {
      const album = url.pathname.match(/^\/browse\/(MPREb_[\w-]+)$/);
      if (url.pathname === '/watch' && url.searchParams.get('v')) items.push({ videoId: url.searchParams.get('v') });
      else if (url.pathname === '/playlist' && url.searchParams.get('list')) items.push({ playlistId: url.searchParams.get('list') });
      else if (album) items.push({ browseId: album[1] });
    }
  }
  return items;
}

const carriesLinks = (event) => [...event.dataTransfer.types].some((type) => type === 'text/uri-list' || type === 'text/plain');
const dropOpen = () => Boolean(view && view.status === 'connected' && !settingsOpen && !$('room').hidden);
let dragDepth = 0;

document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());

// A song dropped among the songs of the queue goes to that place: before the
// row under the upper half of the pointer, after it under the lower half. The
// songs are Main's, then the heading of Standby, then Standby's while it is
// open; over the songs that played, the song goes first in Main. A line shows
// the place. Dropped on the heading of a folded Standby, the song takes a
// random place in Standby; dropped anywhere else in the room, it goes to the
// end of Main.
function dropPlace(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || !target.closest('#queue-body')) return { list: 'queue' };
  const y = event.clientY;
  const open = !$('standby-scroll').hidden;
  const head = $('standby-head').getBoundingClientRect();
  const placeAmong = (rows) => {
    const index = rows.findIndex((row) => y < row.getBoundingClientRect().top + row.offsetHeight / 2);
    return index < 0 ? rows.length : index;
  };
  if (y >= head.top) {
    if (!open) return { list: 'standby' };
    return { list: 'standby', index: y < head.bottom ? 0 : placeAmong([...$('standby').children]) };
  }
  return { list: 'queue', index: placeAmong([...$('queue').children]) };
}

// The line sits between the rows where the song will go.
function showDropLine(place) {
  $('drop-line').hidden = true;
  $('standby-drop-line').hidden = true;
  if (!place || place.index === undefined) return;
  const line = place.list === 'standby' ? $('standby-drop-line') : $('drop-line');
  const rows = [...$(place.list).children];
  let top;
  if (place.index < rows.length) top = rows[place.index].offsetTop;
  else if (rows.length > 0) top = rows[rows.length - 1].offsetTop + rows[rows.length - 1].offsetHeight;
  else top = place.list === 'standby' ? 0 : $('queue').offsetTop;
  line.style.top = `${top - 1}px`;
  line.hidden = false;
}

function markDrop(place) {
  $('queue-panel').classList.toggle('drop-target', Boolean(place) && place.list === 'queue');
  $('standby-section').classList.toggle('drop-target', Boolean(place) && place.list === 'standby' && place.index === undefined);
  showDropLine(place);
}

// Near the top or bottom of either scrollable list, that list scrolls under the song.
function scrollForDrop(event) {
  for (const scroller of [$('queue-scroll'), $('standby-scroll')]) {
    if (scroller.hidden) continue;
    const box = scroller.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right) continue;
    if (event.clientY < box.top + DRAG_EDGE && event.clientY >= box.top) scroller.scrollTop -= DRAG_SCROLL;
    else if (event.clientY > box.bottom - DRAG_EDGE && event.clientY <= box.bottom) scroller.scrollTop += DRAG_SCROLL;
  }
}

$('room').addEventListener('dragenter', (event) => {
  if (!carriesLinks(event) || !dropOpen()) return;
  dragDepth += 1;
  markDrop(dropPlace(event));
});

$('room').addEventListener('dragover', (event) => {
  if (!carriesLinks(event) || !dropOpen()) return;
  event.dataTransfer.dropEffect = 'copy';
  scrollForDrop(event);
  markDrop(dropPlace(event));
});

$('room').addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) markDrop(null);
});

$('room').addEventListener('drop', (event) => {
  dragDepth = 0;
  const place = dropPlace(event);
  markDrop(null);
  if (!dropOpen()) return;
  const items = droppedItems(event.dataTransfer);
  if (items.length === 0) {
    toast(t('drop_nothing'));
    return;
  }
  post({ type: 'drop', items, list: place.list, ...(place.index === undefined ? {} : { index: place.index }) });
});

// --- saving the songs as a playlist ---

// Main becomes a private playlist of this listener's YouTube Music: the songs
// that played, the song that plays, and the songs that wait, named after the
// moment it is made. Without an answer within PLAYLIST_WAIT_MS, the button
// comes back and the popup tells of the failure.
const PLAYLIST_WAIT_MS = 30000;
let playlistSeq = 0;
let playlistTimer = 0;

function stamp(date) {
  const two = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

$('save-playlist').addEventListener('click', () => {
  playlistSeq += 1;
  const seq = playlistSeq;
  $('save-playlist').disabled = true;
  clearTimeout(playlistTimer);
  playlistTimer = setTimeout(() => onPlaylistResult({ reqId: seq, error: 'failed' }), PLAYLIST_WAIT_MS);
  post({ type: 'save-playlist', reqId: playlistSeq, title: t('playlistTitle', { date: stamp(new Date()) }), description: t('playlistDescription') });
});

function onPlaylistResult(message) {
  if (message.reqId !== playlistSeq) return;
  playlistSeq += 1;
  clearTimeout(playlistTimer);
  $('save-playlist').disabled = false;
  if (message.error) {
    toast(t(message.error === 'nothing' ? 'playlistNothing' : 'playlistFailed'));
    return;
  }
  toast(t('playlistSaved', { title: message.title }), {
    label: t('openPlaylist'),
    run: () => chrome.tabs.create({ url: `${YTM_URL}playlist?list=${encodeURIComponent(message.playlistId)}` }),
  });
}

// --- folding the queue ---

// The queue grows down to the bottom of the window with one click, and folds
// back with another. It keeps its state for the next popup. The switch keeps
// the place in the list:
// - Expanding leaves the list where it is and shows more songs below. Near the
//   end of the list, the songs move down to fill the taller list.
// - Folding again goes back to the place the folded list had. When the list
//   was scrolled in between, the song at the top of what shows goes to the top
//   of the folded list instead.

// The first song that shows in the list.
function topRow(scroller) {
  const edge = Math.max(scroller.getBoundingClientRect().top, 0);
  return [...scroller.querySelectorAll('li')].find((li) => li.getBoundingClientRect().bottom > edge + 1) || null;
}

function setupFold(button, panel, body, scroller, key) {
  let open = false;
  try {
    open = localStorage.getItem(key) === 'open';
  } catch {
    // Remembering it is only a convenience.
  }
  let folded = null; // { listTop, listAfter }: where the list was before and after expanding
  const apply = () => {
    panel.classList.toggle('expanded', open);
    button.setAttribute('aria-expanded', String(open));
    button.title = button.disabled ? '' : t(open ? 'foldList' : 'expandList');
  };
  apply();

  // The chevron shows only while the songs do not fit in the folded queue. A
  // queue whose songs fit is folded.
  const fit = () => {
    const last = scroller.lastElementChild;
    const mainContent = last ? last.offsetTop + last.offsetHeight : 0;
    const foldedHeight = parseFloat(getComputedStyle(body).getPropertyValue('--queue-folded')) || 0;
    const standbyHeadHeight = $('standby-head').offsetHeight;
    const standbyContent = $('standby-scroll').hidden ? 0 : $('standby').offsetHeight;
    const standbyNeeded = standbyHeadHeight + standbyContent;
    const standbyMax = foldedHeight * 0.5;
    const fits = mainContent + Math.min(standbyNeeded, standbyMax) <= foldedHeight + 1 && standbyNeeded <= standbyMax + 1;
    button.classList.toggle('unneeded', fits);
    button.disabled = fits;
    if (fits && open) {
      open = false;
      folded = null;
      remember();
    }
    apply();
  };
  const watcher = new ResizeObserver(fit);
  watcher.observe(body);
  watcher.observe(scroller);
  for (const list of scroller.children) watcher.observe(list);
  watcher.observe($('standby-section'));
  watcher.observe($('standby-scroll'));
  watcher.observe($('standby'));

  button.addEventListener('click', () => {
    if (!open) {
      folded = { listTop: scroller.scrollTop };
      open = true;
      apply();
      folded.listAfter = scroller.scrollTop;
    } else {
      const back = folded && scroller.scrollTop === folded.listAfter ? folded : null;
      const anchor = back ? null : topRow(scroller);
      open = false;
      apply();
      if (back) scroller.scrollTop = back.listTop;
      else if (anchor) scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      folded = null;
    }
    remember();
  });

  function remember() {
    try {
      localStorage.setItem(key, open ? 'open' : 'folded');
    } catch {
      // Remembering it is only a convenience.
    }
  }
}

setupFold($('queue-fold'), $('queue-panel'), $('queue-body'), $('queue-scroll'), 'queueFold');

// --- settings ---

// A server on this computer needs the site's permission to reach this computer,
// which the site settings of YouTube Music grant.
$('open-site-settings').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://settings/content/siteDetails?site=' + encodeURIComponent('https://music.youtube.com') });
});

// The gear opens the settings in the popup, and closes them again. It stays
// lit while they are open. Opening unfolds the setting cards from the gear
// with a slight stagger; closing folds them back toward it.
const VIEW_SECTIONS = ['no-tab', 'reload', 'setup', 'lobby', 'room', 'settings-view'];
const SETTINGS_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

function visibleView() {
  for (const id of VIEW_SECTIONS) {
    const el = $(id);
    if (!el.hidden) return el;
  }
  return null;
}

function finishSettingsTransition() {
  if (!settingsTransition) return;
  const { leaving, entering, animations } = settingsTransition;
  settingsTransition = null;
  for (const anim of animations) anim.cancel();
  const main = document.querySelector('main');
  main.classList.remove('view-transitioning');
  if (leaving) {
    leaving.classList.remove('view-leaving');
    leaving.style.top = '';
    leaving.hidden = true;
  }
  if (entering) entering.classList.remove('view-entering');
}

function animateSettingsTransition(fromEl, fromTop, toEl, open) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !toEl || fromEl === toEl) return;
  const main = document.querySelector('main');
  const animations = [];
  main.classList.add('view-transitioning');
  toEl.classList.add('view-entering');
  if (fromEl) {
    fromEl.hidden = false;
    fromEl.classList.add('view-leaving');
    fromEl.style.top = `${fromTop}px`;
    animations.push(
      fromEl.animate(
        open
          ? [
              { opacity: 1, transform: 'none' },
              { opacity: 0, transform: 'translateY(6px) scale(0.985)' },
            ]
          : [
              { opacity: 1, transform: 'none' },
              { opacity: 0, transform: 'translateY(-8px) scale(0.97)' },
            ],
        { duration: 160, easing: SETTINGS_EASE, fill: 'forwards' }
      )
    );
  }
  if (open) {
    [...toEl.querySelectorAll(':scope > .panel')].forEach((panel, index) => {
      animations.push(
        panel.animate(
          [
            { opacity: 0, transform: 'translateY(-10px) scale(0.96)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 240, delay: 25 + index * 45, easing: SETTINGS_EASE, fill: 'backwards' }
        )
      );
    });
  } else {
    animations.push(
      toEl.animate(
        [
          { opacity: 0, transform: 'translateY(6px) scale(0.985)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 210, delay: 20, easing: SETTINGS_EASE, fill: 'backwards' }
      )
    );
    if (!$('leave').hidden) {
      animations.push(
        $('leave').animate(
          [
            { opacity: 0, transform: 'scale(0.92)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 180, easing: 'ease-out', fill: 'backwards' }
        )
      );
    }
  }
  const current = { leaving: fromEl, entering: toEl, animations };
  settingsTransition = current;
  Promise.all(animations.map((a) => a.finished.catch(() => {}))).then(() => {
    if (settingsTransition === current) finishSettingsTransition();
  });
}

function showSettings(open) {
  finishSettingsTransition();
  const fromEl = visibleView();
  const fromTop = fromEl ? fromEl.offsetTop : 0;
  settingsOpen = open;
  $('settings-error').hidden = true;
  showSaved(false);
  render();
  const toEl = visibleView();
  animateSettingsTransition(fromEl, fromTop, toEl, open);
  document.scrollingElement.scrollTop = 0;
  if (open && !configured) $('server').focus();
}

$('settings').addEventListener('click', () => showSettings(!settingsOpen));
$('open-settings').addEventListener('click', () => showSettings(true));

// Saving turns the button into a check, which stays until a field changes
// again. The words of the button tell readers of the screen.
function showSaved(saved) {
  const button = $('save');
  button.classList.toggle('saved', saved);
  if (saved) {
    button.replaceChildren(icon('icon-check'));
    button.setAttribute('aria-label', t('saved'));
  } else {
    button.textContent = t('save');
    button.removeAttribute('aria-label');
  }
}

// Shows what is wrong with a setting and puts the cursor in it.
function refuseSetting(input, key) {
  $('settings-error').textContent = t(key);
  $('settings-error').hidden = false;
  input.focus();
  return null;
}

// Chrome lets the page of YouTube Music, which is HTTPS, reach a server over
// HTTP only on this computer, so http:// is taken for these hosts alone.
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// The address is kept without a trailing slash, as the tab adds the paths of
// the API to it. The token travels in an HTTP header, which takes ASCII only.
function readServer() {
  const text = $('server').value.trim();
  if (!text) return refuseSetting($('server'), 'enterServer');
  if (!/^https?:\/\//i.test(text)) return refuseSetting($('server'), 'serverHttps');
  let url;
  try {
    url = new URL(text);
  } catch {
    return refuseSetting($('server'), 'serverInvalid');
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.includes(url.hostname)) return refuseSetting($('server'), 'serverHttps');
  if (url.username || url.password || url.search || url.hash) return refuseSetting($('server'), 'serverInvalid');
  const value = $('token').value.trim();
  if (!value) return refuseSetting($('token'), 'enterToken');
  if (!/^[\x21-\x7e]+$/.test(value)) return refuseSetting($('token'), 'tokenAscii');
  return { server: url.origin + url.pathname.replace(/\/+$/, ''), token: value };
}

// A new language reloads the popup, so that every word changes at once, and
// the popup opens on the settings again.
$('language').addEventListener('change', async () => {
  const chosen = $('language').value;
  if (!LANGUAGES.includes(chosen)) return;
  await chrome.storage.local.set({ language: chosen });
  history.replaceState(null, '', '#settings');
  location.reload();
});

// The service worker applies the way the button opens, from the next click of
// the button. Leaving the side panel closes it at once.
for (const radio of document.querySelectorAll('input[name="display"]')) {
  radio.checked = radio.value === (display === 'panel' ? 'panel' : 'window');
  radio.addEventListener('change', () => {
    if (radio.checked) chrome.storage.local.set({ display: radio.value === 'panel' ? 'panel' : 'window' });
  });
}

// The tab of a room reads the server and the token when it creates or joins a
// room, so a room keeps the server it began with.
$('server-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('settings-error').hidden = true;
  const settings = readServer();
  if (!settings) return;
  await chrome.storage.local.set(settings);
  $('server').value = settings.server;
  $('token').value = settings.token;
  configured = true;
  showSaved(true);
  render();
});

for (const id of ['server', 'token']) {
  $(id).addEventListener('input', () => {
    $('settings-error').hidden = true;
    showSaved(false);
  });
}

$('language').value = language;
$('server').value = server || '';
$('token').value = token || '';

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

// The invite link opens YouTube Music and joins this room.
$('copy-invite').addEventListener('click', async () => {
  if (!view || !view.roomId) return;
  try {
    await navigator.clipboard.writeText(`${YTM_URL}?musictogether=${view.roomId}`);
    toast(t('inviteCopied'));
  } catch {
    toast(t('copyFailed'));
  }
});

$('leave').addEventListener('click', () => {
  if (!isHost()) {
    hideResults();
    post({ type: 'leave' });
  } else {
    post({ type: view.endingUntil ? 'undo-close' : 'close' });
  }
});

$('participant-control').addEventListener('change', () => {
  post({ type: 'participantControl', value: $('participant-control').checked });
});

$('now').addEventListener('mouseenter', () => startMarquee($('now')));
$('now').addEventListener('mouseleave', () => stopMarquee($('now')));
$('toggle').addEventListener('click', () => post({ type: 'toggle' }));
$('next').addEventListener('click', () => post({ type: 'next' }));
$('shuffle-queue').addEventListener('click', () => {
  startShuffleFeedback();
  post({ type: 'shuffle' });
});
$('shuffle-queue').addEventListener('animationend', () => {
  $('shuffle-queue').classList.remove('shuffling');
});

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
  if (lastRoomId && !shownInvite) $('room-id').value = lastRoomId;
});

refresh();
