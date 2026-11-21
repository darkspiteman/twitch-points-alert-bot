# Twitch Alert Bot — guide

*По-русски: [README.md](README.md)*

Your own replacement for Sound Alerts. It runs on your computer together with **OBS Studio** or
**Streamlabs Desktop**: when a viewer redeems a channel points reward, a sound, video or animation plays
in your streaming app. No cloud services, no paid hosting.

---

## Language

The panel starts in your browser's language. Switch any time with **RU / EN** at the top of the left sidebar
or in **Settings → General → Язык / Language**. The change applies immediately, no restart: the panel, tips, Help, bot messages,
the event log, the overlay service text, the test alert caption and the tray menu.

## Install (one time)

1. Open the program folder and double-click **`install.cmd`**.
   It prepares everything and creates a **“Twitch Alert Bot”** shortcut on the desktop.
2. Start **“Twitch Alert Bot”** from the desktop.
   - A purple star icon appears next to the clock.
   - The **control panel** opens in your browser (`http://127.0.0.1:17420/panel/`).

> If Windows asks about network access, choose “Private networks” only or “Cancel”.
> The bot doesn't need outside access: it only works inside your computer.

Requirements: Windows 10/11 and Node.js 22.18 or newer.

## Connect to Twitch (one time)

The bot signs in through the official Twitch mechanism: you confirm the sign-in on twitch.tv,
the bot **never sees your password**.

1. Open <https://dev.twitch.tv/console/apps/create> and sign in with your Twitch account
   (Twitch may ask you to turn on two-factor authentication).
2. Fill in the form:
   - **Name** — anything unique, for example `Alert Bot YourName`;
   - **OAuth Redirect URLs** — `http://localhost` (required, the bot doesn't use it);
   - **Category** — `Broadcaster Suite`;
   - **Client Type** — **Public**.
3. Click “Create”, then “Manage”. Copy the **Client ID**. The client secret is not needed.
4. In the bot panel: **Settings → Twitch** → paste the Client ID → click **“Sign in with Twitch”**.
5. An 8-character code appears. Click **“Open twitch.tv/activate”**, check the code and click “Authorize”.
6. A few seconds later the Control page shows: **Twitch — Connected, EventSub — Active**.

Channel points are only available to Twitch Affiliates and Partners.

## Add to OBS Studio (one time)

1. “Sources” → “+” → **“Browser”**. Name: “Alert Bot”.
2. Check **“Local file”**, click “Browse” and select `data\overlay.html` in the program folder
   (the exact path and a “Copy” button are in **OBS / Streamlabs → Alerts**). This way it doesn't matter
   whether OBS or the bot starts first — the source waits for the bot.
   *Alternatively*, use the URL `http://127.0.0.1:17420/overlay`, but then start the bot before OBS.
3. Width **1920**, height **1080**.
4. Turn on **“Control audio via OBS”**, turn off **“Shutdown source when not visible”**.
5. To hear alerts in your headphones: “Advanced Audio Properties” → “Audio Monitoring” → “Monitor and Output”.
6. Add **one** source and reuse it in other scenes via “Add Existing”, otherwise sound plays twice.
7. Click **“Test alert”** on the panel's Control page.

## Add to Streamlabs Desktop (one time)

1. “Sources” → “+” → **“Browser Source”** → “Add Source”. Name: “Alert Bot”.
2. Same as OBS: check **“Local file”** and select `data\overlay.html` (or use the URL).
3. Width 1920, height 1080. Turn on **“Control audio via Streamlabs Desktop”**, turn off “Shutdown source when not visible”.
4. In the bot panel: **OBS / Streamlabs** → choose **Streamlabs Desktop** at the top right (for the launch button and scene backup).
5. Click **“Test alert”** on the Control page. Don't keep the source in both OBS and Streamlabs at the same time.

## Rewards

1. **Media library** — drag in sounds (MP3, WAV, OGG, M4A), videos (MP4 H.264 or WebM), GIFs or images. The bot checks every file;
   if a video codec won't play in OBS/Streamlabs, the **“Convert”** button re-saves it as WebM right in the panel.
2. **Rewards** → **“+ New reward in Twitch”** → title, cost, cooldown → confirm.
3. On the reward card choose **“Sound (main file)”** and optionally **“Video / GIF / image”**,
   the mode (“With video” / “Sound only”), volume, duration and anti-spam. Check **“On in the bot”**.
4. **“▶ Test”** plays the alert in your streaming app without spending points (viewers see it if you're live).

Rewards created on the Twitch website (or by Sound Alerts) are played too, but the bot can't edit them or refund points —
use **“Create your own copy in Twitch…”** for that.

**Media library → Find online**: memes and clips from Klipy, sounds from Freesound (free API keys in **Settings → Service keys**)
and downloads from a direct link. **“＋ Reward”** creates a Twitch reward with the file in one click.

## Everyday use

- Start “Twitch Alert Bot” from the desktop, or turn on **Settings → System → Start the bot with Windows**.
- **Tray icon color:** green — everything is connected; yellow — something isn't (for example, OBS is closed);
  red — the bot isn't responding (the launcher restarts it).
- **Updates:** the bot checks for new versions and installs them with one button (“Settings” → “System”).
  Settings, rewards, media and the Twitch sign-in are kept.

## Troubleshooting

| What you see | What to do |
|---|---|
| “Twitch: Not set up” | Enter the Client ID (Settings → Twitch) |
| “Twitch rejected the sign-in request” | Check the Client ID and that the app client type is “Public” |
| “Overlay: Not connected” while OBS is open | OBS probably started before the bot with a URL source: right-click the source → “Refresh”, or switch it to the “Local file” `overlay.html` |
| Sound plays twice | A second source with the bot address (or the same source in both OBS and Streamlabs), or Sound Alerts is still running |
| A file “doesn't play” | Media library → “Convert” on the file, then “Check all files” |
| “Port is used by another program” | Settings → System → another port, restart the bot and update the source |

Logs: tray menu → “Open logs folder” (`data\logs`). Tokens are never written to logs.
The technical log is always in Russian; everything you see in the panel follows the selected language.

## Where things are stored

| What | Where |
|---|---|
| Settings, history, media, logs | the `data\` folder inside the program folder |
| Twitch sign-in | `data\tokens.dpapi` — encrypted by Windows (DPAPI) for your Windows user |
| Scene backups | `data\obs-backups` |

## For developers

```
npm install          # dependencies (Node.js 22.18+)
npm start            # run without the launcher
npm run check        # type check + all tests
npm run build:launcher
```

The code and docs (docs/) are mostly in Russian; the panel texts are translated in `public/panel/i18n.js`,
server messages — in `src/i18n.ts`.
