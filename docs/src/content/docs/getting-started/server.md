---
title: Run a room server
description: Run the room server with Docker Compose on a machine of your own, give it a token and an HTTPS address, and hand both to the people who listen with you.
---

The room server is one program, written in Go with its standard library only.
It keeps the rooms in memory and in one JSON file per room, and sends every change of a room to the people in it.
This page runs the published image of the room server with Docker Compose. It needs Git, Docker with Compose, and a domain name that points to the machine, or a tunnel service that gives the machine an HTTPS address.

## Set the token

The room server answers a request only when the request carries the server's **token**.
The extension sends the token with every request, and the people who listen with you enter it in the settings of the extension.
A token keeps people who do not know it from using your server, even when they know its address.

These commands fetch the source and create the file that holds the token.

```sh
git clone https://github.com/etak64n/musictogether.git
cd musictogether/server
# .env holds the token. Docker Compose reads it from the folder of compose.yaml.
cp .env.example .env
```

Write the token after `TOKEN=` in .env.

```sh
TOKEN=a-long-token-of-your-own
```

- The token has at least 8 characters.
- The token consists of ASCII letters, digits, and symbols, without spaces, because the extension sends it in an HTTP header.
- `openssl rand -base64 18` prints a random token of 24 such characters.

## Start the server

This command fetches the image and starts the room server in the background.

```sh
docker compose up -d
```

- The image is `ghcr.io/etak64n/musictogether:latest`, for amd64 and arm64. Each release also has a tag of its own version, such as `0.3.2`, and of its minor version, such as `0.3`, which a server can name in compose.yaml in place of `latest` to stay on one version.
- The server listens on port 8080 of 127.0.0.1, so only programs on the same machine reach it. A reverse proxy or a tunnel on the machine forwards requests from the internet to it.
- The rooms are kept in a named volume, so they remain when the container is replaced.
- `restart: unless-stopped` starts the server again after the machine restarts.

The index page of the server answers without the token, with the name and version of the server.

```sh
curl http://127.0.0.1:8080/
# Music Together server 0.3.4
```

## Give the server an HTTPS address

The extension calls the room server from the page of YouTube Music, which Chrome loads over HTTPS.
Chrome blocks requests from an HTTPS page to an HTTP address, so the room server needs an HTTPS address that the browsers of all members reach.
A reverse proxy with a certificate, such as Caddy or nginx, provides that address on a machine with a domain name. A tunnel service provides it on a machine that has no open port.

A Caddyfile such as this one serves the room server at `https://music.example.com`. Caddy obtains the certificate by itself.

```text
music.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

The proxy meets two conditions:

1. It passes the response of a room's event stream through as it arrives. Caddy does so for event streams, and nginx does so for responses with the header `X-Accel-Buffering: no`, which the room server sends.
2. It keeps a connection open for as long as a member stays in a room, which can be hours. The room server writes a line to every stream every 15 seconds, so a proxy that closes connections after a period without data keeps them open.

A request with the token checks the address and the token together.

```sh
curl -H "Authorization: Bearer a-long-token-of-your-own" https://music.example.com/api/time
# {"now":1768469400123}
```

## Tell the members

The people who listen with you enter two values in the settings of the extension: the address of the server, such as `https://music.example.com`, and its token.
[Install the extension](/musictogether/getting-started/extension/) describes the settings.

## Update the server

These commands fetch the image of the latest release and replace the container.

```sh
docker compose pull
docker compose up -d
```

The rooms remain in the volume. The extension of a member who is in a room connects again by itself within seconds.

[Server configuration](/musictogether/settings/server/) describes every setting, the logs, and the limits of the server.
