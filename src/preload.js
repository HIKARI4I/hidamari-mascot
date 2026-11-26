// 描画側 (キャラのウィンドウ・設定画面・吹き出し) に公開する最小限のAPI
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload));
const send = (channel) => (payload) => ipcRenderer.send(channel, payload);

contextBridge.exposeInMainWorld('mate', {
  // 読み込み
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getModel: () => ipcRenderer.invoke('get-model'),
  getMotions: () => ipcRenderer.invoke('get-motions'),
  // キャラのウィンドウ → メイン
  setClickThrough: send('set-click-through'),
  dragStart: send('drag-start'),
  dragEnd: send('drag-end'),
  walkStart: send('walk-start'),
  walkStop: send('walk-stop'),
  showContextMenu: send('show-context-menu'),
  event: send('mate-event'),
  headPosition: send('head-position'),
  battery: send('battery'),
  expressions: send('expressions'),
  // ドロップされたファイルの場所を調べて渡す
  dropFile: (file) => ipcRenderer.send('drop-file', webUtils.getPathForFile(file)),
  // 設定画面 → メイン
  applySettings: send('apply-settings'),
  pickModel: send('pick-model'),
  resetPosition: send('reset-position'),
  resetView: send('reset-view'),
  previewMotion: send('preview-motion'),
  previewExpression: send('preview-expression'),
  timerStart: send('timer-start'),
  timerCancel: send('timer-cancel'),
  reminderAdd: send('reminder-add'),
  reminderRemove: send('reminder-remove'),
  sayTest: send('say-test'),
  // 吹き出し → メイン
  bubbleSize: send('bubble-size'),
  // メイン → 描画側
  onReloadModel: on('reload-model'),
  onSettingsChanged: on('settings-changed'),
  onCursor: on('cursor'),
  onFallStart: on('fall-start'),
  onLanded: on('landed'),
  onWalkBlocked: on('walk-blocked'),
  onPreview: on('preview'),
  onPreviewExpression: on('preview-expression'),
  onTalk: on('talk'),
  onButton: on('button'),
  clickMissed: () => ipcRenderer.send('click-missed'),
  reportError: (text) => ipcRenderer.send('renderer-error', text),
  onResetView: on('reset-view'),
  onSleep: on('sleep'),
  onCheer: on('cheer'),
  onDoStretch: on('do-stretch'),
  onTimerState: on('timer-state'),
  onBubbleText: on('bubble-text'),
  onBubbleHide: on('bubble-hide'),
});
