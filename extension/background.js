// Remembers which tab is in a room, so that the popup can find that tab and a
// reloaded tab can rejoin. A browser is in at most one room at a time.

// The toolbar button opens the popup in one of two ways, as the settings
// say: a mini window under the button, which is the default, or Chrome's side
// panel on the right of the window. The side panel is turned off while the
// mini window is chosen, so that it does not show in Chrome's list of panels.
// The mini window carries ?mini=1, so that the page tells it from the side panel.
const MINI_WINDOW = 'popup/popup.html?mini=1';

async function applyDisplay() {
  const { display } = await chrome.storage.local.get('display');
  const panel = display === 'panel';
  await chrome.action.setPopup({ popup: panel ? '' : MINI_WINDOW });
  await chrome.sidePanel.setOptions({ enabled: panel });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: panel });
}

applyDisplay().catch(() => {});
chrome.runtime.onStartup.addListener(() => {
  applyDisplay().catch(() => {});
  checkUpdate().catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.display) applyDisplay().catch(() => {});
});

// Chrome updates this extension only when someone replaces its folder, so the
// extension learns of new releases: from the room server, which tells the
// members of a room as soon as it finds one, and from GitHub, which the
// extension checks when the popup opens (at most every 10 minutes), on browser
// startup, and periodically in the background. A newer version is kept as
// "update" for the popup, which shows a notice with a link to it on every screen.
const LATEST_RELEASE = 'https://api.github.com/repos/etak64n/musictogether/releases/latest';
const RELEASES_PAGE = 'https://github.com/etak64n/musictogether/releases/';
const UPDATE_ALARM = 'check-update';
const UPDATE_PERIOD_MINUTES = 6 * 60;
const UPDATE_COOLDOWN_MS = 10 * 60 * 1000;

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

let checkingUpdate = null;

async function checkUpdate({ force = false } = {}) {
  if (checkingUpdate) return checkingUpdate;
  checkingUpdate = (async () => {
    if (!force) {
      const { updateCheckedAt } = await chrome.storage.local.get('updateCheckedAt');
      if (typeof updateCheckedAt === 'number' && Date.now() - updateCheckedAt < UPDATE_COOLDOWN_MS) return;
    }
    const response = await fetch(LATEST_RELEASE, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (!response.ok) return;
    const release = await response.json();
    await chrome.storage.local.set({ updateCheckedAt: Date.now() });
    await noteRelease(String(release.tag_name || '').replace(/^v/, ''), release.html_url);
  })().finally(() => {
    checkingUpdate = null;
  });
  return checkingUpdate;
}

// Keeps a release that is newer than this extension, and forgets the notice
// once the extension is as new. The link leads to the release on GitHub, and
// to the list of releases otherwise, whoever named it.
async function noteRelease(version, url) {
  if (typeof version !== 'string' || !/^\d+(\.\d+)*$/.test(version)) return;
  if (!isNewer(version, chrome.runtime.getManifest().version)) {
    await chrome.storage.local.remove('update');
    return;
  }
  const link = typeof url === 'string' && url.startsWith(RELEASES_PAGE) ? url : RELEASES_PAGE;
  await chrome.storage.local.set({ update: { version, url: link } });
}

// The alarm is made once, so that the service worker, which Chrome starts
// again and again, does not move the next check each time it starts.
chrome.alarms.get(UPDATE_ALARM).then((alarm) => {
  if (!alarm || alarm.periodInMinutes !== UPDATE_PERIOD_MINUTES) {
    chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: UPDATE_PERIOD_MINUTES });
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) checkUpdate({ force: true }).catch(() => {});
});
// A new version of the extension forgets the notice of the old one, and looks again.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(['update', 'updateCheckedAt']).then(() => checkUpdate({ force: true })).catch(() => {});
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
  if (!message) return false;
  // The popup has no tab, and asks for a release check whenever it opens on any screen.
  if (message.type === 'check-update') {
    checkUpdate().catch(() => {});
    return false;
  }
  const tabId = sender.tab && sender.tab.id;
  if (tabId === undefined) return false;

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

  // YouTube Music installed as an app has a window of its own, which has no
  // side panel. The button opens the mini window for its tab, whatever the
  // settings choose.
  if (message.type === 'app-window') {
    chrome.action.setPopup({ tabId, popup: MINI_WINDOW }).catch(() => {});
    chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
    return false;
  }

  if (message.type === 'release') {
    noteRelease(message.version, message.url).catch(() => {});
    return false;
  }

  // The window on top, which a tab of YouTube Music opens, shows that tab.
  if (message.type === 'which-tab') {
    sendResponse({ tabId });
    return false;
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
