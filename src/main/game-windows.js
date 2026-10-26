'use strict';
/**
 * game-windows —— 游戏窗口控制器
 *
 * 三种窗口形态：
 *   openDirect  顶层直接加载游戏页（app://game/version/<id>/<entry>）
 *   openPlayer  加载 wrapper 壳页 game-window.html，壳页里用 iframe 装游戏（支持三种画面模式）
 *   openServerClient  加载服务器分发的 http 页面（多人版客户端分发场景）
 *
 * 三者共用：分辨率按工作区裁剪、F10 校准键透传、F12 开发者工具、外链交给系统浏览器、
 * 关闭后恢复应用菜单。差别只在窗口参数与菜单，所以公共部分集中在
 * attachCommonWindowHandlers() 里，三个 open* 只负责各自的窗口参数与 URL。
 */
const { BrowserWindow, screen, shell, dialog } = require('electron');
const path = require('path');
const menus = require('./menus');
const keymapTools = require('./keymap-tools');
const inject = require('./inject-scripts');
const rules = require('./game-version');
const { formatConsoleMessage } = require('./dev-harness');

const GAME_PRELOAD = path.join(__dirname, '..', 'preload', 'game-preload.js');
const MIN_W = 320;
const MIN_H = 240;

/** 把请求尺寸裁到当前显示器工作区内（保留最小尺寸下限） */
function clampToWorkArea(size) {
  let w = size.w;
  let h = size.h;
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    w = Math.max(MIN_W, Math.min(w, display.workArea.width));
    h = Math.max(MIN_H, Math.min(h, display.workArea.height));
  } catch (e) { /* 拿不到显示器信息就按原值 */ }
  return { w, h };
}

/** 固定的游戏窗口 webPreferences（沙箱 + 隔离 + 无 node） */
function gameWebPreferences() {
  return {
    preload: GAME_PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  };
}

/** 标题里的画面模式后缀（只有壳页窗口带） */
function fitTitleSuffix(fit) {
  if (fit === 'fixed') return '（固定窗口大小）';
  if (fit === 'scale') return '（固定分辨率缩放）';
  return '（自由窗口大小）';
}

/**
 * @param {object} deps
 * @param {object} deps.versionManager
 * @param {object} deps.lanServices
 * @param {boolean} deps.isMac
 * @param {object} deps.menuHost menus.createMenuHost(isMac) 的返回值
 * @param {boolean} deps.showWindows 是否显示窗口（冒烟/截图时 false，避免抢焦点）
 * @param {boolean} [deps.smoke] 冒烟模式：额外打印游戏页日志
 * @param {(opts:{createIfMissing:boolean})=>void} deps.showLauncher 显示（必要时新建）启动器窗口
 * @param {()=>void} deps.quit
 */
function createGameWindows(deps) {
  const versionManager = deps.versionManager;
  const lanServices = deps.lanServices;

  const state = {
    window: null,            // 当前游戏窗口
    versionId: null,         // 当前游戏窗口对应的版本 id
    scaleMode: 'fixed',      // direct 窗口的画面模式：fixed | free
    logical: { w: 1280, h: 720 },  // direct 窗口的逻辑分辨率（等比缩放用）
    serverFit: 'scale',      // 服务器客户端窗口的画面模式：fixed | follow | scale
    serverLogical: { w: 850, h: 890 }
  };

  const isAlive = (win) => !!win && !win.isDestroyed();

  // 服务器客户端窗口当前地址/显示名（重建菜单时要用）
  let serverUrl = '';
  let serverLabel = '';

  function destroyGame() {
    if (state.window) {
      try { state.window.destroy(); } catch (e) { /* 已销毁 */ }
    }
    state.window = null;
    state.versionId = null;
  }

  /** 当前版本的分辨率：设置 > metadata.launch.resolution > 按版本类型的默认值 */
  function resolveResolution(version) {
    const saved = versionManager.getResolution(version.id);
    if (saved && saved.w && saved.h) return saved;
    if (version.launch && version.launch.resolution) return version.launch.resolution;
    return rules.defaultResolution(version);
  }

  /** direct 窗口的分辨率：设置 > metadata > 1024×768（与壳页的默认值不同，保持原行为） */
  function resolveDirectResolution(version) {
    return versionManager.getResolution(version.id)
      || (version.launch && version.launch.resolution)
      || { w: 1024, h: 768 };
  }

  /** 等比缩放铺满（direct 窗口）：缩放 #c2canvas 并居中 */
  function applyScaleCss(on) {
    if (!isAlive(state.window)) return;
    try {
      const { w, h } = state.logical;
      const script = on ? inject.scaleFitScript(w || 1280, h || 720) : inject.SCALE_RESET_SCRIPT;
      state.window.webContents.executeJavaScript(script);
    } catch (e) { /* 注入失败不影响游戏 */ }
  }

  /** 壳页里的全屏状态同步（壳页暴露 window.__setWinFs） */
  function syncShellFullscreen() {
    if (!isAlive(state.window)) return;
    try {
      state.window.webContents.executeJavaScript('window.__setWinFs && window.__setWinFs(' + (state.window.isFullScreen() ? 'true' : 'false') + ');');
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 公共窗口事件：F10/F12、外链、调试工具、关闭清理。
   * @param {BrowserWindow} win
   * @param {object} opts
   * @param {(target:string)=>boolean} [opts.isInternalUrl] 返回 true 表示站内地址（否则交给系统浏览器）
   * @param {boolean} [opts.denyNewWindow] true = 拦截 window.open；false = 一律交给外部浏览器
   */
  function attachCommonWindowHandlers(win, opts) {
    if (process.env.MDZ_DEVTOOLS === '1') {
      try { win.webContents.openDevTools({ mode: 'detach' }); } catch (e) { /* 忽略 */ }
    }

    if (opts.isInternalUrl) {
      win.webContents.on('will-navigate', (e, target) => {
        if (!opts.isInternalUrl(target)) { e.preventDefault(); shell.openExternal(target); }
      });
    }
    if (opts.denyNewWindow) {
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    } else {
      win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    }

    /* F10 = 键盘映射校准开关。Windows 菜单栏会抢占 F10（页面收不到 keydown）→
       拦截默认行为并按原样回放给页面；f10Replay 防递归导致无限循环。 */
    let f10Replay = false;
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        try { win.webContents.toggleDevTools(); } catch (err) { /* 忽略 */ }
      }
      if (input.key === 'F10' && !f10Replay) {
        e.preventDefault();
        f10Replay = true;
        win.webContents.sendInputEvent({ type: input.type, keyCode: 'F10' });
        setTimeout(() => { f10Replay = false; }, 60);
      }
    });

    win.on('closed', () => {
      if (state.window === win) {
        state.window = null;
        state.versionId = null;
      }
      deps.menuHost.restoreAppMenu();
    });
  }

  /** 冒烟/回归模式的日志采集（只在 MDZ_SMOKE 下挂） */
  function attachSmokeLogging(win, tag) {
    win.webContents.on('console-message', (...args) => console.log('[smoke][' + tag + '-console]', formatConsoleMessage(args)));
    win.webContents.on('did-fail-load', (e, code, desc) => console.log('[smoke] ' + tag + ' load FAIL: ' + code + ' ' + desc));
    win.webContents.on('render-process-gone', (e, details) => console.log('[smoke] ' + tag + ' renderer gone: ' + JSON.stringify(details)));
  }

  // ---------------------------------------------------------------- 菜单 handlers

  /** 「返回启动器」：先关游戏窗口，再显示（或新建）启动器 */
  function backToLauncher(opts) {
    destroyGame();
    deps.showLauncher({ createIfMissing: !!(opts && opts.createIfMissing) });
  }

  /** 改分辨率前的确认框（提示先回主菜单保存进度） */
  async function confirmResolution(preset) {
    const res = await dialog.showMessageBox(state.window, {
      type: 'question',
      title: '修改分辨率',
      message: '确定将分辨率改为 ' + preset.w + '×' + preset.h + ' 吗？',
      detail: '修改分辨率会重启游戏。请先在游戏内回到主菜单保存进度，再点击「确定」。',
      buttons: ['确定重启', '取消'],
      defaultId: 1,
      cancelId: 1
    });
    return res.response === 0;
  }

  async function exportKeymap(versionId) {
    const result = await keymapTools.exportToFile(state.window, versionId, versionManager.getKeymap(versionId));
    if (result.error) console.warn('[menu] ' + result.error);
  }

  async function importKeymap(versionId) {
    try {
      await keymapTools.importFromFile(state.window, versionId, versionManager);
    } catch (e) {
      console.warn('[menu] import keymap failed: ' + e.message);
    }
  }

  /** 切换 direct 窗口的画面模式（fixed / free）→ 重启窗口生效 */
  function switchScaleMode(version, mode) {
    if (mode === state.scaleMode) return;
    state.scaleMode = mode;
    destroyGame();
    openDirect(version, { scaleMode: mode });
  }

  /** 切换壳页窗口的画面模式（fixed / follow / scale）→ 保留窗口位置尺寸 */
  function switchFit(version, fit) {
    if (fit === state.scaleMode) return;
    const bounds = (fit === 'fixed') ? null : currentBounds();
    destroyGame();
    openPlayer(version, { fit, keepBounds: bounds });
  }

  function currentBounds() {
    try { if (isAlive(state.window)) return state.window.getBounds(); } catch (e) { /* 忽略 */ }
    return null;
  }

  /** direct 窗口的菜单 handlers */
  function directMenuHandlers(version) {
    return {
      backToLauncher,
      quit: () => deps.quit(),
      toggleFullscreen: () => {
        const win = state.window;
        if (!isAlive(win)) return;
        const goFullscreen = !win.isFullScreen();
        // 不可缩放的窗口先进全屏前要解锁 resizable，否则全屏只显示左上角一块
        if (goFullscreen) { try { win.setResizable(true); } catch (e) { /* 忽略 */ } }
        win.setFullScreen(goFullscreen);
        if (!goFullscreen && state.scaleMode !== 'free') { try { win.setResizable(false); } catch (e) { /* 忽略 */ } }
      },
      selectScaleMode: (mode) => switchScaleMode(version, mode),
      selectResolution: async (preset) => {
        if (!(await confirmResolution(preset))) return;
        try {
          versionManager.setResolution(version.id, { w: preset.w, h: preset.h });
          destroyGame();
          openDirect(version, { scaleMode: state.scaleMode });
        } catch (err) { console.warn('[menu] set res failed: ' + err.message); }
      },
      launchCalibrate: () => {
        destroyGame();
        openDirect(version, { calibrate: true, scaleMode: state.scaleMode });
      },
      exportKeymap: () => exportKeymap(version.id),
      importKeymap: () => importKeymap(version.id)
    };
  }

  /** 壳页窗口的菜单 handlers（校准模式固定用 direct 的 fixed 画面，保持原行为） */
  function playerMenuHandlers(version, fit) {
    return {
      backToLauncher,
      quit: () => deps.quit(),
      toggleFullscreen: () => {
        const win = state.window;
        if (!isAlive(win)) return;
        const goFullscreen = !win.isFullScreen();
        if (goFullscreen) { try { win.setResizable(true); } catch (e) { /* 忽略 */ } }
        win.setFullScreen(goFullscreen);
      },
      selectFit: (nextFit) => switchFit(version, nextFit),
      selectScaleMode: (mode) => switchFit(version, mode),
      selectResolution: async (preset) => {
        if (!(await confirmResolution(preset))) return;
        try {
          versionManager.setResolution(version.id, { w: preset.w, h: preset.h });
          const bounds = (fit === 'fixed') ? null : currentBounds();
          destroyGame();
          openPlayer(version, { fit, keepBounds: bounds });
        } catch (err) { console.warn('[menu] set res failed: ' + err.message); }
      },
      launchCalibrate: () => {
        destroyGame();
        openDirect(version, { calibrate: true, scaleMode: 'fixed' });
      },
      exportKeymap: () => exportKeymap(version.id),
      importKeymap: () => importKeymap(version.id)
    };
  }

  // ---------------------------------------------------------------- direct 窗口

  /**
   * 顶层直接加载游戏页。
   * @param {object} version
   * @param {{calibrate?:boolean, scaleMode?:'fixed'|'free'}} [opts]
   */
  function openDirect(version, opts) {
    const o = opts || {};
    destroyGame();

    const dbKey = version.dbKey || ('version_' + version.id);
    const mode = o.scaleMode || state.scaleMode;
    state.scaleMode = mode;
    const free = mode === 'free';
    const requestedRes = resolveDirectResolution(version);
    const { w, h } = clampToWorkArea(requestedRes);

    const url = `app://game/version/${encodeURIComponent(version.id)}/${version.entry || 'index.html'}` +
      `?dbKey=${encodeURIComponent(dbKey)}${o.calibrate ? '&calibrate=1' : ''}`;

    state.versionId = version.id;
    state.logical = { w, h };

    const win = new BrowserWindow({
      width: w,
      height: h,
      useContentSize: !free,          // 固定分辨率：内容区=分辨率；自由缩放：窗口自由
      resizable: free,                // 固定分辨率锁定窗口；自由缩放可拖大
      maximizable: free,
      minWidth: free ? MIN_W : w,
      minHeight: free ? MIN_H : h,
      title: (version.name || version.id) + ' · ' + w + '×' + h,
      backgroundColor: '#000000',
      autoHideMenuBar: false,
      show: deps.showWindows,
      webPreferences: gameWebPreferences()
    });
    state.window = win;

    deps.menuHost.setWinMenu(win, menus.buildGameMenu({
      resolution: requestedRes,
      scaleMode: mode,
      isFullScreen: win.isFullScreen(),
      handlers: directMenuHandlers(version)
    }));

    win.loadURL(url);
    attachCommonWindowHandlers(win, { isInternalUrl: (t) => t.startsWith('app://game/'), denyNewWindow: true });

    win.webContents.on('did-finish-load', () => {
      if (free || win.isFullScreen()) applyScaleCss(true);
    });
    win.on('enter-full-screen', () => {
      try { win.setResizable(true); } catch (e) { /* 忽略 */ }
      applyScaleCss(true);
    });
    win.on('leave-full-screen', () => {
      if (!free) {
        try { win.setResizable(false); } catch (e) { /* 忽略 */ }
        applyScaleCss(false);
      }
    });

    // 存档隔离补丁必须在游戏脚本执行前注入；键鼠原生版本不装键盘映射器
    win.webContents.on('dom-ready', () => {
      try { win.webContents.executeJavaScript(inject.DBKEY_PATCH); } catch (e) { console.warn('[dbkey] inject failed: ' + e.message); }
      if (!rules.isMapperDisabled(version)) {
        try { win.webContents.executeJavaScript(inject.MAPPER_LOADER); } catch (e) { console.warn('[mapper] inject failed: ' + e.message); }
      }
    });

    if (deps.smoke) {
      win.webContents.on('did-finish-load', async () => {
        console.log('[smoke] game window loaded: ' + win.webContents.getURL());
        try {
          const info = await win.webContents.executeJavaScript(`JSON.stringify({
            title: document.title,
            hasCanvas: !!document.getElementById('c2canvas'),
            dbKey: (window.__launcher && window.__launcher.versionId) || null,
            patch: (window.indexedDB.open + '').indexOf('suffix') !== -1
          })`);
          console.log('[smoke] game page: ' + info);
        } catch (e) { console.log('[smoke] game verify error: ' + e.message); }
      });
      attachSmokeLogging(win, 'game');
    }
    return win;
  }

  // ---------------------------------------------------------------- 壳页窗口

  /**
   * 加载 wrapper 壳页（iframe 内装游戏）。
   * @param {object} version
   * @param {{calibrate?:boolean, fit?:'fixed'|'follow'|'scale', keepBounds?:object|null}} [opts]
   */
  function openPlayer(version, opts) {
    const o = opts || {};
    destroyGame();

    const dbKey = version.dbKey || ('version_' + version.id);
    const requested = resolveResolution(version);
    const { w, h } = clampToWorkArea(requested);
    const fit = o.fit || 'scale';
    const lock = fit === 'fixed';

    state.scaleMode = fit;
    state.versionId = version.id;

    let url = 'app://game/_launcher/game-window.html?v=' + encodeURIComponent(version.id) +
      '&e=' + encodeURIComponent(version.entry || 'index.html') +
      '&dbKey=' + encodeURIComponent(dbKey) +
      '&w=' + w + '&h=' + h + '&fit=' + fit +
      (o.calibrate ? '&cal=1' : '') +
      (rules.isMapperDisabled(version) ? '&nk=1' : '');
    /* 多人版客户端：把当前信令地址、玩家名交给壳页注入游戏 iframe（mdz=1 让客户端页隐藏滚动条） */
    if (rules.isLanClient(version)) {
      url += '&sig=' + encodeURIComponent(lanServices.endpoints().signalUrl) +
        '&user=' + encodeURIComponent(lanServices.status().playerName || 'MiniPlayer') +
        '&mdz=1';
    }

    const win = new BrowserWindow({
      width: w,
      height: h,
      useContentSize: true,
      resizable: !lock,
      maximizable: !lock,
      minWidth: lock ? w : 480,
      minHeight: lock ? h : 300,
      title: (version.name || version.id) + ' · ' + w + '×' + h + fitTitleSuffix(fit),
      backgroundColor: '#000000',
      autoHideMenuBar: false,
      show: deps.showWindows,
      webPreferences: gameWebPreferences()
    });
    state.window = win;
    if (o.keepBounds) { try { win.setBounds(o.keepBounds); } catch (e) { /* 忽略 */ } }

    deps.menuHost.setWinMenu(win, menus.buildPlayerMenu({
      resolution: requested,
      fit,
      isFullScreen: win.isFullScreen(),
      handlers: playerMenuHandlers(version, fit)
    }));

    win.loadURL(url);
    attachCommonWindowHandlers(win, { isInternalUrl: (t) => t.startsWith('app://game/'), denyNewWindow: true });

    /* 全屏：fixed 窗口先进全屏要解锁 resizable；Windows 上全屏时隐藏菜单栏（mac 无窗口菜单栏，跳过）。
       退出全屏时 fixed 要把窗口恢复成逻辑分辨率尺寸——延迟两次兜底，避开退出全屏动画覆盖 setContentSize。 */
    win.on('enter-full-screen', () => {
      try { win.setResizable(true); } catch (e) { /* 忽略 */ }
      if (!deps.isMac) { try { win.setMenuBarVisibility(false); } catch (e) { /* 忽略 */ } }
      syncShellFullscreen();
    });
    win.on('leave-full-screen', () => {
      syncShellFullscreen();
      if (!deps.isMac) { try { win.setMenuBarVisibility(true); } catch (e) { /* 忽略 */ } }
      if (lock) {
        const restoreSize = () => {
          if (!isAlive(state.window)) return;
          try { state.window.setContentSize(w, h); } catch (e) { /* 忽略 */ }
          try { state.window.setResizable(false); } catch (e) { /* 忽略 */ }
        };
        setTimeout(restoreSize, 60);
        setTimeout(restoreSize, 400);
      }
    });
    win.webContents.on('did-finish-load', () => syncShellFullscreen());

    return win;
  }

  // ---------------------------------------------------------------- 服务器分发的客户端

  /** 服务器客户端窗口：按缩放因子适配（不是分辨率） */
  function applyServerZoom() {
    const win = state.window;
    if (!isAlive(win)) return;
    try {
      if (state.serverFit !== 'scale') { win.webContents.setZoomFactor(1); return; }
      const [cw, ch] = win.getContentSize();
      const k = Math.max(0.3, Math.min(3, Math.min(cw / state.serverLogical.w, ch / state.serverLogical.h)));
      win.webContents.setZoomFactor(Math.round(k * 100) / 100);
    } catch (e) { /* 忽略 */ }
  }

  function setServerFit(fit) {
    state.serverFit = fit;
    const win = state.window;
    if (!isAlive(win)) return;
    if (fit === 'fixed') { try { win.setContentSize(state.serverLogical.w, state.serverLogical.h); } catch (e) { /* 忽略 */ } }
    try { win.setResizable(fit !== 'fixed'); } catch (e) { /* 忽略 */ }
    applyServerZoom();
    /* 不能在菜单点击回调里同步重建菜单（Electron 抛 Invalid Menu）→ 延后一帧 */
    setTimeout(() => {
      if (isAlive(state.window)) {
        try { deps.menuHost.setWinMenu(state.window, menus.buildServerMenu({ url: serverUrl, label: serverLabel, fit: state.serverFit, handlers: serverMenuHandlers() })); } catch (e) { /* 忽略 */ }
      }
    }, 30);
  }

  function serverMenuHandlers() {
    return {
      backToLauncher: (opts) => backToLauncher({ createIfMissing: !!(opts && opts.createIfMissing) }),
      toggleFullscreen: () => {
        try { state.window.setFullScreen(!state.window.isFullScreen()); } catch (e) { /* 忽略 */ }
      },
      selectFit: (fit) => setServerFit(fit),
      zoomIn: () => {
        try { state.window.webContents.setZoomFactor(Math.min(3, state.window.webContents.getZoomFactor() + 0.1)); } catch (e) { /* 忽略 */ }
      },
      zoomOut: () => {
        try { state.window.webContents.setZoomFactor(Math.max(0.3, state.window.webContents.getZoomFactor() - 0.1)); } catch (e) { /* 忽略 */ }
      },
      zoomReset: () => {
        try { state.window.webContents.setZoomFactor(1); } catch (e) { /* 忽略 */ }
      }
    };
  }

  /**
   * @param {string} url 客户端页地址
   * @param {string} label 显示名
   * @param {{w?:number,h?:number,fit?:string,mode?:'fullscreen'}} [opts]
   */
  function openServerClient(url, label, opts) {
    const o = opts || {};
    destroyGame();
    serverUrl = url;
    serverLabel = label || '';

    let w = (o.w && Number.isFinite(o.w)) ? o.w : 850;
    let h = (o.h && Number.isFinite(o.h)) ? o.h : 890;
    const size = clampToWorkArea({ w, h });
    w = size.w; h = size.h;

    state.serverLogical = { w, h };
    if (o.fit) state.serverFit = o.fit;
    state.versionId = rules.LAN_CLIENT_ID;
    const lock = state.serverFit === 'fixed';

    const win = new BrowserWindow({
      width: w,
      height: h,
      useContentSize: true,
      resizable: !lock,
      maximizable: !lock,
      minWidth: lock ? w : 480,
      minHeight: lock ? h : 300,
      title: 'MiniDayZ 多人版客户端 · ' + (label || url) + ' · ' + w + '×' + h,
      backgroundColor: '#000000',
      autoHideMenuBar: false,
      show: deps.showWindows,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    state.window = win;

    try {
      deps.menuHost.setWinMenu(win, menus.buildServerMenu({ url, label, fit: state.serverFit, handlers: serverMenuHandlers() }));
    } catch (e) { /* 忽略 */ }

    win.loadURL(url);
    attachCommonWindowHandlers(win, {
      isInternalUrl: (target) => {
        try { return new URL(target).host === new URL(url).host; } catch (err) { return false; }
      },
      denyNewWindow: false
    });

    win.webContents.on('did-finish-load', () => {
      // 游戏画面不该出滚动条；画布居中
      try {
        win.webContents.insertCSS(
          'html,body{overflow:hidden !important;max-height:100% !important;}\n' +
          'body{margin:0 !important;background:#000 !important;}\n' +
          '#c2canvasdiv{margin:0 auto !important;}\n'
        );
      } catch (e) { /* 忽略 */ }
      applyServerZoom();
      if (o.mode === 'fullscreen') { try { win.setFullScreen(true); } catch (e) { /* 忽略 */ } }
    });
    win.on('resize', () => applyServerZoom());
    win.on('enter-full-screen', () => {
      if (!deps.isMac) { try { win.setMenuBarVisibility(false); } catch (e) { /* 忽略 */ } }
      applyServerZoom();
    });
    win.on('leave-full-screen', () => {
      if (!deps.isMac) { try { win.setMenuBarVisibility(true); } catch (e) { /* 忽略 */ } }
      applyServerZoom();
    });
    return win;
  }

  /** 分辨率设置变化时同步已打开的游戏窗口（IPC config:setResolution 用） */
  function applyResolutionToOpenWindow(versionId, resolution) {
    const win = state.window;
    if (!isAlive(win) || state.versionId !== versionId) return;
    try {
      win.setContentSize(resolution.w, resolution.h);
      win.setTitle((win.getTitle().split(' · ')[0]) + ' · ' + resolution.w + '×' + resolution.h);
    } catch (e) { /* 忽略 */ }
  }

  return {
    state,
    getGame: () => state.window,
    getGameVersionId: () => state.versionId,
    getScaleMode: () => state.scaleMode,
    openDirect,
    openPlayer,
    openServerClient,
    switchFit,
    switchScaleMode,
    closeGame: destroyGame,
    backToLauncher,
    applyResolutionToOpenWindow
  };
}

module.exports = { createGameWindows, clampToWorkArea };
