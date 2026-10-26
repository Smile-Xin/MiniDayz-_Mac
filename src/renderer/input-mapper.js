/* MDZ 键盘映射器（按键 -> 画布坐标触屏事件模拟 + 校准）
 * 由主进程在游戏窗口 dom-ready 时动态注入 loader 加载（与启动器同源）。
 * - 任意时刻按 F10 开关校准面板（无需重启游戏）
 * - 校准：选/加按键 → 面板收起 → 鼠标点游戏按钮 → 自动保存并重新展开
 * - keymap（存 config.json，按版本）：
 *   { "Space": { "action": "攻击", "type": "hold", "pos": [x, y] }, ... }
 *   type: hold（按住持续）| tap（按下触发一次）；pos 为画布比例坐标
 */
(function () {
  'use strict';
  const API = window.__launcher;
  if (!API || !API.getKeymap) return;

  const DEFAULT_KEYS = {
    Space: { action: '攻击', type: 'hold' },
    KeyE: { action: '交互', type: 'hold' },
    KeyB: { action: '背包', type: 'tap' }
  };
  const S = {
    panel: 'position:fixed;left:14px;bottom:14px;z-index:2147483647;width:340px;max-width:86vw;background:rgba(22,24,28,.96);border:1px solid #4a4f57;border-radius:10px;color:#eef0f4;font:13px/1.7 "Microsoft YaHei",sans-serif;padding:14px 16px;box-shadow:0 10px 34px rgba(0,0,0,.55);user-select:none;',
    title: 'font-weight:700;font-size:14px;margin-bottom:2px;',
    tip: 'color:#9aa0aa;font-size:12px;margin-bottom:10px;',
    sel: 'width:100%;padding:7px 9px;background:#26292e;color:#eef0f4;border:1px solid #4a4f57;border-radius:7px;outline:none;margin-bottom:8px;',
    input: 'padding:7px 9px;background:#26292e;color:#eef0f4;border:1px solid #4a4f57;border-radius:7px;outline:none;box-sizing:border-box;font-size:12.5px;',
    status: 'font-size:12px;color:#8d919a;min-height:18px;',
    btn: 'padding:7px 12px;background:#3a3f47;color:#eef0f4;border:1px solid #4a4f57;border-radius:7px;cursor:pointer;font-size:12.5px;',
    hint: 'position:fixed;z-index:2147483646;pointer-events:none;background:rgba(22,24,28,.92);border:1px solid #5a5f68;color:#eef0f4;border-radius:6px;padding:3px 9px;font:12px/1.5 "Microsoft YaHei",sans-serif;white-space:nowrap;',
    cross: 'position:fixed;z-index:2147483646;pointer-events:none;width:24px;height:24px;border:2px solid rgba(255,255,255,.9);border-radius:50%;transform:translate(-50%,-50%);'
  };

  let keymap = null;
  let pressed = {};
  let canvas = null;
  let warnShown = false;
  let panel = null;
  let panelMap = null;
  let panelSel = null;
  let captureCleanup = null;
  let addKeyInput = null;   // 添加按键输入框（全局捕获用）
  let armingKey = false;    // 已点击输入框，等待按目标键

  /** 键位代码归一化：兼容 e.code 缺失、大小写、单字母输入（m -> KeyM） */
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

  function getCanvas() {
    if (canvas && canvas.isConnected) return canvas;
    canvas = document.getElementById('c2canvas') || document.querySelector('canvas');
    return canvas;
  }

  /** 在画布比例坐标 (fx, fy) 派发按下/松开（pointer + mouse + touch） */
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
      c.dispatchEvent(new MouseEvent(down ? 'mousedown' : 'mouseup', {
        bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
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

  function isTyping() {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA');
  }

  function keyDown(e) {
    if (e.repeat || !keymap || isTyping() || captureCleanup || armingKey) return;
    const entry = keymap[e.code] || keymap[codeFromEvent(e)];
    if (!entry) return;
    e.preventDefault();
    if (!entry.pos) {
      if (!warnShown) { console.warn('[mapper] 按键 ' + e.code + '（' + (entry.action || '') + '）未校准位置，游戏内按 F10 校准'); warnShown = true; }
      return;
    }
    const c = getCanvas();
    if (!c) return;
    pressed[e.code] = true;
    if (entry.type === 'tap') {
      dispatchAt(c, entry.pos[0], entry.pos[1], true);
      setTimeout(function () {
        if (pressed[e.code]) { pressed[e.code] = false; dispatchAt(c, entry.pos[0], entry.pos[1], false); }
      }, 90);
    } else {
      dispatchAt(c, entry.pos[0], entry.pos[1], true);
    }
  }
  function keyUp(e) {
    if (!keymap || isTyping() || armingKey) return;
    const entry = keymap[e.code] || keymap[codeFromEvent(e)];
    if (!entry || !pressed[e.code]) return;
    e.preventDefault();
    pressed[e.code] = false;
    const c = getCanvas();
    if (!c || entry.type === 'tap') return;
    dispatchAt(c, entry.pos[0], entry.pos[1], false);
  }
  window.addEventListener('keydown', keyDown, true);
  window.addEventListener('keyup', keyUp, true);

  // ================= 校准 =================
  function persist(map, msg, statusEl) {
    API.saveKeymap(map).catch(function () {});
    if (panelSel) refreshSel(map);
    if (statusEl && msg) statusEl.textContent = msg;
  }

  function refreshSel(map) {
    if (!panelSel) return;
    const prev = panelSel.value;
    panelSel.innerHTML = '';
    Object.keys(map).forEach(function (code) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = (map[code].action || code) + ' (' + code + ')' + (map[code].pos ? '  ✓' : '  ✗');
      panelSel.appendChild(o);
    });
    if (prev && map[prev]) panelSel.value = prev;
  }

  /** 开始捕获：收起面板，十字准星跟随鼠标，点击画布即记录坐标 */
  function startCapture(map, code, statusEl) {
    cancelCapture();
    const c = getCanvas();
    if (!c) { if (statusEl) statusEl.textContent = '未找到画布'; return; }

    if (panel) panel.style.display = 'none';
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
      const inCanvas = fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1;
      cross.style.left = e.clientX + 'px';
      cross.style.top = e.clientY + 'px';
      cross.style.borderColor = inCanvas ? 'rgba(255,255,255,.9)' : 'rgba(255,90,90,.9)';
      hint.style.left = (e.clientX + 16) + 'px';
      hint.style.top = (e.clientY + 16) + 'px';
      hint.textContent = inCanvas
        ? '点击「' + (map[code].action || code) + '」(' + Math.round(fx * 100) + '%, ' + Math.round(fy * 100) + '%) · Esc 取消'
        : '移到画布内… · Esc 取消';
    }
    function onClick(e) {
      if (panel && panel.contains(e.target)) return;
      const rect = c.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return; // 画布外忽略
      map[code].pos = [+fx.toFixed(4), +fy.toFixed(4)];
      cancelCapture();
      persist(map, null, null);
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
      hint.remove();
      cross.remove();
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('mouseup', onClick, true);
      document.removeEventListener('pointerup', onClick, true);
      window.removeEventListener('keydown', onCancel, true);
      captureCleanup = null;
    };
  }

  function cancelCapture() {
    if (captureCleanup) { const fn = captureCleanup; captureCleanup = null; fn(); }
  }

  function closePanel() {
    cancelCapture();
    if (panel) { panel.remove(); panel = null; panelMap = null; panelSel = null; }
    addKeyInput = null;
    armingKey = false;
  }

  function openPanel() {
    if (panel && panel.isConnected) { panel.style.display = 'block'; return; }
    buildPanel();
  }

  function buildPanel() {
    const map = keymap ? JSON.parse(JSON.stringify(keymap)) : {};
    for (const code of Object.keys(DEFAULT_KEYS)) {
      if (!map[code]) map[code] = { action: DEFAULT_KEYS[code].action, type: DEFAULT_KEYS[code].type, pos: null };
    }
    panelMap = map;

    const p = document.createElement('div');
    p.id = 'mdz-keycal';
    p.style.cssText = S.panel;
    const title = document.createElement('div');
    title.style.cssText = S.title;
    title.innerHTML = '🎹 键盘映射校准 <span style="color:#9aa0aa;font-weight:400;font-size:12px;">F10 开关 · Esc 关闭</span>';
    const tip = document.createElement('div');
    tip.style.cssText = S.tip;
    tip.innerHTML = '选择按键后<b>面板自动收起</b>，点击游戏里对应按钮即完成绑定；Delete 清除所选。';
    const sel = document.createElement('select');
    sel.style.cssText = S.sel;
    panelSel = sel;
    const status = document.createElement('div');
    status.style.cssText = S.status;

    // 添加新按键
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px dashed #3a3f47;margin:10px 0 8px;';
    const addTip = document.createElement('div');
    addTip.style.cssText = 'color:#6f737b;font-size:11px;margin-bottom:6px;';
    addTip.textContent = '添加按键：点输入框后直接按下要绑定的键（如 M、F、1、Shift），填名称，选按住/单击，点「添加」再点游戏按钮。';
    const addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex;gap:8px;align-items:center;';
    const keyInp = document.createElement('input');
    keyInp.placeholder = '按键';
    keyInp.style.cssText = S.input + ';flex:1.1;';
    addKeyInput = keyInp;
    keyInp.addEventListener('focus', function () { armingKey = true; });
    keyInp.addEventListener('blur', function () { armingKey = false; });
    const actInp = document.createElement('input');
    actInp.placeholder = '名称';
    actInp.style.cssText = S.input + ';flex:1;';
    const typeSel = document.createElement('select');
    typeSel.innerHTML = '<option value="hold">按住</option><option value="tap">单击</option>';
    typeSel.style.cssText = S.sel + ';flex:0.85;margin-bottom:0;';
    const addBtn = document.createElement('button');
    addBtn.textContent = '添加';
    addBtn.style.cssText = S.btn;
    addRow.append(keyInp, actInp, typeSel, addBtn);

    p.append(title, tip, sel, status, sep, addTip, addRow);
    document.body.appendChild(p);
    panel = p;

    addBtn.onclick = function () {
      const code = keyInp.value.trim();
      const act = actInp.value.trim() || code;
      if (!code) { status.textContent = '先点击按键输入框并按下要绑定的键'; return; }
      map[code] = { action: act, type: typeSel.value, pos: (map[code] && map[code].pos) ? map[code].pos : null };
      keyInp.value = '';
      actInp.value = '';
      refreshSel(map);
      sel.value = code;
      status.textContent = '已添加 ' + code + '（' + act + '），点击游戏里的按钮位置…';
      startCapture(map, code, status);
    };

    sel.onchange = function () {
      const code = sel.value;
      if (!code) return;
      status.textContent = '点击画面上「' + (map[code].action || code) + '」按钮位置…';
      startCapture(map, code, status);
    };

    refreshSel(map);
    status.textContent = '选择按键开始校准，或添加新按键。';
  }

  // ================= 全局：F10 开关 =================
  // 添加按键捕获：点输入框后（即使失焦）任意位置按目标键都有效
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

  window.addEventListener('keydown', function (e) {
    if (e.code === 'F10') {
      e.preventDefault();
      if (armingKey) { armingKey = false; if (addKeyInput) addKeyInput.blur(); }
      if (captureCleanup) {
        cancelCapture();
        if (panel) { panel.style.display = 'block'; }
      } else if (panel && panel.isConnected) {
        closePanel();
      } else {
        openPanel();
      }
      return;
    }
    if (e.code === 'Escape' && panel && panel.isConnected && !captureCleanup) closePanel();
    if (e.code === 'Delete' && panel && panel.isConnected && !captureCleanup && panelSel && panelSel.value) {
      delete panelMap[panelSel.value];
      persist(panelMap, null, null);
      refreshSel(panelMap);
    }
  }, true);

  // ================= 启动 =================
  API.getKeymap().then(function (m) {
    keymap = (m && typeof m === 'object' && Object.keys(m).length) ? m : null;
    if (API.calibrate) openPanel();
  }).catch(function () {
    if (API.calibrate) openPanel();
  });
})();
