// worker.js — MP3 encoding off the main thread (classic worker).
// Receives Float32 channel data, clamps it to Int16 and feeds lamejs in blocks of 1152 samples.
/* global lamejs */
importScripts('vendor/lamejs/lame.min.js');

const BLOCK = 1152;

self.onmessage = (e) => {
  const { id, channels, sampleRate, kbps } = e.data;
  try {
    const blob = encode(id, channels, sampleRate, kbps);
    self.postMessage({ type: 'done', id, blob });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String((err && err.message) || err) });
  }
};

function toInt16(src, start, end, dst) {
  for (let i = start, j = 0; i < end; i++, j++) {
    const s = src[i];
    // Clamp to [-1, 1] so loud or float sources never wrap around into clicks.
    dst[j] = s >= 1 ? 32767 : s <= -1 ? -32768 : (s < 0 ? s * 32768 : s * 32767) | 0;
  }
}

function encode(id, channels, sampleRate, kbps) {
  const count = channels.length;
  const length = channels[0].length;
  const encoder = new lamejs.Mp3Encoder(count, sampleRate, kbps);
  const left = new Int16Array(BLOCK);
  const right = count > 1 ? new Int16Array(BLOCK) : null;
  const chunks = [];
  let lastPost = 0;

  for (let start = 0; start < length; start += BLOCK) {
    const end = Math.min(start + BLOCK, length);
    const n = end - start;
    toInt16(channels[0], start, end, left);
    if (right) toInt16(channels[1], start, end, right);
    const l = n === BLOCK ? left : left.subarray(0, n);
    const r = right ? (n === BLOCK ? right : right.subarray(0, n)) : undefined;
    const out = right ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l);
    if (out.length) chunks.push(out);
    // Progress after each block, throttled so very long files do not flood the main thread.
    const now = Date.now();
    if (now - lastPost > 60) {
      lastPost = now;
      self.postMessage({ type: 'progress', id, progress: end / length });
    }
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(tail);
  self.postMessage({ type: 'progress', id, progress: 1 });
  return new Blob(chunks, { type: 'audio/mpeg' });
}
