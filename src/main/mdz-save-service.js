/* mdz-save-service.js —— MDZ「存档服务」（接收/分发手机直装包的存档）
 * ============================================================================
 * 用途：给注入到游戏 APK 里的 mdz-save-bridge.js 当接收端：
 *       手机游戏页 → POST /save  → 存成 json 文件（PC 启动器里可直接导入）
 *       PC 端把启动器导出的 json 丢进服务目录（或 POST 进来）→ 手机 GET /saves 列表 → GET /save/<id> 写回手机
 *
 * 设计目标：**零依赖**（只用 node 内置模块），方便直接搬进：
 *       · PC 启动器（Node 主进程）：require 本文件 → start({ port, dir, token, onSave })
 *       · 安卓启动器：WebView 里没有 Node，需要用 Java 照着同一套接口实现（协议就是下面 6 个路由，
 *         见文件末尾「接口清单」注释）；本文件可作为行为基准/对照测试用。
 *
 * 用法（模块）：
 *     const svc = require('./mdz-save-service').start({ port: 8090, token: '1234' });
 *     console.log(svc.urls());        // ['http://192.168.1.5:8090', ...]
 *     svc.on('save', (info) => {});   // 收到存档
 *     svc.close();
 * 用法（命令行测试程序）：见 serve-test.js
 *
 * 安全：默认只在局域网用。设了 token 后，/save*、/saves 都要带 ?token= 或 X-MDZ-Token 头。
 *       单文件上限 64MB；id 只允许 [A-Za-z0-9._-]，防止路径穿越。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const MAX_BODY = 64 * 1024 * 1024;         // 单次上传上限
const DEFAULT_PORT = 8090;
const KEEP = 200;                          // 目录里最多保留多少份（超出删最旧）
/* 1×1 透明 PNG：给「图片探测」用（某些游戏 WebView 拦 XHR，但 <img>/<script> 能过） */
const PING_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
/* JSONP 回调名必须净化，否则等于往页面注入任意脚本 */
function safeCb(s) { return String(s || '').replace(/[^A-Za-z0-9_.$]/g, '').slice(0, 64); }

/** 本机局域网 IPv4（给手机填的地址） */
/** v1.0.70：本机**默认路由出口 IP**——UDP connect 不发包，只让内核选出会用的源地址。
 *  手机与电脑在同一 Wi-Fi/路由器时，这个地址就是手机该填的那个，比按网段猜可靠得多。 */
function outboundIP() {
  let s = null;
  try {
    const dgram = require('dgram');
    s = dgram.createSocket('udp4');
    s.unref();                       // 关键：别让这个探针把进程的事件循环吊住（PC 主进程里会表现为退不出）
    s.connect(53, '8.8.8.8');
    return String((s.address() || {}).address || '');
  } catch (e) { return ''; }
  finally { try { if (s) s.close(); } catch (e) {} }
}

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach((name) => {
    (ifs[name] || []).forEach((it) => {
      if (!it || it.family !== 'IPv4' && it.family !== 4) return;
      if (it.internal) return;
      out.push({ name, address: it.address });
    });
  });
  /* v1.0.70：排序要**贴近用户实际能用的那个 IP**。原来只看网段（192.168 优先），
     结果装了 VirtualBox/VMware/WSL 的机器会把 192.168.56.1（VirtualBox 仅主机网卡）排到最前，
     用户在手机里填了根本连不上 → 「PC 启动器显示的 IP 和实际的不一样」。
     现在：虚拟网卡（名字或网段像虚拟机/容器/隧道）一律排到最后；物理网卡（Wi-Fi/以太网/WLAN）优先；
     169.254.x.x（自动私有地址，基本没用）也往后排。 */
  const VIRTUAL = /virtual|vmware|vbox|virtualbox|hyper-?v|vethernet|default switch|docker|wsl|loopback|bluetooth|tap|tun|zerotier|tailscale|radmin|hamachi|npcap|teredo|isatap|utun|bridge\d/i;
  const PHYSICAL = /wi-?fi|wlan|wireless|ethernet|以太网|无线|eth\d|en\d|enp|wlp|wl\d/i;
  const score = (x) => {
    if (x.outbound) return -1000;   // 默认路由出口 IP：手机该填的就是它，最高优先
    let v = 0;
    if (VIRTUAL.test(x.name) || /\(vEthernet|VirtualBox|VMware\)/i.test(x.name)) v += 1000;
    else if (PHYSICAL.test(x.name)) v -= 50;
    if (/wi-?fi|wlan|wireless|无线/i.test(x.name)) v -= 100;   // 手机在 Wi-Fi 上 → 无线网卡优先
    if (/^169\.254\./.test(x.address)) v += 500;
    if (/^192\.168\./.test(x.address)) v += 0;
    else if (/^10\./.test(x.address)) v += 1;
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(x.address)) v += 2;
    else v += 3;
    return v;
  };
  const ob = outboundIP();
  out.forEach((x) => { x.virtual = VIRTUAL.test(x.name); x.outbound = (!!ob && x.address === ob); });
  out.sort((a, b) => score(a) - score(b));
  return out;
}
function safeId(s) { return String(s || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120); }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function stamp(d) {
  d = d || new Date();
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}
function j(obj) { return JSON.stringify(obj); }

/** 从备份 JSON 里算个摘要（库/条目数/C2 状态），列表和日志都用它 */
function summarizeBackup(b) {  const out = { dbs: [], total: 0, c2: false, c2State: '', label: '', at: 0 };
  if (!b || !b.dbs) return out;
  out.at = Number(b._ts || 0) || 0;
  try { out.label = (b._mdzBridge && b._mdzBridge.label) || ''; } catch (e) {}
  Object.keys(b.dbs).forEach((dbName) => {
    let n = 0;
    const stores = b.dbs[dbName] || {};
    Object.keys(stores).forEach((sn) => { n += Object.keys((stores[sn] && stores[sn].data) || {}).length; });
    out.total += n;
    out.dbs.push(dbName + '(' + n + ')');
    if (dbName.indexOf('_C2SaveStates') === 0 || dbName.indexOf('C2SaveStates') === 0) out.c2 = true;
  });
  try {
    const c2key = Object.keys(b.dbs).filter((n) => n.indexOf('_C2SaveStates') === 0)[0];
    const saves = c2key && b.dbs[c2key].saves && b.dbs[c2key].saves.data;
    if (saves) {
      const ck = Object.keys(saves)[0];
      const rec = ck ? saves[ck] : null;
      if (rec && rec.data) {
        const d = JSON.parse(rec.data);
        let inst = 0;
        const types = d.types || {};
        Object.keys(types).forEach((t) => { if (types[t] && types[t].instances) inst += types[t].instances.length; });
        const rt = (d.rt && d.rt.time) || 0;
        out.c2State = (inst > 0 && rt > 0) ? ('对局中 ' + Math.round(rt) + 's/' + inst + '实例/槽' + (rec.slot || ck))
          : (rt === 0 ? ('主菜单（实例 ' + inst + '）') : '对局外');
      }
    }
  } catch (e) {}
  return out;
}

class SaveService extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.port = parseInt(o.port, 10) || DEFAULT_PORT;
    this.host = o.host || '0.0.0.0';
    this.dir = path.resolve(o.dir || path.join(__dirname, 'received'));
    this.token = String(o.token || '');
    this.name = o.name || 'MDZ 存档服务';
    this.quiet = !!o.quiet;
    this.keep = o.keep === 0 ? 0 : (parseInt(o.keep, 10) || KEEP);
    this._cache = new Map();     // id -> {mtime, size, summary}
    this._server = null;
    this._realPort = this.port;
    /* v1.0.69：请求计数 —— 和安卓端（SaveBridgeServer）同口径，「游戏那边到底有没有连上来」看这个 */
    this.reqCount = 0;
    this.lastReqAt = 0;
    this.lastReq = '';
    this.lastRequester = '';
    this.startedAt = 0;
    this.lastError = '';
    fs.mkdirSync(this.dir, { recursive: true });
  }

  log(...a) { if (!this.quiet) console.log('[save-svc]', ...a); this.emit('log', a.join(' ')); }

  /** 局域网访问地址 */
  urls() {
    const p = this._realPort || this.port;
    const list = lanIPs().map((x) => 'http://' + x.address + ':' + p);
    list.push('http://127.0.0.1:' + p);
    return list;
  }
  /** 给手机填的推荐地址（第一个局域网地址） */
  primaryUrl() {
    const p = this._realPort || this.port;
    const ip = lanIPs()[0];
    return 'http://' + (ip ? ip.address : '127.0.0.1') + ':' + p;
  }

  _authOk(req, u) {
    if (!this.token) return true;
    const q = u.searchParams.get('token');
    const h = req.headers['x-mdz-token'];
    return (q && q === this.token) || (h && h === this.token);
  }

  /** v1.0.69：状态/计数（给 PC 启动器「存档传输」页显示；与 Java 端 status() 字段同名） */
  stats() {
    return {
      ok: !!this._server,
      running: !!this._server,
      port: this._realPort || this.port,
      tokenRequired: !!this.token,
      dir: this.dir,
      saves: this.list().length,
      urls: this.urls(),
      primaryUrl: this.primaryUrl(),
      startedAt: this.startedAt,
      reqCount: this.reqCount,
      lastReqAt: this.lastReqAt,
      lastReq: this.lastReq,
      lastRequester: this.lastRequester,
      error: this.lastError || undefined
    };
  }
  /** v1.0.69：取一份存档原文（与 Java 端 getFileJson 对应）；id 只允许 [A-Za-z0-9._-]，防路径穿越 */
  getJson(id) {
    const sid = String(id || '');
    if (!/^[A-Za-z0-9._-]+$/.test(sid)) return null;
    try { return fs.readFileSync(path.join(this.dir, sid + '.json'), 'utf8'); } catch (e) { return null; }
  }
  /** v1.0.69：删除一份（与 Java 端 delete 对应） */
  remove(id) {
    const sid = String(id || '');
    if (!/^[A-Za-z0-9._-]+$/.test(sid)) return { ok: false, error: 'id 不合法' };
    try { fs.rmSync(path.join(this.dir, sid + '.json'), { force: true }); this._cache.delete(sid); this.log('删除存档 ' + sid + '.json'); return { ok: true, deleted: sid }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  }

  /** 目录里所有存档（含用户直接丢进来的 json） */
  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((f) => /\.json$/i.test(f)); } catch (e) { return []; }
    const out = [];
    for (const f of names) {
      const full = path.join(this.dir, f);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      const id = f.replace(/\.json$/i, '');
      let rec = this._cache.get(id);
      if (!rec || rec.mtime !== st.mtimeMs || rec.size !== st.size) {
        let summary = null;
        try {
          const data = JSON.parse(fs.readFileSync(full, 'utf8'));
          const s = summarizeBackup(data);
          summary = {
            dbs: s.dbs.join(' + '), total: s.total, c2: s.c2, c2State: s.c2State,
            label: (data._mdzBridge && data._mdzBridge.label) || '', ts: s.at, dbKey: data._dbKey || '',
            srcPlatform: data._srcPlatform || ''
          };
        } catch (e) { summary = { broken: true, why: String(e.message || e).slice(0, 120) }; }
        rec = { mtime: st.mtimeMs, size: st.size, summary };
        this._cache.set(id, rec);
      }
      const s = rec.summary || {};
      out.push({
        id,
        name: (s.label || '') + (s.c2State ? ' · ' + s.c2State : '') || id,
        at: Number(s.ts || 0) || Math.round(st.mtimeMs),
        bytes: st.size,
        summary: s.broken ? ('文件有问题：' + s.why) : (s.dbs + ' · 共 ' + s.total + ' 条'),
        dbKey: s.dbKey || '',
        url: '/save/' + encodeURIComponent(id) + '?download=1'
      });
    }
    out.sort((a, b) => (b.at || 0) - (a.at || 0));
    return out;
  }

  _prune() {
    if (!this.keep) return;
    const files = this.list().map((x) => path.join(this.dir, x.id + '.json'));
    if (files.length <= this.keep) return;
    const withTime = files.map((f) => { try { return { f, t: fs.statSync(f).mtimeMs }; } catch (e) { return null; } }).filter(Boolean);
    withTime.sort((a, b) => a.t - b.t);
    for (let i = 0; i < withTime.length - this.keep; i++) {
      try { fs.rmSync(withTime[i].f, { force: true }); this.log('超出保留数，删除旧存档 ' + path.basename(withTime[i].f)); } catch (e) {}
    }
  }

  /** 存一份（body 是文本 JSON）→ 返回列表项 */
  store(text, label) {
    /* 兼容「表单通道」：<form enctype="text/plain"> 发出来的是 `mdz=<原文>\r\n`
       —— 这条通道用来绕开「游戏 WebView 拦 XHR」的情况（file:// 页面常见），服务端要能吃它。 */
    let raw = String(text == null ? '' : text);
    if (raw.indexOf('mdz=') === 0) raw = raw.slice(4).replace(/\r?\n$/, '');
    const data = JSON.parse(raw);                       // 解析失败直接抛，由调用方回 400
    if (!data || data._c2 !== true || !data.dbs) throw new Error('不是 C2 存档（缺少 _c2/dbs）');
    const s = summarizeBackup(data);
    const base = safeId(label || (data._mdzBridge && data._mdzBridge.label) || 'save');
    const id = stamp() + '-' + base + '-' + crypto.randomBytes(2).toString('hex');
    const file = path.join(this.dir, id + '.json');
    fs.writeFileSync(file, raw, 'utf8');
    this._cache.delete(id);
    const info = {
      id, file, bytes: Buffer.byteLength(raw), summary: s.dbs.join(' + ') + ' · 共 ' + s.total + ' 条',
      c2State: s.c2State, total: s.total, dbs: s.dbs, label: base, at: Date.now()
    };
    this._prune();
    this.log('收到存档 ' + id + '.json（' + (info.bytes / 1024).toFixed(1) + 'KB · ' + info.summary + (s.c2State ? ' · ' + s.c2State : '') + '）');
    this.emit('save', info);
    return info;
  }

  _json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'cache-control': 'no-store'
    });
    res.end(body);
  }
  /** JSONP 版（?cb=fn）：某些游戏 WebView 拦 XHR/fetch，但 <script src> 不受 CORS 限制 */
  _jsonp(res, code, obj, cb) {
    const fn = safeCb(cb);
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    res.writeHead(code, {
      'content-type': 'application/javascript; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    });
    res.end(fn ? ('/**/typeof ' + fn + '==="function"&&' + fn + '(' + text + ');') : text);
  }
  _png(res) {
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': PING_PNG.length,
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    });
    res.end(PING_PNG);
  }
  _text(res, code, s, type) {
    res.writeHead(code, {
      'content-type': (type || 'text/plain') + '; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    });
    res.end(s);
  }

  page() {
    const urls = this.urls();
    const list = this.list();
    const rows = list.map((x) =>
      '<tr><td>' + esc(x.id) + '</td><td>' + esc(x.summary) + '</td><td>' + (x.bytes / 1024).toFixed(1) + 'KB</td>' +
      '<td>' + new Date(x.at).toLocaleString() + '</td>' +
      '<td><a href="/save/' + encodeURIComponent(x.id) + '?download=1' + (this.token ? '&token=' + encodeURIComponent(this.token) : '') + '">下载</a> ' +
      '<a href="/del/' + encodeURIComponent(x.id) + '?token=' + encodeURIComponent(this.token) + '">删除</a></td></tr>').join('');
    return '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + esc(this.name) + '</title><style>body{font:14px/1.6 -apple-system,Roboto,sans-serif;margin:24px;color:#1b232b}' +
      'code{background:#f1f4f7;padding:2px 6px;border-radius:6px}table{border-collapse:collapse;margin-top:8px}td,th{border-bottom:1px solid #e3e8ee;padding:6px 10px;text-align:left;font-size:13px}' +
      '.u{font-size:18px;font-weight:600}</style>' +
      '<h2>' + esc(this.name) + ' 运行中</h2>' +
      '<p>手机（游戏里的「MDZ 存档桥」）填这个地址：</p><p class="u"><code>' + esc(this.primaryUrl()) + '</code></p>' +
      '<p>全部地址：' + urls.map((u) => '<code>' + esc(u) + '</code>').join(' ') + '</p>' +
      (this.token ? '<p>配对码：<code>' + esc(this.token) + '</code></p>' : '<p>未设配对码（谁都能连，建议设一个）</p>') +
      '<p>存档目录：<code>' + esc(this.dir) + '</code>（把启动器导出的 json 丢进来，手机上就能「接收」）</p>' +
      '<h3>存档（' + list.length + '）</h3><table><tr><th>id</th><th>内容</th><th>大小</th><th>时间</th><th></th></tr>' + rows + '</table>' +
      '</html>';
  }

  _readBody(req, cb) {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { cb(new Error('too large')); try { req.destroy(); } catch (e) {} return; }
      chunks.push(c);
    });
    req.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (e) => cb(e));
  }

  handler() {
    return (req, res) => {
      let u;
      try { u = new URL(req.url, 'http://x'); } catch (e) { return this._text(res, 400, 'bad url'); }
      const p = decodeURIComponent(u.pathname);
      const cb = u.searchParams.get('cb');   // ?cb=fn → JSONP（绕开被拦的 XHR）
      /* v1.0.69：先记账再处理 —— 只要请求到达就计数（含来源 IP），这是「有没有连上来」的证据 */
      this.reqCount++;
      this.lastReqAt = Date.now();
      this.lastReq = req.method + ' ' + p;
      this.lastRequester = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
      this.log('收到请求 #' + this.reqCount + '：' + this.lastReq + (this.lastRequester ? '　来自 ' + this.lastRequester : ''));
      if (req.method === 'OPTIONS') {                                   // 预检（用 application/json 时会被触发）
        res.writeHead(204, {
          'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-max-age': '600'
        });
        return res.end();
      }
      if (p === '/' ) return this._text(res, 200, this.page(), 'text/html');
      if (p === '/ping.png') return this._png(res);   // 图片探测（<img> 不受 CORS 限制）
      if (p === '/health') {
        const h = {
          ok: true, name: this.name, dir: this.dir, tokenRequired: !!this.token,
          saves: this.list().length, urls: this.urls(), at: Date.now(),
          /* v1.0.69：与 Java 端同名字段（游戏端诊断会显示） */
          port: this._realPort || this.port, primaryUrl: this.primaryUrl(),
          startedAt: this.startedAt, reqCount: this.reqCount,
          lastReqAt: this.lastReqAt, lastReq: this.lastReq, lastRequester: this.lastRequester
        };
        return cb ? this._jsonp(res, 200, h, cb) : this._json(res, 200, h);
      }
      const needAuth = /^\/(saves|save|del)(\/|$)/.test(p);
      if (needAuth && !this._authOk(req, u)) return this._json(res, 403, { ok: false, error: '配对码不对（token）' });

      if (p === '/saves' && req.method === 'GET') {
        const l = { ok: true, dir: this.dir, urls: this.urls(), saves: this.list() };
        return cb ? this._jsonp(res, 200, l, cb) : this._json(res, 200, l);
      }
      if (p === '/save' && req.method === 'POST') {
        return this._readBody(req, (err, text) => {
          if (err) return this._json(res, 413, { ok: false, error: '存档太大或读取失败: ' + err.message });
          let info;
          try { info = this.store(text, u.searchParams.get('name')); }
          catch (e) { this.log('上传被拒: ' + e.message); return this._json(res, 400, { ok: false, error: String(e.message) }); }
          this._json(res, 200, { ok: true, id: info.id, bytes: info.bytes, summary: info.summary, c2State: info.c2State });
        });
      }
      if (p.indexOf('/save/') === 0 && req.method === 'GET') {
        const id = safeId(p.slice('/save/'.length).replace(/\.json$/i, ''));
        const file = path.join(this.dir, id + '.json');
        if (!file.startsWith(this.dir) || !fs.existsSync(file)) return this._json(res, 404, { ok: false, error: '没有这份存档: ' + id });
        const body = fs.readFileSync(file);
        if (cb) return this._jsonp(res, 200, body.toString('utf8'), cb);   // JSONP：直接把它当函数参数吐出去
        const dl = u.searchParams.get('download') === '1';
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': body.length,
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
          ...(dl ? { 'content-disposition': 'attachment; filename="' + id + '.json"' } : {})
        });
        return res.end(body);
      }
      if (p.indexOf('/del/') === 0) {                                    // 浏览器页面的「删除」也用 GET（局域网小工具）
        const id = safeId(p.slice('/del/'.length).replace(/\.json$/i, ''));
        const file = path.join(this.dir, id + '.json');
        if (!file.startsWith(this.dir) || !fs.existsSync(file)) return this._json(res, 404, { ok: false, error: '没有这份存档' });
        try { fs.rmSync(file, { force: true }); this._cache.delete(id); this.log('删除 ' + id + '.json'); } catch (e) {}
        res.writeHead(302, { location: '/' + (this.token ? '?token=' + encodeURIComponent(this.token) : '') });
        return res.end();
      }
      if (p === '/delete' && req.method === 'POST') {
        return this._readBody(req, (err, text) => {
          if (err) return this._json(res, 400, { ok: false, error: err.message });
          let id = '';
          try { id = safeId((JSON.parse(text) || {}).id || u.searchParams.get('id') || ''); } catch (e) { id = safeId(u.searchParams.get('id') || ''); }
          const file = path.join(this.dir, id + '.json');
          if (!id || !file.startsWith(this.dir) || !fs.existsSync(file)) return this._json(res, 404, { ok: false, error: '没有这份存档' });
          try { fs.rmSync(file, { force: true }); this._cache.delete(id); } catch (e) {}
          return this._json(res, 200, { ok: true, deleted: id });
        });
      }
      return this._json(res, 404, { ok: false, error: 'unknown: ' + req.method + ' ' + p });
    };
  }

  start(cb) {
    this._server = http.createServer(this.handler());
    this._server.on('error', (e) => { this.lastError = String(e.message || e); this.log('服务错误: ' + e.message); this.emit('error', e); });
    this._server.listen(this.port, this.host, () => {
      this._realPort = (this._server.address() && this._server.address().port) || this.port;
      this.startedAt = Date.now(); this.lastError = '';
      this.reqCount = 0; this.lastReqAt = 0; this.lastReq = ''; this.lastRequester = '';
      this.log(this.name + ' 已启动 → ' + this.primaryUrl() + (this.token ? '　配对码 ' + this.token : '　（未设配对码）'));
      this.log('存档目录：' + this.dir);
      if (cb) cb(this);
      this.emit('ready', this);
    });
    return this;
  }
  close(cb) {
    if (!this._server) { if (cb) cb(); return; }
    const done = () => { this._server = null; if (cb) cb(); };
    try { this._server.close(done); } catch (e) { done(); }
  }
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function start(opts) { return new SaveService(opts).start(); }

module.exports = { start, SaveService, lanIPs, outboundIP, summarizeBackup, DEFAULT_PORT, MAX_BODY };

/* ---------------------------------------------------------------------------
 * 接口清单（安卓启动器用 Java 实现时照这个来；返回都是 JSON，全部带 CORS 头）
 *   GET  /                → HTML 状态页（地址 + 存档列表 + 下载/删除）
 *   GET  /health          → {ok,name,dir,tokenRequired,saves,urls,at}
 *   GET  /saves           → {ok,dir,urls,saves:[{id,name,at,bytes,summary,dbKey,url}]}
 *   POST /save?name=xxx    body = 存档 JSON 文本（text/plain 或 application/json）
 *                          → 200 {ok,id,bytes,summary,c2State} / 400 不是 C2 存档 / 413 太大
 *   GET  /save/<id>       → 存档 JSON（?download=1 加 Content-Disposition）
 *   POST /delete {id}     → {ok,deleted}
 *   鉴权：设了 token 时，/save、/save/<id>、/saves、/del、/delete 都要 ?token= 或 X-MDZ-Token
 *   上限：单文件 64MB；目录保留最近 200 份
 * ------------------------------------------------------------------------- */
