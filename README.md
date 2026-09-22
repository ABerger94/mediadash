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
5. Open http://localhost:3001 on the laptop.

## On your phone (same WiFi)

Find the laptop's IP (`ipconfig` → IPv4 Address, e.g. `192.168.1.5`), then open:

```
http://192.168.1.5:3001
```

Log in with the dashboard user/password from your config.

## Run at startup (Windows) — no more `npm start`

Run this **once** from a Terminal/PowerShell window inside the repo folder
(no administrator needed):

```
powershell -ExecutionPolicy Bypass -File install-task.ps1
```

This registers MediaDash as a Windows background task: it starts automatically at
boot, restarts itself if it crashes, and runs with no console window. Verify it's
running at http://localhost:3001. To remove it later: Win+R → `shell:startup` →
delete `MediaDash.lnk`.

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
   cloudflared tunnel run --url http://localhost:3001 mediadash
   ```
   (Or for a quick test: `cloudflared tunnel --url http://localhost:3001` — but that
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
- Local WiFi access (`http://<laptop-ip>:3001`) keeps working exactly as before.

## Library tab — browse and watch your downloads, no Plex needed

The **Library** tab scans your finished media folders and lets you browse
movies and TV shows (Show → Season → Episode) and stream them straight to
your phone's browser.

Add your media folders to `config.json` (defaults to `E:/media/tv` if omitted):

```json
"mediaDirs": ["E:/media/tv", "E:/media/movies"]
```

A folder whose name contains tv / shows / series / anime is treated as TV;
movies / films / cinema (or anything else) is treated as movies. To be
explicit, use objects instead:

```json
"mediaDirs": [
  { "path": "E:/media/tv", "type": "tv" },
  { "path": "E:/media/movies", "type": "movie" }
]
```

How it works:

- MP4 / M4V / MOV files get a **Play** button — they stream in the browser
  with full seeking (HTTP Range support) and play natively in Safari.
- Anything else (MKV, AVI, WEBM, …) gets a **Convert & Play** button: the
  server converts it to MP4 on the fly with ffmpeg, shows a progress bar,
  then plays it in the browser. A **Download** link for the original file
  stays next to it.
- Every library, convert, and stream route sits behind the same dashboard password.

### Transcoding (MKV → MP4 for Safari)

Conversion is remux-first: if the video is already h264/hevc and the audio
is AAC/MP3/AC-3/E-AC-3, the streams are copied straight into an MP4
container — fast (usually 1–2 min for a full movie), zero quality loss, low
CPU. Otherwise video is re-encoded to h264 (crf 20, veryfast) and/or audio
to AAC. Subtitles are dropped.

Converted files are cached in `transcodeDir` (default `./transcode-cache`,
gitignored), keyed on the source file's size + modification time — replaying
the same file skips conversion entirely. Only one conversion runs at a time.

ffmpeg setup (no admin needed on Windows):

1. Download a portable build from https://www.gyan.dev/ffmpeg/builds/
   (the `ffmpeg-release-essentials.zip`), unzip it anywhere.
2. Add to `config.json`:
```json
"ffmpegPath": "C:/ffmpeg/bin/ffmpeg.exe",
"ffprobePath": "C:/ffmpeg/bin/ffprobe.exe"
```
Leave them empty to use whatever is on PATH instead.

If ffmpeg can't be found, Convert & Play shows the setup instructions
instead of failing silently.

Limitations: conversion jobs live in memory — restarting the server drops
in-progress jobs (finished conversions stay cached, so just hit Play
again). Very large re-encodes take a while; remuxes are quick.

Future ideas (not in this pass): posters/artwork for library items,
watched-state tracking.

## Notes

- `config.json` holds passwords and API keys — it is gitignored and never committed.
- The dashboard is password-gated with HTTP Basic auth. Only expose it on networks you trust.
- qBittorrent session cookies are kept in memory only.
