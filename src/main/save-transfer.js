'use strict';
/**
 * PC 版「存档传输」服务管理（v1.0.1）。
 *
 * 与安卓端一一对应：那边是前台服务常驻（SaveBridgeService），这边是主进程常驻 ——
 * 同一套协议（GET /health、GET /saves、POST /save、GET /save/<id>、POST /delete、/ping.png、?cb= JSONP、
 * 表单 text/plain 上传兜底），服务实现就是 mdz-save-service.js（与「局域网联机/save-bridge」同一份文件）。
 *
 * 页面通过同步 IPC（ipcRenderer.sendSync）拿到和安卓端同形的返回值，所以两端页面代码几乎一模一样。
 */
const path = require('path');
const fs = require('fs');
const { SaveService } = require('./mdz-save-service');

let svc = null;
let dir = '';
let downloadsDir = '';
let onLog = null;
let lastError = '';

function log(line) { try { if (onLog) onLog(String(line)); } catch (e) {} }

/** 初始化（主进程 ready 后调用一次）：存档接收目录 + 下载目录（导出文件用） */
function init(opts) {
  const o = opts || {};
  dir = path.resolve(o.dir || path.join(process.cwd(), 'save-transfer'));
  downloadsDir = o.downloadsDir || '';
  onLog = typeof o.onLog === 'function' ? o.onLog : null;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return status();
}

function emptyStatus(extra) {
  return Object.assign({
    ok: true, running: false, port: 0, tokenRequired: false, saves: 0, dir: dir,
    urls: [], primaryUrl: '', startedAt: 0, reqCount: 0, lastReqAt: 0, lastReq: '', lastRequester: ''
  }, extra || {});
}

/** v1.0.4：只读目录用的服务实例（不 listen，只借它的 list()）——让「服务没启动也能看到已收到的存档」 */
let dirOnly = null;
function dirSvc() {
  if (svc) return svc;
  if (!dirOnly) { try { dirOnly = new SaveService({ port: 0, dir: dir, quiet: true, keep: 0 }); } catch (e) { dirOnly = null; } }
  return dirOnly;
}

/** 状态（字段与 Java 端 status() 同名：running/port/saves/primaryUrl/reqCount/lastReqAt/lastRequester/lastReq） */
function status() {
  if (svc) {
    const st = svc.stats();
    if (lastError) st.error = lastError;
    return st;
  }
  const st = emptyStatus();
  /* v1.0.4：服务没启动时也报出目录里已有多少份（用户要求「不启动服务也能看见」） */
  try { const d = dirSvc(); if (d) st.saves = d.list().length; } catch (e) {}
  if (lastError) st.error = lastError;
  return st;
}

function start(port, token) {
  const p = parseInt(port, 10) || 8090;
  if (svc) {
    /* 已在跑：端口/配对码变了就重启一次 */
    const samePort = (svc._realPort || svc.port) === p;
    const sameToken = String(svc.token || '') === String(token || '');
    if (samePort && sameToken) return status();
    stop();
  }
  lastError = '';
  try {
    svc = new SaveService({ port: p, token: String(token || ''), dir: dir, name: 'MDZ 启动器 · 存档传输' });
    svc.on('log', log);
    svc.on('error', (e) => { lastError = String((e && e.message) || e); });
    svc.start();
  } catch (e) {
    lastError = String((e && e.message) || e);
    try { if (svc) svc.close(); } catch (e2) {}
    svc = null;
  }
  return status();
}

function stop() {
  try { if (svc) svc.close(); } catch (e) {}
  svc = null;
  return emptyStatus({ ok: true });
}

/** 列表（返回 {ok, saves:[...]}，与 Java 端 list() 同形） */
function list() {
  try {
    const s0 = dirSvc();                                    // v1.0.4：服务没启动也读目录
    return { ok: true, dir: dir, urls: svc ? svc.urls() : [], saves: s0 ? s0.list() : [] };
  }
  catch (e) { return { ok: false, error: String((e && e.message) || e), saves: [] }; }
}

/** 取一份存档原文（与 Java 端 getFileJson 同形） */
function get(id) {
  if (!svc) {
    /* 服务没跑也允许取：直接读目录（用户可能只想导出文件） */
    const sid = String(id || '');
    if (!/^[A-Za-z0-9._-]+$/.test(sid)) return { ok: false, error: 'id 不合法' };
    try {
      const t = fs.readFileSync(path.join(dir, sid + '.json'), 'utf8');
      return { ok: true, id: sid, json: t };
    } catch (e) { return { ok: false, error: '没有这份存档' }; }
  }
  const t = svc.getJson(id);
  return t == null ? { ok: false, error: '没有这份存档' } : { ok: true, id: String(id), json: t };
}

function remove(id) {
  if (!svc) {
    const sid = String(id || '');
    if (!/^[A-Za-z0-9._-]+$/.test(sid)) return { ok: false, error: 'id 不合法' };
    try { fs.rmSync(path.join(dir, sid + '.json'), { force: true }); return { ok: true, deleted: sid }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  return svc.remove(id);
}

/** 把一份存档原文写成本地文件（默认 <下载>/MDZLauncher，与安卓端导出目录同名） */
function exportText(fileName, text) {
  try {
    const base = downloadsDir || process.cwd();
    const outDir = path.join(base, 'MDZLauncher');
    fs.mkdirSync(outDir, { recursive: true });
    const safe = String(fileName || 'mdz-save.json').replace(/[\\/:*?"<>|\r\n]+/g, '_');
    const out = path.join(outDir, safe);
    fs.writeFileSync(out, String(text == null ? '' : text), 'utf8');
    log('已导出文件：' + out);
    return out;
  } catch (e) {
    log('导出文件失败：' + ((e && e.message) || e));
    return false;
  }
}

module.exports = { init, status, start, stop, list, get, remove, exportText, dir: () => dir };
