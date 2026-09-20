// MediaDash backend — proxies qBittorrent, Sonarr, Radarr into one API.
// Run:  node server.js   (then open http://localhost:3000)
const express = require('express');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('Missing config.json — copy config.example.json to config.json and fill it in.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const app = express();
app.use(express.json());

// ---- Simple password gate for the dashboard itself ----
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Basic ')) {
    const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
    if (user === config.dashboardUser && pass === config.dashboardPassword) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="MediaDash"');
  return res.status(401).send('Login required');
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- qBittorrent session handling ----
let qbSid = null;
async function qbLogin() {
  const params = new URLSearchParams({
    username: config.qbittorrent.username,
    password: config.qbittorrent.password,
  });
  const res = await fetch(`${config.qbittorrent.url}/api/v2/auth/login`, {
    method: 'POST',
    body: params,
    headers: {
      // qBittorrent 4.5+ enables CSRF protection by default; it rejects
      // API logins that don't carry matching Origin/Referer headers.
      Origin: config.qbittorrent.url,
      Referer: config.qbittorrent.url + '/',
    },
  });
  const text = (await res.text()).trim();
  // qBittorrent < 5.2: 200 + "Ok." body. qBittorrent 5.2+: 204 No Content with an
  // empty body (the "Ok." string is gone). Bad credentials return 401.
  if (res.status !== 204 && text !== 'Ok.') {
    throw new Error(`qBittorrent login failed (HTTP ${res.status}) — check username/password in config.json`);
  }
  const setCookie = res.headers.get('set-cookie') || '';
  qbSid = setCookie.split(';')[0].trim();
  // No cookie + 204 means auth is bypassed for the localhost subnet — requests
  // work fine without a session cookie.
}

async function qbFetch(apiPath, options = {}) {
  if (!qbSid) await qbLogin();
  const doFetch = () => fetch(config.qbittorrent.url + apiPath, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(qbSid ? { Cookie: qbSid } : {}),
      Origin: config.qbittorrent.url,
      Referer: config.qbittorrent.url + '/',
    },
  });
  let res = await doFetch();
  if (res.status === 403) { // session expired — log in again once
    await qbLogin();
    res = await doFetch();
  }
  return res;
}

// ---- Combined status ----
app.get('/api/status', async (req, res) => {
  const out = { qbittorrent: null, sonarr: null, radarr: null, errors: [] };

  try {
    const [torrents, transfer] = await Promise.all([
      qbFetch('/api/v2/torrents/info').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      qbFetch('/api/v2/transfer/info').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
    ]);
    out.qbittorrent = { torrents, transfer };
  } catch (e) { out.errors.push('qBittorrent: ' + e.message); }

  try {
    const r = await fetch(
      `${config.sonarr.url}/api/v3/queue?page=1&pageSize=50&includeUnknownSeriesItems=true`,
      { headers: { 'X-Api-Key': config.sonarr.apiKey } }
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const q = await r.json();
    out.sonarr = {
      queue: (q.records || []).map(rec => ({
        ...rec,
        poster: rec.seriesId ? `/api/poster/sonarr/${rec.seriesId}` : null,
      })),
    };
  } catch (e) { out.errors.push('Sonarr: ' + e.message); }

  try {
    const r = await fetch(
      `${config.radarr.url}/api/v3/queue?page=1&pageSize=50`,
      { headers: { 'X-Api-Key': config.radarr.apiKey } }
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const q = await r.json();
    out.radarr = {
      queue: (q.records || []).map(rec => ({
        ...rec,
        poster: rec.movieId ? `/api/poster/radarr/${rec.movieId}` : null,
      })),
    };
  } catch (e) { out.errors.push('Radarr: ' + e.message); }

  res.json(out);
});

// ---- Pause / resume ALL torrents ----
// Registered before the per-hash route so "all" isn't parsed as a hash.
// qBittorrent accepts hashes=all on stop/start (5.x) and pause/resume (4.x).
app.post('/api/torrents/all/:action', async (req, res) => {
  const { action } = req.params;
  if (!['pause', 'resume'].includes(action)) return res.status(400).json({ error: 'bad action' });
  const modern = action === 'pause' ? 'stop' : 'start';
  const legacy = action === 'pause' ? 'pause' : 'resume';
  const call = (ep) => qbFetch(`/api/v2/torrents/${ep}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ hashes: 'all' }),
  });
  try {
    let r = await call(modern);
    if (r.status === 404) r = await call(legacy);
    res.json({ ok: r.ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Torrent pause / resume ----
// qBittorrent 5.x renamed pause/resume to stop/start; fall back to legacy names on 4.x.
app.post('/api/torrents/:hash/:action', async (req, res) => {
  const { hash, action } = req.params;
  if (!['pause', 'resume'].includes(action)) return res.status(400).json({ error: 'bad action' });
  const modern = action === 'pause' ? 'stop' : 'start';
  const legacy = action === 'pause' ? 'pause' : 'resume';
  const call = (ep) => qbFetch(`/api/v2/torrents/${ep}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ hashes: hash }),
  });
  try {
    let r = await call(modern);
    if (r.status === 404) r = await call(legacy);
    res.json({ ok: r.ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Poster proxy (queue cards show artwork; API keys stay server-side) ----
const posterCache = new Map();
async function resolvePoster(source, id) {
  const key = `${source}:${id}`;
  if (posterCache.has(key)) return posterCache.get(key);
  const cfg = source === 'sonarr' ? config.sonarr : config.radarr;
  const itemPath = source === 'sonarr' ? `/api/v3/series/${id}` : `/api/v3/movie/${id}`;
  const r = await fetch(cfg.url + itemPath, { headers: { 'X-Api-Key': cfg.apiKey } });
  if (!r.ok) return null;
  const item = await r.json();
  const p = (item.images || []).find(i => i.coverType === 'poster');
  if (!p) return null;
  // Prefer the local MediaCover file (fast); fall back to the remote artwork URL.
  const url = p.url && p.url.startsWith('/')
    ? `${cfg.url}${p.url}?apikey=${cfg.apiKey}`
    : (p.remoteUrl || null);
  if (!url) return null;
  posterCache.set(key, url);
  return url;
}

app.get('/api/poster/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  if (!['sonarr', 'radarr'].includes(source) || !/^\d+$/.test(id)) return res.sendStatus(400);
  try {
    const url = await resolvePoster(source, id);
    if (!url) return res.sendStatus(404);
    const r = await fetch(url);
    if (!r.ok) return res.sendStatus(502);
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.sendStatus(502);
  }
});

// ---- Personal media library (browse + stream downloaded files, no Plex) ----
const library = require('./library');

app.get('/api/library', (req, res) => {
  try {
    if (req.query.fresh === '1') library.invalidate();
    res.json(library.getLibrary(config));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Numeric ids only — never trust a raw path from the client.
app.get('/api/stream/:id', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.sendStatus(400);
  library.streamHandler(req, res);
});

// ---- On-the-fly MKV -> MP4 conversion (so Safari can play anything) ----
const transcode = require('./transcode');

// Start (or reuse) a conversion job for a non-native file.
app.post('/api/convert/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  library.getLibrary(config); // make sure the scan has run at least once
  const f = library.getFile(req.params.id);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (f.playable) return res.status(400).json({ error: 'already plays natively' });
  if (!transcode.toolsAvailable(config)) {
    return res.status(503).json({ error: 'no-ffmpeg', message: transcode.NO_FFMPEG_MSG });
  }
  try {
    const job = await transcode.startJob(config, f);
    res.json(transcode.jobPublic(job));
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
});

// Poll conversion progress: { jobId, state: queued|converting|done|error, percent, error }
app.get('/api/convert/:jobId/status', (req, res) => {
  const job = transcode.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  res.json(transcode.jobPublic(job));
});

// Stream a finished conversion with the same Range support as library files.
app.get('/api/stream-converted/:jobId', (req, res) => {
  const job = transcode.getJob(req.params.jobId);
  if (!job || job.state !== 'done') return res.sendStatus(404);
  library.streamPath(req, res, job.outPath, transcode.outNameFor(job.title), 'video/mp4', false);
});

// ---- Search across Sonarr / Radarr ----
function pickPoster(images) {
  const p = (images || []).find(i => i.coverType === 'poster');
  return p ? p.remoteUrl : null;
}

app.get('/api/search', async (req, res) => {
  const { type, q } = req.query;
  if (!q || !['series', 'movie'].includes(type)) {
    return res.status(400).json({ error: 'Use ?type=series|movie&q=...' });
  }
  try {
    if (type === 'series') {
      const r = await fetch(
        `${config.sonarr.url}/api/v3/series/lookup?term=${encodeURIComponent(q)}`,
        { headers: { 'X-Api-Key': config.sonarr.apiKey } }
      );
      if (!r.ok) throw new Error('Sonarr HTTP ' + r.status);
      const items = await r.json();
      return res.json(items.map(s => ({
        id: s.tvdbId, title: s.title, year: s.year,
        overview: s.overview, poster: pickPoster(s.images), type: 'series',
      })));
    }
    const r = await fetch(
      `${config.radarr.url}/api/v3/movie/lookup?term=${encodeURIComponent(q)}`,
      { headers: { 'X-Api-Key': config.radarr.apiKey } }
    );
    if (!r.ok) throw new Error('Radarr HTTP ' + r.status);
    const items = await r.json();
    return res.json(items.map(m => ({
      id: m.tmdbId, title: m.title, year: m.year,
      overview: m.overview, poster: pickPoster(m.images), type: 'movie',
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Add a series/movie and trigger an immediate search ----
app.post('/api/add', async (req, res) => {
  const { type, id } = req.body;
  if (!['series', 'movie'].includes(type) || !id) {
    return res.status(400).json({ ok: false, error: 'Bad request' });
  }
  try {
    if (type === 'series') {
      const H = { 'X-Api-Key': config.sonarr.apiKey, 'Content-Type': 'application/json' };
      const base = config.sonarr.url;
      const [profiles, folders, lookup] = await Promise.all([
        fetch(`${base}/api/v3/qualityprofile`, { headers: H }).then(r => r.json()),
        fetch(`${base}/api/v3/rootfolder`, { headers: H }).then(r => r.json()),
        fetch(`${base}/api/v3/series/lookup?term=tvdb:${id}`, { headers: H }).then(r => r.json()),
      ]);
      const langProfiles = await fetch(`${base}/api/v3/languageprofile`, { headers: H }).then(r => r.json());
      const english = (langProfiles || []).find(l => /english/i.test(l.name)) || langProfiles[0];
      const existing = await fetch(`${base}/api/v3/series`, { headers: H }).then(r => r.json());
      if ((existing || []).some(s => s.tvdbId === Number(id))) {
        return res.json({ ok: false, alreadyAdded: true, error: 'Already in your library' });
      }
      const item = (lookup || []).find(s => s.tvdbId === Number(id)) || lookup[0];
      if (!item) throw new Error('Series not found');
      const body = {
        tvdbId: item.tvdbId, title: item.title, titleSlug: item.titleSlug,
        qualityProfileId: profiles[0].id, rootFolderPath: folders[0].path,
        languageProfileId: english.id,
        monitored: true, seasonFolder: true,
        monitorNewItems: 'all',
        seasons: (item.seasons || []).map(s => ({ seasonNumber: s.seasonNumber, monitored: true })),
        seriesType: item.seriesType || 'standard',
        addOptions: { searchForMissingEpisodes: true },
      };
      const r = await fetch(`${base}/api/v3/series`, { method: 'POST', headers: H, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('Sonarr HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
      return res.json({ ok: true, title: item.title });
    }
    const H = { 'X-Api-Key': config.radarr.apiKey, 'Content-Type': 'application/json' };
    const base = config.radarr.url;
    const [profiles, folders, lookup] = await Promise.all([
      fetch(`${base}/api/v3/qualityprofile`, { headers: H }).then(r => r.json()),
      fetch(`${base}/api/v3/rootfolder`, { headers: H }).then(r => r.json()),
      fetch(`${base}/api/v3/movie/lookup?term=tmdb:${id}`, { headers: H }).then(r => r.json()),
    ]);
    const existing = await fetch(`${base}/api/v3/movie`, { headers: H }).then(r => r.json());
    if ((existing || []).some(m => m.tmdbId === Number(id))) {
      return res.json({ ok: false, alreadyAdded: true, error: 'Already in your library' });
    }
    const item = (lookup || []).find(m => m.tmdbId === Number(id)) || lookup[0];
    if (!item) throw new Error('Movie not found');
    const body = {
      tmdbId: item.tmdbId, title: item.title, titleSlug: item.titleSlug, year: item.year,
      qualityProfileId: profiles[0].id, rootFolderPath: folders[0].path,
      monitored: true,
      addOptions: { searchForMovie: true },
    };
    const r = await fetch(`${base}/api/v3/movie`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('Radarr HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
    return res.json({ ok: true, title: item.title });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = config.port || 3000;
app.listen(PORT, () => {
  console.log(`MediaDash running at http://localhost:${PORT}`);
});
