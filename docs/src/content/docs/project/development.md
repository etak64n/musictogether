---
title: Development
description: The layout of the code, running the extension and the room server from source, the tests, the releases, the icons, and this site.
---

The extension needs no build step: Chrome loads the folder extension/ as it is. The room server needs Go 1.26 or later.

## Layout of the code

```text
extension/            The Chrome extension
  manifest.json
  i18n.js             The words of the popup and its settings, in Japanese and English
  _locales/           The description of the extension, in the languages of Chrome
  background.js       The service worker: which tab is in a room, the number on the button, and how the button opens
  content/room.js     The room script: the connection to the room server, and the player following the room
  content/page.js     The page script: drives the player of YouTube Music, and adds the menu item
  content/invite.js   The invite script: reads the room ID of an invite link before the page starts
  popup/              The popup of the button, in a mini window or in the side panel, with the settings
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

The extension reaches this room server at `http://127.0.0.1:8080`, with the token `a-local-token`: Chrome lets an HTTPS page reach `localhost` and `127.0.0.1` over HTTP, so the settings take these two hosts with `http://`. Every other room server needs an HTTPS address, as [Run a room server](/musictogether/getting-started/server/) describes.
Chrome lets YouTube Music reach this computer only with the permission of the site that Chrome 145 and later call Apps on device. Until it is granted, Chrome holds the requests of the extension, and the popup shows Open site settings, which opens the settings of music.youtube.com where you allow it.

This command builds the image of the room server from source, as the Release workflow does.

```sh
docker build -t musictogether server
```

## Tests

- `go test ./...` in server/ runs the tests of the room server: its API over HTTP, the rules of a room, the token, the settings, and the logs.
- `node --check` checks the syntax of every script of the extension.

The CI workflow (.github/workflows/ci.yml) runs both on every push to main and every pull request.
The behavior of the extension in YouTube Music depends on the page of YouTube Music, so it is checked by hand in Chrome.

## Releases

1. Set the new version in extension/manifest.json and in server/main.go.
2. Push the annotated tag `vX.Y.Z`. Its message is the notes of the release: one line for each change, starting with `[New]` for what is new and `[Fix]` for what is fixed.

```sh
git tag -a v1.2.0 -m "- [New] A song dropped among the songs of the queue goes to that place." -m "- [Fix] The seek bar keeps its handle while the song loads."
git push origin v1.2.0
```

The Release workflow (.github/workflows/release.yml) takes these steps:

1. It checks that both versions match the tag.
2. It builds the image of the room server on amd64 and on arm64, each on a runner of its own, and tries each image: the index page, a request without the token, and a request with it.
3. It publishes the image as `ghcr.io/etak64n/musictogether` with the tags `X.Y.Z`, `X.Y`, and `latest`. A version with a hyphen, such as `1.3.0-rc.1`, gets its own tag only.
4. It packs extension/ into `musictogether.zip`, and publishes the zip as the release of the tag, with the tag's message as its notes.

The zip has the same name in every release, so that `https://github.com/etak64n/musictogether/releases/latest/download/musictogether.zip` always gives the latest one.
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
