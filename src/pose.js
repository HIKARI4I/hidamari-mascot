// 内蔵モーション: .vrma がない動きを、関節の角度を計算して作る
//
// 角度は「左半身の向き」でそろえて書き、右半身は自動で左右反転する。
//   x: 前後 (マイナスで前へ振る / ひざ・ひじはプラスで曲がる)
//   y: ひねり
//   z: 左右の開き (腕はプラスで上がる)
// それぞれの動きは「効き具合 0〜1」を掛けて足し合わせるので、動きの切り替えが自然につながる。
//
// .vrma を再生している間は options.only で一部の動きだけを選び、再生中のポーズの上に足す
// (着地のしゃがみ込みや、ぶら下がった脚の揺れのように、その場の状況で決まる動き)。

export const WALK_SPEED = 0.7; // m/s
export const WALK_SWING = 0.3; // 歩きの脚の振り幅 (rad)
export const STRETCH_SECONDS = 3.4;
export const WAVE_SECONDS = 1.9;

const FINGERS = ['Index', 'Middle', 'Ring', 'Little'];
const SEGMENTS = [['Proximal', 1.0], ['Intermediate', 1.15], ['Distal', 0.8]];
const SIDED = ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot'];
const CENTER = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export function applyPose(vrm, m, { isV0, hipsHeight, hipsRest }, options = {}) {
  const only = options.only ?? null; // null = 全部の動きを使って、ポーズを一から作る
  const use = (section) => !only || only.has(section);
  const pose = {};
  const add = (name, x, y, z) => {
    const p = pose[name] ?? (pose[name] = [0, 0, 0]);
    p[0] += x; p[1] += y; p[2] += z;
  };
  const left = (part, x, y, z) => add(`left${part}`, x, y, z);
  const right = (part, x, y, z) => add(`right${part}`, x, -y, -z); // 左半身の向きで書いた値を反転
  const pair = (part, x, y, z) => { left(part, x, y, z); right(part, x, y, z); };
  const hipsMove = { x: 0, y: 0 };

  const t = m.time;
  const breath = Math.sin(t * 1.5);
  let surprised = 0;
  let eyesClosed = 0;
  let curlLeft = 0.32; // 指の丸み (力を抜いた手)
  let curlRight = 0.32;

  // ---- 伸びと手振りは、始めてからの秒数で進む ----
  const su = m.stretchT;
  const stretchUp = su < 0 ? 0 : smooth(0, 0.9, su) * (1 - smooth(2.2, 3.0, su));
  const stretchHold = su < 0 ? 0 : smooth(0.7, 1.15, su) * (1 - smooth(1.95, 2.35, su));
  const stretchSlump = su < 0 ? 0 : smooth(2.3, 2.7, su) * (1 - smooth(2.8, STRETCH_SECONDS, su));
  const wu = m.waveT;
  const wave = wu < 0 ? 0 : smooth(0, 0.28, wu) * (1 - smooth(WAVE_SECONDS - 0.4, WAVE_SECONDS, wu));

  // ---- 基本の立ち姿: 腕を下ろし、ひじを軽く曲げ、呼吸で胸と肩が動く ----
  if (use('base')) {
    pair('UpperArm', -0.04, 0, -1.25 + breath * 0.012);
    pair('LowerArm', 0, -0.28, 0);
    pair('Shoulder', 0, 0, breath * 0.01);
    add('spine', -breath * 0.006, 0, 0);
    add('chest', breath * 0.018, 0, 0);
    add('upperChest', breath * 0.012, 0, 0);
  }

  // ---- 1. 待機: ゆっくり左右の足に体重を移す (腰が流れ、肩が逆に傾き、浮いた側のひざがゆるむ) ----
  const idle = clamp01(1 - m.walk - m.sit - m.drag - m.fall) * (1 - m.crouch) * (1 - stretchUp);
  const shift = (Math.sin(t * 0.45) + 0.5 * Math.sin(t * 0.23 + 1.3)) / 1.5;
  if (use('idle')) {
    const hipRoll = shift * 0.04 * idle;
    const slide = shift * 0.02 * idle;
    const legLean = -hipRoll - slide / hipsHeight; // 足の裏が動かないよう、脚で打ち消す
    hipsMove.x += slide;
    add('hips', 0, 0, hipRoll);
    add('spine', 0, Math.sin(t * 0.37 + 1) * 0.02 * idle, -shift * 0.03 * idle);
    add('chest', 0, 0, -shift * 0.015 * idle);
    add('leftUpperLeg', 0, 0, legLean);
    add('rightUpperLeg', 0, 0, legLean);
    add('leftFoot', 0, 0, slide / hipsHeight);
    add('rightFoot', 0, 0, slide / hipsHeight);
    const looseRight = 0.08 * Math.max(0, shift) * idle;
    const looseLeft = 0.08 * Math.max(0, -shift) * idle;
    add('rightUpperLeg', -looseRight, 0, 0);
    add('rightLowerLeg', 2 * looseRight, 0, 0);
    add('rightFoot', -looseRight, 0, 0);
    add('leftUpperLeg', -looseLeft, 0, 0);
    add('leftLowerLeg', 2 * looseLeft, 0, 0);
    add('leftFoot', -looseLeft, 0, 0);
    pair('UpperArm', Math.sin(t * 0.9) * 0.015 * idle, 0, 0);
    add('head', Math.sin(t * 0.27 + 2) * 0.015, Math.sin(t * 0.31) * 0.025 + Math.sin(t * 0.83 + 2) * 0.01, shift * 0.012 * idle);
  }

  // ---- 2. 歩き: 腰と肩を逆にひねり、ひざを曲げて脚を運び、かかとから着いてつま先で蹴る ----
  if (use('walk')) {
    const lean = m.walk;
    const stride = clamp01((m.walk - 0.35) / 0.65); // 体を進行方向へ向け終わってから歩き出す
    const phase = m.walkPhase;
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    const leg = (side, sign) => {
      const sw = sign * s;
      const thigh = (-WALK_SWING * sw - 0.05) * stride;
      const knee = (0.08 + 0.9 * Math.max(0, sign * Math.cos(phase + 0.5)) ** 2) * stride;
      const swinging = smooth(-0.2, 0.2, sign * c); // 1 = 足が浮いている
      const flat = -(thigh + knee); // 足の裏が地面と平行になる角度
      add(`${side}UpperLeg`, thigh, 0, 0.04 * c * stride);
      add(`${side}LowerLeg`, knee, 0, 0);
      add(`${side}Foot`, flat * (0.75 - 0.45 * swinging), 0, 0);
    };
    leg('left', 1);
    leg('right', -1);
    hipsMove.x += -0.018 * c * stride;
    hipsMove.y += (0.012 * Math.cos(phase * 2) - 0.012) * stride;
    add('hips', 0, -0.1 * s * stride, -0.04 * c * stride);
    add('spine', 0.05 * lean, 0.06 * s * stride, 0.03 * c * stride);
    add('chest', 0, 0.07 * s * stride, 0);
    add('neck', 0, -0.03 * s * stride, 0);
    const arm = Math.sin(phase - 0.3); // 腕は脚より少し遅れて振れる
    left('UpperArm', 0.4 * arm * stride, 0, 0.05 * lean);
    right('UpperArm', -0.4 * arm * stride, 0, 0.05 * lean);
    left('LowerArm', 0, -(0.2 + 0.3 * Math.max(0, -arm)) * stride, 0);
    right('LowerArm', 0, -(0.2 + 0.3 * Math.max(0, arm)) * stride, 0);
  }

  // ---- 3. 座る: 体育座り。手をひざに置き、ゆっくり揺れて、足先を動かす ----
  if (use('sit')) {
    const sit = smooth(0, 1, m.sit);
    hipsMove.y -= (hipsHeight - 0.28) * sit;
    add('hips', -0.12 * sit, 0, 0);
    pair('UpperLeg', -2.3 * sit, 0, 0.05 * sit);
    pair('LowerLeg', 2.35 * sit, 0, 0);
    left('Foot', (-0.1 + Math.sin(t * 1.3) * 0.08) * sit, 0, 0);
    right('Foot', (-0.1 - Math.sin(t * 1.3) * 0.08) * sit, 0, 0);
    add('spine', 0.22 * sit, 0, Math.sin(t * 0.7) * 0.02 * sit);
    add('chest', 0.12 * sit, 0, 0);
    add('neck', -0.12 * sit, 0, 0);
    add('head', 0, 0, (0.07 + Math.sin(t * 0.5) * 0.04) * sit);
    pair('UpperArm', -1.35 * sit, 0, -0.05 * sit); // 手をひざの上に置く
    pair('LowerArm', 0, 0.13 * sit, 0);
  }

  // ---- 5. つかまれ: 脚は振り子のようにぶら下がり、最初はじたばたして少しずつ落ち着く ----
  if (use('drag')) {
    const d = m.drag;
    const flail = 0.3 + 0.7 * Math.exp(-m.grabAge * 1.3);
    const kick = Math.sin(t * 6.5) * flail;
    const kick2 = Math.sin(t * 6.5 + 1.2) * flail;
    add('leftUpperLeg', (-0.12 + 0.24 * kick) * d, 0, 0);
    add('rightUpperLeg', (-0.12 - 0.24 * kick) * d, 0, 0);
    add('leftLowerLeg', (0.3 + 0.25 * kick2) * d, 0, 0);
    add('rightLowerLeg', (0.3 - 0.25 * kick2) * d, 0, 0);
    pair('Foot', 0.45 * d, 0, 0);
    pair('Shoulder', 0, 0, 0.04 * d);
    pair('UpperArm', 0, 0, 0.08 * d);
    left('UpperArm', Math.sin(t * 7.3) * 0.2 * flail * d, 0, 0);
    right('UpperArm', Math.cos(t * 7.3) * 0.2 * flail * d, 0, 0);
    pair('LowerArm', 0, -0.22 * d, 0);
    add('spine', -0.05 * d, 0, 0);
    curlLeft -= 0.2 * d;
    curlRight -= 0.2 * d;
  }
  if (use('swing')) {
    // 脚は振り子として揺れる: 動かした勢いで振れて、少しずつ収まる
    const d = m.drag;
    add('leftUpperLeg', 0, 0, m.pendulum * 0.9 * d);
    add('rightUpperLeg', 0, 0, m.pendulum * 0.9 * d);
    add('spine', 0, 0, -m.pendulum * 0.25 * d);
    add('chest', 0, 0, -m.pendulum * 0.15 * d);
    add('head', 0, 0, m.pendulum * 0.2 * d);
  }
  surprised = Math.max(surprised, Math.exp(-m.grabAge * 2.2) * m.drag, m.fall);
  eyesClosed = Math.max(eyesClosed, stretchHold);

  // ---- 6. 落下: 腕を上げてばたつかせ、脚をばたばたさせる ----
  if (use('fall')) {
    const f = m.fall;
    const kick = Math.sin(t * 10);
    pair('UpperArm', 0, 0, 0.28 * f);
    left('UpperArm', Math.sin(t * 13) * 0.4 * f, 0, 0);
    right('UpperArm', Math.sin(t * 13 + 1.8) * 0.4 * f, 0, 0);
    pair('LowerArm', 0, -0.3 * f, 0);
    left('UpperLeg', (-0.45 + 0.3 * kick) * f, 0, 0);
    right('UpperLeg', (-0.25 - 0.3 * kick) * f, 0, 0);
    left('LowerLeg', (0.8 + 0.3 * Math.sin(t * 10 + 1)) * f, 0, 0);
    right('LowerLeg', (0.8 - 0.3 * Math.sin(t * 10 + 1)) * f, 0, 0);
    pair('Foot', 0.3 * f, 0, 0);
    add('spine', -0.1 * f, 0, 0);
    add('head', -0.1 * f, 0, 0);
    curlLeft -= 0.25 * f;
    curlRight -= 0.25 * f;
  }

  // ---- 着地・跳ねる前の溜め: ひざで受け止めてしゃがみ、腕でバランスを取る ----
  if (use('crouch')) {
    const c = m.crouch;
    const bend = 0.75 * c;
    pair('UpperLeg', -bend, 0, 0);
    pair('LowerLeg', 2 * bend, 0, 0);
    pair('Foot', -bend, 0, 0);
    hipsMove.y -= (hipsHeight - 0.08) * (1 - Math.cos(bend));
    add('spine', 0.3 * c, 0, 0);
    add('chest', 0.1 * c, 0, 0);
    add('neck', -0.2 * c, 0, 0);
    pair('UpperArm', -0.25 * c, 0, 0.45 * c);
    pair('LowerArm', 0, -0.3 * c, 0);

    // 跳ねている間は腕が上がり、足を軽くたたむ
    const lift = m.hopLift;
    pair('UpperArm', 0, 0, 0.9 * lift);
    pair('UpperLeg', -0.25 * lift, 0, 0);
    pair('LowerLeg', 0.5 * lift, 0, 0);
    pair('Foot', 0.3 * lift, 0, 0);
  }

  // ---- 4. 手を振る: 右腕を上げ、ひじから先を振る。手首は少し遅れてついてくる ----
  if (use('wave')) {
    const swing = Math.sin(wu * 12.5);
    right('Shoulder', 0, 0, 0.2 * wave);
    right('UpperArm', -0.2 * wave, 0, 1.9 * wave);
    right('LowerArm', 0, 0.28 * wave, (1.0 + 0.42 * swing) * wave);
    right('Hand', 0, 0, 0.3 * Math.sin(wu * 12.5 - 1.0) * wave);
    add('spine', 0, 0, -0.04 * wave);
    add('head', 0, 0, 0.09 * wave);
    curlRight -= 0.29 * wave;
  }

  // ---- 8. 伸び: 腕を上げ、背中を反らせてつま先立ちで止め、息を吐いて下ろす ----
  if (use('stretch')) {
    const rising = Math.max(0, stretchUp - stretchHold); // 上げている途中・下ろしている途中
    pair('Shoulder', 0, 0, 0.25 * stretchUp);
    pair('UpperArm', -0.25 * rising, 0, 2.55 * stretchUp - 0.03 * stretchSlump);
    pair('LowerArm', 0, 0.28 * stretchUp - 0.6 * rising, 0);
    add('spine', -0.13 * stretchHold + 0.09 * stretchSlump, 0, Math.sin(t * 31) * 0.006 * stretchHold);
    add('chest', -0.1 * stretchHold, 0, 0);
    add('upperChest', -0.05 * stretchHold, 0, 0);
    add('neck', -0.12 * stretchHold, 0, 0);
    add('head', -0.1 * stretchHold + 0.08 * stretchSlump, 0, 0);
    pair('Foot', 0.38 * stretchHold, 0, 0);
    hipsMove.y += 0.045 * stretchHold * (hipsHeight / 0.85);
    curlLeft -= 0.28 * stretchHold;
    curlRight -= 0.28 * stretchHold;
  }

  // ---- 7. なでられ: 首をすくめて頭を下げ、手の動きに合わせて頭が揺れる ----
  if (use('pat')) {
    const p = m.pat;
    const sway = Math.sin(t * 4.5);
    add('head', 0.1 * p, 0, sway * 0.07 * p);
    add('neck', 0, 0, Math.sin(t * 4.5 - 0.4) * 0.03 * p);
    add('spine', 0, 0, Math.sin(t * 4.5 - 0.9) * 0.015 * p);
    pair('Shoulder', 0, 0, 0.12 * p);
    pair('UpperArm', 0, 0, -0.03 * p);
  }

  // ---- 居眠り: 座ったまま頭をひざに落とし、ゆっくり呼吸する (座りの動きに重ねる) ----
  if (use('sleep')) {
    const z = m.sleep;
    const slow = Math.sin(t * 0.9);
    add('spine', (0.1 + slow * 0.015) * z, 0, 0);
    add('neck', 0.18 * z, 0, 0);
    add('head', 0.3 * z, 0, 0.08 * z);
    pair('Shoulder', 0, 0, slow * 0.015 * z);
  }
  eyesClosed = Math.max(eyesClosed, m.sleep);

  // ---- 指: 軽く丸める (振っている手・驚いている時は開く) ----
  for (const finger of use('base') ? FINGERS : []) {
    for (const [segment, amount] of SEGMENTS) {
      add(`left${finger}${segment}`, 0, 0, -Math.max(0, curlLeft) * amount);
      add(`right${finger}${segment}`, 0, 0, Math.max(0, curlRight) * amount);
    }
  }

  // ---- モデルに反映 (VRM 0.x は x と z の向きが逆) ----
  const sign = isV0 ? -1 : 1;
  const humanoid = vrm.humanoid;
  const names = [...CENTER];
  for (const side of ['left', 'right']) {
    for (const part of SIDED) names.push(`${side}${part}`);
    for (const finger of FINGERS) for (const [segment] of SEGMENTS) names.push(`${side}${finger}${segment}`);
  }
  for (const name of names) {
    const node = humanoid.getNormalizedBoneNode(name);
    if (!node) continue;
    const p = pose[name];
    if (only) {
      // 再生中のモーションの上に足す
      if (p) {
        node.rotation.x += sign * p[0];
        node.rotation.y += p[1];
        node.rotation.z += sign * p[2];
      }
    } else if (p) {
      node.rotation.set(sign * p[0], p[1], sign * p[2]);
    } else {
      node.rotation.set(0, 0, 0);
    }
  }
  const hips = humanoid.getNormalizedBoneNode('hips');
  if (hips && only) {
    hips.position.x += sign * hipsMove.x;
    hips.position.y += hipsMove.y;
  } else if (hips) {
    hips.position.set(hipsRest.x + sign * hipsMove.x, hipsRest.y + hipsMove.y, hipsRest.z);
  }

  return { surprised, eyesClosed, yawn: stretchHold };
}
