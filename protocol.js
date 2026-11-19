// 進行表（CVAカメラ と posture-lab で同じファイルを使う。中身を変えるときは両方のリポジトリに同じものを置くこと）
// 本実験の固定（stand）・手持ち（dual）の区間の並び・秒数・声かけ・posture-lab の画面を決める。
// 時刻はすべて「開始の音」の鳴り始め（t = 0）からの秒。両方のアプリは、この表から区間の開始時刻を計算し、それぞれの時計で進む。
// 声かけを出すのは CVAカメラだけ。posture-lab は画面（目印／読書）だけを切り替える。
(function (root) {
  'use strict';
  const PROTOCOL_VERSION = 'P-20261119';
  // 秒数（すべてここで決める）
  const SEC = {
    toneLead: 1.5,      // 開始の音の鳴り始め → 最初の区間（うなずき）の案内まで
    guide: 3,           // 各区間の前の案内（声かけ）
    trans: 3,           // 案内のあと、姿勢を変える時間
    nodGuide: 3,        // うなずきの声かけ（移行の時間はなし）
    nod: 6,             // うなずき
    firstBase: 10,      // 最初の基準
    base: 6,            // 途中の基準（CVAカメラの「戻れたか」の音では長さを変えない）
    posture: 10,        // うつむく・顎・猫背・目線・端末だけ動かす
    natural: 30,        // 自然（最初と最後）
    bad: 15,            // 悪い姿勢
    reading: 60,        // 読書（6ページ × 10秒）
    readingPage: 10,    // 読書の1ページの秒数
    endToneGap: 1,      // 最後のうなずきの終わり → 終了の音
    stopAfterEndTone: 2,// 終了の音の鳴り始め → 記録の停止（posture-lab が終了の音を聞けるように）
  };
  // 開始・終了の音：[周波数 Hz, 長さ 秒] の並び。声と区別できるよう、純音を3つ続ける
  const TONES = {
    start: [[1500, 0.2], [2500, 0.2], [1500, 0.2]],
    end: [[2500, 0.2], [1500, 0.2], [2500, 0.2]],
    gain: 0.6,
  };
  const SAY = {
    nod: '大きく、素早く1回うなずいてください',
    base0: { stand: '姿勢を正して、画面を見てください', hand: '姿勢を正して、スマホを目の高さに持ってください' },
    base: { stand: '基準の姿勢に戻ってください', hand: '基準の姿勢に戻って、スマホを目の高さに持ってください' },
    natural: '普段スマホを見るときの、楽な姿勢になってください',
    down: { stand: '画面を見たまま、あごを引くようにうつむいてください', hand: 'スマホを胸の高さに下げて、うつむいて画面を見てください' },
    chin: { stand: '画面を見たまま、顎を前に突き出してください', hand: 'スマホを胸の高さに下げて、顎を前に突き出して画面を見てください' },
    slouch: { stand: '猫背になってください', hand: 'スマホを胸の高さに下げて、猫背になってください' },
    gaze: { stand: '頭は動かさず、目線だけを下げてください', hand: 'スマホを胸の高さに下げて、頭は動かさず、目線だけで画面を見てください' },
    device: '頭は動かさず、スマホだけをゆっくり上下に動かしてください',
    bad: '画面を見たまま、自分にとって一番悪いと思う姿勢になってください',
    reading: '画面の文章を読んでください。姿勢は気にしなくて大丈夫です',
  };
  // 区間の並び（kind = 'stand'：固定、'dual'：手持ち）。screen は posture-lab の画面（mark：中央の目印、reading：読書の文章）
  function segments(kind) {
    const c = kind === 'dual' ? 'hand' : 'stand', pick = x => typeof x === 'string' ? x : x[c];
    const B = { label: '基準', sec: SEC.base, say: pick(SAY.base), base: 'middle' };
    const P = (label, say) => ({ label, sec: SEC.posture, say: pick(say) });
    const list = [
      { label: 'うなずき', nod: 'start', sec: SEC.nod, say: SAY.nod },
      { label: '基準', sec: SEC.firstBase, say: pick(SAY.base0), base: 'first' },
      { label: '自然', sec: SEC.natural, say: SAY.natural }, B,
      P('うつむく', SAY.down), B,
      P('顎を突き出す', SAY.chin), B,
      P('猫背', SAY.slouch), B,
      P('目線だけ下げる', SAY.gaze), B,
      ...(kind === 'dual' ? [P('端末だけ動かす', SAY.device), B] : []),
      { label: '悪い姿勢', sec: SEC.bad, say: SAY.bad }, B,
      { label: '読書', sec: SEC.reading, say: SAY.reading, screen: 'reading' }, B,
      { label: '自然', sec: SEC.natural, say: SAY.natural }, B,
      { label: 'うなずき', nod: 'end', sec: SEC.nod, say: SAY.nod },
    ];
    return list.map(s => ({ ...s }));
  }
  // 区間ごとの開始時刻（秒、開始の音から）を計算する
  function buildSchedule(kind) {
    if (kind !== 'stand' && kind !== 'dual') throw Error('進行表は stand か dual です：' + kind);
    const segs = segments(kind), n = segs.filter(s => !s.nod).length;
    let t = SEC.toneLead, k = 0;
    const out = segs.map((s, index) => {
      const nod = !!s.nod, guide = nod ? SEC.nodGuide : SEC.guide, trans = nod ? 0 : SEC.trans;
      const step = nod ? (s.nod === 'start' ? -1 : n) : k++;
      const r = { index, label: s.label, stage: nod ? 'nod' : 'hold', step, nod: s.nod || null, base: s.base || null, screen: s.screen || 'mark', say: s.say,
        guideStart: +t.toFixed(3), transStart: +(t + guide).toFixed(3), holdStart: +(t + guide + trans).toFixed(3), holdSec: s.sec, end: +(t + guide + trans + s.sec).toFixed(3) };
      t = r.end; return r;
    });
    const endToneAt = +(t + SEC.endToneGap).toFixed(3), stopAt = +(endToneAt + SEC.stopAfterEndTone).toFixed(3);
    return { protocolVersion: PROTOCOL_VERSION, kind, segments: out, endToneAt, stopAt, total: stopAt, sec: { ...SEC }, tones: TONES };
  }
  // ある時刻（秒、開始の音から）にいる区間と、その中の段階（guide | transition | hold）
  function segmentAt(schedule, tSec) {
    for (const s of schedule.segments) if (tSec >= s.guideStart && tSec < s.end) return { seg: s, phase: tSec >= s.holdStart ? 'hold' : tSec >= s.transStart ? 'transition' : 'guide' };
    return { seg: null, phase: tSec < schedule.segments[0].guideStart ? 'lead' : tSec < schedule.stopAt ? 'ending' : 'done' };
  }
  const NAMES = { stand: '固定（スタンド）', dual: '手持ち' };
  const api = { PROTOCOL_VERSION, SEC, TONES, SAY, NAMES, buildSchedule, segmentAt };
  root.POSTURE_PROTOCOL = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
