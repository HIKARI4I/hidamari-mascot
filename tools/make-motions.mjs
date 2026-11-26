// 手付けモーションの定義と書き出し:  node tools/make-motions.mjs
//
// 下の MOTIONS に、キーフレーム (時刻とポーズ) を数値で打ってある。
// 実行すると、キーの間をなめらかに補間して motions/*.vrma (VRM Animation) を書き出す。
// 書き出した .vrma は Blender (VRM Add-on) などで読み込んで手直しもできる。
//
// ポーズの書き方 — 値は「基本の立ち姿」からの差分 [x, y, z] (ラジアン):
//   'spine' など体の中心の骨   … そのままの角度
//   'L:UpperArm' / 'R:UpperArm' … 左 / 右。どちらも「左半身の向き」で書く (右は自動で左右反転)
//   'B:UpperArm'               … 左右両方に同じ動き
//   pos                        … 腰の位置の移動 [左右, 上下, 前後] (メートル。腰の高さ 0.85 のモデル基準)
//   curlL / curlR              … 指の丸みの増減
// 角度の向き: x マイナス=前へ振る (ひざ・ひじはプラスで曲がる) / z プラス=腕が上がる・脚が外へ開く
// キーに書かなかった骨は、その骨が書かれている前後のキーの間を補間する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'motions', 'handmade'); // 手付け版の置き場。使う時は motions へコピーする
const FPS = 30;
const HIPS_HEIGHT = 0.85;

// 基本の立ち姿 (左半身の向き): 腕を下ろし、ひじを軽く曲げ、指を軽く丸める
const BASE = { UpperArm: [-0.04, 0, -1.25], LowerArm: [0, -0.28, 0] };
const BASE_CURL = 0.32;

const mirrorCenter = ([x, y, z]) => [x, -y, -z];

// 左右を入れ替えたポーズを作る (歩きの後半など)
function mirror(pose) {
  const out = {};
  for (const [key, value] of Object.entries(pose)) {
    if (key.startsWith('L:')) out[`R:${key.slice(2)}`] = value;
    else if (key.startsWith('R:')) out[`L:${key.slice(2)}`] = value;
    else if (key === 'curlL') out.curlR = value;
    else if (key === 'curlR') out.curlL = value;
    else if (key === 'pos') out.pos = [-value[0], value[1], value[2]];
    else if (key.startsWith('B:') || key === 'curl') out[key] = value;
    else out[key] = mirrorCenter(value);
  }
  return out;
}
const merge = (...poses) => Object.assign({}, ...poses);

// ======================================================================
// モーション定義
// ======================================================================

// ---- 1. 待機 (8秒ループ): 左足 → 右足へゆっくり体重を移す。呼吸は4秒周期 ----
const idleLeft = {
  pos: [0.02, 0, 0],
  hips: [0, 0, 0.04],
  spine: [0, 0.015, -0.03],
  chest: [0.015, 0, -0.015],
  head: [0.01, 0.03, 0.012],
  'B:Shoulder': [0, 0, 0.01],
  'B:UpperArm': [0.015, 0, 0.012],
  'L:UpperLeg': [0, 0, -0.064], // 腰が流れたぶん、足の裏が動かないよう脚で打ち消す
  'L:LowerLeg': [0, 0, 0],
  'L:Foot': [0, 0, 0.0235],
  'R:UpperLeg': [-0.08, 0, 0.064], // 体重が乗っていない側はひざがゆるむ
  'R:LowerLeg': [0.16, 0, 0],
  'R:Foot': [-0.08, 0, -0.0235],
};
const idleMid = {
  pos: [0, 0, 0], hips: [0, 0, 0], spine: [0, 0, 0], chest: [-0.01, 0, 0],
  'B:Shoulder': [0, 0, 0], 'B:UpperArm': [-0.01, 0, 0],
  'B:UpperLeg': [0, 0, 0], 'B:LowerLeg': [0, 0, 0], 'B:Foot': [0, 0, 0],
};
const idle = {
  duration: 8, loop: true,
  keys: [
    [0, idleLeft],
    [2.2, merge(idleMid, { head: [0.02, -0.01, 0] })],
    [4, mirror(idleLeft)],
    [6.3, merge(idleMid, { head: [-0.005, 0.01, 0] })],
  ],
};

// ---- 2. 歩き (1.2秒で左右1歩ずつ。その場歩き): 着地 → 沈む → 脚が交差 → 伸び上がる ----
const walkContact = { // 左足を前に出して、かかとから着地
  pos: [0, -0.03, 0], hips: [0, -0.1, 0], spine: [0.05, 0.06, 0], chest: [0, 0.07, 0], neck: [0, -0.03, 0],
  'L:UpperLeg': [-0.45, 0, 0], 'L:LowerLeg': [0.08, 0, 0], 'L:Foot': [0.22, 0, 0],
  'R:UpperLeg': [0.35, 0, 0], 'R:LowerLeg': [0.25, 0, 0], 'R:Foot': [-0.3, 0, 0],
  'L:UpperArm': [0.35, 0, 0.05], 'L:LowerArm': [0, 0.1, 0],
  'R:UpperArm': [-0.35, 0, 0.05], 'R:LowerArm': [0, -0.3, 0],
};
const walkDown = { // 前足に体重が乗って沈む。後ろ足が地面を離れる
  pos: [0.008, -0.04, 0], hips: [0, -0.07, 0.03], spine: [0.05, 0.04, -0.02], chest: [0, 0.05, 0], neck: [0, -0.02, 0],
  'L:UpperLeg': [-0.38, 0, -0.03], 'L:LowerLeg': [0.3, 0, 0], 'L:Foot': [0.08, 0, 0],
  'R:UpperLeg': [0.2, 0, 0.03], 'R:LowerLeg': [0.75, 0, 0], 'R:Foot': [0.2, 0, 0],
  'L:UpperArm': [0.25, 0, 0.05], 'L:LowerArm': [0, 0.05, 0],
  'R:UpperArm': [-0.25, 0, 0.05], 'R:LowerArm': [0, -0.25, 0],
};
const walkPassing = { // 浮いた足が軸足の横を通る
  pos: [0.018, -0.005, 0], hips: [0, 0, 0.04], spine: [0.05, 0, -0.03], chest: [0, 0, 0], neck: [0, 0, 0],
  'L:UpperLeg': [-0.05, 0, -0.04], 'L:LowerLeg': [0.1, 0, 0], 'L:Foot': [-0.05, 0, 0],
  'R:UpperLeg': [-0.25, 0, 0.04], 'R:LowerLeg': [0.95, 0, 0], 'R:Foot': [0.2, 0, 0],
  'L:UpperArm': [0, 0, 0.05], 'L:LowerArm': [0, -0.1, 0],
  'R:UpperArm': [0, 0, 0.05], 'R:LowerArm': [0, -0.1, 0],
};
const walkUp = { // 軸足で伸び上がり、浮いた足を前へ振り出す
  pos: [0.01, 0.01, 0], hips: [0, 0.06, 0.02], spine: [0.05, -0.04, -0.015], chest: [0, -0.05, 0], neck: [0, 0.02, 0],
  'L:UpperLeg': [0.2, 0, -0.02], 'L:LowerLeg': [0.05, 0, 0], 'L:Foot': [-0.1, 0, 0],
  'R:UpperLeg': [-0.5, 0, 0.02], 'R:LowerLeg': [0.5, 0, 0], 'R:Foot': [0.1, 0, 0],
  'L:UpperArm': [-0.22, 0, 0.05], 'L:LowerArm': [0, -0.2, 0],
  'R:UpperArm': [0.22, 0, 0.05], 'R:LowerArm': [0, 0, 0],
};
const walk = {
  duration: 1.2, loop: true,
  keys: [
    [0, walkContact], [0.15, walkDown], [0.3, walkPassing], [0.45, walkUp],
    [0.6, mirror(walkContact)], [0.75, mirror(walkDown)], [0.9, mirror(walkPassing)], [1.05, mirror(walkUp)],
  ],
};

// ---- 3. 座り (6秒ループ): 体育座りで手をひざに置く。首をかしげ、足先をとんとんする ----
const sitBase = {
  pos: [0, -(HIPS_HEIGHT - 0.28), 0], hips: [-0.12, 0, 0],
  'B:UpperLeg': [-2.3, 0, 0.05], 'B:LowerLeg': [2.35, 0, 0],
  spine: [0.22, 0, 0], chest: [0.12, 0, 0], neck: [-0.12, 0, 0],
  'B:UpperArm': [-1.35, 0, -0.05], 'B:LowerArm': [0, 0.13, 0],
};
const sit = {
  duration: 6, loop: true,
  keys: [
    [0, merge(sitBase, { head: [0, 0, 0.1], spine: [0.22, 0, 0.02], 'L:Foot': [-0.1, 0, 0], 'R:Foot': [-0.1, 0, 0] })],
    [1.5, merge(sitBase, { head: [0.02, 0.05, 0.04], spine: [0.24, 0, 0], 'L:Foot': [-0.28, 0, 0], 'R:Foot': [-0.1, 0, 0] })],
    [3, merge(sitBase, { head: [0, 0, -0.05], spine: [0.22, 0, -0.02], 'L:Foot': [-0.1, 0, 0], 'R:Foot': [-0.1, 0, 0] })],
    [4.5, merge(sitBase, { head: [0.02, -0.05, 0.02], spine: [0.24, 0, 0], 'L:Foot': [-0.1, 0, 0], 'R:Foot': [-0.28, 0, 0] })],
  ],
};

// ---- 4. クリック反応 (1.9秒): 小さく沈んでから右手を上げ、ひじから先を振る。手首は遅れてついてくる ----
const rest = { // 動きの最初と最後に置く、差分ゼロのキー
  pos: [0, 0, 0], spine: [0, 0, 0], head: [0, 0, 0],
  'B:UpperLeg': [0, 0, 0], 'B:LowerLeg': [0, 0, 0], 'B:Foot': [0, 0, 0],
  'R:Shoulder': [0, 0, 0], 'R:UpperArm': [0, 0, 0], 'R:LowerArm': [0, 0, 0], 'R:Hand': [0, 0, 0],
  'L:UpperArm': [0, 0, 0], curlR: 0,
};
const react = {
  duration: 1.9, loop: false,
  keys: [
    [0, rest],
    [0.14, { // 溜め
      pos: [0, -0.008, 0], spine: [0.04, 0, 0],
      'B:UpperLeg': [-0.09, 0, 0], 'B:LowerLeg': [0.18, 0, 0], 'B:Foot': [-0.09, 0, 0],
      'R:Shoulder': [0, 0, 0.05], 'R:UpperArm': [0, 0, 0.15],
    }],
    [0.38, { // 手を上げきる (かかとが少し浮く)
      pos: [0, 0.012, 0], spine: [-0.02, 0, -0.05], head: [0, 0, 0.1],
      'B:UpperLeg': [0, 0, 0], 'B:LowerLeg': [0, 0, 0], 'B:Foot': [0.12, 0, 0],
      'R:Shoulder': [0, 0, 0.22], 'R:UpperArm': [-0.2, 0, 2.05], 'R:LowerArm': [0, 0.28, 0.8], 'R:Hand': [0, 0, 0],
      'L:UpperArm': [0.08, 0, 0.12], curlR: -0.3,
    }],
    [0.56, { 'R:UpperArm': [-0.2, 0, 1.9], 'R:LowerArm': [0, 0.28, 1.45], 'R:Hand': [0, 0, -0.25] }],
    [0.76, { 'R:LowerArm': [0, 0.28, 0.6], 'R:Hand': [0, 0, 0.25] }],
    [0.96, { 'R:LowerArm': [0, 0.28, 1.45], 'R:Hand': [0, 0, -0.25] }],
    [1.16, { 'R:LowerArm': [0, 0.28, 0.6], 'R:Hand': [0, 0, 0.25] }],
    [1.36, {
      spine: [-0.02, 0, -0.04], head: [0, 0, 0.09], pos: [0, 0.005, 0], 'B:Foot': [0.05, 0, 0],
      'R:Shoulder': [0, 0, 0.22], 'R:UpperArm': [-0.2, 0, 1.9], 'R:LowerArm': [0, 0.28, 1.35], 'R:Hand': [0, 0, -0.2],
      'L:UpperArm': [0.08, 0, 0.12], curlR: -0.3,
    }],
    [1.62, { // ひじを曲げたまま、体の前を通して下ろす
      pos: [0, 0, 0], spine: [0, 0, -0.01], head: [0, 0, 0.03], 'B:Foot': [0, 0, 0],
      'R:Shoulder': [0, 0, 0.06], 'R:UpperArm': [-0.45, 0, 0.45], 'R:LowerArm': [0, -0.75, 0.2], 'R:Hand': [0, 0, 0],
      'L:UpperArm': [0.03, 0, 0.04], curlR: -0.1,
    }],
    [1.9, rest],
  ],
};

// ---- 5. つかまれ (1.6秒ループ): 宙ぶらりんで足を交互にばたつかせる ----
const dragCommon = {
  spine: [-0.05, 0, 0], 'B:Shoulder': [0, 0, 0.04], 'B:LowerArm': [0, -0.22, 0], 'B:Foot': [0.45, 0, 0], curlL: -0.2, curlR: -0.2,
};
const dragKick = merge(dragCommon, {
  spine: [-0.05, 0.06, 0], head: [0, -0.04, 0.05],
  'L:UpperLeg': [-0.36, 0, 0], 'L:LowerLeg': [0.55, 0, 0],
  'R:UpperLeg': [0.06, 0, 0], 'R:LowerLeg': [0.2, 0, 0],
  'L:UpperArm': [-0.12, 0, 0.1], 'R:UpperArm': [0.1, 0, 0.07],
});
const dragMid = merge(dragCommon, {
  head: [0, 0, 0],
  'B:UpperLeg': [-0.14, 0, 0], 'B:LowerLeg': [0.38, 0, 0], 'B:UpperArm': [0, 0, 0.08],
});
const drag = {
  duration: 1.6, loop: true,
  keys: [[0, dragKick], [0.4, dragMid], [0.8, mirror(dragKick)], [1.2, dragMid]],
};

// ---- 6. 落下 (0.8秒ループ): 腕は体の横で小さくばたつかせ、足をばたばたさせる ----
const fallCommon = {
  head: [-0.1, 0, 0], 'B:LowerArm': [0, -0.3, 0], 'B:Foot': [0.3, 0, 0], curlL: -0.25, curlR: -0.25,
};
const fallA = merge(fallCommon, {
  spine: [-0.1, 0.05, 0],
  'L:UpperArm': [-0.25, 0, 0.32], 'R:UpperArm': [0.2, 0, 0.22],
  'L:UpperLeg': [-0.6, 0, 0], 'L:LowerLeg': [1.0, 0, 0],
  'R:UpperLeg': [-0.1, 0, 0], 'R:LowerLeg': [0.5, 0, 0],
});
const fallB = merge(fallCommon, {
  spine: [-0.1, 0, 0],
  'L:UpperArm': [0.1, 0, 0.2], 'R:UpperArm': [-0.15, 0, 0.34],
  'B:UpperLeg': [-0.35, 0, 0], 'B:LowerLeg': [0.75, 0, 0],
});
const fall = {
  duration: 0.8, loop: true,
  keys: [[0, fallA], [0.2, fallB], [0.4, mirror(fallA)], [0.6, mirror(fallB)]],
};

// ---- 7. なでられ (1.4秒ループ): 首をすくめて頭を下げ、手に合わせて頭が左右に揺れる ----
const patCommon = {
  chest: [0.03, 0, 0], 'B:Shoulder': [0, 0, 0.12], 'B:UpperArm': [-0.12, 0, -0.03], 'B:LowerArm': [0, -0.5, 0],
  'B:UpperLeg': [-0.04, 0, 0], 'B:LowerLeg': [0.08, 0, 0], 'B:Foot': [-0.04, 0, 0],
};
const pat = {
  duration: 1.4, loop: true,
  keys: [
    [0, merge(patCommon, { head: [0.1, 0, 0.07], neck: [0, 0, 0.03] })],
    [0.2, { spine: [0, 0, 0.015] }], // 体は頭より少し遅れて揺れる
    [0.7, merge(patCommon, { head: [0.1, 0, -0.07], neck: [0, 0, -0.03] })],
    [0.9, { spine: [0, 0, -0.015] }],
  ],
};

// ---- 8. 伸び (3.4秒): 腕を前から上げ、背中を反らしてつま先立ちで止め、横から下ろして息を吐く ----
const stretchRest = {
  pos: [0, 0, 0], spine: [0, 0, 0], chest: [0, 0, 0], upperChest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0],
  'B:Shoulder': [0, 0, 0], 'B:UpperArm': [0, 0, 0], 'B:LowerArm': [0, 0, 0], 'B:Foot': [0, 0, 0], curlL: 0, curlR: 0,
};
const stretch = {
  duration: 3.4, loop: false,
  keys: [
    [0, stretchRest],
    [0.5, { chest: [-0.03, 0, 0], 'B:Shoulder': [0, 0, 0.1], 'B:UpperArm': [-0.9, 0, 0.6], 'B:LowerArm': [0, -0.7, 0] }],
    [1.0, {
      pos: [0, 0.035, 0], spine: [-0.1, 0, 0], chest: [-0.06, 0, 0], neck: [-0.06, 0, 0], head: [-0.08, 0, 0],
      'B:Shoulder': [0, 0, 0.25], 'B:UpperArm': [-0.1, 0, 2.55], 'B:LowerArm': [0, 0.2, 0], 'B:Foot': [0.3, 0, 0],
      curlL: -0.28, curlR: -0.28,
    }],
    [1.5, {
      pos: [0, 0.045, 0], spine: [-0.14, 0, 0.03], chest: [-0.1, 0, 0], upperChest: [-0.05, 0, 0], neck: [-0.12, 0, 0], head: [-0.1, 0, 0],
      'B:Shoulder': [0, 0, 0.28], 'B:UpperArm': [0, 0, 2.6], 'B:LowerArm': [0, 0.28, 0], 'B:Foot': [0.38, 0, 0],
    }],
    [2.0, {
      pos: [0, 0.045, 0], spine: [-0.14, 0, -0.03], chest: [-0.1, 0, 0], upperChest: [-0.05, 0, 0], neck: [-0.12, 0, 0], head: [-0.1, 0, 0],
      'B:Shoulder': [0, 0, 0.28], 'B:UpperArm': [0, 0, 2.58], 'B:LowerArm': [0, 0.28, 0], 'B:Foot': [0.38, 0, 0],
      curlL: -0.28, curlR: -0.28,
    }],
    [2.5, {
      pos: [0, 0, 0], spine: [0, 0, 0], chest: [0, 0, 0], upperChest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0],
      'B:Shoulder': [0, 0, 0.1], 'B:UpperArm': [0, 0, 1.3], 'B:LowerArm': [0, -0.2, 0], 'B:Foot': [0, 0, 0],
      curlL: -0.1, curlR: -0.1,
    }],
    [2.95, { spine: [0.09, 0, 0], head: [0.08, 0, 0], 'B:Shoulder': [0, 0, 0], 'B:UpperArm': [0.05, 0, 0.08], 'B:LowerArm': [0, -0.05, 0] }],
    [3.4, stretchRest],
  ],
};

const MOTIONS = { idle, walk, sit, react, drag, fall, pat, stretch };

// ======================================================================
// ここから下は、補間と .vrma (glTF バイナリ) の書き出し
// ======================================================================

const FINGERS = ['Index', 'Middle', 'Ring', 'Little'];
const SEGMENTS = [['Proximal', 1.0], ['Intermediate', 1.15], ['Distal', 0.8]];

// 骨の親子関係と、ファイルに入れる骨組みのおおよその位置 (回転の再生には影響しない)
const SKELETON = [
  ['hips', null, [0, HIPS_HEIGHT, 0]],
  ['spine', 'hips', [0, 0.08, 0]], ['chest', 'spine', [0, 0.12, 0]], ['upperChest', 'chest', [0, 0.12, 0]],
  ['neck', 'upperChest', [0, 0.14, 0]], ['head', 'neck', [0, 0.08, 0]],
];
for (const [side, sx] of [['left', 1], ['right', -1]]) {
  SKELETON.push(
    [`${side}Shoulder`, 'upperChest', [0.03 * sx, 0.1, 0]],
    [`${side}UpperArm`, `${side}Shoulder`, [0.1 * sx, 0, 0]],
    [`${side}LowerArm`, `${side}UpperArm`, [0.24 * sx, 0, 0]],
    [`${side}Hand`, `${side}LowerArm`, [0.22 * sx, 0, 0]],
    [`${side}UpperLeg`, 'hips', [0.08 * sx, -0.04, 0]],
    [`${side}LowerLeg`, `${side}UpperLeg`, [0, -0.38, 0]],
    [`${side}Foot`, `${side}LowerLeg`, [0, -0.38, 0]],
  );
  FINGERS.forEach((finger, i) => {
    let parent = `${side}Hand`;
    for (const [segment] of SEGMENTS) {
      const name = `${side}${finger}${segment}`;
      SKELETON.push([name, parent, parent.endsWith('Hand') ? [0.08 * sx, 0, 0.03 - 0.02 * i] : [0.025 * sx, 0, 0]]);
      parent = name;
    }
  });
}
const BONE_INDEX = new Map(SKELETON.map(([name], i) => [name, i]));

// キーのポーズを「骨の名前 → 実際の角度」に展開する
function expandPose(pose) {
  const out = {};
  const put = (bone, value) => { out[bone] = value; };
  for (const [key, value] of Object.entries(pose)) {
    if (key === 'pos') put('pos', value);
    else if (key === 'curl' || key === 'curlL' || key === 'curlR') {
      if (key !== 'curlR') put('curlL', [value, 0, 0]);
      if (key !== 'curlL') put('curlR', [value, 0, 0]);
    } else if (key.startsWith('L:')) put(`left${key.slice(2)}`, value);
    else if (key.startsWith('R:')) put(`right${key.slice(2)}`, mirrorCenter(value));
    else if (key.startsWith('B:')) {
      put(`left${key.slice(2)}`, value);
      put(`right${key.slice(2)}`, mirrorCenter(value));
    } else put(key, value);
  }
  return out;
}

// キーの間を、前後のキーも見てなめらかな曲線でつなぐ (ループは終わりと始まりもつなぐ)
function sampleChannel(points, duration, loop, t) {
  if (points.length === 1) return points[0].v;
  let list = points;
  if (loop) {
    const first = points[0];
    const last = points[points.length - 1];
    const second = points[1 % points.length];
    list = [
      { t: last.t - duration, v: last.v },
      ...points,
      { t: first.t + duration, v: first.v },
      { t: second.t + duration, v: second.v },
    ];
    if (t < first.t) t += duration;
  } else {
    if (t <= points[0].t) return points[0].v;
    if (t >= points[points.length - 1].t) return points[points.length - 1].v;
  }
  let i = list.findIndex((p, k) => k < list.length - 1 && t >= p.t && t <= list[k + 1].t);
  if (i < 0) i = list.length - 2;
  const p1 = list[i];
  const p2 = list[i + 1];
  const p0 = list[i - 1];
  const p3 = list[i + 2];
  const span = p2.t - p1.t;
  const u = (t - p1.t) / span;
  return p1.v.map((_, k) => {
    // 止まる所 (前後のキーがない端) は傾きゼロで、ゆっくり動き出して、ゆっくり止まる
    const m1 = p0 ? (p2.v[k] - p0.v[k]) / (p2.t - p0.t) : 0;
    const m2 = p3 ? (p3.v[k] - p1.v[k]) / (p3.t - p1.t) : 0;
    const u2 = u * u;
    const u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * p1.v[k] + (u3 - 2 * u2 + u) * span * m1
      + (-2 * u3 + 3 * u2) * p2.v[k] + (u3 - u2) * span * m2;
  });
}

function eulerToQuat([x, y, z]) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

function buildVrma(motion) {
  // 骨ごとに、その骨が書かれているキーだけを集める
  const channels = new Map();
  for (const [t, pose] of motion.keys) {
    for (const [bone, value] of Object.entries(expandPose(pose))) {
      if (!channels.has(bone)) channels.set(bone, []);
      channels.get(bone).push({ t, v: value });
    }
  }
  const frameCount = Math.round(motion.duration * FPS) + 1;
  const times = Array.from({ length: frameCount }, (_, i) => (i / (frameCount - 1)) * motion.duration);
  const delta = (bone, t) => (channels.has(bone) ? sampleChannel(channels.get(bone), motion.duration, motion.loop, t) : [0, 0, 0]);

  // 全部の骨について、基本の立ち姿 + 差分 を毎フレーム求める
  const rotations = new Map();
  for (const [name] of SKELETON) {
    const side = name.startsWith('left') ? 'left' : name.startsWith('right') ? 'right' : null;
    const part = side ? name.slice(side.length) : name;
    const finger = side ? SEGMENTS.find(([segment]) => FINGERS.some((f) => part === f + segment)) : null;
    let previous = null;
    const values = times.map((t) => {
      let euler;
      if (finger) {
        const curl = Math.max(0, BASE_CURL + delta(side === 'left' ? 'curlL' : 'curlR', t)[0]) * finger[1];
        euler = [0, 0, side === 'left' ? -curl : curl];
      } else {
        const base = side && BASE[part] ? (side === 'left' ? BASE[part] : mirrorCenter(BASE[part])) : [0, 0, 0];
        const d = delta(name, t);
        euler = [base[0] + d[0], base[1] + d[1], base[2] + d[2]];
      }
      let q = eulerToQuat(euler);
      if (previous && q[0] * previous[0] + q[1] * previous[1] + q[2] * previous[2] + q[3] * previous[3] < 0) q = q.map((v) => -v);
      previous = q;
      return q;
    });
    rotations.set(name, values.flat());
  }
  const hipsTrack = times.flatMap((t) => {
    const d = delta('pos', t);
    return [d[0], HIPS_HEIGHT + d[1], d[2]];
  });

  // ---- glTF バイナリに詰める ----
  const buffers = [];
  const bufferViews = [];
  const accessors = [];
  let offset = 0;
  const addAccessor = (array, type, extra = {}) => {
    const data = Buffer.from(new Float32Array(array).buffer);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: array.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type], type, ...extra });
    buffers.push(data);
    offset += data.length;
    return accessors.length - 1;
  };
  const timeAccessor = addAccessor(times, 'SCALAR', { min: [0], max: [motion.duration] });
  const samplers = [];
  const animationChannels = [];
  const addTrack = (node, pathName, accessor) => {
    samplers.push({ input: timeAccessor, output: accessor, interpolation: 'LINEAR' });
    animationChannels.push({ sampler: samplers.length - 1, target: { node, path: pathName } });
  };
  addTrack(BONE_INDEX.get('hips'), 'translation', addAccessor(hipsTrack, 'VEC3'));
  for (const [name, values] of rotations) addTrack(BONE_INDEX.get(name), 'rotation', addAccessor(values, 'VEC4'));

  const nodes = SKELETON.map(([name, , translation]) => ({ name, translation }));
  SKELETON.forEach(([name, parent]) => {
    if (!parent) return;
    const p = nodes[BONE_INDEX.get(parent)];
    (p.children ?? (p.children = [])).push(BONE_INDEX.get(name));
  });
  const bin = Buffer.concat(buffers);
  const gltf = {
    asset: { version: '2.0', generator: 'hidamari-mascot tools/make-motions.mjs' },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: { humanBones: Object.fromEntries(SKELETON.map(([name], i) => [name, { node: i }])) },
      },
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    animations: [{ name: 'motion', channels: animationChannels, samplers }],
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors,
  };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, json, binHeader, bin]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, motion] of Object.entries(MOTIONS)) {
  const file = path.join(OUT_DIR, `${name}.vrma`);
  const data = buildVrma(motion);
  fs.writeFileSync(file, data);
  console.log(`${name}.vrma  ${motion.duration}秒  キー${motion.keys.length}個  ${(data.length / 1024).toFixed(0)} KB`);
}
