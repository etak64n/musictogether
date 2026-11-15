// The words of the popup, its settings included, in each language that the
// extension offers. The language is one of the settings. Until it
// is set, it follows the language of Chrome: Japanese in a Chrome in Japanese,
// and English in any other.

export const LANGUAGES = ['ja', 'en'];

const STRINGS = {
  ja: {
    // The popup
    settings: '設定',
    needTab: 'YouTube Music のタブで使います',
    openYouTubeMusic: 'YouTube Music を開く',
    needReload: 'YouTube Music のタブを再読み込みしてください',
    reload: '再読み込み',
    needSetup: 'サーバーとトークンを設定してください',
    openSettings: '設定を開く',
    lobbyChoice: '入り方',
    createRoom: 'ルームを作る',
    joinRoom: 'ルームに参加',
    yourName: 'あなたの名前',
    roomId: 'ルーム ID',
    join: '参加',
    upNext: '次に再生',
    queueTitle: 'キュー',
    playedSongs: '再生した曲',
    nowPlaying: '再生中',
    expandList: '広げる',
    foldList: 'たたむ',
    searchSongs: '曲を検索',
    searchResults: '検索結果',
    copyRoomId: 'ルーム ID をコピー',
    inviteLink: '招待リンク',
    copyInviteLink: '招待リンクをコピー',
    invited: '招待されたルーム {roomId} です。名前を入れて「参加」を押してください',
    host: 'ホスト',
    memberListening: '{name}（聞いています）',
    memberPaused: '{name}（止めています）',
    participants: '参加者',
    participantControl: '参加者も曲送りと曲順を操作できる',
    play: '再生',
    nextSong: '次の曲',
    seekPosition: '再生位置',
    leave: '退出',
    endRoom: 'ルームを解散',
    undoEnd: '元に戻す',
    endingIn: '{seconds} 秒後にルームを解散します',
    reconnecting: '再接続中…',
    connecting: '接続中…',
    hostAbsent: 'いません',
    pauseOwn: '一時停止（ほかの人は止まりません）',
    playFromRoom: '再生（ルームの今の位置から）',
    remove: '削除',
    addedBy: '{name} が追加',
    searching: '検索中…',
    searchFailed: '検索できませんでした',
    noResults: '見つかりませんでした',
    add: '追加',
    addAgain: 'もう一度追加',
    added: '追加しました',
    enterName: 'あなたの名前を入れてください',
    roomIdFormat: 'ルーム ID は英数字 5 文字です',
    copied: 'ルーム ID をコピーしました',
    inviteCopied: '招待リンクをコピーしました',
    copyFailed: 'コピーできませんでした',
    updateAvailable: '新しい版 v{version} があります',
    // What the room server or the tab reports
    room_not_found: 'ルームが見つかりません',
    room_gone: 'ルームがなくなりました',
    room_closed: 'ホストがルームを解散しました',
    room_full: 'このルームは満員です',
    server_full: 'サーバーが混み合っています',
    too_many_rooms: '今は新しいルームを作れません',
    rate_limited: 'ルームを作りすぎています。しばらくしてからもう一度お試しください',
    host_only: 'この操作は、ホストが許したときだけできます',
    queue_full: 'キューがいっぱいです',
    not_member: 'ルームとの接続が切れています',
    disconnected: 'ルームとの接続が切れています',
    unauthorized: 'トークンが違います',
    no_server: 'サーバーとトークンを設定してください',
    network: 'サーバーに接続できません',
    timeout: 'サーバーから応答がありません。サーバーのアドレスを確かめてください',
    loopback_permission: 'Chrome が YouTube Music からこの PC への接続を止めています。「サイトの設定を開く」を押し、「デバイス上のアプリ」を「許可」にしてください',
    openSiteSettings: 'サイトの設定を開く',
    loopback_prompt: 'Chrome が「このデバイス上の他のアプリやサービスへのアクセス」の許可を求めています。アドレスバーの下の確認で「許可」を押してください。ミニウィンドウの裏に隠れていたら、いったん閉じてください',
    returned: 'ルームの曲に戻しました',
    unplayable: 'この曲はこのアカウントでは再生できません',
    stalled: '再生が始まりません。YouTube Music のページを一度クリックしてください',
    // The settings
    language: '言語',
    roomServer: 'ルームサーバー',
    server: 'サーバー',
    token: 'トークン',
    save: '保存',
    saved: '保存しました',
    enterServer: 'サーバーのアドレスを入れてください',
    serverHttps: 'サーバーのアドレスは https:// で始めてください（この PC のサーバーなら http://localhost も使えます）',
    serverInvalid: 'サーバーのアドレスが正しくありません',
    enterToken: 'トークンを入れてください',
    tokenAscii: 'トークンは半角の英数字と記号で入れてください',
    display: '開き方',
  },
  en: {
    // The popup
    settings: 'Settings',
    needTab: 'Music Together works in a YouTube Music tab',
    openYouTubeMusic: 'Open YouTube Music',
    needReload: 'Reload the YouTube Music tab',
    reload: 'Reload',
    needSetup: 'Set the server and the token',
    openSettings: 'Open settings',
    lobbyChoice: 'Create or join',
    createRoom: 'Create room',
    joinRoom: 'Join room',
    yourName: 'Your name',
    roomId: 'Room ID',
    join: 'Join',
    upNext: 'Up next',
    queueTitle: 'Queue',
    playedSongs: 'Played songs',
    nowPlaying: 'Now playing',
    expandList: 'Expand',
    foldList: 'Fold',
    searchSongs: 'Search songs',
    searchResults: 'Search results',
    copyRoomId: 'Copy the room ID',
    inviteLink: 'Invite link',
    copyInviteLink: 'Copy the invite link',
    invited: 'You were invited to room {roomId}. Enter your name and click Join.',
    host: 'Host',
    memberListening: '{name} (listening)',
    memberPaused: '{name} (paused)',
    participants: 'Participants',
    participantControl: 'Participants can skip and reorder',
    play: 'Play',
    nextSong: 'Next song',
    seekPosition: 'Position in the song',
    leave: 'Leave',
    endRoom: 'End room',
    undoEnd: 'Undo',
    endingIn: 'The room ends in {seconds} seconds',
    reconnecting: 'Reconnecting…',
    connecting: 'Connecting…',
    hostAbsent: 'Not here',
    pauseOwn: 'Pause (the others keep listening)',
    playFromRoom: 'Play (where the room is now)',
    remove: 'Remove',
    addedBy: 'Added by {name}',
    searching: 'Searching…',
    searchFailed: 'The search failed',
    noResults: 'No songs found',
    add: 'Add',
    addAgain: 'Add again',
    added: 'Added',
    enterName: 'Enter your name',
    roomIdFormat: 'A room ID has 5 letters and digits',
    copied: 'Copied the room ID',
    inviteCopied: 'Copied the invite link',
    copyFailed: 'Could not copy',
    updateAvailable: 'Version {version} is available',
    // What the room server or the tab reports
    room_not_found: 'No room has this ID',
    room_gone: 'The room is gone',
    room_closed: 'The host ended the room',
    room_full: 'This room is full',
    server_full: 'The server is busy',
    too_many_rooms: 'No room can be created right now',
    rate_limited: 'Too many rooms were created. Try again later',
    host_only: 'Only the host, or members the host allows, can do this',
    queue_full: 'The queue is full',
    not_member: 'The connection to the room is lost',
    disconnected: 'The connection to the room is lost',
    unauthorized: 'The token is wrong',
    no_server: 'Set the server and the token',
    network: 'Cannot reach the server',
    timeout: 'The server does not answer. Check the address of the server',
    loopback_permission: 'Chrome does not let YouTube Music reach this computer. Open the site settings, and allow Apps on device',
    openSiteSettings: 'Open site settings',
    loopback_prompt: 'Chrome asks for access to this computer. Click Allow in its question below the address bar. If the mini window hides it, close the mini window',
    returned: "Back to the room's song",
    unplayable: 'This account cannot play this song',
    stalled: 'Playback does not start. Click the YouTube Music page once',
    // The settings
    language: 'Language',
    roomServer: 'Room server',
    server: 'Server',
    token: 'Token',
    save: 'Save',
    saved: 'Saved',
    enterServer: 'Enter the address of the server',
    serverHttps: 'The address of the server starts with https://, or with http://localhost for a server on this computer',
    serverInvalid: 'The address of the server is not valid',
    enterToken: 'Enter the token',
    tokenAscii: 'The token has ASCII letters, digits, and symbols only',
    display: 'Open as',
  },
};

// The language of Chrome, as one that the extension offers.
export function chromeLanguage() {
  return (navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export async function loadLanguage() {
  const { language } = await chrome.storage.local.get('language');
  return LANGUAGES.includes(language) ? language : chromeLanguage();
}

export function hasString(key) {
  return Object.hasOwn(STRINGS.en, key);
}

// Returns a function that gives the words for a key, with {name} and the like
// filled in from the parameters.
export function translator(language) {
  const strings = STRINGS[language] || STRINGS.en;
  return (key, params = {}) =>
    (strings[key] ?? STRINGS.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
}

// Fills the elements that name their words: data-i18n sets the text,
// data-i18n-label the accessible name, data-i18n-title the tooltip, and
// data-i18n-placeholder the placeholder.
export function localize(root, t) {
  for (const element of root.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of root.querySelectorAll('[data-i18n-label]')) {
    element.setAttribute('aria-label', t(element.dataset.i18nLabel));
  }
  for (const element of root.querySelectorAll('[data-i18n-title]')) element.title = t(element.dataset.i18nTitle);
  for (const element of root.querySelectorAll('[data-i18n-placeholder]')) {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  }
}
