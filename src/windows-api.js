// Windows のウィンドウ情報を調べる (ウィンドウの上に乗る・全画面アプリの検出に使う)
// Windows 以外や、読み込みに失敗した環境では何も返さない (機能がオフになるだけ)
let api = null;
let loadError = null;

const GW_HWNDNEXT = 2;
const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_TOOLWINDOW = 0x80;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9; // 影や見えない枠を除いた、見た目どおりの枠
const DWMWA_CLOAKED = 14; // 別の仮想デスクトップにあるなど、実際には見えていない
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);

function load() {
  if (api || loadError) return api;
  if (process.platform !== 'win32') {
    loadError = new Error('Windows 専用の機能です');
    return null;
  }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    koffi.struct('POINT', { x: 'long', y: 'long' });
    api = {
      GetTopWindow: user32.func('void *GetTopWindow(void *hWnd)'),
      GetCursorPos: user32.func('bool GetCursorPos(_Out_ POINT *lpPoint)'),
      GetAsyncKeyState: user32.func('short GetAsyncKeyState(int vKey)'),
      GetPhysicalCursorPos: user32.func('bool GetPhysicalCursorPos(_Out_ POINT *lpPoint)'),
      GetWindow: user32.func('void *GetWindow(void *hWnd, uint32_t uCmd)'),
      GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
      IsWindowVisible: user32.func('bool IsWindowVisible(void *hWnd)'),
      IsIconic: user32.func('bool IsIconic(void *hWnd)'),
      GetWindowTextLengthW: user32.func('int GetWindowTextLengthW(void *hWnd)'),
      GetWindowLongW: user32.func('long GetWindowLongW(void *hWnd, int nIndex)'),
      GetWindowRect: user32.func('bool GetWindowRect(void *hWnd, _Out_ RECT *lpRect)'),
      GetWindowThreadProcessId: user32.func('uint32_t GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)'),
      GetClassNameW: user32.func('int GetClassNameW(void *hWnd, uint16_t *lpClassName, int nMaxCount)'),
      DwmGetRect: dwmapi.func('long DwmGetWindowAttribute(void *hwnd, uint32_t dwAttribute, _Out_ RECT *pvAttribute, uint32_t cbAttribute)'),
      DwmGetInt: dwmapi.func('long DwmGetWindowAttribute(void *hwnd, uint32_t dwAttribute, _Out_ int32_t *pvAttribute, uint32_t cbAttribute)'),
    };
  } catch (err) {
    loadError = err;
    api = null;
  }
  return api;
}

function className(hwnd) {
  const buffer = Buffer.alloc(512);
  const length = api.GetClassNameW(hwnd, buffer, 256);
  return buffer.toString('utf16le', 0, Math.max(0, length) * 2);
}

function frameRect(hwnd) {
  const rect = {};
  if (api.DwmGetRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16) !== 0 && !api.GetWindowRect(hwnd, rect)) return null;
  return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
}

function ownerPid(hwnd) {
  const pid = [0];
  api.GetWindowThreadProcessId(hwnd, pid);
  return pid[0];
}

// いま見えているウィンドウを、手前にあるものから順に返す。枠は画面の実ピクセル単位
// (このアプリ自身のウィンドウ、最小化中・非表示のもの、デスクトップやタスクバーは除く)
function listWindows() {
  if (!load()) return [];
  const result = [];
  let hwnd = api.GetTopWindow(null);
  for (let i = 0; hwnd && i < 1000; i += 1, hwnd = api.GetWindow(hwnd, GW_HWNDNEXT)) {
    if (!api.IsWindowVisible(hwnd) || api.IsIconic(hwnd)) continue;
    const exStyle = api.GetWindowLongW(hwnd, GWL_EXSTYLE);
    if (exStyle & WS_EX_TOOLWINDOW || exStyle & WS_EX_TRANSPARENT) continue;
    if (api.GetWindowTextLengthW(hwnd) === 0) continue;
    const cloaked = [0];
    api.DwmGetInt(hwnd, DWMWA_CLOAKED, cloaked, 4);
    if (cloaked[0] !== 0) continue;
    if (ownerPid(hwnd) === process.pid) continue;
    if (SHELL_CLASSES.has(className(hwnd))) continue;
    const rect = frameRect(hwnd);
    if (!rect || rect.width < 80 || rect.height < 40) continue;
    result.push({ key: String(hwnd), rect });
  }
  return result;
}

// いま操作中のウィンドウの枠を返す (デスクトップ・タスクバー・このアプリ自身なら null)
function foregroundWindow() {
  if (!load()) return null;
  const hwnd = api.GetForegroundWindow();
  if (!hwnd || ownerPid(hwnd) === process.pid || SHELL_CLASSES.has(className(hwnd))) return null;
  const rect = {};
  if (!api.GetWindowRect(hwnd, rect)) return null;
  return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
}

// いまのカーソル位置 (物理ピクセル)。取れなければ null
function cursorPos() {
  if (!load()) return null;
  try {
    const pt = {};
    if (api.GetPhysicalCursorPos(pt) || api.GetCursorPos(pt)) return { x: pt.x, y: pt.y };
  } catch {
    // 取れない時は呼び出し側で別の方法を使う
  }
  return null;
}

// マウスのボタンがいま押されているか (ウィンドウに届くイベントに頼らない)
function buttons() {
  if (!load()) return null;
  try {
    return { left: (api.GetAsyncKeyState(0x01) & 0x8000) !== 0, right: (api.GetAsyncKeyState(0x02) & 0x8000) !== 0 };
  } catch {
    return null;
  }
}

module.exports = {
  cursorPos,
  buttons,
  listWindows,
  foregroundWindow,
  available: () => Boolean(load()),
  error: () => loadError,
};
