---
title: Development
description: The layout of the code, running the extension and the room server from source, the tests, the releases, the icons, and this site.
---

The extension needs no build step: Chrome loads the folder extension/ as it is. The room server needs Go 1.26 or later.

## Layout of the code

```text
extension/            The Chrome extension
  manifest.json
  i18n.js             The words of the popup and the settings page, in Japanese and English
  _locales/           The description of the extension, in the languages of Chrome
  background.js       The service worker: which tab is in a room, the number on the button, and how the button opens
  content/room.js     The room script: the connection to the room server, and the player following the room
  content/page.js     The page script: drives the player of YouTube Music, and adds the menu item
  popup/              The popup of the button, in a mini window or in the side panel
  options/            The settings page
  icons/              The icons: icon.svg, and the PNG files rendered from it
server/               The room server, in Go with its standard library only
  .env.example        The token, for Docker Compose
docs/                 This site
images/               The images of the README
```

## Run from source

Chrome loads the extension from the repository:

1. Open `chrome://extensions`, and turn on Developer mode.
2. Click Load unpacked, and choose the folder extension/ of the repository.

After a change, click the reload button (↻) of the extension, and reload the tabs of YouTube Music.

These commands run the room server from source, with its rooms in server/data.

```sh
cd server
ADDR=127.0.0.1:8080 DATA_DIR=./data LOG_FORMAT=text TOKEN=a-local-token go run .
```

The extension reaches a room server over HTTPS only, so a room server on a development machine needs a tunnel or a reverse proxy with a certificate, as [Run a room server](/musictogether/getting-started/server/) describes.

## Tests

- `go test ./...` in server/ runs the tests of the room server: its API over HTTP, the rules of a room, the token, the settings, and the logs.
- `node --check` checks the syntax of every script of the extension.

The CI workflow (.github/workflows/ci.yml) runs both on every push to main and every pull request.
The behavior of the extension in YouTube Music depends on the page of YouTube Music, so it is checked by hand in Chrome.

## Releases

1. Set the new version in extension/manifest.json and in server/main.go.
2. Push the tag `vX.Y.Z`.

The Release workflow (.github/workflows/release.yml) checks that both versions match the tag, packs extension/ into `musictogether-vX.Y.Z.zip`, and publishes the zip as a release.
The folder in the zip is named `musictogether` in every release, so that a member who replaces the folder keeps the settings of the extension.
The Docs workflow publishes this site for the release.

## Icons

Chrome uses PNG files for the icons of an extension. extension/icons/icon.svg is the source of them.
The Icons workflow (.github/workflows/icons.yml) renders the PNG files when it is started by hand, and keeps them in an artifact named icons. The files of the artifact go to extension/icons/.

## This site

This site is in docs/, built with Starlight, the documentation theme of Astro.
These commands serve it with live reload.

```sh
pnpm --dir docs install
pnpm --dir docs dev
```

The Docs workflow (.github/workflows/docs.yml) builds the site on every push to main, so that a broken page fails before a release, and publishes it to GitHub Pages for every release and on a manual run.
