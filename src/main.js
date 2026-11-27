// メインプロセス: キャラ用の小さな透明ウィンドウを動かす・設定・トレイ・おしゃべり・タイマー・PCの見守り
const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, screen, nativeImage, globalShortcut, powerMonitor, shell,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const winApi = require('./windows-api');
const LINES = require('./lines');

const APP_DIR = path.join(__dirname, '..');
const MODELS_DIR = path.join(APP_DIR, 'models');
const MOTIONS_DIR = path.join(APP_DIR, 'motions');
const LOG_FILE = path.join(APP_DIR, 'mate.log');
const WINDOW_SCALE = 1.3; // ウィンドウの一辺 = キャラの身長 × この値 (揺れと跳ねの余白)
const TICK_MS = 16;
const HIDE_SHORTCUT = 'Control+Alt+H';
const DEMO_SHORTCUT = 'Control+Alt+D'; // 紹介用のデモを再生 / 停止
const BUILT_IN_MOTIONS = ['idle', 'walk', 'sit', 'stretch', 'react', 'pat', 'drag', 'fall'];
const IDLE_SLEEP_SECONDS = 300; // これだけPCを触らないと眠る

let mateWin = null;
let settingsWin = null;
let bubbleWin = null;
let tray = null;
let config = {
  modelPath: null,
  heightPx: 450,
  landing: 'fall', // 'fall' = 離すと地面に着地 / 'float' = その場で浮いたまま
  alwaysOnTop: true,
  lookAtCursor: true,
  wander: true, // 自由に歩き回る・座る
  rideWindows: true, // ほかのウィンドウの上に乗る
  chatter: true, // ときどきひとりごとを言う・反応してしゃべる
  hourly: true, // 時報
  pcReact: true, // PCの状態に反応する
  hideOnFullscreen: true, // 全画面のアプリの間は隠れる
  breakMinutes: 0, // 休憩の声かけの間隔 (0 = しない)
  reminders: [], // { id, time: 'HH:MM', text } 毎日その時刻に知らせる
  viewYaw: 0, // キャラの向き: 左右 (ラジアン。0 = 正面)
  viewPitch: 0, // キャラの向き: 上下 (プラスで上から見下ろす)
  position: null, // { x, y } ウィンドウ左上
};

// ドラッグ・落下・歩きはここでウィンドウごと動かす
// platform: いま乗っているウィンドウ { key, dx } (null = タスクバーの上の地面)
let buttonState = { left: false, right: false };
const motion = { mode: 'rest', offX: 0, offY: 0, x: 0, vx: 0, y: 0, vy: 0, last: 0, platform: null };
let modelExpressions = []; // いまのモデルが持っている表情の名前 (描画側から届く)
const head = { x: 0.5, y: 0.1 }; // 頭のてっぺんの位置 (ウィンドウの幅・高さに対する割合。描画側から届く)

// 画面上の位置を整数にする。Math.round は -0.3 を「-0」にするが、Electron は -0 を整数として受け取れず
// ウィンドウの移動に失敗する (画面の左端・上端の近くで起きる) ので、必ず 0 に直す
const px = (v) => Math.round(v) || 0;

// ---------- ログ (動作がおかしい時の手がかり。mate.log に残す) ----------
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? p.stack : String(p))).join(' ')}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // ログが書けなくても動作は続ける
  }
}
const loggedOnce = new Set();
function logOnce(key, ...parts) {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  log(...parts);
}

// ---------- 設定 ----------
const configPath = () => path.join(app.getPath('userData'), 'config.json');
const winSize = () => Math.round(config.heightPx * WINDOW_SCALE);
const sendMate = (channel, payload) => {
  if (mateWin && !mateWin.isDestroyed()) mateWin.webContents.send(channel, payload);
};
const sendSettings = (channel, payload) => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload);
};

function loadConfig() {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch {
    // 初回起動時は設定ファイルがないので既定値のまま
  }
  if (!Array.isArray(config.reminders)) config.reminders = [];
}

function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

// 設定で選んだVRM → なければ models フォルダの最初のVRM
function resolveModelPath() {
  if (config.modelPath && fs.existsSync(config.modelPath)) return config.modelPath;
  try {
    const first = fs.readdirSync(MODELS_DIR).find((f) => f.toLowerCase().endsWith('.vrm'));
    if (first) return path.join(MODELS_DIR, first);
  } catch {
    // models フォルダがない場合は未選択扱い
  }
  return null;
}

function motionFiles() {
  try {
    return fs.readdirSync(MOTIONS_DIR).filter((f) => f.toLowerCase().endsWith('.vrma'));
  } catch {
    return [];
  }
}

// Windows のログイン時に自動で起動する設定 (開発用の起動でも、このフォルダを開くよう登録する)
const loginItem = () => ({ path: process.execPath, args: [`"${APP_DIR}"`] });
function autoStartEnabled() {
  try {
    return app.getLoginItemSettings(loginItem()).openAtLogin;
  } catch {
    return false;
  }
}

function publicSettings() {
  const modelPath = resolveModelPath();
  const names = new Set(BUILT_IN_MOTIONS);
  for (const file of motionFiles()) names.add(path.basename(file, path.extname(file)).toLowerCase());
  return {
    heightPx: config.heightPx,
    landing: config.landing,
    alwaysOnTop: config.alwaysOnTop,
    lookAtCursor: config.lookAtCursor,
    wander: config.wander,
    rideWindows: config.rideWindows,
    chatter: config.chatter,
    hourly: config.hourly,
    pcReact: config.pcReact,
    hideOnFullscreen: config.hideOnFullscreen,
    breakMinutes: config.breakMinutes,
    reminders: config.reminders,
    viewYaw: config.viewYaw,
    viewPitch: config.viewPitch,
    autoStart: autoStartEnabled(),
    windowsApi: winApi.available(), // false なら「ウィンドウに乗る」「全画面で隠れる」は使えない
    hideShortcut: 'Ctrl + Alt + H',
    motions: [...names],
    expressions: modelExpressions,
    modelName: modelPath ? path.basename(modelPath) : null,
    timer: timerState(),
  };
}

// ---------- 足場 (地面と、ほかのウィンドウの上の縁) ----------
const centerOf = (b) => ({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
const areaOf = (b) => screen.getDisplayNearestPoint(centerOf(b)).workArea;

let windowCache = { at: 0, list: [] };
// いま見えているウィンドウ (手前から順)。枠はこのアプリと同じ座標系に直してある
function visibleWindows() {
  if (!config.rideWindows || config.landing !== 'fall') return [];
  const now = Date.now();
  if (now - windowCache.at < 50) return windowCache.list;
  let list = [];
  try {
    if (process.env.MATE_TEST_WINDOWS) list = JSON.parse(fs.readFileSync(process.env.MATE_TEST_WINDOWS, 'utf8')); // 開発用: 偽のウィンドウ一覧
    else list = winApi.listWindows().map((w) => ({ key: w.key, rect: screen.screenToDipRect(null, w.rect) }));
  } catch (err) {
    logOnce('listWindows', 'ウィンドウ一覧の取得に失敗:', err);
  }
  windowCache = { at: now, list };
  return list;
}

// list[index] のウィンドウの上の縁に、横位置 cx で立てるか
function standable(list, index, cx) {
  const r = list[index].rect;
  const margin = Math.min(config.heightPx * 0.2, r.width / 2 - 1);
  if (cx < r.x + margin || cx > r.x + r.width - margin) return false;
  const area = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(r.y) }).workArea;
  if (r.y - config.heightPx < area.y) return false; // 上に体が入るすき間がない (最大化中など)
  if (r.y > area.y + area.height - 30) return false; // ほぼ地面と同じ高さ
  for (let j = 0; j < index; j += 1) {
    // 手前のウィンドウに縁が隠れている
    const q = list[j].rect;
    if (cx >= q.x && cx <= q.x + q.width && r.y + 2 >= q.y && r.y + 2 <= q.y + q.height) return false;
  }
  return true;
}

// 足の高さ feetY より下で、いちばん近い足場を探す (なければ地面)
function findFloor(b, feetY) {
  const cx = b.x + b.width / 2;
  const area = areaOf(b);
  let best = { top: area.y + area.height, key: null, rect: null };
  const list = visibleWindows();
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i].rect;
    if (r.y >= feetY - 6 && r.y < best.top && standable(list, i, cx)) best = { top: r.y, key: list[i].key, rect: r };
  }
  return best;
}

function settleOn(b, floor) {
  mateWin.setPosition(b.x, px(floor.top - b.height));
  motion.platform = floor.key ? { key: floor.key, dx: b.x - floor.rect.x } : null;
  motion.mode = 'rest';
  rememberPosition();
}

function homePosition() {
  const area = screen.getPrimaryDisplay().workArea;
  const size = winSize();
  return { x: Math.round(area.x + (area.width - size) / 2), y: area.y + area.height - size };
}

function rememberPosition() {
  if (!mateWin) return;
  const [x, y] = mateWin.getPosition();
  config.position = { x, y };
  saveConfig();
}

// 保存してあった位置が、いまつながっている画面の外なら中央に戻す
function initialPosition() {
  const size = winSize();
  const p = config.position;
  if (p) {
    const cx = p.x + size / 2;
    const cy = p.y + size / 2;
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height;
    });
    if (visible) return p;
  }
  return homePosition();
}

function startFall() {
  if (!mateWin) return;
  const b = mateWin.getBounds();
  const floor = findFloor(b, b.y + b.height);
  if (b.y + b.height >= floor.top - 1) {
    settleOn(b, floor); // もう足場の上 (または地面より下) にいる
    return;
  }
  motion.mode = 'fall';
  motion.platform = null;
  motion.y = b.y;
  motion.vy = 0;
  motion.last = Date.now();
  sendMate('fall-start');
}

function tick() {
  if (!mateWin || mateWin.isDestroyed()) return;
  let cursor = screen.getCursorScreenPoint();
  // Electron から取るカーソル位置は、画面の切り取り (スクリーンショット) の後などに古いまま止まることがある。
  // Windows では OS から直接取った位置を優先する
  const direct = winApi.cursorPos();
  if (direct) {
    try {
      const p = screen.screenToDipPoint(direct);
      cursor = { x: Math.round(p.x), y: Math.round(p.y) };
    } catch (err) {
      logOnce('cursor-direct', 'カーソル位置の変換に失敗:', err);
    }
  }
  // マウスのボタンも OS から直接見る。ウィンドウにクリックが届かなくなった時の予備の経路
  const held = winApi.buttons();
  if (held) {
    if (held.left !== buttonState.left) sendMate('button', { button: 0, down: held.left });
    if (held.right !== buttonState.right) sendMate('button', { button: 2, down: held.right });
    buttonState = held;
  }
  if (process.env.MATE_TEST_CURSOR) {
    // 開発用: カーソルがキャラの頭から見て指定の位置にあることにする (視線の確認)
    const [dx, dy] = process.env.MATE_TEST_CURSOR.split(',').map(Number);
    const mb = mateWin.getBounds();
    cursor = { x: Math.round(mb.x + mb.width * head.x + dx), y: Math.round(mb.y + mb.height * head.y + dy) };
  }
  const now = Date.now();
  const dt = Math.min((now - motion.last) / 1000, 0.05);
  const b = mateWin.getBounds();

  try {
    if (motion.mode === 'drag') {
      mateWin.setPosition(px(cursor.x - motion.offX), px(cursor.y - motion.offY));
    } else if (motion.mode === 'fall') {
      motion.last = now;
      const pxPerMeter = config.heightPx / 1.5;
      const floor = findFloor(b, motion.y + b.height); // 落ちる前の足の高さより下にある足場
      motion.vy += 9.8 * pxPerMeter * dt;
      motion.y += motion.vy * dt;
      if (motion.y + b.height >= floor.top) {
        const impact = motion.vy / pxPerMeter; // 着地の強さ (m/s)
        settleOn(b, floor);
        sendMate('landed', impact);
        if (impact > 2.5) sayReaction('land', 0.35);
      } else {
        mateWin.setPosition(b.x, px(motion.y));
      }
    } else if (motion.mode === 'walk') {
      motion.last = now;
      stepWalk(b, dt);
    } else if (motion.platform) {
      followPlatform(b);
    }
  } catch (err) {
    // 位置の計算に失敗した時は、その場で止めてやり直す (ここで止まるとクリックの判定まで止まってしまう)
    logOnce('tick-move', '移動の失敗:', err);
    motion.mode = 'rest';
    motion.platform = null;
    motion.x = b.x;
    motion.y = b.y;
    motion.vy = 0;
  }

  // 視線と、カーソルがキャラの上にあるかの判定に使う。
  // ウィンドウの位置も一緒に送る (描画側の window.screenX は、こちらから動かした直後は古いままのことがある)
  const wb = mateWin.getContentBounds();
  sendMate('cursor', { x: cursor.x, y: cursor.y, wx: wb.x, wy: wb.y });
  if (bubbleVisible) placeBubble();
}

// 乗っているウィンドウの今の枠を返す (なくなった・隠れた時は null)
function currentPlatform(cxOffset) {
  const list = visibleWindows();
  const index = list.findIndex((w) => w.key === motion.platform.key);
  if (index < 0) return null;
  const rect = list[index].rect;
  return { rect, index, list, ok: (x) => standable(list, index, x + cxOffset) };
}

// ウィンドウの上で休んでいる間: そのウィンドウが動けば一緒に動き、消えたら落ちる
function followPlatform(b) {
  const platform = currentPlatform(b.width / 2);
  if (!platform) {
    startFall();
    return;
  }
  const x = px(platform.rect.x + motion.platform.dx);
  const y = px(platform.rect.y - b.height);
  if (!platform.ok(x)) {
    motion.platform = null;
    startFall();
  } else if (x !== b.x || y !== b.y) {
    mateWin.setPosition(x, y);
  }
}

// 歩き: 地面なら今いる画面の中、ウィンドウの上ならその幅の中を横に動く
function stepWalk(b, dt) {
  const nextX = motion.x + motion.vx * dt;
  const center = nextX + b.width / 2;
  const margin = config.heightPx * 0.2;
  let top;
  let blocked;
  if (motion.platform) {
    const platform = currentPlatform(b.width / 2);
    if (!platform) {
      startFall();
      return;
    }
    top = platform.rect.y;
    blocked = !platform.ok(nextX);
    if (!blocked) motion.platform.dx = nextX - platform.rect.x;
  } else {
    const area = areaOf(b);
    top = area.y + area.height;
    blocked = center < area.x + margin || center > area.x + area.width - margin;
  }
  if (!Number.isFinite(nextX) || !Number.isFinite(top)) {
    // 位置が数にならなかった時は歩くのをやめる (そのまま進めるとウィンドウを動かす所で止まってしまう)
    logOnce('walk-nan', '歩きの位置が計算できなかったため、歩くのをやめました');
    motion.x = b.x;
    motion.vx = 0;
    motion.mode = 'rest';
    sendMate('walk-blocked');
    return;
  }
  if (blocked) {
    logOnce('walk-edge', '歩きを止めた: 画面の端か、足場の端に来た');
    motion.mode = 'rest';
    sendMate('walk-blocked');
    rememberPosition();
  } else {
    motion.x = nextX;
    mateWin.setPosition(px(nextX), px(top - b.height));
  }
}

// ---------- ウィンドウ ----------
function createMateWindow() {
  const size = winSize();
  const pos = initialPosition();
  mateWin = new BrowserWindow({
    x: pos.x, y: pos.y, width: size, height: size,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });
  mateWin.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver');
  // キャラ以外の透明な部分はクリックを下のアプリへ素通しする (マウス移動だけ受け取る)
  mateWin.setIgnoreMouseEvents(true, { forward: true });
  mateWin.loadFile(path.join(__dirname, 'index.html'));
  mateWin.on('closed', () => { mateWin = null; });
}

function createBubbleWindow() {
  bubbleWin = new BrowserWindow({
    width: 280, height: 80,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  bubbleWin.setAlwaysOnTop(true, 'screen-saver');
  bubbleWin.setIgnoreMouseEvents(true);
  bubbleWin.loadFile(path.join(__dirname, 'bubble.html'));
  bubbleWin.on('closed', () => { bubbleWin = null; });
}

function openSettings() {
  if (settingsWin) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 460, height: 700,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'Hidamari Mascot 設定',
    icon: path.join(APP_DIR, 'assets', 'tray.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

function resizeMateWindow(oldSize) {
  if (!mateWin) return;
  const size = winSize();
  const b = mateWin.getBounds();
  // 足元 (下端の中央) を動かさずに大きさだけ変える
  mateWin.setBounds({
    x: px(b.x + (oldSize - size) / 2),
    y: b.y + oldSize - size,
    width: size,
    height: size,
  });
  if (motion.platform) motion.platform.dx += (oldSize - size) / 2;
}

// ---------- おしゃべり (吹き出し) ----------
let bubbleVisible = false;
let bubbleTimer = null;
let bubbleSize = { width: 280, height: 80 };
let lastSpokeAt = 0;
let nextChatterAt = Date.now() + 90_000;

const pick = (list) => list[Math.floor(Math.random() * list.length)];
function line(category, vars = {}) {
  const text = pick(LINES[category] ?? [category]);
  return text.replace(/\{(\w+)\}/g, (_m, key) => (key in vars ? String(vars[key]) : ''));
}

function say(text, seconds = 4.5) {
  if (!bubbleWin || !mateWin || hidden()) return;
  lastSpokeAt = Date.now();
  clearTimeout(bubbleTimer);
  bubbleWin.webContents.send('bubble-text', text);
  // しゃべっている間は口を動かす (寝言は口を動かさない)
  if (!sleeping) sendMate('talk', Math.min(2500, Math.max(700, text.length * 110)));
  bubbleTimer = setTimeout(hideBubble, seconds * 1000);
}

function hideBubble() {
  clearTimeout(bubbleTimer);
  if (!bubbleWin || !bubbleVisible) return;
  bubbleWin.webContents.send('bubble-hide');
  bubbleTimer = setTimeout(() => {
    bubbleVisible = false;
    bubbleWin?.hide();
  }, 250);
}

// 吹き出しを頭の上に置く (画面からはみ出す時は内側へ寄せる)
function placeBubble() {
  if (!bubbleWin || !mateWin) return;
  const b = mateWin.getBounds();
  const area = areaOf(b);
  const headX = b.x + b.width * head.x;
  const headY = b.y + b.height * head.y;
  const x = Math.min(Math.max(headX - bubbleSize.width / 2, area.x), area.x + area.width - bubbleSize.width);
  const y = Math.max(headY - bubbleSize.height - 6, area.y);
  bubbleWin.setBounds({ x: px(x), y: px(y), width: bubbleSize.width, height: bubbleSize.height });
}

// クリックなどへの反応のセリフ。毎回しゃべるとうるさいので、間をあけて、たまにだけ
function sayReaction(category, chance) {
  if (!config.chatter || sleeping) return;
  if (Date.now() - lastSpokeAt < 6000 || Math.random() > chance) return;
  say(line(category), 3);
}

function greeting() {
  const h = new Date().getHours();
  if (h < 4) return line('night');
  if (h < 11) return line('morning');
  if (h < 18) return line('daytime');
  return line('evening');
}

// ---------- タイマー・リマインダー・時報 ----------
let timer = null; // { endsAt, minutes }
let nextBreakAt = 0;
let lastHourKey = '';
const firedReminders = new Set();

function timerState() {
  return timer ? { minutes: timer.minutes, remaining: Math.max(0, Math.round((timer.endsAt - Date.now()) / 1000)) } : null;
}

function startTimer(minutes) {
  const m = Math.min(600, Math.max(1, Math.round(Number(minutes) || 0)));
  timer = { endsAt: Date.now() + m * 60_000, minutes: m };
  say(line('timerStart', { m }));
  sendSettings('timer-state', timerState());
  rebuildTrayMenu();
}

function cancelTimer() {
  if (!timer) return;
  timer = null;
  say(line('timerCancel'), 3);
  sendSettings('timer-state', null);
  rebuildTrayMenu();
}

// 知らせる時は、吹き出し + 手を振る + 音
function announce(text) {
  say(text, 10);
  sendMate('cheer');
  shell.beep();
}

function scheduleBreak() {
  nextBreakAt = config.breakMinutes > 0 ? Date.now() + config.breakMinutes * 60_000 : 0;
}

function everySecond() {
  const now = new Date();
  if (timer) {
    if (Date.now() >= timer.endsAt) {
      const { minutes } = timer;
      timer = null;
      announce(line('timerDone', { m: minutes }));
      rebuildTrayMenu();
    }
    sendSettings('timer-state', timerState());
  }

  if (nextBreakAt && Date.now() >= nextBreakAt) {
    scheduleBreak();
    if (!sleeping) {
      say(line('breakTime'), 8);
      sendMate('do-stretch');
    }
  }

  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const day = now.toDateString();
  for (const reminder of config.reminders) {
    const key = `${day} ${reminder.id}`;
    if (reminder.time === hhmm && !firedReminders.has(key)) {
      firedReminders.add(key);
      announce(reminder.text || 'じかんだよ！');
    }
  }

  const hourKey = `${day} ${now.getHours()}`;
  if (now.getMinutes() === 0 && hourKey !== lastHourKey) {
    lastHourKey = hourKey;
    const h = now.getHours();
    if (config.hourly && !sleeping) say(line(h < 5 ? 'lateNight' : 'hourly', { h }), 6);
  }

  if (config.chatter && !sleeping && Date.now() >= nextChatterAt) {
    nextChatterAt = Date.now() + (3 + Math.random() * 5) * 60_000;
    if (Date.now() - lastSpokeAt > 30_000) say(line('chatter'));
  }

  checkFullscreen();
}

// ---------- PCの見守り ----------
let sleeping = false;
let lastCpu = null;
let hotCount = 0;
let lastZzzAt = 0;
const cooldown = {};
const ready = (key, minutes) => {
  if (Date.now() - (cooldown[key] ?? 0) < minutes * 60_000) return false;
  cooldown[key] = Date.now();
  return true;
};
const battery = { level: 1, charging: true, warned: false, known: false };

function cpuUsage() {
  const totals = os.cpus().reduce((sum, cpu) => {
    const t = cpu.times;
    return { idle: sum.idle + t.idle, all: sum.all + t.user + t.nice + t.sys + t.idle + t.irq };
  }, { idle: 0, all: 0 });
  const previous = lastCpu;
  lastCpu = totals;
  if (!previous || totals.all === previous.all) return 0;
  return 1 - (totals.idle - previous.idle) / (totals.all - previous.all);
}

function setSleeping(next) {
  if (sleeping === next) return;
  sleeping = next;
  sendMate('sleep', next);
  if (next) {
    lastZzzAt = Date.now();
    say(line('sleep'), 5);
  } else {
    say(line('wake'), 5);
  }
}

function watchPc() {
  const usage = cpuUsage();
  if (process.env.MATE_TEST_SLEEP) return; // 開発用: 居眠りの見た目を確かめる間は起こさない
  if (!config.pcReact) {
    setSleeping(false);
    return;
  }
  // しばらくPCを触っていないと眠る。戻ってきたら起きる
  const idleSeconds = powerMonitor.getSystemIdleTime();
  if (idleSeconds >= IDLE_SLEEP_SECONDS) setSleeping(true);
  else if (idleSeconds < 10) setSleeping(false);
  if (sleeping) {
    if (Date.now() - lastZzzAt > 60_000) {
      lastZzzAt = Date.now();
      say(line('sleep'), 5);
    }
    return;
  }

  hotCount = usage > 0.85 ? hotCount + 1 : 0;
  if (hotCount >= 3 && ready('cpu', 10)) say(line('cpuHot'), 6);
  if (1 - os.freemem() / os.totalmem() > 0.92 && ready('memory', 30)) say(line('memoryFull'), 6);
}

function onBattery(next) {
  if (!next || typeof next.level !== 'number') return;
  const wasCharging = battery.charging;
  const first = !battery.known;
  Object.assign(battery, { level: next.level, charging: Boolean(next.charging), known: true });
  if (!config.pcReact || first) return;
  if (battery.charging && !wasCharging) say(line('charging'), 5);
  if (battery.charging || battery.level > 0.25) battery.warned = false;
  if (!battery.charging && battery.level <= 0.2 && !battery.warned) {
    battery.warned = true;
    say(line('batteryLow'), 8);
  }
}

// ---------- 隠す・表示する ----------
let userHidden = false; // ショートカットやメニューで隠した
let autoHidden = false; // 全画面のアプリがあるので隠れている
const hidden = () => userHidden || autoHidden;

function applyVisibility() {
  if (!mateWin) return;
  if (hidden()) {
    hideBubble();
    bubbleVisible = false;
    bubbleWin?.hide();
    mateWin.hide();
  } else {
    mateWin.showInactive();
    mateWin.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver');
  }
  rebuildTrayMenu();
}

function toggleHidden() {
  userHidden = !userHidden;
  applyVisibility();
}

// 操作中のウィンドウが、キャラのいる画面いっぱいに広がっていたら隠れる (ゲームや動画の全画面)
function checkFullscreen() {
  let full = false;
  if (config.hideOnFullscreen && mateWin) {
    try {
      const raw = winApi.foregroundWindow();
      if (raw) {
        const rect = screen.screenToDipRect(null, raw);
        const display = screen.getDisplayMatching(rect);
        const d = display.bounds;
        const covers = Math.abs(rect.x - d.x) <= 1 && Math.abs(rect.y - d.y) <= 1
          && Math.abs(rect.width - d.width) <= 2 && Math.abs(rect.height - d.height) <= 2;
        full = covers && display.id === screen.getDisplayNearestPoint(centerOf(mateWin.getBounds())).id;
      }
    } catch (err) {
      logOnce('fullscreen', '全画面の検出に失敗:', err);
    }
  }
  if (full !== autoHidden) {
    autoHidden = full;
    applyVisibility();
  }
}

// ---------- 設定の反映 ----------
function applySettings(patch) {
  const oldSize = winSize();
  if (typeof patch.heightPx === 'number') config.heightPx = Math.min(1000, Math.max(150, Math.round(patch.heightPx)));
  if (patch.landing === 'fall' || patch.landing === 'float') config.landing = patch.landing;
  for (const key of ['alwaysOnTop', 'lookAtCursor', 'wander', 'rideWindows', 'chatter', 'hourly', 'pcReact', 'hideOnFullscreen']) {
    if (typeof patch[key] === 'boolean') config[key] = patch[key];
  }
  if (typeof patch.breakMinutes === 'number') {
    config.breakMinutes = Math.min(240, Math.max(0, Math.round(patch.breakMinutes)));
    scheduleBreak();
  }
  if (typeof patch.viewYaw === 'number' && Number.isFinite(patch.viewYaw)) {
    config.viewYaw = Math.atan2(Math.sin(patch.viewYaw), Math.cos(patch.viewYaw)); // -180°〜180° に収める
  }
  if (typeof patch.viewPitch === 'number' && Number.isFinite(patch.viewPitch)) {
    config.viewPitch = Math.min(1.5, Math.max(-1.5, patch.viewPitch));
  }
  if (typeof patch.autoStart === 'boolean') {
    try {
      app.setLoginItemSettings({ ...loginItem(), openAtLogin: patch.autoStart });
    } catch (err) {
      log('自動起動の設定に失敗:', err);
    }
  }
  saveConfig();

  if (winSize() !== oldSize) resizeMateWindow(oldSize);
  if (!hidden()) mateWin?.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver');
  if (motion.mode === 'rest' && config.landing === 'fall') {
    // 着地の設定や「ウィンドウに乗る」を変えた時は、足場を選び直す
    if (motion.platform && !config.rideWindows) motion.platform = null;
    if (!motion.platform) startFall();
  }
  if (config.landing === 'float') motion.platform = null;
  if (!config.hideOnFullscreen) checkFullscreen();
  sendMate('settings-changed', publicSettings());
  rememberPosition();
}

function useModel(file) {
  config.modelPath = file;
  saveConfig();
  sendMate('reload-model');
  sendSettings('settings-changed', publicSettings());
}

async function pickModel() {
  const result = await dialog.showOpenDialog({
    title: 'VRMファイルを選ぶ',
    filters: [{ name: 'VRM', extensions: ['vrm'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return;
  useModel(result.filePaths[0]);
}

// ドラッグ&ドロップされたファイル: .vrm はキャラの入れ替え、.vrma は motions フォルダへ追加
function handleDroppedFile(file) {
  if (typeof file !== 'string' || !fs.existsSync(file)) return;
  const ext = path.extname(file).toLowerCase();
  if (ext === '.vrm') {
    useModel(file);
    setTimeout(() => say(line('dropped')), 1500);
  } else if (ext === '.vrma') {
    try {
      fs.mkdirSync(MOTIONS_DIR, { recursive: true });
      fs.copyFileSync(file, path.join(MOTIONS_DIR, path.basename(file).toLowerCase()));
      sendMate('reload-model');
      sendSettings('settings-changed', publicSettings());
      say(`「${path.basename(file, ext)}」の動きをおぼえたよ！`);
    } catch (err) {
      log('モーションの追加に失敗:', err);
    }
  } else {
    say(line('dropFailed'));
  }
}

function resetPosition() {
  if (!mateWin) return;
  const pos = homePosition();
  motion.mode = 'rest';
  motion.platform = null;
  mateWin.setPosition(pos.x, pos.y);
  rememberPosition();
}

function resetView() {
  config.viewYaw = 0;
  config.viewPitch = 0;
  saveConfig();
  sendMate('reset-view');
}

// ---------- トレイ ----------
function buildMenu() {
  const timerItems = [5, 10, 15, 25, 60].map((m) => ({ label: `${m}分`, click: () => startTimer(m) }));
  if (timer) timerItems.push({ type: 'separator' }, { label: `取り消す（${timer.minutes}分のタイマー）`, click: cancelTimer });
  return Menu.buildFromTemplate([
    { label: '設定…', click: openSettings },
    { label: userHidden ? '表示する' : '隠す', accelerator: HIDE_SHORTCUT, click: toggleHidden },
    { label: 'タイマー', submenu: timerItems },
    { type: 'separator' },
    { label: 'VRMを選ぶ…', click: pickModel },
    { label: 'デモを再生 / 停止', accelerator: DEMO_SHORTCUT, click: playDemo },
    { label: '画面中央に戻す', click: resetPosition },
    { label: '向きを正面に戻す', click: resetView },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() },
  ]);
}

function rebuildTrayMenu() {
  tray?.setContextMenu(buildMenu());
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(APP_DIR, 'assets', 'tray.png')));
  tray.setToolTip('Hidamari Mascot');
  rebuildTrayMenu();
  tray.on('double-click', openSettings);
}

// ---------- 描画側とのやりとり ----------
ipcMain.on('set-click-through', (_e, ignore) => {
  if (!mateWin) return;
  if (ignore) mateWin.setIgnoreMouseEvents(true, { forward: true });
  else mateWin.setIgnoreMouseEvents(false);
});
// 描画側から: キャラの上で押されたのに、ウィンドウにはクリックが届かなかった
let missedClicks = 0;
ipcMain.on('click-missed', () => {
  missedClicks += 1;
  if (!mateWin) return;
  logOnce('click-missed', 'クリックがウィンドウに届かなかったため、予備の経路で処理しました (以後は記録しません)');
  // 立て直しを試みる: クリック透過をかけ直し、いちばん手前に出し直す
  mateWin.setIgnoreMouseEvents(true, { forward: true });
  mateWin.setIgnoreMouseEvents(false);
  mateWin.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver');
  mateWin.moveTop();
});
// 描画側で起きたエラーを mate.log に残す (原因を後から調べられるように)
let rendererErrors = 0;
ipcMain.on('renderer-error', (_e, text) => {
  rendererErrors += 1;
  if (rendererErrors <= 20) log('描画側のエラー:', String(text).slice(0, 600));
});

ipcMain.on('drag-start', () => {
  if (!mateWin) return;
  const cursor = screen.getCursorScreenPoint();
  const [x, y] = mateWin.getPosition();
  motion.mode = 'drag';
  motion.platform = null;
  motion.offX = cursor.x - x;
  motion.offY = cursor.y - y;
});

ipcMain.on('drag-end', () => {
  if (motion.mode !== 'drag') return;
  motion.mode = 'rest';
  if (config.landing === 'fall') startFall();
  else rememberPosition();
});

// 歩いている間は毎フレーム速さが届く (歩き出しと止まり際をなめらかにするため)
ipcMain.on('walk-start', (_e, vx) => {
  if (!mateWin || typeof vx !== 'number' || !Number.isFinite(vx)) return;
  const speed = Math.max(-600, Math.min(600, vx));
  if (motion.mode === 'walk') {
    motion.vx = speed;
    return;
  }
  const b = mateWin.getBounds();
  const area = areaOf(b);
  const grounded = motion.platform || Math.abs(b.y + b.height - (area.y + area.height)) <= 2;
  if (motion.mode !== 'rest' || config.landing !== 'fall' || !grounded || hidden()) {
    // 歩き出せなかった理由を、理由ごとに1回だけ残す
    const why = motion.mode !== 'rest' ? `ほかの動作中 (${motion.mode})` : config.landing !== 'fall' ? '設定が「浮いたまま」' : hidden() ? '非表示中' : `地面に立っていない (足元 ${b.y + b.height} / 地面 ${area.y + area.height})`;
    logOnce(`walk-reject-${why.slice(0, 6)}`, '歩き出せなかった:', why);
    sendMate('walk-blocked');
    return;
  }
  logOnce('walk-ok', '歩き出した (初回のみ記録)');
  motion.mode = 'walk';
  motion.x = b.x;
  motion.vx = speed;
  motion.last = Date.now();
});

// 開発用: 歩きの指示と結果を記録する
if (process.env.MATE_TEST_WALKLOG) {
  let n = 0;
  ipcMain.on('walk-start', (_e, vx) => {
    n += 1;
    if (n % 20 === 1 && mateWin) log(`[walk] vx=${vx} mode=${motion.mode} x=${motion.x} bounds=${JSON.stringify(mateWin.getBounds())} area=${JSON.stringify(areaOf(mateWin.getBounds()))} landing=${config.landing} platform=${Boolean(motion.platform)} hidden=${hidden()}`);
  });
}
ipcMain.on('walk-stop', () => {
  if (motion.mode !== 'walk') return;
  motion.mode = 'rest';
  rememberPosition();
});

// キャラに起きた出来事 (クリックされた・なでられた・つかまれた) → たまにしゃべる
ipcMain.on('mate-event', (_e, name) => {
  if (name === 'click') sayReaction('click', 0.6);
  else if (name === 'pat') sayReaction('pat', 0.5);
  else if (name === 'grab') sayReaction('grab', 0.6);
});

ipcMain.on('head-position', (_e, p) => {
  if (p && typeof p.x === 'number' && typeof p.y === 'number') Object.assign(head, { x: p.x, y: p.y });
});
ipcMain.on('battery', (_e, state) => onBattery(state));
ipcMain.on('bubble-size', (_e, size) => {
  if (!bubbleWin || !size || hidden()) return;
  bubbleSize = { width: Math.ceil(size.width), height: Math.ceil(size.height) };
  placeBubble();
  bubbleVisible = true;
  bubbleWin.showInactive();
  bubbleWin.setAlwaysOnTop(true, 'screen-saver');
});

ipcMain.on('show-context-menu', () => buildMenu().popup({ window: mateWin }));
ipcMain.on('open-settings', openSettings);
ipcMain.on('pick-model', pickModel);
ipcMain.on('drop-file', (_e, file) => handleDroppedFile(file));
ipcMain.on('reset-position', resetPosition);
ipcMain.on('reset-view', resetView);
ipcMain.on('apply-settings', (_e, patch) => applySettings(patch ?? {}));
ipcMain.on('preview-motion', (_e, name) => {
  if (typeof name !== 'string') return;
  if (userHidden) toggleHidden();
  setSleeping(false);
  sendMate('preview', { name, seconds: 5 });
});
ipcMain.on('expressions', (_e, names) => {
  modelExpressions = Array.isArray(names) ? names.filter((n) => typeof n === 'string').slice(0, 200) : [];
  sendSettings('settings-changed', publicSettings());
});
ipcMain.on('preview-expression', (_e, name) => {
  if (typeof name !== 'string') return;
  if (userHidden) toggleHidden();
  setSleeping(false);
  sendMate('preview-expression', name);
});
ipcMain.on('timer-start', (_e, minutes) => startTimer(minutes));
ipcMain.on('timer-cancel', cancelTimer);
ipcMain.on('reminder-add', (_e, reminder) => {
  if (!reminder || !/^\d{2}:\d{2}$/.test(reminder.time ?? '')) return;
  config.reminders.push({ id: Date.now().toString(36), time: reminder.time, text: String(reminder.text ?? '').slice(0, 60) });
  config.reminders.sort((a, b) => a.time.localeCompare(b.time));
  saveConfig();
  sendSettings('settings-changed', publicSettings());
});
ipcMain.on('reminder-remove', (_e, id) => {
  config.reminders = config.reminders.filter((r) => r.id !== id);
  saveConfig();
  sendSettings('settings-changed', publicSettings());
});
ipcMain.on('say-test', () => say(line('chatter')));
// デモの台本にあるせりふを吹き出しに出す
ipcMain.on('say-text', (_e, text) => {
  if (typeof text === 'string' && text.length <= 60) say(text, 3.5);
});

// 紹介用のデモを描画側に始めさせる (もう一度呼ぶと止まる)
function playDemo() {
  if (!mateWin || hidden()) return;
  sendMate('demo');
}
ipcMain.handle('get-settings', () => publicSettings());

ipcMain.handle('get-model', () => {
  const p = resolveModelPath();
  if (!p) return null;
  return { name: path.basename(p), data: fs.readFileSync(p) };
});

// motions フォルダの .vrma を全部渡す (ファイル名が動きの名前になる。例: idle.vrma)
ipcMain.handle('get-motions', () => motionFiles().map((f) => ({
  name: path.basename(f, path.extname(f)).toLowerCase(),
  data: fs.readFileSync(path.join(MOTIONS_DIR, f)),
})));

// ---------- 起動 ----------
// Windows + 一部のグラフィックドライバー (NVIDIAなど) では、透明ウィンドウを出すと画面全体が
// 黒くなることがある。画面の合成だけソフトウェアで行うと起きない (3Dの描画はGPUのまま)
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-gpu-compositing');

// 以前の名前 (hikari-desktop-mate) で保存した設定があれば、最初の1回だけ引き継ぐ
try {
  const oldDir = path.join(app.getPath('appData'), 'hikari-desktop-mate');
  const newDir = app.getPath('userData');
  if (oldDir !== newDir && !fs.existsSync(path.join(newDir, 'config.json')) && fs.existsSync(path.join(oldDir, 'config.json'))) {
    fs.mkdirSync(newDir, { recursive: true });
    fs.copyFileSync(path.join(oldDir, 'config.json'), path.join(newDir, 'config.json'));
  }
} catch {
  // 引き継げなくても、初期設定で動く
}

process.on('uncaughtException', (err) => log('予期しないエラー:', err));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', openSettings);
  app.whenReady().then(() => {
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 200_000) fs.unlinkSync(LOG_FILE);
    } catch {
      // 古いログが消せなくても続ける
    }
    loadConfig();
    log(`起動 v${app.getVersion()} / ウィンドウ情報の取得: ${winApi.available() ? '使える' : `使えない (${winApi.error()?.message})`}`);
    createMateWindow();
    createBubbleWindow();
    createTray();
    scheduleBreak();
    cpuUsage();
    setInterval(tick, TICK_MS);
    setInterval(everySecond, 1000);
    setInterval(watchPc, 5000);
    if (!globalShortcut.register(HIDE_SHORTCUT, toggleHidden)) log(`ショートカット ${HIDE_SHORTCUT} を登録できませんでした`);
    if (!globalShortcut.register(DEMO_SHORTCUT, playDemo)) log(`ショートカット ${DEMO_SHORTCUT} を登録できませんでした`);
    powerMonitor.on('unlock-screen', () => { if (config.pcReact) say(line('unlock'), 5); });
    setTimeout(() => { if (config.chatter) say(greeting(), 5); }, 4000);

    // 開発用: MATE_TEST_SHOT=保存先フォルダ を指定すると、連続コマと設定画面・吹き出しを保存して終了する
    if (process.env.MATE_TEST_SHOT) {
      const dir = process.env.MATE_TEST_SHOT;
      const frames = Number(process.env.MATE_TEST_FRAMES ?? 1);
      const gap = Number(process.env.MATE_TEST_GAP ?? 300);
      openSettings();
      setTimeout(() => {
        if (process.env.MATE_TEST_POSE) sendMate('preview', { name: process.env.MATE_TEST_POSE, seconds: 9999 });
        if (process.env.MATE_TEST_SLEEP) setSleeping(true);
        if (process.env.MATE_TEST_DEMO) playDemo();
        if (process.env.MATE_TEST_TAB) settingsWin.webContents.executeJavaScript(`document.querySelector('[data-tab="${process.env.MATE_TEST_TAB}"]').click()`);
        if (process.env.MATE_TEST_DROP_FROM) {
          // 上から落として、足場に乗るかを確かめる
          const [x] = mateWin.getPosition();
          mateWin.setPosition(x, Number(process.env.MATE_TEST_DROP_FROM));
          startFall();
        }
      }, 3000);
      const trace = [];
      if (process.env.MATE_TEST_DROP_FROM) setInterval(() => trace.push({ t: Date.now(), ...mateWin.getBounds(), mode: motion.mode, platform: motion.platform?.key ?? null }), 250);
      process.on('exit', () => { if (trace.length) fs.writeFileSync(path.join(dir, 'trace.json'), JSON.stringify(trace)); });
      setTimeout(async () => {
        for (let i = 0; i < frames; i += 1) {
          fs.writeFileSync(path.join(dir, `mate${i}.png`), (await mateWin.webContents.capturePage()).toPNG());
          await new Promise((done) => setTimeout(done, gap));
        }
        fs.writeFileSync(path.join(dir, 'settings.png'), (await settingsWin.webContents.capturePage()).toPNG());
        fs.writeFileSync(path.join(dir, 'bubble.png'), (await bubbleWin.webContents.capturePage()).toPNG());
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ bubbleVisible, bubbleSize, bubble: bubbleWin.getBounds(), mate: mateWin.getBounds(), head }));
        app.quit();
      }, Number(process.env.MATE_TEST_AT ?? 6000));
    }
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // 設定画面を閉じてもキャラは残す (終了はトレイメニューから)
  app.on('window-all-closed', () => {
    if (!mateWin) app.quit();
  });
}
