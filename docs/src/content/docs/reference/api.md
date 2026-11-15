---
title: HTTP API
description: Every endpoint of the room server, with its token, its CORS rules, its errors, the events of a room, and the commands that change a room.
---

The room server has an HTTP API, which the extension calls from the page of YouTube Music.
The bodies of requests and responses are JSON, except where an endpoint says otherwise.

## Endpoints

| Method and path | Description |
| --- | --- |
| [`GET /`](#index-page) | The name and version of the server |
| [`GET /api/time`](#server-clock) | The clock of the server |
| [`POST /api/rooms`](#create-a-room) | Create a room |
| [`POST /api/rooms/{id}/stream`](#join-a-room) | Join a room, and receive its changes as events |
| [`POST /api/rooms/{id}/commands`](#change-a-room) | Change a room |

## Token

Every endpoint under `/api/` requires the header `Authorization: Bearer <token>`, where `<token>` is the value of `TOKEN` on the server.
A request without the header, or with another value, gets the status 401, the header `WWW-Authenticate: Bearer`, and the error `unauthorized`.
`GET /` and CORS preflight requests need no token.

```sh
curl -H "Authorization: Bearer a-long-token-of-your-own" https://music.example.com/api/time
```

## CORS

The server lets the pages of `https://music.youtube.com` read its responses, and no other origin.
A response to a request with the header `Origin: https://music.youtube.com` carries `Access-Control-Allow-Origin: https://music.youtube.com`.
A preflight request from that origin is answered with the status 204, the methods `GET` and `POST`, and the headers `Content-Type` and `Authorization`.
Clients outside a browser, such as curl, do not apply CORS, and use the API with the token.

## Errors

An error has a status and a body with a reason.

```json
{"error": "room_not_found"}
```

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | The body is not valid JSON, or a field is missing or invalid. |
| 401 | `unauthorized` | The token is missing or wrong. |
| 403 | `not_member` | The `sessionId` is not an open connection to the room. |
| 403 | `host_only` | The command needs the host, or the host's permission. |
| 404 | `room_not_found` | No room has the ID. |
| 409 | `queue_full` | The queue of the room holds 200 songs. |
| 429 | `rate_limited` | The address created 20 rooms in the last hour. |
| 500 | `internal` | The server failed, as when it cannot write the file of a room. |
| 503 | `too_many_rooms` | The server holds 1,000 rooms. |
| 503 | `room_full` | The room has 50 connections. |
| 503 | `server_full` | The server has 500 connections. |

## Index page

`GET /` returns the name and version of the server as plain text. It needs no token.

```text
Music Together server 0.3.0
```

## Server clock

`GET /api/time` returns the clock of the server, in milliseconds since the Unix epoch.
The extension calls it to learn the difference between the clock of the browser and the clock of the server.

```json
{"now": 1768469400123}
```

## Create a room

`POST /api/rooms` creates an empty room. The browser that creates the room becomes its host.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `clientId` | string | Yes | The ID of the browser: 8 to 64 ASCII letters, digits, or hyphens. The extension makes one per browser and keeps it. |

The response has the status 201 and the ID of the room: 5 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`.

```json
{"roomId": "K7QMX"}
```

The errors are `bad_request`, `rate_limited`, and `too_many_rooms`.

## Join a room

`POST /api/rooms/{id}/stream` joins the room `{id}`, and keeps the response open as an event stream for as long as the member is in the room.
Closing the stream leaves the room.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `clientId` | string | Yes | The ID of the browser. The same ID in the same room is the same member, and the ID that created the room is the host. |
| `name` | string | Yes | The name that the others see. The server removes control characters and keeps the first 30 characters. |
| `listening` | boolean | No | Whether the member's player plays. `false` joins with the player paused, as when a paused member connects again. The default is `true`. |

The response has the status 200 and the type `text/event-stream`.
Every 15 seconds without events, the server writes the comment line `: heartbeat`, so that proxies keep the connection open.
The errors are `bad_request`, `room_not_found`, `room_full`, and `server_full`.

The stream carries these events:

| Event | When | Data |
| --- | --- | --- |
| `hello` | First | The session of this connection |
| `room` | After `hello`, and after every change of the room | The whole room |
| `closed` | When the host closes the room | `{}`. The stream ends after it. |

```text
event: hello
data: {"sessionId":"VJ4TQ2KXW7NHPZ3MCRLD6YBF5A","memberId":"3fa2c81e09bd"}

event: room
data: {"id":"K7QMX","version":4,"serverTime":1768469400123,"hostId":"3fa2c81e09bd","participantControl":false,"current":{...},"queue":[...],"playback":{...},"members":[...]}
```

The data of `hello`:

| Field | Type | Description |
| --- | --- | --- |
| `sessionId` | string | The secret of this connection. Commands carry it. |
| `memberId` | string | The ID of the member, which the others see. Every connection of the same browser to the room has the same `memberId`. |

The data of `room`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | The ID of the room. |
| `version` | number | A number that grows with every change of the room. |
| `serverTime` | number | The clock of the server when it sent the event, in milliseconds since the Unix epoch. |
| `hostId` | string | The `memberId` of the host. |
| `participantControl` | boolean | Whether participants may seek, skip, and reorder the queue. |
| `current` | item or null | The song that plays. `null` while nothing plays, and the queue is then empty. |
| `queue` | array of items | The songs after `current`, in the order they play. |
| `playback` | playback | The shared timeline of the room. |
| `members` | array of members | The members connected to the room, in the order they joined. |

An item is a song in the room:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | The ID of the item in the room. The same song added twice has two items. |
| `videoId` | string | The ID of the song in YouTube Music. |
| `title` | string | The title. |
| `artists` | string | The artists, as YouTube Music shows them. |
| `album` | string | The album, or an empty string. |
| `duration` | number | The length in seconds, or 0 when it is unknown. |
| `thumbnail` | string | The URL of the artwork, or an empty string. |
| `addedBy` | string | The name of the member who added the song. |
| `addedById` | string | The `memberId` of the member who added the song. |

The playback is the shared timeline:

| Field | Type | Description |
| --- | --- | --- |
| `playing` | boolean | Whether the timeline moves forward. |
| `position` | number | The position in `current`, in seconds, at `updatedAt`. |
| `updatedAt` | number | The clock of the server when the timeline was at `position`, in milliseconds since the Unix epoch. |

While `playing` is true, the position at a time `t` is `position + (t - updatedAt) / 1000`, up to the `duration` of `current`.

A member is a person in the room:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | The `memberId` of the member. |
| `name` | string | The name that the member joined with. |

## Change a room

`POST /api/rooms/{id}/commands` changes the room `{id}` with one command.
When the command changes the room, every member receives the changed room as a `room` event.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | string | Yes | The `sessionId` of an open stream to the room. |
| `type` | string | Yes | The command, one of the types in the table of commands. |
| `track` | track | For `add` | The song to add. |
| `itemId` | string | For `remove`, `move`, `next`, and `ended` | The `id` of an item. |
| `index` | number | For `move` | The new place of the item in the queue, from 0. |
| `position` | number | For `seek` | The new position in seconds. |
| `value` | boolean | For `listening` and `participantControl` | The new value. |

The response has the status 200.

```json
{"ok": true}
```

The errors are `bad_request`, `not_member`, `host_only`, `room_not_found`, and `queue_full`.

The commands:

| `type` | Who | Effect |
| --- | --- | --- |
| `add` | Everyone | Adds `track` to the end of the queue. In a room where nothing plays, the song starts at once. |
| `remove` | The host, and the member who added the item | Removes the item from the queue. |
| `move` | The host, and participants with the permission | Takes the item out of the queue and puts it back at `index`. 0 plays it next, and an index past the end puts it last. |
| `seek` | The host, and participants with the permission | Moves the timeline to `position`. A position past the end of the song is the end. |
| `next` | The host, and participants with the permission | Skips `current`, when `itemId` is still `current`. |
| `ended` | Everyone | Moves on from `current` when `itemId` is still `current` and the timeline is within 5 seconds of its end, or at once when its `duration` is 0. |
| `listening` | Everyone | Sets whether the member of this connection listens. The room moves forward while anyone listens. |
| `participantControl` | The host | Gives participants the permission, or takes it away. |
| `close` | The host | Deletes the room. Every member receives `closed`, and every stream ends. |

`next` and `ended` name the item to move past, so that several members who reach the end of the same song at once move the room on only once.

A track describes a song as YouTube Music shows it:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `videoId` | string | Yes | The ID of the song in YouTube Music: 11 ASCII letters, digits, `-`, or `_`. |
| `title` | string | Yes | The title. The server keeps the first 200 characters. |
| `artists` | string | No | The artists. The server keeps the first 200 characters. |
| `album` | string | No | The album. The server keeps the first 200 characters. |
| `duration` | number | No | The length in seconds, up to 86,400. Other values become 0. |
| `thumbnail` | string | No | An HTTPS URL of the artwork on a host that ends with `.googleusercontent.com`, `.ggpht.com`, or `.ytimg.com`. Other values become an empty string, so that a member cannot make the others load images from another server. |
