#!/usr/bin/env node
// Put a voice take through the telephone, so a line recorded today sits next to Jane Barbe's
// clips as if it came off the same drum: a 300 to 3400 Hz band, mono, 22 kHz, a touch of
// compression, a whisper of hiss. Writes the mp3 the phone plays (assets/audio/).
//
//   node tools/phone_voice.mjs TAKE.mp3 assets/audio/intercept_international.mp3 [--hiss 0.004] [--gain 1.5]
//
// Needs ffmpeg: on the PATH, or `npm install --no-save ffmpeg-static` once (a static build).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const files = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
const [input, output] = files;
if (!input || !output) { console.error('usage: node tools/phone_voice.mjs TAKE OUT.mp3 [--hiss 0.004] [--gain 1.5]'); process.exit(2); }
const hiss = Number(opt('hiss', 0.004)), gain = Number(opt('gain', 1.5));

let ffmpeg = 'ffmpeg';
try { const p = createRequire(import.meta.url)('ffmpeg-static'); if (p && existsSync(p)) ffmpeg = p; } catch (e) { /* the PATH's, then */ }

// the voice: band-limited, evened out, lifted; the hiss: filtered noise mixed in under it
const filter = [
  `[0:a]highpass=f=300,lowpass=f=3400,acompressor=threshold=-18dB:ratio=3:attack=5:release=80,volume=${gain},aformat=channel_layouts=mono[v]`,
  `anoisesrc=color=pink:amplitude=${hiss}:seed=7[n0]`,
  `[n0]highpass=f=300,lowpass=f=3400,aformat=channel_layouts=mono[n]`,
  `[v][n]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[out]`,
].join(';');
const r = spawnSync(ffmpeg, ['-y', '-v', 'error', '-i', input, '-filter_complex', filter, '-map', '[out]', '-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '48k', output], { stdio: 'inherit' });
if (r.error) { console.error(`${ffmpeg}: ${r.error.message}. Install ffmpeg, or run: npm install --no-save ffmpeg-static`); process.exit(1); }
if (r.status) process.exit(r.status);
console.log(`${input} -> ${output}: through the telephone`);
