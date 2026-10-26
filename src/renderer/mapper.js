/* MDZ 键盘映射器 —— 浏览器版（v0.6.27 重构）
 * 由网页版启动器注入到游戏 iframe / 新窗口（不修改游戏 index.html）。
 * - 多套按键方案：localStorage 'mdz-keymaps-<versionId>'（按版本独立；旧单方案 key 自动迁移）
 * - 默认方案：window.__mdzKeymapPreset（由部署可改的 mdz-keymap-preset.js 注入，可上传导出的 JSON 覆盖）
 * - 游戏页内 F10 或右下角 🎹 按钮开关校准面板；面板可拖动、可收起；画布上显示绑定位置标记，可拖拽改位
 * - v0.6.27：无条件禁用右键/拖拽/选择手势（防右键长按手势导致画面黑屏）；类型仅 按住/单击（不再绑定鼠标键）
 */
(function () {
  'use strict';

  // 版本 id：优先取运行时注入标记（srcdoc 下 location.pathname 不可用），回退路径解析
  // （web=versions/<id>/；PC 窗口/direct=app://game/version/<id>/——两种路径都兼容）
  let versionId = window.__mdzVersion || 'default';
  if (!window.__mdzVersion) {
    try {
      const segs = location.pathname.split('/').filter(Boolean);
      let i = segs.lastIndexOf('versions');
      if (i < 0) i = segs.lastIndexOf('version');
      if (i >= 0 && segs[i + 1]) versionId = decodeURIComponent(segs[i + 1]);
    } catch (e) {}
  }
  // PC 原生存储（v0.7.17）：Electron 桥接的 window.__launcher（config.json）存在时走 API——
  // keymaps[id] 存与 localStorage 同构的多方案 {active, schemes}；web 无桥接 → 原 localStorage
  const NATIVE = (window.__launcher && typeof window.__launcher.getKeymap === 'function' &&
    typeof window.__launcher.saveKeymap === 'function') ? window.__launcher : null;

  const LS_KEY = 'mdz-keymap-' + versionId;         // 旧单方案 key（迁移用）
  const SCHEMES_KEY = 'mdz-keymaps-' + versionId;   // 新多方案 key
  const DEFAULT_SCHEME = '默认';
  const DEFAULT_KEYS = {
    Space: { action: '攻击', type: 'hold' },
    KeyE: { action: '交互', type: 'hold' },
    KeyB: { action: '背包', type: 'tap' }
  };
  const S = {
    panel: 'position:fixed;left:14px;bottom:14px;z-index:2147483647;width:384px;max-width:92vw;background:rgba(22,24,28,.97);border:1px solid #4a4f57;border-radius:10px;color:#eef0f4;font:13px/1.7 "Microsoft YaHei",sans-serif;padding:0;box-shadow:0 10px 34px rgba(0,0,0,.55);user-select:none;',
    title: 'font-weight:700;font-size:14px;padding:10px 14px 8px;cursor:move;display:flex;align-items:center;gap:8px;',
    tip: 'color:#9aa0aa;font-size:12px;margin:0 14px 10px;',
    sel: 'width:100%;padding:6px 8px;background:#26292e;color:#eef0f4;border:1px solid #4a4f57;border-radius:7px;outline:none;font-size:12.5px;box-sizing:border-box;',
    input: 'padding:6px 8px;background:#26292e;color:#eef0f4;border:1px solid #4a4f57;border-radius:7px;outline:none;box-sizing:border-box;font-size:12.5px;',
    btn: 'padding:6px 10px;background:#3a3f47;color:#eef0f4;border:1px solid #4a4f57;border-radius:7px;cursor:pointer;font-size:12.5px;',
    hint: 'position:fixed;z-index:2147483646;pointer-events:none;background:rgba(22,24,28,.92);border:1px solid #5a5f68;color:#eef0f4;border-radius:6px;padding:3px 9px;font:12px/1.5 "Microsoft YaHei",sans-serif;white-space:nowrap;',
    cross: 'position:fixed;z-index:2147483646;pointer-events:none;width:24px;height:24px;border:2px solid rgba(255,255,255,.9);border-radius:50%;transform:translate(-50%,-50%);'
  };

  // ===== 方案数据 =====
  let schemes = null;      // { [name]: {code: entry} }
  let activeName = DEFAULT_SCHEME;
  let keymap = null;       // 当前方案（activeName 的 map）
  let preset = null;
  try { preset = window.__mdzKeymapPreset || null; } catch (e) {}
  // localStorage（web 体系）读取多方案存储
  function loadLocalSchemes() {
    try {
      const raw = localStorage.getItem(SCHEMES_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object' && obj.schemes && typeof obj.schemes === 'object') return obj;
      }
    } catch (e) {}
    return null;
  }
  function saveSchemes() {
    const data = { active: activeName, schemes: schemes };
    if (NATIVE) {
      // PC 原生：写数据目录 config.json（主进程菜单/详情导出读同一份）
      try { NATIVE.saveKeymap(data).catch(function () {}); } catch (e) {}
      return;
    }
    try { localStorage.setItem(SCHEMES_KEY, JSON.stringify(data)); } catch (e) {}
  }
  // 应用多方案存储对象到运行态（含面板已打开时的刷新）
  function applySchemesObj(obj) {
    if (!obj || !obj.schemes || typeof obj.schemes !== 'object') return;
    schemes = obj.schemes;
    activeName = (obj.active && obj.schemes[obj.active]) ? obj.active : Object.keys(obj.schemes)[0];
    keymap = schemes[activeName] || null;
    if (panel && panel.isConnected) {
      panelMap = keymap ? JSON.parse(JSON.stringify(keymap)) : {};
      try { refreshSel(panelMap); } catch (e) {}
      try { refreshSchemeSel(); } catch (e) {}
      if (statusEl) statusEl.textContent = '当前方案：' + activeName + (isProtectedDefault() ? '（默认方案，可修改；不可删除）' : '');
      showMarkers(keymap);
    }
  }
  function baseMap() {
    if (preset && typeof preset === 'object' && Object.keys(preset).length) {
      const m = {};
      Object.keys(preset).forEach(function (k) { m[k] = { action: preset[k].action || k, type: preset[k].type || 'hold', pos: preset[k].pos || null }; });
      return m;
    }
    const m = {};
    Object.keys(DEFAULT_KEYS).forEach(function (k) { m[k] = { action: DEFAULT_KEYS[k].action, type: DEFAULT_KEYS[k].type, pos: null }; });
    return m;
  }
  function initSchemes() {
    if (!NATIVE) {
      // —— web 体系（localStorage，同步） ——
      const s = loadLocalSchemes();
      if (s) { applySchemesObj(s); return; }
      // 旧单方案迁移
      let old = null;
      try { old = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) {}
      schemes = {};
      schemes[DEFAULT_SCHEME] = (old && typeof old === 'object') ? old : baseMap();
      activeName = DEFAULT_SCHEME;
      keymap = schemes[DEFAULT_SCHEME];
      saveSchemes();
      try { localStorage.removeItem(LS_KEY); } catch (e) {}
      return;
    }
    // —— PC 原生存储（数据目录 config.json，异步读取；空/旧 plain map 自动迁移为多方案结构） ——
    schemes = {};
    schemes[DEFAULT_SCHEME] = baseMap();
    activeName = DEFAULT_SCHEME;
    keymap = schemes[DEFAULT_SCHEME];
    NATIVE.getKeymap().then(function (m) {
      if (m && typeof m === 'object' && Object.keys(m).length) {
        let obj = m;
        if (!obj.schemes || typeof obj.schemes !== 'object') {
          obj = { active: DEFAULT_SCHEME, schemes: {} };
          obj.schemes[DEFAULT_SCHEME] = m; // 旧单方案（input-mapper 时代 plain map）迁移
        }
        applySchemesObj(obj);
      } else {
        saveSchemes(); // config 无数据 → 落默认方案
      }
      maybeCalibrateOpen();
    }).catch(function () { maybeCalibrateOpen(); });
  }
  function activate(name) {
    if (!schemes[name]) return;
    activeName = name;
    keymap = schemes[name];
    saveSchemes();
    if (panel && panel.isConnected) {
      panelMap = keymap;
      refreshSel(panelMap);
      refreshSchemeSel();
      if (statusEl) statusEl.textContent = '当前方案：' + name + (isProtectedDefault() ? '（默认方案，可修改；不可删除）' : '');
    }
    showMarkers(keymap);
  }
  function ensureScheme(name) {
    if (!schemes[name]) { schemes[name] = JSON.parse(JSON.stringify(schemes[DEFAULT_SCHEME] || baseMap())); /* v1.0.31：基于当前「默认」方案（含你的改动）新建 */ }
    return schemes[name];
  }
  /** v0.7.19：默认方案 = **可修改**、**不可删除**（删除按钮改为「重置为预设键位」，见 delSchemeBtn） */
  function isProtectedDefault() { return activeName === DEFAULT_SCHEME; }
  function persist(map) {
    keymap = map;
    schemes[activeName] = map;
    saveSchemes();
    if (panelSel) refreshSel(map);
    showMarkers(map);
    return true;
  }
  function toast(msg, isErr) {
    try {
      const t = document.getElementById('toast');
      if (t && t.textContent !== undefined) { t.textContent = msg; t.className = 'toast' + (isErr ? ' error' : ''); t.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.add('hidden'); }, 3000); }
      else { console.log('[mapper] ' + msg); }
    } catch (e) { console.log('[mapper] ' + msg); }
  }

  let pressed = {};
  let canvas = null;
  let warnShown = false;
  let panel = null;
  let panelMap = null;
  let panelSel = null;
  let schemeSel = null;
  let statusEl = null;
  let captureCleanup = null;
  let addKeyInput = null;
  let armingKey = false;
  let armingRebind = false;          // v1.0.31：正在改绑已存在按键（「按键」输入框聚焦）
  let onSelRefreshed = null;         // v1.0.31：面板注册的回调——refreshSel 后同步编辑框（保证第一个按键可改）

  function getCanvas() {
    if (canvas && canvas.isConnected) return canvas;
    canvas = document.getElementById('c2canvas') || document.querySelector('canvas');
    return canvas;
  }
  function codeFromEvent(e) {
    const c = e.code;
    if (c && /^[A-Za-z0-9_]+$/.test(c)) return c;
    const k = e.key;
    if (!k) return c || null;
    if (k.length === 1) {
      if (/^[a-zA-Z]$/.test(k)) return 'Key' + k.toUpperCase();
      if (/^[0-9]$/.test(k)) return 'Digit' + k;
      if (k === ' ') return 'Space';
    }
    const named = { ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Shift: 'ShiftLeft', Control: 'ControlLeft', Alt: 'AltLeft', Escape: 'Escape' };
    return named[k] || c || null;
  }
  function isTyping() {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA');
  }
  /** 向游戏画布派发按下/松开（触屏语义：PointerEvent(touch) + TouchEvent，不发 MouseEvent——防 C2 双响应重复点击） */
  function dispatchAt(c, fx, fy, down) {
    const rect = c.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = rect.left + fx * rect.width;
    const y = rect.top + fy * rect.height;
    try {
      c.dispatchEvent(new PointerEvent(down ? 'pointerdown' : 'pointerup', {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: down ? 1 : 0
      }));
    } catch (e) {}
    try {
      const t = new Touch({ identifier: 1, target: c, clientX: x, clientY: y, pageX: x, pageY: y, radiusX: 2, radiusY: 2, force: down ? 1 : 0 });
      c.dispatchEvent(new TouchEvent(down ? 'touchstart' : 'touchend', {
        bubbles: true, cancelable: true,
        touches: down ? [t] : [], targetTouches: down ? [t] : [], changedTouches: [t]
      }));
    } catch (e) {}
  }

  // v0.6.42：tap 与 hold 行为统一（按下按住、松开释放），不再需要 isTap 区分

  /** 统一触发入口（键盘，v0.6.27 起仅键盘——不再绑定鼠标键）
   *  v0.6.42：tap（单击）与 hold（按住）行为统一为「按下按住、松开释放」——
   *  旧 tap 用 90ms 自动弹起：快速点按（keyup < 90ms）时 pressed 已被清 → 自动弹起不触发
   *  → 游戏按钮一直按着（按死）。现在 keyup 一定派发 up，点一下=一次点击、长按=持续按住，不卡死 */
  function handleTrigger(code, down, e) {
    const entry = keymap[code];
    if (!entry) return false;
    if (down) {
      if (e && e.repeat) return false;
      if (isTyping() || captureCleanup || armingKey) return false;
      if (e && e.preventDefault) e.preventDefault();
      if (!entry.pos) {
        if (!warnShown) { console.warn('[mapper] 按键 ' + code + ' 未校准，按 F10 或点右下角 🎹 校准'); warnShown = true; }
        return true;
      }
      const c = getCanvas();
      if (!c) return true;
      pressed[code] = true;
      dispatchAt(c, entry.pos[0], entry.pos[1], true);
      return true;
    }
    if (!pressed[code]) return false;
    if (e && e.preventDefault) e.preventDefault();
    pressed[code] = false;
    const c2 = getCanvas();
    if (!c2) return true;
    dispatchAt(c2, keymap[code].pos[0], keymap[code].pos[1], false);
    return true;
  }
  function keyDown(e) {
    const code = (keymap && e.code && keymap[e.code]) ? e.code : codeFromEvent(e);
    handleTrigger(code, true, e);
  }
  function keyUp(e) {
    const code = (keymap && e.code && keymap[e.code]) ? e.code : codeFromEvent(e);
    handleTrigger(code, false, e);
  }
  window.addEventListener('keydown', keyDown, true);
  window.addEventListener('keyup', keyUp, true);

  /** v0.6.27：无条件禁用右键/拖拽/选择手势（防右键长按画手势后画面黑屏） */
  document.addEventListener('mousedown', function (e) { if (e.button === 2) { e.preventDefault(); } }, true);
  document.addEventListener('contextmenu', function (e) { try { e.preventDefault(); } catch (err) {} }, true);
  document.addEventListener('selectstart', function (e) { e.preventDefault(); }, true);
  document.addEventListener('dragstart', function (e) { e.preventDefault(); }, true);

  /** 释放所有按住的映射键（iframe 失焦/切后台时 keyup 丢失 → 按键卡死；v0.6.42：tap 也释放，与 hold 一致） */
  function releaseAllKeys() {
    const codes = Object.keys(pressed);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (!pressed[code]) continue;
      pressed[code] = false;
      const entry = keymap && keymap[code];
      if (!entry || !entry.pos) continue;
      const c = getCanvas();
      if (c) dispatchAt(c, entry.pos[0], entry.pos[1], false);
    }
  }
  window.addEventListener('blur', releaseAllKeys);
  document.addEventListener('visibilitychange', function () { if (document.hidden) releaseAllKeys(); });

  // ===== 校准 =====
  function refreshSel(map) {
    if (!panelSel) return;
    const prev = panelSel.value;
    panelSel.innerHTML = '';
    Object.keys(map).forEach(function (code) {
      const o = document.createElement('option');
      o.value = code;
      const posTxt = map[code].pos
        ? '  ✓ ' + Math.round(map[code].pos[0] * 100) + '%,' + Math.round(map[code].pos[1] * 100) + '%'
        : '  ✗ 未绑定';
      o.textContent = (map[code].action || code) + ' (' + code + ')' + posTxt;
      panelSel.appendChild(o);
    });
    if (prev && map[prev]) panelSel.value = prev;
    /* v1.0.31：列表变化后**保证有选中项**并同步右侧编辑框——原来既不设初值也不刷字段，
       表现为「要先点一下别的按键、再点回来才能改第一个按键」。 */
    if (!panelSel.value && panelSel.options.length) panelSel.value = panelSel.options[0].value;
    if (typeof onSelRefreshed === 'function') { try { onSelRefreshed(); } catch (e) {} }
    showMarkers(map);
  }
  function refreshSchemeSel() {
    if (!schemeSel) return;
    const prev = schemeSel.value;
    schemeSel.innerHTML = '';
    Object.keys(schemes).forEach(function (name) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name + (name === activeName ? '（当前）' : '');
      schemeSel.appendChild(o);
    });
    if (prev && schemes[prev]) schemeSel.value = prev;
    else if (schemes[activeName]) schemeSel.value = activeName;
  }

  function startCapture(map, code, statusEl) {
    cancelCapture();
    const c = getCanvas();
    if (!c) { if (statusEl) statusEl.textContent = '未找到画布'; return; }
    if (panel) panel.style.display = 'none';
    hideMarkers(); // 校准中隐藏标记避免干扰
    const hint = document.createElement('div');
    hint.style.cssText = S.hint;
    document.body.appendChild(hint);
    const cross = document.createElement('div');
    cross.style.cssText = S.cross;
    document.body.appendChild(cross);
    function onMove(e) {
      const rect = c.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      const inC = fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1;
      cross.style.left = e.clientX + 'px';
      cross.style.top = e.clientY + 'px';
      cross.style.borderColor = inC ? 'rgba(255,255,255,.9)' : 'rgba(255,90,90,.9)';
      hint.style.left = (e.clientX + 16) + 'px';
      hint.style.top = (e.clientY + 16) + 'px';
      hint.textContent = inC ? '点击「' + (map[code].action || code) + '」(' + Math.round(fx * 100) + '%, ' + Math.round(fy * 100) + '%) · Esc 取消' : '移到画布内… · Esc 取消';
    }
    function onClick(e) {
      if (panel && panel.contains(e.target)) return;
      const rect = c.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
      map[code].pos = [+fx.toFixed(4), +fy.toFixed(4)];
      cancelCapture();
      persist(map);
      if (panel) {
        panel.style.display = 'block';
        if (statusEl) statusEl.textContent = '已保存 ' + code + ' → (' + Math.round(fx * 100) + '%, ' + Math.round(fy * 100) + '%)';
        refreshSel(map);
      }
    }
    function onCancel(e) {
      if (e.code === 'Escape' || e.code === 'F10') {
        e.preventDefault();
        cancelCapture();
        if (panel) { panel.style.display = 'block'; if (statusEl) statusEl.textContent = '已取消'; }
      }
    }
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('mouseup', onClick, true);
    document.addEventListener('pointerup', onClick, true);
    window.addEventListener('keydown', onCancel, true);
    captureCleanup = function () {
      hint.remove(); cross.remove();
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('mouseup', onClick, true);
      document.removeEventListener('pointerup', onClick, true);
      window.removeEventListener('keydown', onCancel, true);
      captureCleanup = null;
    };
  }
  function cancelCapture() { if (captureCleanup) { const fn = captureCleanup; captureCleanup = null; fn(); } }

  // ===== 画布位置标记（可拖拽改位） =====
  let markersWrap = null;
  let markersList = [];
  function showMarkers(map) {
    hideMarkers();
    const c = getCanvas();
    if (!c) return;
    const m = map || keymap || {};
    const codes = Object.keys(m).filter(function (code) { return m[code] && m[code].pos; });
    if (!codes.length) return;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483645;';
    markersList = codes.map(function (code) {
      const en = m[code];
      const dot = document.createElement('div');
      dot.style.cssText = 'position:fixed;width:16px;height:16px;border-radius:50%;background:rgba(120,180,255,.8);border:2px solid #fff;box-shadow:0 0 6px rgba(0,0,0,.5);transform:translate(-50%,-50%);cursor:grab;pointer-events:auto;touch-action:none;'; // v0.6.31：显式 pointer-events:auto（wrap 为 none 会继承到 dot 导致拖不动）+ touch-action:none
      dot.title = '拖拽可调整位置';
      const label = document.createElement('div');
      label.style.cssText = 'position:fixed;transform:translate(-50%,-125%);color:#fff;background:rgba(20,24,28,.88);border:1px solid #5a5f68;border-radius:4px;padding:1px 6px;font:11px/1.5 "Microsoft YaHei",sans-serif;white-space:nowrap;pointer-events:none;';
      label.textContent = (en.action || code) + ' · ' + code;
      wrap.appendChild(dot);
      wrap.appendChild(label);
      const mk = { code: code, pos: en.pos, dot: dot, label: label };
      // v0.6.27：长按拖动标记修改位置（仅校准面板打开时启用）
      mk.drag = makeMarkerDraggable(mk, m);
      return mk;
    });
    document.body.appendChild(wrap);
    markersWrap = wrap;
    placeMarkers();
  }
  function makeMarkerDraggable(mk, map) {
    let dragging = false;
    // v0.6.31：down 统一入口（鼠标/触摸）；dot 显式 pointer-events:auto 后才能收到事件
    function down(e) {
      if (!panel || !panel.isConnected) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dragging = true;
      mk.dragging = true;
    }
    function moveTo(x, y) {
      if (!dragging) return;
      const c = getCanvas();
      if (!c) return;
      const rect = c.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      let fx = (x - rect.left) / rect.width;
      let fy = (y - rect.top) / rect.height;
      fx = Math.max(0, Math.min(1, fx));
      fy = Math.max(0, Math.min(1, fy));
      mk.pos = [+fx.toFixed(4), +fy.toFixed(4)];
      mk.dot.style.left = (rect.left + fx * rect.width) + 'px';
      mk.dot.style.top = (rect.top + fy * rect.height) + 'px';
      mk.label.style.left = (rect.left + fx * rect.width) + 'px';
      mk.label.style.top = (rect.top + fy * rect.height) + 'px';
    }
    function move(e) {
      if (!dragging) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      moveTo(e.clientX, e.clientY);
    }
    function up(e) {
      if (!dragging) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dragging = false;
      map[mk.code].pos = mk.pos;
      persist(map);
    }
    // v0.6.31：触屏拖动支持（手机/触屏设备）
    function tstart(e) {
      const t = e.touches && e.touches[0];
      if (!t) return;
      down(e);
    }
    function tmove(e) {
      const t = e.touches && e.touches[0];
      if (!t) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      moveTo(t.clientX, t.clientY);
    }
    function tend(e) { if (dragging) { e.preventDefault(); dragging = false; map[mk.code].pos = mk.pos; persist(map); } }
    mk.dot.addEventListener('mousedown', down, true);
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
    mk.dot.addEventListener('touchstart', tstart, true);
    document.addEventListener('touchmove', tmove, true);
    document.addEventListener('touchend', tend, true);
    document.addEventListener('touchcancel', tend, true);
    return function cleanup() {
      mk.dot.removeEventListener('mousedown', down, true);
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      mk.dot.removeEventListener('touchstart', tstart, true);
      document.removeEventListener('touchmove', tmove, true);
      document.removeEventListener('touchend', tend, true);
      document.removeEventListener('touchcancel', tend, true);
    };
  }
  function placeMarkers() {
    const c = getCanvas();
    if (!c || !markersWrap) return;
    const rect = c.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    for (let i = 0; i < markersList.length; i++) {
      const mk = markersList[i];
      const x = rect.left + mk.pos[0] * rect.width;
      const y = rect.top + mk.pos[1] * rect.height;
      mk.dot.style.left = x + 'px';
      mk.dot.style.top = y + 'px';
      mk.label.style.left = x + 'px';
      mk.label.style.top = y + 'px';
    }
  }
  function hideMarkers() {
    if (markersWrap) {
      markersWrap.remove();
      markersWrap = null;
      if (markersList.length) { for (let i = 0; i < markersList.length; i++) { if (markersList[i].drag) markersList[i].drag(); } }
      markersList = [];
    }
  }
  window.addEventListener('resize', function () { try { placeMarkers(); } catch (e) {} });

  // ===== 面板（可拖动 / 可收起） =====
  function closePanel() {
    cancelCapture();
    hideMarkers();
    if (panel) { panel.remove(); panel = null; panelMap = null; panelSel = null; schemeSel = null; }
    addKeyInput = null;
    armingKey = false;
    armingRebind = false;
    onSelRefreshed = null;
  }
  function openPanel() {
    if (panel && panel.isConnected) { panel.style.display = 'block'; refreshSel(panelMap); return; }
    buildPanel();
  }
  function buildPanel() {
    panelMap = JSON.parse(JSON.stringify(keymap || {}));
    const p = document.createElement('div');
    p.id = 'mdz-keycal';
    p.style.cssText = S.panel;
    // 标题行（可拖动）+ 收起按钮
    const title = document.createElement('div');
    title.style.cssText = S.title;
    title.innerHTML = '<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🎹 键盘映射校准 <span style="color:#9aa0aa;font-weight:400;font-size:12px;">F10 开关 · 可拖/收起</span></span>';
    const foldBtn = document.createElement('button');
    foldBtn.textContent = '收起';
    foldBtn.style.cssText = S.btn + ';padding:2px 8px;font-size:11px;';
    foldBtn.title = '收起面板（F10 重新打开）——方便查看画布标记';
    foldBtn.onclick = function () { p.style.display = 'none'; };
    title.appendChild(foldBtn);
    // 面板拖动（标题行 mousedown）
    (function () {
      let offX = 0, offY = 0, dragging = false;
      title.addEventListener('mousedown', function (e) {
        if (e.target === foldBtn) return;
        dragging = true;
        offX = e.clientX - p.offsetLeft;
        offY = e.clientY - p.offsetTop;
        e.preventDefault();
      });
      document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        p.style.left = (e.clientX - offX) + 'px';
        p.style.top = (e.clientY - offY) + 'px';
        p.style.right = 'auto';
        p.style.bottom = 'auto';
      });
      document.addEventListener('mouseup', function () { dragging = false; });
    })();
    const tip = document.createElement('div');
    tip.style.cssText = S.tip;
    tip.textContent = '选键 → 面板自动收起 → 点游戏按钮绑定位置；标记可拖拽改位；Delete 清除所选。';
    // 方案管理行（下拉 + 新建/删除）
    const schemeRow = document.createElement('div');
    schemeRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin:0 14px 8px;';
    const schemeLbl = document.createElement('span');
    schemeLbl.style.cssText = 'color:#9aa0aa;font-size:12px;white-space:nowrap;';
    schemeLbl.textContent = '方案';
    schemeSel = document.createElement('select');
    schemeSel.style.cssText = S.sel + ';flex:1;margin:0;min-width:0;';
    const newSchemeBtn = document.createElement('button');
    newSchemeBtn.textContent = '＋';
    newSchemeBtn.style.cssText = S.btn + ';flex:none;padding:6px 9px;';
    newSchemeBtn.title = '新建方案';
    const delSchemeBtn = document.createElement('button');
    delSchemeBtn.textContent = '删';
    delSchemeBtn.style.cssText = S.btn + ';flex:none;padding:6px 9px;';
    delSchemeBtn.title = '删除当前方案（默认方案不可删除）';
    schemeRow.append(schemeLbl, schemeSel, newSchemeBtn, delSchemeBtn);
    // 导入/导出行（独立一行，避免按钮溢出面板）
    const ieRow = document.createElement('div');
    ieRow.style.cssText = 'display:flex;gap:6px;margin:0 14px 8px;';
    const importBtn = document.createElement('button');
    importBtn.textContent = '导入方案';
    importBtn.style.cssText = S.btn + ';flex:1;';
    importBtn.title = '导入按键映射 JSON（作为新方案）';
    const exportBtn = document.createElement('button');
    exportBtn.textContent = '导出方案';
    exportBtn.style.cssText = S.btn + ';flex:1;';
    exportBtn.title = '导出当前方案为 JSON（可分享/上传到默认方案）';
    ieRow.append(importBtn, exportBtn);
    // 当前按键行
    const selRow = document.createElement('div');
    selRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin:0 14px 8px;';
    panelSel = document.createElement('select');
    panelSel.style.cssText = S.sel + ';flex:1;margin:0;min-width:0;';
    const typeSel = document.createElement('select');
    typeSel.style.cssText = S.sel + ';width:84px;margin:0;flex:none;';
    typeSel.innerHTML = '<option value="hold">按住</option><option value="tap">单击</option>';
    const delBtn = document.createElement('button');
    delBtn.textContent = '删除';
    delBtn.style.cssText = S.btn + ';flex:none;';
    delBtn.title = '删除所选按键绑定';
    /* v1.0.31（用户要求）：
       ① 「按键」输入框——点一下再按新键即可**直接改绑已存在的按键**（原来只能删掉重加）；
       ② 「校准」按钮——把「一选键就立刻进入位置校准、面板自动收起」改成显式点按钮才校准。 */
    const keyCodeInp = document.createElement('input');
    keyCodeInp.placeholder = '按键';
    keyCodeInp.title = '点这里后按键盘上的键 = 把当前按键改绑到新键（Esc 取消）';
    keyCodeInp.style.cssText = S.input + ';width:74px;flex:none;cursor:pointer;';
    keyCodeInp.readOnly = true;
    const calBtn = document.createElement('button');
    calBtn.textContent = '校准';
    calBtn.style.cssText = S.btn + ';flex:none;';
    calBtn.title = '进入位置校准：点一下游戏里这个按钮的位置';
    selRow.append(panelSel, typeSel, keyCodeInp, calBtn, delBtn);
    let delArmT = 0; // v0.7.17：删除方案二段确认的自动取消计时器
    const status = document.createElement('div');
    status.style.cssText = 'font-size:12px;color:#8d919a;min-height:18px;margin:0 14px 8px;';
    statusEl = status; // v0.6.28：全局状态行引用（activate/保护提示用）
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px dashed #3a3f47;margin:0 14px 8px;';
    // 添加行
    const addTip = document.createElement('div');
    addTip.style.cssText = 'color:#6f737b;font-size:11px;margin:0 14px 6px;';
    addTip.textContent = '添加按键：点输入框后按键盘键，填名称，选按住/单击，点「添加」再点游戏按钮。';
    const addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin:0 14px 12px;';
    const keyInp = document.createElement('input');
    keyInp.placeholder = '按键';
    keyInp.style.cssText = S.input + ';flex:1.1;min-width:0;';
    addKeyInput = keyInp;
    keyInp.addEventListener('focus', function () { armingKey = true; status.textContent = '请按下要绑定的键…'; });
    keyInp.addEventListener('blur', function () { armingKey = false; });
    const actInp = document.createElement('input');
    actInp.placeholder = '名称';
    actInp.style.cssText = S.input + ';flex:1;min-width:0;';
    const addTypeSel = document.createElement('select');
    addTypeSel.innerHTML = '<option value="tap">单击</option><option value="hold">按住</option>'; // v0.6.30：新按键默认「单击」
    addTypeSel.style.cssText = S.sel + ';width:84px;margin:0;flex:none;';
    const addBtn = document.createElement('button');
    addBtn.textContent = '添加';
    addBtn.style.cssText = S.btn + ';flex:none;';
    addRow.append(keyInp, actInp, addTypeSel, addBtn);
    p.append(title, tip, schemeRow, ieRow, selRow, status, sep, addTip, addRow);
    document.body.appendChild(p);
    panel = p;

    // ===== 方案操作 =====
    refreshSchemeSel();
    schemeSel.onchange = function () {
      if (!schemeSel.value) return;
      activate(schemeSel.value);
      status.textContent = '已切换到方案「' + activeName + '」';
    };
    // v0.7.17：新建方案不用 window.prompt——Electron 游戏 iframe / 部分环境会抑制 JS 对话框
    // （表现为「点＋没反应」）→ 面板内联命名行（Enter 确定 / Esc 取消），web 浏览器同享更稳
    newSchemeBtn.onclick = function () {
      if (schemeRow.querySelector('.mdz-new-scheme-row')) return;
      const nameInp = document.createElement('input');
      nameInp.placeholder = '新方案名称（默认自动编号）';
      nameInp.style.cssText = S.input + ';flex:1;min-width:0;';
      const okBtn = document.createElement('button');
      okBtn.textContent = '确定';
      okBtn.style.cssText = S.btn + ';flex:none;';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = '取消';
      cancelBtn.style.cssText = S.btn + ';flex:none;';
      const row = document.createElement('div');
      row.className = 'mdz-new-scheme-row';
      row.style.cssText = 'display:flex;gap:6px;margin:0 14px 8px;';
      row.append(nameInp, okBtn, cancelBtn);
      schemeRow.insertAdjacentElement('afterend', row);
      nameInp.focus();
      function commit() {
        const name = String(nameInp.value || '').trim() || ('方案' + (Object.keys(schemes).length + 1));
        row.remove();
        if (schemes[name]) { status.textContent = '方案「' + name + '」已存在'; return; }
        schemes[name] = JSON.parse(JSON.stringify(schemes[DEFAULT_SCHEME] || baseMap())); /* v1.0.31：基于当前「默认」方案（含你的改动）新建 */
        activate(name);
        refreshSchemeSel();
        status.textContent = '已新建并切换到方案「' + name + '」（基于「' + DEFAULT_SCHEME + '」方案）';
      }
      okBtn.onclick = commit;
      cancelBtn.onclick = function () { row.remove(); };
      nameInp.addEventListener('keydown', function (ev) {
        ev.stopPropagation();
        if (ev.code === 'Enter') commit();
        else if (ev.code === 'Escape') row.remove();
      });
    };
    // v0.7.17：删除方案不用 window.confirm（同上被抑制风险）→ 二段确认（5 秒内再点执行）
    // v0.7.19：默认方案不可删除——对默认方案点删除 = 二段确认后「重置为预设键位」（默认键位来自 mdz-keymap-preset.js）
    delSchemeBtn.onclick = function () {
      if (isProtectedDefault()) {
        if (delSchemeBtn.dataset.arm !== '1') {
          delSchemeBtn.dataset.arm = '1';
          delSchemeBtn.textContent = '确认重置';
          status.textContent = '「' + DEFAULT_SCHEME + '」是默认方案，不可删除。再点一次「确认重置」= 恢复预设默认键位（自定义修改会丢失）；5 秒后自动取消';
          clearTimeout(delArmT);
          delArmT = setTimeout(function () {
            delete delSchemeBtn.dataset.arm;
            delSchemeBtn.textContent = '删';
            if (status) status.textContent = '已取消';
          }, 5000);
          return;
        }
        delete delSchemeBtn.dataset.arm;
        delSchemeBtn.textContent = '删';
        schemes[DEFAULT_SCHEME] = JSON.parse(JSON.stringify(baseMap()));
        keymap = schemes[DEFAULT_SCHEME];
        panelMap = keymap;
        saveSchemes();
        refreshSel(panelMap);
        refreshSchemeSel();
        showMarkers(keymap);
        status.textContent = '已把默认方案重置为预设键位';
        toast('默认方案已重置为预设键位');
        return;
      }
      if (Object.keys(schemes).length <= 1) { toast('至少保留一个方案', true); return; }
      if (delSchemeBtn.dataset.arm !== '1') {
        delSchemeBtn.dataset.arm = '1';
        delSchemeBtn.textContent = '确认删除';
        status.textContent = '再点一次「确认删除」执行（删除方案「' + activeName + '」，不可恢复）；5 秒后自动取消';
        clearTimeout(delArmT);
        delArmT = setTimeout(function () {
          delete delSchemeBtn.dataset.arm;
          delSchemeBtn.textContent = '删';
          if (status) status.textContent = '已取消删除';
        }, 5000);
        return;
      }
      delete delSchemeBtn.dataset.arm;
      delSchemeBtn.textContent = '删';
      delete schemes[activeName];
      const rest = Object.keys(schemes);
      activate(rest[0]);
      refreshSchemeSel();
      status.textContent = '已删除方案（当前切换到「' + activeName + '」）';
    };
    importBtn.onclick = function () {
      const fi = document.createElement('input');
      fi.type = 'file';
      fi.accept = '.json,application/json';
      fi.onchange = function () {
        const f = fi.files && fi.files[0];
        fi.value = '';
        if (!f) return;
        const reader = new FileReader();
        reader.onload = function () {
          try {
            const obj = JSON.parse(String(reader.result));
            if (!obj || typeof obj !== 'object') throw new Error('JSON 无效');
            // 兼容完整方案包 {schemes:{...}} 或单方案 {code:entry}
            let name = f.name.replace(/\.json$/i, '');
            if (obj.schemes && typeof obj.schemes === 'object') {
              Object.keys(obj.schemes).forEach(function (n) {
                if (!schemes[n]) schemes[n] = sanitizeMap(obj.schemes[n]);
              });
              name = name + '（批量导入）';
            } else {
              schemes[name] = sanitizeMap(obj);
            }
            saveSchemes();
            activate(name);
            refreshSchemeSel();
            status.textContent = '已导入方案「' + name + '」（' + Object.keys(keymap).length + ' 个键）';
          } catch (e) { status.textContent = '导入失败: ' + e.message; }
        };
        reader.readAsText(f);
      };
      fi.click();
    };
    exportBtn.onclick = function () {
      try {
        const blob = new Blob([JSON.stringify(keymap, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'mdz-keymap-' + versionId + '-' + activeName + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
        status.textContent = '已导出方案「' + activeName + '」（' + Object.keys(keymap).length + ' 个键）';
      } catch (e) { status.textContent = '导出失败: ' + e.message; }
    };
    function sanitizeMap(obj) {
      const out = {};
      Object.keys(obj).forEach(function (code) {
        const v = obj[code];
        if (!v || typeof v !== 'object') return;
        out[code] = {
          action: String(v.action || code),
          type: (v.type === 'tap') ? 'tap' : 'hold',
          pos: (Array.isArray(v.pos) && v.pos.length >= 2 && typeof v.pos[0] === 'number' && typeof v.pos[1] === 'number') ? [+v.pos[0].toFixed(4), +v.pos[1].toFixed(4)] : null
        };
      });
      return out;
    }

    // ===== 按键操作（v0.7.19：默认方案也可编辑——编辑不再拦截；仍不可删除） =====
    function guardEdit() { return true; }
    addBtn.onclick = function () {
      if (!guardEdit()) return;
      const code = keyInp.value.trim();
      const act = actInp.value.trim() || code;
      if (!code) { status.textContent = '先点击按键输入框并按下要绑定的键'; return; }
      keyInp.value = '';
      actInp.value = '';
      panelMap[code] = { action: act, type: addTypeSel.value, pos: (panelMap[code] && panelMap[code].pos) ? panelMap[code].pos : null };
      persist(panelMap);
      refreshSel(panelMap);
      panelSel.value = code;
      status.textContent = '已添加 ' + code + '（' + act + '），点击游戏里的按钮位置…';
      startCapture(panelMap, code, status);
    };
    /* v1.0.31：把选中按键的「类型 / 键码」同步到编辑控件（打开面板/切方案/增删改后都会调） */
    function loadFields() {
      const code = panelSel.value;
      if (!code || !panelMap || !panelMap[code]) { keyCodeInp.value = ''; return; }
      typeSel.value = panelMap[code].type === 'tap' ? 'tap' : 'hold';
      keyCodeInp.value = code;
      keyCodeInp.title = '当前绑定：' + code + '（点这里再按新键 = 改绑）';
    }
    onSelRefreshed = loadFields;
    panelSel.onchange = function () {
      const code = panelSel.value;
      if (!code) return;
      if (!guardEdit()) { refreshSel(panelMap); return; }
      loadFields(); // v1.0.31：选中即在编辑框里显示（不再自动跳去位置校准）
      status.textContent = '已选中「' + (panelMap[code].action || code) + '」(' + code + ')：可改类型/按键，或点「校准」定位。';
    };
    calBtn.onclick = function () {
      const code = panelSel.value;
      if (!code || !panelMap || !panelMap[code]) return;
      if (!guardEdit()) return;
      status.textContent = '点击画面上「' + (panelMap[code].action || code) + '」按钮位置…';
      startCapture(panelMap, code, status);
    };
    /* v1.0.31：改绑——「按键」输入框聚焦时按下的键就是新键码；新键已被占用则确认后覆盖 */
    keyCodeInp.addEventListener('focus', function () {
      armingRebind = true;
      status.textContent = '按下要改绑的键…（Esc 取消）';
    });
    keyCodeInp.addEventListener('blur', function () { armingRebind = false; });
    keyCodeInp.addEventListener('keydown', function (e) {
      if (!armingRebind) return;
      e.preventDefault();
      e.stopPropagation();   // 不让全局 keydown（添加按键/Delete 清除）再处理
      const from = panelSel.value;
      if (!from || !panelMap || !panelMap[from]) return;
      if (e.code === 'Escape') { armingRebind = false; keyCodeInp.blur(); status.textContent = '已取消改键'; return; }
      if (e.code === 'F10' || e.code === 'Delete') { status.textContent = '这个键留给面板用，不能绑定'; return; }
      const to = e.code;
      if (to === from) { armingRebind = false; keyCodeInp.blur(); status.textContent = '键位没变（仍是 ' + from + '）'; return; }
      if (panelMap[to]) { status.textContent = '「' + to + '」已绑定「' + (panelMap[to].action || to) + '」——先删掉它或换一个键'; return; }
      const rec = panelMap[from];
      delete panelMap[from];
      panelMap[to] = rec;       // 位置/动作/类型保持不变，只换键码
      persist(panelMap);
      refreshSel(panelMap);
      panelSel.value = to;
      loadFields();
      armingRebind = false;
      keyCodeInp.blur();
      toast('已把「' + (rec.action || from) + '」改绑到 ' + to);
      status.textContent = '已改绑到 ' + to + '（位置不变）';
    });
    typeSel.onchange = function () {
      const code = panelSel.value;
      if (!code || !panelMap[code]) return;
      if (!guardEdit()) { refreshSel(panelMap); return; }
      panelMap[code].type = typeSel.value;
      persist(panelMap);
      refreshSel(panelMap);
      status.textContent = code + ' 类型已设为「' + (typeSel.value === 'tap' ? '单击' : '按住') + '」';
    };
    delBtn.onclick = function () {
      const code = panelSel.value;
      if (!code) return;
      if (!guardEdit()) return;
      delete panelMap[code];
      persist(panelMap);
      status.textContent = '已删除 ' + code;
    };
    refreshSel(panelMap);
    status.textContent = isProtectedDefault()
      ? '当前为默认方案（可修改；不可删除——点删除会重置为预设键位）。'
      : '选择按键开始校准，或添加新按键。';
  }

  // 添加按键全局捕获（键盘）
  window.addEventListener('keydown', function (e) {
    if (!addKeyInput || !panel || panel.style.display === 'none') return;
    if (e.code === 'F10' || e.code === 'Escape' || e.code === 'Delete') return;
    if (document.activeElement === addKeyInput || armingKey) {
      e.preventDefault();
      e.stopPropagation();
      addKeyInput.value = codeFromEvent(e);
      armingKey = false;
    }
  }, true);

  // F10 / Esc / Delete
  window.addEventListener('keydown', function (e) {
    if (e.code === 'F10') {
      e.preventDefault();
      if (armingKey) { armingKey = false; if (addKeyInput) addKeyInput.blur(); }
      if (captureCleanup) { cancelCapture(); if (panel) panel.style.display = 'block'; }
      else if (panel && panel.isConnected) {
        if (panel.style.display === 'none') { panel.style.display = 'block'; refreshSel(panelMap); } // v0.6.30：收起状态下 F10 直接重新展开（此前会先走 closePanel 关掉，需按两次）
        else closePanel();
      }
      else openPanel();
      return;
    }
    if (e.code === 'Escape' && panel && panel.isConnected && !captureCleanup) closePanel();
    if (e.code === 'Delete' && panel && panel.isConnected && !captureCleanup && panelSel && panelSel.value) {
      delete panelMap[panelSel.value];
      persist(panelMap);
    }
  }, true);

  // 启动
  initSchemes();
  // 热更新（v0.4.1）：启动器页（同源）导入/修改 → storage 事件 → 立即重载生效（仅 localStorage 体系）
  if (!NATIVE) {
    window.addEventListener('storage', function (e) {
      if (!e.key) return;
      if (e.key === SCHEMES_KEY || e.key === LS_KEY) {
        const s = loadLocalSchemes();
        if (s) { applySchemesObj(s); }
      }
    });
  }
  // 校准触发：?calibrate=1 / cal=1（PC 窗口模式）或启动器注入 __mdzCalibrate；
  // PC 原生存储（config.json）异步就绪后再触发一次（见 initSchemes NATIVE 分支）
  function maybeCalibrateOpen() {
    if (window.__mdzCalibrate === true || new URLSearchParams(location.search).get('calibrate') === '1' ||
        new URLSearchParams(location.search).get('cal') === '1') {
      openPanel();
    }
  }
  maybeCalibrateOpen();
  window.__mdzMapper = { openPanel, closePanel, getKeymap: function () { return keymap; }, getSchemes: function () { return schemes; }, getActive: function () { return activeName; } };
})();
