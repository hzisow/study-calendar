# Deploying Recall to study.henryzisow.com

This app is built to live on its **own subdomain** via its **own GitHub Pages
site**. (A repo's Pages site allows only one custom domain, and this repo's slot
is already used by `redditstories.henryzisow.com` — so the study app needs a
separate repo.)

The files in this folder are deploy-ready: a `CNAME` file is already set to
`study.henryzisow.com`, and all paths are relative so they work at a domain root.

## One-time setup (~5 minutes)

### 1. Create the new repo
1. On GitHub: **New repository** → name it e.g. `study-calendar` → **Public** → Create.
2. Copy **everything inside this `docs/study/` folder** into the **root** of the new
   repo. That's: `index.html`, `app.js`, `ics.js`, `sw.js`, `manifest.webmanifest`,
   `CNAME`, and the `icons/` folder.
   - Easiest: download this folder from GitHub (or `git clone` this repo, then copy
     `docs/study/*` into the new repo and push).

### 2. Add the DNS record at GoDaddy
1. Sign in to GoDaddy → **My Products** → next to **henryzisow.com** click
   **DNS** (Manage DNS).
2. **Add New Record**:
   | Field | Value |
   |---|---|
   | Type | **CNAME** |
   | Name | **study** |
   | Value | **hzisow.github.io** |
   | TTL | 1 Hour (default) |
3. **Save.** (Put just `study` as the Name — GoDaddy adds `.henryzisow.com`
   automatically. Don't point it at the `redditstories` host.)

### 3. Turn on GitHub Pages for the new repo
1. New repo → **Settings** → **Pages**.
2. **Source:** Deploy from a branch → **Branch: `main`**, **Folder: `/ (root)`** → **Save**.
3. The **Custom domain** box should auto-fill `study.henryzisow.com` (read from the
   `CNAME` file). If not, type it and Save.
4. Wait for GitHub to verify DNS and issue the TLS certificate (usually minutes,
   occasionally up to a few hours). Then tick **Enforce HTTPS**.

### 4. Done
Visit **https://study.henryzisow.com** on your phone → browser menu →
**Add to Home Screen** to install it as an app.

## Google Calendar direct sync (optional but recommended)

Lets reviews appear in your Google Calendar the second you log a topic — no
download or import. Setup is a one-time 5-minute thing in Google Cloud:

1. Open **https://console.cloud.google.com** → top bar **▾ → New Project** →
   name it `Recall` → **Create**.
2. Top search bar: **Google Calendar API** → click it → **Enable**.
3. Left sidebar → **APIs & Services → OAuth consent screen**:
   - User type: **External** → Create
   - App name: `Recall` · User support email: your email · Developer email: your email · Save
   - **Scopes** step: leave empty → Save and continue
   - **Test users** step: **+ Add Users** → add your own Google email → Save and continue
4. Left sidebar → **Credentials → + Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Name: `Recall Web`
   - **Authorized JavaScript origins → + Add URI** → `https://study.henryzisow.com`
     - (Also add `http://localhost:8000` if you want to test locally.)
   - **Create** → copy the **Client ID** (ends in `.apps.googleusercontent.com`).
5. In the app on your phone/laptop: **Settings → Google Calendar (direct sync)** →
   paste the Client ID → tap **🔗 Connect Google Calendar** → sign in.
   - You'll see *“Google hasn't verified this app”* — that's normal for a personal app
     in Testing mode. Click **Advanced → Continue to Recall**.
6. Done. A new **Recall Reviews** calendar appears in your Google Calendar
   (calendar.google.com), and every topic you log creates 5 events on it with
   built-in phone reminders.

You can switch the Recall calendar's color, hide it during exams, etc. — it's a
normal Google calendar your Recall app fully owns.

## Notes
- **Order matters:** add the GoDaddy DNS record *before* (or right when) you set the
  Pages custom domain — the HTTPS certificate can't be issued until `study`
  resolves to GitHub.
- **Keep one live copy.** Since this is the deploy target, don't also merge the
  `spaced-repetition` branch into your Pages branch (`youtube-automation`) — that
  would publish a second copy at `redditstories.henryzisow.com/study/`. Use the
  dedicated repo as the home for the app going forward.
- **Updating later:** edit the files in the new repo and push to `main`; Pages
  redeploys automatically. (The service worker cache is versioned via `CACHE` in
  `sw.js` — bump it when you change cached files so devices pick up the update.)
