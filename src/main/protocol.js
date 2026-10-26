'use strict';
const { protocol } = require('electron');
const path = require('path');
const fs = require('fs');

const SCHEME = 'app';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.manifest': 'text/cache-manifest'
};

// v0.7.15：图片类资源在版本包内缺失时返回 1×1 透明 PNG（200）——部分版本（如 mdz-tank-v160）
// 事件表引用了包内不存在的图片，C2 预加载会因此等不到完成回调而"卡加载进度"；
// 占位图让预加载正常结束（缺失的画面显示为空白而非卡死）。其它资源类型仍 404。
const MISSING_IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico']);
const TRANSPARENT_1PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * 必须在 app ready 之前调用。standard: true 是 IndexedDB 等 Web 存储
 * API 可用的硬前提；secure 保证安全上下文。
 */
function registerPrivilegedSchemes() {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }]);
}

/** 路径穿越防护：target 必须位于 root 之内 */
/** v0.7.27：随包的多人版客户端目录（合成版本 __lan_client__ 的素材来源，和单机版一样直接读本地文件）
 *  v1.0.16（用户要求：内置版本统一放 versions\）——打包后 `resources\versions\{minidayz-pc,minidayz-mp}`，
 *           dev = `<app>\versions\...`；旧的 `builtin\` 与 `mp-client` 布局保留为兼容回退。 */
function mpClientRoot() {
  const cands = [
    path.join(process.resourcesPath || '', 'versions', 'minidayz-mp'),   // v1.0.16 新布局（打包后 extraResources）
    path.join(__dirname, '..', '..', 'versions', 'minidayz-mp'),         // v1.0.16 新布局（dev）
    path.join(process.resourcesPath || '', 'builtin', 'minidayz-mp'),    // 旧布局回退（≤1.0.15）
    path.join(__dirname, '..', '..', 'builtin', 'minidayz-mp'),
    path.join(process.resourcesPath || '', 'mp-client'),                 // 更旧布局回退（≤0.7.33）
    path.join(__dirname, '..', '..', 'mp-client')
  ];
  for (const c of cands) {
    try { if (fs.existsSync(path.join(c, 'client', 'index.html'))) return path.resolve(c); } catch (e) {}
  }
  return path.join(process.resourcesPath || '', 'versions', 'minidayz-mp');
}
function isSafe(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 用 fs 直接读文件（兼容打包后 asar 内部路径；net.fetch 的 file:// 无法读 asar）。
 * app://game/_launcher/*        → 启动器 UI（打包在应用内）
 * app://game/version/<id>/*     → 各游戏版本静态文件（用户数据目录）
 * 所有页面同一 origin（app://game）→ 共享同一 IndexedDB
 */
// v0.6.34：存档隔离补丁——必须在游戏脚本执行前注入（此前 dom-ready 注入太晚：
// C2 游戏脚本在 HTML 解析阶段就执行 indexedDB.open，读到的还是无后缀库 → 导入后游戏读不到）。
// 协议层拦截 HTML 响应，在 <head> 开头插入补丁（从 location.search 读 dbKey，追加 _<dbKey> 后缀），
// 与 web/安卓 buildInjectedHtml 同机制。启动器页（无 dbKey 参数）注入后自动跳过，无副作用。
// v1.0.15：dbKey 也按 [^A-Za-z0-9_-] 净化——与启动器 dbKeyOf / 壳页 mdzIsolate 同规则，
// 否则特殊字符 dbKey 会出现「协议补丁写一种库名、启动器找另一种」。
const DBKEY_PATCH_HTML = '<script id="mdz-dbkey-patch">' +
  '(function(){try{var m=(location.search||"").match(/[?&]dbKey=([^&]+)/);var k=m?decodeURIComponent(m[1]):"";' +
  'k=String(k).replace(/[^A-Za-z0-9_-]/g,"");if(!k)return;' +
  'var s="_"+k,o=window.indexedDB.open.bind(window.indexedDB);' +
  'window.indexedDB.open=function(n,v){if(n&&typeof n==="string"&&!n.endsWith(s))return o(n+s,v);return o(n,v);};}catch(e){}})();' +
  '</script>';

function serveFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.htm') {
    let html = fs.readFileSync(filePath, 'utf8');
    if (html.indexOf('mdz-dbkey-patch') === -1) {
      html = (html.indexOf('<head') !== -1) ? html.replace(/(<head[^>]*>)/i, '$1' + DBKEY_PATCH_HTML) : DBKEY_PATCH_HTML + html;
    }
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  const type = MIME[ext] || 'application/octet-stream';
  const data = fs.readFileSync(filePath);
  return new Response(data, { headers: { 'content-type': type } });
}

function registerGameProtocol(vm) {
  const rendererRoot = path.join(__dirname, '..', 'renderer');

  protocol.handle(SCHEME, async (request) => {
    try {
      const u = new URL(request.url);
      if (u.host !== 'game') return new Response('not found', { status: 404 });

      let p;
      try { p = decodeURIComponent(u.pathname); } catch (e) { p = u.pathname; }
      if (p === '/' || p === '') p = '/_launcher/index.html';

      let filePath;
      if (p.startsWith('/_launcher/')) {
        filePath = path.resolve(rendererRoot, '.' + p.replace(/^\/_launcher/, ''));
        if (!isSafe(rendererRoot, filePath)) return new Response('forbidden', { status: 400 });
      } else if (p.startsWith('/version/')) {
        const relPath = p.replace(/^\/version\//, '');
        /* v0.7.27：合成版「多人版客户端」没有版本目录——映射到随包的 mp-client（和单机版一样直接读本地文件） */
        if (relPath.startsWith('__lan_client__/')) {
          const sub = relPath.slice('__lan_client__/'.length);
          filePath = path.resolve(mpClientRoot(), sub);
          if (!isSafe(mpClientRoot(), filePath)) return new Response('forbidden', { status: 400 });
        } else {
          /* v0.7.44：内置版本不再复制进数据目录 → 数据目录里没有时回退到内置根（resources\versions 等） */
          const cands = [vm.getVersionsRoot()].concat((vm.getBuiltinRoots && vm.getBuiltinRoots()) || []);
          let hit = false;
          for (const r of cands) {
            let p2;
            try { p2 = path.resolve(r, relPath); } catch (e) { continue; }
            if (!isSafe(r, p2)) continue;
            if (fs.existsSync(p2)) { filePath = p2; hit = true; break; }
          }
          if (!hit) {
            const r0 = vm.getVersionsRoot();
            filePath = path.resolve(r0, relPath);
            if (!isSafe(r0, filePath)) return new Response('forbidden', { status: 400 });
          }
        }
      } else {
        return new Response('not found', { status: 404 });
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        // v0.7.15：缺失图片 → 透明占位 PNG（防 C2 预加载卡进度）；其它缺失仍 404
        if (MISSING_IMG_EXT.has(path.extname(filePath).toLowerCase())) {
          return new Response(TRANSPARENT_1PX_PNG, {
            status: 200,
            headers: { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'image/png' }
          });
        }
        return new Response('not found', { status: 404 });
      }
      return serveFile(filePath);
    } catch (err) {
      console.error('[protocol] ' + err.message);
      return new Response('error: ' + err.message, { status: 500 });
    }
  });
}

module.exports = { registerPrivilegedSchemes, registerGameProtocol, SCHEME };
