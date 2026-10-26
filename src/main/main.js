'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { registerPrivilegedSchemes, registerGameProtocol } = require('./protocol');
const versionCore = require('./version-core');
const versionManager = require('./version-manager');
const saveIo = require('./save-io');
const lanServices = require('./lan-services');
const saveTransfer = require('./save-transfer');   // v1.0.1：PC 版「存档传输」服务（手机直装包把存档发到 PC）   // v0.7.22：局域网/服务器能力（信令/分发/建房程序）

/* v0.7.27：pp:// 是安全上下文，页面里连局域网 ws:// 信令会被当混合内容拦——
   多人版客户端现在和单机版一样直接读本地文件（app://game/version/__lan_client__/…），所以需要打开这个开关。
   作用域：整个启动器进程（本地程序、只连自己的信令服务器）。 */
app.commandLine.appendSwitch('allow-running-insecure-content');

// ================= v0.8.0：数据目录布局（必须在 app ready 之前完成） =================
// 用户定稿（2026-09-15）——根目录下固定两个子目录：data = 设置/存档，versions = 版本。
//   非便携：<根> = %APPDATA%\MDZLauncher → %APPDATA%\MDZLauncher\data（config.json + Chromium profile：
//           localStorage / IndexedDB / Preferences …即设置与游戏存档）+ %APPDATA%\MDZLauncher\versions
//   便携  ：<根> = PORTABLE_EXECUTABLE_DIR（打包便携 exe）/ 程序目录（绿色包）/ 工程根（dev）
//           → <根>\data + <根>\versions（整包搬走即带走全部数据）
// 便携判定：<根>\data\.portable 存在，或 <根>\data\config.json 里 dataMode=portable。
// **不做旧布局兼容**（用户明确：旧数据他自己清）——旧版把 data 放在 <根>\MDZLauncher\，不再识别/迁移。
app.setName('MDZLauncher');                       // 必须先于 getPath('userData')，否则路径名不对
const APPDATA_ROOT = app.getPath('userData');     // 系统 %APPDATA%\MDZLauncher（根：下含 data / versions）
const PORTABLE_BASE = versionCore.computePortableBase({
  exeDir: path.dirname(app.getPath('exe')),
  isPackaged: app.isPackaged,
  devRoot: path.join(__dirname, '..', '..')
});
const APPDATA_DATA = path.join(APPDATA_ROOT, 'data');
const PORTABLE_DATA = path.join(PORTABLE_BASE, 'data');
const PORTABLE_MARK = path.join(PORTABLE_DATA, '.portable');
// 与 version-manager.PROFILE_ITEMS 保持一致（设置/存档所在；可再生缓存不搬）
const PROFILE_ITEMS = ['Local Storage', 'Session Storage', 'IndexedDB', 'Preferences', 'Network', 'WebStorage', 'Shared Dictionary'];

function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function copyProfileItem(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) return versionCore.copyDirRecursive(src, dst);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return 1;
}
function migrateProfileIfNeeded(fromDir, toDir) {
  if (!fromDir || !toDir || path.resolve(fromDir) === path.resolve(toDir)) return 0;
  let n = 0;
  fs.mkdirSync(toDir, { recursive: true });
  for (const name of PROFILE_ITEMS) {
    const src = path.join(fromDir, name);
    const dst = path.join(toDir, name);
    try { if (fs.existsSync(src) && !fs.existsSync(dst)) n += copyProfileItem(src, dst); } catch (e) { /* 单项失败不影响启动 */ }
  }
  return n;
}

/* macOS 移植：`.app` 是签名只读包，没有 Windows 那种「便携单文件 exe」概念——
   便携模式在 macOS 上整体禁用，数据固定放 ~/Library/Application Support/MDZLauncher/{data,versions}。 */
const IS_MAC = process.platform === 'darwin';

let BOOT_PORTABLE = false;
try {
  const posCfg = IS_MAC ? null : readJsonSafe(path.join(PORTABLE_DATA, 'config.json'));
  BOOT_PORTABLE = IS_MAC ? false : !!((posCfg && posCfg.dataMode === 'portable') || fs.existsSync(PORTABLE_MARK));
  if (BOOT_PORTABLE) {
    fs.mkdirSync(PORTABLE_DATA, { recursive: true });
    // 首次以便携方式启动（只有标记、没有配置）→ 从 appdata 的 data 目录把设置/存档搬过来（只补缺失项）
    const movedProfile = migrateProfileIfNeeded(APPDATA_DATA, PORTABLE_DATA);
    if (!posCfg) {
      const merged = Object.assign({}, readJsonSafe(path.join(APPDATA_DATA, 'config.json')) || {}, { dataMode: 'portable' });
      fs.writeFileSync(path.join(PORTABLE_DATA, 'config.json'), JSON.stringify(merged, null, 2), 'utf8');
    }
    try { fs.writeFileSync(PORTABLE_MARK, 'portable\n', 'utf8'); } catch (e) {}
    if (movedProfile) console.log('[mdz] 便携数据目录已迁移 ' + movedProfile + ' 个文件 → ' + PORTABLE_DATA);
  }
} catch (e) {
  console.warn('[mdz] 便携数据目录引导失败，回退系统 appdata：' + (e && e.message));
}
// 当前生效的数据目录（Chromium profile 与 config.json 都在这里）——必须在 ready 之前定好
app.setPath('userData', BOOT_PORTABLE ? PORTABLE_DATA : APPDATA_DATA);

const LAUNCHER_ENTRY = 'app://game/_launcher/index.html';
// 打包后 exe 无法用裸 --smoke/--uitest（Electron 视未知 --switch 为自身参数报 bad option），
// 改用环境变量通道：MDZ_SMOKE=1 / MDZ_UITEST=1（dev 下 electron . --smoke 的 argv 形式仍兼容）
const SMOKE = process.argv.includes('--smoke') || process.env.MDZ_SMOKE === '1';
const UITEST = process.argv.includes('--uitest') || process.env.MDZ_UITEST === '1'; // v0.7.4：renderer UI 全路径自动化验证

// v0.7.17：keymap 结构规范化——数据目录 config.json keymaps[id] 可为多方案 {active, schemes}
// （与 web mapper.js / PC mapper.js 同构）或历史单方案 plain map（自动包为「默认」方案）
function keymapNorm(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.schemes && typeof m.schemes === 'object') return m;
  return { active: '默认', schemes: { '默认': m } };
}
function keymapActive(m) {
  const n = keymapNorm(m);
  if (!n) return null;
  const name = (n.active && n.schemes[n.active]) ? n.active : Object.keys(n.schemes)[0];
  return (name && n.schemes[name]) ? { name, map: n.schemes[name] } : null;
}
// v0.7.17：该版本是否无需键盘映射——内置 PC 版（键鼠原生，renderer 侧 BUILTIN_SPECIAL.noKeymap 只在
// 前端打标，主进程需用 id/name/标记自判），避免给 minidayz-pc 等注入 mapper（壳页 nk=1 / 不注入 loader）
function isMapperDisabled(v) {
  return !!(v && (v.noKeymap || v.directUrl || String(v.id).indexOf('minidayz-pc') === 0 ||
    String(v.id).indexOf('minidayz-mp') === 0 || // v0.7.20：PC 多人版同样是键鼠原生（不注入 mapper）
    String(v.name || '').indexOf('MiniDayZ PC') >= 0 || String(v.name || '').indexOf('多人版') >= 0));
}

// 动态注入到游戏页（direct 直开窗口顶层）的键盘映射器——web 同款 mapper.js（多方案/预设/拖动/防卡死），
// 由 app://game/_launcher/ 提供、与启动器同源（升级启动器即可更新映射逻辑，无需重导入游戏版本）；
// 先注入默认方案 preset，再注入 mapper（mapper 经 __launcher 原生存储走数据目录 config.json）
const MAPPER_LOADER = `(function(){
  try {
    if (document.getElementById('mdz-web-mapper')) return;
    if (!document.getElementById('mdz-keymap-preset')) {
      var p = document.createElement('script');
      p.id = 'mdz-keymap-preset';
      p.src = 'app://game/_launcher/mdz-keymap-preset.js';
      (document.head || document.documentElement).appendChild(p);
    }
    var s = document.createElement('script');
    s.id = 'mdz-web-mapper';
    s.src = 'app://game/_launcher/mapper.js';
    (document.head || document.documentElement).appendChild(s);
  } catch(e) {}
})();`;

// v0.6.33：IndexedDB 隔离补丁（PC 游戏读写带后缀库 _<dbKey>，与启动器存档管理/web/安卓一致）。
// 此前 PC 版漏注入此补丁 → 游戏读写无后缀库，启动器导入写带后缀库 → 恢复后游戏读不到。
const DBKEY_PATCH = `(function(){
  try {
    if (document.getElementById('mdz-dbkey-patch')) return;
    var m = (location.search || '').match(/[?&]dbKey=([^&]+)/);
    var k = m ? decodeURIComponent(m[1]) : '';
    if (!k) return;
    var s = '_' + k;
    var o = window.indexedDB.open.bind(window.indexedDB);
    window.indexedDB.open = function(n, v) {
      if (n && typeof n === 'string' && !n.endsWith(s)) return o(n + s, v);
      return o(n, v);
    };
  } catch(e) {}
})();`;

// ---- 单实例锁 ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  start();
}

function start() {
  app.setName('MDZLauncher');
  // v0.7.12：启动计时（MDZ_TIMING=1 打印各阶段耗时并写入 %TEMP%\mdz-boot.txt，定位"启动慢"用）
  const T0 = Date.now();
  const tlog = (tag) => {
    if (process.env.MDZ_TIMING !== '1') return;
    const line = '[t] ' + tag + ' +' + (Date.now() - T0) + 'ms';
    console.log(line);
    try { require('fs').appendFileSync(require('path').join(process.env.TEMP || '.', 'mdz-boot.txt'), line + '\n'); } catch (e) {}
  };
  // v0.7.10：默认硬件加速——软件渲染（原 v0.7.6 默认）首帧慢、UI/滚动/游戏整体卡顿；
  // 若遇 GPU 兼容问题（地图花屏/白屏等），设 MDZ_SOFT=1 回退软件渲染（原行为）
  if (process.env.MDZ_SOFT === '1') app.disableHardwareAcceleration();

  registerPrivilegedSchemes();

  let launcherWin = null;
  let gameWin = null;
  let gameWinVersionId = null;

  /* ===== macOS 移植：菜单适配 =====
     macOS 的菜单是「应用级」的：win.setMenu() / setMenuBarVisibility() 都是空操作，
     菜单必须挂到 Menu.setApplicationMenu()。这里让 build*Menu 统一返回「模板数组」，
     再由 setWinMenu 决定是挂窗口菜单（Windows）还是挂全局菜单（macOS）。 */
  const BASE_APP_MENU = [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }];
  function withMacChrome(tpl) {
    return [{ role: 'appMenu' }, ...tpl, { role: 'windowMenu' }];
  }
  /* 让 build*Menu 统一返回「模板数组」而不是已构建的 Menu，便于按平台决定挂到哪里 */
  function menuTemplate(tpl) { return tpl; }
  function setWinMenu(win, template) {
    if (!win || (win.isDestroyed && win.isDestroyed()) || !Array.isArray(template)) return;
    try {
      if (IS_MAC) {
        Menu.setApplicationMenu(Menu.buildFromTemplate(withMacChrome(template)));
        try { win.setMenu(null); } catch (e) {}
      } else {
        win.setMenu(Menu.buildFromTemplate(template));
      }
    } catch (e) { console.warn('[menu] 设置菜单失败: ' + e.message); }
  }
  function restoreAppMenu() {
    if (!IS_MAC) return;
    try { Menu.setApplicationMenu(Menu.buildFromTemplate(BASE_APP_MENU)); } catch (e) {}
  }

  function ensureBuiltinVersion() {
    // v0.7.4（PC 重建）：内置版本首启复制到数据目录——
    // 打包后源 = extraResources/versions/<id>；dev 源 = 项目根 versions/<id>；
    // 目标（数据目录 versionsRoot）已存在同名版本则跳过（用户数据优先，不自动覆盖/还原）
    // v0.7.20：支持多个内置版本（minidayz-pc 单机版 / minidayz-mp 多人版）
    const fs = require('fs');
    // v0.7.24：PC 不再自带「原版多人版」版本条目——多人版的客户端由「服务器」提供（resources\mp-client，
    // 由分发服务 lan-host/serve.js 发出去），列表里的入口是合成的「多人游戏客户端」（见 lan-services/前端）。
    // 旧数据目录里我们装过的内置副本（带 metadata/builtin-ver.txt 标记）自动清掉，避免残留在版本列表里。
    try {
      const stale = path.join(versionManager.getVersionsRoot(), 'minidayz-mp');
      /* v1.0.16：别把「内置版本源」当残留删掉——dev/便携模式下 versionsRoot 可能正好就是
         <工程根|程序目录>\versions\，而内置多人版源就住在里面（曾因这条清掉了源）。 */
      const srcVersionDirs = [
        path.join(process.resourcesPath || '', 'versions', 'minidayz-mp'),
        path.join(app.getAppPath(), 'versions', 'minidayz-mp')
      ].map((p) => { try { return path.resolve(p); } catch (e) { return p; } });
      const isBuiltinSource = srcVersionDirs.indexOf(path.resolve(stale)) >= 0;
      if (!isBuiltinSource && fs.existsSync(path.join(stale, 'metadata', 'builtin-ver.txt'))) {
        fs.rmSync(stale, { recursive: true, force: true });
        console.log('[builtin] removed stale built-in minidayz-mp -> ' + stale);
      }
    } catch (e) { console.warn('[builtin] cleanup minidayz-mp: ' + e.message); }
    const BUILTINS = [
      { id: 'minidayz-pc', probe: path.join('v141', 'index.html'), sync: path.join('v141', 'data.js') },
      { id: 'mdz-plus-v120', probe: 'index.html', sync: 'data.js' },
      { id: 'minidayz-mp', probe: path.join('client', 'index.html'), sync: path.join('client', 'data.js') }
    ];
    /* v1.0.16（用户要求）：内置游戏版本统一放 `versions\` 下，目录名 = minidayz-pc / minidayz-mp：
       打包后 = resources\versions\{minidayz-pc,minidayz-mp}，dev = <项目根>\versions\...；
       旧的 `builtin\` 与 `mp-client` 布局保留为兼容回退。
       v0.7.44（用户要求：数据目录里不该再有一份重复的内置版）：内置版**不再复制**到数据目录，
       而是直接由内置根提供（列表见 version-manager.getBuiltinRoots / 文件见 protocol.js 的回退）；
       以前复制进来的同名目录，内容与内置源一致就清掉，免得 resources\versions 与 <根>\versions 各存一份。 */
    const candidates = [
      path.join(process.resourcesPath, 'versions'), // v1.0.16：内置版本都在 versions\（extraResources）
      path.join(app.getAppPath(), 'versions'),      // dev
      path.join(process.resourcesPath, 'builtin'),  // 旧布局回退（≤1.0.15）
      path.join(app.getAppPath(), 'builtin')
    ];
    for (const base of candidates) {
      let found = false;
      for (const b of BUILTINS) {
        try {
          const srcDir = path.join(base, b.id);
          if (!fs.existsSync(path.join(srcDir, b.probe))) continue;
          found = true;
          const dest = path.join(versionManager.getVersionsRoot(), b.id);
          let isSrc = true;
          try { isSrc = path.resolve(srcDir) === path.resolve(dest); } catch (e) { isSrc = true; }
          if (isSrc) continue;                 // 数据根就是内置源（dev/便携）→ 不动
          if (!fs.existsSync(dest)) continue;   // 数据目录里没有副本 → 无需清理
          const rel = b.sync || b.probe;
          const sf = path.join(srcDir, rel);
          const df = path.join(dest, rel);
          let same = false;
          try { same = fs.existsSync(sf) && fs.existsSync(df) && fs.readFileSync(sf).equals(fs.readFileSync(df)); } catch (e) { same = false; }
          if (!same) { console.log('[builtin] kept user copy (content differs) -> ' + dest); continue; }
          fs.rmSync(dest, { recursive: true, force: true });
          console.log('[builtin] removed duplicate built-in copy (now served from resources) -> ' + dest);
        } catch (e) { console.warn('[builtin] ' + b.id + ' cleanup failed: ' + e.message); }
      }
      if (found) return;
    }
    console.log('[builtin] no builtin source found (dev without builtin/minidayz-pc?)');
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
      show: !SMOKE, // v0.7.12：立即显示（先底色后内容）——双击后尽快看到窗口，不再等首帧（避免"10 秒无反应"感）
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'launcher-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    tlog('launcher-window-created');
    launcherWin.loadURL(LAUNCHER_ENTRY);
    if (process.env.MDZ_TIMING === '1') launcherWin.webContents.once('did-finish-load', () => tlog('launcher-did-finish-load'));
    if (process.env.MDZ_DEVTOOLS === '1') { try { launcherWin.webContents.openDevTools({ mode: 'detach' }); } catch (e) {} } // v0.7.6 诊断通道
    // v0.7.4：外部 http(s) 链接（帮助/下载/关于等真实 <a target=_blank>）交给系统默认浏览器，
    // 内部 app:// 子窗口（window.open 游戏新窗口/document.write）保持允许
    launcherWin.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
      return { action: 'allow' };
    });
    launcherWin.on('closed', () => { launcherWin = null; });
    if (SMOKE) {
      launcherWin.webContents.on('did-finish-load', async () => {
        console.log('[smoke] launcher window loaded');
        try {
          const title = await launcherWin.webContents.executeJavaScript('document.title');
          const bridge = await launcherWin.webContents.executeJavaScript('!!window.__launcherNative');
          const cards = await launcherWin.webContents.executeJavaScript("document.querySelectorAll('.card').length");
          console.log('[smoke] launcher title=' + JSON.stringify(title) + ' bridge=' + bridge + ' cards=' + cards);
        } catch (e) { console.log('[smoke] launcher verify error: ' + e.message); }
      });
      launcherWin.webContents.on('console-message', (...a) => console.log('[smoke][launcher-console]', fmtConsole(a)));
    }
    /* 调试用：MDZ_SHOT=/path/out.png → 启动器首帧稳定后截图并退出（移植时验证 UI 渲染） */
    if (process.env.MDZ_SHOT) {
      launcherWin.webContents.once('did-finish-load', async () => {
        await new Promise((r) => setTimeout(r, Number(process.env.MDZ_SHOT_DELAY || 2500)));
        try {
          if (process.env.MDZ_VIEW) {
            await launcherWin.webContents.executeJavaScript(
              "document.querySelector('[data-view=\"" + process.env.MDZ_VIEW + "\"]').click()");
            await new Promise((r) => setTimeout(r, 1200));
          }
          const img = await launcherWin.webContents.capturePage();
          require('fs').writeFileSync(process.env.MDZ_SHOT, img.toPNG());
          const cards = await launcherWin.webContents.executeJavaScript("document.querySelectorAll('.card').length");
          console.log('[shot] saved ' + process.env.MDZ_SHOT + ' cards=' + cards);
        } catch (e) { console.log('[shot] failed: ' + e.message); }
        /* MDZ_LAUNCH=<版本id> → 顺带开一次游戏窗口并截图（验证 app:// 协议 + 壳页 + 存档补丁） */
        if (process.env.MDZ_SHOT2 && process.env.MDZ_LAUNCH) {
          const v = versionManager.getVersion(process.env.MDZ_LAUNCH);
          if (v) {
            try {
              createPlayerWindow(v, false, 'scale');
              await new Promise((r) => setTimeout(r, Number(process.env.MDZ_SHOT2_DELAY || 25000)));
              const img2 = await gameWin.webContents.capturePage();
              require('fs').writeFileSync(process.env.MDZ_SHOT2, img2.toPNG());
              const info = await gameWin.webContents.executeJavaScript(
                'JSON.stringify({url:location.href,hasFrame:!!document.querySelector("iframe"),' +
                'dbPatch:(function(){try{var w=document.querySelector("iframe").contentWindow;' +
                'return /endsWith|suffix/.test(String(w.indexedDB.open));}catch(e){return "n/a";}})()})');
              console.log('[shot] game saved ' + process.env.MDZ_SHOT2 + ' ' + info);
            } catch (e) { console.log('[shot] game capture failed: ' + e.message); }
          } else console.log('[shot] version not found: ' + process.env.MDZ_LAUNCH);
        }
        app.exit(0);
      });
    }
    return launcherWin;
  }

  // v0.7.12：游戏窗口菜单分辨率预设与启动器命名一致（PC 原生 850×890 / 普通 PE 原生 1024×768）
  const PRESET_RES = [
    { label: '850×890（PC 原生）', w: 850, h: 890 },
    { label: '1024×768（PE 原生）', w: 1024, h: 768 },
    { label: '1280×720', w: 1280, h: 720 },
    { label: '1366×768', w: 1366, h: 768 },
    { label: '1600×900', w: 1600, h: 900 },
    { label: '1920×1080', w: 1920, h: 1080 }
  ];
  // v0.2.3：窗口模式画面缩放模式（fixed=固定分辨率启动；free=自由缩放窗口），内存态（本次会话）
  let winScaleMode = 'fixed';
  let winLogical = { w: 1280, h: 720 }; // 当前游戏窗口逻辑分辨率（applyScaleCss 计算等比缩放用）
  // v0.7.12：窗口/全屏等比铺满修复——旧 CSS 用 width:auto 但 canvas inline style 优先故失效，
  // 导致"全屏后画面只有左上角一小块"。改为对 #c2canvas 计算 scale 并 translate 居中
  // （Canvas 事件走 offset 本地坐标系，与内嵌 iframe 的 transform 缩放同机制，可正常点击）。
  function applyScaleCss(on) {
    if (!gameWin || gameWin.isDestroyed()) return;
    try {
      const lw = winLogical.w || 1280;
      const lh = winLogical.h || 720;
      const body = on
        ? "(function(){try{var s=document.getElementById('mdz-scale-css');if(!s){s=document.createElement('style');s.id='mdz-scale-css';(document.head||document.documentElement).appendChild(s);}s.textContent='html,body{overflow:hidden!important;margin:0!important;background:#000!important;}#c2canvas{margin:0!important;max-width:none!important;max-height:none!important;}';" +
          'var fit=function(){var cv=document.getElementById("c2canvas");if(!cv)return;' +
          'var iw=window.innerWidth||document.documentElement.clientWidth;var ih=window.innerHeight||document.documentElement.clientHeight;' +
          'var k=Math.min(iw/' + lw + ',ih/' + lh + ');if(!(k>0)||!isFinite(k))k=1;' +
          'var tx=(iw-' + lw + '*k)/2,ty=(ih-' + lh + '*k)/2;' +
          "cv.style.transformOrigin='0 0';cv.style.transform='translate('+tx+'px,'+ty+'px) scale('+k+')';};" +
          'fit();window.addEventListener("resize",fit);window.__mdzScaleFit=fit;' +
          'if(window.__mdzScaleFitT){clearTimeout(window.__mdzScaleFitT);}window.__mdzScaleFitT=setTimeout(fit,900);' +
          '}catch(e){}})()'
        : "(function(){try{var s=document.getElementById('mdz-scale-css');if(s)s.remove();" +
          'if(window.__mdzScaleFit){window.removeEventListener("resize",window.__mdzScaleFit);window.__mdzScaleFit=null;}' +
          "var cv=document.getElementById('c2canvas');if(cv)cv.style.transform='';}catch(e){}})()";
      gameWin.webContents.executeJavaScript(body);
    } catch (e) {}
  }

  function createGameWindow(version, calibrate, scaleMode) {
    if (gameWin) { try { gameWin.destroy(); } catch (e) {} }
    const dbKey = version.dbKey || ('version_' + version.id);
    // 分辨率优先级：启动器设置 > metadata launch.resolution > 默认 1024x768
    const res = versionManager.getResolution(version.id)
      || (version.launch && version.launch.resolution) || { w: 1024, h: 768 };
    const mode = scaleMode || winScaleMode;
    winScaleMode = mode;
    let { w, h } = res;
    try {
      const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      w = Math.max(320, Math.min(w, disp.workArea.width));
      h = Math.max(240, Math.min(h, disp.workArea.height));
    } catch (e) { /* 保持原值 */ }
    const url = `app://game/version/${encodeURIComponent(version.id)}/${version.entry || 'index.html'}?dbKey=${encodeURIComponent(dbKey)}${calibrate ? '&calibrate=1' : ''}`;
    gameWinVersionId = version.id;
    const free = mode === 'free';
    winLogical = { w, h }; // v0.7.12：记录逻辑分辨率供全屏等比缩放
    gameWin = new BrowserWindow({
      width: w,
      height: h,
      useContentSize: !free,           // 固定分辨率：内容区=分辨率；自由缩放：窗口自由
      resizable: free,                 // 固定分辨率锁定窗口；自由缩放可拖大
      maximizable: free,
      minWidth: free ? 320 : w,
      minHeight: free ? 240 : h,
      title: (version.name || version.id) + ' · ' + w + '×' + h,
      backgroundColor: '#000000',
      autoHideMenuBar: false,
      show: !SMOKE,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'game-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    // v0.2.3：窗口模式 Windows 菜单（文件/显示/按键映射 分开放，不挤一起）
    setWinMenu(gameWin, buildGameMenu(version));
    gameWin.loadURL(url);
    if (process.env.MDZ_DEVTOOLS === '1') { try { gameWin.webContents.openDevTools({ mode: 'detach' }); } catch (e) {} } // v0.7.6 诊断通道
    gameWin.webContents.on('did-finish-load', () => {
      if (free || gameWin.isFullScreen()) applyScaleCss(true); // 自由缩放/全屏：等比铺满（全屏占满修复）
    });
    // v0.7.12：fixed（不可缩放）窗口先进全屏前先解锁 resizable——否则 F11/菜单全屏不生效（画面只左上角小块）
    gameWin.on('enter-full-screen', () => {
      try { gameWin.setResizable(true); } catch (e) {}
      applyScaleCss(true);
    });
    gameWin.on('leave-full-screen', () => {
      if (!free) {
        try { gameWin.setResizable(false); } catch (e) {}
        applyScaleCss(false);
      }
    });
    gameWin.webContents.on('will-navigate', (e, target) => {
      if (!target.startsWith('app://game/')) { e.preventDefault(); shell.openExternal(target); }
    });
    gameWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // v0.7.17：F10 = 键盘映射校准开关（游戏内 mapper.js 监听）——Windows 菜单栏会抢占 F10
    // （激活菜单栏、页面收不到 keydown）→ 拦截默认行为并按原样回放给页面（防递归标志避免二次拦截）
    let f10Replay = false;
    gameWin.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') gameWin.webContents.toggleDevTools();
      if (input.key === 'F10') {
        if (!f10Replay) {
          e.preventDefault();
          f10Replay = true;
          gameWin.webContents.sendInputEvent({ type: input.type, keyCode: 'F10' });
          setTimeout(() => { f10Replay = false; }, 60);
        }
      }
    });
    gameWin.on('closed', () => { gameWin = null; gameWinVersionId = null; restoreAppMenu(); });
    // 注入键盘映射器（键位映射存数据目录 config.json 多方案，按版本读取）+ IndexedDB 隔离补丁（v0.6.33）；
    // noKeymap 版（内置 PC 版，键鼠原生）不注入 mapper（v0.7.17）
    gameWin.webContents.on('dom-ready', () => {
      try { gameWin.webContents.executeJavaScript(DBKEY_PATCH); } catch (e) { console.warn('[dbkey] inject failed: ' + e.message); }
      if (!isMapperDisabled(version)) {
        try { gameWin.webContents.executeJavaScript(MAPPER_LOADER); } catch (e) { console.warn('[mapper] inject failed: ' + e.message); }
      }
    });
    if (SMOKE) {
      gameWin.webContents.on('did-finish-load', async () => {
        console.log('[smoke] game window loaded: ' + gameWin.webContents.getURL());
        try {
          const info = await gameWin.webContents.executeJavaScript(`JSON.stringify({
            title: document.title,
            hasCanvas: !!document.getElementById('c2canvas'),
            dbKey: (window.__launcher && window.__launcher.versionId) || null,
            patch: (window.indexedDB.open + '').indexOf('suffix') !== -1
          })`);
          console.log('[smoke] game page: ' + info);
        } catch (e) { console.log('[smoke] game verify error: ' + e.message); }
      });
      gameWin.webContents.on('console-message', (...a) => console.log('[smoke][game-console]', fmtConsole(a)));
      gameWin.webContents.on('did-fail-load', (e, code, desc) => console.log('[smoke] game load FAIL: ' + code + ' ' + desc));
      gameWin.webContents.on('render-process-gone', (e, details) => console.log('[smoke] game renderer gone: ' + JSON.stringify(details)));
    }
    return gameWin;
  }

  // ===== v0.7.13：窗口模式 = wrapper 壳页（game-window.html）
  // 三种画面模式（原生菜单「显示→画面模式」切换，重建窗口）：
  //   fixed  = 固定窗口大小：窗口不可缩放，内容=所选逻辑分辨率，1:1
  //   follow = 自由窗口大小：窗口可自由缩放，画面分辨率跟随窗口（iframe=100%）
  //   scale  = 固定分辨率缩放：窗口可自由缩放，画面固定逻辑分辨率，等比缩放铺满窗口
  // 全屏 = 窗口铺满屏幕；fixed/scale 下画面保持逻辑分辨率等比铺满（不再"变分辨率只看到左上角"）。
  function defaultResFor(version) {
    // v0.7.13：PC 版游戏默认 PC 原生 850×890；其他导入版本默认 1280×720
    if (String(version.id).indexOf('minidayz-pc') === 0 ||
        String(version.name || '').indexOf('MiniDayZ PC') >= 0 ||
        !!version.directUrl) {
      return { w: 850, h: 890 };
    }
    return { w: 1280, h: 720 };
  }
  function resOf(version) {
    const r = versionManager.getResolution(version.id);
    if (r && r.w && r.h) return r;
    if (version.launch && version.launch.resolution) return version.launch.resolution;
    return defaultResFor(version);
  }
  function curWinBounds() { try { if (gameWin && !gameWin.isDestroyed()) return gameWin.getBounds(); } catch (e) {} return null; }
  function playerJsFs(on) { try { gameWin.webContents.executeJavaScript('window.__setWinFs && window.__setWinFs(' + (on ? 'true' : 'false') + ');'); } catch (e) {} }
  function createPlayerWindow(version, calibrate, fit, keepBounds) {
    if (gameWin) { try { gameWin.destroy(); } catch (e) {} }
    const dbKey = version.dbKey || ('version_' + version.id);
    const r = resOf(version);
    let { w, h } = r;
    try {
      const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      w = Math.max(320, Math.min(w, disp.workArea.width));
      h = Math.max(240, Math.min(h, disp.workArea.height));
    } catch (e) { /* 保持原值 */ }
    winScaleMode = fit; // 'fixed' | 'follow' | 'scale'
    const lock = fit === 'fixed';
    const url = 'app://game/_launcher/game-window.html?v=' + encodeURIComponent(version.id) +
      '&e=' + encodeURIComponent(version.entry || 'index.html') +
      '&dbKey=' + encodeURIComponent(dbKey) +
      '&w=' + w + '&h=' + h + '&fit=' + fit +
      (calibrate ? '&cal=1' : '') +
      (isMapperDisabled(version) ? '&nk=1' : '') +
      /* v0.7.27：多人版（__lan_client__）把当前信令地址交给壳页 → 注入进游戏 iframe
         v0.7.29：再带上玩家名称 + mdz=1（客户端页据此隐藏滚动条） */
      (version.id === '__lan_client__'
        ? '&sig=' + encodeURIComponent(lanServices.endpoints().signalUrl) +
          '&user=' + encodeURIComponent(lanServices.status().playerName || 'MiniPlayer') +
          '&mdz=1'
        : '');
    gameWinVersionId = version.id;
    gameWin = new BrowserWindow({
      width: w,
      height: h,
      useContentSize: true,
      resizable: !lock,
      maximizable: !lock,
      minWidth: lock ? w : 480,
      minHeight: lock ? h : 300,
      title: (version.name || version.id) + ' · ' + w + '×' + h +
        (fit === 'fixed' ? '（固定窗口大小）' : (fit === 'scale' ? '（固定分辨率缩放）' : '（自由窗口大小）')),
      backgroundColor: '#000000',
      autoHideMenuBar: false,
      show: !SMOKE,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'game-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    if (keepBounds) { try { gameWin.setBounds(keepBounds); } catch (e) {} }
    setWinMenu(gameWin, buildPlayerMenu(version, r, fit));
    gameWin.loadURL(url);
    if (process.env.MDZ_DEVTOOLS === '1') { try { gameWin.webContents.openDevTools({ mode: 'detach' }); } catch (e) {} }
    gameWin.webContents.on('will-navigate', (e, target) => {
      if (!target.startsWith('app://game/')) { e.preventDefault(); shell.openExternal(target); }
    });
    gameWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // v0.7.17：F10 = 键盘映射校准开关（壳页内 mapper.js 监听）——Windows 菜单栏抢占 F10 时
    // 页面收不到 keydown → 拦截默认并回放给页面（防递归；回放按当前焦点路由到游戏 iframe）
    let f10Replay = false;
    gameWin.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') gameWin.webContents.toggleDevTools();
      if (input.key === 'F10') {
        if (!f10Replay) {
          e.preventDefault();
          f10Replay = true;
          gameWin.webContents.sendInputEvent({ type: input.type, keyCode: 'F10' });
          setTimeout(() => { f10Replay = false; }, 60);
        }
      }
    });
    // 全屏：fixed 锁定窗先进全屏先解锁 resizable（否则全屏异常）；wrapper 按需重算缩放
    // v0.7.15：全屏隐藏原生工具栏（菜单栏），退出恢复；fixed 退出全屏时把窗口恢复为逻辑分辨率尺寸
    gameWin.on('enter-full-screen', () => {
      try { gameWin.setResizable(true); } catch (e) {}
      if (!IS_MAC) { try { gameWin.setMenuBarVisibility(false); } catch (e) {} }
      playerJsFs(true);
    });
    gameWin.on('leave-full-screen', () => {
      playerJsFs(false);
      if (!IS_MAC) { try { gameWin.setMenuBarVisibility(true); } catch (e) {} }
      if (lock) {
        // v0.7.15/16：fixed 退出全屏恢复逻辑分辨率尺寸——延迟重试兜底（Electron 退出全屏动画期间
        // 一次性 setContentSize 可能被覆盖，双定时器确保最终尺寸生效）
        const restore = () => {
          if (!gameWin || gameWin.isDestroyed()) return;
          try { gameWin.setContentSize(w, h); } catch (e) {}
          try { gameWin.setResizable(false); } catch (e) {}
        };
        setTimeout(restore, 60);
        setTimeout(restore, 400);
      }
    });
    gameWin.on('closed', () => { gameWin = null; gameWinVersionId = null; restoreAppMenu(); });
    gameWin.webContents.on('did-finish-load', () => {
      try { gameWin.webContents.executeJavaScript('window.__setWinFs && window.__setWinFs(' + (gameWin.isFullScreen() ? 'true' : 'false') + ');'); } catch (e) {}
    });
    return gameWin;
  }
  function switchPlayerFit(version, fit) {
    if (fit === winScaleMode) return;
    const bounds = (fit === 'fixed') ? null : curWinBounds();
    if (gameWin) { try { gameWin.destroy(); } catch (e) {} }
    gameWin = null;
    createPlayerWindow(version, false, fit, bounds);
  }
  function buildPlayerMenu(version, curRes, fit) {
    const vid = version.id;
    const resItems = PRESET_RES.map((p) => ({
      label: p.label + ((curRes.w === p.w && curRes.h === p.h) ? ' ✓' : ''),
      type: 'checkbox',
      checked: curRes.w === p.w && curRes.h === p.h,
      click: async () => {
        if (curRes.w === p.w && curRes.h === p.h) return;
        const r = await dialog.showMessageBox(gameWin, {
          type: 'question',
          title: '修改分辨率',
          message: '确定将分辨率改为 ' + p.w + '×' + p.h + ' 吗？',
          detail: '修改分辨率会重启游戏。请先在游戏内回到主菜单保存进度，再点击「确定」。',
          buttons: ['确定重启', '取消'],
          defaultId: 1,
          cancelId: 1
        });
        if (r.response !== 0) return;
        try {
          versionManager.setResolution(vid, { w: p.w, h: p.h });
          const bounds = (fit === 'fixed') ? null : curWinBounds();
          if (gameWin) { gameWin.destroy(); gameWin = null; }
          createPlayerWindow(version, false, fit, bounds);
        } catch (err) { console.warn('[menu] set res failed: ' + err.message); }
      }
    }));
    const FITS = [
      { v: 'fixed', l: '固定窗口大小' },
      { v: 'follow', l: '自由窗口大小' },
      { v: 'scale', l: '固定分辨率缩放' }
    ];
    const fitItems = FITS.map((f) => ({
      label: f.l, type: 'checkbox', checked: fit === f.v,
      click: () => switchPlayerFit(version, f.v)
    }));
    return menuTemplate([
      {
        label: '文件',
        submenu: [
          { label: '返回启动器', click: () => {
            if (gameWin) { gameWin.destroy(); gameWin = null; }
            if (launcherWin) { launcherWin.show(); launcherWin.focus(); }
            else launcherWin = createLauncherWindow();
          } },
          { type: 'separator' },
          { label: '退出', click: () => app.quit() }
        ]
      },
      {
        label: '显示',
        submenu: [
          { label: '全屏', accelerator: 'F11', type: 'checkbox', checked: gameWin && gameWin.isFullScreen(), click: () => {
            if (!gameWin) return;
            const goFs = !gameWin.isFullScreen();
            if (goFs) { try { gameWin.setResizable(true); } catch (e) {} }
            gameWin.setFullScreen(goFs);
          } },
          { type: 'separator' },
          { label: '画面模式', submenu: fitItems },
          { label: '分辨率', submenu: resItems }
        ]
      },
      {
        label: '按键映射',
        submenu: [
          { label: '以校准模式启动', click: () => { if (gameWin) { gameWin.destroy(); gameWin = null; } createGameWindow(version, true, 'fixed'); } },
          { type: 'separator' },
          {
            label: '导出按键映射…', click: async () => {
              const act = keymapActive(versionManager.getKeymap(vid));
              if (!act) { console.warn('[menu] 该版本还没有按键映射配置'); return; }
              const r = await dialog.showSaveDialog(gameWin, { title: '导出按键映射', defaultPath: 'mdz-keymap-' + vid + '-' + act.name + '.json', filters: [{ name: '按键映射', extensions: ['json'] }] });
              if (r.canceled || !r.filePath) return;
              require('fs').writeFileSync(r.filePath, JSON.stringify(act.map, null, 2), 'utf8');
            }
          },
          {
            label: '导入按键映射…', click: async () => {
              const r = await dialog.showOpenDialog(gameWin, { title: '导入按键映射', filters: [{ name: '按键映射', extensions: ['json'] }], properties: ['openFile'] });
              if (r.canceled || !r.filePaths[0]) return;
              try {
                const raw = JSON.parse(require('fs').readFileSync(r.filePaths[0], 'utf8'));
                if (!raw || typeof raw !== 'object') return;
                const obj = (raw.schemes && typeof raw.schemes === 'object') ? raw : { active: '默认', schemes: { '默认': raw } };
                versionManager.saveKeymap(vid, obj);
              } catch (e) { console.warn('[menu] import keymap failed: ' + e.message); }
            }
          }
        ]
      }
    ]);
  }

  /** v0.2.3：窗口模式菜单重排——「文件 / 显示 / 按键映射」顶级菜单分开，不挤一起
   *  显示：全屏(F11) + 画面模式（固定分辨率/自由缩放）+ 分辨率预设（改分辨率弹窗确认重启） */
  function buildGameMenu(version) {
    const vid = version.id;
    const cur = resOf(version);
    const resItems = PRESET_RES.map((p) => ({
      label: p.label + ((cur.w === p.w && cur.h === p.h) ? ' ✓' : ''),
      type: 'checkbox',
      checked: cur.w === p.w && cur.h === p.h,
      click: async () => {
        if (cur.w === p.w && cur.h === p.h) return;
        // v0.2.2：改分辨率前弹窗确认（提示回游戏主菜单保存进度），确定才重启，取消不改
        const r = await dialog.showMessageBox(gameWin, {
          type: 'question',
          title: '修改分辨率',
          message: '确定将分辨率改为 ' + p.w + '×' + p.h + ' 吗？',
          detail: '修改分辨率会重启游戏。请先在游戏内回到主菜单保存进度，再点击「确定」。',
          buttons: ['确定重启', '取消'],
          defaultId: 1,
          cancelId: 1
        });
        if (r.response !== 0) return;
        try {
          versionManager.setResolution(vid, { w: p.w, h: p.h });
          if (gameWin) { gameWin.destroy(); gameWin = null; }
          createGameWindow(version, false, winScaleMode);
        } catch (err) { console.warn('[menu] set res failed: ' + err.message); }
      }
    }));
    return menuTemplate([
      {
        label: '文件',
        submenu: [
          { label: '返回启动器', click: () => {
            if (gameWin) { gameWin.destroy(); gameWin = null; }
            if (launcherWin) { launcherWin.show(); launcherWin.focus(); }
            else launcherWin = createLauncherWindow();
          } },
          { type: 'separator' },
          { label: '退出', click: () => app.quit() }
        ]
      },
      {
        label: '显示',
        submenu: [
          { label: '全屏', accelerator: 'F11', type: 'checkbox', checked: gameWin && gameWin.isFullScreen(), click: (mi) => {
            if (!gameWin) return;
            // v0.7.12：不可缩放窗口先进全屏前解锁 resizable（否则全屏只左上角小块）
            const goFs = !gameWin.isFullScreen();
            if (goFs) { try { gameWin.setResizable(true); } catch (e) {} }
            gameWin.setFullScreen(goFs);
            if (!goFs && winScaleMode !== 'free') { try { gameWin.setResizable(false); } catch (e) {} }
          } },
          { type: 'separator' },
          {
            label: '画面模式',
            submenu: [
              {
                label: '固定分辨率', type: 'checkbox', checked: winScaleMode === 'fixed',
                click: () => switchScaleMode(version, 'fixed')
              },
              {
                label: '自由缩放窗口', type: 'checkbox', checked: winScaleMode === 'free',
                click: () => switchScaleMode(version, 'free')
              }
            ]
          },
          { label: '分辨率', submenu: resItems }
        ]
      },
      {
        label: '按键映射',
        submenu: [
          { label: '以校准模式启动', click: () => { if (gameWin) { gameWin.destroy(); gameWin = null; } createGameWindow(version, true, winScaleMode); } },
          { type: 'separator' },
          {
            label: '导出按键映射…', click: async () => {
              const act = keymapActive(versionManager.getKeymap(vid));
              if (!act) { console.warn('[menu] 该版本还没有按键映射配置'); return; }
              const r = await dialog.showSaveDialog(gameWin, { title: '导出按键映射', defaultPath: 'mdz-keymap-' + vid + '-' + act.name + '.json', filters: [{ name: '按键映射', extensions: ['json'] }] });
              if (r.canceled || !r.filePath) return;
              require('fs').writeFileSync(r.filePath, JSON.stringify(act.map, null, 2), 'utf8');
            }
          },
          {
            label: '导入按键映射…', click: async () => {
              const r = await dialog.showOpenDialog(gameWin, { title: '导入按键映射', filters: [{ name: '按键映射', extensions: ['json'] }], properties: ['openFile'] });
              if (r.canceled || !r.filePaths[0]) return;
              try {
                const raw = JSON.parse(require('fs').readFileSync(r.filePaths[0], 'utf8'));
                if (!raw || typeof raw !== 'object') return;
                const obj = (raw.schemes && typeof raw.schemes === 'object') ? raw : { active: '默认', schemes: { '默认': raw } };
                versionManager.saveKeymap(vid, obj);
              } catch (e) { console.warn('[menu] import keymap failed: ' + e.message); }
            }
          }
        ]
      }
    ]);
  }

  /** v0.2.3：切换画面模式（固定分辨率 / 自由缩放）——需重启游戏窗口生效 */
  function switchScaleMode(version, mode) {
    if (mode === winScaleMode) return;
    winScaleMode = mode;
    if (gameWin) { gameWin.destroy(); gameWin = null; }
    createGameWindow(version, false, mode);
  }

  /* ===== v0.7.22：播放「服务器分发的客户端」=====
     为什么用顶层窗口直接加载 http 页面：Electron 里顶层 http 页面可以连局域网 ws:// 信令服务器，
     不需要 --allow-running-insecure-content（而 app:// 页面里嵌 http 就会被混合内容拦）。
     v0.7.24：支持播放设置——分辨率（config.json 的 resolutions['__lan_client__']）、
             画面模式（固定窗口大小 fixed / 自由窗口大小 follow / 固定分辨率缩放 scale，原生菜单切换）、
             全屏、缩放加减；与普通版本的窗口模式语义一致。 */
  let srvFit = 'scale';        // 画面模式（运行时可切）
  let srvLogical = { w: 850, h: 890 };
  function srvApplyZoom() {
    if (!gameWin || gameWin.isDestroyed()) return;
    try {
      if (srvFit !== 'scale') { gameWin.webContents.setZoomFactor(1); return; }
      const [cw, ch] = gameWin.getContentSize();
      const k = Math.max(0.3, Math.min(3, Math.min(cw / srvLogical.w, ch / srvLogical.h)));
      gameWin.webContents.setZoomFactor(Math.round(k * 100) / 100);
    } catch (e) {}
  }
  function srvMenu(url, label) {
    const fitItem = (key, text) => ({
      label: text, type: 'radio', checked: srvFit === key,
      click: () => {
        srvFit = key;
        if (gameWin && !gameWin.isDestroyed()) {
          if (key === 'fixed') { try { gameWin.setContentSize(srvLogical.w, srvLogical.h); } catch (e) {} }
          try { gameWin.setResizable(key !== 'fixed'); } catch (e) {}
          srvApplyZoom();
          /* ★ 不能在菜单点击回调里同步重建菜单（Electron 报 TypeError: Invalid Menu）→ 延后一帧 */
          setTimeout(() => { try { if (gameWin && !gameWin.isDestroyed()) setWinMenu(gameWin, srvMenu(url, label)); } catch (e) {} }, 30);
        }
      }
    });
    return [
      {
        label: '文件',
        submenu: [
          { label: '返回启动器', accelerator: 'Esc', click: () => { if (gameWin) { gameWin.destroy(); gameWin = null; } if (launcherWin) { launcherWin.show(); launcherWin.focus(); } } },
          { type: 'separator' },
          { label: '退出启动器', role: 'quit' }
        ]
      },
      {
        label: '显示',
        submenu: [
          { label: '全屏 (F11)', accelerator: 'F11', click: () => { try { gameWin.setFullScreen(!gameWin.isFullScreen()); } catch (e) {} } },
          { type: 'separator' },
          fitItem('fixed', '画面模式：固定窗口大小'),
          fitItem('follow', '画面模式：自由窗口大小'),
          fitItem('scale', '画面模式：固定分辨率缩放'),
          { type: 'separator' },
          { label: '放大画面', click: () => { try { gameWin.webContents.setZoomFactor(Math.min(3, gameWin.webContents.getZoomFactor() + 0.1)); } catch (e) {} } },
          { label: '缩小画面', click: () => { try { gameWin.webContents.setZoomFactor(Math.max(0.3, gameWin.webContents.getZoomFactor() - 0.1)); } catch (e) {} } },
          { label: '重置缩放', click: () => { try { gameWin.webContents.setZoomFactor(1); } catch (e) {} } }
        ]
      },
      { label: label || url, enabled: false }
    ];
  }
  function createServerClientWindow(url, label, opts) {
    const o = opts || {};
    if (gameWin) { try { gameWin.destroy(); } catch (e) {} }
    gameWinVersionId = '__lan_client__';
    let w = (o.w && Number.isFinite(o.w)) ? o.w : 850;
    let h = (o.h && Number.isFinite(o.h)) ? o.h : 890;
    try {
      const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      w = Math.max(320, Math.min(w, disp.workArea.width));
      h = Math.max(240, Math.min(h, disp.workArea.height));
    } catch (e) {}
    srvLogical = { w, h };
    if (o.fit) srvFit = o.fit;
    const lock = srvFit === 'fixed';
    gameWin = new BrowserWindow({
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
      show: !SMOKE,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    try { setWinMenu(gameWin, srvMenu(url, label)); } catch (e) {}
    gameWin.loadURL(url);
    if (process.env.MDZ_DEVTOOLS === '1') { try { gameWin.webContents.openDevTools({ mode: 'detach' }); } catch (e) {} }
    gameWin.webContents.on('did-finish-load', () => {
      /* v0.7.26：去掉滚动条（游戏画面本身不该出现滚动条）+ 居中画布 */
      try {
        gameWin.webContents.insertCSS(
          'html,body{overflow:hidden !important;max-height:100% !important;}\n' +
          'body{margin:0 !important;background:#000 !important;}\n' +
          '#c2canvasdiv{margin:0 auto !important;}\n'
        );
      } catch (e) {}
      srvApplyZoom();
      if (o.mode === 'fullscreen') { try { gameWin.setFullScreen(true); } catch (e) {} }
    });
    gameWin.on('resize', () => srvApplyZoom());
    gameWin.webContents.on('will-navigate', (e, target) => {
      let same = false;
      try { same = new URL(target).host === new URL(url).host; } catch (err) {}
      if (!same) { e.preventDefault(); shell.openExternal(target); }
    });
    gameWin.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
    gameWin.on('enter-full-screen', () => { if (!IS_MAC) { try { gameWin.setMenuBarVisibility(false); } catch (e) {} } srvApplyZoom(); });
    gameWin.on('leave-full-screen', () => { if (!IS_MAC) { try { gameWin.setMenuBarVisibility(true); } catch (e) {} } srvApplyZoom(); });
    gameWin.on('closed', () => { gameWin = null; gameWinVersionId = null; restoreAppMenu(); });
    return gameWin;
  }

  /* v0.7.23：探一次 http（1.6s 超时；任何响应都算通）——避免「服务没起 → 黑窗口」 */
  function probeHttp(url) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok, error) => { if (!done) { done = true; resolve({ ok, error }); } };
      try {
        const req = require('http').get(url, (res) => { try { res.resume(); } catch (e) {} finish(true); });
        req.on('error', (err) => finish(false, '连不上 ' + url + '（' + (err && err.code || err && err.message) + '）'));
        req.setTimeout(1600, () => { try { req.destroy(); } catch (e) {} finish(false, '连不上 ' + url + '（超时）'); });
      } catch (err) { finish(false, '地址无效：' + url); }
    });
  }

  app.whenReady().then(async () => {
    tlog('app-ready');
    await versionManager.init({ realUserData: APPDATA_ROOT }); /* 版本根 = <APPDATA_ROOT>\versions（与 <APPDATA_ROOT>\data 同级） */
    ensureBuiltinVersion();
    registerGameProtocol(versionManager);

    // v0.7.22：局域网模块（信令服务器/分发服务/建房程序）——状态变化时推给界面
    lanServices.init({
      versionManager,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      onLog: (line) => { try { if (launcherWin && !launcherWin.isDestroyed()) launcherWin.webContents.send('lan:log', line); } catch (err) {} },
      onStatus: (st) => { try { if (launcherWin && !launcherWin.isDestroyed()) launcherWin.webContents.send('lan:status', st); } catch (err) {} }
    });
    try { lanServices.status(); } catch (err) { console.warn('[lan] init status fail: ' + err.message); }

    // v1.0.1：存档传输服务（不自动启动，等用户在「存档传输」页点启动；与安卓端一致）
    try {
      saveTransfer.init({
        dir: path.join(app.getPath('userData'), 'save-transfer'),
        downloadsDir: app.getPath('downloads'),
        onLog: (line) => { try { if (launcherWin && !launcherWin.isDestroyed()) launcherWin.webContents.send('transfer:log', line); } catch (e) {} }
      });
    } catch (err) { console.warn('[transfer] init fail: ' + err.message); }

    // ================= IPC =================
    ipcMain.handle('versions:list', () => versionManager.listVersions());

    ipcMain.handle('versions:pickZip', async () => {
      const res = await dialog.showOpenDialog(launcherWin, {
        title: '选择游戏版本 zip（可多选）',
        filters: [{ name: '游戏版本包', extensions: ['zip'] }],
        properties: ['openFile', 'multiSelections'] // v0.5.7：一次多选依次导入
      });
      if (res.canceled || !res.filePaths.length) return null;
      const out = [];
      for (const p of res.filePaths) {
        try { out.push(await versionManager.inspectZip(p)); }
        catch (err) { out.push({ error: err.message }); }
      }
      return { list: out };
    });

    ipcMain.handle('versions:doImport', async (e, candidate, overrides) => {
      try { return await versionManager.importZip(candidate, overrides); }
      catch (err) { return { error: err.message }; }
    });

    ipcMain.handle('versions:remove', async (e, id) => {
      try { await versionManager.removeVersion(id); return { ok: true }; }
      catch (err) { return { error: err.message }; }
    });

    // v0.7.11+：窗口模式（fullscreen）经此通道打开——mode='calibrate' 时以校准模式启动；
    // res={w,h} 可选：按启动器侧所选分辨率定窗（缺省按版本规则：PC 版 850×890，其他 1280×720）
    // v0.7.13：统一进 wrapper 壳页（game-window.html，三种画面模式）
    // v0.7.16：默认画面模式 = 固定分辨率缩放(scale)（用户：默认用窗口模式启动 + 固定分辨率缩放）
    ipcMain.on('versions:launch', (e, id, mode, res) => {
      // v0.7.27：合成版「多人版客户端」没有版本目录（素材走 resources\mp-client，见 protocol.js 映射）
      const v = (id === '__lan_client__')
        ? { id: '__lan_client__', name: 'MiniDayZ PC多人版', entry: 'client/index.html', dbKey: '__lan_client__', directUrl: true, noSave: true, noKeymap: true }
        : versionManager.getVersion(id);
      if (!v) { console.warn('[launcher] version not found: ' + id); return; }
      if (res && Number.isFinite(res.w) && Number.isFinite(res.h)) {
        try { versionManager.setResolution(id, { w: res.w, h: res.h }); } catch (err) { console.warn('[launcher] setResolution fail: ' + err.message); }
      }
      createPlayerWindow(v, mode === 'calibrate', 'scale');
    });

    // v0.6.37：导入存档前关闭游戏窗口（防游戏自动保存覆盖导入的数据）
    ipcMain.on('game:close', () => {
      if (gameWin && !gameWin.isDestroyed()) { gameWin.destroy(); gameWin = null; gameWinVersionId = null; }
    });

    // 以校准模式启动（打开游戏内键盘映射校准面板）
    ipcMain.on('versions:launchKeymap', (e, id) => {
      const v = versionManager.getVersion(id);
      if (v) createGameWindow(v, true);
      else console.warn('[launcher] version not found: ' + id);
    });

    ipcMain.handle('config:getKeymap', (e, id) => versionManager.getKeymap(id));
    ipcMain.handle('config:saveKeymap', (e, id, map) => versionManager.saveKeymap(id, map));

    ipcMain.on('game:back-to-launcher', () => {
      if (gameWin) { gameWin.destroy(); gameWin = null; }
      if (launcherWin) { launcherWin.show(); launcherWin.focus(); }
      else launcherWin = createLauncherWindow();
    });

    ipcMain.handle('config:get', () => versionManager.getConfig());
    ipcMain.handle('config:setLan', (e, patch) => {
      const lan = versionManager.setLan(patch);
      const ep = lanServices.endpoints();
      try { lanServices.restartLocalClient(); } catch (err) {}   // v0.7.26：信令地址变了要重启本地客户端（重新注入地址）
      return { lan, endpoints: ep, status: lanServices.status() };
    });

    /* ===== v0.7.22：局域网/服务器能力 ===== */
    ipcMain.handle('lan:status', () => lanServices.status());

    // ===== v1.0.1：存档传输（用同步 IPC —— 页面里的 PLAT.saveTransfer 与安卓端同形，全是同步返回）=====
    ipcMain.on('transfer:status', (e) => { e.returnValue = saveTransfer.status(); });
    ipcMain.on('transfer:start', (e, port, token) => { e.returnValue = saveTransfer.start(port, token); });
    ipcMain.on('transfer:stop', (e) => { e.returnValue = saveTransfer.stop(); });
    ipcMain.on('transfer:list', (e) => { e.returnValue = saveTransfer.list(); });
    ipcMain.on('transfer:get', (e, id) => { e.returnValue = saveTransfer.get(id); });
    ipcMain.on('transfer:remove', (e, id) => { e.returnValue = saveTransfer.remove(id); });
    ipcMain.on('transfer:export', (e, fileName, text) => { e.returnValue = saveTransfer.exportText(fileName, text); });
    ipcMain.handle('lan:signal', (e, action) => (action === 'start' ? lanServices.startSignal() : lanServices.stopSignal()));
    ipcMain.handle('lan:serve', (e, action) => (action === 'start' ? lanServices.startServe() : lanServices.stopServe()));
    ipcMain.handle('lan:host', (e, action) => (action === 'start' ? lanServices.startHost() : lanServices.stopHost()));
    ipcMain.handle('lan:pickHostDir', async () => {
      const res = await dialog.showOpenDialog(launcherWin, {
        title: '选择建房程序目录（里面有 nw.exe）',
        properties: ['openDirectory']
      });
      if (res.canceled || !res.filePaths.length) return { canceled: true };
      versionManager.setLan({ hostDir: res.filePaths[0] });
      return { dir: res.filePaths[0], status: lanServices.status() };
    });
    /** 播放多人客户端（v0.7.26：**本地启动**——启动器在 127.0.0.1 上把 mp-client 发出来，
     *  信令地址用设置里的 IP/端口注入；和 PC 单机版一样是本地版本，不依赖局域网分发服务。
     *  局域网分发（8088）保留给"把客户端发给别人"用。 */
    ipcMain.handle('lan:play', async (e, override) => {
      const started = { signal: false, serve: false, local: false };
      const ep = lanServices.endpoints();
      const host = lanServices.hostOnly((override && override.serverHost) || '') || ep.host;
      const isLocalSignal = ['', '127.0.0.1', 'localhost', '::1'].indexOf(String(host)) >= 0;
      if (isLocalSignal) {
        const st0 = lanServices.status();
        if (!st0.signal.running) { lanServices.startSignal(); started.signal = true; }
        if (started.signal) await new Promise((r) => setTimeout(r, 1200));
      }
      /* v0.7.27：和单机版一样走正常播放管线——壳页（内嵌/窗口）从 app:// 读本地 client/index.html，
         信令地址由 pc-adapter 的 gameUrl 以 ?signal= 注入 */
      started.local = true;
      const v = { id: '__lan_client__', name: 'MiniDayZ 多人版', entry: 'client/index.html', dbKey: '__lan_client__', directUrl: true, noSave: true, noKeymap: true };
      createPlayerWindow(v, false, 'scale');
      return { url: 'app://game/version/__lan_client__/' + v.entry, started, local: true };
    });
    /** 本地多人客户端的地址（供界面做内嵌播放用；会顺带把本地服务拉起来） */
    ipcMain.handle('lan:clientUrl', async () => {
      const local = await lanServices.ensureLocalClient();
      if (!local) return { error: '本地多人客户端不可用' };
      return { url: local.url, port: local.port, signal: local.signal };
    });
    // v0.7.19：数据目录/便携 profile 切换后需要重启才生效（Chromium userData 只能在 ready 前设定）
    ipcMain.handle('app:relaunch', () => {
      setTimeout(() => { try { app.relaunch(); } catch (e) {} app.exit(0); }, 600);
      return { ok: true };
    });
    ipcMain.handle('config:setDataMode', async (e, mode) => {
      try { return await versionManager.setDataMode(mode); }
      catch (err) { return { error: err.message }; }
    });
    ipcMain.handle('config:setResolution', (e, id, res) => {
      try {
        const r = versionManager.setResolution(id, res);
        // 若该版本游戏窗口正开着，立即调整到新分辨率
        if (gameWin && gameWinVersionId === id && !gameWin.isDestroyed()) {
          gameWin.setContentSize(r.w, r.h);
          gameWin.setTitle((gameWin.getTitle().split(' · ')[0]) + ' · ' + r.w + '×' + r.h);
        }
        return r;
      } catch (err) { return { error: err.message }; }
    });

    ipcMain.handle('save:export', async (e, payload, fileName) => saveIo.exportJson(launcherWin || gameWin, payload, fileName));
    ipcMain.handle('save:import', async (e) => saveIo.importJson(launcherWin || gameWin));

    // v0.2.2：帮助链接 → 外部浏览器（新窗口）
    ipcMain.handle('shell:openExternal', async (e, url) => {
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
      return { ok: true };
    });

    // 按键映射导入/导出（config.json keymaps[id] ↔ 本地 JSON 文件）
    ipcMain.handle('keymap:export', async (e, id) => {
      const act = keymapActive(versionManager.getKeymap(id));
      if (!act) return { error: '该版本还没有按键映射配置' };
      const res = await dialog.showSaveDialog(launcherWin || gameWin, {
        title: '导出按键映射',
        defaultPath: 'mdz-keymap-' + id + '-' + act.name + '.json',
        filters: [{ name: '按键映射', extensions: ['json'] }]
      });
      if (res.canceled || !res.filePath) return { canceled: true };
      require('fs').writeFileSync(res.filePath, JSON.stringify(act.map, null, 2), 'utf8');
      return { filePath: res.filePath, scheme: act.name };
    });
    ipcMain.handle('keymap:import', async (e, id) => {
      const res = await dialog.showOpenDialog(launcherWin || gameWin, {
        title: '导入按键映射',
        filters: [{ name: '按键映射', extensions: ['json'] }],
        properties: ['openFile']
      });
      if (res.canceled || !res.filePaths[0]) return { canceled: true };
      const raw = JSON.parse(require('fs').readFileSync(res.filePaths[0], 'utf8'));
      if (!raw || typeof raw !== 'object') return { error: '无效的按键映射文件' };
      const obj = (raw.schemes && typeof raw.schemes === 'object') ? raw : { active: '默认', schemes: { '默认': raw } };
      versionManager.saveKeymap(id, obj);
      return { ok: true, count: Object.keys(obj.schemes).length };
    });

    if (IS_MAC) restoreAppMenu();
    createLauncherWindow();

    if (SMOKE) runSmoke();
    else if (UITEST) runUITest();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createLauncherWindow();
  });

  app.on('window-all-closed', () => { app.quit(); });
  // v0.7.22：退出时收拾局域网服务（建房程序是独立程序，会被一起结束；信令/分发是本进程内的）
  app.on('before-quit', () => {
  try { lanServices.stopAll(); } catch (e) {}
  try { saveTransfer.stop(); } catch (e) {}   // v1.0.1：退出时放掉存档传输端口
});

  // ================= 冒烟测试 =================
  function runSmoke() {
    let done = false;
    const finish = (code) => { if (!done) { done = true; setTimeout(() => app.exit(code), 600); } };
    const versions = versionManager.listVersions();
    console.log('[smoke] versions found: ' + versions.length);
    if (versions.length === 0) { console.log('[smoke] NO VERSIONS IMPORTED'); finish(1); return; }
    setTimeout(() => {
      const v = versions[0];
      console.log('[smoke] launching version: ' + v.id + ' dbKey=' + (v.dbKey || ''));
      createGameWindow(v);
      const timer = setTimeout(() => { console.log('[smoke] TIMEOUT'); finish(1); }, 60000);
      gameWin.webContents.on('did-finish-load', () => {
        console.log('[smoke] game did-finish-load OK');
        clearTimeout(timer);
        setTimeout(() => finish(0), 5000);
      });
      gameWin.webContents.on('did-fail-load', (e, code, desc) => { console.log('[smoke] FAIL: ' + code + ' ' + desc); finish(1); });
      gameWin.webContents.on('render-process-gone', (e, d) => { console.log('[smoke] renderer gone: ' + JSON.stringify(d)); finish(1); });
    }, 1200);
  }

  // ================= renderer UI 全路径验证（--uitest；v0.7.4 PC 重建回归） =================
  // 断言：版本列表渲染（含 minidayz-pc 置顶）、「导入版本」按钮、设置卡隐藏、
  //       存档管理器不含 noSave 版本、minidayz-pc 内嵌启动画面完整无滚动、游戏可运行
  function runUITest() {
    let done = false;
    const finish = (code, msg) => {
      if (done) return;
      done = true;
      console.log('[uitest] ' + msg);
      setTimeout(() => app.exit(code), 600);
    };
    const js = (code) => launcherWin.webContents.executeJavaScript(code);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const WAIT = (ms) => { const t0 = Date.now(); return () => Date.now() - t0 > ms; };
    // 转发 launcher 页面 console（含 iframe 内同源游戏页）→ stdout，诊断加载错误
    launcherWin.webContents.on('console-message', (...a) => {
      try { console.log('[uitest][console] ' + fmtConsole(a).slice(0, 300)); } catch (e) {}
    });

    (async () => {
      try {
        // 1) 等版本列表渲染（异步 fetchVersionList + refresh）
        let n = 0, listN = 0;
        const deadline = WAIT(20000);
        while (!deadline()) {
          n = await js('(function(){ var a=window.__webApp; return a ? a.versions() : -1; })()');
          listN = await js("document.querySelectorAll('#versions .list-row, #versions .vcard, #versions .card').length");
          if (n >= 1 && listN >= 1) break;
          await sleep(300);
        }
        if (n < 1 || listN < 1) { finish(1, 'RESULT=FAIL no list rendered (v=' + n + ' cards=' + listN + ')'); return; }
        // 2) 列表断言：v0.7.20 起置顶块 = 「MINIDAYZ PC版」系列（单机版 + 多人版同系列）→
        //    首项应为该系列头（父级行），块内有 MiniDayZ PC 版 / 多人版两个子项，且与后续版本之间有虚线分隔
        await js("(function(){ try { localStorage.removeItem('mdz-playmode-minidayz-pc'); localStorage.removeItem('mdz-res-minidayz-pc'); } catch(e){} return 1; })()"); // v0.7.6：每轮清播放方式/分辨率残留，确保 embed+默认分辨率起点
        const listInfo = await js(`(function(){
          var wrap = document.getElementById('versions');
          var cards = Array.from(wrap.querySelectorAll('.list-row, .vcard, .card'));
          var names = cards.map(function(c){ return (c.textContent || '').trim().slice(0, 40); });
          var first = names[0] || '';
          var head = (wrap.querySelector('.series-head') || {}).textContent || '';
          var all = wrap.textContent || '';
          // 分隔线：仅当置顶块之后还有其它版本时才应出现（测试环境通常只有两个内置版 → 无需分隔线）
          var seps = wrap.querySelectorAll('.list-first-sep').length;
          var topCount = wrap.children.length - seps;
          return JSON.stringify({ total: cards.length, names: names.slice(0, 8),
            firstIsPc: (first.indexOf('MiniDayZ PC') >= 0 || /PC版/.test(first) || /PC版/.test(head)),
            // v0.7.25：多人版客户端是合成版本条目（名字含「多人版」，与单机版同系列）
        hasMp: /多人版/.test(all),
            topCount: topCount,
            sepAfterFirst: (topCount <= 1) ? true : (seps > 0),
            importBtn: !!document.getElementById('pc-btn-import'),
            noticeBtn: !!document.getElementById('btn-notice') }); // v0.7.10：PC 无公告 → 不应出现侧边栏公告按钮
        })()`);
        console.log('[uitest] list=' + listInfo);
        const li = JSON.parse(listInfo);
        if (!li.firstIsPc || !li.hasMp || !li.sepAfterFirst || !li.importBtn || li.noticeBtn) { finish(1, 'RESULT=FAIL list assertions: ' + listInfo); return; }
        // 3) 存档管理器：切存档视图 → 卡无 minidayz-pc
        await js("(function(){ var b=document.querySelector('[data-view=saves]'); if(b) b.click(); return !!b; })()");
        await sleep(1500);
        const saveInfo = await js(`(function(){
          var names = Array.from(document.querySelectorAll('#save-list .save-card h3')).map(function(h){ return h.textContent; });
          return JSON.stringify({ names: names, hasPc: names.some(function(x){ return x.indexOf('MiniDayZ PC') >= 0; }) });
        })()`);
        console.log('[uitest] saves=' + saveInfo);
        const si = JSON.parse(saveInfo);
        if (si.hasPc) { finish(1, 'RESULT=FAIL saves contains minidayz-pc: ' + saveInfo); return; }
        // 4) 回版本列表 → 选中 minidayz-pc → 详情「启动」
        // v0.7.16：PC 默认播放方式=窗口模式——内嵌断言前显式改回 embed 测试内嵌链路
        await js("(function(){ try { localStorage.setItem('mdz-playmode-minidayz-pc', JSON.stringify('embed')); } catch(e){} return 1; })()");
        await js("(function(){ Array.from(document.querySelectorAll('[data-view]')).forEach(function(x){ if(x.dataset.view==='versions') x.click(); }); return 1; })()");
        await sleep(700);
        const clicked = await js(`(async function(){
          var rows = Array.from(document.querySelectorAll('#versions .list-row, #versions .vcard, #versions .card'));
          var hit = rows.find(function(r){ return (r.textContent||'').indexOf('MiniDayZ PC') >= 0; });
          if (!hit) return 'no-row';
          hit.click();
          await new Promise(function(res){ setTimeout(res, 800); });
          var btns = Array.from(document.querySelectorAll('#detail-panel button'));
          var play = btns.find(function(b){ return b.textContent.indexOf('启动') >= 0; });
          if (!play) return 'no-play-btn';
          play.click(); return 'clicked';
        })()`);
        console.log('[uitest] click=' + clicked);
        // 5) 等 iframe 加载 minidayz-pc
        let snap = null;
        const d2 = WAIT(25000);
        while (!d2()) {
          snap = await js(`(function(){
            var fr = document.getElementById('embed-frame');
            if (!fr || !fr.src || fr.src.indexOf('minidayz-pc') < 0) return null;
            var st = document.getElementById('embed-stage');
            try {
              var d = fr.contentDocument;
              if (!d) return { state: 'loading-doc' };
              var el = d.scrollingElement || d.documentElement;
              var cv = d.getElementById('c2canvas');
              return {
                state: d.getElementById('mods') ? 'mods' : 'loaded',
                frameRes: fr.dataset.resW + 'x' + fr.dataset.resH,
                frameCss: fr.style.width + 'x' + fr.style.height + ' t=' + (fr.style.transform || 'none'),
                stageStyleH: st.style.height || '',
                scrollEq: el.scrollHeight === el.clientHeight,
                overflowHidden: getComputedStyle(d.documentElement).overflowY === 'hidden',
                canvas: cv ? cv.clientWidth + 'x' + cv.clientHeight : null,
                hasMods: !!d.getElementById('mods')
              };
            } catch (e) { return { state: 'err:' + e }; }
          })()`);
          if (snap && (snap.state === 'mods' || snap.state === 'loaded' || snap.state.indexOf('err') === 0)) break;
          await sleep(400);
        }
        console.log('[uitest] embed=' + JSON.stringify(snap));
        if (!snap || snap.state === 'err') { finish(1, 'RESULT=FAIL embed: ' + JSON.stringify(snap)); return; }
        // v0.7.8：自由分辨率——iframe 布局=默认 defaultRes(850×890)、overflow hidden、canvas 完整
        if (!snap.overflowHidden || String(snap.frameRes) !== '850x890' || String(snap.canvas) !== '850x890') {
          finish(1, 'RESULT=FAIL embed geometry: ' + JSON.stringify(snap)); return;
        }
        // 6) 点 Start 进游戏，确认 canvas 完整运行
        await js("(function(){ try { var d=document.getElementById('embed-frame').contentDocument; var s=d.querySelector('#mods .start'); if(s) s.dispatchEvent(new PointerEvent('pointerup',{bubbles:true})); return !!s; } catch(e){ return false; } })()");
        await sleep(8000);
        const game = await js(`(function(){
          try {
            var fr=document.getElementById('embed-frame'); var d=fr.contentDocument;
            var el=d.scrollingElement||d.documentElement; var cv=d.getElementById('c2canvas');
            return { hasMods: !!d.getElementById('mods'), canvas: cv ? cv.clientWidth+'x'+cv.clientHeight : null,
              scrollEq: el.scrollHeight === el.clientHeight };
          } catch(e){ return 'err:'+e; }
        })()`);
        console.log('[uitest] game=' + JSON.stringify(game));
        if (!game || typeof game !== 'object' || game.hasMods || !game.canvas) {
          finish(1, 'RESULT=FAIL game start: ' + JSON.stringify(game)); return;
        }
        // 6.5) v0.7.6：分辨率可调——关闭播放器 → 设 1280×720 → 重启动 → iframe 布局 1280×914
        await js("(function(){ var b=document.getElementById('btn-embed-close'); if(b) b.click(); return !!b; })()");
        await sleep(1000);
        await js("(function(){ try { localStorage.setItem('mdz-res-minidayz-pc', JSON.stringify({w:1280,h:720})); } catch(e){} return 1; })()");
        const clicked2 = await js(`(async function(){
          var rows = Array.from(document.querySelectorAll('#versions .list-row, #versions .vcard, #versions .card'));
          var hit = rows.find(function(r){ return (r.textContent||'').indexOf('MiniDayZ PC') >= 0; });
          if (!hit) return 'no-row';
          hit.click();
          await new Promise(function(res){ setTimeout(res, 600); });
          var btns = Array.from(document.querySelectorAll('#detail-panel button'));
          var play = btns.find(function(b){ return b.textContent.indexOf('启动') >= 0; });
          if (!play) return 'no-play-btn';
          play.click(); return 'ok';
        })()`);
        console.log('[uitest] resclick=' + clicked2);
        let snapRes = null;
        const d3 = WAIT(25000);
        while (!d3()) {
          snapRes = await js(`(function(){
            var fr = document.getElementById('embed-frame');
            if (!fr || !fr.src || fr.src.indexOf('minidayz-pc') < 0) return null;
            var d = fr.contentDocument;
            if (!d || !d.getElementById('mods')) return { state: 'loading' };
            return { state: 'mods', frameRes: fr.dataset.resW + 'x' + fr.dataset.resH,
              resSel: (function(){ var s=document.getElementById('embed-res'); return s ? s.value : '-'; })() };
          })()`);
          if (snapRes && snapRes.state === 'mods') break;
          await sleep(400);
        }
        console.log('[uitest] res-snap=' + JSON.stringify(snapRes));
        if (!snapRes || snapRes.frameRes !== '1280x720' || snapRes.resSel !== '1280x720') {
          finish(1, 'RESULT=FAIL resolution: ' + JSON.stringify(snapRes)); return;
        }
        // 7) v0.7.11：PC「窗口模式」（原全屏）→ 独立游戏窗口（IPC versions:launch → createGameWindow）
        await js("(function(){ try { localStorage.setItem('mdz-playmode-minidayz-pc', JSON.stringify('fullscreen')); } catch(e){} return 1; })()");
        const clicked3 = await js(`(async function(){
          var rows = Array.from(document.querySelectorAll('#versions .list-row, #versions .vcard, #versions .card'));
          var hit = rows.find(function(r){ return (r.textContent||'').indexOf('MiniDayZ PC') >= 0; });
          if (!hit) return 'no-row';
          hit.click();
          await new Promise(function(res){ setTimeout(res, 600); });
          var btns = Array.from(document.querySelectorAll('#detail-panel button'));
          var play = btns.find(function(b){ return b.textContent.indexOf('启动') >= 0; });
          if (!play) return 'no-play-btn';
          play.click(); return 'ok';
        })()`);
        console.log('[uitest] winclick=' + clicked3);
        let winOk = null;
        const d4 = WAIT(20000);
        while (!d4()) {
          winOk = (gameWin && !gameWin.isDestroyed())
            ? { url: gameWin.webContents.getURL(), content: gameWin.getContentSize() }
            : null;
          if (winOk && String(winOk.url).indexOf('minidayz-pc') >= 0) break;
          await sleep(400);
        }
        console.log('[uitest] gamewin=' + JSON.stringify(winOk));
        if (!winOk || String(winOk.url).indexOf('minidayz-pc') < 0) { finish(1, 'RESULT=FAIL window-mode: ' + JSON.stringify(winOk)); return; }
        // 7.5) v0.7.13：wrapper 壳页内游戏真实加载（无滚动条 + mapper 注入 + 画布存在）
        let inner = null;
        const d5 = WAIT(30000);
        while (!d5()) {
          if (!gameWin || gameWin.isDestroyed()) { inner = { state: 'gone' }; break; }
          inner = await gameWin.webContents.executeJavaScript(`(function(){
            try {
              var f = document.getElementById('game');
              if (!f) return null;
              var d = f.contentDocument;
              if (!d || !d.documentElement) return null;
              var cv = d.getElementById('c2canvas');
              if (!cv) return { state: 'loading-canvas' };
              var ov = getComputedStyle(d.documentElement).overflowY;
              return { state: 'ok', canvas: cv.clientWidth + 'x' + cv.clientHeight,
                overflow: ov, mapper: !!d.getElementById('mdz-web-mapper') };
            } catch (e) { return { state: 'err:' + e }; }
          })()`);
          if (inner && inner.state === 'ok') break;
          await sleep(500);
        }
        console.log('[uitest] win-inner=' + JSON.stringify(inner));
        // v0.7.17：minidayz-pc = noKeymap（内置 PC 版键鼠原生）→ 壳页应有 overflow/画布处理但【不注入 mapper】
        if (!inner || inner.state !== 'ok' || inner.overflow !== 'hidden' || inner.mapper !== false) {
          finish(1, 'RESULT=FAIL window-inner: ' + JSON.stringify(inner)); return;
        }
        // 7.6) v0.7.17：noKeymap（minidayz-pc）窗口模式下 F10 不应出现校准面板（mapper 未注入）。
        // 普通版本窗口 mapper/F10 正向链路与内嵌 mapper 一致（web-smoke 校准断言覆盖）
        let f10 = null;
        try {
          f10 = await gameWin.webContents.executeJavaScript(`(async function(){
            try {
              var f = document.getElementById('game');
              if (!f || !f.contentWindow) return 'no-frame';
              var d = f.contentDocument;
              if (!d || !d.documentElement) return 'no-doc';
              var mapper = !!(d.getElementById('mdz-web-mapper') || d.getElementById('mdz-keymap-preset'));
              await new Promise(function (r) { setTimeout(r, 1200); });
              var sent = 0, panelShown = false;
              while (sent < 4) {
                try { f.contentWindow.dispatchEvent(new KeyboardEvent('keydown', { code: 'F10', bubbles: true, cancelable: true })); } catch (e) {}
                sent++;
                await new Promise(function (r) { setTimeout(r, 400); });
                if (d.getElementById('mdz-keycal')) { panelShown = true; break; }
              }
              return JSON.stringify({ mapper: mapper, panelShown: panelShown });
            } catch (e) { return 'err:' + e; }
          })()`);
          const fo = (typeof f10 === 'string') ? JSON.parse(f10) : f10;
          if (!fo || fo.mapper || fo.panelShown) { finish(1, 'RESULT=FAIL window-nokeymap: ' + JSON.stringify(f10)); return; }
          console.log('[uitest] win-nokeymap=' + JSON.stringify(f10));
        } catch (e2) { finish(1, 'RESULT=FAIL window-nokeymap exception: ' + e2); return; }
        try { if (gameWin && !gameWin.isDestroyed()) { gameWin.destroy(); gameWin = null; gameWinVersionId = null; } } catch (e) {}
        await js("(function(){ try { localStorage.removeItem('mdz-playmode-minidayz-pc'); } catch(e){} return 1; })()");

        // 7.8) v0.7.22 新增 / v0.7.25 调整：局域网能力回归（控制面板已从设置页移到侧边栏「联机配置」页）
        //   a) 侧边栏有「联机配置」入口（放在 index.html 里，随导航绑定一起生效——不是后注入的按钮）
        const lanNav = await js(`(function(){ var b=document.querySelector('.nav-item[data-view="lan"]'); if(!b) return 'none';
          return JSON.stringify({ found:true, text:(b.textContent||'').trim(), isButton:b.tagName === 'BUTTON' }); })()`);
        console.log('[uitest] lan-nav=' + lanNav);
        if (String(lanNav).indexOf('none') === 0) { finish(1, 'RESULT=FAIL lan nav missing'); return; }

        //   a2) v0.7.25：侧边栏「联机配置」页（服务器/分发/建房程序三件套都在这一页；版本列表里不再放这三项）
        await js("(function(){ var n=document.querySelector('.nav-item[data-view=\"lan\"]'); if(n) n.click(); return 1; })()");
        await sleep(900);
        const lanPage = await js(`(function(){ var p=document.getElementById('lan-panel'); var v=document.getElementById('view-lan');
          if(!p||!v) return 'no-panel';
          var txt=p.textContent||'';
          return JSON.stringify({ active:v.classList.contains('active'), cards:p.querySelectorAll('.settings-card').length,
            btns:p.querySelectorAll('button').length, hasSignal:/信令/.test(txt), hasServe:/分发/.test(txt),
            hasName:/玩家名称/.test(txt), nameRows:[].slice.call(p.querySelectorAll('.row')).filter(function(r){ return r.querySelector('input') && (r.textContent||'').indexOf('玩家名称')>=0; }).length, hasHost:/建房程序/.test(txt), hasLog:!!document.getElementById('lan-log') }); })()`);
        console.log('[uitest] lan-page=' + lanPage);
        if (String(lanPage).indexOf('no-panel') === 0) { finish(1, 'RESULT=FAIL lan page missing'); return; }
        const lp = JSON.parse(lanPage);
        /* v0.7.30：玩家名称已挪到「多人版 → 配置」弹窗 → 联机配置页不该再有「玩家名称」输入行
           （不能只看文本——卡片提示里会提到这个词；也不能数文本框——建房程序目录也是文本框） */
        if (!lp.active || lp.cards < 3 || lp.btns < 5 || !lp.hasSignal || !lp.hasServe || !lp.hasHost || lp.nameRows !== 0 || !lp.hasLog) {
          finish(1, 'RESULT=FAIL lan page content: ' + lanPage); return;
        }
        //   a3) 多人版客户端 = 合成版本条目（与单机版同系列；父级块里有子项）
        await js("(function(){ var n=document.querySelector('.nav-item[data-view=\"versions\"]'); if(n) n.click(); return 1; })()");
        await sleep(900);
        const mpRow = await js(`(function(){ var wrap=document.getElementById('versions'); if(!wrap) return 'no-wrap';
          var txt=wrap.textContent||'';
          var head=wrap.querySelector('.list-row.series-head');
          /* v0.7.28：多人版图标/封面必须真加载出图像（此前写死 mp-icon.png/mp-cover.png → 图裂成一块蓝色，
             用户反馈「元数据没了、变成一块蓝色」）。这里按 naturalWidth 断言真图，而不是只看元素存在。 */
          var row=null, rows=[].slice.call(wrap.querySelectorAll('.list-row'));
          for (var i=0;i<rows.length;i++){ if((rows[i].textContent||'').indexOf('多人版')>=0){ row=rows[i]; break; } }
          var out={ hasMP:/多人版/.test(txt), seriesHead: head ? (head.textContent||'').slice(0,30) : 'none', img:null, imgOk:false };
          if (row) {
            var im=row.querySelector('img');
            if (im) { out.img = im.getAttribute('src'); out.imgOk = !!(im.naturalWidth > 0); }
            else out.img = 'no-img';
          } else out.img = 'no-row';
          return JSON.stringify(out); })()`);
        console.log('[uitest] lan-client-row=' + mpRow);
        const mp2 = (function () { try { return JSON.parse(mpRow); } catch (e) { return null; } })();
        if (!mp2 || !mp2.hasMP) { finish(1, 'RESULT=FAIL mp client row: ' + mpRow); return; }
        if (!mp2.imgOk) { finish(1, 'RESULT=FAIL mp client icon/cover 没加载出来（一块蓝色）: ' + mpRow); return; }
        /* v0.7.30：「服务器地址 + 玩家名称」在多人版**配置弹窗**里（用户要求从「联机配置」页挪过来），保存要真落盘 */
        const mpCfg = await js(`(async function(){
          var wrap=document.getElementById('versions');
          var rows=[].slice.call(wrap.querySelectorAll('.list-row'));
          var row=rows.filter(function(r){ return (r.textContent||'').indexOf('多人版')>=0; })[0];
          if(!row){ var hs=[].slice.call(wrap.querySelectorAll('.series-expand'));
            var h=hs.filter(function(b){ return (b.textContent||'').indexOf('展开')>=0; })[0];
            if(h){ h.click(); await new Promise(function(s){ setTimeout(s,800); }); }
            rows=[].slice.call(wrap.querySelectorAll('.list-row'));
            row=rows.filter(function(r){ return (r.textContent||'').indexOf('多人版')>=0; })[0];
          }
          if(!row) return 'no-mp-row';
          var cfg=row.querySelector('.lr-config'); if(!cfg) return 'no-cfg-btn'; cfg.click();
          await new Promise(function(s){ setTimeout(s,900); });
          var d=document.querySelector('.cd-dialog')||document.querySelector('.config-dialog');
          if(!d) return 'no-dialog';
          var ins=[].slice.call(d.querySelectorAll('input[type=text]'));
          if(ins.length<2) return 'inputs=' + ins.length;
          var before=(window.__launcherNative? await window.__launcherNative.lanStatus() : null);
          ins[0].value='192.168.7.7:8790';
          ins[1].value='UItestName';
          var bs=[].slice.call(d.querySelectorAll('button')).filter(function(b){ return (b.textContent||'').trim()==='保存'; });
          if(bs.length<2) return 'save-btns=' + bs.length;
          bs[0].click(); await new Promise(function(s){ setTimeout(s,700); });
          var d2=document.querySelector('.cd-dialog')||document.querySelector('.config-dialog');
          var ins2=[].slice.call(d2.querySelectorAll('input[type=text]'));
          ins2[1].value='UItestName';
          var bs2=[].slice.call(d2.querySelectorAll('button')).filter(function(b){ return (b.textContent||'').trim()==='保存'; });
          bs2[1].click(); await new Promise(function(s){ setTimeout(s,700); });
          var st=window.__launcherNative? await window.__launcherNative.lanStatus() : null;
          var d3=document.querySelector('.cd-dialog')||document.querySelector('.config-dialog');
          if(d3){ var cs=d3.querySelector('.cd-close'); if(cs) cs.click(); }
          return JSON.stringify({ inputs:ins.length, before: before? (before.lan.serverHost+'|'+before.lan.playerName) : 'n/a',
            host: st? st.lan.serverHost : 'n/a', sigPort: st? st.lan.signalPort : 0, name: st? st.lan.playerName : 'n/a',
            txt:(d3? (d3.textContent||'') : '').indexOf('多人联机')>=0 });
        })()`);
        console.log('[uitest] mp-config=' + mpCfg);
        const mc = (function () { try { return JSON.parse(mpCfg); } catch (e) { return null; } })();
        if (!mc || mc.inputs < 2 || mc.host !== '192.168.7.7' || mc.sigPort !== 8790 || mc.name !== 'UItestName') {
          finish(1, 'RESULT=FAIL mp config（服务器地址/玩家名称）: ' + mpCfg); return;
        }
        // 复位（后续步骤与用户日常都基于 127.0.0.1:8787 + MiniPlayer）
        await js("(async function(){ if(window.__launcherNative){ await window.__launcherNative.setLan({serverHost:'', signalPort:8787, playerName:'MiniPlayer'}); } return 1; })()");
        await sleep(500);
        const stReset = lanServices.status();
        console.log('[uitest] mp-config-reset=' + JSON.stringify({ host: stReset.lan.serverHost, sig: stReset.lan.signalPort, name: stReset.playerName }));
        if (stReset.lan.serverHost !== '' || stReset.lan.signalPort !== 8787 || stReset.playerName !== 'MiniPlayer') {
          finish(1, 'RESULT=FAIL mp config reset: ' + JSON.stringify(stReset.lan)); return;
        }

        //   b) 进程内起信令服务器 → 配电服务 → 分发内容确实注入了自适应信令地址 → 再全部停掉
        lanServices.startSignal();
        await sleep(1200);
        const stA = lanServices.status();
        console.log('[uitest] lan-signal=' + JSON.stringify({ running: stA.signal.running, port: stA.signal.port, dir: stA.lanDir || '' }));
        if (!stA.signal.running || !stA.lanDir) { finish(1, 'RESULT=FAIL signal server not running'); return; }

        lanServices.startServe();
        await sleep(1500);
        const stB = lanServices.status();
        console.log('[uitest] lan-serve=' + JSON.stringify({ running: stB.serve.running, port: stB.serve.port, url: (stB.serve.urls || [])[0] || '', builtinMp: stB.builtinMp || '' }));
        if (!stB.serve.running || !stB.builtinMp) { finish(1, 'RESULT=FAIL serve not running'); return; }

        let injectOk = false;
        try {
          const httpMod = require('http');
          const body = await new Promise((resolve, reject) => {
            const req = httpMod.get('http://127.0.0.1:' + stB.serve.port + '/mods.js', (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => resolve(d)); });
            req.on('error', reject);
            req.setTimeout(5000, () => req.destroy(new Error('timeout')));
          });
          injectOk = /location\.hostname\s*\+\s*':\d+'/.test(body) && /mdz-signal/.test(body);
        } catch (e) { console.log('[uitest] lan-inject error: ' + e.message); }
        console.log('[uitest] lan-inject=' + injectOk + ' lan-host=' + JSON.stringify({ exists: stB.host.exists }));
        if (!injectOk) { finish(1, 'RESULT=FAIL distribute injection'); return; }

        lanServices.stopServe();
        lanServices.stopSignal();
        await sleep(700);
        const stC = lanServices.status();
        console.log('[uitest] lan-stopped=' + JSON.stringify({ sig: stC.signal.running, serve: stC.serve.running }));
        if (stC.signal.running || stC.serve.running) { finish(1, 'RESULT=FAIL lan stop'); return; }

        //   c) v0.7.26：点「多人游戏客户端」= **本地**把客户端发出来（127.0.0.1:临时端口）+ 信令地址注入，
        //      窗口真的加载到游戏页（修「忘了先起服务 → 黑窗口」与「内嵌黑屏」）
        await js("(function(){ window.__playRes=''; window.__launcherNative.lanPlay().then(function(r){ window.__playRes=JSON.stringify(r); }).catch(function(e){ window.__playRes='ERR '+e.message; }); return 1; })()");
        await sleep(6000);
        const playRes = await js("window.__playRes || '(pending)'");
        console.log('[uitest] lan-play=' + playRes);
        let pr = null; try { pr = JSON.parse(playRes); } catch (e) {}
        if (!pr || pr.error || String(pr.url || '').indexOf('__lan_client__') < 0 || !pr.started || !pr.started.local) {
          finish(1, 'RESULT=FAIL lan:play local client: ' + playRes); return;
        }
        let playPage = 'none';
        const dPage = WAIT(30000);
        while (!dPage()) {
          if (!gameWin || gameWin.isDestroyed()) { playPage = 'gone'; break; }
          try {
            /* v0.7.27：多人版现在和单机版同一条管线（壳页 game-window.html + 游戏 iframe），
               所以要看 iframe 里的游戏页，而不是壳页自身 */
            playPage = await gameWin.webContents.executeJavaScript("(function(){ try{ var f=document.getElementById('game'); var w=f&&f.contentWindow; var d=f&&f.contentDocument; if(!w||!d) return 'no-doc'; return (d.getElementById('mods')?'mods-ui':'no-mods') + '|canvas=' + (!!d.getElementById('c2canvas')) + '|sig=' + (w.__mdzMpSignal||'') + '|src=' + (f.getAttribute('src')||''); }catch(e){ return 'err:'+e.message; } })()");
          } catch (e) { playPage = 'err:' + e.message; }
          if (/canvas=true/.test(String(playPage))) break;
          await sleep(500);
        }
        console.log('[uitest] lan-play-page=' + playPage);
        if (!/mods-ui\|canvas=true/.test(String(playPage))) { finish(1, 'RESULT=FAIL lan play page (black screen?): ' + playPage); return; }
        if (String(playPage).indexOf('sig=ws://') < 0) { finish(1, 'RESULT=FAIL lan signal not injected: ' + playPage); return; }
        /* v0.7.29：客户端页地址必须带 mdz=1（据此 html,body{overflow:hidden}，不出滚动条）与 user=（玩家名） */
        if (String(playPage).indexOf('mdz=1') < 0) { finish(1, 'RESULT=FAIL 客户端地址缺 mdz=1（会出滚动条）: ' + playPage); return; }
        if (String(playPage).indexOf('user=') < 0) { finish(1, 'RESULT=FAIL 客户端地址缺 user=（玩家名）: ' + playPage); return; }
        //   c2) v0.7.24：在服务器分发的客户端里点 Start → C2 runtime 起来（顶替原「内置多人版内嵌启动」回归）
        try {
          await gameWin.webContents.executeJavaScript("(function(){ try{ var f=document.getElementById('game'); var d=f&&f.contentDocument; if(!d) return 0; var s=d.querySelector('#mods .start'); if(!s) return 0; s.dispatchEvent(new f.contentWindow.PointerEvent('pointerup',{bubbles:true})); return 1; }catch(e){ return 0; } })()");
        } catch (e) {}
        await sleep(9000);
        let srvRun = 'none';
        try {
          if (gameWin && !gameWin.isDestroyed()) {
            /* v0.7.28：壳页 + iframe → C2 runtime 在 iframe 的 window 上；
               并验证客户端真的装了我们的**信令地址模组**（否则连的是官方=已停服，用户看到「原版、没房间」） */
            srvRun = await gameWin.webContents.executeJavaScript("(function(){ try{ var f=document.getElementById('game'); var w=f&&f.contentWindow; if(!w) return JSON.stringify({err:'no-frame'}); var d=w.document; var c=d&&d.getElementById('c2canvas');" +
              "var mpMods=''; try{ mpMods=String(w.localStorage.getItem('mp.mods')||''); }catch(e){}" +
              "var patched=false; try{ patched=!!(w.C2Multiplayer && w.C2Multiplayer.prototype && w.C2Multiplayer.prototype.__mdzSignalPatched); }catch(e){}" +
              "var addr=''; try{ addr=String(w.__mdzMpSignal||''); }catch(e){}" +
              /* v0.7.32：directUrl 客户端的「存档隔离」是否装上（壳页注入 / 客户端自带 P6 均可） */
              "var isoDb=''; try{ isoDb=String(w.__mdzDbKey||''); }catch(e){}" +
              "var isoOn=''; try{ isoOn=String(w.__mdzIsolation||''); }catch(e){}" +
              "return JSON.stringify({ runtime: !!w.c2runtime, modsGone: !(d&&d.getElementById('mods')), canvas: c ? (c.width+'x'+c.height) : null, sigMod: mpMods.indexOf('mdz-signal')>=0, sigPatched: patched, sigAddr: addr, isoDbKey: isoDb, isoOn: isoOn }); }catch(e){ return JSON.stringify({err:String(e)}); } })()");
          }
        } catch (e) { srvRun = 'err:' + e.message; }
        console.log('[uitest] lan-play-run=' + srvRun);
        const srr = (function () { try { return JSON.parse(srvRun); } catch (e) { return null; } })();
        if (!srr || !srr.runtime || !srr.modsGone) { finish(1, 'RESULT=FAIL server client run (black screen?): ' + srvRun); return; }
        /* v0.7.28：客户端必须挂上我们的信令模组（否则是「原版」= 连官方已停服 → 看不到自建服务器里的房间） */
        if (!srr.sigMod) { finish(1, 'RESULT=FAIL 客户端未启用 mdz-signal 模组（会连官方、看不到房间）: ' + srvRun); return; }
        if (String(srr.sigAddr || '').indexOf('ws://') !== 0) { finish(1, 'RESULT=FAIL 客户端未拿到局域网信令地址: ' + srvRun); return; }
        /* v0.7.32：多人版是 directUrl 直链加载 —— 必须已经装上「存档隔离」（库名带 __lan_client__ 后缀），
           否则它写裸库、与其它版本互相覆盖（用户反馈「存档隔离不起作用」） */
        if (String(srr.isoDbKey || '') !== '__lan_client__') { finish(1, 'RESULT=FAIL 多人版客户端未装存档隔离: ' + srvRun); return; }
        try { if (gameWin && !gameWin.isDestroyed()) { gameWin.destroy(); gameWin = null; } } catch (e) {}

        //   d) v0.7.25：从**版本列表**点「MiniDayZ 多人版」启动 → 走 lan:play（服务器分发页；PC 默认全屏，与单机版一致）
        await js("(function(){ var n=document.querySelector('.nav-item[data-view=\"versions\"]'); if(n) n.click(); return 1; })()");
        await sleep(800);
        const mpClick = await js(`(async function(){ var rows=[].slice.call(document.querySelectorAll('#versions .list-row'));
          var hit=rows.find(function(r){ return (r.textContent||'').indexOf('多人版')>=0 && r.querySelectorAll('button').length>1; });
          if(!hit) return 'no-row'; hit.click();
          await new Promise(function(s){ setTimeout(s,900); });
          var bs=[].slice.call(document.querySelectorAll('#detail-panel button'));
          var p=bs.find(function(b){ return (b.textContent||'').indexOf('启动')>=0; });
          if(!p) return 'no-play'; p.click(); return 'clicked'; })()`);
        console.log('[uitest] mp-launch-click=' + mpClick);
        await sleep(5000);
        let mpWin = 'none';
        try { if (gameWin && !gameWin.isDestroyed()) mpWin = JSON.stringify({ url: gameWin.webContents.getURL(), fs: gameWin.isFullScreen() }); } catch (e) { mpWin = 'err:' + e.message; }
        console.log('[uitest] mp-launch-win=' + mpWin);
        if (String(mpWin).indexOf('__lan_client__') < 0) { finish(1, 'RESULT=FAIL mp launch from list: ' + mpWin); return; }
        /* 顺带确认壳页里真的把多人版客户端加载出来了（不是黑屏壳） */
        const mpInner = await (async () => {
          try {
            if (!gameWin || gameWin.isDestroyed()) return 'gone';
            return await gameWin.webContents.executeJavaScript("(function(){ try{ var f=document.getElementById('game'); var d=f&&f.contentDocument; if(!d) return 'no-doc'; return (d.getElementById('mods')?'mods-ui':'no-mods') + '|canvas=' + (!!d.getElementById('c2canvas')); }catch(e){ return 'err:'+e.message; } })()");
          } catch (e) { return 'err:' + e.message; }
        })();
        console.log('[uitest] mp-launch-page=' + mpInner);
        if (!/canvas=true/.test(String(mpInner))) { finish(1, 'RESULT=FAIL mp launch page: ' + mpInner); return; }
        try { if (gameWin && !gameWin.isDestroyed()) { gameWin.destroy(); gameWin = null; } } catch (e) {}
        await js("(function(){ Array.from(document.querySelectorAll('[data-view]')).forEach(function(x){ if(x.dataset.view==='versions') x.click(); }); return 1; })()");
        lanServices.stopServe();
        lanServices.stopSignal();
        await sleep(500);

        finish(0, 'RESULT=UI-OK');
      } catch (e) {
        finish(1, 'RESULT=FAIL exception: ' + (e && e.stack || e));
      }
    })();
  }
}

function fmtConsole(args) {
  try {
    if (args.length >= 2 && typeof args[1] === 'object' && args[1] !== null && 'message' in args[1]) {
      return `[${args[1].level}] ${String(args[1].message).slice(0, 400)}`;
    }
    const [e, level, message, line, source] = args;
    return `[${level}] ${String(message).slice(0, 400)} (${source}:${line})`;
  } catch (err) { return String(args); }
}
