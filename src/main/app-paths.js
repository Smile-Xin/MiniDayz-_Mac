'use strict';
/**
 * app-paths —— 数据目录布局与「便携模式」启动期引导
 *
 * 目录模型（2026-09-15 定稿）：
 *   <根>/data     设置与存档（config.json + Chromium profile：localStorage / IndexedDB / Preferences …）
 *   <根>/versions 游戏版本
 * 其中 <根> 有两种：
 *   appdata 模式 = 系统用户数据目录（Windows: %APPDATA%\MDZLauncher，macOS: ~/Library/Application Support/MDZLauncher）
 *   便携模式     = 程序所在目录（整包搬走即带走全部数据）
 *
 * macOS 例外：`.app` 是签名的只读包，没有 Windows「便携单文件 exe」概念，
 *            因此便携模式在 macOS 上整体禁用，数据固定放 appdata。
 *
 * 便携判定：<根>/data/.portable 存在，或 <根>/data/config.json 里 dataMode=portable。
 * 兼容策略：**不识别旧布局**（旧版把 data 放在 <根>/MDZLauncher/）。
 */
const fs = require('fs');
const path = require('path');
const core = require('./version-core');

/** Chromium profile 里需要随数据目录一起搬的项目（设置/存档所在；Cache 等可再生缓存不搬） */
const PROFILE_ITEMS = [
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'Preferences',
  'Network',
  'WebStorage',
  'Shared Dictionary'
];

const CONFIG_FILE = 'config.json';
const PORTABLE_MARK_NAME = '.portable';

/** 读 JSON，失败返回 null（不抛异常：启动期任何损坏文件都不该阻断进程） */
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

/** 便携基准目录（版本目录与数据目录共用同一基准，保证两者始终同处便携路径） */
function portableBase(app) {
  return core.computePortableBase({
    exeDir: path.dirname(app.getPath('exe')),
    isPackaged: app.isPackaged,
    devRoot: path.join(__dirname, '..', '..')
  });
}

/**
 * 计算一个数据根下的全部相关路径。
 * 注意：app.getPath('userData') 必须在 app.setName 之后读，否则目录名不对。
 */
function resolveLayout(app) {
  const appDataRoot = app.getPath('userData');
  const base = portableBase(app);
  const portableData = path.join(base, 'data');
  return {
    appDataRoot,
    appData: path.join(appDataRoot, 'data'),
    portableBase: base,
    portableData,
    portableMark: path.join(portableData, PORTABLE_MARK_NAME)
  };
}

/** 复制单个 profile 项目；目录走递归复制，返回复制的文件数 */
function copyProfileItem(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) return core.copyDirRecursive(src, dst);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return 1;
}

/**
 * 把 profile 里的设置/存档搬到目标数据目录。
 * 只补缺失项，不覆盖已有数据；单项失败不影响其余项。
 * @returns {number} 复制成功的文件数
 */
function migrateProfile(fromDir, toDir) {
  if (!fromDir || !toDir || path.resolve(fromDir) === path.resolve(toDir)) return 0;
  let moved = 0;
  fs.mkdirSync(toDir, { recursive: true });
  for (const name of PROFILE_ITEMS) {
    const src = path.join(fromDir, name);
    const dst = path.join(toDir, name);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) moved += copyProfileItem(src, dst);
    } catch (e) { /* 单项失败不影响启动 */ }
  }
  return moved;
}

/**
 * 启动引导：判断是否便携模式，首次以便携方式启动时把设置/存档搬过来。
 * **必须在 app ready 之前调用**（结果用于 app.setPath('userData')）。
 *
 * @param {object} opts
 * @param {object} opts.layout resolveLayout() 的返回值
 * @param {boolean} opts.isMac macOS 上强制 appdata
 * @returns {{portable: boolean, dataDir: string}} 当前生效的数据目录
 */
function bootstrapDataDir(opts) {
  const layout = opts.layout;
  const isMac = !!opts.isMac;
  let portable = false;
  try {
    if (!isMac) {
      const portableConfig = readJsonSafe(path.join(layout.portableData, CONFIG_FILE));
      portable = !!((portableConfig && portableConfig.dataMode === 'portable') || fs.existsSync(layout.portableMark));
      if (portable) {
        fs.mkdirSync(layout.portableData, { recursive: true });
        // 首次以便携方式启动（只有标记、没有配置）→ 从 appdata 的 data 目录把设置/存档搬过来（只补缺失项）
        const moved = migrateProfile(layout.appData, layout.portableData);
        if (!portableConfig) {
          const merged = Object.assign({}, readJsonSafe(path.join(layout.appData, CONFIG_FILE)) || {}, { dataMode: 'portable' });
          fs.writeFileSync(path.join(layout.portableData, CONFIG_FILE), JSON.stringify(merged, null, 2), 'utf8');
        }
        try { fs.writeFileSync(layout.portableMark, 'portable\n', 'utf8'); } catch (e) { /* 标记写失败不影响本次启动 */ }
        if (moved) console.log('[mdz] 便携数据目录已迁移 ' + moved + ' 个文件 → ' + layout.portableData);
      }
    }
  } catch (e) {
    console.warn('[mdz] 便携数据目录引导失败，回退系统 appdata：' + (e && e.message));
    portable = false;
  }
  return { portable, dataDir: portable ? layout.portableData : layout.appData };
}

module.exports = {
  PROFILE_ITEMS,
  CONFIG_FILE,
  readJsonSafe,
  portableBase,
  resolveLayout,
  migrateProfile,
  bootstrapDataDir
};
