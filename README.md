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

## Notes

- `config.json` holds passwords and API keys — it is gitignored and never committed.
- The dashboard is password-gated with HTTP Basic auth. Only expose it on networks you trust.
- qBittorrent session cookies are kept in memory only.
