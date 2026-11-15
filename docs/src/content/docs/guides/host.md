---
title: Host and participants
description: What the host of a room and its participants can do, how the host lets participants control playback, and how the host closes a room.
---

The **host** of a room is the Chrome that created the room.
The room server recognizes the host by an ID that the extension keeps in Chrome, so the host remains the host after connecting again or reopening YouTube Music in the same Chrome.
A **participant** is a member of the room in any other Chrome.

## What each member can do

| Action | Host | Participant |
| --- | --- | --- |
| Add a song | Yes | Yes |
| Remove a song that you added | Yes | Yes |
| Remove a song that someone else added | Yes | No |
| Pause and play your own player | Yes | Yes |
| Seek, and skip to the next song | Yes | With the host's permission, which a new room gives |
| Reorder the Queue | Yes | With the host's permission, which a new room gives |
| Give or take away the permission | Yes | No |
| End the room | Yes | No |

Pausing and playing affect your own player only, from the popup and from the player of YouTube Music.
Seeking and skipping reach everyone in the room, from the seek bar and the ⏭ button of the popup, and from those of the player of YouTube Music.
A member without the permission sees the seek bar of the popup without its handle.
A participant without the permission who seeks in YouTube Music returns to the room's position.

## Let participants control playback

The switch Participants can skip and reorder, in the popup of the host, gives participants the permission to seek, skip, and reorder the Queue.
The switch is on in a new room. The host turns it off to keep these to the host.

## End a room

Ending a room deletes it, with its Queue, and takes everyone out of it. So the room ends 5 seconds after the host asks, and the host can take it back until then:

1. Click End room at the top of the popup.
2. The popup shows The room ends in 5 seconds, and the button becomes Undo. Click Undo to keep the room as it is.

The others notice nothing during the 5 seconds. The room ends even when the popup is closed in the meantime. A host who closes or reloads the tab of the room before then keeps the room.

A host who closes the tab only, without ending the room, leaves the room running, and the room plays the Queue in order.
