const $ = id => document.getElementById(id);

function fmtBytes(b) {
  if (b == null || isNaN(b)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(b >= 100 ? 0 : 1) + ' ' + u[i];
}
function fmtSpeed(bps) { return fmtBytes(bps) + '/s'; }
function fmtEta(s) {
  if (s == null || s < 0 || s === 8640000) return '∞';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

async function toggleTorrent(hash, action) {
  try {
    await fetch(`/api/torrents/${hash}/${action}`, { method: 'POST' });
    load();
  } catch (e) { console.error(e); }
}

async function toggleAllTorrents(action) {
  try {
    await fetch(`/api/torrents/all/${action}`, { method: 'POST' });
    load();
  } catch (e) { console.error(e); }
}

function updatePauseAll(torrents) {
  const btn = $('pause-all');
  if (!torrents.length) { btn.hidden = true; return; }
  const PAUSED = ['pausedDL', 'pausedUP', 'stoppedDL', 'stoppedUP'];
  const DONE = ['uploading', 'stalledUP', 'seeding', 'queuedUP'];
  const anyActive = torrents.some(t => !PAUSED.includes(t.state) && !DONE.includes(t.state));
  btn.hidden = false;
  btn.textContent = anyActive ? 'Pause all' : 'Resume all';
  btn.classList.toggle('paused', !anyActive);
  btn.onclick = (e) => { e.stopPropagation(); toggleAllTorrents(anyActive ? 'pause' : 'resume'); };
}

function torrentCard(t) {
  const pct = (t.progress * 100).toFixed(1);
  const paused = ['pausedDL', 'pausedUP', 'stoppedDL', 'stoppedUP'].includes(t.state);
  const errored = ['error', 'missingFiles'].includes(t.state);
  const done = ['uploading', 'stalledUP', 'seeding', 'queuedUP', 'stalledDL'].includes(t.state);
  const stateCls = errored ? 'st-error' : paused ? 'st-paused' : done ? 'st-done' : 'st-active';
  const badgeCls = errored ? 'badge error' : (paused ? 'badge paused' : 'badge');
  const badgeTxt = errored ? 'error' : (paused ? 'paused' : t.state);
  return `<div class="card ${stateCls}">
    <div class="name">${esc(t.name)}<span class="${badgeCls}">${badgeTxt}</span></div>
    <div class="bar"><div style="width:${pct}%"></div></div>
    <div class="meta">
      <span>${pct}% · ${fmtBytes(t.downloaded)} / ${fmtBytes(t.size)}</span>
      <span>${fmtSpeed(t.dlspeed)} · ETA ${fmtEta(t.eta)}</span>
    </div>
    <div class="row">
      <span class="meta">↑ ${fmtSpeed(t.upspeed)}</span>
      <button class="action ${paused ? 'paused' : ''}"
        onclick="toggleTorrent('${t.hash}','${paused ? 'resume' : 'pause'}')">
        ${paused ? 'Resume' : 'Pause'}
      </button>
    </div>
  </div>`;
}

function queueCard(q, kind) {
  const title = kind === 'sonarr'
    ? (q.series?.title ? `${q.series.title} — ${q.title || ''}` : (q.title || 'Unknown'))
    : (q.movie?.title ? `${q.movie.title} (${q.movie.year || ''})` : (q.title || 'Unknown'));
  const size = q.size || 0, left = q.sizeleft || 0;
  const pct = size > 0 ? ((size - left) / size * 100).toFixed(1) : 0;
  const status = q.status || q.trackedDownloadStatus || '';
  const thumb = q.poster
    ? `<img class="thumb" src="${esc(q.poster)}" alt="" loading="lazy" onerror="this.remove()">`
    : '';
  return `<div class="card queue">
    ${thumb}
    <div class="qbody">
      <div class="name">${esc(title)}<span class="badge">${esc(status)}</span></div>
      <div class="bar"><div style="width:${pct}%"></div></div>
      <div class="meta">
        <span>${pct}% · ${fmtBytes(size - left)} / ${fmtBytes(size)}</span>
        <span>${q.timeleft ? 'ETA ' + q.timeleft : ''}</span>
      </div>
    </div>
  </div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function load() {
  try {
    const res = await fetch('/api/status');
    if (res.status === 401) { document.body.innerHTML = '<p style="padding:20px">Login required.</p>'; return; }
    const d = await res.json();

    // errors
    $('errors').innerHTML = (d.errors || []).map(e => `<div class="err">${esc(e)}</div>`).join('');

    // qBittorrent
    if (d.qbittorrent) {
      const { torrents, transfer } = d.qbittorrent;
      $('dl').textContent = fmtSpeed(transfer.dl_info_speed);
      $('up').textContent = fmtSpeed(transfer.up_info_speed);
      const active = torrents.filter(t => !['uploading', 'stalledUP', 'seeding'].includes(t.state));
      const list = active.length ? active : torrents;
      $('qb-count').textContent = `(${torrents.length})`;
      $('torrents').innerHTML = list.length
        ? list.map(torrentCard).join('')
        : '<p class="empty">Nothing downloading.</p>';
      updatePauseAll(torrents);
    } else {
      $('torrents').innerHTML = '<p class="empty">qBittorrent unreachable.</p>';
      $('pause-all').hidden = true;
    }

    // Sonarr
    if (d.sonarr) {
      $('sonarr-count').textContent = `(${d.sonarr.queue.length})`;
      $('sonarr').innerHTML = d.sonarr.queue.length
        ? d.sonarr.queue.map(q => queueCard(q, 'sonarr')).join('')
        : '<p class="empty">Queue empty.</p>';
    } else {
      $('sonarr').innerHTML = '<p class="empty">Sonarr unreachable.</p>';
    }

    // Radarr
    if (d.radarr) {
      $('radarr-count').textContent = `(${d.radarr.queue.length})`;
      $('radarr').innerHTML = d.radarr.queue.length
        ? d.radarr.queue.map(q => queueCard(q, 'radarr')).join('')
        : '<p class="empty">Queue empty.</p>';
    } else {
      $('radarr').innerHTML = '<p class="empty">Radarr unreachable.</p>';
    }

    $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    document.body.classList.add('ready'); // stop card entrance animation on refreshes
  } catch (e) {
    $('errors').innerHTML = `<div class="err">Could not reach dashboard backend: ${esc(e.message)}</div>`;
  }
}

$('refresh').onclick = () => { currentView === 'library' ? loadLibrary(true) : load(); };
$('go').onclick = doSearch;
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
$('tab-series').onclick = () => setTab('series');
$('tab-movie').onclick = () => setTab('movie');
load();
setInterval(load, 5000);

// ---- Collapsible sections (state persists across reloads) ----
document.querySelectorAll('main section[data-section]').forEach(sec => {
  const key = 'mediadash-collapsed-' + sec.dataset.section;
  try {
    if (localStorage.getItem(key) === '1') sec.classList.add('collapsed');
    sec.querySelector('h2').addEventListener('click', () => {
      sec.classList.toggle('collapsed');
      localStorage.setItem(key, sec.classList.contains('collapsed') ? '1' : '0');
    });
  } catch (e) { /* private mode etc. — collapsing still works for the session */ 
    sec.querySelector('h2').addEventListener('click', () => sec.classList.toggle('collapsed'));
  }
});

// ---- Search + add ----
let searchType = 'series';
function setTab(t) {
  searchType = t;
  $('tab-series').classList.toggle('on', t === 'series');
  $('tab-movie').classList.toggle('on', t === 'movie');
  $('results').innerHTML = '';
}

async function doSearch() {
  const q = $('q').value.trim();
  if (!q) return;
  $('results').innerHTML = '<p class="empty">Searching…</p>';
  try {
    const res = await fetch(`/api/search?type=${searchType}&q=${encodeURIComponent(q)}`);
    const items = await res.json();
    if (items.error) throw new Error(items.error);
    $('results').innerHTML = items.length
      ? items.slice(0, 10).map(resultCard).join('')
      : '<p class="empty">No results.</p>';
  } catch (e) {
    $('results').innerHTML = `<p class="empty">Search failed: ${esc(e.message)}</p>`;
  }
}

function resultCard(it) {
  return `<div class="card result">
    ${it.poster ? `<img src="${esc(it.poster)}" alt="" loading="lazy">` : ''}
    <div class="rbody">
      <div class="name">${esc(it.title)}${it.year ? ` <span class="year">(${it.year})</span>` : ''}</div>
      <div class="overview">${esc((it.overview || '').slice(0, 140))}</div>
      <div class="row"><span></span>
        <button class="action" onclick="addItem('${it.type}',${it.id},this)">+ Add</button>
      </div>
    </div>
  </div>`;
}

async function addItem(type, id, btn) {
  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    const res = await fetch('/api/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, id }),
    });
    const d = await res.json();
    if (d.ok) {
      btn.textContent = '✓ Added';
      load();
    } else if (d.alreadyAdded) {
      btn.textContent = '✓ In library';
    } else {
      btn.disabled = false;
      btn.textContent = '+ Add';
      alert('Add failed: ' + d.error);
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '+ Add';
    alert('Add failed: ' + e.message);
  }
}

// ---- View tabs: Dashboard / Library ----
let currentView = 'dashboard';
function switchView(v) {
  currentView = v;
  $('viewbtn-dashboard').classList.toggle('on', v === 'dashboard');
  $('viewbtn-library').classList.toggle('on', v === 'library');
  $('view-dashboard').hidden = v !== 'dashboard';
  $('view-library').hidden = v !== 'library';
  if (v === 'library') loadLibrary();
}
$('viewbtn-dashboard').onclick = () => switchView('dashboard');
$('viewbtn-library').onclick = () => switchView('library');

// ---- Personal library (no Plex) ----
const libTitles = {};
function libFileRow(f) {
  libTitles[f.id] = f.label ? f.label + ' - ' + f.name : f.name;
  const meta = `${fmtBytes(f.size)} · ${f.ext.replace('.', '').toUpperCase()}`;
  if (f.playable) {
    return `<div class="lib-row">
      <div class="lib-info">
        <div class="lib-name">${esc(f.label ? f.label + ' — ' + f.name : f.name)}</div>
        <div class="lib-meta">${meta}</div>
      </div>
      <button class="action small" onclick="playFile(${f.id})">Play</button>
    </div>`;
  }
  return `<div class="lib-row">
    <div class="lib-info">
      <div class="lib-name">${esc(f.label ? f.label + ' — ' + f.name : f.name)}</div>
      <div class="lib-meta">${meta} · converts to MP4 for Safari</div>
    </div>
    <div class="lib-actions">
      <button class="action small" onclick="convertAndPlay(${f.id})">Convert &amp; Play</button>
      <a class="action small dlink" href="/api/stream/${f.id}?download=1">Download</a>
    </div>
  </div>`;
}

function libShowCard(show) {
  const epCount = show.seasons.reduce((n, s) => n + s.episodes.length, 0);
  const seasons = show.seasons.map(s => `
    <div class="season-group">
      <div class="season-label">${esc(s.label)}</div>
      ${s.episodes.map(libFileRow).join('')}
    </div>`).join('');
  return `<div class="card lib-show collapsed">
    <div class="name lib-show-head" onclick="this.parentElement.classList.toggle('collapsed')">${esc(show.name)}<span class="badge">${epCount} ep</span></div>
    <div class="lib-eps">${seasons}</div>
  </div>`;
}

function libMovieCard(movie) {
  return `<div class="card">
    <div class="name">${esc(movie.name)}<span class="badge">${movie.files.length > 1 ? movie.files.length + ' files' : movie.files[0].ext.replace('.', '').toUpperCase()}</span></div>
    ${movie.files.map(libFileRow).join('')}
  </div>`;
}

async function loadLibrary(fresh) {
  const mv = $('lib-movies'), tv = $('lib-tv');
  mv.innerHTML = '<p class="empty">Loading…</p>';
  tv.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const res = await fetch('/api/library' + (fresh ? '?fresh=1' : ''));
    if (res.status === 401) { document.body.innerHTML = '<p style="padding:20px">Login required.</p>'; return; }
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    $('lib-movie-count').textContent = `(${d.movies.length})`;
    $('lib-tv-count').textContent = `(${d.tv.length})`;
    mv.innerHTML = d.movies.length ? d.movies.map(libMovieCard).join('') : '<p class="empty">No movies found.</p>';
    tv.innerHTML = d.tv.length ? d.tv.map(libShowCard).join('') : '<p class="empty">No shows found.</p>';
    $('updated').textContent = 'Library: ' + d.totalFiles + ' files · updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    const msg = `<p class="empty">Library failed: ${esc(e.message)}</p>`;
    mv.innerHTML = msg; tv.innerHTML = msg;
  }
}

// ---- In-browser player ----
function playFile(id) {
  const v = $('player');
  v.src = '/api/stream/' + id;
  $('player-title').textContent = libTitles[id] || 'Playing';
  $('player-overlay').hidden = false;
  v.play().catch(() => {});
}
function closePlayer() {
  clearInterval(convTimer);
  const v = $('player');
  v.pause();
  v.removeAttribute('src');
  v.load();
  $('player-converting').hidden = true;
  v.style.display = '';
  $('player-overlay').hidden = true;
}
$('player-close').onclick = closePlayer;
$('player-overlay').addEventListener('click', e => { if (e.target.id === 'player-overlay') closePlayer(); });

// ---- Convert & Play: MKV (etc.) -> MP4 on the server, then play in Safari ----
let convTimer = null;
function convertAndPlay(id) {
  const title = libTitles[id] || 'Converting';
  showConverting(title, 0, 'Starting…');
  fetch('/api/convert/' + id, { method: 'POST' })
    .then(async res => {
      const d = await res.json().catch(() => ({}));
      if (res.status === 503 && d.error === 'no-ffmpeg') {
        showConverting(title, 0, d.message || 'ffmpeg not found');
        return;
      }
      if (!res.ok || !d.jobId) throw new Error(d.error || 'convert failed to start');
      pollConvert(d.jobId, title);
    })
    .catch(e => showConverting(title, 0, 'Error: ' + e.message));
}
function pollConvert(jobId, title) {
  clearInterval(convTimer);
  convTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/convert/' + jobId + '/status');
      const d = await res.json();
      if (d.state === 'done') {
        clearInterval(convTimer);
        hideConverting();
        const v = $('player');
        v.src = '/api/stream-converted/' + jobId;
        $('player-title').textContent = title;
        $('player-overlay').hidden = false;
        v.play().catch(() => {});
      } else if (d.state === 'error') {
        clearInterval(convTimer);
        showConverting(title, d.percent || 0, 'Error: ' + (d.error || 'conversion failed'));
      } else {
        showConverting(title, d.percent || 0,
          d.state === 'queued' ? 'Waiting — another conversion is running…' : 'Converting… ' + (d.percent || 0) + '%');
      }
    } catch (e) {
      clearInterval(convTimer);
      showConverting(title, 0, 'Error: ' + e.message);
    }
  }, 1000);
}
function showConverting(title, percent, msg) {
  $('player-overlay').hidden = false;
  $('player').style.display = 'none';
  $('player-converting').hidden = false;
  $('player-title').textContent = title;
  $('conv-fill').style.width = Math.min(100, Math.max(0, percent)) + '%';
  $('conv-msg').textContent = msg;
}
function hideConverting() {
  clearInterval(convTimer);
  $('player-converting').hidden = true;
  $('player').style.display = '';
}
