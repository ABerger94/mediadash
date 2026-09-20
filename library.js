// MediaDash personal library scanner + HTTP file streaming.
// Scans configured media directories for video files, groups TV as
// Show > Season > Episode and movies as a flat list, and streams files
// over HTTP with Range support so seeking works in the browser.
//
// MKV (and other non-Safari containers) are converted to MP4 on demand by
// transcode.js; this module just streams files, whatever their source.

const fs = require('fs');
const path = require('path');

const VIDEO_EXTS = new Set([
  '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm',
  '.mpg', '.mpeg', '.wmv', '.ts', '.m2ts',
]);

// Containers an iPhone plays natively inside a <video> tag.
const SAFARI_PLAYABLE = new Set(['.mp4', '.m4v', '.mov']);

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
};

const SCAN_CACHE_MS = 60 * 1000; // rescan at most once a minute

function detectType(dirPath) {
  const base = path.basename(dirPath).toLowerCase();
  if (/(^|[._\s-])(tv|shows?|series|anime)($|[._\s-])/.test(base)) return 'tv';
  if (/(^|[._\s-])(movies?|films?|cinema)($|[._\s-])/.test(base)) return 'movie';
  return 'movie';
}

// Accepts ["E:/media/tv"] or [{path, type}] mixes; type defaults from the folder name.
function normalizeMediaDirs(cfg) {
  const raw = (cfg.mediaDirs && cfg.mediaDirs.length) ? cfg.mediaDirs : ['E:/media/tv'];
  return raw
    .map(d => (typeof d === 'string'
      ? { path: d, type: detectType(d) }
      : { path: d && d.path, type: String((d && d.type) || detectType((d && d.path) || '')).toLowerCase() }))
    .filter(d => d.path && ['tv', 'movie'].includes(d.type));
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) { return; } // missing/unreadable dir — skip quietly
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
}

function parseEpisode(filename) {
  const base = path.basename(filename, path.extname(filename));
  let m = base.match(/[Ss](\d{1,2})[Ee](\d{1,3})/) || base.match(/(\d{1,2})[xX](\d{1,3})/);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  return null;
}

function parseSeasonFolder(name) {
  const m = String(name).match(/season[\s._-]*(\d{1,2})/i);
  return m ? Number(m[1]) : null;
}

function prettyShow(name) {
  return String(name).replace(/[._]+/g, ' ').trim();
}

let files = [];        // flat list; index doubles as the public file id
let cache = null;      // { ts, data }

function scan(config) {
  const dirs = normalizeMediaDirs(config);
  files = [];
  const tv = new Map();   // show name -> { name, seasons: Map<num, {number, episodes: []}> }
  const movies = new Map(); // folder name -> { name, files: [] }

  for (const { path: root, type } of dirs) {
    const found = [];
    walk(root, found);
    for (const full of found) {
      const rel = path.relative(root, full);
      const parts = rel.split(path.sep);
      const ext = path.extname(full).toLowerCase();
      let stat;
      try { stat = fs.statSync(full); } catch (e) { continue; }
      const id = files.length;
      const file = {
        id,
        name: path.basename(full),
        ext,
        size: stat.size,
        playable: SAFARI_PLAYABLE.has(ext),
        mime: MIME[ext] || 'application/octet-stream',
        _path: full, // never sent to the client; used only by the streamer
      };
      files.push(file);

      if (type === 'tv') {
        const showName = prettyShow(parts[0] || 'Unknown');
        let seasonNum = null;
        if (parts.length >= 3) seasonNum = parseSeasonFolder(parts[1]);
        const ep = parseEpisode(file.name);
        if (ep) seasonNum = ep.season;
        if (seasonNum == null) seasonNum = 0;
        if (!tv.has(showName)) tv.set(showName, { name: showName, seasons: new Map() });
        const show = tv.get(showName);
        if (!show.seasons.has(seasonNum)) {
          show.seasons.set(seasonNum, {
            number: seasonNum,
            label: seasonNum === 0 ? 'Other' : 'Season ' + seasonNum,
            episodes: [],
          });
        }
        show.seasons.get(seasonNum).episodes.push({
          ...file,
          season: seasonNum,
          episode: ep ? ep.episode : null,
          label: ep ? `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}` : null,
        });
      } else {
        const title = prettyShow(parts[0] ? path.basename(parts[0], path.extname(parts[0])) : file.name);
        if (!movies.has(title)) movies.set(title, { name: title, files: [] });
        movies.get(title).files.push(file);
      }
    }
  }

  const tvList = [...tv.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(show => ({
      name: show.name,
      seasons: [...show.seasons.values()]
        .sort((a, b) => (a.number === 0) - (b.number === 0) || a.number - b.number)
        .map(s => ({
          number: s.number,
          label: s.label,
          episodes: s.episodes
            .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0) || a.name.localeCompare(b.name))
            .map(({ _path, ...pub }) => pub),
        })),
    }));

  const movieList = [...movies.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(m => ({ name: m.name, files: m.files.map(({ _path, ...pub }) => pub) }));

  const totalFiles = files.length;
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  return { tv: tvList, movies: movieList, totalFiles, totalBytes };
}

function getLibrary(config) {
  const now = Date.now();
  if (!cache || now - cache.ts > SCAN_CACHE_MS) {
    cache = { ts: now, data: scan(config) };
  }
  return cache.data;
}

function getFile(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 0 || n >= files.length) return null;
  const f = files[n];
  if (f.id !== n) return null;
  return f;
}

function invalidate() { cache = null; }

// Express handler: stream a file with Range support.
// ?download=1 forces a download (used for containers Safari can't play).
function streamHandler(req, res) {
  const f = getFile(req.params.id);
  if (!f) return res.sendStatus(404);
  streamPath(req, res, f._path, f.name, f.mime, req.query.download === '1');
}

// Shared Range-request streamer for any file on disk (library files and
// converted MP4s alike). name/mime describe what the client sees.
function streamPath(req, res, absPath, name, mime, download) {
  let stat;
  try { stat = fs.statSync(absPath); } catch (e) { return res.sendStatus(404); }
  const total = stat.size;

  res.set('Accept-Ranges', 'bytes');
  res.set('Content-Type', mime);
  res.set('Content-Disposition',
    (download ? 'attachment' : 'inline') + `; filename="${encodeURIComponent(name)}"`);

  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (!m) return res.status(416).end();
    let start = m[1] === '' ? null : Number(m[1]);
    let end = m[2] === '' ? null : Number(m[2]);
    if (start == null && end == null) return res.status(416).end();
    if (start == null) { start = total - end; end = total - 1; } // suffix range
    if (end == null || end >= total) end = total - 1;
    if (start >= total || start > end || start < 0) {
      res.set('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    res.status(206);
    res.set('Content-Range', `bytes ${start}-${end}/${total}`);
    res.set('Content-Length', String(end - start + 1));
    fs.createReadStream(absPath, { start, end }).pipe(res);
  } else {
    res.set('Content-Length', String(total));
    fs.createReadStream(absPath).pipe(res);
  }
}

module.exports = { getLibrary, getFile, invalidate, streamHandler, streamPath, normalizeMediaDirs };
