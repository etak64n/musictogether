// Remembers which tab is in a room, so that the popup can find that tab and a
// reloaded tab can rejoin. A browser is in at most one room at a time.

// The toolbar button opens the popup in one of two ways, as the settings page
// says: a mini window under the button, which is the default, or Chrome's side
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
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'room-left') {
    getRoomTab().then(async (current) => {
      if (current && current.tabId === tabId) {
        await chrome.storage.session.remove('roomTab');
        showQueueCount(0);
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

  if (message.type === 'which-room') {
    getRoomTab().then((current) => {
      sendResponse({ roomId: current && current.tabId === tabId ? current.roomId : null });
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
  }
});
