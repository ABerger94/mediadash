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
  const text = await res.text();
  if (text.trim() !== 'Ok.') throw new Error(`qBittorrent login failed (HTTP ${res.status}) — if credentials are correct, disable CSRF protection in qBittorrent's Web UI settings`);
  const setCookie = res.headers.get('set-cookie') || '';
  qbSid = setCookie.split(';')[0];
  if (!qbSid) throw new Error('qBittorrent did not return a session cookie');
}

async function qbFetch(apiPath, options = {}) {
  if (!qbSid) await qbLogin();
  const doFetch = () => fetch(config.qbittorrent.url + apiPath, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Cookie: qbSid,
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
    out.sonarr = { queue: q.records || [] };
  } catch (e) { out.errors.push('Sonarr: ' + e.message); }

  try {
    const r = await fetch(
      `${config.radarr.url}/api/v3/queue?page=1&pageSize=50`,
      { headers: { 'X-Api-Key': config.radarr.apiKey } }
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const q = await r.json();
    out.radarr = { queue: q.records || [] };
  } catch (e) { out.errors.push('Radarr: ' + e.message); }

  res.json(out);
});

// ---- Torrent pause / resume ----
app.post('/api/torrents/:hash/:action', async (req, res) => {
  const { hash, action } = req.params;
  if (!['pause', 'resume'].includes(action)) return res.status(400).json({ error: 'bad action' });
  try {
    const r = await qbFetch(`/api/v2/torrents/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ hashes: hash }),
    });
    res.json({ ok: r.ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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
      const item = (lookup || []).find(s => s.tvdbId === Number(id)) || lookup[0];
      if (!item) throw new Error('Series not found');
      const body = {
        tvdbId: item.tvdbId, title: item.title, titleSlug: item.titleSlug,
        qualityProfileId: profiles[0].id, rootFolderPath: folders[0].path,
        monitored: true, seasonFolder: true,
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
