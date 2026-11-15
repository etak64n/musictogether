---
title: Listen in a room
description: Create or join a room, add songs to its queue, reorder them, and pause your own player without stopping anyone else.
---

A **room** is a queue of songs and a position in the current song, which the room server keeps for a group of people.
Everyone in a room hears the room's current song at the room's position.
Each room has a **room ID** of 5 letters and digits, which people enter to join the room.
The browser that creates a room is the room's **host**, and everyone else in the room is a **participant**. [Host and participants](/musictogether/guides/host/) describes what each of them can do.

The labels on this page are those of the English screens. The extension shows its screens in the language of Chrome, Japanese or English, until another language is chosen in its settings.

## Create a room

1. Open YouTube Music, and click the button of Music Together. The popup opens in a mini window below the button, or in the side panel on the right of the window, as the settings choose.
2. Choose Create room, and enter your name in Your name.
3. Click Create room.
4. Click the room ID in the popup to copy it, and send it to the people who listen with you.

The room is on the room server of your settings. The people who join enter the same server and token in their own settings.

## Join a room

1. Choose Join room.
2. Enter your name in Your name, and the room ID in Room ID.
3. Click Join.

Everyone in the room sees the names of the others.

## Add songs

A song reaches the room in either of these ways:

- Search in the search field of the popup, and click ＋ next to the song.
- In YouTube Music, open the ⋮ menu of a song, and choose Add to Music Together. The item is in the menu while the tab is in a room.

A song added to a room where nothing plays starts at once. Any other song goes to the end of Up next.
Up next and the playing song show the name of the person who added each song, after its artists.
While Chrome is in a room, the button of Music Together shows the number of songs in Up next, up to 99.

## Reorder the queue

Drag a song in Up next up or down. The song at the top plays next.
Reordering needs the host, or a participant whom the host allows to control playback.

## Pause your own player

Pausing stops your own player only, whether you pause it in the popup or in YouTube Music. Everyone else keeps listening.
Playing again starts the room's current song at the room's current position, which has moved on while you were paused.

## How a room plays

- While Chrome is in a room, the tab of the room plays the room's songs. A song started in that tab by hand is replaced by the room's song. While nothing plays in the room, the tab plays anything.
- Chrome is in one room at a time, in one tab. Joining in another tab takes the first tab out of the room.
- When a song ends, the room plays the next song in Up next. When Up next is empty, the room stops, and the autoplay and radio of YouTube Music do not continue it.
- The room moves forward while at least one member listens. When every member has paused, the room stops at that position, and it moves on from there when someone plays again.
- When every listening member has left the room, the room waits 30 seconds for them to connect again, and then stops at its position.
- A room that nobody joins or changes for 7 days is deleted.
- A song that your account cannot play, as when it is not available in your region, stays silent in your tab only. The others hear it.
- A member who gets an ad falls behind during the ad, and the player moves to the room's position after it.
- Closing the popup, in the mini window or in the side panel, leaves Chrome in the room.

## Messages of the popup

| Message | Meaning and what to do |
| --- | --- |
| Set the server and the token | The settings page has no server or no token. Open settings, and enter the address and the token of the room server. |
| Reload the YouTube Music tab | The tab was opened before the extension was installed or updated. Reload the tab. |
| Playback does not start. Click the YouTube Music page once | Chrome plays sound only in a page that has been clicked. Click anywhere in the page of YouTube Music. |
| Back to the room's song | The tab of a room plays the room's songs. To play other songs, leave the room. |
| This account cannot play this song | Your account cannot play the room's current song, as when the song is not available in your region. The others hear it. |
| The token is wrong | The token in the settings differs from the room server's. Ask the person who runs the server for the token, and enter it in the settings again. |
| Cannot reach the server | Chrome cannot reach the address of the server in the settings. Check the address, and ask the person who runs the server whether it is running. |
| The server does not answer. Check the address of the server | The server gave no answer within 10 seconds. Check the address in the settings, and ask the person who runs the server whether it is running. |
| The server does not answer. If Chrome asks in the YouTube Music tab to let it access this computer, allow it | Chrome holds a request to a room server on the same computer until you allow YouTube Music to reach this computer. Look for the question of Chrome in the YouTube Music tab, and allow it. |
