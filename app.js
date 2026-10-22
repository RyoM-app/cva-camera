'use strict';
// CVAカメラ 0.2.0 — 1人で使える側面CVA計測
// 流れ：内カメラを開始 → セルフタイマーで1枚撮影 → 写真の上でマーカーをタップ → 記録スタート（ライブ映像で追跡）
// 角度の定義は cva_tracker.py（Python版）と同じ。
const VERSION = '0.2.0';
const $ = id => document.getElementById(id);
const video = $('video'), snap = $('snap'), overlay = $('overlay'), octx = overlay.getContext('2d');
const proc = document.createElement('canvas'), pctx = proc.getContext('2d', { willReadFrequently: true });
const NAMES = { tragus: '耳珠', c7: 'C7', acromion: '肩峰' };
const RING = { tragus: '#e04a3f', c7: '#e9a23b', acromion: '#2f6f8f' };
const PROTOCOL = ['基準', 'うつむく', '顎を突き出す', '目線だけ下げる', '基準'];
const SAY = { '基準': '楽な姿勢で、正面を見てください', 'うつむく': 'スマホを見るように、うつむいてください', '顎を突き出す': '顎を前に突き出してください', '目線だけ下げる': '頭は動かさず、目線だけを下げてください' };

const S = {
  stream: null, running: false, phase: 'idle',   // idle | live | frozen | countdown | recording
  target: 'tragus', label: '基準', showMask: false,
  markers: {}, level: [], roll: 0, facing: 1,
  k: 1, img: null, snapImg: null, fps: 0, lastT: 0, frame: 0,
  tilt: null, rec: null, last: null, timers: [],
  hTol: 18, minArea: 8, procLong: 640,
};

// ---------------------------------------------------------------- 音と声
let audio = null;
function beep(freq = 880, ms = 150) {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq; o.connect(g); g.connect(audio.destination);
    g.gain.setValueAtTime(0.25, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + ms / 1000);
    o.start(); o.stop(audio.currentTime + ms / 1000);
  } catch (e) {}
}
function say(text) {
  if (!text) return;
  try { const u = new SpeechSynthesisUtterance(text); u.lang = 'ja-JP'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) {}
}
function countdown(sec, done) {
  const el = $('countdown');
  if (sec <= 0) { el.hidden = true; done(); return; }
  let n = sec; el.hidden = false; el.textContent = n; beep(660, 120);
  const id = setInterval(() => {
    n--;
    if (n <= 0) { clearInterval(id); el.hidden = true; beep(1200, 250); done(); }
    else { el.textContent = n; beep(660, 120); }
  }, 1000);
  S.timers.push(id);
}

// ---------------------------------------------------------------- 色
function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx ? d / mx : 0, mx];
}
function matches(data, i, c) {
  const [h, s, v] = rgb2hsv(data[i], data[i + 1], data[i + 2]);
  if (s < c.sMin || v < c.vMin) return false;
  const dh = Math.abs(h - c.h); return Math.min(dh, 360 - dh) <= c.hTol;
}
function sampleColor(img, px, py) {
  const { width: W, height: H, data } = img, hs = [], ss = [], vs = [];
  for (let y = Math.max(0, py - 2); y <= Math.min(H - 1, py + 2); y++)
    for (let x = Math.max(0, px - 2); x <= Math.min(W - 1, px + 2); x++) {
      const i = (y * W + x) * 4, [h, s, v] = rgb2hsv(data[i], data[i + 1], data[i + 2]); hs.push(h); ss.push(s); vs.push(v);
    }
  const sx = hs.reduce((a, h) => a + Math.cos(h * Math.PI / 180), 0), sy = hs.reduce((a, h) => a + Math.sin(h * Math.PI / 180), 0);
  let h = Math.atan2(sy, sx) * 180 / Math.PI; if (h < 0) h += 360;
  const med = a => a.sort((p, q) => p - q)[a.length >> 1], s = med(ss), v = med(vs);
  return { h, s, v, hTol: S.hTol, sMin: Math.max(0.3, s - 0.28), vMin: Math.max(0.2, v - 0.3) };  // Python版と同じ幅
}

// ---------------------------------------------------------------- 検出
function findBlob(img, c, cx, cy, R, step = 1) {
  const { width: W, height: H, data } = img;
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
  const ww = Math.floor((x1 - x0) / step) + 1, wh = Math.floor((y1 - y0) / step) + 1;
  const m = new Uint8Array(ww * wh), lab = new Int32Array(ww * wh), q = new Int32Array(ww * wh);
  for (let j = 0; j < wh; j++) for (let i = 0; i < ww; i++) if (matches(data, ((y0 + j * step) * W + x0 + i * step) * 4, c)) m[j * ww + i] = 1;
  let best = null, bestScore = -Infinity, n = 0;
  for (let p = 0; p < m.length; p++) {
    if (!m[p] || lab[p]) continue;
    n++; let head = 0, tail = 0, a = 0, sx = 0, sy = 0; q[tail++] = p; lab[p] = n;
    while (head < tail) {
      const u = q[head++], ui = u % ww, uj = (u / ww) | 0; a++; sx += ui; sy += uj;
      if (ui > 0 && m[u - 1] && !lab[u - 1]) { lab[u - 1] = n; q[tail++] = u - 1; }
      if (ui < ww - 1 && m[u + 1] && !lab[u + 1]) { lab[u + 1] = n; q[tail++] = u + 1; }
      if (uj > 0 && m[u - ww] && !lab[u - ww]) { lab[u - ww] = n; q[tail++] = u - ww; }
      if (uj < wh - 1 && m[u + ww] && !lab[u + ww]) { lab[u + ww] = n; q[tail++] = u + ww; }
    }
    const area = a * step * step; if (area < S.minArea) continue;
    const bx = x0 + (sx / a) * step, by = y0 + (sy / a) * step, d = Math.hypot(bx - cx, by - cy);
    const score = step === 1 ? -d + 0.02 * area : area;
    if (score > bestScore) { bestScore = score; best = { x: bx, y: by, area }; }
  }
  return best;
}
function track() {
  for (const mk of Object.values(S.markers)) {
    let b = findBlob(S.img, mk.color, mk.prev[0], mk.prev[1], Math.max(25, mk.rad * 4), 1);
    if (!b && mk.lost >= 3) b = findBlob(S.img, mk.color, S.img.width / 2, S.img.height / 2, Math.max(S.img.width, S.img.height), 2);
    if (b) { mk.prev = [b.x, b.y]; mk.rad = 0.7 * mk.rad + 0.3 * Math.sqrt(b.area / Math.PI); mk.lost = 0; mk.pos = [b.x / S.k, b.y / S.k]; mk.area = b.area / (S.k * S.k); }
    else { mk.lost++; mk.pos = null; mk.area = null; }
  }
}

// ---------------------------------------------------------------- 角度（Python版と同じ定義）
function rot(p, c) { const t = -S.roll * Math.PI / 180, x = p[0] - c[0], y = p[1] - c[1]; return [c[0] + x * Math.cos(t) - y * Math.sin(t), c[1] + x * Math.sin(t) + y * Math.cos(t)]; }
function angles() {
  const c = [video.videoWidth / 2, video.videoHeight / 2], P = {};
  for (const [n, mk] of Object.entries(S.markers)) if (mk.pos) P[n] = rot(mk.pos, c);
  const out = { cva: null, wat: null };
  if (P.tragus && P.c7) out.cva = Math.atan2(P.c7[1] - P.tragus[1], (P.tragus[0] - P.c7[0]) * S.facing) * 180 / Math.PI;
  if (P.tragus && P.acromion) out.wat = Math.atan2((P.tragus[0] - P.acromion[0]) * S.facing, P.acromion[1] - P.tragus[1]) * 180 / Math.PI;
  return out;
}

// ---------------------------------------------------------------- 表示
function layout() {
  const r = overlay.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  overlay.width = Math.round(r.width * dpr); overlay.height = Math.round(r.height * dpr);
  const vw = video.videoWidth || 1, vh = video.videoHeight || 1, s = Math.min(r.width / vw, r.height / vh);
  S.view = { s, ox: (r.width - vw * s) / 2, oy: (r.height - vh * s) / 2, dpr };
}
function toVideo(ev) { const r = overlay.getBoundingClientRect(), v = S.view; return [(ev.clientX - r.left - v.ox) / v.s, (ev.clientY - r.top - v.oy) / v.s]; }
function draw(ang) {
  const v = S.view; if (!v) return;
  octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, overlay.width, overlay.height);
  octx.setTransform(v.dpr * v.s, 0, 0, v.dpr * v.s, v.dpr * v.ox, v.dpr * v.oy);
  const lw = 2 / v.s, img = S.phase === 'frozen' ? S.snapImg : S.img;
  if (S.showMask && img) {
    const { width: W, height: H, data } = img, md = new ImageData(W, H);
    for (const mk of Object.values(S.markers)) for (let i = 0; i < data.length; i += 4) if (matches(data, i, mk.color)) { md.data[i] = 255; md.data[i + 2] = 255; md.data[i + 3] = 150; }
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H; tmp.getContext('2d').putImageData(md, 0, 0);
    octx.drawImage(tmp, 0, 0, video.videoWidth, video.videoHeight);
  }
  const T = S.markers.tragus?.pos, C = S.markers.c7?.pos;
  if (T && C && ang.cva !== null) {
    const r = Math.hypot(T[0] - C[0], T[1] - C[1]), a0 = (S.facing > 0 ? S.roll : 180 + S.roll) * Math.PI / 180;
    const a1 = a0 + (S.facing > 0 ? -1 : 1) * ang.cva * Math.PI / 180;
    octx.fillStyle = 'rgba(240,120,40,.35)'; octx.beginPath(); octx.moveTo(C[0], C[1]); octx.arc(C[0], C[1], r, Math.min(a0, a1), Math.max(a0, a1)); octx.closePath(); octx.fill();
    octx.strokeStyle = '#e0352b'; octx.lineWidth = lw;
    octx.beginPath(); octx.moveTo(C[0], C[1]); octx.lineTo(C[0] + 1.3 * r * Math.cos(a0), C[1] + 1.3 * r * Math.sin(a0)); octx.stroke();
    octx.beginPath(); octx.moveTo(C[0], C[1]); octx.lineTo(T[0], T[1]); octx.stroke();
  }
  for (const [n, mk] of Object.entries(S.markers)) {
    const p = mk.pos || [mk.prev[0] / S.k, mk.prev[1] / S.k];
    octx.strokeStyle = mk.pos ? RING[n] : '#999'; octx.lineWidth = 2.5 * lw;
    octx.beginPath(); octx.arc(p[0], p[1], Math.max(8 / v.s, mk.rad / S.k * 1.3), 0, Math.PI * 2); octx.stroke();
  }
  if (S.level.length) {
    octx.fillStyle = '#ffd34d'; S.level.forEach(p => { octx.beginPath(); octx.arc(p[0], p[1], 6 / v.s, 0, Math.PI * 2); octx.fill(); });
    if (S.level.length === 2) { octx.strokeStyle = '#ffd34d'; octx.lineWidth = lw; octx.beginPath(); octx.moveTo(...S.level[0]); octx.lineTo(...S.level[1]); octx.stroke(); }
  }
}
function readouts(ang) {
  $('cvaValue').textContent = ang.cva === null ? '—' : ang.cva.toFixed(1) + '°';
  $('watValue').textContent = ang.wat === null ? '—' : ang.wat.toFixed(1) + '°';
  const chip = (id, n) => { const mk = S.markers[n]; $(id).textContent = `${NAMES[n]}：${!mk ? '未設定' : mk.pos ? '検出' : (S.phase === 'recording' ? '見失い' : '設定済み')}`; };
  chip('chipT', 'tragus'); chip('chipC', 'c7'); chip('chipA', 'acromion');
  $('chipFps').textContent = S.phase === 'frozen' ? '写真' : `${S.fps.toFixed(0)} fps`;
  $('chipTilt').textContent = S.tilt === null ? '端末の傾き：—' : `端末の傾き：${S.tilt.toFixed(1)}°`;
  $('modeLabel').textContent = { idle: '待機中', live: 'ライブ映像', frozen: '撮影した写真（タップで指定）', countdown: 'まもなく記録開始', recording: `記録中：${S.label}` }[S.phase];
}
function setPhase(p) {
  S.phase = p;
  const frozen = p === 'frozen', busy = p === 'recording' || p === 'countdown';
  snap.hidden = !frozen; video.style.visibility = frozen ? 'hidden' : 'visible';
  $('tapPanel').hidden = !frozen;
  $('snapBtn').disabled = !(p === 'live' || frozen);
  $('retakeBtn').disabled = !frozen;
  $('recBtn').disabled = !(busy || (frozen && S.markers.tragus && S.markers.c7));
  $('recBtn').textContent = busy ? '記録停止' : '記録スタート';
  $('syncBtn').disabled = p !== 'recording';
}

// ---------------------------------------------------------------- フレーム処理
function grab() {
  const vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return null;
  const k = S.procLong / Math.max(vw, vh);
  if (S.k !== k) { for (const mk of Object.values(S.markers)) { mk.prev = [mk.prev[0] * k / S.k, mk.prev[1] * k / S.k]; mk.rad *= k / S.k; } S.k = k; }
  const pw = Math.round(vw * k), ph = Math.round(vh * k);
  if (proc.width !== pw || proc.height !== ph) { proc.width = pw; proc.height = ph; layout(); }
  pctx.drawImage(video, 0, 0, pw, ph);
  return pctx.getImageData(0, 0, pw, ph);
}
function loop(now, meta) {
  if (!S.running) return;
  if (S.phase !== 'frozen') {
    const img = grab();
    if (img) {
      S.img = img;
      const rec = S.phase === 'recording';
      if (rec) track(); else for (const mk of Object.values(S.markers)) mk.pos = null;
      const ang = rec ? angles() : { cva: null, wat: null };
      draw(ang); readouts(ang);
      const t = performance.now(); if (S.lastT) S.fps = 0.9 * S.fps + 0.1 * (1000 / (t - S.lastT)); S.lastT = t; S.frame++;
      if (rec) record(t, meta, ang);
    }
  }
  video.requestVideoFrameCallback ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(t => loop(t, null));
}
function record(t, meta, ang) {
  const cap = meta && meta.captureTime ? meta.captureTime : null;
  const row = { epoch_ms: +(performance.timeOrigin + t).toFixed(1), perf_ms: +t.toFixed(1), capture_perf_ms: cap === null ? '' : +cap.toFixed(1), media_time_s: meta ? +meta.mediaTime.toFixed(4) : '', frame: S.frame, label: S.label };
  for (const n of ['tragus', 'c7', 'acromion']) {
    const mk = S.markers[n];
    row[`${n}_x`] = mk && mk.pos ? +mk.pos[0].toFixed(2) : ''; row[`${n}_y`] = mk && mk.pos ? +mk.pos[1].toFixed(2) : ''; row[`${n}_area`] = mk && mk.pos ? Math.round(mk.area) : '';
  }
  row.cva_deg = ang.cva === null ? '' : +ang.cva.toFixed(2); row.watanabe_deg = ang.wat === null ? '' : +ang.wat.toFixed(2);
  row.valid = ang.cva === null ? 0 : 1; row.device_tilt_deg = S.tilt === null ? '' : +S.tilt.toFixed(2);
  S.rec.rows.push(row);
  if (S.rec.rows.length % 15 === 0) $('recStatus').textContent = `記録中：${S.rec.rows.length}行（${((t - S.rec.t0) / 1000).toFixed(0)}秒）・${S.label}`;
}

// ---------------------------------------------------------------- 操作
async function start() {
  beep(440, 1);   // iOSで音を鳴らせるよう、ユーザー操作の中で初期化
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (e) { setStatus('カメラを開始できません：' + e.message, true); return; }
  video.srcObject = S.stream; await video.play();
  $('previewHint').hidden = true; S.running = true; layout(); setPhase('live');
  $('startBtn').disabled = true; $('stopBtn').disabled = false;
  const st = S.stream.getVideoTracks()[0].getSettings();
  setStatus(`内カメラ：${st.width}×${st.height}、${st.frameRate ? st.frameRate.toFixed(0) : '?'} fps。画面は左右反転していません（記録と同じ向き）。`);
  try { if ('wakeLock' in navigator) S.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) await DeviceMotionEvent.requestPermission();
    addEventListener('devicemotion', e => {
      const g = e.accelerationIncludingGravity; if (!g || g.x === null) return;
      const a = Math.atan2(g.x, g.y) * 180 / Math.PI; S.tilt = ((a + 45) % 90 + 90) % 90 - 45;   // 縦・横の軸からのずれ
    });
  } catch (e) {}
  video.requestVideoFrameCallback ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(t => loop(t, null));
}
function stopCamera() {
  if (S.phase === 'recording' || S.phase === 'countdown') stopRec('カメラを停止したため記録を停止しました。');
  S.running = false; if (S.stream) S.stream.getTracks().forEach(t => t.stop());
  $('startBtn').disabled = false; $('stopBtn').disabled = true; setPhase('idle'); setStatus('カメラを停止しました。');
}
function setStatus(m, err) { $('status').textContent = m; $('status').classList.toggle('error', !!err); }

function takeSnapshot() {
  if (S.phase === 'frozen') setPhase('live');
  $('snapBtn').disabled = true; $('retakeBtn').disabled = true;
  const sec = +$('snapTimer').value;
  if (sec) say('撮影します。正面を見て、楽な姿勢でいてください');
  countdown(sec, () => {
    const img = grab(); if (!img) return;
    S.snapImg = img; S.img = img;
    snap.width = video.videoWidth; snap.height = video.videoHeight; snap.getContext('2d').drawImage(video, 0, 0);
    S.markers = {}; S.level = []; S.roll = 0;
    setPhase('frozen'); selectTarget('tragus'); draw({ cva: null, wat: null }); readouts({ cva: null, wat: null });
    say('撮影しました。写真のマーカーをタップしてください');
    setStatus('撮影しました。写真の中の耳珠のマーカーをタップしてください。');
  });
}
function onTap(ev) {
  if (S.phase !== 'frozen' || !S.snapImg) return;
  const [x, y] = toVideo(ev);
  if (x < 0 || y < 0 || x > video.videoWidth || y > video.videoHeight) return;
  if (S.target === 'level') {
    if (S.level.length >= 2) S.level = [];
    S.level.push([x, y]);
    if (S.level.length === 2) { let [p, q] = S.level; if (q[0] < p[0]) [p, q] = [q, p]; S.roll = Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI; setStatus(`水平線を設定しました。傾き補正：${S.roll.toFixed(2)}°`); }
    redrawSnap(); return;
  }
  const px = Math.round(x * S.k), py = Math.round(y * S.k), color = sampleColor(S.snapImg, px, py);
  const b = findBlob(S.snapImg, color, px, py, 40, 1);              // 写真の上で実際に検出できるか確かめる
  if (!b) { setStatus(`${NAMES[S.target]}の色を検出できません。マーカーの中心をタップし直してください。`, true); return; }
  S.markers[S.target] = { color, prev: [b.x, b.y], rad: Math.sqrt(b.area / Math.PI), lost: 0, pos: [b.x / S.k, b.y / S.k], area: b.area / (S.k * S.k), snapPos: [b.x / S.k, b.y / S.k] };
  if (S.markers.tragus && S.markers.c7) S.facing = S.markers.tragus.prev[0] > S.markers.c7.prev[0] ? 1 : -1;
  const done = NAMES[S.target];
  const order = ['tragus', 'c7', 'acromion'], i = order.indexOf(S.target);
  if (i >= 0 && i < 2) selectTarget(order[i + 1]); else hint();
  setPhase('frozen'); redrawSnap();
  if (!(S.markers.tragus && S.markers.c7)) setStatus(`${done}を設定しました（色相 ${color.h.toFixed(0)}°、彩度 ${(color.s * 100).toFixed(0)}%）。`);
}
function redrawSnap() { S.img = S.snapImg; const ang = angles(); draw(ang); readouts(ang); if (ang.cva !== null) setStatus(`写真でのCVA：${ang.cva.toFixed(1)}°。問題なければ「記録スタート」を押してください。`); }
function selectTarget(t) { S.target = t; document.querySelectorAll('[data-target]').forEach(b => b.classList.toggle('sel', b.dataset.target === t)); hint(); }
function hint() { $('tapHint').textContent = S.target === 'level' ? '壁の水平なテープなど、本当に水平な線の上を2点タップしてください。' : `${NAMES[S.target]}のマーカーをタップしてください。`; }

function ev(type, extra = {}) { const t = performance.now(); return { type, epoch_ms: +(performance.timeOrigin + t).toFixed(1), perf_ms: +t.toFixed(1), label: S.label, ...extra }; }
function setLabel(l, log = true) {
  S.label = l; document.querySelectorAll('[data-label]').forEach(x => x.classList.toggle('sel', x.dataset.label === l));
  if (log && S.rec) S.rec.events.push(ev('label', { label: l }));
}
function startRec() {
  for (const mk of Object.values(S.markers)) { mk.lost = 0; mk.prev = [mk.snapPos[0] * S.k, mk.snapPos[1] * S.k]; }
  setPhase('countdown');
  const auto = $('protocol').value === 'auto', hold = Math.max(3, +$('holdSec').value || 10) * 1000, sec = +$('recTimer').value;
  if (sec) say('記録を始めます。写真と同じ位置で、正面を向いてください');
  countdown(sec, () => {
    S.rec = { rows: [], events: [], t0: performance.now(), startedAt: new Date().toISOString(), protocol: auto ? { steps: PROTOCOL, holdMs: hold } : null };
    setLabel(auto ? '基準' : S.label, false); S.rec.events.push(ev('record_start'));
    setPhase('recording'); $('recStatus').classList.add('on'); $('recStatus').textContent = '記録中…';
    if (!auto) return;
    // 自動の案内：うなずき → 各姿勢 → うなずき → 終了
    const nod = (at, tag) => S.timers.push(setTimeout(() => { say('素早く1回うなずいてください'); beep(1000, 200); if (S.rec) S.rec.events.push(ev('sync_cue', { which: tag })); }, at));
    nod(0, 'start');
    PROTOCOL.forEach((l, i) => S.timers.push(setTimeout(() => { setLabel(l); say(SAY[l]); beep(880, 150); }, 3000 + i * hold)));
    const end = 3000 + PROTOCOL.length * hold;
    nod(end, 'end');
    S.timers.push(setTimeout(() => stopRec('自動の案内が終わりました。保存してください。'), end + 3000));
  });
}
function stopRec(msg) {
  S.timers.forEach(id => { clearTimeout(id); clearInterval(id); }); S.timers = []; $('countdown').hidden = true;
  if (S.rec) {
    S.rec.events.push(ev('record_stop')); S.rec.stoppedAt = new Date().toISOString(); S.last = S.rec; S.rec = null;
    $('csvBtn').disabled = $('jsonBtn').disabled = false;
    const v = S.last.rows.filter(r => r.valid).length;
    $('recStatus').textContent = `${msg || '記録を停止しました。'}（${S.last.rows.length}行、CVAが求まった割合 ${(v / Math.max(1, S.last.rows.length) * 100).toFixed(0)}%）`;
    say('記録を終了しました'); beep(520, 300);
  }
  $('recStatus').classList.remove('on');
  setPhase('live');
}
function meta() {
  const st = S.stream ? S.stream.getVideoTracks()[0].getSettings() : {};
  return {
    app: 'cva-camera', version: VERSION, camera: 'user (front)', createdAt: S.last.startedAt, stoppedAt: S.last.stoppedAt,
    timeOrigin: performance.timeOrigin, userAgent: navigator.userAgent,
    video: { width: video.videoWidth, height: video.videoHeight, settings: st, mirrored: false },
    processing: { longSide: S.procLong, minArea: S.minArea }, protocol: S.last.protocol,
    facing: S.facing > 0 ? 'right' : 'left', rollDeg: S.roll, levelPoints: S.level,
    markers: Object.fromEntries(Object.entries(S.markers).map(([n, m]) => [n, { color: m.color, snapshotPosition: m.snapPos }])),
    units: { epoch_ms: 'Unix時刻[ms] = performance.timeOrigin + perf_ms（posture-lab の meta.timeOrigin + t と同じ基準）', coords: '映像の画素（左上が原点、左右反転なし）', angles: '度' },
    definitions: { cva: 'C7を通る水平線と C7→耳珠 のなす角（画像の傾きを補正）', watanabe: '肩峰→耳珠 と鉛直線のなす角（前傾が正）' },
  };
}
function save(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const fileId = () => 'cva-' + S.last.startedAt.replace(/[:.]/g, '-');
function toCSV(rows) { if (!rows.length) return ''; const k = Object.keys(rows[0]); return '﻿' + [k.join(','), ...rows.map(r => k.map(x => r[x]).join(','))].join('\n'); }

// ---------------------------------------------------------------- 結線
$('startBtn').onclick = start; $('stopBtn').onclick = stopCamera;
$('snapBtn').onclick = takeSnapshot; $('retakeBtn').onclick = takeSnapshot;
overlay.addEventListener('pointerdown', onTap);
document.querySelectorAll('[data-target]').forEach(b => b.onclick = () => selectTarget(b.dataset.target));
document.querySelectorAll('[data-label]').forEach(b => b.onclick = () => setLabel(b.dataset.label));
$('recBtn').onclick = () => (S.phase === 'recording' || S.phase === 'countdown') ? stopRec() : startRec();
$('syncBtn').onclick = () => { if (S.rec) { S.rec.events.push(ev('sync')); setStatus('同期の合図を記録しました。'); } };
$('protocol').onchange = e => { $('protocolNote').textContent = e.target.value === 'auto' ? '自動：うなずき → 基準 → うつむく → 顎を突き出す → 目線だけ下げる → 基準 → うなずき の順に、音声で案内して自動で終わります。' : '手動：姿勢を変えるたびにラベルを押してください。記録停止も手動です。'; };
$('csvBtn').onclick = () => save(fileId() + '.csv', toCSV(S.last.rows), 'text/csv');
$('jsonBtn').onclick = () => save(fileId() + '.json', JSON.stringify({ meta: meta(), events: S.last.events, rows: S.last.rows }), 'application/json');
$('maskBtn').onclick = () => { S.showMask = !S.showMask; $('maskBtn').textContent = S.showMask ? '検出範囲の表示を消す' : '色の検出範囲を表示'; if (S.phase === 'frozen') redrawSnap(); };
$('resetBtn').onclick = () => { S.markers = {}; S.level = []; S.roll = 0; selectTarget('tragus'); if (S.phase === 'frozen') { setPhase('frozen'); redrawSnap(); } };
const bind = (id, key) => { $(id).oninput = e => { S[key] = +e.target.value; $(id + 'V').textContent = e.target.value; if (key === 'hTol') Object.values(S.markers).forEach(m => m.color.hTol = S.hTol); }; };
bind('hTol', 'hTol'); bind('minArea', 'minArea'); bind('proc', 'procLong');
addEventListener('resize', () => { layout(); if (S.phase === 'frozen') redrawSnap(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && (S.phase === 'recording' || S.phase === 'countdown')) stopRec('画面が非表示になったため記録を停止しました。保存してください。'); });
window.__cva = S;   // 動作確認用
