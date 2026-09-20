// MediaDash on-the-fly conversion: MKV (and friends) -> MP4 for iPhone Safari.
//
// Remux-first: when the video codec is already h264/hevc and the audio is a
// format Safari understands, we just copy both streams into an MP4 container
// (fast, zero quality loss, low CPU). Otherwise we re-encode video to h264
// and/or audio to AAC. Output lands in a cache dir keyed on the source
// file's mtime+size, so repeat plays skip conversion entirely.
//
// Requires ffmpeg + ffprobe: config `ffmpegPath`/`ffprobePath` first, else
// whatever is on PATH. Only one conversion runs at a time (laptop CPU).

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NO_FFMPEG_MSG =
  'ffmpeg not found \u2014 download a portable build (e.g. gyan.dev), unzip it, ' +
  'and set ffmpegPath/ffprobePath in config.json (no admin needed)';

// Video codecs Safari plays inside an MP4 container.
const NATIVE_VIDEO = new Set(['h264', 'hevc', 'avc']);
// Audio codecs browsers actually play inside an MP4 container. AC-3/E-AC-3
// decode fine in native players (VLC, Movies & TV) but are SILENT in every
// browser, so we re-encode those to AAC instead of copying.
const NATIVE_AUDIO = new Set(['aac', 'mp3']);

function resolveTool(config, key, fallbackName) {
  const candidates = [];
  if (config && config[key]) candidates.push(config[key]);
  candidates.push(fallbackName);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-version'], { stdio: 'ignore', timeout: 8000, windowsHide: true });
      if (r && r.status === 0) return c;
    } catch (e) { /* try next candidate */ }
  }
  return null;
}

function ffmpegBin(config) { return resolveTool(config, 'ffmpegPath', 'ffmpeg'); }
function ffprobeBin(config) { return resolveTool(config, 'ffprobePath', 'ffprobe'); }
function toolsAvailable(config) { return !!(ffmpegBin(config) && ffprobeBin(config)); }

function transcodeDir(config) {
  const d = (config && config.transcodeDir) || path.join(__dirname, 'transcode-cache');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* best effort */ }
  return d;
}

function cacheKey(absPath) {
  const st = fs.statSync(absPath);
  return crypto.createHash('sha1')
    .update('v4|' + absPath + '|' + st.mtimeMs + '|' + st.size)
    .digest('hex');
}

function probe(config, absPath) {
  return new Promise((resolve, reject) => {
    const bin = ffprobeBin(config);
    const p = spawn(bin,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', absPath],
      { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) return reject(new Error('ffprobe failed: ' + err.trim().slice(0, 200)));
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error('ffprobe returned invalid JSON')); }
    });
  });
}

function durationMs(info) {
  const d = Number(info && info.format && info.format.duration);
  return (Number.isFinite(d) && d > 0) ? d * 1000 : 0;
}

// Returns ffmpeg args with INPUT/OUTPUT placeholders filled by the caller.
function buildArgs(info, src, out) {
  const streams = (info && info.streams) || [];
  const v = streams.find(s => s.codec_type === 'video');
  const a = streams.find(s => s.codec_type === 'audio');
  const vCodec = String(v && v.codec_name || '').toLowerCase();
  const aCodec = String(a && a.codec_name || '').toLowerCase();

  const args = ['-y', '-progress', 'pipe:1', '-nostats', '-i', src];
  // Map the exact streams we probed. Without this, ffmpeg's default stream
  // selection can pick a different audio track than the one we inspected
  // (e.g. a 5.1 DTS track instead of the stereo AAC one), producing an MP4
  // that's silent in browsers but plays fine in native players.
  if (v && v.index != null) args.push('-map', '0:' + v.index);
  if (a && a.index != null) args.push('-map', '0:' + a.index);
  if (v && NATIVE_VIDEO.has(vCodec)) args.push('-c:v', 'copy');
  else args.push('-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast');
  if (a) {
    if (NATIVE_AUDIO.has(aCodec)) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '160k');
  }
  // Drop subtitles: simple, and avoids players choking on embedded subs.
  args.push('-sn', '-movflags', '+faststart', '-f', 'mp4', out);
  return args;
}

// ---- Job bookkeeping ----
const jobs = new Map(); // jobId -> job
const queue = [];
let activeId = null;

function jobPublic(j) {
  return { jobId: j.id, state: j.state, percent: j.percent, error: j.error, title: j.title };
}

function outNameFor(title) {
  return String(title).replace(/\.[^.]+$/, '') + '.mp4';
}

async function startJob(config, file) {
  // file: library record ({ id, name, _path })
  for (const j of jobs.values()) {
    if (j.fileId !== file.id) continue;
    if (j.state === 'done' && !fs.existsSync(j.outPath)) { jobs.delete(j.id); continue; }
    if (j.state === 'queued' || j.state === 'converting' || j.state === 'done') return j;
  }
  const dir = transcodeDir(config);
  const outPath = path.join(dir, cacheKey(file._path) + '.mp4');
  const job = {
    id: crypto.randomBytes(8).toString('hex'),
    fileId: file.id,
    title: file.name,
    srcPath: file._path,
    outPath,
    state: 'queued',
    percent: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
  if (fs.existsSync(outPath)) {
    job.state = 'done';
    job.percent = 100;
    job.finishedAt = Date.now();
    jobs.set(job.id, job);
    return job;
  }
  jobs.set(job.id, job);
  queue.push(job.id);
  pump(config);
  return job;
}

function getJob(id) {
  return jobs.get(String(id)) || null;
}

function pump(config) {
  if (activeId) return;
  const id = queue.shift();
  if (!id) return;
  const job = jobs.get(id);
  if (!job) { pump(config); return; }
  activeId = id;
  runJob(config, job).catch(e => {
    job.state = 'error';
    job.error = String((e && e.message) || e).slice(0, 300);
    job.finishedAt = Date.now();
  }).finally(() => {
    activeId = null;
    pump(config);
  });
}

function runJob(config, job) {
  return new Promise(async (resolve, reject) => {
    job.state = 'converting';
    job.startedAt = Date.now();
    let info;
    try {
      info = await probe(config, job.srcPath);
    } catch (e) { return reject(e); }
    const total = durationMs(info);
    const args = buildArgs(info, job.srcPath, job.outPath);
    const trackList = ((info && info.streams) || [])
      .map(s => `${s.codec_type}:${s.codec_name}${s.channels ? '/' + s.channels + 'ch' : ''}`)
      .join(', ');
    console.log(`[transcode] "${job.title}" tracks=[${trackList}]`);
    const bin = ffmpegBin(config);
    const p = spawn(bin, args, { windowsHide: true });
    let errTail = '';
    let sawEnd = false;

    p.stdout.on('data', d => {
      const text = d.toString();
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t.startsWith('out_time_ms=')) {
          // ffmpeg reports this in microseconds despite the name
          const ms = Number(t.slice('out_time_ms='.length)) / 1000;
          if (total > 0 && Number.isFinite(ms) && ms >= 0) {
            job.percent = Math.min(99, Math.round((ms / total) * 100));
          }
        } else if (t === 'progress=end') {
          sawEnd = true;
        }
      }
    });
    p.stderr.on('data', d => {
      errTail = (errTail + d.toString()).slice(-2000);
    });
    p.on('error', e => {
      try { fs.unlinkSync(job.outPath); } catch (x) { /* ignore */ }
      reject(e);
    });
    p.on('close', code => {
      if (code === 0 && (sawEnd || fs.existsSync(job.outPath))) {
        job.state = 'done';
        job.percent = 100;
        job.finishedAt = Date.now();
        return resolve();
      }
      try { fs.unlinkSync(job.outPath); } catch (x) { /* ignore */ }
      reject(new Error('ffmpeg exited with code ' + code +
        (errTail ? ': ' + errTail.trim().split('\n').slice(-3).join(' | ').slice(0, 250) : '')));
    });
  });
}

module.exports = {
  NO_FFMPEG_MSG,
  toolsAvailable,
  ffmpegBin,
  ffprobeBin,
  transcodeDir,
  startJob,
  getJob,
  jobPublic,
  outNameFor,
  buildArgs,   // exported for tests
  probe,       // exported for tests
};
