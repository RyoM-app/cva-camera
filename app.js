'use strict';
// CVAカメラ 0.3.0 — 1人で使える側面CVA計測
// 流れ：カメラを開始 → セルフタイマーで1枚撮影 → 写真の上でマーカーをタップ → 記録スタート（ライブ映像で追跡）
// 0.3.0：案内中・移行中のラベル、うなずきの自動検出、重力センサーによる傾き補正、外カメラ、映像の保存（任意）
// 0.4.0：姿勢の間に基準を挟む、posture-labとの同時計測用の案内、色の判定を厳しく（マーカー自身の色の幅から決める）、大きさの急変を除外、色の重なりの警告
// 角度の定義は cva_tracker.py（Python版）と同じ。
const VERSION = '0.4.0';
const $ = id => document.getElementById(id);
const video = $('video'), snap = $('snap'), overlay = $('overlay'), octx = overlay.getContext('2d');
const proc = document.createElement('canvas'), pctx = proc.getContext('2d', { willReadFrequently: true });
const comp = document.createElement('canvas'), cctx = comp.getContext('2d');   // 映像の保存用（計測結果を重ねる）
const NAMES = { tragus: '耳珠', c7: 'C7', acromion: '肩峰' };
// 案内の手順。姿勢と姿勢の間には必ず「基準」（頭を楽な位置に戻す）を挟む
const BACK = '頭を楽な位置に戻して、正面を見てください';
const PRESETS = {
  basic: [
    ['基準', '楽な姿勢で、正面を見てください'],
    ['うつむく', 'スマホを見るように、うつむいてください'], ['基準', BACK],
    ['顎を突き出す', '顎を前に突き出してください'], ['基準', BACK],
    ['目線だけ下げる', '頭は楽な位置のまま、目線だけを下げてください'], ['基準', BACK],
  ],
  dual: [   // posture-labのスマホを手に持って同時に計測するとき
    ['基準', 'スマホを目の高さに持ち、頭を楽な位置にして、画面を見てください'],
    ['うつむく', 'スマホを胸の高さに下げて、うつむいて画面を見てください'], ['基準', 'スマホを目の高さに戻し、頭を楽な位置に戻してください'],
    ['顎を突き出す', 'スマホを胸の高さに下げて、顎を前に突き出して画面を見てください'], ['基準', 'スマホを目の高さに戻し、頭を楽な位置に戻してください'],
    ['目線だけ下げる', 'スマホを胸の高さに下げて、頭は動かさず、目線だけで画面を見てください'], ['基準', 'スマホを目の高さに戻し、頭を楽な位置に戻してください'],
    ['端末だけ動かす', '頭は動かさず、スマホだけをゆっくり上下に動かしてください'], ['基準', 'スマホを目の高さに戻し、頭を楽な位置に戻してください'],
  ],
};
let PROTOCOL = PRESETS.basic.map(x => x[0]), SAYS = PRESETS.basic.map(x => x[1]);
const NOD = { drop: 6, back: 3, startMax: 8000, endMax: 12000, after: 1500 };   // うなずき：基準から6°以上下がり、3°以内に戻ったら検出

const S = {
  stream: null, running: false, phase: 'idle',   // idle | live | frozen | countdown | recording
  cam: 'user', target: 'tragus', label: '基準', showMask: false,
  stage: 'manual', rowLabel: '基準', step: -1,    // 記録中の区間（prep | nod | guide | transition | hold | manual）
  markers: {}, level: [], roll: 0, rollSrc: 'none', sensorRoll: null, snapGrav: null, facing: 1,
  grav: null, gravHist: [], devRoll: null, devPitch: null, lastMotion: 0,
  k: 1, img: null, snapImg: null, fps: 0, lastT: 0, frame: 0,
  rec: null, last: null, timers: [], nodWatch: null, vr: null, lastVideo: null,
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
// 読み上げが終わるまで待つ（終わりの通知が来ない端末に備えて、文の長さから上限を決める）
function sayWait(text) {
  const t0 = performance.now();
  return new Promise(res => {
    let done = false; const fin = () => { if (!done) { done = true; res(); } };
    try { const u = new SpeechSynthesisUtterance(text); u.lang = 'ja-JP'; u.onend = fin; u.onerror = fin; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) { fin(); }
    S.timers.push(setTimeout(fin, 1000 + text.length * 250));
  }).then(() => sleep(Math.max(0, t0 + text.length * 110 - performance.now())));   // 終わりの通知が早すぎる端末でも、読み上げにかかる時間は案内中にする
}
const sleep = ms => new Promise(r => S.timers.push(setTimeout(r, ms)));
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

// ---------------------------------------------------------------- 重力センサー（端末の傾き）
// 端末の座標（x：画面の右、y：画面の上、z：画面の手前）での重力の反力 g から、
//   左右の傾き θ = atan2(-gx, gy)（画面を見て時計回りが正）、前後の傾き = atan2(gz, gy)（画面が上を向くほど正）
// 内カメラ（左右反転なし）の画像では、本当の水平線が θ だけ傾いて写る。外カメラでは -θ。
function onGrav(x, y, z, src) {
  if (x === null || y === null || x === undefined) return;
  let gx = x, gy = y, gz = z || 0;
  if (gy < 0) { gx = -gx; gy = -gy; gz = -gz; }   // 符号が逆の端末（一部のiOS）でも、端末を縦に立てている前提で揃える
  const t = performance.now();
  S.grav = { x: +x, y: +y, z: +(z || 0), src };
  S.devRoll = Math.atan2(-gx, gy) * 180 / Math.PI;
  S.devPitch = Math.atan2(gz, gy) * 180 / Math.PI;
  S.gravHist.push([t, S.devRoll]); while (S.gravHist.length && S.gravHist[0][0] < t - 2000) S.gravHist.shift();
}
function sensorImgRoll(devRoll) { return devRoll === null ? null : (S.cam === 'user' ? devRoll : -devRoll); }
function meanRoll(ms = 1000) {
  const t = performance.now(), v = S.gravHist.filter(h => h[0] >= t - ms).map(h => h[1]);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
let sensorsOn = false;
async function startSensors() {
  try { if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) await DeviceMotionEvent.requestPermission(); } catch (e) {}
  try { if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) await DeviceOrientationEvent.requestPermission(); } catch (e) {}
  if (sensorsOn) return; sensorsOn = true;
  addEventListener('devicemotion', e => {
    const g = e.accelerationIncludingGravity; if (!g || g.x === null || g.y === null) return;
    if (g.x === 0 && g.y === 0 && (g.z === 0 || g.z === null)) return;   // 値が来ていない
    S.lastMotion = performance.now(); onGrav(g.x, g.y, g.z, 'devicemotion');
  });
  addEventListener('deviceorientation', e => {   // 加速度が使えない端末の代わり
    if (performance.now() - S.lastMotion < 500 || e.beta === null || e.gamma === null) return;
    const b = e.beta * Math.PI / 180, c = e.gamma * Math.PI / 180;
    onGrav(-9.81 * Math.cos(b) * Math.sin(c), 9.81 * Math.sin(b), 9.81 * Math.cos(b) * Math.cos(c), 'deviceorientation');
  });
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

// マーカー自身の画素から色の幅を決める（肌や背景を拾いにくくする）
function hsvStats(img, c, cx, cy, r, keepTop = 1) {   // (cx,cy)から半径rで色cに合う画素の色の統計。keepTop：彩度の高い順に使う割合
  const { width: W, height: H, data } = img, px = [];
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++) {
      if (Math.hypot(x - cx, y - cy) > r) continue;
      const i = (y * W + x) * 4; if (c && !matches(data, i, c)) continue;
      px.push(rgb2hsv(data[i], data[i + 1], data[i + 2]));
    }
  px.sort((a, b) => b[1] - a[1]); const use = px.slice(0, Math.max(1, Math.ceil(px.length * keepTop)));
  if (use.length < 5) return null;
  const hs = use.map(p => p[0]), ss = use.map(p => p[1]), vs = use.map(p => p[2]);
  const sx = hs.reduce((a, h) => a + Math.cos(h * Math.PI / 180), 0), sy = hs.reduce((a, h) => a + Math.sin(h * Math.PI / 180), 0);
  let h = Math.atan2(sy, sx) * 180 / Math.PI; if (h < 0) h += 360;
  const pct = (a, q) => { const t = [...a].sort((p, q2) => p - q2); return t[Math.min(t.length - 1, Math.floor(q * t.length))]; };
  const dev = hs.map(x => { const d = Math.abs(x - h); return Math.min(d, 360 - d); });
  const hAuto = Math.max(8, Math.min(30, 1.5 * pct(dev, 0.9) + 4));
  return { h, s: pct(ss, 0.5), v: pct(vs, 0.5), hAuto, hTol: Math.min(S.hTol, hAuto), sMin: Math.max(0.35, pct(ss, 0.1) - 0.08), vMin: Math.max(0.2, pct(vs, 0.1) - 0.15) };
}
// マーカー自身の画素から色の幅を決める（肌や背景を拾いにくくする）
// ① タップ位置の近く（半径5画素）で、彩度の高い半分だけを使って色を決める（マーカーは肌より鮮やか）
// ② その色で塊を探し、塊の内側の画素で色を決め直す
function markerColor(img, px, py) {
  const c0 = sampleColor(img, px, py);
  let c1 = hsvStats(img, c0, px, py, 5, 0.5) || { ...c0, hAuto: c0.hTol };
  let b = findBlob(img, c1, px, py, 40, 1); if (!b) { b = findBlob(img, c0, px, py, 40, 1); if (!b) return null; c1 = { ...c0, hAuto: c0.hTol }; }
  const c2 = hsvStats(img, c1, b.x, b.y, Math.max(2, 0.8 * Math.sqrt(b.area / Math.PI)), 1);
  const color = c2 || c1;
  const b2 = findBlob(img, color, b.x, b.y, 40, 1) || b;
  return { color, blob: b2 };
}
// 同じ色が、マーカー以外（肌・服・背景）にどれだけあるか。マーカーの面積に対する比
function colorClash(img, color, blob) {
  const { width: W, height: H, data } = img, r = 2.5 * Math.sqrt(blob.area / Math.PI) + 3; let n = 0;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    if (Math.hypot(x - blob.x, y - blob.y) < r) continue;
    if (matches(data, (y * W + x) * 4, color)) n += 4;
  }
  return n / blob.area;
}

// ---------------------------------------------------------------- 検出
function findBlob(img, c, cx, cy, R, step = 1, aRef = 0) {   // aRef：期待する大きさ。0.3〜3倍の外は除外し、近い大きさを優先
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
    if (aRef && (area < 0.3 * aRef || area > 3 * aRef)) continue;
    const bx = x0 + (sx / a) * step, by = y0 + (sy / a) * step, d = Math.hypot(bx - cx, by - cy);
    const size = aRef ? -8 * Math.abs(Math.log(area / aRef)) : 0.02 * area;
    const score = step === 1 ? -d + size : (aRef ? size : area);
    if (score > bestScore) { bestScore = score; best = { x: bx, y: by, area }; }
  }
  return best;
}
function track() {
  for (const mk of Object.values(S.markers)) {
    const aRef = mk.aRef * S.k * S.k;   // 期待する大きさ（処理画素）
    let b = findBlob(S.img, mk.color, mk.prev[0], mk.prev[1], Math.max(25, mk.rad * 4), 1, aRef);
    if (!b && mk.lost >= 3) b = findBlob(S.img, mk.color, mk.prev[0], mk.prev[1], Math.max(S.img.width, S.img.height), 2, aRef);
    if (b) {
      mk.prev = [b.x, b.y]; mk.rad = 0.7 * mk.rad + 0.3 * Math.sqrt(b.area / Math.PI); mk.lost = 0; mk.pos = [b.x / S.k, b.y / S.k]; mk.area = b.area / (S.k * S.k);
      mk.aRef = 0.95 * mk.aRef + 0.05 * mk.area; mk.found++;
    } else { mk.lost++; mk.pos = null; mk.area = null; }
    mk.frames++;
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
function hline(ctx, deg, color, lw, dash) {   // 画像の中心を通り、deg だけ傾いた線
  const W = video.videoWidth, H = video.videoHeight, a = deg * Math.PI / 180, L = Math.hypot(W, H);
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.setLineDash(dash);
  ctx.beginPath(); ctx.moveTo(W / 2 - L * Math.cos(a), H / 2 - L * Math.sin(a)); ctx.lineTo(W / 2 + L * Math.cos(a), H / 2 + L * Math.sin(a)); ctx.stroke(); ctx.restore();
}
function draw(ang) {
  const v = S.view; if (!v) return;
  octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, overlay.width, overlay.height);
  octx.setTransform(v.dpr * v.s, 0, 0, v.dpr * v.s, v.dpr * v.ox, v.dpr * v.oy);
  const lw = 2 / v.s, img = S.phase === 'frozen' ? S.snapImg : S.img;
  // センサーから求めた水平線（点線）：撮影前はいまの傾き、写真では補正に使う傾き
  const sr = S.phase === 'live' ? sensorImgRoll(S.devRoll) : S.phase === 'frozen' ? sensorImgRoll(S.sensorRoll) : null;
  if (sr !== null) hline(octx, sr, 'rgba(80,220,255,.9)', lw, [10 / v.s, 8 / v.s]);
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
    // 扇形と線も白と黒（マーカーの色と混ざらないように）
    octx.fillStyle = 'rgba(255,255,255,.35)'; octx.beginPath(); octx.moveTo(C[0], C[1]); octx.arc(C[0], C[1], r, Math.min(a0, a1), Math.max(a0, a1)); octx.closePath(); octx.fill();
    const seg = (x1, y1, x2, y2) => { for (const [w, c] of [[3.5 * lw, 'rgba(0,0,0,.7)'], [1.6 * lw, '#fff']]) { octx.strokeStyle = c; octx.lineWidth = w; octx.beginPath(); octx.moveTo(x1, y1); octx.lineTo(x2, y2); octx.stroke(); } };
    seg(C[0], C[1], C[0] + 1.3 * r * Math.cos(a0), C[1] + 1.3 * r * Math.sin(a0)); seg(C[0], C[1], T[0], T[1]);
  }
  for (const [n, mk] of Object.entries(S.markers)) {   // 円は白と黒で描く（保存した映像を後で解析しても、マーカーの色と混ざらない）
    const p = mk.pos || [mk.prev[0] / S.k, mk.prev[1] / S.k], rr = Math.max(8 / v.s, mk.rad / S.k * 1.3);
    octx.lineWidth = 4 * lw; octx.strokeStyle = 'rgba(0,0,0,.75)'; octx.beginPath(); octx.arc(p[0], p[1], rr, 0, Math.PI * 2); octx.stroke();
    octx.lineWidth = 2 * lw; octx.strokeStyle = mk.pos ? '#ffffff' : '#888888'; octx.setLineDash(mk.pos ? [] : [6 / v.s, 5 / v.s]); octx.beginPath(); octx.arc(p[0], p[1], rr, 0, Math.PI * 2); octx.stroke(); octx.setLineDash([]);
    const fs = 12 / v.s; octx.font = `700 ${fs}px system-ui, sans-serif`; const tw = octx.measureText(NAMES[n]).width, tx = p[0] + rr + 3 / v.s, ty = p[1] - rr;
    octx.fillStyle = 'rgba(0,0,0,.6)'; octx.fillRect(tx - 2 / v.s, ty - fs, tw + 4 / v.s, fs * 1.3); octx.fillStyle = '#fff'; octx.fillText(NAMES[n], tx, ty);
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
  $('chipTilt').textContent = S.devRoll === null ? '端末の傾き：センサーなし' : `端末の傾き：左右 ${S.devRoll.toFixed(1)}°・前後 ${S.devPitch.toFixed(1)}°`;
  $('chipTilt').classList.toggle('warn', S.devRoll !== null && (Math.abs(S.devRoll) > 5 || Math.abs(S.devPitch) > 10));
  const tgt = S.rec && S.stage !== 'hold' && S.stage !== 'manual' && S.label && S.step >= 0 && S.step < PROTOCOL.length ? `（次：${PROTOCOL[S.step]}）` : '';
  $('modeLabel').textContent = { idle: '待機中', live: 'ライブ映像', frozen: '撮影した写真（タップで指定）', countdown: 'まもなく記録開始', recording: `記録中：${S.rowLabel}${tgt}` }[S.phase];
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
  $('camSel').disabled = $('vidMode').disabled = busy;
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
      if (rec) { record(t, meta, ang); watchNod(t, ang.cva); }
      if (S.vr && S.vr.mode === 'overlay') composite(ang, t);
    }
  }
  video.requestVideoFrameCallback ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(t => loop(t, null));
}
function record(t, meta, ang) {
  const cap = meta && meta.captureTime ? meta.captureTime : null;
  const target = S.stage === 'manual' ? S.label : (S.step >= 0 && S.step < PROTOCOL.length && ['guide', 'transition', 'hold'].includes(S.stage) ? PROTOCOL[S.step] : '');
  const row = { epoch_ms: +(performance.timeOrigin + t).toFixed(1), perf_ms: +t.toFixed(1), capture_perf_ms: cap === null ? '' : +cap.toFixed(1), media_time_s: meta ? +meta.mediaTime.toFixed(4) : '', frame: S.frame,
    label: S.rowLabel, target_label: target, stage: S.stage, step: S.step };
  for (const n of ['tragus', 'c7', 'acromion']) {
    const mk = S.markers[n];
    row[`${n}_x`] = mk && mk.pos ? +mk.pos[0].toFixed(2) : ''; row[`${n}_y`] = mk && mk.pos ? +mk.pos[1].toFixed(2) : ''; row[`${n}_area`] = mk && mk.pos ? Math.round(mk.area) : '';
  }
  row.cva_deg = ang.cva === null ? '' : +ang.cva.toFixed(2); row.watanabe_deg = ang.wat === null ? '' : +ang.wat.toFixed(2);
  row.valid = ang.cva === null ? 0 : 1;
  row.device_roll_deg = S.devRoll === null ? '' : +S.devRoll.toFixed(2); row.device_pitch_deg = S.devPitch === null ? '' : +S.devPitch.toFixed(2);
  S.rec.rows.push(row);
  if (S.rec.rows.length % 15 === 0) $('recStatus').textContent = `記録中：${S.rec.rows.length}行（${((t - S.rec.t0) / 1000).toFixed(0)}秒）・${S.rowLabel}`;
}

// ---------------------------------------------------------------- うなずきの検出
// 合図の直前1.5秒のCVAの中央値を基準にし、そこから NOD.drop 度以上下がって、NOD.back 度以内に戻ったら検出。
function startNodWatch(which) {
  const t = performance.now(), prev = S.rec.rows.filter(r => r.valid && r.perf_ms >= t - 1500).map(r => r.cva_deg).sort((a, b) => a - b);
  return new Promise(res => { S.nodWatch = { which, t0: t, base: prev.length >= 3 ? prev[prev.length >> 1] : null, min: Infinity, minT: null, deep: false, res }; });
}
function watchNod(t, cva) {
  const w = S.nodWatch; if (!w || cva === null) return;
  if (w.base === null) { w.base = cva; return; }   // 直前のデータがなければ、最初の値を基準にする
  if (cva < w.min) { w.min = cva; w.minT = t; }
  if (w.base - cva >= NOD.drop) w.deep = true;
  if (w.deep && cva >= w.base - NOD.back) {
    S.rec.events.push(ev('nod_detected', { which: w.which, base_cva: +w.base.toFixed(2), min_cva: +w.min.toFixed(2), depth_deg: +(w.base - w.min).toFixed(2),
      min_epoch_ms: +(performance.timeOrigin + w.minT).toFixed(1), latency_ms: Math.round(w.minT - w.t0) }));
    S.nodWatch = null; beep(1400, 80); w.res(true);
  }
}
function nodOrTimeout(which, max) {
  const p = startNodWatch(which);
  return Promise.race([p, sleep(max).then(() => false)]).then(ok => { if (!ok && S.nodWatch) { S.rec?.events.push(ev('nod_timeout', { which })); S.nodWatch = null; } return ok; });
}

// ---------------------------------------------------------------- 映像の保存（任意）
function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  return ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported?.(m)) || '';
}
function startVideo() {
  const mode = $('vidMode').value; S.lastVideo = null; $('videoBtn').disabled = true;
  if (mode === 'none') return;
  const mime = pickMime(); if (mime === null) { setStatus('このブラウザは映像の保存に対応していません。データだけ記録します。', true); return; }
  let stream;
  if (mode === 'overlay') {
    const sc = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    comp.width = Math.round(video.videoWidth * sc); comp.height = Math.round(video.videoHeight * sc);
    stream = comp.captureStream(30);
  } else stream = S.stream;
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 4e6 } : { videoBitsPerSecond: 4e6 }), chunks = [];
  S.vr = { mode, mime: mime || mr.mimeType, mr, chunks, startEpoch: null };
  mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onstart = () => { S.vr.startEpoch = +(performance.timeOrigin + performance.now()).toFixed(1); S.rec?.events.push(ev('video_start', { mode })); };
  mr.start(1000);
}
function stopVideo() {
  const vr = S.vr; if (!vr) return; S.vr = null;
  vr.mr.onstop = () => {
    const type = vr.mime || vr.chunks[0]?.type || 'video/webm', blob = new Blob(vr.chunks, { type });
    S.lastVideo = { blob, ext: type.includes('mp4') ? 'mp4' : 'webm', mode: vr.mode, mime: type, startEpoch: vr.startEpoch, bytes: blob.size };
    $('videoBtn').disabled = false; $('videoBtn').textContent = `映像を保存（${(blob.size / 1e6).toFixed(1)} MB）`;
  };
  try { vr.mr.stop(); } catch (e) {}
}
function composite(ang, t) {
  const v = S.view; if (!v) return;
  const W = comp.width, H = comp.height;
  cctx.drawImage(video, 0, 0, W, H);
  cctx.drawImage(overlay, v.ox * v.dpr, v.oy * v.dpr, video.videoWidth * v.s * v.dpr, video.videoHeight * v.s * v.dpr, 0, 0, W, H);
  const fs = Math.round(Math.max(14, H * 0.032)), lines = [
    `CVA ${ang.cva === null ? '—' : ang.cva.toFixed(1) + '°'}   渡邉角 ${ang.wat === null ? '—' : ang.wat.toFixed(1) + '°'}`,
    `${S.rowLabel}${S.stage === 'guide' || S.stage === 'transition' ? '（次：' + (PROTOCOL[S.step] || '') + '）' : ''}`,
    `${((t - S.rec.t0) / 1000).toFixed(1)} s`];
  cctx.font = `600 ${fs}px system-ui, sans-serif`;
  const bw = Math.max(...lines.map(l => cctx.measureText(l).width)) + fs;
  cctx.fillStyle = 'rgba(0,0,0,.55)'; cctx.fillRect(0, 0, bw, fs * (lines.length + 0.6));
  cctx.fillStyle = '#fff'; lines.forEach((l, i) => cctx.fillText(l, fs / 2, fs * (i + 1.1)));
}

// ---------------------------------------------------------------- 操作
async function start() {
  beep(440, 1);   // iOSで音を鳴らせるよう、ユーザー操作の中で初期化
  await startSensors();   // iOSはユーザー操作の中で許可を求める必要がある
  S.cam = $('camSel').value;
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: S.cam, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (e) { setStatus('カメラを開始できません：' + e.message, true); return; }
  video.srcObject = S.stream; await video.play();
  $('previewHint').hidden = true; S.running = true; layout(); setPhase('live');
  $('startBtn').disabled = true; $('stopBtn').disabled = false;
  const st = S.stream.getVideoTracks()[0].getSettings();
  setStatus(`${S.cam === 'user' ? '内' : '外'}カメラ：${st.width}×${st.height}、${st.frameRate ? st.frameRate.toFixed(0) : '?'} fps。画面は左右反転していません（記録と同じ向き）。水色の点線が、センサーで求めた水平です。`);
  try { if ('wakeLock' in navigator) S.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  video.requestVideoFrameCallback ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(t => loop(t, null));
}
function stopCamera() {
  if (S.phase === 'recording' || S.phase === 'countdown') stopRec('カメラを停止したため記録を停止しました。');
  S.running = false; if (S.stream) S.stream.getTracks().forEach(t => t.stop());
  $('startBtn').disabled = false; $('stopBtn').disabled = true; setPhase('idle'); setStatus('カメラを停止しました。');
}
function setStatus(m, err) { $('status').textContent = m; $('status').classList.toggle('error', !!err); }

function applySensorRoll() {
  if (S.sensorRoll === null) { S.roll = 0; S.rollSrc = 'none'; return; }
  S.roll = sensorImgRoll(S.sensorRoll); S.rollSrc = 'sensor';
}
function rollText() {
  return S.rollSrc === 'sensor' ? `傾き補正：センサー ${S.roll.toFixed(1)}°` : S.rollSrc === 'manual' ? `傾き補正：手動の水平線 ${S.roll.toFixed(1)}°` : '傾き補正：なし（センサーが使えません）';
}
function takeSnapshot() {
  if (S.phase === 'frozen') setPhase('live');
  $('snapBtn').disabled = true; $('retakeBtn').disabled = true;
  const sec = +$('snapTimer').value;
  if (sec) say('撮影します。正面を見て、楽な姿勢でいてください');
  countdown(sec, () => {
    const img = grab(); if (!img) return;
    S.snapImg = img; S.img = img;
    snap.width = video.videoWidth; snap.height = video.videoHeight; snap.getContext('2d').drawImage(video, 0, 0);
    S.markers = {}; S.level = [];
    S.sensorRoll = meanRoll(1000); S.snapGrav = S.grav ? { ...S.grav, devRoll: S.devRoll, devPitch: S.devPitch } : null; applySensorRoll();
    setPhase('frozen'); selectTarget('tragus'); draw({ cva: null, wat: null }); readouts({ cva: null, wat: null });
    say('撮影しました。写真のマーカーをタップしてください');
    setStatus(`撮影しました。${rollText()}。写真の中の耳珠のマーカーをタップしてください。`);
    $('rollInfo').textContent = rollText();
  });
}
function onTap(ev) {
  if (S.phase !== 'frozen' || !S.snapImg) return;
  const [x, y] = toVideo(ev);
  if (x < 0 || y < 0 || x > video.videoWidth || y > video.videoHeight) return;
  if (S.target === 'level') {
    if (S.level.length >= 2) S.level = [];
    S.level.push([x, y]);
    if (S.level.length === 2) { let [p, q] = S.level; if (q[0] < p[0]) [p, q] = [q, p]; S.roll = Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI; S.rollSrc = 'manual'; setStatus(`水平線を設定しました。${rollText()}`); $('rollInfo').textContent = rollText(); }
    redrawSnap(); return;
  }
  const px = Math.round(x * S.k), py = Math.round(y * S.k), mc = markerColor(S.snapImg, px, py);   // 写真の上で実際に検出できるか確かめる
  if (!mc) { setStatus(`${NAMES[S.target]}の色を検出できません。マーカーの中心をタップし直してください。`, true); return; }
  const { color, blob: b } = mc, clash = colorClash(S.snapImg, color, b);
  S.markers[S.target] = { color, clash, prev: [b.x, b.y], rad: Math.sqrt(b.area / Math.PI), lost: 0, found: 0, frames: 0, pos: [b.x / S.k, b.y / S.k], area: b.area / (S.k * S.k), aRef: b.area / (S.k * S.k), snapArea: b.area / (S.k * S.k), snapPos: [b.x / S.k, b.y / S.k] };
  updateClash();
  if (S.markers.tragus && S.markers.c7) S.facing = S.markers.tragus.prev[0] > S.markers.c7.prev[0] ? 1 : -1;
  const done = NAMES[S.target];
  const order = ['tragus', 'c7', 'acromion'], i = order.indexOf(S.target);
  if (i >= 0 && i < 2) selectTarget(order[i + 1]); else hint();
  setPhase('frozen'); redrawSnap();
  if (!(S.markers.tragus && S.markers.c7)) setStatus(`${done}を設定しました（色相 ${color.h.toFixed(0)}°、彩度 ${(color.s * 100).toFixed(0)}%）。`, clash > 0.3);
}
// 色の重なりの警告：マーカーと同じ色が、ほかの場所にマーカーの30%以上あれば知らせる
function updateClash() {
  const bad = Object.entries(S.markers).filter(([, m]) => m.clash > 0.3);
  $('clashInfo').hidden = !bad.length;
  $('clashInfo').textContent = bad.length ? `注意：${bad.map(([n, m]) => `${NAMES[n]}の色が、肌・服・背景にもあります（マーカーの${Math.round(m.clash * 100)}%）`).join('、')}。追跡が外れやすいので、別の色のマーカーに替えるか、色相の許容幅を狭めてください。紫の範囲で確認できます。` : '';
}
function redrawSnap() { S.img = S.snapImg; const ang = angles(); draw(ang); readouts(ang); if (ang.cva !== null) setStatus(`写真でのCVA：${ang.cva.toFixed(1)}°（${rollText()}）。問題なければ「記録スタート」を押してください。`); }
function selectTarget(t) { S.target = t; document.querySelectorAll('[data-target]').forEach(b => b.classList.toggle('sel', b.dataset.target === t)); hint(); }
function hint() { $('tapHint').textContent = S.target === 'level' ? '水色の点線（センサーの水平）がずれているときだけ使います。壁の水平なテープなど、本当に水平な線の上を2点タップしてください。' : `${NAMES[S.target]}のマーカーをタップしてください。`; }

function ev(type, extra = {}) { const t = performance.now(); return { type, epoch_ms: +(performance.timeOrigin + t).toFixed(1), perf_ms: +t.toFixed(1), label: S.rowLabel, ...extra }; }
function setLabel(l, log = true) {   // 手動のラベル
  S.label = l; if (S.stage === 'manual') S.rowLabel = l;
  document.querySelectorAll('[data-label]').forEach(x => x.classList.toggle('sel', x.dataset.label === l));
  if (log && S.rec) S.rec.events.push(ev('label', { label: l }));
}
function setStage(stage, rowLabel, step = S.step) {   // 自動の案内の区間
  S.stage = stage; S.rowLabel = rowLabel; S.step = step;
  if (stage === 'hold') setLabel(PROTOCOL[step], false);
  if (S.rec) S.rec.events.push(ev('stage', { stage, label: rowLabel, step, target_label: step >= 0 && step < PROTOCOL.length ? PROTOCOL[step] : '' }));
}
function startRec() {
  for (const mk of Object.values(S.markers)) { mk.lost = 0; mk.found = 0; mk.frames = 0; mk.aRef = mk.snapArea; mk.prev = [mk.snapPos[0] * S.k, mk.snapPos[1] * S.k]; }
  setPhase('countdown');
  const auto = $('protocol').value === 'auto', hold = Math.max(3, +$('holdSec').value || 10) * 1000, trans = Math.max(0, +$('transSec').value || 0) * 1000, sec = +$('recTimer').value;
  if (sec) say('記録を始めます。写真と同じ位置で、正面を向いてください');
  countdown(sec, () => {
    const preset = $('preset').value; PROTOCOL = PRESETS[preset].map(x => x[0]); SAYS = PRESETS[preset].map(x => x[1]);
    S.rec = { rows: [], events: [], t0: performance.now(), startedAt: new Date().toISOString(), protocol: auto ? { preset, steps: PROTOCOL, guidance: SAYS, holdMs: hold, transitionMs: trans, nod: NOD } : null };
    S.step = -1;
    if (auto) { S.stage = 'prep'; S.rowLabel = '準備'; } else { S.stage = 'manual'; S.rowLabel = S.label; }
    S.rec.events.push(ev('record_start'));
    startVideo();
    setPhase('recording'); $('recStatus').classList.add('on'); $('recStatus').textContent = '記録中…';
    if (auto) runProtocol(hold, trans);
  });
}
// 自動の案内：準備 → うなずき（検出まで）→［案内中 → 移行中 → 姿勢］×5 → うなずき（検出まで）→ 終了
async function runProtocol(hold, trans) {
  const tok = S.rec, alive = () => S.rec === tok;
  setStage('prep', '準備', -1); await sleep(2000); if (!alive()) return;
  setStage('nod', 'うなずき', -1); beep(1000, 200); S.rec.events.push(ev('sync_cue', { which: 'start' })); say('素早く1回うなずいてください');
  await nodOrTimeout('start', NOD.startMax); if (!alive()) return;
  await sleep(NOD.after); if (!alive()) return;
  for (let i = 0; i < PROTOCOL.length; i++) {
    const l = PROTOCOL[i];
    setStage('guide', '案内中', i); beep(880, 150); await sayWait(SAYS[i]); if (!alive()) return;
    if (trans) { setStage('transition', '移行中', i); await sleep(trans); if (!alive()) return; }
    setStage('hold', l, i); await sleep(hold); if (!alive()) return;
  }
  setStage('nod', 'うなずき', PROTOCOL.length); beep(1000, 200); S.rec.events.push(ev('sync_cue', { which: 'end' })); say('最後に、素早く1回うなずいてください');
  const ok = await nodOrTimeout('end', NOD.endMax); if (!alive()) return;
  if (ok) await sleep(NOD.after + 500); if (!alive()) return;
  stopRec(ok ? '最後のうなずきを検出しました。自動の案内が終わりました。保存してください。' : '最後のうなずきを検出できないまま、待ち時間が終わりました。保存してください。');
}
function stopRec(msg) {
  S.timers.forEach(id => { clearTimeout(id); clearInterval(id); }); S.timers = []; $('countdown').hidden = true; S.nodWatch = null;
  if (S.rec) {
    S.rec.events.push(ev('record_stop')); S.rec.stoppedAt = new Date().toISOString(); S.last = S.rec; S.rec = null;
    stopVideo();
    $('csvBtn').disabled = $('jsonBtn').disabled = false;
    const v = S.last.rows.filter(r => r.valid).length, nods = S.last.events.filter(e => e.type === 'nod_detected').length;
    S.last.detection = Object.fromEntries(Object.entries(S.markers).map(([n, m]) => [n, { found: m.found, frames: m.frames, rate: m.frames ? +(m.found / m.frames).toFixed(3) : null, colorClash: +m.clash.toFixed(3) }]));
    const det = Object.entries(S.last.detection).map(([n, d]) => `${NAMES[n]} ${Math.round(100 * (d.rate ?? 0))}%`).join('・');
    $('recStatus').textContent = `${msg || '記録を停止しました。'}（${S.last.rows.length}行、CVAが求まった割合 ${(v / Math.max(1, S.last.rows.length) * 100).toFixed(0)}%、検出：${det}${S.last.protocol ? `、うなずき検出 ${nods}/2` : ''}）`;
    say('記録を終了しました'); beep(520, 300);
  }
  S.stage = 'manual'; S.rowLabel = S.label; S.step = -1;
  $('recStatus').classList.remove('on');
  setPhase('live');
}
function meta() {
  const st = S.stream ? S.stream.getVideoTracks()[0].getSettings() : {};
  return {
    app: 'cva-camera', version: VERSION, camera: S.cam === 'user' ? 'user (front)' : 'environment (rear)', createdAt: S.last.startedAt, stoppedAt: S.last.stoppedAt,
    timeOrigin: performance.timeOrigin, userAgent: navigator.userAgent,
    video: { width: video.videoWidth, height: video.videoHeight, settings: st, mirrored: false },
    processing: { longSide: S.procLong, minArea: S.minArea }, protocol: S.last.protocol,
    facing: S.facing > 0 ? 'right' : 'left',
    roll: { deg: S.roll, source: S.rollSrc, sensorDeviceRollDeg: S.sensorRoll, gravityAtSnapshot: S.snapGrav, levelPoints: S.level,
      note: '端末の左右の傾き θ = atan2(-gx, gy)。内カメラの画像では水平線が θ、外カメラでは -θ 傾く' },
    recordedVideo: S.lastVideo ? { mode: S.lastVideo.mode, mime: S.lastVideo.mime, startEpochMs: S.lastVideo.startEpoch, bytes: S.lastVideo.bytes } : null,
    markers: Object.fromEntries(Object.entries(S.markers).map(([n, m]) => [n, { color: m.color, snapshotPosition: m.snapPos, snapshotArea: m.snapArea, colorClash: m.clash }])),
    detection: S.last.detection,
    columns: { label: '自動：準備・うなずき・案内中・移行中・各姿勢／手動：押したラベル', target_label: 'その区間で目標にしている姿勢', stage: 'prep | nod | guide | transition | hold | manual', step: '姿勢の番号（0から。基準は何度も出てくるので step で区別する）' },
    units: { epoch_ms: 'Unix時刻[ms] = performance.timeOrigin + perf_ms（posture-lab の meta.timeOrigin + t と同じ基準）', coords: '映像の画素（左上が原点、左右反転なし）', angles: '度' },
    definitions: { cva: 'C7を通る水平線と C7→耳珠 のなす角（画像の傾きを補正）', watanabe: '肩峰→耳珠 と鉛直線のなす角（前傾が正）' },
  };
}
function save(name, blobOrText, type) {
  const blob = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
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
function protocolNote() {
  if ($('protocol').value !== 'auto') { $('protocolNote').textContent = '手動：姿勢を変えるたびにラベルを押してください。記録停止も手動です。'; return; }
  const steps = PRESETS[$('preset').value].map(x => x[0]);
  $('protocolNote').textContent = `自動：うなずき → ${steps.join(' → ')} → うなずき。姿勢の間には必ず基準（頭を楽な位置に戻す）が入ります。うなずきを検出したら次へ進み、最後のうなずきを検出したら終わります。`;
}
$('protocol').onchange = protocolNote; $('preset').onchange = protocolNote;
$('camSel').onchange = () => { if (S.running) { stopCamera(); start(); } };
$('csvBtn').onclick = () => save(fileId() + '.csv', toCSV(S.last.rows), 'text/csv');
$('jsonBtn').onclick = () => save(fileId() + '.json', JSON.stringify({ meta: meta(), events: S.last.events, rows: S.last.rows }), 'application/json');
$('videoBtn').onclick = () => { if (S.lastVideo) save(fileId() + '.' + S.lastVideo.ext, S.lastVideo.blob); };
$('maskBtn').onclick = () => { S.showMask = !S.showMask; $('maskBtn').textContent = S.showMask ? '検出範囲の表示を消す' : '色の検出範囲を表示'; if (S.phase === 'frozen') redrawSnap(); };
$('resetBtn').onclick = () => { S.markers = {}; updateClash(); S.level = []; applySensorRoll(); $('rollInfo').textContent = rollText(); selectTarget('tragus'); if (S.phase === 'frozen') { setPhase('frozen'); redrawSnap(); } };
$('levelResetBtn').onclick = () => { S.level = []; applySensorRoll(); $('rollInfo').textContent = rollText(); if (S.phase === 'frozen') redrawSnap(); };
const bind = (id, key) => { $(id).oninput = e => { S[key] = +e.target.value; $(id + 'V').textContent = e.target.value; if (key === 'hTol') { Object.values(S.markers).forEach(m => { m.color.hTol = Math.min(S.hTol, m.color.hAuto ?? S.hTol); if (S.snapImg) m.clash = colorClash(S.snapImg, m.color, { x: m.snapPos[0] * S.k, y: m.snapPos[1] * S.k, area: m.snapArea * S.k * S.k }); }); updateClash(); if (S.phase === 'frozen') redrawSnap(); } }; };
bind('hTol', 'hTol'); bind('minArea', 'minArea'); bind('proc', 'procLong');
addEventListener('resize', () => { layout(); if (S.phase === 'frozen') redrawSnap(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && (S.phase === 'recording' || S.phase === 'countdown')) stopRec('画面が非表示になったため記録を停止しました。保存してください。'); });
window.__cva = S;   // 動作確認用
window.__cvaGrav = onGrav;
