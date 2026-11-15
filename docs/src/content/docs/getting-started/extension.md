---
title: Install the extension
description: Load the extension into Chrome from a release, pin its button to the toolbar, and set its language, how its button opens, its room server, and the server's token.
---

The extension runs in Google Chrome on a computer.
Each member signs in to YouTube Music with their own Google account, because each member's own player plays the songs.

## Download a release

Download [musictogether.zip](https://github.com/etak64n/musictogether/releases/latest/download/musictogether.zip), and extract it.
The link always gives the zip of the latest release. The zips of every release are on the [releases](https://github.com/etak64n/musictogether/releases) page.

- macOS: double-click the zip. A folder named `musictogether` appears next to it.
- Windows: right-click the zip, choose Extract All, and click Extract.

The **extension folder** is the folder that contains `manifest.json` directly.
Windows can extract the zip into a folder that holds another folder of the same name. The inner folder is then the extension folder.

## Move the folder to a lasting place

Chrome loads the extension from the extension folder every time it starts, so deleting or moving the folder stops the extension.
Move the extension folder to a place that you keep, such as Documents.

## Load the extension into Chrome

1. Open `chrome://extensions` in Chrome.
2. Turn on Developer mode, at the top right. Developer mode lets Chrome load extensions from a folder.
3. Click Load unpacked, at the top left.
4. Choose the extension folder.

Music Together appears in the list of extensions.

## Pin the button

Click the puzzle piece at the top right of Chrome, and click the pin next to Music Together.
The button of Music Together, a white ♫ on teal, appears in the toolbar.
The button opens the popup of the extension in a mini window below the button, or in the side panel on the right of the window, as the settings choose.
Chrome opens the mini window below the button, so dragging the button to the right moves the mini window to the right.

## Fill in the settings

The extension has four settings, which show in the popup itself. The gear at the top right of the popup opens them in place of the room, and closes them again. In YouTube Music installed as an app, the button of Music Together is in the menu of extensions in the title bar of the app's window, and opens the mini window.

| Setting | Value |
| --- | --- |
| Language | English or 日本語 (Japanese): the language of the popup, its settings included, and of the item that the extension adds to the menus of YouTube Music. Until it is chosen, the extension follows the language of Chrome: Japanese in a Chrome in Japanese, and English in any other. |
| Open as | Mini window, a small window below the button, or Side panel, the panel of Chrome on the right of the window, which stays open while you move between tabs. Mini window until the other is chosen. |
| Server | The address of the room server, such as `https://music.example.com`. The address starts with `https://`, or with `http://localhost` or `http://127.0.0.1` for a room server on the same computer, which Chrome reaches over HTTP. |
| Token | The token of the room server. |

The language takes effect as soon as it is chosen: the popup opens again in that language, on the settings.
Open as takes effect from the next click of the button. Choosing Mini window in the side panel closes the side panel at once.
The server and the token take effect with Save.
The person who runs the room server gives the address and the token.
The extension keeps the settings in this Chrome, and reads the server and the token every time it creates or joins a room.
[Listen in a room](/musictogether/guides/rooms/) describes how to create and join a room.

## Update the extension

The extension asks GitHub for its latest release once a day, with an ordinary request to the API of GitHub that carries no settings.
When a newer version is out, the popup shows Version X.Y.Z is available at its top, and a click on it opens the page of the release.
Chrome does not replace the extension folder by itself, so the update takes these steps:

1. Download and extract [musictogether.zip](https://github.com/etak64n/musictogether/releases/latest/download/musictogether.zip) again.
2. Delete the old extension folder, and put the new one in its place, under the same name.
3. Open `chrome://extensions`, and click the reload button (↻) of Music Together.
4. Reload the tabs of YouTube Music.

The extension keeps your name and its settings, because the extension folder stays at the same place.
