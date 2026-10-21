// app.js — WAV to MP3 Converter (ES module). Everything runs on the device; no network requests.
// Flow per file: ArrayBuffer -> decodeAudioData in an OfflineAudioContext at the target sample rate
// (the browser resamples while decoding) -> channel mix -> worker.js (lamejs, 1152-sample blocks) -> Blob.
/* global fflate */
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';

const zone = document.getElementById('dropzone');
const input = document.getElementById('file-input');
const results = document.getElementById('results');
const convertBtn = document.getElementById('convert');
const zipBtn = document.getElementById('download-zip');
const clearBtn = document.getElementById('clear');
const emptyState = document.getElementById('empty-state');
const bitrateSel = document.getElementById('bitrate');
const channelsSel = document.getElementById('channels');
const rateSel = document.getElementById('samplerate');

const MAX_BYTES = 500 * 1024 * 1024;
const AUDIO_EXT = ['wav', 'wave', 'flac', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'mp3', 'aif', 'aiff', 'webm', 'caf'];
const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

/** @type {Array<{id:number,file:File,outName:string,status:string,el:HTMLElement,url?:string,blob?:Blob,key?:string,duration?:number}>} */
let items = [];
let nextId = 1;
let running = false;
let worker = null;
let errorBox = null;
let listEl = null;

// ---------- helpers ----------
const ext = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const baseName = (name) => (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name) || 'audio';

function isAudio(file) {
  return (file.type && file.type.startsWith('audio/')) || AUDIO_EXT.includes(ext(file.name));
}

function uniqueName(base) {
  const used = new Set(items.map((it) => it.outName.toLowerCase()));
  let name = `${base}.mp3`;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}-${n}.mp3`;
  return name;
}

function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

// Saving rounded down to one decimal so 99.96% reads 99.9%, never an untrue 100%.
function savingText(orig, out) {
  if (!orig) return '';
  const pct = (1 - out / orig) * 100;
  if (pct >= 0) return `${(Math.floor(pct * 10) / 10).toFixed(1)}% smaller`;
  return `${(Math.ceil(-pct * 10) / 10).toFixed(1)}% larger`;
}

function settings() {
  return { kbps: Number(bitrateSel.value), channels: channelsSel.value, rate: rateSel.value };
}
const settingsKey = (s) => `${s.kbps}|${s.channels}|${s.rate}`;

function supportedRate(rate) {
  if (MP3_RATES.includes(rate)) return rate;
  if (rate < MP3_RATES[0]) return MP3_RATES[0];
  return MP3_RATES.find((r) => r >= rate) || 48000;
}

// Read the source sample rate from the file header so "Keep source" really keeps it.
// Returns 0 when unknown (we then fall back to 44,100 Hz).
function sniffRate(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  const str = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  try {
    if ((str(0, 4) === 'RIFF' || str(0, 4) === 'RF64') && str(8, 4) === 'WAVE') {
      for (let o = 12; o + 8 <= b.length;) {
        const size = dv.getUint32(o + 4, true);
        if (str(o, 4) === 'fmt ') return dv.getUint32(o + 12, true);
        o += 8 + size + (size & 1);
      }
    }
    if (str(0, 4) === 'fLaC') return (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
    if (str(0, 4) === 'FORM' && (str(8, 4) === 'AIFF' || str(8, 4) === 'AIFC')) return 0; // browser decodes at its own rate
    if (str(0, 4) === 'OggS') {
      const head = str(0, Math.min(b.length, 4096));
      if (head.includes('OpusHead')) return 48000;
      const v = head.indexOf('\x01vorbis');
      if (v >= 0) return dv.getUint32(v + 12, true);
    }
    if (str(4, 4) === 'ftyp') {
      const mp4a = findBytes(b, 'mp4a');
      return mp4a > 0 ? dv.getUint16(mp4a + 28) : 0;
    }
    // MP3: skip an ID3v2 tag, then read the first frame header.
    let o = 0;
    if (str(0, 3) === 'ID3') o = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
    for (const end = Math.min(b.length - 4, o + 65536); o < end; o++) {
      if (b[o] === 0xff && (b[o + 1] & 0xe0) === 0xe0) {
        const ver = (b[o + 1] >> 3) & 3;
        const layer = (b[o + 1] >> 1) & 3;
        const idx = (b[o + 2] >> 2) & 3;
        if (ver === 1 || idx === 3) continue;
        if (layer === 0) return [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000][(b[o + 2] >> 2) & 15] || 0; // AAC ADTS
        const base = [44100, 48000, 32000][idx];
        return ver === 3 ? base : ver === 2 ? base / 2 : base / 4;
      }
    }
  } catch { /* malformed header: fall through */ }
  return 0;
}

function findBytes(b, text) {
  const c = [...text].map((ch) => ch.charCodeAt(0));
  for (let i = 0, end = b.length - c.length; i < end; i++) {
    if (b[i] === c[0] && b[i + 1] === c[1] && b[i + 2] === c[2] && b[i + 3] === c[3]) return i;
  }
  return -1;
}

// ---------- DOM ----------
const ICONS = {
  pending: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  working: '<span class="spinner" aria-hidden="true"></span>',
  done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.5 17 19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v6m0 4h.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
};
const STATUS_LABEL = { pending: 'Waiting', working: 'Converting', done: 'Converted', error: 'Failed' };

function ensureList() {
  if (!listEl || !listEl.isConnected) {
    listEl = document.createElement('ul');
    listEl.className = 'file-list';
    listEl.setAttribute('aria-label', 'Files to convert');
    results.appendChild(listEl);
  }
  return listEl;
}

function showErrors(messages) {
  if (errorBox) errorBox.remove();
  errorBox = null;
  if (!messages.length) return;
  errorBox = document.createElement('div');
  errorBox.className = 'alert alert--error';
  errorBox.setAttribute('role', 'alert');
  if (messages.length === 1) errorBox.textContent = messages[0];
  else {
    const ul = document.createElement('ul');
    for (const m of messages) { const li = document.createElement('li'); li.textContent = m; ul.appendChild(li); }
    errorBox.append('Some files were skipped:', ul);
  }
  results.prepend(errorBox);
}

function createRow(item) {
  const li = document.createElement('li');
  li.className = 'result conv-row';
  li.tabIndex = 0;
  li.dataset.id = item.id;
  li.innerHTML = `
    <span class="conv-row__icon" role="img"></span>
    <div class="result__meta">
      <div class="result__name"></div>
      <div class="result__info"></div>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>
      <p class="conv-row__error alert alert--error" hidden></p>
    </div>
    <div class="conv-row__actions">
      <a class="btn btn--small btn--primary conv-row__download" hidden></a>
      <button class="btn btn--small btn--ghost conv-row__remove" type="button"></button>
    </div>`;
  const name = li.querySelector('.result__name');
  name.textContent = item.file.name;
  name.title = item.file.name;
  li.querySelector('.progress').setAttribute('aria-label', `Progress for ${item.file.name}`);
  const rm = li.querySelector('.conv-row__remove');
  rm.textContent = '✕';
  rm.setAttribute('aria-label', `Remove ${item.file.name}`);
  rm.title = 'Remove';
  rm.addEventListener('click', () => removeItem(item));
  item.el = li;
  setStatus(item, item.status);
  ensureList().appendChild(li);
}

function setStatus(item, status, message) {
  item.status = status;
  const el = item.el;
  el.dataset.status = status;
  const icon = el.querySelector('.conv-row__icon');
  icon.innerHTML = ICONS[status];
  icon.setAttribute('aria-label', STATUS_LABEL[status]);
  const err = el.querySelector('.conv-row__error');
  err.hidden = status !== 'error';
  err.textContent = status === 'error' ? message || 'Could not convert this file.' : '';
  el.querySelector('.progress').hidden = status === 'error' || status === 'done';
  const info = el.querySelector('.result__info');
  if (status === 'pending') info.textContent = `${formatBytes(item.file.size)} · waiting → ${item.outName}`;
  if (status === 'error') info.textContent = formatBytes(item.file.size);
}

function setProgress(item, frac, text) {
  const bar = item.el.querySelector('.progress');
  const pct = Math.max(0, Math.min(100, frac * 100));
  bar.firstElementChild.style.width = `${pct}%`;
  bar.setAttribute('aria-valuenow', String(Math.floor(pct)));
  if (text) item.el.querySelector('.result__info').textContent = text;
}

function showResult(item, blob, meta) {
  if (item.url) URL.revokeObjectURL(item.url);
  item.blob = blob;
  item.url = URL.createObjectURL(blob);
  item.duration = meta.duration;
  setStatus(item, 'done');
  const info = item.el.querySelector('.result__info');
  info.innerHTML = '';
  const parts = [
    ['Original', formatBytes(item.file.size), 'conv-orig'],
    ['MP3', formatBytes(blob.size), 'conv-new'],
    ['Saving', savingText(item.file.size, blob.size), 'conv-saving'],
    ['Length', formatDuration(meta.duration), 'conv-duration'],
  ];
  for (const [label, value, cls] of parts) {
    const span = document.createElement('span');
    span.className = `stat ${cls}${cls === 'conv-saving' && blob.size < item.file.size ? ' stat--ok' : ''}`;
    span.textContent = `${label} ${value}`;
    info.appendChild(span);
  }
  const extra = document.createElement('span');
  extra.className = 'stat conv-format';
  extra.textContent = `${meta.kbps} kbps · ${meta.channels === 1 ? 'mono' : 'stereo'} · ${meta.rate.toLocaleString('en-US')} Hz`;
  info.appendChild(extra);
  const a = item.el.querySelector('.conv-row__download');
  a.href = item.url;
  a.download = item.outName;
  a.textContent = `Download ${item.outName}`;
  a.hidden = false;
}

function refreshControls() {
  const has = items.length > 0;
  emptyState.hidden = has;
  clearBtn.hidden = !has;
  const key = settingsKey(settings());
  const todo = items.some((it) => it.status === 'pending' || (it.status === 'done' && it.key !== key));
  convertBtn.disabled = running || !todo;
  convertBtn.textContent = running ? 'Converting…' : items.some((it) => it.status === 'done') && todo ? 'Convert again with these settings' : 'Convert to MP3';
  const done = items.filter((it) => it.status === 'done');
  zipBtn.hidden = done.length < 2;
  zipBtn.textContent = `Download all as ZIP (${done.length} files)`;
  zipBtn.disabled = running;
  if (!has && listEl) { listEl.remove(); listEl = null; }
}

// ---------- file handling ----------
function handleFiles(files) {
  const errors = [];
  for (const file of files) {
    if (!isAudio(file)) {
      errors.push(`"${file.name}" is not an audio file. Add WAV, FLAC, M4A, OGG, AAC or MP3 files.`);
      continue;
    }
    const item = { id: nextId++, file, outName: uniqueName(baseName(file.name)), status: 'pending' };
    items.push(item);
    createRow(item);
    if (file.size > MAX_BYTES) {
      setStatus(item, 'error', `This file is ${formatBytes(file.size)}. The limit is about 500 MB per file, because decoding expands audio several times in memory. Split it into shorter parts first.`);
    }
  }
  showErrors(errors);
  refreshControls();
  const added = files.length - errors.length;
  if (added > 0) toast(`${added} file${added === 1 ? '' : 's'} added. Nothing was uploaded.`);
  (errorBox || results.querySelector('.result'))?.scrollIntoView({ block: 'nearest' });
}

function removeItem(item) {
  if (item.status === 'working' && worker) {
    // Stop the encode in progress; the queue moves on to the next file.
    worker.terminate();
    worker = null;
    item.cancel?.();
  }
  if (item.url) URL.revokeObjectURL(item.url);
  const idx = items.indexOf(item);
  if (idx >= 0) items.splice(idx, 1);
  const next = item.el.nextElementSibling || item.el.previousElementSibling;
  item.el.remove();
  refreshControls();
  if (next) next.focus();
  else zone.focus();
}

function clearAll() {
  for (const it of [...items]) removeItem(it);
  showErrors([]);
  refreshControls();
}

// ---------- conversion ----------
function getWorker() {
  if (!worker) worker = new Worker('./worker.js');
  return worker;
}

function encodeInWorker(item, channels, sampleRate, kbps, onProgress) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    item.cancel = () => reject(new Error('cancelled'));
    w.onmessage = (e) => {
      const m = e.data;
      if (m.id !== item.id) return;
      if (m.type === 'progress') onProgress(m.progress);
      else if (m.type === 'done') resolve(m.blob);
      else reject(new Error(m.message));
    };
    w.onerror = (e) => { e.preventDefault(); reject(new Error(e.message || 'The encoder stopped unexpectedly.')); };
    w.postMessage({ id: item.id, channels, sampleRate, kbps }, channels.map((c) => c.buffer));
  });
}

function codecMessage(file) {
  const e = ext(file.name).toUpperCase() || 'this';
  return `Your browser cannot decode ${e} audio, or the file is damaged. Try another browser (Chrome and Firefox read FLAC and OGG, Safari reads M4A and AAC).`;
}

async function convertItem(item, opts) {
  setStatus(item, 'working');
  setProgress(item, 0, 'Reading…');
  const buf = await item.file.arrayBuffer();
  const srcRate = sniffRate(buf);
  const rate = supportedRate(opts.rate === 'keep' ? srcRate || 44100 : Number(opts.rate));

  setProgress(item, 0.02, 'Decoding…');
  let audio;
  try {
    // Created here, after the user pressed Convert, which also keeps Safari happy.
    const ctx = new OfflineAudioContext(1, 1, rate);
    audio = await ctx.decodeAudioData(buf);
  } catch {
    throw new Error(codecMessage(item.file));
  }
  if (!audio || !audio.length) throw new Error('This file contains no audio.');

  const srcCh = audio.numberOfChannels;
  const outCh = opts.channels === 'mono' ? 1 : opts.channels === 'stereo' ? 2 : Math.min(srcCh, 2);
  let channels;
  if (outCh === 1) {
    const mix = new Float32Array(audio.length);
    for (let c = 0; c < srcCh; c++) {
      const d = audio.getChannelData(c);
      for (let i = 0; i < d.length; i++) mix[i] += d[i] / srcCh;
    }
    channels = [mix];
  } else {
    const l = audio.getChannelData(0).slice();
    const r = srcCh > 1 ? audio.getChannelData(1).slice() : l.slice();
    channels = [l, r];
  }
  const duration = audio.duration;
  audio = null; // let the decoded buffer go before encoding

  const started = performance.now();
  const blob = await encodeInWorker(item, channels, rate, opts.kbps, (p) => {
    const frac = 0.05 + p * 0.95;
    let text = `Encoding ${Math.floor(p * 100)}% · ${formatDuration(duration)} of audio`;
    const elapsed = (performance.now() - started) / 1000;
    if (p > 0.02 && elapsed > 1.5) {
      const left = Math.ceil((elapsed / p) * (1 - p));
      text += ` · about ${left < 60 ? `${left} s` : `${Math.ceil(left / 60)} min`} left`;
    }
    setProgress(item, frac, text);
  });
  return { blob, meta: { duration, kbps: opts.kbps, channels: outCh, rate } };
}

async function convertAll() {
  if (running) return;
  const opts = settings();
  const key = settingsKey(opts);
  const queue = items.filter((it) => it.status === 'pending' || (it.status === 'done' && it.key !== key));
  if (!queue.length) return;
  running = true;
  refreshControls();
  let first = true;
  // One file at a time keeps memory use to a single decoded file.
  for (const item of queue) {
    if (!items.includes(item)) continue;
    try {
      const { blob, meta } = await convertItem(item, opts);
      if (!items.includes(item)) continue;
      item.key = key;
      showResult(item, blob, meta);
      if (first) { item.el.scrollIntoView({ block: 'nearest' }); first = false; }
    } catch (err) {
      if (!items.includes(item) || err.message === 'cancelled') continue;
      setStatus(item, 'error', err.message);
    }
    refreshControls();
  }
  running = false;
  refreshControls();
  const ok = queue.filter((it) => it.status === 'done' && items.includes(it)).length;
  if (ok) toast(`${ok} MP3 file${ok === 1 ? '' : 's'} ready.`);
}

async function downloadZip() {
  const done = items.filter((it) => it.status === 'done' && it.blob);
  if (!done.length) return;
  const files = {};
  for (const it of done) files[it.outName] = [new Uint8Array(await it.blob.arrayBuffer()), { level: 0 }];
  // Store mode: MP3 is already compressed, deflating it again only costs time.
  const zip = fflate.zipSync(files, { level: 0 });
  downloadBlob(new Blob([zip], { type: 'application/zip' }), 'mp3-files.zip');
}

// ---------- wiring ----------
wireDropzone(zone, input, handleFiles);
convertBtn.addEventListener('click', convertAll);
zipBtn.addEventListener('click', () => downloadZip().catch((err) => showErrors([`Could not build the ZIP: ${err.message}`])));
clearBtn.addEventListener('click', clearAll);
[bitrateSel, channelsSel, rateSel].forEach((s) => s.addEventListener('change', refreshControls));

document.addEventListener('keydown', (e) => {
  const t = e.target;
  const row = t instanceof Element ? t.closest('.conv-row') : null;
  if (e.key === 'Delete' && row && t === row) {
    e.preventDefault();
    const item = items.find((it) => it.el === row);
    if (item) removeItem(item);
    return;
  }
  if (e.key === 'Enter' && !e.isComposing) {
    const interactive = t instanceof Element && t.closest('button, a, input, textarea, .dropzone, summary');
    if (interactive || !t.closest?.('#tool') && t !== document.body) return;
    e.preventDefault();
    if (!convertBtn.disabled) convertAll();
  }
});

refreshControls();

// Called by the factory's screenshot script to show the tool in a realistic, fictional state.
window.__demo = async () => {
  const res = await fetch('./tests/fixtures/sample.wav');
  const blob = await res.blob();
  handleFiles([new File([blob], 'piano-arpeggio.wav', { type: 'audio/wav' })]);
  await convertAll();
};

export { handleFiles, convertAll };
