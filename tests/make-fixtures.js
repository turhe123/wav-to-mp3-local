// make-fixtures.js — generates tests/fixtures/sample.wav: a fictional two second piano-like arpeggio,
// 44.1 kHz, 16 bit, stereo (about 350 KB) so the MP3 size reduction is obvious.
// Run with: node tests/make-fixtures.js
const fs = require('fs');
const path = require('path');

const rate = 44100;
const seconds = 2;
const frames = rate * seconds;
const left = new Float32Array(frames);
const right = new Float32Array(frames);

// C major arpeggio up and back down, one note every 0.22 s.
const notes = [261.63, 329.63, 392.0, 523.25, 659.25, 783.99, 659.25, 523.25, 392.0];
notes.forEach((freq, i) => {
  const start = Math.round(i * 0.22 * rate);
  const pan = 0.25 + 0.5 * (i / (notes.length - 1)); // drift from left to right
  for (let n = start; n < frames; n++) {
    const t = (n - start) / rate;
    const env = Math.min(1, t * 400) * Math.exp(-3.2 * t); // fast attack, piano-like decay
    let s = 0;
    for (let h = 1; h <= 5; h++) {
      const inharm = 1 + 0.0004 * h * h; // slightly stretched partials like a real string
      s += Math.sin(2 * Math.PI * freq * h * inharm * t) * Math.exp(-0.9 * h * t) / (h * h);
    }
    s *= env * 0.6;
    left[n] += s * (1 - pan);
    right[n] += s * pan;
  }
});

const dataBytes = frames * 2 * 2;
const buf = Buffer.alloc(44 + dataBytes);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
const clamp = (v) => Math.max(-1, Math.min(1, v));
for (let n = 0; n < frames; n++) {
  buf.writeInt16LE(Math.round(clamp(left[n]) * 32767), 44 + n * 4);
  buf.writeInt16LE(Math.round(clamp(right[n]) * 32767), 46 + n * 4);
}
const out = path.join(__dirname, 'fixtures', 'sample.wav');
fs.writeFileSync(out, buf);
console.log(`wrote ${out} (${buf.length} bytes)`);
