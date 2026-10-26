'use strict';
/**
 * lan-services.js —— v0.7.22 局域网/服务器能力（PC 启动器）
 *
 * 三件事，全部可单独启停，且都能「脱离启动器」独立使用（原始脚本/程序不受影响）：
 *   1) 信令服务器：直接 require 工具包的 signal-server/mdz-signal.js（进程内跑，用户不用装 Node）
 *   2) 客户端分发服务：require lan-host/serve.js（把内置的 minidayz-mp 版本以 http 分发给别人）
 *   3) 建房程序：写 host\signal.txt + 拉起 NW.js 的 nw.exe（服务端包，用户自备/一键解压到 host\）
 *
 * 脚本目录查找顺序：MDZ_LAN_DIR 环境变量 → <resources>/lan（打包随包）→ <app>/lan（开发）→ 工具包目录
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { normalizeHost } = require('./version-manager');
const mpPaths = require('./mp-paths');

let ctx = null;          // { versionManager, resourcesPath, appPath, onLog, onStatus }
let signalHandle = null; // mdz-signal 的 start() 返回值
let serveHandle = null;  // serve.js 的 start() 返回值
let hostProc = null;     // 建房程序子进程
const logs = [];         // 最近日志（给界面显示）

const KIT_FALLBACK = 'H:\\.Agent\\Web\\mdz-mp-lan';

/* macOS 移植：建房程序是 NW.js 的服务端包，mac 上可执行文件不是 nw.exe 而是
   nwjs.app/Contents/MacOS/nwjs（官方 osx 构建）——这里统一按平台找可执行文件。 */
const IS_MAC = process.platform === 'darwin';
const HOST_BIN_CANDIDATES = IS_MAC
  ? ['nwjs.app/Contents/MacOS/nwjs', 'nwjs.app/Contents/MacOS/nw', 'nw']
  : ['nw.exe'];

function log(msg) {
  const line = '[' + new Date().toTimeString().slice(0, 8) + '] ' + msg;
  logs.push(line);
  if (logs.length > 200) logs.shift();
  try { if (ctx && ctx.onLog) ctx.onLog(line); } catch (e) {}
  try { console.log('[lan] ' + msg); } catch (e) {}
}

/** 把可能带协议/端口/路径的地址归一化成 host（与 version-manager.normalizeHost 同一实现） */
const hostOnly = normalizeHost;

/** 收集候选目录（忽略空值；p 是懒计算的路径，避免 ctx 未就绪时报错） */
function collectDirs(getters) {
  const out = [];
  for (const get of getters) {
    try {
      const dir = get();
      if (dir) out.push(dir);
    } catch (e) { /* 跳过无效候选 */ }
  }
  return out;
}

/** 工具包脚本目录（含 signal-server/ lan-host/ game-patch/） */
function resolveLanDir() {
  const cands = collectDirs([
    () => process.env.MDZ_LAN_DIR,
    () => ctx && ctx.resourcesPath && path.join(ctx.resourcesPath, 'lan'),
    () => ctx && ctx.appPath && path.join(ctx.appPath, 'lan'),
    () => KIT_FALLBACK
  ]);
  for (const d of cands) {
    try {
      if (fs.existsSync(path.join(d, 'signal-server', 'mdz-signal.js')) &&
          fs.existsSync(path.join(d, 'lan-host', 'serve.js'))) return path.resolve(d);
    } catch (e) {}
  }
  return '';
}

/** 多人版客户端目录（分发/本地播放用的那份；候选顺序见 mp-paths） */
function builtinMpDir() {
  return mpPaths.findClientDir({
    resourcesPath: ctx && ctx.resourcesPath,
    appPath: ctx && ctx.appPath,
    versionsRoot: (ctx && ctx.versionManager && ctx.versionManager.getVersionsRoot()) || '',
    includeUserData: true
  });
}

/** 建房程序目录（含 NW.js 可执行文件：Windows = nw.exe，macOS = nwjs.app/Contents/MacOS/nwjs） */
function resolveHostDir() {
  const lan = ctx.versionManager.getLan();
  const lanDir = resolveLanDir();
  const cands = collectDirs([
    () => lan.hostDir,
    () => ctx.resourcesPath && path.join(ctx.resourcesPath, 'host'),  // v0.7.26：随包自带
    () => ctx.appPath && path.join(ctx.appPath, 'host'),
    () => lanDir && path.join(lanDir, 'host'),
    () => path.join(KIT_FALLBACK, 'host')
  ]);
  for (const d of cands) {
    try {
      if (HOST_BIN_CANDIDATES.some((b) => fs.existsSync(path.join(d, b)))) return path.resolve(d);
    } catch (e) {}
  }
  return '';
}

/** 建房程序可执行文件（按平台） */
function resolveHostBin(dir) {
  for (const b of HOST_BIN_CANDIDATES) {
    const f = path.join(dir, b);
    try { if (fs.existsSync(f)) return f; } catch (e) {}
  }
  return path.join(dir, HOST_BIN_CANDIDATES[0]);
}

/** 生效地址：信令（ws/wss）与客户端分发页（http） */
function endpoints() {
  const lan = ctx.versionManager.getLan();
  const host = hostOnly(lan.serverHost);
  return {
    host: host || '127.0.0.1',
    isLocal: !host,
    signalUrl: 'ws://' + (host || '127.0.0.1') + ':' + lan.signalPort,
    clientUrl: 'http://' + (host || '127.0.0.1') + ':' + lan.httpPort + '/client/index.html',
    signalPort: lan.signalPort,
    httpPort: lan.httpPort
  };
}

/* ---------------- 信令服务器 ---------------- */
function startSignal() {
  if (signalHandle) return status();
  const ld = resolveLanDir();
  if (!ld) { log('✗ 找不到信令服务器脚本（signal-server/mdz-signal.js）'); return status(); }
  const lan = ctx.versionManager.getLan();
  try {
    const mod = require(path.join(ld, 'signal-server', 'mdz-signal.js'));
    signalHandle = mod.start({
      host: '0.0.0.0',
      port: lan.signalPort,
      iceServers: [],
      verbose: false,
      onLog: (s) => {
        log('[信令] ' + s);
        /* v0.7.27：登录/建房/加入/断开等关键事件 → 立刻把新状态推给界面
           （否则「联机配置」页的在线人数/房间数要等下一次交互才刷新，看着像 0） */
        if (/登录|创建房间|加入房间|断开|离开/.test(String(s))) {
          try { if (ctx && ctx.onStatus) ctx.onStatus(status()); } catch (e) {}
        }
      }
    });
    signalHandle.server.on('listening', () => log('✓ 信令服务器已启动：0.0.0.0:' + lan.signalPort));
    signalHandle.server.on('error', (e) => { log('✗ 信令服务器端口占用或出错：' + e.message); try { signalHandle = null; } catch (e2) {} });
  } catch (e) {
    log('✗ 启动信令服务器失败：' + e.message);
    signalHandle = null;
  }
  return status();
}

function stopSignal() {
  if (!signalHandle) return status();
  try { signalHandle.stop(); } catch (e) {}
  signalHandle = null;
  log('已停止信令服务器');
  return status();
}

/* ---------------- 客户端分发服务 ---------------- */
function startServe() {
  if (serveHandle) return status();
  const ld = resolveLanDir();
  if (!ld) { log('✗ 找不到分发服务脚本（lan-host/serve.js）'); return status(); }
  const gameDir = builtinMpDir();
  if (!gameDir) { log('✗ 找不到内置多人版目录（client/index.html）'); return status(); }
  const lan = ctx.versionManager.getLan();
  try {
    const mod = require(path.join(ld, 'lan-host', 'serve.js'));
    serveHandle = mod.start({
      gameDir,
      port: lan.httpPort,
      signal: 'ws://auto:' + lan.signalPort,   // 自适应：玩家用哪个地址进来就连哪台的信令
      quiet: true,
      onLog: (s) => log('[分发] ' + s)
    });
  } catch (e) {
    log('✗ 启动分发服务失败：' + e.message);
    serveHandle = null;
  }
  return status();
}

function stopServe() {
  if (!serveHandle) return status();
  try { serveHandle.close(); } catch (e) {}
  serveHandle = null;
  log('已停止分发服务');
  return status();
}

/* ---------------- 本地多人客户端（v0.7.26）----------------
   PC 的多人客户端**本地启动**：启动器自己在 127.0.0.1 上用一个临时端口把 resources\mp-client 发出来
   （http://127.0.0.1 被浏览器视为可信来源 → 页面里连 ws:// 不受混合内容限制，也不需要安全开关），
   信令地址由设置里的 IP/端口注入。这样它和 PC 单机版一样是"本地版本"，不依赖局域网分发服务是否开着。
   局域网分发（8088）仍保留，用于把客户端发给别人。 */
let localClient = null;      // { handle, port, url, signal }
let localClientPend = null;  // Promise
let localPort = 0;

function ensureLocalClient() {
  if (localClient && localClient.handle) return Promise.resolve(localClient);
  if (localClientPend) return localClientPend;
  const ld = resolveLanDir();
  const gameDir = builtinMpDir();
  if (!ld || !gameDir) return Promise.resolve(null);
  const lan = ctx.versionManager.getLan();
  const host = hostOnly(lan.serverHost) || '127.0.0.1';
  const signal = 'ws://' + host + ':' + lan.signalPort;
  localClientPend = new Promise((resolve) => {
    try {
      const mod = require(path.join(ld, 'lan-host', 'serve.js'));
      const handle = mod.start({
        gameDir,
        port: localPort || 0,              // 0 = 系统分配；记住上次的端口复用
        host: '127.0.0.1',
        signal,
        quiet: true,
        onLog: (s) => log('[本地客户端] ' + s),
        onReady: (info) => {
          localPort = info.port;
          localClient = { handle, port: info.port, url: 'http://127.0.0.1:' + info.port + '/client/index.html', signal };
          log('✓ 本地多人客户端已就绪：' + localClient.url + '（信令 ' + signal + '）');
          resolve(localClient);
        }
      });
      /* serve.js 的 listen 回调会带 onReady；这里兜底超时 */
      setTimeout(() => { if (!localClient) { localClientPend = null; resolve(null); } }, 4000);
    } catch (e) {
      log('✗ 本地多人客户端启动失败：' + e.message);
      localClientPend = null;
      resolve(null);
    }
  });
  return localClientPend;
}

/** 信令地址变了 → 重启本地客户端服务（注入的地址要跟着变） */
function restartLocalClient() {
  try { if (localClient && localClient.handle) localClient.handle.close(); } catch (e) {}
  localClient = null; localClientPend = null;
  return ensureLocalClient();
}

/* ---------------- 建房程序（NW.js 服务端包） ---------------- */
function startHost() {
  if (hostProc && !hostProc.killed) return status();
  const dir = resolveHostDir();
  if (!dir) {
    log(IS_MAC
      ? '✗ 找不到建房程序（host/nwjs.app/Contents/MacOS/nwjs）——把 NW.js 的 osx 构建 + 服务端包解压到 host/，或用「选择…」指定'
      : '✗ 找不到建房程序（host\\nw.exe）——把 server-files 的 win64 包解压到该目录');
    return status();
  }
  const ep = endpoints();
  try {
    fs.writeFileSync(path.join(dir, 'signal.txt'), ep.signalUrl + '\r\n', 'utf8');
    hostProc = spawn(resolveHostBin(dir), ['--user-data-dir=' + path.join(dir, 'profile')], {
      cwd: dir, detached: false, stdio: 'ignore', windowsHide: false
    });
    hostProc.on('exit', (code) => { log('建房程序已退出（code=' + code + '）'); hostProc = null; try { if (ctx.onStatus) ctx.onStatus(status()); } catch (e) {} });
    log('✓ 已启动建房程序（信令 ' + ep.signalUrl + '）——在它的窗口里填服务器名 → 点 [Launch server] 建房');
  } catch (e) {
    log('✗ 启动建房程序失败：' + e.message);
    hostProc = null;
  }
  return status();
}

function stopHost() {
  if (!hostProc) return status();
  const pid = hostProc.pid;
  if (IS_MAC) { try { process.kill(-pid, 'SIGTERM'); } catch (e) { try { hostProc.kill('SIGTERM'); } catch (e2) {} } }
  else { try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (e) {} }
  hostProc = null;
  log('已停止建房程序');
  return status();
}

/** 随包的建房程序是否就位（resources/host 下有该平台的可执行文件） */
function hasBundledHost() {
  try {
    if (!ctx.resourcesPath) return false;
    const hostDir = path.join(ctx.resourcesPath, 'host');
    return HOST_BIN_CANDIDATES.some((b) => fs.existsSync(path.join(hostDir, b)));
  } catch (e) { return false; }
}

/* ---------------- 状态 ---------------- */
function status() {
  let sigStats = null;
  try { if (signalHandle && signalHandle.stats) sigStats = signalHandle.stats(); } catch (e) {}
  const lan = ctx.versionManager.getLan();
  // 目录解析要读文件系统，同一次 status 里只算一次
  const lanDir = resolveLanDir();
  const hostDir = resolveHostDir();
  return {
    lan,
    playerName: lan.playerName || 'MiniPlayer', // v0.7.29：多人版玩家名（注入给客户端）
    endpoints: endpoints(),
    lanDir,
    hostDir,
    builtinMp: builtinMpDir(),
    signal: {
      running: !!signalHandle,
      port: lan.signalPort,
      clients: sigStats ? sigStats.clients : 0,
      games: sigStats ? sigStats.games : []
    },
    serve: {
      running: !!serveHandle,
      port: lan.httpPort,
      urls: serveHandle ? serveHandle.urls() : []
    },
    client: {
      running: !!(localClient && localClient.handle),
      url: localClient ? localClient.url : '',
      signal: localClient ? localClient.signal : ''
    },
    host: {
      running: !!(hostProc && !hostProc.killed),
      bundled: hasBundledHost(),
      pid: (hostProc && !hostProc.killed) ? hostProc.pid : 0,
      dir: hostDir,
      exists: !!hostDir
    },
    logs: logs.slice(-40)
  };
}

function init(opts) {
  ctx = opts || {};
  log('局域网模块就绪：工具包 ' + (resolveLanDir() || '(未找到)') + '；内置多人版 ' + (builtinMpDir() || '(未找到)') + '；建房程序 ' + (resolveHostDir() || '(未找到)'));
  const lan = ctx.versionManager.getLan();
  if (lan.autoSignal) startSignal();
  if (lan.autoServe) startServe();
  return status();
}

function stopAll() {
  stopHost();
  stopServe();
  stopSignal();
  try { if (localClient && localClient.handle) localClient.handle.close(); } catch (e) { /* 忽略 */ }
  localClient = null;
  localClientPend = null;
}

module.exports = { init, status, startSignal, stopSignal, startServe, stopServe, startHost, stopHost, stopAll, endpoints, resolveLanDir, resolveHostDir, builtinMpDir, hostOnly, ensureLocalClient, restartLocalClient };
