// Remembers which tab is in a room, so that the popup can find that tab and a
// reloaded tab can rejoin. A browser is in at most one room at a time.

// The toolbar button opens the popup in one of two ways, as the settings
// say: a mini window under the button, which is the default, or Chrome's side
// panel on the right of the window. The side panel is turned off while the
// mini window is chosen, so that it does not show in Chrome's list of panels.
async function applyDisplay() {
  const { display } = await chrome.storage.local.get('display');
  const panel = display === 'panel';
  await chrome.action.setPopup({ popup: panel ? '' : 'popup/popup.html' });
  await chrome.sidePanel.setOptions({ enabled: panel });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: panel });
}

applyDisplay().catch(() => {});
chrome.runtime.onStartup.addListener(() => applyDisplay().catch(() => {}));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.display) applyDisplay().catch(() => {});
});

// Chrome updates this extension only when someone replaces its folder, so the
// extension asks GitHub once a day for the latest release. A newer version is
// kept as "update" for the popup, which shows a notice with a link to it.
const LATEST_RELEASE = 'https://api.github.com/repos/etak64n/musictogether/releases/latest';
const RELEASES_PAGE = 'https://github.com/etak64n/musictogether/releases/';
const UPDATE_ALARM = 'check-update';

// Whether version a, such as 0.10.0, comes after version b, such as 0.9.1.
function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const difference = (pa[i] || 0) - (pb[i] || 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

async function checkUpdate() {
  const response = await fetch(LATEST_RELEASE, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
  if (!response.ok) return;
  const release = await response.json();
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!/^\d+(\.\d+)*$/.test(version)) return;
  if (!isNewer(version, chrome.runtime.getManifest().version)) {
    await chrome.storage.local.remove('update');
    return;
  }
  // The link leads to the release on GitHub, and to the list of releases otherwise.
  const url = typeof release.html_url === 'string' && release.html_url.startsWith(RELEASES_PAGE) ? release.html_url : RELEASES_PAGE;
  await chrome.storage.local.set({ update: { version, url } });
}

// The alarm is made once, so that the service worker, which Chrome starts
// again and again, does not move the next check each time it starts.
chrome.alarms.get(UPDATE_ALARM).then((alarm) => {
  if (!alarm) chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) checkUpdate().catch(() => {});
});
// A new version of the extension forgets the notice of the old one, and looks again.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove('update').then(() => checkUpdate()).catch(() => {});
});

async function getRoomTab() {
  const { roomTab } = await chrome.storage.session.get('roomTab');
  return roomTab || null;
}

// The toolbar button shows how many songs wait in the room's queue, up to 99,
// as the tab in the room tells.
chrome.action.setBadgeBackgroundColor({ color: '#087f8c' });
chrome.action.setBadgeTextColor({ color: '#ffffff' });

function showQueueCount(count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(Math.min(count, 99)) : '' });
}

// Every tab of YouTube Music shows "Add to Music Together" in its menus while a
// tab of this Chrome is in a room, so every tab hears when that changes.
async function tellTabs(inRoom) {
  const tabs = await chrome.tabs.query({ url: 'https://music.youtube.com/*' });
  for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'room-state', inRoom }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  if (tabId === undefined || !message) return false;

  if (message.type === 'room-joined') {
    getRoomTab().then(async (previous) => {
      await chrome.storage.session.set({ roomTab: { tabId, roomId: message.roomId } });
      showQueueCount(0);
      if (previous && previous.tabId !== tabId) {
        chrome.tabs.sendMessage(previous.tabId, { type: 'leave-room' }).catch(() => {});
      }
      tellTabs(true);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'room-left') {
    getRoomTab().then(async (current) => {
      if (current && current.tabId === tabId) {
        await chrome.storage.session.remove('roomTab');
        showQueueCount(0);
        tellTabs(false);
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'queue-count') {
    getRoomTab().then((current) => {
      if (current && current.tabId === tabId) showQueueCount(message.count);
    });
    return false;
  }

  // Songs chosen in the menu of a tab outside the room go to the tab in the
  // room, which adds them, and the answer comes back to the tab that chose them.
  if (message.type === 'add-to-room') {
    const failed = { code: 'failed', count: 0 };
    getRoomTab().then(async (current) => {
      if (!current || current.tabId === tabId) {
        sendResponse(failed);
        return;
      }
      try {
        const answer = await chrome.tabs.sendMessage(current.tabId, { type: 'add-from-menu', songs: message.songs });
        sendResponse(answer && answer.code ? answer : failed);
      } catch {
        sendResponse(failed);
      }
    });
    return true;
  }

  if (message.type === 'which-room') {
    getRoomTab().then((current) => {
      sendResponse({ roomId: current && current.tabId === tabId ? current.roomId : null, inRoom: Boolean(current) });
    });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const current = await getRoomTab();
  if (current && current.tabId === tabId) {
    await chrome.storage.session.remove('roomTab');
    showQueueCount(0);
    tellTabs(false);
  }
});
