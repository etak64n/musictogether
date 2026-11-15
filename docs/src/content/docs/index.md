---
title: Overview
description: Music Together is a Chrome extension and a room server for listening to YouTube Music with friends at the same moment. These pages explain how to run the server, how to use the extension, and how both work.
---

Music Together is a Chrome extension for listening to YouTube Music with friends at the same moment.
Each person plays YouTube Music in their own Chrome, with their own account.
The extension makes the players of everyone in a **room** play the same song at the same position.
A room is kept by a **room server**, a small program that one person in the group runs on a machine of their own.
The room server answers only the people who know its token.

The source and the releases are on [GitHub](https://github.com/etak64n/musictogether). Music Together is released under the MIT License.
Music Together is not affiliated with Google or YouTube. It relies on parts of YouTube Music that are not documented, so a change to YouTube Music can stop it from working.

## Getting started

- [Run a room server](/musictogether/getting-started/server/): the room server with Docker Compose, its token, and its HTTPS address
- [Install the extension](/musictogether/getting-started/extension/): the extension in Chrome from a release, and its settings: the language, the room server, and its token

## Guides

- [Listen in a room](/musictogether/guides/rooms/): creating a room, joining it from an invite link, the shared queue, pausing your own player, and the messages of the popup
- [Host and participants](/musictogether/guides/host/): what each member of a room can do, and how the host closes a room

## Settings

- [Server configuration](/musictogether/settings/server/): the environment variables of the room server, its logs, and its limits

## Reference

- [HTTP API](/musictogether/reference/api/): every endpoint of the room server, with its token, its errors, its events, and its commands

## Internals

- [Architecture](/musictogether/internals/architecture/): the parts of Music Together, the shared timeline of a room, and how a player follows it

## Project

- [Development](/musictogether/project/development/): the layout of the code, the tests, the releases, and this site
