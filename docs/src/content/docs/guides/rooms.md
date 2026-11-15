---
title: Listen in a room
description: Create or join a room, add songs to its queue, reorder them, and pause your own player without stopping anyone else.
---

A **room** is a queue of songs and a position in the current song, which the room server keeps for a group of people.
Everyone in a room hears the room's current song at the room's position.
Each room has a **room ID** of 5 letters and digits, which people enter to join the room.
An **invite link** is an address of YouTube Music that carries the room ID, such as `https://music.youtube.com/?musictogether=K7QMX`. Opening it joins the room.
The browser that creates a room is the room's **host**, and everyone else in the room is a **participant**. [Host and participants](/musictogether/guides/host/) describes what each of them can do.

The labels on this page are those of the English screens. The extension shows its screens in the language of Chrome, Japanese or English, until another language is chosen in its settings.

## Create a room

1. Open YouTube Music, and click the button of Music Together. The popup opens in a mini window below the button, or in the side panel on the right of the window, as the settings choose.
2. Choose Create room, and enter your name in Your name.
3. Click Create room.
4. Click Invite link in the popup to copy the invite link, and send it to the people who listen with you. To copy the room ID alone, click the room ID.

The room is on the room server of your settings. The people who join enter the same server and token in their own settings.

## Join a room

Open the invite link that you received. YouTube Music opens, and the tab joins the room under the name and with the room server of your settings.
The tab takes the room ID out of its address, so reloading the page keeps you where you are.
Before you have used a name, the popup shows the room on Join room with its ID filled in: enter your name in Your name, and click Join.
The settings need the room server and its token first; the popup asks for them when they are missing.

With a room ID in place of a link:

1. Choose Join room.
2. Enter your name in Your name, and the room ID in Room ID.
3. Click Join.

Everyone in the room sees the names of the others, each after a mark of their player: bars while it plays, and ⏸ while it is paused.

## Add songs

A song reaches the room in either of these ways:

- Search in the search field of the popup, and click ＋ next to the song.
- In YouTube Music, open the ⋮ menu of a song, and choose Add to Music Together. The item is in the menus of every YouTube Music tab while this Chrome is in a room, and appears in the menus that have Add to queue.
- In YouTube Music, open the ⋮ menu of an album or a playlist, and choose Add to Music Together. Its songs join the end of the Queue in their order, except the songs that YouTube Music cannot play for your account. When the Queue has room for fewer songs than the album, the first ones are added, and YouTube Music shows how many.
- In the Queue, click ＋ next to a song that has played to add it again.

A song added to a room where nothing plays starts at once. Any other song waits at the end of the Queue.
The Queue and the playing song show the name of the person who added each song, after its artists.
While Chrome is in a room, the button of Music Together shows the number of songs waiting in the Queue, up to 99.

The Queue lists the songs that have played in gray, up to the last 50, then the song that plays in a frame, then the songs that wait. When a song finishes, the Queue scrolls so that the song that played last is at its top.
The Queue shows a few songs at a time. When its songs do not fit, an arrow at its top makes it reach down to the bottom of the window, and folds it again; the songs that showed at the top stay in view through both. A Queue longer than that scrolls.

## Reorder the queue

Drag a waiting song in the Queue up or down. The first waiting song plays next. The songs that have played stay where they are.
Reordering needs the host, or the host's permission, which a new room gives to participants.

## Pause your own player

Pausing stops your own player only, whether you pause it in the popup or in YouTube Music. Everyone else keeps listening.
Playing again starts the room's current song at the room's current position, which has moved on while you were paused.
The others see ⏸ before your name while your player is paused.

## How a room plays

- While Chrome is in a room, the tab of the room plays the room's songs. A song started in that tab by hand is replaced by the room's song. While nothing plays in the room, the tab plays anything.
- Chrome is in one room at a time, in one tab. Joining in another tab takes the first tab out of the room.
- When a song ends, the room plays the first song waiting in the Queue. When no song waits, the room stops, and the autoplay and radio of YouTube Music do not continue it.
- The room moves forward while at least one member listens. When every member has paused, the room stops at that position, and it moves on from there when someone plays again.
- When every listening member has left the room, the room waits 30 seconds for them to connect again, and then stops at its position.
- A room that nobody is in or changes for an hour is deleted. Leaving a room open in a tab keeps it.
- A song that your account cannot play, as when it is not available in your region, stays silent in your tab only. The others hear it.
- A member who gets an ad falls behind during the ad, and the player moves to the room's position after it.
- Closing the popup, in the mini window or in the side panel, leaves Chrome in the room.

## Messages of the popup

| Message | Meaning and what to do |
| --- | --- |
| Set the server and the token | The settings have no server or no token. Click Open settings, and enter the address and the token of the room server. |
| Reload the YouTube Music tab | The tab was opened before the extension was installed or updated. Reload the tab. |
| Playback does not start. Click the YouTube Music page once | Chrome plays sound only in a page that has been clicked. Click anywhere in the page of YouTube Music. |
| Back to the room's song | The tab of a room plays the room's songs. To play other songs, leave the room. |
| This account cannot play this song | Your account cannot play the room's current song, as when the song is not available in your region. The others hear it. |
| The token is wrong | The token in the settings differs from the room server's. Ask the person who runs the server for the token, and enter it in the settings again. |
| Cannot reach the server | Chrome cannot reach the address of the server in the settings. Check the address, and ask the person who runs the server whether it is running. |
| The server does not answer. Check the address of the server | The server gave no answer within 10 seconds. Check the address in the settings, and ask the person who runs the server whether it is running. |
| Chrome does not let YouTube Music reach this computer. Open the site settings, and allow Apps on device | The room server runs on the same computer, and Chrome lets YouTube Music reach this computer only with a permission of the site. Click Open site settings, allow Apps on device for music.youtube.com, and reload the tab of YouTube Music. |
