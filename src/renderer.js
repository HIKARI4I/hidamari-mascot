// キャラのウィンドウ: VRMの表示・ふるまい・視線・つかまれた時の揺れ・クリック反応
// ウィンドウそのものの移動 (ドラッグ・落下・歩き) はメイン側 (main.js) が行う
// 関節の角度を計算して作る内蔵モーションは pose.js にある
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { applyPose, WALK_SPEED, WALK_SWING, STRETCH_SECONDS, WAVE_SECONDS } from './pose.js';

const FPS = 30;
// くり返し再生する動き。ここに無い名前の .vrma は「1回きりの仕草」として扱う
const LOOPING = new Set(['idle', 'walk', 'sit', 'drag', 'fall', 'pat', 'sleep']);
const isOneShot = (name) => !LOOPING.has(name);
// 待機中にひとりでにする仕草 (名前: 選ばれやすさ)。その名前の .vrma が motions にある時だけ使う
const FIDGETS = {
  stretch: 3, 'look-around': 3, hair: 3, yawn: 2, skirt: 2, 'peek-up': 2, reach: 1.5, crouch: 1.5,
  doze: 1, heart: 1, 'wave-both': 1, 'joy-jump': 0.8, bow: 0.5, dance: 0.5,
};
// 仕草の間の表情 (名前: [表情の候補, 始まり, 終わり])。候補は前から順に、モデルが持っている最初のものを使う。
// 始まりと終わりは動き全体に対する割合
const ACTION_FACE = {
  yawn: [['yawn'], 0.25, 0.85], heart: [['joy', 'happy'], 0.15, 0.9], 'joy-jump': [['joy', 'happy'], 0.1, 0.9],
  'wave-both': [['smile', 'happy'], 0.1, 0.9], dance: [['winkRight'], 0.2, 0.2667], bow: [['smile', 'relaxed'], 0.25, 0.8],
  doze: [['sleepy', 'blink'], 0.2, 0.75], angry: [['rage', 'angry'], 0.1, 0.9], startled: [['fear', 'surprised'], 0, 0.6],
  'look-around': [['puzzled'], 0.15, 0.85], hair: [['shy', 'smile'], 0.2, 0.85], skirt: [['shy'], 0.2, 0.85],
  'peek-up': [['surprisedO', 'awe'], 0.25, 0.8], reach: [['serious'], 0.2, 0.8], crouch: [['thinking'], 0.2, 0.8],
  pose: [['winkRight', 'happy'], 0.14, 0.86],
};
// 何もしていない時に、ときどき浮かべる表情 (名前: 選ばれやすさ)。モデルが持っているものだけ使う
const AMBIENT_FACES = {
  idle: { smile: 4, smirk: 2, puff: 2, thinking: 2, puzzled: 1.5, confident: 2, winkRight: 1.5, grin: 2, doubt: 1, whistle: 1, tongueOut: 0.8, worried: 0.6, happy: 1 },
  walk: { smile: 4, confident: 2, whistle: 2, grin: 1.5, happy: 1 },
  sit: { smile: 3, relief: 2, thinking: 2, sleepy: 1.5, puff: 1, happy: 1 },
};
// 目の形を自分で変える表情 (出している間は、まばたきを止める)
const EYE_FACES = new Set(['winkRight', 'winkLeft', 'relief', 'squeeze', 'kiss', 'cry', 'joy', 'sleepy', 'grin', 'smile', 'happy']);
const FADE_SECONDS = { sit: 0.6, sleep: 0.8, drag: 0.15, fall: 0.15 }; // モーションを切り替える時のつなぎの長さ (既定 0.3秒)
const GRAVITY = 9.8; // m/s^2
const mate = window.mate;
const notice = document.getElementById('notice');

// ---------- シーン ----------
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(window.devicePixelRatio);

const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, Math.PI * 0.8);
sun.position.set(0.5, 1, 2);
scene.add(sun);

// ウィンドウのピクセルをそのままメートルに換算する正投影カメラ (モデルは実寸のまま)
const camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 100);
camera.position.z = 20;

const rig = new THREE.Group(); // 揺れ・跳ね・体の向きはここで動かす (足元が原点)
rig.rotation.order = 'ZXY'; // 左右の向き → 上下の向き → 傾き の順にかける (傾きは常に画面に対して付く)
scene.add(rig);
const lookTarget = new THREE.Object3D();
scene.add(lookTarget);

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

// ---------- 状態 ----------
let settings = { heightPx: 450, lookAtCursor: true, wander: true, landing: 'fall' };
let vrm = null;
let isV0 = false;
let modelHeight = 1.5; // m
let hipsHeight = 0.85; // m (腰の高さ。歩幅と、しゃがむ・座る時に下げる量に使う)
const hipsRest = new THREE.Vector3();
let ppm = 300; // 1メートルあたりのピクセル数
let mixer = null;
const actions = {}; // 名前 → AnimationAction (motions フォルダの .vrma)
let currentAction = null;
let currentName = null;

const mouse = { x: -1, y: -1, mx: 0, my: 0, known: false }; // ウィンドウ内の px と m
let overCharacter = false;
let clickThrough = true;
let cursorSpeed = 0; // px/s

let dragging = false;
let falling = false;
const grab = { x: 0, y: 0, px: 0, py: 0 }; // つかんだ点 (足元基準) と、その画面上の位置
const dragFrom = { x: 0, y: 0 };
const winPrev = { x: window.screenX, y: window.screenY };
let winVx = 0; // ウィンドウの横移動の速さ (m/s)
let tilt = 0;
let hopY = 0;
let hopV = 0;
let hopPrep = 0; // 跳ねる前に沈み込む残り時間
let landHold = 0; // 着地で沈み込んでいる残り時間
let landAmount = 0;
let happyTimer = 0;
let blinkTimer = 2;
let blinkPhase = -1;
const head = { yaw: 0, pitch: 0 };
let time = 0;

// ふるまい: 待機の合間に、ときどき歩く・座る・伸びをする
let behavior = 'idle'; // idle | walk | sit | stretch
let behaviorTimer = 6;
let walkDir = 1;
let walkingActive = false; // メイン側でウィンドウを歩かせている最中か
let faceYaw = 0;
let patHold = 0;
let demoScale = 1; // デモの間だけの見た目の倍率 (足元が基準)
let viewYaw = 0; // 右クリックしたままドラッグで変えられる、キャラの向き: 左右 (0 = 正面)
let viewPitch = 0; // 同じく上下 (プラスで上から見下ろす)
const MAX_PITCH = 1.5;
let rotating = null; // 向きを変えている最中 { startX, startY, startYaw, startPitch, moved }
let asleep = false; // PCをしばらく触っていない間は座って眠る
let lastCursor = null;
let polledPrev = null;
let eventCursor = null; // このウィンドウに届いたマウスの動きから分かった、画面上のカーソル位置
let clickTimes = []; // 最近クリックされた時刻
let preview = null; // 設定画面からのお試し再生 { name, until }
const ambient = { name: null, weight: 0, hold: 0, wait: 4 }; // ふとした表情の状態
let shownAction = null; // 仕草に合わせて出している表情の名前
let previewExpression = null; // 設定画面からの表情のお試し { name, until }
let shownExpression = null;
let talkUntil = 0; // 吹き出しでしゃべっている間は口を動かす
let grabNotified = false;
let patNotified = false;
let frameCount = 0;

// pose.js に渡す、いまの動きの状態 (各動きの効き具合は 0〜1 で、少しずつ近づける)
const m = {
  time: 0,
  walk: 0, sit: 0, drag: 0, fall: 0, pat: 0, sleep: 0,
  walkPhase: 0,
  stretchT: -1, // 伸びを始めてからの秒数 (-1 = していない)
  waveT: -1, // 手を振り始めてからの秒数 (-1 = していない)
  grabAge: 0, // つかまれてからの秒数
  pendulum: 0, // ぶら下がった脚の振れ角
  pendulumV: 0,
  crouch: 0, // しゃがみ込み (着地・跳ねる前)
  hopLift: 0, // 跳ねている高さに応じた腕の上がり
  tilt: 0,
};

const toArrayBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const approach = (value, target, rate, dt) => value + (target - value) * (1 - Math.exp(-rate * dt));
const parse = (buffer) => new Promise((ok, ng) => loader.parse(buffer, '', ok, ng));
const bone = (name) => vrm.humanoid.getNormalizedBoneNode(name);

function layout() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  ppm = (settings.heightPx / modelHeight) * demoScale; // デモの間は、カメラの寄り引きで大きさを変える (体は縮めないので髪や服が乱れない)
  camera.right = w / ppm;
  camera.top = h / ppm;
  camera.updateProjectionMatrix();
  if (!dragging) releaseGrab();
}

// つかんでいない時の基準位置 = ウィンドウ下端の中央に足元
function releaseGrab() {
  grab.x = 0;
  grab.y = 0;
  grab.px = camera.right / 2;
  grab.py = 0;
}

function showNotice(text) {
  notice.textContent = text;
  notice.style.display = text ? 'block' : 'none';
}

// ---------- モデルとモーションの読み込み ----------
async function loadModel() {
  const file = await mate.getModel();
  if (!file) {
    showNotice('右下のトレイアイコンを右クリック →「VRMを選ぶ…」');
    return false;
  }
  try {
    const gltf = await parse(toArrayBuffer(file.data));
    const next = gltf.userData.vrm;
    if (!next) throw new Error('VRMとして読み込めませんでした');
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(next);
    next.scene.traverse((o) => { o.frustumCulled = false; });

    if (vrm) {
      rig.remove(vrm.scene);
      VRMUtils.deepDispose(vrm.scene);
    }
    vrm = next;
    isV0 = vrm.meta?.metaVersion === '0';
    rig.position.set(0, 0, 0);
    rig.rotation.set(0, 0, 0);
    rig.add(vrm.scene);
    if (vrm.lookAt) vrm.lookAt.target = lookTarget;

    vrm.update(0);
    rig.updateMatrixWorld(true);
    const h = new THREE.Box3().setFromObject(vrm.scene).max.y;
    modelHeight = h > 0.2 && h < 5 ? h : 1.5;
    const hipsNode = bone('hips');
    const hipsY = hipsNode?.getWorldPosition(new THREE.Vector3()).y ?? 0;
    hipsHeight = hipsY > 0.1 ? hipsY : modelHeight * 0.55;
    if (hipsNode) hipsRest.copy(hipsNode.position);

    layout();
    vrm.springBoneManager?.reset();
    await loadMotions();
    setBehavior('idle', 5);
    // このモデルが持っている表情を知らせる (設定画面の「表情を試す」に並ぶ)
    const skip = new Set(['neutral', 'lookUp', 'lookDown', 'lookLeft', 'lookRight']);
    mate.expressions(Object.keys(vrm.expressionManager?.expressionMap ?? {}).filter((name) => !skip.has(name)));
    showNotice('');
    return true;
  } catch (err) {
    console.error(err);
    showNotice(`${file.name} を読み込めませんでした: ${err.message}`);
    return false;
  }
}

async function loadMotions() {
  mixer = new THREE.AnimationMixer(vrm.scene);
  for (const key of Object.keys(actions)) delete actions[key];
  currentAction = null;
  for (const motion of await mate.getMotions()) {
    try {
      const gltf = await parse(toArrayBuffer(motion.data));
      const anim = gltf.userData.vrmAnimations?.[0];
      if (!anim) continue;
      const action = mixer.clipAction(createVRMAnimationClip(anim, vrm));
      if (isOneShot(motion.name)) {
        // 1回だけ再生して、最後のポーズで止める
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      actions[motion.name] = action;
    } catch (err) {
      console.warn(`モーション ${motion.name} を読み込めませんでした`, err);
    }
  }
}

// 状態名と同じ名前の .vrma があればそれを再生し、なければ内蔵モーションにまかせる
function playMotion(name) {
  const next = actions[name] ?? null;
  if (next === currentAction) return;
  if (next) {
    // 座りから立つ時などは、いま再生中の動きに合わせてゆっくりつなぐ
    const fade = Math.max(FADE_SECONDS[name] ?? 0.3, FADE_SECONDS[currentName] ?? 0.3);
    next.reset().fadeIn(fade).play();
    currentAction?.fadeOut(fade);
  } else {
    mixer.stopAllAction();
    vrm.humanoid.resetNormalizedPose();
  }
  currentAction = next;
  currentName = name;
}

// ---------- ふるまい ----------
const canWander = () => settings.wander && settings.landing === 'fall';

// その動きの長さ (.vrma があればその長さ、なければ内蔵モーションの長さ)
const clipSeconds = (name, fallback) => actions[name]?.getClip().duration ?? fallback;

// 1回きりの仕草を始める
function doAction(name) {
  setBehavior(name, clipSeconds(name, name === 'stretch' ? STRETCH_SECONDS : 3));
  actions[name]?.reset();
}

// いま出来る仕草の中から、重みに応じて1つ選ぶ (伸びは内蔵モーションがあるのでいつでも選べる)
function pickFidget() {
  const names = Object.keys(FIDGETS).filter((n) => n === 'stretch' || actions[n]);
  let r = Math.random() * names.reduce((sum, n) => sum + FIDGETS[n], 0);
  for (const n of names) {
    r -= FIDGETS[n];
    if (r <= 0) return n;
  }
  return 'stretch';
}

function setBehavior(next, seconds) {
  behavior = next;
  behaviorTimer = seconds;
  if (next === 'walk') walkDir = Math.random() < 0.5 ? -1 : 1;
  if (next === 'stretch') m.stretchT = 0;
}

function updateBehavior(dt) {
  if (preview) {
    if (performance.now() > preview.until) {
      preview = null;
      setBehavior('idle', rand(4, 8));
    }
    return;
  }
  if (dragging || falling) {
    if (behavior !== 'idle') setBehavior('idle', rand(4, 8));
    return;
  }
  if (asleep) {
    if (behavior !== 'sit') setBehavior('sit', 5);
    return;
  }
  if (demo) {
    updateDemo(dt);
    return;
  }
  if (behavior === 'walk' && !canWander()) setBehavior('idle', rand(4, 8));
  behaviorTimer -= dt;
  if (behaviorTimer > 0) return;
  if (behavior !== 'idle') {
    setBehavior('idle', rand(5, 12));
    return;
  }
  const r = Math.random();
  if (canWander() && r < 0.4) setBehavior('walk', rand(3, 6));
  else if (canWander() && r < 0.55) setBehavior('sit', rand(10, 18));
  else if (r < 0.9) doAction(pickFidget());
  else setBehavior('idle', rand(4, 8));
}

// いまの動きの名前 (.vrma のファイル名と対応)
function motionName() {
  if (dragging) return 'drag';
  if (falling) return 'fall';
  if (preview) return preview.name;
  // 座っている間の手振り・なでられは、座りモーションの上に重ねる (立ち上がらせない)
  if (asleep && behavior === 'sit' && actions.sleep) return 'sleep';
  if (behavior === 'sit' || m.sit > 0.5) return behavior;
  if (m.waveT >= 0) return 'react';
  if (m.pat > 0.5 && actions.pat) return 'pat';
  // 歩きは、体を進行方向へ向け終わって足が動き出してから切り替える
  if (behavior === 'walk' && m.walk <= 0.35 && !preview) return 'idle';
  return behavior;
}

function updateMotionState(dt) {
  m.time = time;
  m.tilt = tilt;
  // お試し再生の間は、ふだんのふるまいの代わりにその動きを見せる
  const mode = preview ? preview.name : behavior;
  const held = dragging || mode === 'drag';
  m.walk = approach(m.walk, mode === 'walk' ? 1 : 0, 5, dt);
  m.sit = approach(m.sit, mode === 'sit' ? 1 : 0, 2.6, dt);
  m.drag = approach(m.drag, held ? 1 : 0, 10, dt);
  m.fall = approach(m.fall, falling || mode === 'fall' ? 1 : 0, 9, dt);
  m.sleep = approach(m.sleep, asleep && !preview && !dragging && !falling ? 1 : 0, 2, dt);
  m.grabAge = held ? m.grabAge + dt : 0;

  if (m.stretchT >= 0) {
    m.stretchT += dt;
    if (m.stretchT > clipSeconds('stretch', STRETCH_SECONDS) || dragging || falling) m.stretchT = -1;
    if (m.stretchT < 0 && mode === 'stretch' && preview) restartOneShot('stretchT');
  }
  if (m.waveT >= 0) {
    m.waveT += dt;
    if (m.waveT > clipSeconds('react', WAVE_SECONDS)) m.waveT = -1;
    if (m.waveT < 0 && mode === 'react' && preview) restartOneShot('waveT');
  }

  // 歩き: まず進む方向へ体を向け、向き終わってから歩き出す。止まる時も足を止めてから正面へ戻る
  const speedScale = clamp((m.walk - 0.35) / 0.65, 0, 1);
  const stepLength = 2 * hipsHeight * Math.sin(WALK_SWING);
  m.walkPhase += (WALK_SPEED * speedScale * Math.PI / stepLength) * dt;
  if (!preview) {
    if (speedScale > 0) {
      walkingActive = true;
      mate.walkStart(walkDir * WALK_SPEED * speedScale * ppm);
    } else if (walkingActive) {
      walkingActive = false;
      mate.walkStop();
    }
  }
  faceYaw = approach(faceYaw, mode === 'walk' ? walkDir * 1.15 : 0, 6, dt);

  // しゃがみ込み: 跳ねる前の溜めと、着地の受け止め
  landHold = Math.max(0, landHold - dt);
  const crouchTarget = hopPrep > 0 ? 0.55 : landHold > 0 ? landAmount : 0;
  m.crouch = approach(m.crouch, crouchTarget, crouchTarget > m.crouch ? 22 : 7, dt);
  m.hopLift = approach(m.hopLift, clamp(hopY * 7, 0, 1), 14, dt);

  // なでる: カーソルが頭の上で動いている間
  patHold = Math.max(0, patHold - dt);
  const headNode = bone('head');
  if (headNode && overCharacter && !dragging && cursorSpeed > 60) {
    const headY = headNode.getWorldPosition(new THREE.Vector3()).y;
    if (mouse.my > headY - 0.05) patHold = 0.6;
  }
  m.pat = approach(m.pat, patHold > 0 || mode === 'pat' ? 1 : 0, 5, dt);

  // 出来事をメイン側に知らせる (たまにしゃべる)
  if (patHold > 0 && !patNotified) mate.event('pat');
  patNotified = patHold > 0;
  if (dragging && !grabNotified && Math.hypot(window.screenX - dragFrom.x, window.screenY - dragFrom.y) > 5) {
    grabNotified = true;
    mate.event('grab');
  }
}

// 1回きりの動き (伸び・手振り) を最初からやり直す
function restartOneShot(key) {
  m[key] = 0;
  currentAction?.reset().play();
}

function startPreview({ name, seconds }) {
  if (!vrm || typeof name !== 'string') return;
  if (walkingActive) {
    walkingActive = false;
    mate.walkStop();
  }
  // 1回きりの仕草は、その動きの長さだけ見せる
  const length = isOneShot(name) && actions[name] ? actions[name].getClip().duration + 0.2 : seconds;
  preview = { name, until: performance.now() + length * 1000 };
  walkDir = 1;
  if (name === 'react') restartOneShot('waveT');
  if (name === 'stretch') restartOneShot('stretchT');
  if (name !== 'react') m.waveT = -1;
  if (name !== 'stretch') m.stretchT = -1;
  actions[name]?.reset();
}

// 頭のてっぺんがウィンドウのどこにあるかを知らせる (吹き出しを頭の上に出すため)
function reportHead() {
  const node = bone('head');
  if (!node) return;
  const pos = node.getWorldPosition(new THREE.Vector3());
  mate.headPosition({
    x: clamp((pos.x * ppm) / window.innerWidth, 0, 1),
    y: clamp(1 - ((pos.y + 0.16) * ppm) / window.innerHeight, 0, 1),
  });
}

// ---------- 毎フレームの動き ----------
// 顔をカーソルのほうへ少し向ける (目は lookAt が追う)
function followCursor(dt) {
  const headNode = bone('head');
  if (!headNode) return;
  const pos = headNode.getWorldPosition(new THREE.Vector3());
  const busy = Math.max(m.walk, m.pat, m.stretchT >= 0 ? 1 : 0);
  const follow = settings.lookAtCursor && mouse.known && busy < 0.3;
  const dx = follow ? mouse.mx - pos.x : 0;
  const dy = follow ? mouse.my - pos.y : 0;
  // 体が横を向いている時は、そのぶんを差し引いてカーソルのほうへ首を回す (真後ろ向きの時は追わない)
  const bodyYaw = Math.atan2(Math.sin(rig.rotation.y), Math.cos(rig.rotation.y));
  const wanted = Math.abs(bodyYaw) > 1.9 ? 0 : clamp(dx * 0.5, -0.6, 0.6) - bodyYaw;
  head.yaw = approach(head.yaw, clamp(wanted, -0.7, 0.7), 5, dt);
  head.pitch = approach(head.pitch, clamp(dy * 0.4, -0.35, 0.35), 5, dt);

  // 首 → 頭 → 少しだけ胸、の順に分けて向けると首だけが回る不自然さが減る
  const pitchSign = isV0 ? 1 : -1;
  for (const [name, weight] of [['chest', 0.12], ['neck', 0.35], ['head', 0.53]]) {
    const node = bone(name);
    if (!node) continue;
    node.rotation.y += head.yaw * weight;
    node.rotation.x += pitchSign * head.pitch * weight;
  }
  lookTarget.position.set(pos.x + dx, pos.y + dy, 3);
}

function updateFace(dt, face) {
  const em = vrm.expressionManager;
  if (!em) return;
  // 表情のお試し中は、その表情だけを見せる
  if (previewExpression && performance.now() > previewExpression.until) previewExpression = null;
  const wanted = previewExpression?.name ?? null;
  if (shownExpression && shownExpression !== wanted) em.setValue(shownExpression, 0);
  shownExpression = wanted;
  if (wanted) {
    for (const name of ['happy', 'surprised', 'relaxed', 'blink', 'aa', 'yawn']) if (name !== wanted) em.setValue(name, 0);
    em.setValue(wanted, 1);
    return;
  }
  happyTimer = Math.max(0, happyTimer - dt);
  const happyBase = Math.min(1, happyTimer * 4);
  // 仕草に合わせた表情 (その表情を持つモデルだけ)
  const actDef = currentAction ? ACTION_FACE[currentName] : null;
  const actName = actDef ? actDef[0].find((name) => em.getExpression(name)) : null;
  let actWeight = 0;
  if (actName) {
    const k = currentAction.time / currentAction.getClip().duration;
    const ramp = Math.min(0.08, 0.15 / currentAction.getClip().duration); // 出入りは長くても0.15秒
    actWeight = clamp(Math.min((k - actDef[1]) / ramp, (actDef[2] - k) / ramp), 0, 1);
  }
  // 何もしていない時の、ふとした表情
  const calm = !actName && happyBase === 0 && face.surprised < 0.05 && m.pat < 0.05 && !dragging && !falling && !asleep && (face.yawn ?? 0) === 0
    && ['idle', 'walk', 'sit'].includes(behavior);
  if (!calm) {
    ambient.hold = 0;
    ambient.wait = Math.max(ambient.wait, 3);
  } else if (ambient.hold > 0) {
    ambient.hold -= dt;
  } else if (ambient.weight < 0.01) {
    ambient.wait -= dt;
    if (ambient.wait <= 0) {
      const table = AMBIENT_FACES[behavior] ?? AMBIENT_FACES.idle;
      const names = Object.keys(table).filter((name) => em.getExpression(name) && name !== ambient.name);
      let r = Math.random() * names.reduce((sum, name) => sum + table[name], 0);
      ambient.name = names.find((name) => (r -= table[name]) <= 0) ?? names[0] ?? null;
      ambient.hold = ambient.name ? 2.5 + Math.random() * 3 : 0;
      ambient.wait = 5 + Math.random() * 9;
    }
  }
  ambient.weight = approach(ambient.weight, calm && ambient.hold > 0 ? 1 : 0, 5, dt);
  const moodName = actName ?? (ambient.weight > 0.01 ? ambient.name : null);
  const moodWeight = actName ? actWeight : ambient.weight * 0.85;
  const actFace = (name) => (moodName === name ? moodWeight : 0);
  if (shownAction && shownAction !== moodName) em.setValue(shownAction, 0);
  shownAction = moodName && !['happy', 'surprised', 'relaxed', 'yawn', 'blink'].includes(moodName) ? moodName : null;
  if (shownAction) em.setValue(shownAction, moodWeight);
  const moodEyes = moodName && EYE_FACES.has(moodName) ? moodWeight : 0;
  const happy = Math.max(happyBase, actFace('happy'));
  const surprised = happy > 0 ? 0 : Math.max(face.surprised, actFace('surprised'));
  em.setValue('happy', happy);
  em.setValue('surprised', surprised);
  em.setValue('relaxed', happy > 0 || surprised > 0.3 ? 0 : Math.max(m.pat, actFace('relaxed'))); // なでられている間のうっとり顔
  // 伸びの間は、あくびの表情があればあくびをする (なければ目を閉じるだけ)
  const canYawn = Boolean(em.getExpression('yawn'));
  const yawn = canYawn && happy === 0 ? Math.max(face.yawn ?? 0, actFace('yawn')) : 0;
  em.setValue('yawn', yawn);
  // しゃべっている間の口の開け閉め (ほかの表情で口が動いている間はしない)
  const talking = performance.now() < talkUntil && yawn === 0 && surprised < 0.3;
  em.setValue('aa', talking ? 0.2 + 0.45 * (0.5 + 0.5 * Math.sin(time * 15)) * (0.6 + 0.4 * Math.sin(time * 4.3)) : 0);

  // まばたき (表情で目の形が変わっている間は止める)
  let blink = 0;
  if (happy === 0 && m.pat < 0.5 && surprised < 0.3 && moodEyes < 0.3) {
    if (blinkPhase < 0) {
      blinkTimer -= dt;
      if (blinkTimer <= 0) blinkPhase = 0;
    } else {
      blinkPhase += dt / 0.16;
      blink = Math.sin(Math.min(1, blinkPhase) * Math.PI);
      if (blinkPhase >= 1) {
        blinkPhase = -1;
        // たまに二度まばたきする
        blinkTimer = Math.random() < 0.2 ? 0.12 : 2 + Math.random() * 4;
      }
    }
    blink = Math.max(blink, yawn > 0 ? 0 : face.eyesClosed, actFace('blink')); // あくびの表情は自分で目を閉じる
  }
  em.setValue('blink', blink);
}

function updateBody(dt) {
  // ウィンドウが横に動いた速さで、つかまれた体が傾く
  const vx = (window.screenX - winPrev.x) / ppm / Math.max(dt, 1e-3);
  winPrev.x = window.screenX;
  winPrev.y = window.screenY;
  const prevVx = winVx;
  winVx += (vx - winVx) * 0.3;

  const hang = grab.y > modelHeight / 2 ? -1 : 1;
  tilt = approach(tilt, dragging ? clamp(hang * winVx * 0.1, -0.45, 0.45) : 0, 8, dt);

  // ぶら下がった脚は振り子として揺らす (動かした勢いで振れて、少しずつ収まる)
  const accel = dragging ? (winVx - prevVx) / Math.max(dt, 1e-3) : 0;
  const omega = 7;
  m.pendulumV += (-omega * omega * m.pendulum - 2 * 0.2 * omega * m.pendulumV - hang * -1.1 * accel) * dt;
  m.pendulum = clamp(m.pendulum + m.pendulumV * dt, -0.9, 0.9);

  // クリックされた時の小さなジャンプ: 沈み込んで溜めてから跳ぶ
  if (hopPrep > 0) {
    hopPrep -= dt;
    if (hopPrep <= 0) hopV = 1.9;
  }
  if (hopV !== 0 || hopY > 0) {
    hopV -= GRAVITY * dt;
    hopY += hopV * dt;
    if (hopY <= 0) {
      land(-hopV);
      hopY = 0;
      hopV = 0;
    }
  }

  // つかんだ点が画面上の同じ場所に留まるように、傾きに合わせて足元の位置を決める
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  rig.position.x = grab.px - (grab.x * cos - grab.y * sin);
  rig.position.y = grab.py - (grab.x * sin + grab.y * cos) + hopY;
  if (settings.landing === 'float' && !dragging) rig.position.y += 0.02 + Math.sin(time * 1.5) * 0.015; // ふわふわ浮く
  rig.rotation.y = faceYaw + viewYaw * (1 - clamp(m.walk, 0, 1)); // 歩く時は進む方向を向く
  rig.rotation.x = viewPitch;
  // 大きく見下ろす・見上げる時は、体が下にはみ出さないよう体の中心を軸にする (少しの傾きなら足元はほぼ動かない)
  rig.position.y += modelHeight * 0.5 * (1 - Math.cos(viewPitch));
  rig.rotation.z = tilt;
}

// 着地: 落ちてきた勢いに応じてひざで受け止める
function land(impact) {
  landAmount = clamp(impact * 0.14, 0.15, 0.85);
  landHold = 0.16;
  // 高い所から落ちた時は、びっくりする
  if (impact > 3.5 && actions.startled && !asleep && !preview) doAction('startled');
}

// 描画した絵の透明度を1ピクセル読んで、カーソルがキャラの上にあるか調べる
function hitTest() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (!mouse.known || mouse.x < 0 || mouse.y < 0 || mouse.x >= w || mouse.y >= h) return false;
  const gl = renderer.getContext();
  const dpr = renderer.getPixelRatio();
  const x = Math.floor(mouse.x * dpr);
  const y = Math.max(0, Math.floor((h - mouse.y) * dpr) - 1);
  // カーソルの周り 5×5 ピクセルを読み、どこかにキャラが描かれていれば「上にいる」とする (細い髪や指でも反応しやすい)
  const size = 5;
  const x0 = clamp(x - 2, 0, Math.max(0, gl.drawingBufferWidth - size));
  const y0 = clamp(y - 2, 0, Math.max(0, gl.drawingBufferHeight - size));
  const px = new Uint8Array(size * size * 4);
  gl.readPixels(x0, y0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
  for (let i = 3; i < px.length; i += 4) if (px[i] > 16) return true;
  // 絵が読めない環境でも反応できるように、骨の位置からも判定する
  return boneHit();
}

// カーソルが、体の骨に沿った太い線の近くにあるか (頭は大きめの円)
const HIT_SEGMENTS = [
  ['head', 'neck', 0.11], ['neck', 'hips', 0.1],
  ['leftUpperArm', 'leftLowerArm', 0.05], ['leftLowerArm', 'leftHand', 0.045], ['rightUpperArm', 'rightLowerArm', 0.05], ['rightLowerArm', 'rightHand', 0.045],
  ['leftUpperLeg', 'leftLowerLeg', 0.075], ['leftLowerLeg', 'leftFoot', 0.065], ['rightUpperLeg', 'rightLowerLeg', 0.075], ['rightLowerLeg', 'rightFoot', 0.065],
];
const _hitA = new THREE.Vector3();
const _hitB = new THREE.Vector3();
function boneScreen(name, out) {
  const node = vrm?.humanoid?.getNormalizedBoneNode(name);
  if (!node) return false;
  node.getWorldPosition(out).project(camera);
  out.x = (out.x * 0.5 + 0.5) * window.innerWidth;
  out.y = (1 - (out.y * 0.5 + 0.5)) * window.innerHeight;
  return true;
}
function boneHit() {
  for (const [from, to, radius] of HIT_SEGMENTS) {
    if (!boneScreen(from, _hitA) || !boneScreen(to, _hitB)) continue;
    if (from === 'head') _hitA.y -= 0.09 * ppm; // 頭の骨は首の付け根にあるので、頭の中心まで上げる
    const dx = _hitB.x - _hitA.x;
    const dy = _hitB.y - _hitA.y;
    const t = clamp(((mouse.x - _hitA.x) * dx + (mouse.y - _hitA.y) * dy) / Math.max(dx * dx + dy * dy, 1e-6), 0, 1);
    if (Math.hypot(mouse.x - (_hitA.x + dx * t), mouse.y - (_hitA.y + dy * t)) < radius * ppm) return true;
  }
  return false;
}

let clickThroughSent = 0;
function setClickThrough(ignore) {
  // 状態が変わった時に加えて、0.5秒ごとにも送り直す (メイン側と食い違ったままにならないように)
  const now = performance.now();
  if (ignore === clickThrough && now - clickThroughSent < 500) return;
  clickThrough = ignore;
  clickThroughSent = now;
  mate.setClickThrough(ignore);
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  try {
    step(now);
  } catch (err) {
    // 途中で失敗しても、次のコマとクリックの判定は続ける
    mate.reportError(err?.stack ?? String(err));
  }
  if (vrm) {
    try {
      overCharacter = hitTest();
    } catch (err) {
      mate.reportError(err?.stack ?? String(err));
    }
    setClickThrough(!(overCharacter || dragging || rotating));
  }
}

function step(now) {
  const elapsed = (now - last) / 1000;
  if (elapsed < 1 / FPS - 0.002) return;
  last = now;
  const dt = Math.min(elapsed, 0.1);
  time += dt;

  if (vrm) {
    updateBehavior(dt);
    updateBody(dt);
    updateMotionState(dt);
    playMotion(motionName());
    let face = { surprised: 0, eyesClosed: 0, yawn: 0 };
    const body = { isV0, hipsHeight, hipsRest };
    if (currentAction) {
      // 歩きモーションは、足の運びが移動の速さと合うように再生速度を合わせる
      if (currentName === 'walk') {
        const cycle = (2 * 2 * hipsHeight * Math.sin(WALK_SWING)) / WALK_SPEED;
        currentAction.timeScale = (currentAction.getClip().duration / cycle) * clamp((m.walk - 0.35) / 0.65, 0, 1);
      }
      // 胸・首・頭はモーションに含まれない場合があるので、毎フレーム戻してから再生する
      for (const name of ['chest', 'neck', 'head']) bone(name)?.rotation.set(0, 0, 0);
      mixer.update(dt);
      // その場の状況で決まる動きだけ、再生中のポーズの上に足す
      const only = new Set(['crouch']);
      if (m.drag > 0.01) only.add('swing');
      if (currentName !== 'react' && m.waveT >= 0 && !dragging && !falling) only.add('wave');
      if (currentName !== 'pat' && m.pat > 0.01 && !dragging && !falling) only.add('pat');
      if (m.sleep > 0.01 && currentName !== 'sleep') only.add('sleep');
      face = applyPose(vrm, m, body, { only });
      face.eyesClosed = Math.max(face.eyesClosed, m.sleep);
    } else {
      face = applyPose(vrm, m, body);
    }
    followCursor(dt);
    updateFace(dt, face);
    vrm.update(dt);
    frameCount += 1;
    if (frameCount % 6 === 0) reportHead();
  }
  renderer.render(scene, camera);
}

// ---------- 入力 ----------
// カーソル位置はメイン側から画面全体の座標で届く (ウィンドウの外にいても視線が追える)
let cursorPrev = null;
mate.onCursor((p) => {
  const now = performance.now();
  if (cursorPrev) {
    const speed = Math.hypot(p.x - cursorPrev.x, p.y - cursorPrev.y) / Math.max((now - cursorPrev.t) / 1000, 1e-3);
    cursorSpeed += (speed - cursorSpeed) * 0.2;
  }
  cursorPrev = { x: p.x, y: p.y, t: now };
  lastCursor = p;
  // メイン側の位置が前回から動いていない間は、このウィンドウに届いたマウスの動きのほうを信じる
  const polledMoved = !polledPrev || polledPrev.x !== p.x || polledPrev.y !== p.y;
  polledPrev = { x: p.x, y: p.y };
  if (polledMoved || !eventCursor) eventCursor = null;
  const cx = eventCursor ? eventCursor.x : p.x;
  const cy = eventCursor ? eventCursor.y : p.y;
  mouse.x = cx - (p.wx ?? window.screenX);
  mouse.y = cy - (p.wy ?? window.screenY);
  mouse.mx = mouse.x / ppm;
  mouse.my = (window.innerHeight - mouse.y) / ppm;
  mouse.known = true;

  // 右クリックしたまま動かすと、キャラの向きが変わる: 左右で横回転、上下で見下ろす・見上げる
  // (ウィンドウの外まで動かしても続く)
  if (rotating) {
    const dx = p.x - rotating.startX;
    const dy = p.y - rotating.startY;
    if (Math.hypot(dx, dy) > 4) rotating.moved = true;
    if (rotating.moved) {
      viewYaw = rotating.startYaw + dx * 0.012;
      viewPitch = clamp(rotating.startPitch + dy * 0.012, -MAX_PITCH, MAX_PITCH);
    }
  }
});

// ---------- デモ (紹介動画の撮影用) ----------
// 決まった順番で動きを見せる。トレイのメニューか Ctrl+Alt+D で始まり、キャラをクリックすると途中で止まる。
//   action: 1回きりの仕草 (その .vrma が無ければ飛ばす) / behavior: idle・walk・sit を dur 秒
//   size: 大きさの変化 [[進み具合 0〜1, 倍率], …] (設定は変えず、デモの間だけの見た目)
//   spin: その間に左右へ回す量 (ラジアン。2π で1回転) / tilt: 途中で上からのぞき込む角度 / sway: 左右に振る幅 / say: 吹き出し
const DEMO = [
  { action: 'bow', say: 'はじめまして！' },
  { action: 'wave-both', dur: 4 },
  { behavior: 'idle', dur: 5, spin: Math.PI * 2, tilt: 0.3, say: 'くるっと回れるよ' },
  { behavior: 'idle', dur: 5, size: [[0, 1], [0.28, 0.55], [0.42, 0.55], [0.72, 1.18], [0.86, 1.18], [1, 1]], say: '大きさも変えられるよ' },
  { action: 'heart', dur: 4.5 },
  { behavior: 'walk', dir: -1, dur: 2.2 },
  { behavior: 'walk', dir: 1, dur: 2.2 },
  { action: 'joy-jump', dur: 4.5 },
  { action: 'dance', dur: 8, sway: 0.6 },
  { action: 'pose', say: 'よろしくね！' },
];
let demo = null;

// [[進み具合, 値], …] をなめらかにつないだ時の、k での値
function alongKeys(keys, k) {
  for (let i = 1; i < keys.length; i++) {
    if (k <= keys[i][0]) {
      const u = clamp((k - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]), 0, 1);
      return keys[i - 1][1] + (keys[i][1] - keys[i - 1][1]) * u * u * (3 - 2 * u);
    }
  }
  return keys[keys.length - 1][1];
}

function setDemoScale(value) {
  if (value === demoScale) return;
  demoScale = value;
  layout();
}

function startDemo(from = 0) {
  if (!vrm || dragging || falling) return;
  preview = null;
  demo = { index: from - 1, t: 0, dur: 0, yaw0: 0, home: { yaw: viewYaw, pitch: viewPitch } };
  viewYaw = 0;
  viewPitch = 0;
  nextDemoStep();
}

function stopDemo() {
  if (!demo) return;
  viewYaw = demo.home.yaw;
  viewPitch = demo.home.pitch;
  setDemoScale(1);
  demo = null;
  setBehavior('idle', rand(4, 8));
}

function nextDemoStep() {
  demo.index += 1;
  const stepDef = DEMO[demo.index];
  if (!stepDef) {
    stopDemo();
    return;
  }
  demo.t = 0;
  demo.yaw0 = viewYaw;
  if (stepDef.action) {
    if (!actions[stepDef.action]) {
      nextDemoStep(); // そのモーションが無い時は飛ばす
      return;
    }
    doAction(stepDef.action);
    demo.dur = Math.min(stepDef.dur ?? Infinity, clipSeconds(stepDef.action, 3));
  } else {
    setBehavior(stepDef.behavior, 999);
    if (stepDef.behavior === 'walk') walkDir = stepDef.dir;
    demo.dur = stepDef.dur;
  }
  if (stepDef.say) mate.sayText(stepDef.say);
}

function updateDemo(dt) {
  if (dragging || falling) {
    stopDemo();
    return;
  }
  const stepDef = DEMO[demo.index];
  demo.t += dt;
  const k = clamp(demo.t / demo.dur, 0, 1);
  const ease = k * k * (3 - 2 * k);
  if (stepDef.spin) viewYaw = demo.yaw0 + stepDef.spin * ease;
  if (stepDef.sway) viewYaw = demo.yaw0 + stepDef.sway * Math.sin(k * Math.PI * 4) * Math.sin(k * Math.PI);
  if (stepDef.tilt) viewPitch = stepDef.tilt * Math.sin(k * Math.PI);
  if (stepDef.size) setDemoScale(alongKeys(stepDef.size, k));
  if (demo.t >= demo.dur) {
    viewYaw = Math.atan2(Math.sin(viewYaw), Math.cos(viewYaw));
    viewPitch = 0;
    setDemoScale(1);
    nextDemoStep();
  }
}
mate.onDemo((data) => (demo ? stopDemo() : startDemo(data?.from ?? 0)));

// ウィンドウに届いた本物のクリックを覚えておく
const domSeen = {};
for (const type of ['mousedown', 'mouseup']) {
  window.addEventListener(type, (e) => {
    if (e.isTrusted) domSeen[`${type}${e.button}`] = performance.now();
  }, true);
}
// OS から直接見たボタンの動き。ウィンドウに同じクリックが届いていなければ、こちらで代わりに処理する
mate.onButton(({ button, down }) => {
  const type = down ? 'mousedown' : 'mouseup';
  const at = performance.now();
  const wanted = down ? overCharacter : (button === 0 ? dragging : Boolean(rotating));
  if (!vrm || !wanted) return;
  setTimeout(() => {
    if ((domSeen[`${type}${button}`] ?? 0) > at - 150) return; // 本物が届いている
    if (down) mate.clickMissed();
    const sx = (lastCursor?.x ?? 0);
    const sy = (lastCursor?.y ?? 0);
    window.dispatchEvent(new MouseEvent(type, { button, clientX: mouse.x, clientY: mouse.y, screenX: sx, screenY: sy }));
  }, 120);
});
window.addEventListener('mousemove', (e) => {
  eventCursor = { x: e.screenX, y: e.screenY };
});
window.addEventListener('mousedown', (e) => {
  if (e.button === 2 && vrm && overCharacter && !dragging) {
    rotating = { startX: e.screenX, startY: e.screenY, startYaw: viewYaw, startPitch: viewPitch, moved: false };
    return;
  }
  if (e.button !== 0 || !vrm || !overCharacter) return;
  if (demo) stopDemo(); // デモの途中でさわったら、そこで終わり
  // つかんだ点を、キャラの足元から見た位置として覚える
  const px = e.clientX / ppm;
  const py = (window.innerHeight - e.clientY) / ppm;
  const dx = px - rig.position.x;
  const dy = py - rig.position.y;
  const cos = Math.cos(-tilt);
  const sin = Math.sin(-tilt);
  grab.x = dx * cos - dy * sin;
  grab.y = dx * sin + dy * cos;
  grab.px = px;
  grab.py = py;
  dragFrom.x = window.screenX;
  dragFrom.y = window.screenY;
  dragging = true;
  grabNotified = false;
  hopY = 0;
  hopV = 0;
  hopPrep = 0;
  mate.dragStart();
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 2 && rotating) {
    // 動かさずに離した時はメニューを出す。動かした時は向きを保存する
    const { moved } = rotating;
    rotating = null;
    if (moved) {
      viewYaw = Math.atan2(Math.sin(viewYaw), Math.cos(viewYaw));
      mate.applySettings({ viewYaw, viewPitch });
    } else {
      mate.showContextMenu();
    }
    return;
  }
  if (e.button !== 0 || !dragging) return;
  dragging = false;
  const moved = Math.hypot(window.screenX - dragFrom.x, window.screenY - dragFrom.y) > 5;
  mate.dragEnd();
  if (!moved) {
    // 動かさずに離した = クリック。笑って、跳ねるか手を振る
    // 短い間に何度もつつかれたら怒る
    const now = performance.now();
    clickTimes = clickTimes.filter((t) => now - t < 3000);
    clickTimes.push(now);
    if (clickTimes.length >= 4 && actions.angry && behavior !== 'sit') {
      clickTimes = [];
      doAction('angry');
    } else if (behavior !== 'angry') {
      happyTimer = 1.8;
      if (behavior === 'sit' || Math.random() < 0.5) m.waveT = 0;
      else hopPrep = 0.14;
    }
    mate.event('click');
  }
  // 傾きが戻るのに合わせて、足元を基準位置へなめらかに戻す
  const home = { x: camera.right / 2, y: 0 };
  grab.px += home.x - (grab.px - grab.x);
  grab.py += home.y - (grab.py - grab.y);
});

// 右クリックのメニューは、ボタンを離した時に自分で出す (上の mouseup)
window.addEventListener('error', (e) => mate.reportError(e.error?.stack ?? e.message));
window.addEventListener('unhandledrejection', (e) => mate.reportError(e.reason?.stack ?? String(e.reason)));
window.addEventListener('contextmenu', (e) => e.preventDefault());

// VRM (キャラの入れ替え) や VRMA (モーションの追加) をキャラの上にドロップできる
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) mate.dropFile(file);
});

window.addEventListener('resize', layout);

mate.onReloadModel(loadModel);
mate.onSettingsChanged((next) => {
  settings = next;
  layout();
});
mate.onFallStart(() => {
  falling = true;
});
mate.onLanded((impact) => {
  falling = false;
  land(impact);
});
mate.onPreview(startPreview);
mate.onTalk((ms) => { talkUntil = performance.now() + ms; });
mate.onPreviewExpression((name) => {
  previewExpression = { name, until: performance.now() + 3000 };
});
mate.onResetView(() => {
  viewYaw = 0;
  viewPitch = 0;
});
mate.onSleep((next) => {
  asleep = Boolean(next);
  // 起きたら伸びをする
  if (!asleep && !dragging && !falling && !preview) doAction('stretch');
});
mate.onCheer(() => {
  // タイマーやリマインダーを知らせる時: 笑って手を振る
  happyTimer = 2.5;
  m.waveT = 0;
});
mate.onDoStretch(() => {
  if (!dragging && !falling && !asleep && !preview) doAction('stretch');
});
mate.onWalkBlocked(() => {
  if (demo && DEMO[demo.index]?.behavior === 'walk') demo.t = demo.dur; // 端に来たら、デモは次の動きへ
  // 画面の端に着いた、または歩けない状況だった
  walkingActive = false;
  if (behavior === 'walk') setBehavior('idle', rand(3, 6));
});

// ---------- 起動 ----------
(async () => {
  settings = await mate.getSettings();
  viewYaw = settings.viewYaw ?? 0;
  viewPitch = clamp(settings.viewPitch ?? 0, -MAX_PITCH, MAX_PITCH);
  layout();
  requestAnimationFrame(frame);
  const loaded = await loadModel();
  if (!loaded && !settings.modelName) mate.pickModel();
  // 起動のあいさつ: おじぎの動きがあれば、最初に1回おじぎする
  if (loaded && actions.bow) doAction('bow');

  // バッテリーの残量と充電の状態を知らせる (PCの状態に反応するため)
  try {
    const power = await navigator.getBattery();
    const report = () => mate.battery({ level: power.level, charging: power.charging });
    power.addEventListener('levelchange', report);
    power.addEventListener('chargingchange', report);
    report();
  } catch {
    // バッテリーの情報が取れない環境では何もしない
  }
})();
