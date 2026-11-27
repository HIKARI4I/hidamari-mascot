// 設定画面: 変更はすぐキャラに反映され、自動で保存される
const api = window.mate;
const $ = (id) => document.getElementById(id);

const SWITCHES = ['alwaysOnTop', 'lookAtCursor', 'wander', 'rideWindows', 'chatter', 'hourly', 'pcReact', 'hideOnFullscreen', 'autoStart'];
const MOTION_LABELS = {
  idle: '待機', walk: '歩き', sit: '座り', stretch: '伸び', react: '手を振る', pat: 'なでられ', drag: 'つかまれ', fall: '落下',
  sleep: '眠る', startled: 'びっくり', 'look-around': 'きょろきょろ', yawn: 'あくび', hair: '髪をさわる', skirt: 'スカートを直す',
  'peek-up': '見上げる', doze: 'うとうと', 'wave-both': '両手を振る', angry: 'ぷんぷん', heart: 'ハート', 'joy-jump': '喜んでジャンプ',
  reach: '手を伸ばす', crouch: 'しゃがむ', 'lie-down': '寝転ぶ', bow: 'おじぎ', dance: 'ダンス', pose: '決めポーズ',
};

const EXPRESSION_LABELS = {
  blink: 'まばたき', blinkLeft: '左目を閉じる', blinkRight: '右目を閉じる',
  happy: 'うれしい', angry: '怒り', sad: '悲しい', relaxed: 'リラックス', surprised: 'おどろき',
  aa: 'あ', ih: 'い', ou: 'う', ee: 'え', oh: 'お',
  smile: 'ほほえみ', joy: '大笑い', shy: '照れ笑い', smirk: 'いたずら笑い', winkRight: '右目ウインク', winkLeft: '左目ウインク',
  puff: '頬をぷくっと', worried: '心配', gloomy: 'しょんぼり', holdTears: '涙をこらえる', annoyed: 'むっとする', doubt: '疑い',
  puzzled: '困惑', serious: '真剣', thinking: '考え中', sleepy: '眠たげ', relief: '安堵', squeeze: 'きゅっと目を閉じる',
  kiss: 'キス顔', whistle: '口笛', confident: '自信顔',
  grin: '満面の笑み', tongueOut: '舌をぺろり', surprisedO: 'おどろき（丸い口）', awe: '感嘆', fear: '恐怖',
  cry: '泣き顔', rage: '激怒', fedUp: '呆れ顔', yawn: 'あくび',
};

// ---- タブ ----
for (const tab of document.querySelectorAll('nav button')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('nav button')) other.setAttribute('aria-selected', String(other === tab));
    for (const panel of document.querySelectorAll('.tab')) panel.classList.toggle('active', panel.id === `tab-${tab.dataset.tab}`);
  });
}

// ---- 表示 ----
function show(settings) {
  $('modelName').textContent = settings.modelName ?? '未選択';
  $('height').value = settings.heightPx;
  $('heightValue').textContent = settings.heightPx;
  for (const id of SWITCHES) $(id).checked = settings[id];
  for (const radio of document.querySelectorAll('input[name="landing"]')) radio.checked = radio.value === settings.landing;
  $('breakMinutes').value = String(settings.breakMinutes);
  $('hideShortcut').textContent = settings.hideShortcut;

  // ウィンドウの情報が取れない環境では、それを使う機能を選べなくする
  if (!settings.windowsApi) {
    for (const id of ['rideWindows', 'hideOnFullscreen']) $(id).disabled = true;
    $('rideHint').textContent = 'この環境では使えません（Windows専用）';
    $('fullscreenHint').textContent = 'この環境では使えません（Windows専用）';
  }

  showTimer(settings.timer);
  showReminders(settings.reminders);
  showMotions(settings.motions);
  showExpressions(settings.expressions ?? []);
}

function showTimer(timer) {
  $('timerIdle').hidden = Boolean(timer);
  $('timerRunning').hidden = !timer;
  if (!timer) return;
  const m = Math.floor(timer.remaining / 60);
  const s = timer.remaining % 60;
  $('timerRemaining').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function showReminders(reminders) {
  const list = $('reminders');
  list.replaceChildren();
  for (const reminder of reminders) {
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = reminder.time;
    const text = document.createElement('span');
    text.textContent = reminder.text || '（内容なし）';
    const remove = document.createElement('button');
    remove.className = 'btn';
    remove.textContent = '削除';
    remove.setAttribute('aria-label', `${reminder.time} のリマインダーを削除`);
    remove.addEventListener('click', () => api.reminderRemove(reminder.id));
    item.append(time, text, remove);
    list.append(item);
  }
}

function showMotions(names) {
  const grid = $('motions');
  if (grid.dataset.names === names.join(',')) return;
  grid.dataset.names = names.join(',');
  grid.replaceChildren();
  for (const name of names) {
    const button = document.createElement('button');
    button.className = 'btn';
    button.textContent = MOTION_LABELS[name] ?? name;
    if (MOTION_LABELS[name]) {
      const file = document.createElement('small');
      file.textContent = name;
      button.append(file);
    }
    button.addEventListener('click', () => api.previewMotion(name));
    grid.append(button);
  }
}

function showExpressions(names) {
  $('expressionSection').hidden = names.length === 0;
  const grid = $('expressions');
  if (grid.dataset.names === names.join(',')) return;
  grid.dataset.names = names.join(',');
  grid.replaceChildren();
  for (const name of names) {
    const button = document.createElement('button');
    button.className = 'btn';
    button.textContent = EXPRESSION_LABELS[name] ?? name;
    if (EXPRESSION_LABELS[name]) {
      const sub = document.createElement('small');
      sub.textContent = name;
      button.append(sub);
    }
    button.addEventListener('click', () => api.previewExpression(name));
    grid.append(button);
  }
}

// ---- 操作 ----
$('pick').addEventListener('click', () => api.pickModel());
$('reset').addEventListener('click', () => api.resetPosition());
$('resetView').addEventListener('click', () => api.resetView());
$('sayTest').addEventListener('click', () => api.sayTest());

$('height').addEventListener('input', (e) => {
  const heightPx = Number(e.target.value);
  $('heightValue').textContent = heightPx;
  api.applySettings({ heightPx });
});

for (const radio of document.querySelectorAll('input[name="landing"]')) {
  radio.addEventListener('change', () => api.applySettings({ landing: radio.value }));
}
for (const id of SWITCHES) {
  $(id).addEventListener('change', (e) => api.applySettings({ [id]: e.target.checked }));
}
$('breakMinutes').addEventListener('change', (e) => api.applySettings({ breakMinutes: Number(e.target.value) }));

$('timerStart').addEventListener('click', () => api.timerStart(Number($('timerMinutes').value)));
$('timerCancel').addEventListener('click', () => api.timerCancel());

$('reminderAdd').addEventListener('click', () => {
  const time = $('reminderTime').value;
  if (!time) return;
  api.reminderAdd({ time, text: $('reminderText').value.trim() });
  $('reminderText').value = '';
});

// ---- VRM のドラッグ&ドロップ ----
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth += 1;
  document.body.classList.add('dropping');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove('dropping');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  const file = e.dataTransfer?.files?.[0];
  if (file) api.dropFile(file);
});

api.onSettingsChanged(show);
api.onTimerState(showTimer);
api.getSettings().then(show);
