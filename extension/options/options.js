// The settings page: the language of the extension, how its button opens it,
// and the room server that it uses, with its token. The tab of a room reads
// the server and the token when it creates or joins a room, so a room keeps
// the server it began with.

import { LANGUAGES, loadLanguage, localize, translator } from '../i18n.js';

const $ = (id) => document.getElementById(id);

let t = translator('en');

function applyLanguage(language) {
  t = translator(language);
  document.documentElement.lang = language;
  document.title = t('settingsTitle');
  localize(document, t);
}

function showStatus(key, isError) {
  $('status').textContent = t(key);
  $('status').classList.toggle('error', isError);
  $('status').hidden = false;
}

// Shows what is wrong with a field and puts the cursor in it.
function refuse(input, key) {
  showStatus(key, true);
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
  if (!text) return refuse($('server'), 'enterServer');
  if (!/^https?:\/\//i.test(text)) return refuse($('server'), 'serverHttps');
  let url;
  try {
    url = new URL(text);
  } catch {
    return refuse($('server'), 'serverInvalid');
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.includes(url.hostname)) return refuse($('server'), 'serverHttps');
  if (url.username || url.password || url.search || url.hash) return refuse($('server'), 'serverInvalid');
  const token = $('token').value.trim();
  if (!token) return refuse($('token'), 'enterToken');
  if (!/^[\x21-\x7e]+$/.test(token)) return refuse($('token'), 'tokenAscii');
  return { server: url.origin + url.pathname.replace(/\/+$/, ''), token };
}

// The language takes effect as soon as it is chosen.
$('language').addEventListener('change', async () => {
  const language = $('language').value;
  if (!LANGUAGES.includes(language)) return;
  await chrome.storage.local.set({ language });
  applyLanguage(language);
  $('status').hidden = true;
});

// So does the way the button opens: the service worker applies it.
const displayRadios = document.querySelectorAll('input[name="display"]');
for (const radio of displayRadios) {
  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    await chrome.storage.local.set({ display: radio.value === 'panel' ? 'panel' : 'window' });
  });
}

$('server-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = readServer();
  if (!settings) return;
  await chrome.storage.local.set(settings);
  $('server').value = settings.server;
  $('token').value = settings.token;
  showStatus('saved', false);
});

for (const id of ['server', 'token']) {
  $(id).addEventListener('input', () => {
    $('status').hidden = true;
  });
}

// --- start ---

const language = await loadLanguage();
$('language').value = language;
applyLanguage(language);

const { server, token, display } = await chrome.storage.local.get(['server', 'token', 'display']);
$('server').value = server || '';
$('token').value = token || '';
const shown = display === 'panel' ? 'panel' : 'window';
for (const radio of displayRadios) radio.checked = radio.value === shown;
