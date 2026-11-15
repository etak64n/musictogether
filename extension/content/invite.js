// Reads the room ID of an invite link, such as
// https://music.youtube.com/?musictogether=K7QMX, before YouTube Music starts.
// YouTube Music takes the parameters that it does not know out of the address
// as soon as its own scripts run, which is before content/room.js runs. So
// this script runs at document_start, takes the parameter out of the address
// itself, and leaves the room ID for content/room.js in the world that the
// content scripts of the extension share.
(() => {
  'use strict';

  const url = new URL(location.href);
  if (!url.searchParams.has('musictogether')) return;
  globalThis.musictogetherInvite = url.searchParams.get('musictogether');
  // Without the parameter, reloading the page does not join the room again.
  url.searchParams.delete('musictogether');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
})();
