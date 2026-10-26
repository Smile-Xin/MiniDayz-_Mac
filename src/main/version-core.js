'use strict';
/**
 * 版本核心逻辑（纯 Node，不依赖 Electron）：
 * - zip 检查 / 安全解压
 * - index.html 注入（存档隔离补丁 + SW 屏蔽）
 * - version.json 清单读写
 * - 版本目录扫描
 * 供主进程 version-manager 与 CLI 脚本共用。
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024; // 2GB
const MAX_ENTRIES = 50000;
const INJECT_MARK = 'MDZ_LAUNCHER_INJECT';
const META_CANDIDATES = ['metadata/config.json', 'metadata/metadata.json', 'metadata.json'];

// ---------- 工具 ----------

function sanitizeId(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/[^A-Za-z0-9_-]/g, '_');
  s = s.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'game';
}

function defaultDbKey(id) {
  return 'version_' + id;
}

/** v1.0.15：dbKey 统一净化（与前端 dbKeyOf / 壳页 mdzIsolate / 协议补丁同规则）——
 *  带 [^A-Za-z0-9_-] 的 dbKey 会让"落盘补丁烘的库名"和"启动器查找的库名"分叉（存档页永远 0 条）。 */
function normDbKey(raw, id) {
  const k = String(raw == null ? '' : raw).replace(/[^A-Za-z0-9_-]/g, '');
  if (k) return k;
  const byId = String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '');
  return byId ? ('version_' + byId) : 'version_default';
}

function normEntry(name) {
  return String(name).replace(/\\/g, '/').replace(/^\.\//, '');
}

function decodeSeg(seg) {
  try { return decodeURIComponent(seg); } catch (e) { return seg; }
}

// ---------- metadata 元数据 ----------

/** 从已解压目录读取 metadata/config.json（或 metadata.json） */
function readMetaFromDir(dir) {
  for (const rel of META_CANDIDATES) {
    const f = path.join(dir, rel);
    if (fs.existsSync(f)) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* 忽略损坏 */ }
    }
  }
  return null;
}

/** 从 zip 条目中读取 metadata 配置（兼容顶层单目录结构） */
function readMetaFromZip(zip, singleTop) {
  const want = new Set(META_CANDIDATES);
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const clean = normEntry(e.entryName);
    const rootName = singleTop && clean.startsWith(singleTop + '/') ? clean.slice(singleTop.length + 1) : clean;
    if (want.has(rootName)) {
      try { return JSON.parse(e.getData().toString('utf8')); } catch (err) { /* 忽略损坏 */ }
    }
  }
  return null;
}

// ---------- zip 检查 ----------

function inspectZip(zipPath) {
  if (!fs.existsSync(zipPath)) throw new Error('文件不存在: ' + zipPath);
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const files = entries.filter((e) => !e.isDirectory);
  const topLevels = new Set();
  let totalSize = 0;
  for (const e of files) {
    const clean = normEntry(e.entryName);
    totalSize += e.header.size || 0;
    const first = clean.split('/')[0];
    if (first && first !== '.') topLevels.add(first);
  }
  // v0.6.1：识别「套一层文件夹」的 zip——根目录无 index.html 时，
  // 找唯一含 index.html（或 version.json）的顶层目录作为版本根（不再要求顶层只有这一个目录，
  // 兼容 __MACOSX 等杂项并存；多个候选目录则无法确定 → 保持 null → 导入报缺入口）
  let singleTop = null;
  const rootHasIndex = files.some((e) => normEntry(e.entryName) === 'index.html');
  if (!rootHasIndex) {
    const candTops = [...topLevels].filter((t) =>
      files.some((e) => {
        const c = normEntry(e.entryName);
        return c === t + '/index.html' || c === t + '/version.json';
      })
    );
    if (candTops.length === 1) singleTop = candTops[0];
  }
  const at = (name) => files.some((e) => {
    const c = normEntry(e.entryName);
    return c === name || (singleTop && c === singleTop + '/' + name);
  });

  // v0.5.7：id 生成不再使用 zip 文件名（对齐安卓 v0.5.0——文件名不影响导入目录）：
  // 唯一顶层目录名优先；metadata.id / metadata.name 在下方覆盖/兜底；最后固定 'game'（重复导入走覆盖提示）
  let id = singleTop ? (sanitizeId(singleTop) || '') : '';

  const cand = {
    zipPath,
    id,
    name: id,
    dbKey: defaultDbKey(id),
    desc: '',
    author: '',
    version: '',
    series: '',
    cover: '',
    cardRatio: '',
    screenshots: [],
    download: '',
    entry: 'index.html',
    singleTop,                  // zip 顶层只有一个目录时为其名，否则 null（文件在根）
    hasVersionJson: at('version.json'),
    hasIndex: at('index.html'),
    hasMeta: false,
    meta: null,
    entryCount: files.length,
    totalSize
  };

  // 读取 metadata 配置并覆盖默认值（id/name/dbKey/desc/entry/icon/launch/cover/screenshots/version/series/author）
  const meta = readMetaFromZip(zip, singleTop);
  if (meta) {
    cand.meta = meta;
    cand.hasMeta = true;
    if (meta.id) cand.id = sanitizeId(meta.id) || cand.id;
    // v0.5.7：无顶层目录/无 metadata.id 时用 metadata.name 兜底（仍不用 zip 文件名）
    if (!cand.id && meta.name) cand.id = sanitizeId(meta.name) || '';
    if (meta.name) cand.name = meta.name;
    if (meta.dbKey) cand.dbKey = String(meta.dbKey);
    if (meta.desc) cand.desc = meta.desc;
    if (meta.author) cand.author = meta.author;
    if (meta.version) cand.version = String(meta.version);
    if (meta.series) cand.series = meta.series;
    if (meta.cover) cand.cover = String(meta.cover);
    if (meta.cardRatio) cand.cardRatio = String(meta.cardRatio);
    if (Array.isArray(meta.screenshots)) cand.screenshots = meta.screenshots.map(String);
    if (meta.download) cand.download = String(meta.download);
    if (meta.entry) cand.entry = meta.entry;
  }

  // v0.5.7：仍无 id（无顶层目录、无元数据）→ 固定 'game'（重复导入时走覆盖提示，不再用文件名生成）
  if (!cand.id) cand.id = 'game';
  cand.name = cand.name || cand.id;
  cand.dbKey = cand.dbKey || defaultDbKey(cand.id);

  return cand;
}

// ---------- 安全解压 ----------

function extractZip(zipPath, targetDir, singleTop) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) throw new Error('zip 条目过多（> ' + MAX_ENTRIES + '）');
  const root = path.resolve(targetDir);
  fs.mkdirSync(root, { recursive: true });
  let total = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    total += e.header.size || 0;
    if (total > MAX_TOTAL_SIZE) throw new Error('zip 解压后体积超限');

    const clean = normEntry(e.entryName);
    const rawSegs = clean.split('/');
    if (rawSegs.some((s) => s === '..')) throw new Error('zip 含非法路径(..): ' + e.entryName);
    let segs = rawSegs.map(decodeSeg).filter((s) => s && s !== '.');

    // v0.6.1：singleTop 识别后只解压版本根目录下的文件，跳过其他顶层项（__MACOSX/.DS_Store 等杂物不进版本目录）
    if (singleTop) {
      if (segs[0] !== singleTop) continue;
      segs.shift(); // 剥掉唯一顶层目录
    }
    if (segs.length === 0) continue;

    const target = path.join(root, ...segs);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('zip 路径越界: ' + e.entryName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.getData());
  }
  return root;
}

// ---------- index.html 注入 ----------

function buildInjectBlock(dbKey) {
  const key = normDbKey(dbKey, '');
  return `<script>
/* ${INJECT_MARK} v2 - 存档隔离（IndexedDB 库名 + localStorage 兜底键）+ SW 屏蔽（本地启动器注入，不影响线上部署） */
(function(){
  try {
    var versionId = "${key}";
    var suffix = "_" + versionId;
    var originalOpen = window.indexedDB.open.bind(window.indexedDB);
    window.indexedDB.open = function(name, version){
      if (name && typeof name === "string" && !name.endsWith(suffix)) {
        return originalOpen(name + suffix, version);
      }
      return originalOpen(name, version);
    };
  } catch(e){ console.warn("[launcher] isolation patch failed", e); }
})();
(function(){
  /* v1.0.15：C2 在 IndexedDB 不可用（iOS 常见）时把进度写 localStorage['__c2save_<槽位>']，
     这条通道此前完全没有隔离 → 各版本共用同一批键。__mdzLsnIso 幂等守卫（启动器侧再注入也无害）。 */
  try {
    if (window.__mdzLsnIso) return;
    var suffix2 = "_${key}", ls = window.localStorage;
    var gi = ls.getItem.bind(ls), si = ls.setItem.bind(ls), ri = ls.removeItem.bind(ls);
    var map = function(n){ return (typeof n === "string" && n.indexOf("__c2save_") === 0) ? n + suffix2 : n; };
    ls.getItem = function(n){ return gi(map(n)); };
    ls.setItem = function(n,v){ return si(map(n), v); };
    ls.removeItem = function(n){ return ri(map(n)); };
    window.__mdzLsnIso = true;
  } catch(e){}
})();
(function(){
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.register) {
      navigator.serviceWorker.register = function(){ return Promise.resolve({}); };
    }
  } catch(e){}
})();
</script>
`;
}

function patchIndexHtml(indexPath, dbKey) {
  let html = fs.readFileSync(indexPath, 'utf8');
  if (html.includes(INJECT_MARK)) return false; // 已注入过
  const block = buildInjectBlock(dbKey);
  const idx = html.indexOf('<script');
  if (idx !== -1) {
    html = html.slice(0, idx) + block + '\n' + html.slice(idx);
  } else {
    const headEnd = html.indexOf('</head>');
    if (headEnd !== -1) html = html.slice(0, headEnd) + block + '\n' + html.slice(headEnd);
    else html = block + html;
  }
  fs.writeFileSync(indexPath, html, 'utf8');
  return true;
}

// ---------- 清单 ----------

function writeVersionJson(dir, v) {
  const rec = {
    id: v.id,
    name: v.name || v.id,
    dbKey: v.dbKey || defaultDbKey(v.id),
    entry: v.entry || 'index.html',
    desc: v.desc || '',
    author: v.author || '',
    version: v.version || '',
    series: v.series || '',
    cover: v.cover || '',
    cardRatio: v.cardRatio || '',
    screenshots: Array.isArray(v.screenshots) ? v.screenshots : [],
    download: v.download || '',
    c2version: v.c2version || '',
    addedAt: v.addedAt || Date.now()
  };
  if (v.icon) rec.icon = v.icon;
  if (v.launch) rec.launch = v.launch;
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify(rec, null, 2), 'utf8');
}

function detectC2Version(dir) {
  try {
    const js = fs.readFileSync(path.join(dir, 'c2runtime.js'), 'utf8');
    const m = js.match(/c2version["']?\s*[:=]\s*["']?([^"',;\s]+)/i);
    return m ? m[1].slice(0, 40) : '';
  } catch (e) { return ''; }
}

function loadVersions(root, extraRoots) {
  const out = [];
  const seenIds = new Set();
  /* v0.7.44（用户要求：数据目录里不该再有一份重复的内置版）：内置版本不再复制进数据目录，
     而是把内置根（打包 = resources\versions；dev = <工程根>\versions）一并列出来；
     同名时数据目录优先（用户自己导入的同 ID 版本覆盖内置版）。 */
  const bases = [];
  if (root) bases.push({ base: root, builtin: false });
  for (const r of (extraRoots || [])) {
    if (!r) continue;
    let dup = false;
    for (const b of bases) { try { if (path.resolve(b.base) === path.resolve(r)) dup = true; } catch (e) { /* 忽略 */ } }
    if (!dup) bases.push({ base: r, builtin: true });
  }
  for (const item of bases) {
  const base = item.base;
  if (!base || !fs.existsSync(base)) continue;
  for (const name of fs.readdirSync(base)) {
    const dir = path.join(base, name);
    let st;
    try { st = fs.statSync(dir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    const vf = path.join(dir, 'version.json');
    let rec = null;
    if (fs.existsSync(vf)) {
      try { rec = JSON.parse(fs.readFileSync(vf, 'utf8')); } catch (e) { rec = null; }
    }
    if (!rec || !rec.id) {
      // v0.2.9：无 version.json 的解压目录也识别（目录即真相，与 web versions.php 一致）——
      // 有 index.html 即视为版本；id=metadata.id || 目录名；图标/封面/截图从 metadata 解析
      // v0.7.2：入口在子目录（metadata.entry 指向，如 minidayz-pc 的 v141/index.html）也识别——
      // versions.php 本来就扫任意 metadata 子目录，这里对齐；无 index.html 且无有效 entry 才跳过
      const meta = readMetaFromDir(dir) || {};
      let entryPath = null;
      const metaEntry = meta.entry || 'index.html';
      if (fs.existsSync(path.join(dir, 'index.html'))) entryPath = path.join(dir, 'index.html');
      else if (metaEntry && !String(metaEntry).split('/').some((s) => s === '..')) {
        const cand = path.join(dir, String(metaEntry));
        if (fs.existsSync(cand)) entryPath = cand;
      }
      if (!entryPath) continue;
      const rawId = sanitizeId(meta.id || name);
      const rawName = meta.name || meta.id || name;
      const dbKey = String(meta.dbKey || defaultDbKey(rawId));
      rec = {
        id: rawId,
        name: rawName,
        dbKey: dbKey,
        entry: meta.entry || 'index.html',
        desc: meta.desc || '',
        author: meta.author || '',
        version: String(meta.version || ''),
        series: meta.series || '',
        cardRatio: meta.cardRatio || '',
        download: meta.download || '',
        addedAt: Date.now(),
        _dir: dir
      };
      rec.cover = resolveCover(dir, meta.cover) || '';
      const shots = (Array.isArray(meta.screenshots) ? meta.screenshots : []).map(String).filter(Boolean);
      rec.screenshots = shots.length ? shots : scanScreenshots(dir);
      const icon = resolveIcon(dir, meta.icon) || (fs.existsSync(path.join(dir, 'icon-256.png')) ? 'icon-256.png' : null);
      if (icon) rec.icon = icon;
      if (meta.launch) rec.launch = meta.launch;
    }
    if (rec && rec.id) {
      if (item.builtin && seenIds.has(rec.id)) continue; // 内置版被数据目录里的同名版覆盖
      seenIds.add(rec.id);
      rec.dir = dir;
      if (item.builtin) rec.builtin = true;
      out.push(rec);
    }
  }
  }
  out.sort((a, b) => {
    // v0.6.1：按名称（缺省用 id）升序，名称相同按版本号（自然序）再排；与 web 端一致
    const na = String(a.name || a.id || '').toLowerCase();
    const nb = String(b.name || b.id || '').toLowerCase();
    const r = na.localeCompare(nb, undefined, { numeric: true, sensitivity: 'base' });
    if (r !== 0) return r;
    return String(a.version || '').localeCompare(String(b.version || ''), undefined, { numeric: true, sensitivity: 'base' });
  });
  return out;
}

// ---------- 导入 ----------

/** 解析图标实际路径（相对版本根目录）；优先 metadata/<icon>，其次根目录 */
function resolveIcon(dir, icon) {
  if (!icon) return null;
  const i = String(icon);
  for (const c of [path.join(dir, 'metadata', i), path.join(dir, i)]) {
    if (fs.existsSync(c)) return path.relative(dir, c).split(path.sep).join('/');
  }
  return null; // 找不到则回退 icon-256.png
}

/** 解析竖版封面路径（2:3）；优先 metadata/<cover>，其次根目录 */
function resolveCover(dir, cover) {
  if (!cover) return null;
  const c = String(cover);
  for (const p of [path.join(dir, 'metadata', c), path.join(dir, c)]) {
    if (fs.existsSync(p)) return path.relative(dir, p).split(path.sep).join('/');
  }
  return null;
}

/** 扫描 metadata/screenshots/ 目录下的截图（可选元数据；config 未声明 screenshots 时的回退） */
function scanScreenshots(dir) {
  const sdir = path.join(dir, 'metadata', 'screenshots');
  try {
    return fs.readdirSync(sdir)
      .filter((n) => /\.(png|jpe?g|webp|gif)$/i.test(n))
      .sort()
      .map((n) => path.relative(dir, path.join(sdir, n)).split(path.sep).join('/'));
  } catch (e) { return []; }
}

/**
 * 导入 zip 版本。
 * overrides：调用方显式指定的 {id,name,dbKey,desc,entry}（优先级最高）
 * 其次读取 zip 内 metadata 配置（metadata/config.json），最后回退 zip 文件名。
 * 版本图标/启动配置（icon/launch）来自 metadata，写入 version.json。
 */
function importZip(zipPath, overrides, root) {
  const cand = inspectZip(zipPath);
  const zipMeta = cand.meta || {};
  const o = overrides || {};
  const id = sanitizeId(o.id || zipMeta.id || cand.singleTop || path.basename(zipPath, path.extname(zipPath)));
  const dbKey = normDbKey((o.dbKey && String(o.dbKey).trim()) || zipMeta.dbKey || defaultDbKey(id), id);
  const target = path.join(root, id);
  if (fs.existsSync(target)) throw new Error('版本已存在: ' + id);

  const tmp = fs.mkdtempSync(path.join(root, '.import-'));
  try {
    extractZip(zipPath, tmp, cand.singleTop);
    const dirMeta = readMetaFromDir(tmp);
    const entry = String(o.entry || dirMeta.entry || zipMeta.entry || 'index.html');
    if (entry.split('/').some((s) => s === '..')) throw new Error('非法入口路径: ' + entry);
    const indexPath = path.join(tmp, entry);
    if (!fs.existsSync(indexPath)) throw new Error('缺少入口文件: ' + entry);
    patchIndexHtml(indexPath, dbKey);
    const c2version = detectC2Version(tmp);
    fs.renameSync(tmp, target);
    writeVersionJson(target, {
      id,
      name: o.name || dirMeta.name || zipMeta.name || id,
      dbKey,
      entry,
      desc: o.desc || dirMeta.desc || zipMeta.desc || '',
      author: o.author || dirMeta.author || zipMeta.author || '',
      version: o.version || dirMeta.version || zipMeta.version || '',
      series: o.series || dirMeta.series || zipMeta.series || '',
      cover: resolveCover(target, o.cover || dirMeta.cover || zipMeta.cover) || '',
      cardRatio: o.cardRatio || dirMeta.cardRatio || zipMeta.cardRatio || '',
      screenshots: pickScreenshots(o, dirMeta, zipMeta, target),
      download: o.download || dirMeta.download || zipMeta.download || '',
      c2version,
      icon: resolveIcon(target, dirMeta.icon || zipMeta.icon),
      launch: dirMeta.launch || zipMeta.launch || null,
      addedAt: Date.now()
    });
    return loadVersions(root).find((v) => v.id === id);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** screenshots 取值优先级：显式 config → 目录扫描 metadata/screenshots/ 回退；config 路径相对 metadata/ → 转相对版本根 */
function pickScreenshots(o, dirMeta, zipMeta, dir) {
  const arr = (Array.isArray(o.screenshots) ? o.screenshots
    : Array.isArray(dirMeta && dirMeta.screenshots) ? dirMeta.screenshots
    : Array.isArray(zipMeta && zipMeta.screenshots) ? zipMeta.screenshots : []);
  const list = arr.map(String).filter(Boolean)
    .map((s) => (s.indexOf('metadata/') === 0 ? s : 'metadata/' + s));
  return list.length ? list : scanScreenshots(dir);
}

// ---------- 数据目录 ----------

/** 便携基准目录（v0.7.19 抽出：版本目录与「数据目录」共用同一基准，保证两者始终同处便携路径）
 *  打包：便携单文件 exe 解压到临时目录运行，须用 electron-builder 注入的 PORTABLE_EXECUTABLE_DIR（exe 真实所在目录）；
 *  dev：工程根 */
function computePortableBase(opts) {
  const o = opts || {};
  if (o.isPackaged) return process.env.PORTABLE_EXECUTABLE_DIR || o.exeDir || process.cwd();
  return o.devRoot || o.exeDir || process.cwd();
}

function computeVersionsRoot(dataMode, opts) {
  // opts: { userData, exeDir, isPackaged, devRoot }
  if (dataMode === 'portable') return path.join(computePortableBase(opts), 'versions');
  return path.join(opts.userData, 'versions');
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) n += copyDirRecursive(s, d);
    else { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

module.exports = {
  sanitizeId,
  defaultDbKey,
  inspectZip,
  extractZip,
  patchIndexHtml,
  buildInjectBlock,
  writeVersionJson,
  detectC2Version,
  loadVersions,
  importZip,
  computeVersionsRoot,
  computePortableBase,
  copyDirRecursive,
  readMetaFromDir,
  resolveIcon,
  resolveCover,
  scanScreenshots,
  INJECT_MARK
};
