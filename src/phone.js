import { formatTime } from './state.js';

// The pay phone. Lift the receiver: dial tone. Dial a number on the keypad, or pick one from the
// phone book, which dials it for you. Most numbers are not in service and get an intercept (the
// three SIT tones, then the phone company's line); a few work: the time and temperature, an
// answering machine you can leave a message on (functions/api/voicemail.js), a recording.
//
// The numbers and what they reach are in assets/audio/numbers.json: a phone book (what the
// directory lists), a map of numbers to outcomes, and the intercepts. Where an entry names an
// audio file in assets/audio/ it is played; where there is none yet, the panel shows the
// transcript and the tones carry the call, so the phone works before any voice has been
// recorded. The voice of the intercepts and the time line is meant to be Jane Barbe's, from a
// collector's recording (README, "The pay phone's voice"); the tones are made here, since they
// are signals, not art.
//
// Nothing makes a sound until the receiver is lifted, and everything is quiet.
const MANIFEST = new URL('../assets/audio/numbers.json', import.meta.url);
const AUDIO = new URL('../assets/audio/', import.meta.url);
const API = 'api/voicemail';
export const MESSAGE_MAX = 120;

let manifest = { book: [], numbers: {}, intercepts: {} };
export const phoneBook = () => manifest.book;
export async function loadPhoneBook() {
  try { const r = await fetch(MANIFEST); if (r.ok) manifest = { ...manifest, ...(await r.json()) }; } catch (e) { /* the phone still dials */ }
  return manifest;
}
export const digitsOf = (s) => String(s ?? '').replace(/\D/g, '');
export function formatNumber(d) {
  d = digitsOf(d);
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.startsWith('011') && d.length > 8) return '011-' + d.slice(3).replace(/(\d{4})$/, '-$1').replace(/^(\d{1,3})(\d{1,3})-/, '$1-$2-');   // 011-36-1-555-0160, near enough
  return d;
}

// --- the sounds: dial tone, touch tones, the SIT, ringback, busy, the beep. Pure tones, quiet.
const GAIN = 0.06;
const DTMF = { 1: [697, 1209], 2: [697, 1336], 3: [697, 1477], 4: [770, 1209], 5: [770, 1336], 6: [770, 1477], 7: [852, 1209], 8: [852, 1336], 9: [852, 1477], '*': [941, 1209], 0: [941, 1336], '#': [941, 1477] };
class Sounds {
  constructor() { this.ctx = null; this.playing = []; }
  ensure() {
    if (!this.ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) this.ctx = new AC(); }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  // a set of sine tones from t0 for dur seconds (dur null: until stopped); returns a stop()
  tones(freqs, dur, gain = GAIN, t0 = 0) {
    const ctx = this.ensure(); if (!ctx) return () => {};
    const g = ctx.createGain(); g.gain.value = 0; g.connect(ctx.destination);
    const start = ctx.currentTime + t0;
    g.gain.setValueAtTime(0, start); g.gain.linearRampToValueAtTime(gain / freqs.length, start + 0.01);
    const oscs = freqs.map((f) => { const o = ctx.createOscillator(); o.frequency.value = f; o.connect(g); o.start(start); return o; });
    const stop = (at = ctx.currentTime) => { try { g.gain.cancelScheduledValues(at); g.gain.setValueAtTime(g.gain.value, at); g.gain.linearRampToValueAtTime(0, at + 0.02); oscs.forEach((o) => o.stop(at + 0.03)); } catch (e) { /* already stopped */ } };
    if (dur != null) stop(start + dur);
    const h = { stop }; this.playing.push(h);
    return () => stop();
  }
  stopAll() { for (const h of this.playing) h.stop(); this.playing = []; }
  dialTone() { return this.tones([350, 440], null); }
  dtmf(d) { if (DTMF[d]) this.tones(DTMF[d], 0.12, GAIN * 1.2); }
  sit() { [950, 1400, 1800].forEach((f, i) => this.tones([f], 0.33, GAIN, i * 0.33)); return 1.0; }   // seconds it takes
  // ringback by country: North America 2 s on 4 s off; much of Europe a single 425 Hz, 1 s on
  // 4 s off; Britain's double ring. Returns the seconds until the last ring ends.
  ringback(cycles, style = 'us') {
    if (style === 'eu') { for (let i = 0; i < cycles; i++) this.tones([425], 1, GAIN * 0.8, i * 5); return cycles * 5 - 4; }
    if (style === 'uk') { for (let i = 0; i < cycles; i++) { this.tones([400, 450], 0.4, GAIN * 0.8, i * 3); this.tones([400, 450], 0.4, GAIN * 0.8, i * 3 + 0.6); } return cycles * 3 - 2; }
    for (let i = 0; i < cycles; i++) this.tones([440, 480], 2, GAIN * 0.8, i * 6); return cycles * 6 - 4;
  }
  busy(seconds) { const n = Math.ceil(seconds / 1); for (let i = 0; i < n; i++) this.tones([480, 620], 0.5, GAIN, i * 1); return n; }
  reorder(seconds) { const n = Math.ceil(seconds / 0.5); for (let i = 0; i < n; i++) this.tones([480, 620], 0.25, GAIN, i * 0.5); return n * 0.5; }
  beep() { this.tones([1000], 0.6, GAIN); return 0.7; }
  // the pay phone's coin tones, as a caller hears them in the earpiece: a quarter is five quick
  // beeps, a dime two slower ones, a nickel one. Returns the seconds they take.
  coin(kind = 'quarter') {
    const beeps = kind === 'nickel' ? [[0, 0.066]] : kind === 'dime' ? [[0, 0.066], [0.132, 0.066]] : [0, 1, 2, 3, 4].map((i) => [i * 0.066, 0.033]);
    for (const [at, dur] of beeps) this.tones([1700, 2200], dur, GAIN * 0.9, at);
    const last = beeps[beeps.length - 1]; return last[0] + last[1] + 0.1;
  }
  // a recording from assets/audio/; resolves when it ends, rejects if it cannot play
  play(file) {
    return new Promise((resolve, reject) => {
      const a = new Audio(new URL(file, AUDIO).href); a.volume = 0.5;
      const h = { stop: () => { try { a.pause(); } catch (e) { /* ignore */ } resolve(); } }; this.playing.push(h);
      a.onended = resolve; a.onerror = () => reject(new Error('no recording')); a.play().catch(reject);
    });
  }
}

// --- the call
export class Phone {
  constructor({ now, temp, hasItem, onChange }) {
    this.sounds = new Sounds(); this.now = now; this.temp = temp; this.hasItem = hasItem || (() => false); this.onChange = onChange || (() => {});
    this.state = 'hung'; this.number = ''; this.lines = []; this.entry = null; this.timer = 0; this.stopTone = null; this.call = 0;
  }
  set(state, extra = {}) { Object.assign(this, { state }, extra); this.onChange(this); }
  say(line) { this.lines = [...this.lines, line]; this.onChange(this); }
  // resolves true after s seconds unless the receiver went down (hangUp bumps the call counter)
  wait(s) { const id = this.call; return new Promise((res) => setTimeout(() => res(id === this.call && this.state !== 'hung'), s * 1000)); }

  lift() {
    this.sounds.ensure();
    this.lines = []; this.number = ''; this.entry = null;
    this.stopTone = this.sounds.dialTone();
    this.set('dialtone');
  }
  hangUp() {
    this.call++; clearTimeout(this.timer);
    if (this.stopTone) { this.stopTone(); this.stopTone = null; }
    this.sounds.stopAll();
    this.set('hung', { number: '', lines: [], entry: null });
  }
  press(d) {
    if (this.state !== 'dialtone' && this.state !== 'dialing') return;
    if (this.stopTone) { this.stopTone(); this.stopTone = null; }
    this.sounds.dtmf(d);
    if (/[0-9]/.test(d)) this.number += d;
    this.set('dialing');
    clearTimeout(this.timer);
    const n = this.number;
    const intl = n.startsWith('011');
    const complete = (intl ? n.length >= 15 : n.length >= 11) || (n.length === 10 && n[0] !== '1' && n[0] !== '0') || (n.length === 7 && n[0] !== '1' && n[0] !== '0' && !/^(406|800|888|877)/.test(n)) || (n.length === 3 && /^(411|511|611|911)/.test(n)) || n === '0';
    this.timer = setTimeout(() => this.place(), complete ? 500 : 3000);   // or a pause, the way a real exchange gives up waiting
  }
  dial(number) {   // from the phone book: the keypad presses itself
    if (this.state === 'hung') this.lift();
    if (this.stopTone) { this.stopTone(); this.stopTone = null; }
    const digits = digitsOf(number); this.number = ''; this.set('dialing');
    digits.split('').forEach((d, i) => setTimeout(() => { if (this.state === 'dialing') { this.sounds.dtmf(d); this.number += d; this.onChange(this); } }, i * 160));
    clearTimeout(this.timer); this.timer = setTimeout(() => this.place(), digits.length * 160 + 400);
  }
  lookup(n) {
    const d = n.length === 11 && n[0] === '1' ? n.slice(1) : n;
    const map = manifest.numbers || {};
    const area = manifest.area || '406';   // a seven-digit dial is local
    return map[d] || (d.length === 7 && map[area + d]) || (d.length === 10 && map[d.slice(3)]) || null;
  }
  async place() {
    if (this.state !== 'dialing' || !this.number) return;
    const n = this.number;
    if (/^911/.test(n)) { this.set('intercept'); this.say('If this is an emergency, hang up and dial 911 on a real phone.'); return; }
    // an unlisted number: in the listed exchange it is a line nobody has ("not in service"); in any
    // other exchange, or with too few digits, it is a misdial ("cannot be completed as dialed")
    const local = n.length === 11 && n[0] === '1' ? n.slice(1) : n;
    const exchange = local.length === 10 ? local.slice(3, 6) : local.length === 7 ? local.slice(0, 3) : '';
    let entry = this.lookup(n) || { kind: 'intercept', which: n.startsWith('011') ? 'international' : exchange === (manifest.exchange || '555') ? 'service' : 'cannot' };
    // some numbers need something found first: `requires` is one item or a list, any of which opens the line
    let key = null;
    if (entry.requires) {
      key = [].concat(entry.requires).find((it) => this.hasItem(it)) || null;
      if (!key) entry = { kind: 'intercept', which: entry.locked || 'international' };
    }
    this.set('connecting', { entry });
    const id = this.call;
    const go = (fn) => id === this.call && this.state !== 'hung' && fn();
    if (entry.kind === 'intercept') return this.intercept(entry.which || 'service');
    if (entry.kind === 'busy') { this.set('busy'); if (entry.text) this.say(entry.text); this.sounds.busy(20); return; }
    // the key that opened the line may have a sound of its own (the whistle) before the far end rings
    const opener = key && entry.opens && entry.opens[key];
    if (opener) {
      if (opener.interrupt) {   // the call starts down the locked road, and the item cuts it off mid-word
        const it = (manifest.intercepts || {})[entry.locked || 'international'] || {};
        this.set('intercept');
        if (it.sit !== false) { const t = this.sounds.sit(); if (!(await this.wait(t + 0.2))) return; }
        else if (!(await this.wait(1.2))) return;
        if (it.text) this.say(it.text);
        if (it.file) this.sounds.play(it.file).catch(() => { /* the transcript carries it */ });
        if (!(await this.wait(opener.interrupt))) return;
        this.sounds.stopAll();
        this.set('connecting');
      }
      if (opener.text) this.say(opener.text);
      if (opener.file) { try { await this.sounds.play(opener.file); } catch (e) { /* no sound: the line still opens */ } }
      if (!(await this.wait(0.6))) return;
      if (opener.coin) {   // the phone answers as if a coin had dropped
        if (opener.coinText) this.say(opener.coinText);
        const t = this.sounds.coin(opener.coin);
        if (!(await this.wait(t + 0.5))) return;
      }
    }
    // the rest ring first
    const rings = entry.kind === 'time' ? 1 : entry.rings || 2;
    this.set('ringing');
    const t = this.sounds.ringback(rings, entry.ring || 'us');
    if (!(await this.wait(t))) return;
    go(() => this[entry.kind] ? this[entry.kind](entry) : this.intercept('service'));
  }
  async intercept(which) {
    const it = (manifest.intercepts || {})[which] || { text: "We're sorry, your call cannot be completed as dialed. Please check the number and dial again." };
    this.set('intercept');
    if (it.sit !== false) {   // the three tones before a phone-company announcement; a routing (a menu) has none
      const t = this.sounds.sit();
      if (!(await this.wait(t + 0.2))) return;
    } else if (!(await this.wait(1.2))) return;
    this.say(it.text);
    let spoken = false;
    if (it.file) { try { await this.sounds.play(it.file); spoken = true; } catch (e) { /* the recording is not in yet: the transcript carries it */ } }
    if (!spoken && !(await this.wait(5))) return;
    if (this.state === 'intercept') { this.sounds.reorder(30); this.set('reorder'); }
  }
  async time() {
    this.set('time');
    const now = this.now(), temp = this.temp();
    const t = formatTime(now).toLowerCase().replace(/(\d+):(\d+) (am|pm)/, (m, h, mm, ap) => `${h}:${mm} ${ap === 'am' ? 'a.m.' : 'p.m.'}`);
    this.say(`At the tone, the time will be ${t}, exactly.`);
    if (!(await this.wait(2.5))) return;
    this.sounds.beep();
    if (!(await this.wait(1.5))) return;
    this.say(temp == null ? 'The temperature is not available.' : `The temperature is ${Math.round(temp)} degrees.`);
    if (!(await this.wait(6))) return;
    this.say('Thank you for calling.');
    if (!(await this.wait(2))) return;
    if (this.state === 'time') { this.sounds.reorder(30); this.set('reorder'); }
  }
  async machine(entry) {
    this.set('machine', { entry });
    this.say(entry.greeting || `You have reached ${entry.name || 'this number'}. Leave a message after the tone.`);
    if (entry.file) { try { await this.sounds.play(entry.file); } catch (e) { /* transcript only */ } }
    else if (!(await this.wait(4))) return;
    this.sounds.beep();
    if (!(await this.wait(0.8))) return;
    if (this.state === 'machine') this.set('record', { entry });   // the panel offers the message form
  }
  async recording(entry) {
    this.set('recording', { entry });
    if (entry.note) this.say(entry.note);
    try { await this.sounds.play(entry.file); } catch (e) { this.say(entry.missing || 'The recording has not been put in yet.'); }
    if (!(await this.wait(1))) return;
    if (this.state === 'recording') { this.sounds.reorder(30); this.set('reorder'); }
  }
  async leaveMessage(text) {
    text = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MESSAGE_MAX);
    if (!text) throw new Error('nothing to say');
    const number = this.number.length === 11 ? this.number.slice(1) : this.number;
    const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number, text }) });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error((body && body.error) || 'the message did not take');
    this.set('left');
    this.say('Your message has been recorded.');
    return body;
  }
}
// what a machine has on its tape, newest last; [] where there is no API (the dev server)
export async function messagesFor(number) {
  try { const r = await fetch(API + '?number=' + digitsOf(number)); if (r.ok) { const j = await r.json(); if (Array.isArray(j)) return j; } } catch (e) { /* none */ }
  return [];
}
