# MediaDash

One phone-friendly dashboard for your whole download stack: **qBittorrent** progress with pause/resume, plus **Sonarr** and **Radarr** queues — and **search** to add new shows/movies, which start downloading immediately. Runs on your server laptop; open it from your phone on the same WiFi.

## Setup (on the laptop)

1. Install Node.js 18+ if you don't have it: https://nodejs.org
2. Clone this repo and install:
   ```
   git clone https://github.com/ABerger94/mediadash.git
   cd mediadash
   npm install
   ```
3. Copy `config.example.json` to `config.json` and fill it in:
   - `qbittorrent.username` / `qbittorrent.password` — your qBittorrent Web UI login
   - `sonarr.apiKey` — Sonarr → Settings → General → API Key
   - `radarr.apiKey` — Radarr → Settings → General → API Key
   - `dashboardUser` / `dashboardPassword` — pick a login for the dashboard itself
4. Start it:
   ```
   npm start
   ```
5. Open http://localhost:3000 on the laptop.

## On your phone (same WiFi)

Find the laptop's IP (`ipconfig` → IPv4 Address, e.g. `192.168.1.5`), then open:

```
http://192.168.1.5:3000
```

Log in with the dashboard user/password from your config.

## Run at startup (Windows)

To have it start with the laptop, create a `mediadash.bat` containing:

```
@echo off
cd /d C:\path\to\mediadash
npm start
```

Put it in the Startup folder (Win+R → `shell:startup`).

## Remote access via Vercel (check downloads away from home)

The backend (`server.js`) must keep running on your laptop — it's the only thing
that can reach qBittorrent/Sonarr/Radarr on your home network. Vercel hosts the
frontend and proxies `/api/*` to your laptop through a secure Cloudflare Tunnel.

1. On the laptop, install `cloudflared`: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. Create a (free) named tunnel so the URL never changes:
   ```
   cloudflared tunnel login
   cloudflared tunnel create mediadash
   cloudflared tunnel route dns mediadash mediadash.example.com
   cloudflared tunnel run --url http://localhost:3000 mediadash
   ```
   (Or for a quick test: `cloudflared tunnel --url http://localhost:3000` — but that
   URL changes every restart, so you'd have to update `vercel.json` each time.)
3. In `vercel.json`, replace `YOUR-TUNNEL-URL-HERE` with your tunnel hostname
   (e.g. `mediadash.example.com`), commit, and push.
4. In the Vercel dashboard: Add New → Project → import `ABerger94/mediadash` → Deploy.
   No build command needed; output directory is `public`.
5. Open the Vercel URL on your phone and log in with the dashboard user/password.

Notes:
- The laptop must stay on with `npm start` running, or the Vercel copy shows errors.
- The tunnel URL is public — the dashboard password gate still protects it, but don't
  share the link.
- Local WiFi access (`http://<laptop-ip>:3000`) keeps working exactly as before.

## Notes

- `config.json` holds passwords and API keys — it is gitignored and never committed.
- The dashboard is password-gated with HTTP Basic auth. Only expose it on networks you trust.
- qBittorrent session cookies are kept in memory only.
