'use strict';
const BUILD = '2708448d';

const $ = id => document.getElementById(id);
const audio = $('player');
const now = () => Date.now();
const AUDIO_CACHE = 'audio-v1';
const SILENCE = silence();
const ART = [{ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }];
const HOLDS = [[0, 'Tap'], [1000, '1 s'], [2000, '2 s'], [3000, '3 s']];
const CHOICES = {
  hold: HOLDS,
  holdShot: HOLDS,
  startOn: [['fill', 'When the bar fills'], ['release', 'When I let go']],
  red: [[false, 'Normal'], [true, 'Dim red']],
  src: [['memory', 'From memory'], ['direct', 'Direct']],
};

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } },
  set(key, v) { try { v == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} },
};
const cfg = Object.assign({ hold: 3000, holdShot: 1000, startOn: 'fill', red: false, loop: true, delay: 0, src: 'memory',
  geo: null, lgBefore: 30, lgAfter: 30 }, store.get('sb-settings'));
const saveCfg = () => store.set('sb-settings', cfg);

const subs = new Map();       // button -> what its small line says when nothing else claims it
const holdResets = [];
const notes = [];
let sounds = [], files = [], cache = null;
let armed = false, priming = false, shellSaved = false, updateWaiting = false, storageNote = '';
let pending = null, pendingTimer = 0, lastRun = null, lastSave = 0, provisioning = false, retries = 0;

// The one sound in play. While it is heard, the <audio> element is the clock. While it is muted
// the element is paused, and the call's place is worked out from when it went quiet (pos, wall).
const S = { mode: 'idle', kind: '', sound: null, len: 0, pre: false, preStart: 0, pos: 0, wall: 0,
  mutedBy: '', seq: 0, target: null, tries: 0, heardAt: 0, resuming: false, url: '', msg: '', msgUntil: 0 };

const fmt = s => { s = Math.max(0, Math.ceil(s - 0.05)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const holdWords = ms => ms ? 'hold ' + ms / 1000 + ' s' : 'tap';
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
const closeSetup = () => { $('setup').hidden = true; };

function note(msg) {
  notes.push(new Date().toTimeString().slice(0, 8) + ' ' + msg);
  if (notes.length > 40) notes.shift();
  if (!$('setup').hidden) drawDiag();
}

function say(msg) {
  S.msg = msg;
  S.msgUntil = now() + 4000;
  render();
}

function silence() {
  const n = 2205, b = new Uint8Array(44 + n).fill(128), v = new DataView(b.buffer);
  const put = (at, s) => { for (let i = 0; i < s.length; i++) b[at + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); v.setUint32(4, 36 + n, true); put(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 44100, true); v.setUint32(28, 44100, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true); put(36, 'data'); v.setUint32(40, n, true);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return 'data:audio/wav;base64,' + btoa(s);
}

// ---------------------------------------------------------------- the files

async function loadManifest() {
  const r = await fetch('manifest.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('manifest.json ' + r.status);
  sounds = (await r.json()).sounds;
  const entry = (f, isPreview) => ({ url: f.path + '?v=' + f.v, bytes: f.bytes, isPreview, state: 'wait', got: 0, saved: false, blobUrl: '' });
  for (const s of sounds) {
    s.main = entry(s.file, false);
    s.pv = s.preview ? entry(s.preview, true) : null;
    const paren = /\s*\(([^)]*)\)\s*$/.exec(s.title);
    s.label = (paren ? s.title.slice(0, paren.index) : s.title).replace(/ x(\d)/i, ' ×$1');
    s.blurb = s.kind === 'sequence' ? `${Math.round(s.duration_s / 60)} min · ${s.windows.length} rounds`
      : paren ? paren[1] : `${Math.round(s.duration_s)} s`;
  }
  files = sounds.map(s => s.main).concat(sounds.filter(s => s.pv).map(s => s.pv));
}

async function provisionAll() {
  if (provisioning) return;
  provisioning = true;
  if (!cache && window.caches) {
    try { cache = await caches.open(AUDIO_CACHE); } catch (e) { note('cannot open the saved-files store: ' + e.message); }
  }
  for (const f of files) if (f.state !== 'ready') await provision(f);
  provisioning = false;
  drawSaved();
  if (files.some(f => f.state === 'error')) {
    if (retries++ < 6) setTimeout(provisionAll, 15000);
  } else {
    retries = 0;
    if (cache && files.every(f => f.saved)) prune();
  }
}

// Each file is fetched whole and played from memory: Safari will not play audio that a service
// worker hands back complete, and a call that is all in memory needs no signal for the hour.
async function provision(f) {
  f.state = 'loading';
  f.got = 0;
  drawButtons(); drawSaved();
  try {
    const hit = cache && await cache.match(f.url);
    let blob = hit ? await hit.blob() : null;
    if (blob && blob.size === f.bytes) {
      f.saved = true;
    } else {
      const r = await fetch(f.url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      blob = await pull(r, f);
      if (blob.size !== f.bytes) throw new Error('download cut short');
      if (cache) {
        try {
          await cache.put(f.url, new Response(blob, { headers: { 'Content-Type': 'audio/mp4', 'Content-Length': String(blob.size) } }));
          f.saved = true;
        } catch (e) { note('could not save ' + f.url.split('?')[0] + ': ' + e.message); }
      }
    }
    f.blobUrl = URL.createObjectURL(blob.slice(0, blob.size, 'audio/mp4'));
    f.state = 'ready';
  } catch (e) {
    f.state = 'error';
    note('could not get ' + f.url.split('?')[0] + ': ' + (e.message || e));
  }
  drawButtons(); drawSaved();
}

async function pull(r, f) {
  if (!r.body || !r.body.getReader) return r.blob();
  const reader = r.body.getReader(), parts = [];
  let drawn = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    f.got += value.length;
    if (now() - drawn > 200) { drawn = now(); drawButtons(); }
  }
  return new Blob(parts);
}

async function prune() {
  const keep = new Set(files.map(f => new URL(f.url, location.href).href));
  for (const req of await cache.keys()) if (!keep.has(req.url)) cache.delete(req);
}

async function redownload() {
  if (S.mode !== 'idle' || provisioning) return;
  for (const f of files) {
    if (f.blobUrl) URL.revokeObjectURL(f.blobUrl);
    Object.assign(f, { state: 'wait', got: 0, saved: false, blobUrl: '' });
  }
  cache = null;
  try { if (window.caches) await caches.delete(AUDIO_CACHE); } catch (e) {}
  provisionAll();
}

async function askStorage() {
  const st = navigator.storage;
  if (!st || !st.persist) return;
  try {
    storageNote = (await st.persisted()) || (await st.persist())
      ? 'The phone will keep them.'
      : 'The phone can clear them after about a week without a visit, so open this page with signal before a trip.';
  } catch (e) {}
  drawSaved();
}

function worker() {
  const sw = navigator.serviceWorker;
  if (!sw) return;
  const had = !!sw.controller;
  const checkShell = async () => {
    try { shellSaved = await caches.has('shell-' + BUILD); } catch (e) { shellSaved = false; }
    drawSaved();
  };
  sw.register('sw.js', { updateViaCache: 'none' }).catch(e => note('offline worker: ' + e.message));
  sw.ready.then(checkShell);
  sw.addEventListener('controllerchange', () => {
    checkShell();
    if (!had) return;
    let last = 0;
    try { last = +sessionStorage.getItem('sb-reloaded') || 0; } catch (e) {}
    if (S.mode === 'idle' && $('setup').hidden && now() - last > 30000) {
      try { sessionStorage.setItem('sb-reloaded', String(now())); } catch (e) {}
      location.reload();
    } else {
      updateWaiting = true;
      drawSaved();
    }
  });
}

// ---------------------------------------------------------------- the clock

function where() {
  if (S.mode !== 'muted') return { pos: S.target != null ? S.target : audio.currentTime, pre: S.pre };
  let pos = S.pos + (now() - S.wall) / 1000, pre = S.pre;
  if (pre && pos >= S.len) { pos -= S.len; pre = false; }
  if (!pre && pos >= S.len) {
    if (!cfg.loop) return { ended: true };
    pos %= S.len;
  }
  return { pos, pre };
}

function settle() {
  const at = where();
  if (at.ended) return stopAll();
  Object.assign(S, { pos: at.pos, pre: at.pre, wall: now() });
}

function roundAt(wins, pos, pre) {
  if (pre) return { st: 'delay', i: 0, secs: S.len - pos + wins[0].first_sound_s };
  for (let i = 0; i < wins.length; i++) {
    if (pos < wins[i].first_sound_s) return { st: 'quiet', i, secs: wins[i].first_sound_s - pos };
    if (pos < wins[i].last_sound_s) return { st: 'calling', i, secs: wins[i].last_sound_s - pos };
  }
  return cfg.loop ? { st: 'quiet', i: 0, secs: S.len - pos + wins[0].first_sound_s }
    : { st: 'last', i: wins.length - 1, secs: S.len - pos };
}

// ---------------------------------------------------------------- the player

function setSrc(f) {
  const url = cfg.src === 'direct' ? f.url : f.blobUrl;
  if (S.url !== url) { S.url = url; audio.src = url; }
}

function dropSrc() {
  if (!S.url) return;
  S.url = '';
  audio.removeAttribute('src');
  audio.load();
}

// play() is called at once, so it lands inside the touch when there is one. A file that is already
// loaded is moved in place and played as is. A fresh file that has to begin somewhere other than
// 0:00 plays muted until the playhead gets there, so nothing from the wrong spot is heard.
function playAt(at) {
  const my = S.seq;
  at = Math.max(0, at);
  S.tries = 0;
  S.target = null;
  if (audio.readyState < 1) S.target = at || null;
  else if (Math.abs(audio.currentTime - at) > 0.05) audio.currentTime = at;
  audio.muted = S.target != null;
  let p;
  try { p = audio.play(); } catch (e) { return playFailed(my, e); }
  if (p && p.catch) p.catch(e => playFailed(my, e));
}

function land() {
  if (S.mode !== 'playing' || audio.readyState < 1) return;
  if (S.kind !== 'sequence' && isFinite(audio.duration)) S.len = audio.duration;
  if (S.target == null || audio.seeking) return;
  const off = audio.currentTime - S.target;
  if ((off < -0.3 || off > 2.5) && S.tries < 3) {
    S.tries++;
    audio.currentTime = S.target;
    return;
  }
  S.target = null;
  S.heardAt = now();
  audio.muted = false;
}

// The phone would not let the page make sound: play() was turned down, or the player was paused
// the moment it was unmuted. A fresh start is dropped; an unmute goes back to muted.
function refused(name) {
  note('the phone refused to play: ' + name);
  if (S.resuming) {
    Object.assign(S, { mode: 'muted', target: null, resuming: false });
    audio.muted = true;
    audio.pause();
    media(); saveSession();
  } else {
    stopAll();
  }
  if (name === 'NotAllowedError') blocked(); else say('Could not play that call');
  render();
}

function playFailed(my, e) {
  const name = (e && e.name) || 'Error';
  if (my === S.seq && name !== 'AbortError') refused(name);
}

function start(sound, kind) {
  const f = kind === 'preview' ? sound.pv : sound.main;
  if (!f || f.state !== 'ready') return;
  dropPending();
  S.seq++;
  Object.assign(S, { mode: 'playing', kind, sound, len: kind === 'preview' ? 40 : sound.duration_s,
    pre: false, mutedBy: '', resuming: false, msg: '' });
  let at = 0;
  if (kind === 'sequence' && cfg.delay) {
    // The wait is the silent tail of the same file, with loop on, so no timer has to fire.
    const wins = sound.windows;
    at = Math.max(S.len - cfg.delay * 60, wins[wins.length - 1].last_sound_s + 1);
    S.pre = true;
    S.preStart = at;
  }
  S.pos = at;
  S.wall = now();
  audio.loop = kind === 'sequence' && (S.pre || cfg.loop);
  setSrc(f);
  playAt(at);
  buildBar(kind === 'sequence' ? sound.windows : []);
  media(); saveSession(); render();
  note('start ' + sound.id + (kind === 'preview' ? ' volume check' : '') + (S.pre ? ', delay ' + cfg.delay + ' min' : ''));
}

function mute(by) {
  if (S.mode !== 'playing') return;
  if (S.kind !== 'sequence') return stopAll();
  S.pos = S.target != null ? S.target : audio.currentTime;
  S.wall = now();
  Object.assign(S, { mode: 'muted', mutedBy: by, target: null, resuming: false });
  audio.muted = true;
  audio.pause();
  media(); saveSession(); render();
  note('muted' + (by === 'user' ? '' : ' by the ' + by) + ' at ' + fmt(S.pos));
}

function unmute() {
  if (S.mode !== 'muted') return;
  const at = where();
  if (at.ended) return stopAll();
  if (S.sound.main.state !== 'ready') return say('That call is not ready yet');
  S.seq++;
  Object.assign(S, { mode: 'playing', pre: at.pre, pos: at.pos, wall: now(), resuming: true });
  audio.loop = S.pre || cfg.loop;
  setSrc(S.sound.main);
  playAt(at.pos);
  media(); saveSession(); render();
  note('unmuted at ' + fmt(at.pos));
}

function callNow() {
  if (S.mode !== 'playing' || S.kind !== 'sequence') return;
  const wins = S.sound.windows, pos = where().pos;
  const next = (!S.pre && wins.find(w => w.first_sound_s > pos + 0.5)) || wins[0];
  S.seq++;
  S.pre = false;
  audio.loop = cfg.loop;
  const at = Math.max(next.start_s, next.first_sound_s - 0.3);
  playAt(at);
  S.pos = at;
  S.wall = now();
  saveSession(); render();
  note('call now, round ' + (wins.indexOf(next) + 1));
}

function stopAll(why) {
  const was = S.mode;
  S.seq++;
  Object.assign(S, { mode: 'idle', kind: '', sound: null, pre: false, target: null, mutedBy: '', resuming: false });
  audio.muted = true;
  audio.pause();
  audio.loop = false;
  dropSrc();
  media(); saveSession(); render();
  if (was !== 'idle') note(typeof why === 'string' ? why : 'stopped');
}

// iPhone only lets a page start sound from inside a touch, and a hold that finishes on a timer is
// not one. A plain tap on this player first lifts that rule for it for as long as the page is open.
function arm() {
  armed = true;
  $('arm').hidden = true;
  if (S.mode !== 'playing') {
    priming = true;
    audio.muted = true;
    audio.loop = false;
    S.url = SILENCE;
    audio.src = SILENCE;
    const done = e => {
      priming = false;
      if (e && e.name === 'NotAllowedError') {
        note('the arming tap was refused');
        cfg.startOn = 'release';
        saveCfg();
      }
      if (S.mode !== 'playing') {
        audio.pause();
        if (S.url === SILENCE) dropSrc();
      }
    };
    let p;
    try { p = audio.play(); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(() => done(), done);
  }
  askStorage();
  render();
}

function tick() {
  if (S.mode !== 'playing') return;
  land();
  if (S.target == null) {
    S.pos = audio.currentTime;
    S.wall = now();
    if (S.resuming && S.wall - S.heardAt > 1000) S.resuming = false;
    if (S.pre && S.pos < S.preStart - 1) {
      S.pre = false;
      audio.loop = cfg.loop;
    }
    if (S.wall - lastSave > 10000) saveSession();
  }
  render();
}

function listen() {
  for (const ev of ['loadedmetadata', 'seeked', 'canplay', 'playing']) audio.addEventListener(ev, land);
  audio.addEventListener('timeupdate', tick);
  audio.addEventListener('ended', () => { if (S.mode === 'playing') stopAll('played to the end'); });
  // A pause this page did not ask for: a phone call, the speaker dropping out, another app's sound.
  audio.addEventListener('pause', () => {
    if (S.mode !== 'playing' || !audio.paused || audio.ended) return;
    // iPhone pauses a player on the spot if it is unmuted without the right to make sound.
    if (now() - S.heardAt < 1000) return refused('NotAllowedError');
    mute('phone');
  });
  // The phone resumes on its own after an interruption. Sound only comes back when it is asked for.
  audio.addEventListener('play', () => {
    if (S.mode !== 'playing' && !priming) { audio.muted = true; audio.pause(); }
  });
  audio.addEventListener('error', () => {
    if (S.mode !== 'playing' || !audio.error) return;
    note('audio error ' + audio.error.code);
    stopAll();
    say('Could not play that call');
  });

  const ms = navigator.mediaSession;
  if (!ms) return;
  const on = (name, fn) => { try { ms.setActionHandler(name, fn); } catch (e) {} };
  on('play', () => { lastRun = null; unmute(); });
  on('pause', () => mute('user'));
  on('stop', stopAll);
  // Without these the lock screen's skip and scrub controls would move the call on their own.
  for (const name of ['seekto', 'seekbackward', 'seekforward']) on(name, () => {});
}

function media() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  try {
    ms.metadata = S.sound && window.MediaMetadata
      ? new MediaMetadata({ title: S.sound.label + (S.kind === 'preview' ? ' (volume check)' : ''), artist: 'Call soundboard', artwork: ART })
      : null;
    ms.playbackState = S.mode === 'playing' ? 'playing' : S.mode === 'muted' ? 'paused' : 'none';
  } catch (e) {}
}

// A running call is written down so that a reload (the phone clearing the tab while another app
// is open) does not lose its schedule. It always comes back muted.
function saveSession() {
  lastSave = now();
  store.set('sb-session', S.kind === 'sequence' && S.mode !== 'idle'
    ? { id: S.sound.id, pos: S.pos, wall: S.wall, pre: S.pre, preStart: S.preStart } : null);
}

function restoreSession() {
  const s = store.get('sb-session'), sound = s && sounds.find(x => x.id === s.id);
  const age = s ? now() - s.wall : -1;
  if (!sound || sound.kind !== 'sequence' || age < 0 || age > 6 * 3600e3) return store.set('sb-session', null);
  Object.assign(S, { mode: 'muted', kind: 'sequence', sound, len: sound.duration_s, pre: !!s.pre,
    preStart: s.preStart || 0, pos: s.pos, wall: s.wall, mutedBy: 'reload' });
  if (where().ended) return stopAll();
  buildBar(sound.windows);
  note('picked up ' + sound.id + ' after a reload, muted');
}

// ---------------------------------------------------------------- holding a button

function holdable(btn, o) {
  let id = null, timer = 0, full = false;
  const inside = e => {
    const r = btn.getBoundingClientRect(), slop = 14;
    return e.clientX > r.left - slop && e.clientX < r.right + slop && e.clientY > r.top - slop && e.clientY < r.bottom + slop;
  };
  const reset = () => {
    clearTimeout(timer);
    id = null;
    full = false;
    btn.classList.remove('holding', 'full');
    drawButtons();
  };
  const fire = () => { lastRun = { run: o.run, btn }; o.run(); };
  holdResets.push(() => { if (id !== null) reset(); });

  btn.addEventListener('pointerdown', e => {
    if (id !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (pending && pending.btn === btn) return;
    if (o.down && o.down()) return;
    if (!o.can()) return;
    id = e.pointerId;
    try { btn.setPointerCapture(id); } catch (err) {}
    const ms = o.ms();
    if (!ms) return;
    btn.style.setProperty('--hold', ms + 'ms');
    btn.classList.add('holding');
    timer = setTimeout(() => {
      full = true;
      btn.classList.add('full');
      if (cfg.startOn === 'release') drawButtons(); else fire();
    }, ms);
  });
  btn.addEventListener('pointerup', e => {
    if (e.pointerId !== id) return;
    const ms = o.ms(), wasFull = full, ok = inside(e);
    const waiting = pending && pending.btn === btn && pending.stage === 'release';
    reset();
    if (waiting) return ok ? runPending() : dropPending();
    if (!ok) return;
    if (!ms || (wasFull && cfg.startOn === 'release')) fire();
    else if (!wasFull && o.tap) o.tap();
  });
  const cancel = e => {
    if (e.pointerId !== id) return;
    reset();
    if (pending && pending.btn === btn) dropPending();
  };
  btn.addEventListener('pointercancel', cancel);
  btn.addEventListener('pointermove', e => { if (!inside(e)) cancel(e); });
  btn.addEventListener('click', () => { if (pending && pending.btn === btn && pending.stage === 'tap') runPending(); });
}

// The phone would not start the sound from the timer. From now on a hold starts when the thumb
// lifts, which is a touch; if even that is refused, one more tap on the same button does it.
function blocked() {
  if (cfg.startOn !== 'release') {
    cfg.startOn = 'release';
    saveCfg();
    drawSetup();
    note('switched to starting when you let go');
  }
  if (!lastRun) return;
  const btn = lastRun.btn;
  pending = { run: lastRun.run, btn, stage: btn.classList.contains('full') ? 'release' : 'tap' };
  btn.classList.add('armed');
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(dropPending, 10000);
  drawButtons();
}

function runPending() {
  const p = pending;
  dropPending();
  if (!p) return;
  lastRun = p;
  p.run();
}

function dropPending() {
  if (!pending) return;
  clearTimeout(pendingTimer);
  pending.btn.classList.remove('armed');
  pending = null;
  drawButtons();
}

function flash(btn, text) {
  btn.dataset.flash = text;
  btn.classList.add('flash');
  clearTimeout(btn.flashTimer);
  btn.flashTimer = setTimeout(() => {
    delete btn.dataset.flash;
    btn.classList.remove('flash');
    drawButtons();
  }, 1800);
  drawButtons();
}

// ---------------------------------------------------------------- legal light

// The two times are worked out on the phone from the date and a saved location, with the standard
// sunrise and sunset formulas (NOAA's, good to about a minute). Nothing is fetched, and the
// location is kept in this phone's settings and nowhere else.
const RAD = Math.PI / 180;
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayName = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } };
let locating = false, locateNote = '';

// Where the sun is at a moment: its declination in radians and the equation of time in minutes.
function sunAt(ms) {
  const T = (ms / 864e5 + 2440587.5 - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360 * RAD;
  const M = (357.52911 + T * (35999.05029 - 0.0001537 * T)) * RAD;
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * M) * (0.019993 - 0.000101 * T) + Math.sin(3 * M) * 0.000289;
  const om = (125.04 - 1934.136 * T) * RAD;
  const lam = L0 + (C - 0.00569 - 0.00478 * Math.sin(om)) * RAD;
  const eps = (23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(om)) * RAD;
  const y = Math.tan(eps / 2) ** 2;
  const eot = 4 / RAD * (y * Math.sin(2 * L0) - 2 * e * Math.sin(M) + 4 * e * y * Math.sin(M) * Math.cos(2 * L0)
    - 0.5 * y * y * Math.sin(4 * L0) - 1.25 * e * e * Math.sin(2 * M));
  return { decl: Math.asin(Math.sin(eps) * Math.sin(lam)), eot };
}

// Sunrise and sunset, in milliseconds, for a calendar day at a place. Null where the sun does neither.
function sunTimes(y, m, d, lat, lon) {
  const base = Date.UTC(y, m, d), out = [];
  for (const side of [-1, 1]) {
    let t = base + (720 - 4 * lon) * 6e4;
    for (let i = 0; i < 3; i++) {
      const s = sunAt(t);
      const c = Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(s.decl)) - Math.tan(lat * RAD) * Math.tan(s.decl);
      if (!(c >= -1 && c <= 1)) return null;
      t = base + (720 - 4 * lon - s.eot + side * 4 * Math.acos(c) / RAD) * 6e4;
    }
    out.push(t);
  }
  return out;
}

// Half a minute of slack and then rounded to the minute, so the start never shows early and the
// end never shows late.
function legalTimes(g, when) {
  const d = new Date(when), s = sunTimes(d.getFullYear(), d.getMonth(), d.getDate(), g.lat, g.lon);
  return s && [Math.ceil((s[0] - cfg.lgBefore * 6e4 + 3e4) / 6e4) * 6e4, Math.floor((s[1] + cfg.lgAfter * 6e4 - 3e4) / 6e4) * 6e4];
}

const spanText = t => clock.format(t[0]) + ' – ' + clock.format(t[1]);

function drawLegal() {
  const g = cfg.geo;
  let label = 'Legal light', line;
  if (!g) {
    line = 'Set location in Setup';
  } else if (g.zone !== zone()) {
    // The phone has changed time zones since the location was saved, so the saved spot is not here.
    line = 'Set location again in Setup';
  } else {
    const t = legalTimes(g, now());
    line = t ? spanText(t) : 'No sunrise or sunset today';
    if (now() - g.at > 2 * 864e5) label += ' · location from ' + dayName.format(g.at);
  }
  setText($('lg-l'), label);
  setText($('lg-t'), line);
}

function locate() {
  if (locating) return;
  if (!navigator.geolocation || !window.isSecureContext) {
    locateNote = 'This address cannot ask the phone where it is. That needs the https address.';
    return drawSetup();
  }
  locating = true;
  locateNote = '';
  drawSetup();
  navigator.geolocation.getCurrentPosition(p => {
    locating = false;
    // Kept to a tenth of a degree, a few miles: plenty for sunrise, and not a pin on a stand.
    cfg.geo = { lat: Math.round(p.coords.latitude * 10) / 10, lon: Math.round(p.coords.longitude * 10) / 10, at: now(), zone: zone() };
    saveCfg();
    note('location saved for legal light');
    applyCfg();
  }, e => {
    locating = false;
    locateNote = e.code === 1
      ? 'The phone would not share its location. On an iPhone: Settings, Privacy & Security, Location Services, Safari Websites, While Using the App.'
      : 'The phone could not find itself. Step into the open and press again.';
    note('location not found, code ' + e.code);
    drawSetup();
    // A fresh fix every time, never one the phone has kept: the button is pressed because the phone has moved.
  }, { enableHighAccuracy: true, timeout: 60000, maximumAge: 0 });
}

// ---------------------------------------------------------------- the screen

function button(cls, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn hold ' + cls;
  b.innerHTML = '<span class="fill"></span><span class="lbl"></span><span class="sub"></span>';
  b.querySelector('.lbl').textContent = label;
  return b;
}

function buildBoard() {
  for (const s of sounds) {
    const seq = s.kind === 'sequence', ms = () => seq ? cfg.hold : cfg.holdShot;
    s.btn = button(seq ? 'call' : 'shot', s.label);
    $(seq ? 'calls' : 'shots').appendChild(s.btn);
    holdable(s.btn, {
      ms,
      can: () => s.main.state === 'ready',
      run: () => start(s, seq ? 'sequence' : 'oneshot'),
      tap: () => flash(s.btn, holdWords(ms()) + ' to start'),
    });
    subs.set(s.btn, () => s.main.state === 'loading' ? 'saving ' + Math.floor(100 * s.main.got / s.main.bytes) + '%'
      : s.main.state === 'wait' ? 'waiting'
      : s.main.state === 'error' ? 'not saved'
      : S.sound === s && S.kind !== 'preview' ? (S.mode === 'muted' ? 'muted' : 'running')
      : s.blurb);
    if (!s.pv) continue;
    s.pvBtn = button('check', s.label);
    $('checks').appendChild(s.pvBtn);
    holdable(s.pvBtn, {
      ms: () => cfg.hold,
      can: () => s.pv.state === 'ready',
      run: () => { start(s, 'preview'); closeSetup(); },
      tap: () => flash(s.pvBtn, holdWords(cfg.hold) + ' to play'),
    });
    subs.set(s.pvBtn, () => s.pv.state === 'ready' ? '40 s' : s.pv.state === 'error' ? 'not saved' : 'saving');
  }
  const seqs = sounds.filter(s => s.kind === 'sequence').length;
  $('calls').style.flexGrow = seqs;
  $('shots').style.flexGrow = Math.ceil((sounds.length - seqs) / 2);
}

function buildBar(wins) {
  const box = $('bar-wins');
  box.textContent = '';
  for (const w of wins) {
    const d = document.createElement('div');
    d.className = 'win';
    d.style.left = 100 * w.first_sound_s / S.len + '%';
    d.style.width = 100 * (w.last_sound_s - w.first_sound_s) / S.len + '%';
    box.appendChild(d);
  }
}

// Everything on screen is read from the player's position each time. Nothing here counts time.
function render() {
  let cls = 'idle', state = 'Ready', count = '', info;
  if (S.mode !== 'idle' && S.kind === 'sequence') {
    const at = where();
    if (at.ended) return stopAll();
    const wins = S.sound.windows, r = roundAt(wins, at.pos, at.pre), t = fmt(r.secs), muted = S.mode === 'muted';
    cls = muted ? 'muted' : r.st === 'calling' ? 'calling' : 'quiet';
    state = muted ? 'Muted' : r.st === 'calling' ? 'Calling' : r.st === 'delay' ? 'Delay' : 'Quiet';
    count = r.st === 'calling' ? (muted ? `round ${r.i + 1} is on · ${t} left` : `${t} left in this round`)
      : r.st === 'delay' ? `first round in ${t}`
      : r.st === 'last' ? `ends in ${t}`
      : `next round in ${t}`;
    info = S.sound.label + ' · ' + (muted && S.mutedBy === 'phone' ? 'paused by the phone'
      : muted && S.mutedBy === 'reload' ? 'the page was reloaded'
      : r.st === 'calling' ? `round ${r.i + 1} of ${wins.length} · ${wins[r.i].label}`
      : r.st === 'last' ? `all ${wins.length} rounds done`
      : `round ${r.i + 1} of ${wins.length} is next`);
    $('bar-dot').style.left = (100 * at.pos / S.len).toFixed(2) + '%';
  } else if (S.mode !== 'idle') {
    const pos = where().pos;
    cls = 'calling';
    state = S.kind === 'preview' ? 'Volume check' : 'Playing';
    count = fmt(S.len - pos) + ' left';
    info = S.sound.label;
    $('bar-dot').style.left = Math.min(100, 100 * pos / S.len).toFixed(2) + '%';
  } else {
    const calls = files.filter(f => !f.isPreview);
    info = !calls.length || calls.some(f => f.state === 'wait' || f.state === 'loading') ? 'Getting the calls ready…'
      : calls.some(f => f.state === 'error') ? 'Some calls are not saved. Needs signal.'
      : (cfg.hold ? 'Hold' : 'Tap') + ' a call to start';
  }
  if (S.msg && now() < S.msgUntil) info = S.msg;
  const st = $('status');
  if (st.className !== 'status ' + cls) st.className = 'status ' + cls;
  setText($('st-state'), state);
  setText($('st-count'), count);
  setText($('st-info'), info);
  drawLegal();
  drawButtons();
}

function drawButtons() {
  for (const [btn, base] of subs) {
    const mine = pending && pending.btn === btn;
    setText(btn.querySelector('.sub'), btn.dataset.flash
      || (mine ? (pending.stage === 'tap' ? 'tap again' : 'let go now')
        : btn.classList.contains('full') && cfg.startOn === 'release' ? 'let go'
        : base()));
  }
  for (const s of sounds) {
    s.btn.classList.toggle('off', s.main.state !== 'ready');
    s.btn.classList.toggle('active', S.sound === s && S.kind !== 'preview' && S.mode !== 'idle');
    if (s.pvBtn) s.pvBtn.classList.toggle('off', s.pv.state !== 'ready');
  }
  $('b-now').classList.toggle('off', !(S.mode === 'playing' && S.kind === 'sequence'));
  $('b-stop').classList.toggle('off', S.mode === 'idle');
  $('b-mute').classList.toggle('off', S.mode === 'idle');
  setText($('b-mute').querySelector('.lbl'), S.mode === 'muted' ? 'Unmute' : 'Mute');
}

function drawSaved() {
  const calls = files.filter(f => !f.isPreview), n = calls.length, pv = files.filter(f => f.isPreview);
  const ready = calls.filter(f => f.state === 'ready').length, saved = calls.filter(f => f.saved).length;
  const canSave = !!(window.caches && navigator.serviceWorker), have = canSave ? saved : ready;
  const t = !n ? ''
    : calls.some(f => f.state === 'loading' || f.state === 'wait') ? `${canSave ? 'Saving' : 'Loading'} ${have} of ${n}…`
    : calls.some(f => f.state === 'error') ? `${canSave ? 'Saved on this phone' : 'Loaded'}: ${have} of ${n} · needs signal`
    : !canSave ? `Loaded ${n} of ${n} · not saved (address is not https)`
    : saved === n && !shellSaved ? `Calls saved: ${n} of ${n} · saving the page…`
    : `Saved on this phone: ${saved} of ${n}`;
  setText($('arm-saved'), t);
  setText($('saved'), updateWaiting ? 'Update ready · tap here to load it' : t);
  const mb = files.filter(f => f.saved).reduce((sum, f) => sum + f.bytes, 0) / 1e6;
  setText($('saved-detail'), canSave
    ? `${saved} of ${n} calls and ${pv.filter(f => f.saved).length} of ${pv.length} previews, ${mb.toFixed(1)} MB. ${storageNote}`
    : 'This address cannot save anything on the phone. Saving needs an https address.');
}

function drawSetup() {
  for (const seg of document.querySelectorAll('.seg')) {
    const key = seg.dataset.key;
    if (!seg.firstChild) {
      for (const [value, text] of CHOICES[key]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.addEventListener('click', () => { cfg[key] = value; saveCfg(); applyCfg(); });
        seg.appendChild(b);
      }
    }
    [...seg.children].forEach((b, i) => b.classList.toggle('on', CHOICES[key][i][0] === cfg[key]));
  }
  for (const step of document.querySelectorAll('.step')) {
    const key = step.dataset.key;
    if (!step.firstChild) {
      for (const by of [-5, -1, 0, 1, 5]) {
        const el = document.createElement(by ? 'button' : 'span');
        if (by) {
          el.type = 'button';
          el.textContent = (by > 0 ? '+' : '−') + Math.abs(by);
          el.addEventListener('click', () => { cfg[key] = Math.max(0, Math.min(90, cfg[key] + by)); saveCfg(); applyCfg(); });
        } else {
          el.className = 'val';
        }
        step.appendChild(el);
      }
    }
    setText(step.querySelector('.val'), cfg[key] + ' min');
  }
  const g = cfg.geo, t = g && g.zone === zone() && legalTimes(g, now());
  setText($('lg-status'), locating ? 'Asking the phone where it is…'
    : locateNote ? locateNote
    : !g ? 'No location saved yet.'
    : `Location saved ${dayName.format(g.at)}${t ? ' · today ' + spanText(t) : ''}. Press again when you move camp.`);
  drawDiag();
}

function drawDiag() {
  const home = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const edge = name => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
  $('diag').textContent = [
    `build ${BUILD} · opened ${home ? 'from the Home Screen' : 'in a browser tab'}`,
    `screen ${screen.width} x ${screen.height} · page ${innerWidth} x ${innerHeight} · kept clear: top ${edge('--edge-top')}, bottom ${edge('--edge-bottom')}`,
    `page saved for offline: ${shellSaved ? 'yes' : 'no'}`,
    `armed: ${armed ? 'yes' : 'no'} · now: ${S.mode}${S.sound ? ' ' + S.sound.id : ''}`,
    ...notes.slice(-14),
  ].join('\n');
}

function applyCfg() {
  document.documentElement.classList.toggle('red', !!cfg.red);
  drawSetup();
  render();
}

function wire() {
  $('b-arm').addEventListener('click', arm);
  $('b-setup').addEventListener('click', () => { locateNote = ''; $('setup').hidden = false; drawSetup(); drawSaved(); });
  $('b-done').addEventListener('click', closeSetup);
  $('b-locate').addEventListener('click', locate);
  $('b-redo').addEventListener('click', redownload);
  $('saved').addEventListener('click', () => { if (updateWaiting && S.mode === 'idle') location.reload(); });

  $('b-loop').addEventListener('click', () => {
    if (S.mode === 'muted') settle();
    cfg.loop = !cfg.loop;
    saveCfg();
    if (S.mode === 'playing' && S.kind === 'sequence' && !S.pre) audio.loop = cfg.loop;
    render();
  });
  $('b-delay').addEventListener('click', () => {
    cfg.delay = cfg.delay === 0 ? 1 : cfg.delay === 1 ? 5 : 0;
    saveCfg();
    render();
  });
  subs.set($('b-loop'), () => cfg.loop ? 'on' : 'off');
  subs.set($('b-delay'), () => cfg.delay ? cfg.delay + ' min' : 'none');

  // Two hold lengths: the long one starts or stops an hour, the short one is for sound wanted now.
  for (const [id, ms, can, run] of [
    ['b-now', () => cfg.holdShot, () => S.mode === 'playing' && S.kind === 'sequence', callNow],
    ['b-stop', () => cfg.hold, () => S.mode !== 'idle', stopAll],
  ]) {
    holdable($(id), { ms, can, run, tap: () => flash($(id), holdWords(ms())) });
    subs.set($(id), () => holdWords(ms()));
  }

  // Mute acts the moment the thumb lands. Unmuting takes a hold so a brush cannot do it.
  holdable($('b-mute'), {
    ms: () => cfg.holdShot,
    down: () => { if (S.mode !== 'playing') return false; mute('user'); return true; },
    can: () => S.mode === 'muted',
    run: unmute,
    tap: () => flash($('b-mute'), holdWords(cfg.holdShot) + ' to unmute'),
  });
  subs.set($('b-mute'), () => S.mode === 'muted' ? holdWords(cfg.holdShot)
    : S.mode !== 'playing' ? ''
    : S.kind === 'sequence' ? 'the clock keeps running' : 'ends it');

  document.addEventListener('pointerdown', e => { if (pending && !pending.btn.contains(e.target)) dropPending(); }, true);
  for (const ev of ['contextmenu', 'gesturestart', 'dblclick']) document.addEventListener(ev, e => e.preventDefault());
  document.addEventListener('touchmove', e => { if (!e.target.closest('.setup-body')) e.preventDefault(); }, { passive: false });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return holdResets.forEach(reset => reset());
    render();
    if (files.some(f => f.state === 'error')) provisionAll();
  });
  window.addEventListener('online', provisionAll);
}

async function boot() {
  wire();
  listen();
  applyCfg();
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
  try {
    await loadManifest();
  } catch (e) {
    note('manifest: ' + e.message);
    $('b-arm').hidden = true;
    return setText($('arm-note'), 'Could not load the calls. Check the signal and reload the page.');
  }
  buildBoard();
  restoreSession();
  if (S.mode === 'muted') setText($('arm-note'), S.sound.label + ' was running. It comes back muted, still on its schedule.');
  render();
  drawSaved();
  worker();
  provisionAll();
  setInterval(render, 250);
}

window.soundboard = { S, cfg, notes, audio, sunTimes, legalTimes, get sounds() { return sounds; }, get files() { return files; } };
boot();
