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

function torrentCard(t) {
  const pct = (t.progress * 100).toFixed(1);
  const paused = ['pausedDL', 'pausedUP', 'stoppedDL', 'stoppedUP'].includes(t.state);
  const errored = ['error', 'missingFiles'].includes(t.state);
  const badgeCls = errored ? 'badge error' : (paused ? 'badge paused' : 'badge');
  const badgeTxt = errored ? 'error' : (paused ? 'paused' : t.state);
  return `<div class="card">
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
  return `<div class="card">
    <div class="name">${esc(title)}<span class="badge">${esc(status)}</span></div>
    <div class="bar"><div style="width:${pct}%"></div></div>
    <div class="meta">
      <span>${pct}% · ${fmtBytes(size - left)} / ${fmtBytes(size)}</span>
      <span>${q.timeleft ? 'ETA ' + q.timeleft : ''}</span>
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
    } else {
      $('torrents').innerHTML = '<p class="empty">qBittorrent unreachable.</p>';
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
  } catch (e) {
    $('errors').innerHTML = `<div class="err">Could not reach dashboard backend: ${esc(e.message)}</div>`;
  }
}

$('refresh').onclick = load;
$('go').onclick = doSearch;
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
$('tab-series').onclick = () => setTab('series');
$('tab-movie').onclick = () => setTab('movie');
load();
setInterval(load, 5000);

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
