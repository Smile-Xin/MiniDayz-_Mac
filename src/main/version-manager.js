'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const core = require('./version-core');
const appPaths = require('./app-paths');

const CONFIG_FILE = appPaths.CONFIG_FILE;
const APP_DATA_DIR = 'MDZLauncher'; // 与 app.setName 保持一致

let dataMode = 'appdata';
let versionsRoot = null;
let userDataPath = null;   // 当前生效的「数据目录」= <根>\data（appdata = %APPDATA%\MDZLauncher\data；portable = <程序同级>\data）
let realUserData = null;   // appdata 模式的「根」= %APPDATA%\MDZLauncher（下含 data 与 versions；切换模式时作为迁移对端）

function configPath() { return path.join(userDataPath, CONFIG_FILE); }

/** v0.8.0：便携数据目录 = <便携基准>/data（与 <便携基准>/versions 同级，整包搬走即带走全部数据） */
function portableBase() {
  return appPaths.portableBase(app);
}
function portableDataPath() { return path.join(portableBase(), 'data'); }
/** v0.8.0：appdata 模式的「数据目录」= <根>\data（realUserData 是根，versions 也在根下与它同级） */
function appdataDataPath() { return path.join(realUserData || userDataPath, 'data'); }
function portableMarkPath() { return path.join(portableDataPath(), '.portable'); }

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (e) { return {}; }
}
function writeConfig(cfg) {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

function resolveRoot(mode) {
  return core.computeVersionsRoot(mode, {
    // v0.7.19：appdata 模式必须用「真正的系统 appdata」——便携模式下 userData 已被重定位到便携目录
    userData: (mode === 'portable') ? userDataPath : (realUserData || userDataPath),
    exeDir: path.dirname(app.getPath('exe')),
    isPackaged: app.isPackaged,
    devRoot: path.join(__dirname, '..', '..')
  });
}

async function init(opts) {
  userDataPath = app.getPath('userData');  // 便携模式下 main 引导阶段已 setPath 到便携数据目录
  realUserData = (opts && opts.realUserData) || userDataPath;
  const cfg = readConfig();
  dataMode = cfg.dataMode === 'portable' ? 'portable' : 'appdata';
  versionsRoot = resolveRoot(dataMode);
  fs.mkdirSync(versionsRoot, { recursive: true });
}

function getVersionsRoot() { return versionsRoot; }
/** v0.7.44：内置版本根（打包 = resources\versions；dev = <工程根>\versions；旧 builtin\ 布局回退）——
 *  内置版直接从这里读，不再复制进数据目录。 */
function getBuiltinRoots() {
  const cands = [
    path.join(process.resourcesPath || '', 'versions'),
    path.join(app.getAppPath(), 'versions'),
    path.join(process.resourcesPath || '', 'builtin'),
    path.join(app.getAppPath(), 'builtin')
  ];
  const out = [];
  for (const c of cands) {
    if (!c) continue;
    let dup = false;
    for (const o of out) { try { if (path.resolve(o) === path.resolve(c)) dup = true; } catch (e) { /* 忽略 */ } }
    if (dup) continue;
    try { if (!fs.existsSync(c)) continue; } catch (e) { continue; }
    out.push(c);
  }
  return out;
}
/** 该 id 是否只存在于内置根（数据目录里没有） */
function isBuiltinVersion(id) {
  for (const r of getBuiltinRoots()) {
    try {
      if (versionsRoot && path.resolve(r) === path.resolve(versionsRoot)) continue;
      if (fs.existsSync(path.join(r, String(id)))) return true;
    } catch (e) { /* 忽略 */ }
  }
  return false;
}
/* v0.7.44：内置根里有 minidayz-pc 与 minidayz-mp 两份，但**多人版不作为版本卡片**
   （v0.7.24 起：联机页里那个合成的「多人游戏客户端」才是入口）——这里保持改动前的卡片集合：
   pc（内置）+ 用户自己导入的版本；用户自己导入的同名 minidayz-mp 仍会照常显示。 */
const LIST_SKIP_BUILTIN = ['minidayz-mp'];
function listVersions() {
  return core.loadVersions(versionsRoot, getBuiltinRoots())
    .filter((v) => !(v.builtin && LIST_SKIP_BUILTIN.indexOf(v.id) >= 0));
}
function getVersion(id) { return listVersions().find((v) => v.id === id) || null; }

function inspectZip(zipPath) {
  const cand = core.inspectZip(zipPath);
  cand.existing = getVersion(cand.id) ? true : false;
  return cand;
}

function importZip(candidate, overrides) {
  const o = overrides || {};
  const m = (candidate && candidate.meta) || {};
  const id = core.sanitizeId(o.id || m.id || (candidate && candidate.id));
  const dbKey = (o.dbKey && String(o.dbKey).trim()) || m.dbKey || core.defaultDbKey(id);
  // dbKey 冲突检查：不同版本不得共用隔离后缀（会串档）
  const clash = listVersions().find((v) => v.id !== id && v.dbKey === dbKey);
  if (clash) throw new Error('dbKey 与版本 ' + clash.id + ' 冲突，请修改（否则存档会串）');
  const rec = core.importZip(candidate.zipPath, {
    id,
    name: o.name || m.name || id,
    dbKey,
    desc: o.desc || m.desc || ''
  }, versionsRoot);
  return rec;
}

function removeVersion(id) {
  const dir = path.join(versionsRoot, id);
  const has = fs.existsSync(dir);
  /* v0.7.44：内置版由内置根提供，数据目录里没有它 —— 删了也还在，直接拒绝并提示 */
  if (!has && isBuiltinVersion(id)) throw new Error('内置版本不可删除（' + id + '）');
  if (has) fs.rmSync(dir, { recursive: true, force: true });
}

/** 切换数据目录模式（v0.7.19：连同「数据/缓存」一起搬——config.json + localStorage/IndexedDB 等 profile 数据）
 *  注意：Chromium profile 路径只能在 app ready 之前设定，所以切换后需重启应用（needRestart）。 */
function setDataMode(mode) {
  if (mode !== 'appdata' && mode !== 'portable') throw new Error('非法模式: ' + mode);
  // macOS 移植：便携模式在 .app 里没有可写位置（沙箱/只读签名包），直接拒绝并保持 appdata
  if (process.platform === 'darwin' && mode === 'portable') {
    throw new Error('macOS 版不支持「程序目录（便携）」，数据固定放在 ~/Library/Application Support/MDZLauncher');
  }
  if (mode === dataMode) return { dataMode, versionsRoot, userData: userDataPath, needRestart: false };

  const posData = portableDataPath();
  const newRoot = resolveRoot(mode);
  let moved = 0;
  if (fs.existsSync(versionsRoot) && fs.readdirSync(versionsRoot).length > 0) {
    moved = core.copyDirRecursive(versionsRoot, newRoot);
  }
  fs.mkdirSync(newRoot, { recursive: true });

  // 数据目录（设置/存档/主题等 profile 数据）随模式走：
  //  → portable：系统 appdata → 便携目录；→ appdata：便携目录 → 系统 appdata
  const fromDir = (mode === 'portable') ? appdataDataPath() : userDataPath;
  const toDir = (mode === 'portable') ? posData : appdataDataPath();
  const cacheMoved = appPaths.migrateProfile(fromDir, toDir);

  // 配置写到目标数据目录（含 resolutions/keymaps），并维护便携标记
  const cfg = readConfig();
  cfg.dataMode = mode;
  fs.mkdirSync(toDir, { recursive: true });
  fs.writeFileSync(path.join(toDir, CONFIG_FILE), JSON.stringify(cfg, null, 2), 'utf8');
  if (mode === 'portable') fs.writeFileSync(portableMarkPath(), 'portable\n', 'utf8');
  else { try { fs.rmSync(portableMarkPath(), { force: true }); } catch (e) {} }

  dataMode = mode;
  versionsRoot = newRoot;
  userDataPath = (mode === 'portable') ? posData : appdataDataPath();
  return { dataMode, versionsRoot, userData: userDataPath, moved, cacheMoved, needRestart: true };
}

function getConfig() {
  const cfg = readConfig();
  return {
    dataMode,
    versionsRoot,
    userData: userDataPath,
    defaultUserData: realUserData,   // appdata 模式的根（%APPDATA%\MDZLauncher）
    dataDir: userDataPath,           // 当前生效的数据目录（<根>\data）
    portableData: portableDataPath(),
    portableMark: portableMarkPath(),
    resolutions: cfg.resolutions || {},
    lan: getLan()
  };
}

/** 读取某版本的固定分辨率（未设置返回 null，主进程回退 1024x768） */
function getResolution(id) {
  const cfg = readConfig();
  const r = (cfg.resolutions && cfg.resolutions[id]) || null;
  if (r && r.w && r.h) return { w: Math.round(r.w), h: Math.round(r.h) };
  return null;
}

/** 保存某版本的固定分辨率（限制在 320x240 ~ 7680x4320） */
function setResolution(id, res) {
  const w = Math.max(320, Math.min(7680, Math.round(Number(res && res.w) || 1024)));
  const h = Math.max(240, Math.min(4320, Math.round(Number(res && res.h) || 768)));
  const cfg = readConfig();
  cfg.resolutions = cfg.resolutions || {};
  cfg.resolutions[id] = { w, h };
  writeConfig(cfg);
  return { w, h };
}

/** 读取某版本的键盘映射（keymap） */
function getKeymap(id) {
  const cfg = readConfig();
  return (cfg.keymaps && cfg.keymaps[id]) || null;
}

/** 保存某版本的键盘映射 */
function saveKeymap(id, map) {
  const cfg = readConfig();
  cfg.keymaps = cfg.keymaps || {};
  cfg.keymaps[id] = (map && typeof map === 'object') ? map : {};
  writeConfig(cfg);
  return cfg.keymaps[id];
}

/** 供 CLI 在无 Electron 环境复用的路径解析 */
/* ===== v0.7.22：局域网/服务器设置 =====
   serverHost：服务器地址（空 = 本机）；可填 IP 或域名，也可带 http(s):// 前缀（会自动归一化）
   signalPort：信令服务器端口（默认 8787）
   httpPort  ：客户端分发服务端口（默认 8088）
   hostDir   ：建房程序目录（NW.js 包，含 nw.exe）；空 = 自动探测
   autoSignal/autoServe：启动器打开时自动拉起（默认关）
   playerName（v0.7.29）：多人版里的玩家名（客户端上游原本 prompt 输入，启动器里配置 → 注入 __mdzMpUser/?user=） */
const LAN_DEFAULTS = {
  serverHost: '',
  signalPort: 8787,
  httpPort: 8088,
  hostDir: '',
  autoSignal: false,
  autoServe: false,
  playerName: 'MiniPlayer'
};
function getLan() {
  const cfg = readConfig();
  return Object.assign({}, LAN_DEFAULTS, cfg.lan || {});
}
function setLan(patch) {
  const cfg = readConfig();
  const next = Object.assign({}, LAN_DEFAULTS, cfg.lan || {}, patch || {});
  next.signalPort = Math.max(1, Math.min(65535, Math.round(Number(next.signalPort) || LAN_DEFAULTS.signalPort)));
  next.httpPort = Math.max(1, Math.min(65535, Math.round(Number(next.httpPort) || LAN_DEFAULTS.httpPort)));
  next.serverHost = String(next.serverHost || '').trim();
  next.hostDir = String(next.hostDir || '').trim();
  next.playerName = String(next.playerName == null ? '' : next.playerName).trim().slice(0, 16) || 'MiniPlayer';
  cfg.lan = next;
  writeConfig(cfg);
  return next;
}
/** 归一化服务器主机名：去掉协议/路径/端口，只留 host */
function normalizeHost(h) {
  let s = String(h || '').trim();
  if (!s) return '';
  s = s.replace(/^[a-zA-Z]+:\/\//, '');
  s = s.split('/')[0];
  s = s.split(':')[0];
  return s;
}
/** 效果地址：信令（ws:// 或 wss://）与客户端分发页（http://） */
function lanEndpoints(lan) {
  const l = lan || getLan();
  const host = normalizeHost(l.serverHost);
  const isLocal = !host;
  return {
    host: host || '127.0.0.1',
    isLocal,
    signalUrl: (l.signalTls ? 'wss://' : 'ws://') + (host || '127.0.0.1') + ':' + l.signalPort,
    clientUrl: 'http://' + (host || '127.0.0.1') + ':' + l.httpPort + '/client/index.html'
  };
}

function resolveAppDataBase() {
  return path.join(process.env.APPDATA || '', APP_DATA_DIR);
}
function cliResolveRoot() {
  // v0.7.19：便携模式下 config.json 落在便携数据目录，两处都探一次
  const cands = [
    path.join(__dirname, '..', '..', 'MDZLauncher', CONFIG_FILE),  // dev/绿色包：工程或程序目录下的便携数据目录
    path.join(resolveAppDataBase(), CONFIG_FILE)                    // 系统 appdata
  ];
  for (const p of cands) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (cfg.dataMode === 'portable') return path.join(path.dirname(p), '..', 'versions');
      return path.join(resolveAppDataBase(), 'versions');
    } catch (e) { /* 继续探测 */ }
  }
  return path.join(resolveAppDataBase(), 'versions');
}

module.exports = {
  init,
  getVersionsRoot,
  getBuiltinRoots,
  isBuiltinVersion,
  listVersions,
  getVersion,
  inspectZip,
  importZip,
  removeVersion,
  setDataMode,
  getConfig,
  getResolution,
  setResolution,
  getKeymap,
  saveKeymap,
  getLan,
  setLan,
  normalizeHost,
  lanEndpoints,
  cliResolveRoot
};
