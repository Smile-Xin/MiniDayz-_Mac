/* PC 平台适配层（renderer 专用，launcher.js 之前加载）
 * 职责：
 *  1. 注入 window.__mdzPlatform —— launcher.js 的 PLAT = __mdzPlatform，
 *     版本清单走 main（appdata/portable 数据目录），游戏/媒体 URL 走 app://game 协议直链，
 *     存档导出/导入走原生对话框（save-io IPC）。
 *  2. PC 独有 UI：顶栏「导入版本(zip)」黑按钮 + 设置页「数据目录」卡（与外观/关于同款样式）。
 *  web/安卓构建不含本文件（不引用），PC 端 src/renderer/pc-adapter.js 独立维护。
 */
(function () {
  'use strict';
  var N = window.__launcherNative;
  if (!N) return; // 非 PC：不注入任何东西（web/安卓行为不变）

  var PC_VER = '1.0.4'; // 与 package.json 同步；显示于侧栏底部

  /* v0.7.25：多人版客户端 = 合成版本条目（和单机版同系列、列表里一样显示；客户端由「服务器」分发）
     v0.7.28：图标/封面改用 mp-client 里真实存在的 metadata/ 素材——此前写的 mp-icon.png / mp-cover.png
     在 mp-client 里根本不存在（用户反馈「元数据没了、变成一块蓝色」= 图裂占位）。 */
  var LAN_CLIENT_VER = {
    id: '__lan_client__',
    name: 'MiniDayZ PC多人版',
    version: '1.4.1',
    series: 'MINIDAYZ PC版',
    builtin: true,
    sortFirst: true,
    directUrl: true,
    noSave: true,
    noKeymap: true,
    desktopOnly: true,
    lanClient: true,
    entry: 'client/index.html',
    defaultRes: { w: 850, h: 890 },
    icon: 'metadata/icon.png',
    cover: 'metadata/cover.png',
    author: '官方 + 社区',
    description: '多人联机客户端（由「服务器」分发）：在「联机配置」页启动服务器与分发后，用这个条目进游戏；' +
      '播放方式/分辨率与单机版一致，默认全屏。房间由「房间创建程序」创建。'
  };

  function segs(p) {
    return String(p || '').split('/').map(function (s) { return encodeURIComponent(s); }).join('/');
  }
  function vrootOf(v) {
    return 'app://game/version/' + encodeURIComponent(v.id) + '/';
  }
  function isLanClient(v) { return !!(v && v.lanClient); }
  /* v0.7.26：本地多人客户端的 loopback 地址（启动器自己发出来；内嵌播放用这个 URL）
     —— app:// 页面内嵌 http://127.0.0.1 是允许的（本机被当作可信来源），所以内嵌不再是黑屏 */
  var LAN_SIGNAL = '';   // 当前信令地址（由「联机配置」页/多人版配置设置；注入到客户端 URL 的 ?signal=）
  function refreshLanSignal(cb) {
    try {
      N.lanStatus().then(function (st) {
        if (st && st.endpoints && st.endpoints.signalUrl) LAN_SIGNAL = st.endpoints.signalUrl;
        if (cb) cb(LAN_SIGNAL);
      }).catch(function () {});
    } catch (e) {}
  }
  refreshLanSignal();

  window.__mdzPlatform = {
    isAndroid: false,
    isPC: true, // v0.7.11：PC 专属行为分支（模式命名/窗口模式/隐藏 web 专属入口）
    hideStaticSettings: true, // 本地版无 versions.php 静态清单生成卡
    hideNotice: true, // v0.7.10：PC 本地版不启用公告弹窗/侧边栏公告按钮（web 部署专属；用户要求）
    hideDownload: true, // v0.7.11：PC 版本信息详情不显示「下载」按钮（保留侧边栏「下载游戏」）
    // v0.7.16：PC 恢复「帮助」入口（用户要求与 web 一致——侧边栏「帮助」外链打开浏览器）
    canvasPatternFix: true, // v0.7.7：Electron 软渲染 C2 平铺图案 drawImage 兼容（地图一白屏修复）
    // 版本清单：main 扫描数据目录（appdata / portable）版本目录 + 合成的「多人版客户端」条目
    getVersions: function () {
      return N.versionsList().then(function (list) {
        var arr = Array.isArray(list) ? list.slice() : [];
        if (!arr.some(function (x) { return x && x.id === LAN_CLIENT_VER.id; })) arr.push(LAN_CLIENT_VER);
        return arr;
      });
    },
    // 游戏/媒体 URL：app://game 协议（main protocol.js 从数据目录读文件；supportFetchAPI）
    // v0.7.26：合成版「多人版客户端」走本地 loopback http 服务（内嵌能被 app:// 页面加载；连 ws:// 也不受混合内容限制）
    // v0.7.27：合成版和单机版一样直接读本地文件（app://game/version/__lan_client__/client/index.html，protocol.js 映射到 mp-client）
    //          信令地址用 ?signal= 注入（游戏端 mdz-signal 模组读取；app:// 已开 allow-running-insecure-content）
    gameUrl: function (v) {
      if (!isLanClient(v)) return vrootOf(v) + segs(v.entry || 'index.html');
      refreshLanSignal();
      var u = vrootOf(v) + segs(v.entry || 'client/index.html');
      if (LAN_SIGNAL) u += '?signal=' + encodeURIComponent(LAN_SIGNAL);
      return u;
    },
    // v0.7.27：合成版的图标/封面也走 app://（protocol.js 映射到 mp-client/metadata），不再依赖本地相对文件
    mediaUrl: function (v, p) { return vrootOf(v) + segs(String(p).replace(/^\.\//, '')); },
    baseUrl: function (v) { return vrootOf(v); },
    // v0.7.11：「窗口模式」（原全屏）→ 打开独立游戏窗口（main createGameWindow：原生菜单
    // 显示→全屏F11/分辨率预设，改分辨率弹「请先回到主菜单」确认重启）。游戏内容不动。
    // 分辨率取启动器当前所选（localStorage，与内嵌一致）随 IPC 下发，窗口按此定尺寸。
    // v0.7.25：合成版「多人版客户端」走 lan:play（服务器分发的 http 页面，顶层窗口；连不上会提示而不是黑窗口）
    launchWindow: function (v, calibrate) {
      var r = null;
      try { r = JSON.parse(localStorage.getItem('mdz-res-' + v.id) || 'null'); } catch (e) { r = null; }
      if (!(r && Number.isFinite(r.w) && Number.isFinite(r.h))) {
        r = (v && v.defaultRes && Number.isFinite(v.defaultRes.w) && Number.isFinite(v.defaultRes.h))
          ? { w: v.defaultRes.w, h: v.defaultRes.h } : { w: 1280, h: 720 }; // v0.7.13：普通版默认 1280×720
      }

      try { N.launch(v.id, calibrate ? 'calibrate' : 'window', r); } catch (e) { console.warn('[mdz] launchWindow fail: ' + e.message); }
    },
    // 删除版本（配置弹窗「其他 → 删除版本」；安卓同款入口 v0.7.14 PC 补齐）
    removeVersion: function (v) {
      try { N.closeGame(); } catch (e) {}
      return N.removeVersion(v.id).then(function (r) {
        if (r && r.error) { throw new Error(r.error); }
        return r;
      });
    },
    // ===== v1.0.1：存档传输（手机直装游戏包把存档发到 PC 启动器；与安卓端同形 API）=====
    // 底层是主进程里的 mdz-save-service.js（与「局域网联机/save-bridge」同一份实现），
    // 同步 IPC → 页面里可以像安卓端一样直接同步取状态/列表。
    saveTransfer: {
      available: function () { return !!(N && N.transferStatus); },
      status: function () { try { return N.transferStatus() || {}; } catch (e) { return { ok: false, error: String(e.message || e) }; } },
      start: function (port, token) { try { return N.transferStart(String(port || ''), String(token || '')) || {}; } catch (e) { return { ok: false, error: String(e.message || e) }; } },
      stop: function () { try { return N.transferStop() || {}; } catch (e) { return { ok: false, error: String(e.message || e) }; } },
      list: function () { try { var r = N.transferList(); return (r && r.saves) ? r.saves : []; } catch (e) { return []; } },
      get: function (id) { try { return N.transferGet(String(id)) || {}; } catch (e) { return { ok: false, error: String(e.message || e) }; } },
      remove: function (id) { try { return N.transferRemove(String(id)) || {}; } catch (e) { return { ok: false, error: String(e.message || e) }; } },
      exportText: function (fileName, text) { try { return !!N.transferExport(String(fileName), String(text)); } catch (e) { return false; } }
    },
    onTransferLog: function (cb) { try { if (N && N.onTransferLog) N.onTransferLog(cb); } catch (e) {} },

    // 存档导出：原生「另存为」对话框
    saveExport: function (payload, v, fileName) {
      var fn = fileName ||
        ('mdz-save_' + v.id + '_' + new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '') + '.json');
      return N.saveExport(payload, fn);
    },
    // v0.7.18：按键映射导出/导入接 PC 原生（数据目录 config.json + 原生对话框，与游戏窗口菜单同一数据源）。
    // 详情弹窗按钮（launcher.js exportKeymap/importKeymap 的 PLAT 钩子）从网页下载/上传升级为原生实现：
    //   - 导出：config.json 无该版本映射时，先把内嵌时代存于 localStorage 的「当前方案」迁移过去再导出；
    //   - 导入：原生打开文件 → 主进程写入 config.json（重启游戏生效）。
    exportKeymap: function (map, v) {
      return N.getKeymap(v.id).then(function (cur) {
        if (!cur || !cur.schemes || !Object.keys(cur.schemes).length) {
          // localStorage（内嵌 web mapper 多方案 {active, schemes}）→ config.json 一次迁移
          //（整体多方案结构，与 PC 窗口 mapper 走 config 的存储同构）
          var obj = null;
          try { obj = JSON.parse(localStorage.getItem('mdz-keymaps-' + v.id) || 'null'); } catch (e) {}
          if (!obj || !obj.schemes) {
            try {
              var old = JSON.parse(localStorage.getItem('mdz-keymap-' + v.id) || 'null');
              if (old && typeof old === 'object') obj = { active: '默认', schemes: { '默认': old } };
            } catch (e2) {}
          }
          if (obj && obj.schemes && typeof obj.schemes === 'object') {
            try { N.saveKeymap(v.id, { active: obj.active || '默认', schemes: obj.schemes }).then(function () { toast('已将内嵌校准的按键方案同步到数据目录'); }).catch(function () {}); } catch (e3) {}
          }
        }
        return N.keymapExport(v.id);
      }).then(function (r) {
        if (r && r.error) { toast(r.error, true); return; }
        if (r && r.filePath) toast('已导出按键映射：' + r.filePath);
      }).catch(function (err) { toast('导出按键映射失败: ' + err.message, true); });
    },
    importKeymap: function (v) {
      return N.keymapImport(v.id).then(function (r) {
        if (r && r.error) { toast(r.error, true); return; }
        if (r && r.ok) toast('已导入按键映射（' + r.count + ' 个按键，重启游戏生效）');
      }).catch(function (err) { toast('导入按键映射失败: ' + err.message, true); });
    }
  };

  // ============ PC 独有 UI ============
  function toast(msg, isErr) {
    try {
      var t = document.getElementById('toast');
      if (!t) return;
      t.textContent = msg;
      t.className = 'toast' + (isErr ? ' error' : '');
      t.classList.remove('hidden');
      clearTimeout(toast._t);
      toast._t = setTimeout(function () { t.classList.add('hidden'); }, 4500);
    } catch (e) {}
  }
  function waitApp(cb, tries) {
    if (window.__webApp && window.__webApp.refresh && window.__saveManager) { cb(); return; }
    if ((tries || 0) > 40) return;
    setTimeout(function () { waitApp(cb, (tries || 0) + 1); }, 150);
  }

  // —— 顶栏「导入版本」按钮（黑底白字 + 图标 + zip 提示；与安卓同入口：主顶栏）——
  function addTopbarImportButton() {
    var bar = document.querySelector('.topbar');
    if (!bar || document.getElementById('pc-btn-import')) return;
    var btn = document.createElement('button');
    btn.id = 'pc-btn-import';
    btn.type = 'button';
    btn.title = '导入游戏版本压缩包（.zip 文件，可多选）';
    btn.innerHTML =
      '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:15px;height:15px;flex:none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
      '<span>导入版本</span>' +
      '<span class="pc-zip" style="font-size:9px;line-height:1;padding:2px 4px;border-radius:4px;background:rgba(255,255,255,.16);letter-spacing:.3px">zip</span>';
    // v0.7.11：黑色按钮（用户点名配色）；margin-left:auto 顶栏右端（对齐 .btn-ios-home 惯例）
    btn.style.cssText = 'margin-left:auto;margin-right:6px;display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 12px;' +
      'font-size:13px;font-weight:600;border-radius:8px;color:#fff;background:#101318;' +
      'border:1px solid rgba(255,255,255,.16);cursor:pointer;white-space:nowrap;flex:none;box-shadow:0 2px 6px rgba(0,0,0,.25)';
    btn.onclick = pickZipAndImport;
    btn.onmouseenter = function () { btn.style.filter = 'brightness(1.35)'; };
    btn.onmouseleave = function () { btn.style.filter = ''; };
    // 插在 #btn-menu 之前：桌面（按钮不可见/隐藏）即顶栏最右端；手机端与菜单按钮同排右区
    var menu = document.getElementById('btn-menu');
    if (menu) bar.insertBefore(btn, menu);
    else bar.appendChild(btn);
  }

  // 侧栏底部版本标签：web 文案 → PC 版本号（隐藏误导）
  function patchVersionTag() {
    try {
      var ver = document.querySelector('.side-foot .ver');
      if (ver && ver.textContent.indexOf('web v') === 0) ver.textContent = 'PC v' + PC_VER;
    } catch (e) {}
  }

  async function pickZipAndImport() {
    var res = null;
    try { res = await N.pickZip(); } catch (e) { toast('选择 zip 失败: ' + e.message, true); return; }
    if (!res || !res.list || !res.list.length) return;
    var added = 0, failed = 0, conflicts = 0;
    for (var i = 0; i < res.list.length; i++) {
      var cand = res.list[i];
      if (cand && cand.error) { failed++; toast('「' + (cand.fileName || '') + '」检查失败: ' + cand.error, true); continue; }
      var overrides = null;
      if (cand && cand.existing) {
        conflicts++;
        var name = (cand.meta && cand.meta.name) || cand.id;
        // v0.7.14：覆盖 = 先删旧版本文件再导入（main 端对已存在 ID 会抛"版本已存在"，
        // 旧"留空=覆盖"其实没生效）；改名 = 输入新 ID 另作新版本；取消 = 跳过
        var inp = prompt('版本「' + name + '」（ID: ' + cand.id + '）已存在。\n【覆盖更新】直接点确定——旧游戏文件将被删除后导入新文件（存档独立保留）\n【另作新版本】输入新的版本 ID\n【跳过】点取消');
        if (inp == null) continue; // 取消跳过
        if (String(inp).trim() !== '') {
          overrides = { id: String(inp).trim() };
        } else {
          try {
            try { N.closeGame(); } catch (e3) {}
            var rr = await N.removeVersion(cand.id);
            if (rr && rr.error) throw new Error(rr.error);
          } catch (e2) { failed++; toast('覆盖前删除旧版本失败: ' + e2.message, true); continue; }
        }
      }
      var r = null;
      try { r = await N.doImport(cand, overrides); } catch (e) { r = { error: e.message }; }
      if (r && r.error) { failed++; toast('导入失败: ' + r.error, true); continue; }
      added++;
    }
    if (added) {
      try { window.__webApp.refresh(); } catch (e) {}
      toast('已导入 ' + added + ' 个版本' + (conflicts ? '（含覆盖/改名 ' + conflicts + ' 个）' : '') + (failed ? ('，' + failed + ' 个失败') : ''));
    } else if (failed) {
      toast('本次导入失败 ' + failed + ' 个', true);
    }
  }

  // —— 设置页「数据目录」卡（与外观/关于卡同款 settings-card 样式）——
  function addDataModeCard() {
    var view = document.getElementById('view-settings');
    if (!view || document.getElementById('pc-datamode-card')) return;
    N.getConfig().then(function (c) {
      if (!c) return;
      var card = document.createElement('div');
      card.className = 'settings-card';
      card.id = 'pc-datamode-card';
      var h = document.createElement('h4');
      h.textContent = '数据目录';
      var row = document.createElement('div');
      row.className = 'row';
      var lbl = document.createElement('span');
      lbl.textContent = '存储位置';
      lbl.className = 'muted';
      var sel = document.createElement('select');
      sel.className = 'res-select';
      var MAC = (N.platform === 'darwin');
      var o1 = document.createElement('option'); o1.value = 'appdata';
      o1.textContent = MAC ? '应用支持目录（~/Library/Application Support）' : 'AppData（系统用户数据）';
      var o2 = document.createElement('option'); o2.value = 'portable'; o2.textContent = '程序目录（便携）';
      sel.appendChild(o1);
      if (!MAC) sel.appendChild(o2);   // mac 移植：.app 包内不可写，便携模式不提供
      sel.value = c.dataMode === 'portable' ? 'portable' : 'appdata';
      row.appendChild(lbl);
      row.appendChild(sel);
      var tip = document.createElement('p');
      tip.className = 'muted settings-tip';
      // v0.7.19：把「版本目录」与「数据目录（设置/存档/缓存）」都显示出来，避免误以为缓存没跟着走
      tip.textContent = '版本目录：' + (c.versionsRoot || '');
      var tip2 = document.createElement('p');
      tip2.className = 'muted settings-tip';
      tip2.textContent = '数据目录（设置 / 存档 / 缓存）：' + (c.userData || '');
      var tip3 = document.createElement('p');
      tip3.className = 'muted settings-tip';
      tip3.textContent = MAC
        ? 'macOS 版把版本与存档固定放在 ~/Library/Application Support/MDZLauncher（.app 是签名只读包，程序目录不可写，因此不提供便携模式）。'
        : '「程序目录（便携）」= 与程序同处的便携路径，整包搬走即带走全部数据；切换会迁移版本 + 设置/存档，并自动重启生效。';
      sel.onchange = function () {
        var oldSel = sel.value;
        N.setDataMode(sel.value).then(function (r2) {
          if (r2 && r2.error) { toast(r2.error, true); sel.value = oldSel; return; }
          var extra = [];
          if (r2 && r2.moved) extra.push('版本 ' + r2.moved + ' 个文件');
          if (r2 && r2.cacheMoved) extra.push('数据/缓存 ' + r2.cacheMoved + ' 个文件');
          toast('数据目录已切换' + (extra.length ? '（迁移 ' + extra.join('、') + '）' : '') + '，正在重启生效…');
          // v0.7.19：userData（Chromium profile）只能在 app ready 前设定 → 切换后必须重启
          if (r2 && r2.needRestart && N.relaunchApp) {
            setTimeout(function () { try { N.relaunchApp(); } catch (e) {} }, 900);
          } else {
            setTimeout(function () { try { window.__webApp.refresh(); } catch (e) {} }, 200);
          }
        });
      };
      card.appendChild(h);
      card.appendChild(row);
      card.appendChild(tip);
      card.appendChild(tip2);
      card.appendChild(tip3);
      // 插在「外观」卡之后（与外观/关于同级；中间的静态清单卡 PC 端已隐藏，无碍）
      var cards = view.querySelectorAll('.settings-card');
      var ref = null, k;
      for (k = 0; k < cards.length; k++) {
        var h4 = cards[k].querySelector('h4');
        if (h4 && h4.textContent.indexOf('外观') !== -1) { ref = cards[k]; break; }
      }
      if (ref && ref.nextSibling) view.insertBefore(card, ref.nextSibling);
      else if (ref) ref.parentNode.appendChild(card);
      else {
        var hd = view.querySelector('.view-head');
        if (hd && hd.nextSibling) view.insertBefore(card, hd.nextSibling);
        else view.appendChild(card);
      }
    }).catch(function () {});
  }

  document.addEventListener('DOMContentLoaded', function () {
    addTopbarImportButton();
    patchVersionTag();
    waitApp(function () { addDataModeCard(); });
  });
})();
