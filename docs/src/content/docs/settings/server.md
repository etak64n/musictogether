---
title: Server configuration
description: The environment variables of the room server, its token, the format of its logs, the headers it reads behind Cloudflare, and its built-in limits.
---

The room server reads its settings from environment variables, and requires every one of them.
A missing or wrong value stops the server when it starts, with a line for each such value that says what to set.

## Environment variables

| Variable | Required | Description | Example |
| --- | --- | --- | --- |
| `ADDR` | Yes | The host and port to listen on, as `host:port`. The host `0.0.0.0` listens on every network interface of the machine, and `127.0.0.1` on the machine itself only. | `0.0.0.0:8080` |
| `DATA_DIR` | Yes | The directory for the rooms. The server creates `rooms/` in it, with one JSON file per room. | `/data` |
| `LOG_FORMAT` | Yes | The format of the logs: `json` for one JSON object per line, or `text` for tab-separated columns. | `json` |
| `TOKEN` | Yes | The token that the extension sends with every request. At least 8 ASCII letters, digits, or symbols, without spaces. | `a-long-token-of-your-own` |

server/compose.yaml sets `ADDR`, `DATA_DIR`, and `LOG_FORMAT`, and reads `TOKEN` from the file .env next to it.
In its container, the server listens on `0.0.0.0:8080`, and Docker publishes the port on 127.0.0.1 of the machine only.

## Token

Every request to a path under `/api/` carries the token in the header `Authorization: Bearer <token>`.
A request without it, or with another value, gets the status 401 and the error `unauthorized`.
The index page `/` answers without the token, so that a health check reaches it. CORS preflight requests also pass without it, because browsers send them without the header `Authorization`.

To change the token, set the new value in .env, and run `docker compose up -d` again.
The extension of a member who is in a room at that moment leaves the room and shows The token is wrong. The member enters the new token in the settings and joins again.

## Logs

The server writes its logs to standard error, one line per event. Each line has these fields:

| Field | Description |
| --- | --- |
| `timestamp` | The time of the event in UTC, with milliseconds, such as `2026-01-15T09:30:00.123Z`. |
| `level` | `DEBUG`, `INFO`, `WARN`, or `ERROR`. The server writes `INFO` and above. |
| `message` | What happened, such as `Request completed` or `Room created`. |
| `requestId` | The ID of the request that the line belongs to. A line outside any request has the ID of the running process. |
| `service` | `musictogether`, in JSON lines. |

The other fields depend on the event:

- `Request completed` has `method`, `path`, `status`, and `durationMs`. `path` is the route, such as `/api/rooms/{id}/stream`, so that room IDs, which let anyone with the token join a room, stay out of the logs. Requests to `/api/time` are logged at `DEBUG`, below the level that the server writes, because every member's extension calls it regularly.
- `Server started` has `addr`, `version`, and `count`, the number of rooms read from `DATA_DIR`.
- `Room created` and `Room closed` have `count`, the number of rooms on the server. `Unused rooms deleted` has `count`, the number of rooms deleted.
- `Member joined` and `Member left` have `count`, the number of connections in the room.
- Errors have `errorType` and `errorMessage`.

The names of members are not written to the logs.

A JSON line:

```json
{"timestamp":"2026-01-15T09:30:00.123Z","level":"INFO","message":"Request completed","requestId":"8f2c1d7b9a3e4f60","service":"musictogether","method":"POST","path":"/api/rooms","status":201,"durationMs":3}
```

A text line has the columns timestamp, requestId, level, and message, and then the other fields as one JSON object, or `-` without them:

```text
2026-01-15T09:30:00.123Z	8f2c1d7b9a3e4f60	INFO	Request completed	{"method":"POST","path":"/api/rooms","status":201,"durationMs":3}
```

## Behind Cloudflare

The room server reads two headers that Cloudflare adds to the requests it forwards:

- `CF-Ray` becomes the `requestId` of the request, so that a line of the log matches the request in the logs of Cloudflare. Without the header, the server makes a random ID.
- `CF-Connecting-IP` is the address that the limit on creating rooms counts against. Without the header, the limit counts against the address of the connection.

The server takes both headers as they arrive, so a client that reaches the server directly can set them.
A server behind Cloudflare listens on an address that only Cloudflare reaches, as server/compose.yaml does with 127.0.0.1 and a tunnel on the same machine.

## Limits

| Limit | Value |
| --- | --- |
| Rooms on one server | 1,000 |
| Connections on one server | 500 |
| Connections in one room | 50 |
| Rooms that one address creates in an hour | 20 |
| Songs waiting in a room | 200 |
| Songs that played, kept in a room | 50 |
| Characters in a member's name | 30 |
| Characters in a title, an artist list, or an album | 200 |
| Time that an unused room is kept | 1 hour |
| Seconds that a room plays after its last listener leaves | 30 |
| Size of a request body | 512 KiB |
| Interval of the heartbeat line on an event stream | 15 seconds |
