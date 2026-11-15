# Music Together

Listen to YouTube Music with friends: the same queue, at the same moment, each in their own Chrome.

Music Together is a Chrome extension and a small room server that you run yourself.
A host creates a room and shares its ID. Everyone in the room hears the same song at the same position.
Nothing is streamed: each person plays YouTube Music with their own account, and the extension keeps their player on the room's song and position.

**Documentation:** https://etak64n.github.io/musictogether/

Music Together is not affiliated with Google or YouTube. It relies on parts of YouTube Music that are not documented, so a change to YouTube Music can stop it from working.

## How it works

![The Chrome of each member connects to the room server over HTTPS, with the token. The room server keeps the queue of each room and its position in the song, and sends every change to the members.](images/architecture.svg)

The extension in each Chrome keeps a connection to the room server, sends the member's changes as commands, and receives every change of the room as an event.
The room server keeps the queue of each room and a timeline: the position in the current song at a moment on its clock.
Each extension computes the position from the timeline, and moves its own player there.

## Features

- **A shared queue.** Everyone in a room adds songs, from the search of the popup or from the ⋮ menu of a song in YouTube Music. The queue is reordered by dragging.
- **The same moment.** The room plays while anyone listens. Pausing stops your own player only, and playing again joins the room where it is now.
- **A host.** The host decides whether participants may skip, seek, and reorder, and closes the room.
- **Your own server.** One Go program without dependencies keeps the rooms in JSON files, and answers only the people who know its token.
- **A mini window or a side panel.** The button opens the popup in a small window below it, or in the side panel of Chrome, which stays open while you move between tabs.
- **English and Japanese.** The screens of the extension follow the language of Chrome, and the settings page switches them between the two.

## Quick start

Run the room server on a machine with Docker:

```sh
git clone https://github.com/etak64n/musictogether.git
cd musictogether/server
cp .env.example .env    # then set TOKEN in .env
docker compose up -d --build
```

The server listens on 127.0.0.1:8080. Give it an HTTPS address with a reverse proxy or a tunnel, because the extension connects over HTTPS only.

Install the extension in Chrome:

1. Download `musictogether-vX.Y.Z.zip` from the [releases](https://github.com/etak64n/musictogether/releases), extract it, and move the folder `musictogether` to a place you keep.
2. Open `chrome://extensions`, turn on Developer mode, click Load unpacked, and choose the folder.
3. Click the gear in the popup of Music Together, and enter the address of the server and its token.

Open YouTube Music, create a room in the popup, and send its room ID to your friends.

## Configuration

The room server reads four environment variables, all required:

| Variable | Description | Example |
| --- | --- | --- |
| `ADDR` | The host and port to listen on | `0.0.0.0:8080` |
| `DATA_DIR` | The directory that keeps the rooms | `/data` |
| `LOG_FORMAT` | The format of the logs: `json` or `text` | `json` |
| `TOKEN` | The token that the extension sends: at least 8 ASCII letters, digits, or symbols | `a-long-token-of-your-own` |

[Server configuration](https://etak64n.github.io/musictogether/settings/server/) describes the logs and the limits.

## License

[MIT](LICENSE)
