'use strict';
/**
 * main —— 主进程入口
 *
 * 这里只做三件事：
 *   1) 启动前定下数据目录（Chromium userData 只能在 ready 之前设置）
 *   2) app ready 后按顺序初始化各子系统（版本 → 内置版整理 → 协议 → 联机 → 存档传输 → IPC → 窗口）
 *   3) 应用级生命周期（单实例、activate、退出清理）
 *
 * 具体能力都在各自模块里：
 *   app-paths    数据目录布局与便携模式引导
 *   protocol     app:// 自定义协议（版本静态文件 + 存档隔离补丁注入）
 *   game-windows 游戏窗口（direct / 壳页 / 服务器客户端）
 *   menus        原生菜单模板与挂载
 *   ipc          渲染层调用主进程的全部通道
 *   lan-services / save-transfer / mdz-save-service  联机与存档传输
 *   uitest / dev-harness  开发期回归与截图钩子
 */
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

const versionManager = require('./version-manager');
const appPaths = require('./app-paths');
const menus = require('./menus');
const { createGameWindows } = require('./game-windows');
const { syncBuiltinVersions } = require('./builtin-sync');
const { registerIpcHandlers } = require('./ipc');
const { registerPrivilegedSchemes, registerGameProtocol } = require('./protocol');
const { attachShotHarness, formatConsoleMessage } = require('./dev-harness');
const { runUITest } = require('./uitest');
const saveIo = require('./save-io');
const lanServices = require('./lan-services');
const saveTransfer = require('./save-transfer');

const IS_MAC = process.platform === 'darwin';
const LAUNCHER_ENTRY = 'app://game/_launcher/index.html';

// 启动参数：打包后 exe 不接受裸 --switch（Electron 会当成自己的参数报错），所以同时支持环境变量
const IS_SMOKE = process.argv.includes('--smoke') || process.env.MDZ_SMOKE === '1';
const IS_UITEST = process.argv.includes('--uitest') || process.env.MDZ_UITEST === '1';

/* app:// 是安全上下文，页面里连局域网 ws:// 信令会被当混合内容拦——
   多人版客户端与单机版一样直接读本地文件，所以需要打开这个开关。
   作用域是整个启动器进程（本地程序、只连自己的信令服务器）。 */
app.commandLine.appendSwitch('allow-running-insecure-content');

// ================= 数据目录（必须在 ready 之前定好） =================

app.setName('MDZLauncher');  // 必须先于 getPath('userData')，否则目录名不对
const layout = appPaths.resolveLayout(app);
const boot = appPaths.bootstrapDataDir({ layout, isMac: IS_MAC });
app.setPath('userData', boot.dataDir);

// ================= 单实例 =================

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

/**
 * 启动编排。所有子系统都在这里被「创建并接线」，但自己不实现业务逻辑。
 */
function start() {
  app.setName('MDZLauncher');
  const startedAt = Date.now();

  /** 启动阶段耗时（MDZ_TIMING=1 时打印，定位「启动慢」） */
  const timing = (tag) => {
    if (process.env.MDZ_TIMING !== '1') return;
    const line = '[t] ' + tag + ' +' + (Date.now() - startedAt) + 'ms';
    console.log(line);
    try {
      require('fs').appendFileSync(path.join(process.env.TEMP || '.', 'mdz-boot.txt'), line + '\n');
    } catch (e) { /* 临时目录不可写就算了 */ }
  };

  // 默认硬件加速；遇到 GPU 兼容问题（地图花屏/白屏）可设 MDZ_SOFT=1 回退软件渲染
  if (process.env.MDZ_SOFT === '1') app.disableHardwareAcceleration();

  registerPrivilegedSchemes();

  const menuHost = menus.createMenuHost(IS_MAC);
  let launcherWin = null;

  const windows = createGameWindows({
    versionManager,
    lanServices,
    menuHost,
    isMac: IS_MAC,
    showWindows: !IS_SMOKE,
    smoke: IS_SMOKE,
    showLauncher,
    quit: () => app.quit()
  });

  /** 显示启动器窗口；没有就新建（macOS 关掉窗口后应用仍在运行） */
  function showLauncher(opts) {
    const createIfMissing = !opts || opts.createIfMissing !== false;
    if (!launcherWin && createIfMissing) { createLauncherWindow(); return; }
    if (launcherWin) { launcherWin.show(); launcherWin.focus(); }
  }

  function sendToLauncher(channel, payload) {
    try {
      if (launcherWin && !launcherWin.isDestroyed()) launcherWin.webContents.send(channel, payload);
    } catch (e) { /* 窗口已关，忽略 */ }
  }

  function createLauncherWindow() {
    launcherWin = new BrowserWindow({
      width: 1080,
      height: 720,
      minWidth: 860,
      minHeight: 560,
      title: 'MINIDAYZ Launcher',
      backgroundColor: '#14161c',
      autoHideMenuBar: true,
      show: !IS_SMOKE,   // 立即显示（先底色后内容），不让用户觉得「双击没反应」
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'launcher-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    timing('launcher-window-created');
    launcherWin.loadURL(LAUNCHER_ENTRY);

    if (process.env.MDZ_TIMING === '1') {
      launcherWin.webContents.once('did-finish-load', () => timing('launcher-did-finish-load'));
    }
    if (process.env.MDZ_DEVTOOLS === '1') {
      try { launcherWin.webContents.openDevTools({ mode: 'detach' }); } catch (e) { /* 忽略 */ }
    }
    // 外部 http(s) 链接交给系统浏览器；内部 app:// 子窗口（window.open / document.write）保持允许
    launcherWin.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
      return { action: 'allow' };
    });
    launcherWin.on('closed', () => { launcherWin = null; });

    if (IS_SMOKE) {
      launcherWin.webContents.on('did-finish-load', async () => {
        console.log('[smoke] launcher window loaded');
        try {
          const title = await launcherWin.webContents.executeJavaScript('document.title');
          const bridge = await launcherWin.webContents.executeJavaScript('!!window.__launcherNative');
          const cards = await launcherWin.webContents.executeJavaScript("document.querySelectorAll('.card').length");
          console.log('[smoke] launcher title=' + JSON.stringify(title) + ' bridge=' + bridge + ' cards=' + cards);
        } catch (e) { console.log('[smoke] launcher verify error: ' + e.message); }
      });
      launcherWin.webContents.on('console-message', (...args) => console.log('[smoke][launcher-console]', formatConsoleMessage(args)));
    }

    attachShotHarness({ launcherWin, windows, versionManager, app });
    return launcherWin;
  }

  // ================= 冒烟测试（MDZ_SMOKE=1：启动首个版本，确认能进游戏页） =================

  function runSmoke() {
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      setTimeout(() => app.exit(code), 600);
    };

    const versions = versionManager.listVersions();
    console.log('[smoke] versions found: ' + versions.length);
    if (versions.length === 0) { console.log('[smoke] NO VERSIONS IMPORTED'); finish(1); return; }

    setTimeout(() => {
      const version = versions[0];
      console.log('[smoke] launching version: ' + version.id + ' dbKey=' + (version.dbKey || ''));
      const gameWin = windows.openDirect(version);
      const timer = setTimeout(() => { console.log('[smoke] TIMEOUT'); finish(1); }, 60000);
      gameWin.webContents.on('did-finish-load', () => {
        console.log('[smoke] game did-finish-load OK');
        clearTimeout(timer);
        setTimeout(() => finish(0), 5000);
      });
      gameWin.webContents.on('did-fail-load', (e, code, desc) => { console.log('[smoke] FAIL: ' + code + ' ' + desc); finish(1); });
      gameWin.webContents.on('render-process-gone', (e, details) => { console.log('[smoke] renderer gone: ' + JSON.stringify(details)); finish(1); });
    }, 1200);
  }

  // ================= 应用启动 =================

  app.whenReady().then(async () => {
    timing('app-ready');

    await versionManager.init({ realUserData: layout.appDataRoot });
    syncBuiltinVersions(versionManager);
    registerGameProtocol(versionManager);

    // 局域网/服务器能力（状态变化推给界面）
    lanServices.init({
      versionManager,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      onLog: (line) => sendToLauncher('lan:log', line),
      onStatus: (status) => sendToLauncher('lan:status', status)
    });
    try { lanServices.status(); } catch (err) { console.warn('[lan] init status fail: ' + err.message); }

    // 存档传输服务：不自动启动，等用户在「存档传输」页点启动（与安卓端一致）
    try {
      saveTransfer.init({
        dir: path.join(app.getPath('userData'), 'save-transfer'),
        downloadsDir: app.getPath('downloads'),
        onLog: (line) => sendToLauncher('transfer:log', line)
      });
    } catch (err) { console.warn('[transfer] init fail: ' + err.message); }

    registerIpcHandlers({
      ipcMain,
      versionManager,
      lanServices,
      saveTransfer,
      saveIo,
      windows,
      getLauncher: () => launcherWin,
      getGame: () => windows.getGame(),
      showLauncher
    });

    if (IS_MAC) menuHost.restoreAppMenu();
    createLauncherWindow();

    if (IS_SMOKE) runSmoke();
    else if (IS_UITEST) {
      runUITest({
        getLauncher: () => launcherWin,
        getGame: () => windows.getGame(),
        windows,
        lanServices,
        exit: (code) => app.exit(code)
      });
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createLauncherWindow();
  });

  app.on('window-all-closed', () => { app.quit(); });

  // 退出时收拾联机与存档传输（建房程序是独立进程，会被一起结束）
  app.on('before-quit', () => {
    try { lanServices.stopAll(); } catch (e) { /* 忽略 */ }
    try { saveTransfer.stop(); } catch (e) { /* 忽略 */ }
  });
}
