# Recall — Spaced Repetition Study Calendar

A small, installable web app (PWA) that turns *"here's what I learned today"* into a
schedule of review reminders, and shows your Blackbaud assignments alongside them.

It runs **entirely in your browser** — no account, no server, no cost. Your data
lives in this device's local storage.

## What it does

- **Log what you learned.** Tap **+**, type the topic, pick a class, set the date.
- **Auto-schedules 5 reviews** using the classic spaced-repetition curve:
  **1 day · 3 days · 1 week · 2 weeks · 1 month** after you learned it. (Editable in Settings.)
- **Google-Calendar-style month view** with color-coded review chips per class.
- **"To review" agenda** — overdue / today / next 14 days, with one tap to mark a review done.
- **Direct Google Calendar sync** (recommended): connect your Google account once
  and reviews go straight into a dedicated **Recall Reviews** calendar — no
  download or import. Phone reminders are built in. See `DEPLOY.md` for the
  5-min Google Cloud OAuth setup.
- **Fallback:** export reviews as `.ics` (or one-click "＋Google Cal" links) if
  you'd rather not connect.
- **Blackbaud assignments** appear on the same calendar (amber chips), with
  optional **live auto-sync** (on app open + every 30 min while open).
- **In-app notifications** (bonus) while the installed app is open.

## Getting phone reminders (Google Calendar)

The most dependable phone push for a no-backend web app is to let **Google Calendar**
do it:

1. Go to the **Topics** tab → **⬇️ All reviews (.ics)** (or a single topic's
   **📅 To Google Calendar**).
2. On a computer, open [Google Calendar → Settings → Import & export](https://calendar.google.com/calendar/r/settings/export)
   and import the downloaded `.ics`. Each review has an alarm, so Google Calendar
   notifies your phone automatically.
3. Re-export and re-import whenever you've logged new topics. (Each event has a
   stable ID, so re-importing updates rather than duplicates.)

Prefer one event at a time? Every review row has a **＋Google Cal** link that opens
a pre-filled Google Calendar event.

## Connecting Blackbaud assignments

Blackbaud's myschoolapp portal can hand you a personal calendar feed:

1. In **myschoolapp**: **Calendar → Individual Filter Feeds** → copy your
   assignments feed link (a `webcal://yourschool.myschoolapp.com/...` URL).
   See Blackbaud's guide: <https://kb.blackbaud.com/articles/Article/89327>.
2. In Recall: **Settings → Blackbaud → Calendar feed URL**, paste it, then
   **🔄 Sync now**.

Two ways to pull it in, with a privacy tradeoff:

| Method | Privacy | Convenience |
|---|---|---|
| **Import `.ics` file** (Settings → Import / drag-drop) | Fully private — file never leaves your device | Manual refresh |
| **Auto-sync feed URL** | Feed URL passes through a public CORS proxy* | Automatic |

\* A static website can't fetch `myschoolapp.com` directly (browser CORS), so
auto-sync routes the request through a public proxy (`allorigins.win` by default,
switchable in Settings). The proxy sees your feed URL, which is a private link to
your calendar. If that bothers you, use **Import `.ics` file** instead — it's 100%
local. The SKY API (Blackbaud's official assignments API) needs a registered
developer app, a subscription key, and a backend for the OAuth client secret, so
it isn't usable from a no-backend static site.

## Install on your phone

Open the app in your phone browser and choose **Add to Home Screen** (or tap the
**⬇️ Install** button when it appears). It then runs full-screen like a native app
and works offline.

## Hosting

This folder is self-contained static files. It's served from this repo's existing
GitHub Pages (`docs/`), so once merged to the Pages branch it's live at:

```
https://redditstories.henryzisow.com/study/
```

To run locally: `python3 -m http.server` from this folder, then open
`http://localhost:8000/`. (A `localhost` or HTTPS origin is required for the
service worker / install to work; opening the file directly via `file://` shows the
UI but disables those.)

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell + styles |
| `app.js` | All app logic (state, calendar, agenda, modals, sync, notifications) |
| `ics.js` | iCalendar generate (export) + parse (Blackbaud) + Google Calendar links |
| `sw.js` | Service worker — offline cache + notifications |
| `manifest.webmanifest` | PWA manifest |
| `icons/` | App icons (+ `make_icons.py` generator) |

## Backups

Settings → **Export backup** writes a JSON file of everything; **Import backup**
restores it (handy for moving to another device, since data is per-browser).
