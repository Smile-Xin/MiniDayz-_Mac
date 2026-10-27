'use strict';
/**
 * trainer.js —— MiniDayZ+ 游戏内修改器（覆盖层）
 * ============================================================================
 * 这个脚本不修改游戏文件、不碰存档文件，只在游戏运行时读写内存里的数值：
 *
 *   1) C2 全局变量：rt.tD 是运行时全局变量表（每项 { name, data }），
 *      name 没被混淆（God_mode / karma_points / perk_* …），按名字直接读写；
 *   2) 玩家实例变量：玩家状态对象是一个「只有一个实例、带 50 个左右实例变量」的
 *      逻辑对象，其中连续 4 个是 [饥饿, 口渴, 生命, 体温]。它没有名字（导出时被混淆），
 *      所以用「数值形态 + 时间衰减」自动定位，并把结果按游戏签名缓存下来。
 *
 * 注入方式（两种窗口都支持）：
 *   · 壳页窗口：game-window.html 里 iframe 加载完成后由壳页注入到顶层窗口；
 *   · 直开窗口：主进程 dom-ready 后 executeJavaScript 注入。
 * 脚本始终跑在「顶层窗口」，通过同源 iframe 访问游戏运行时，因此面板不受画布缩放影响。
 */
(function () {
  if (window.__mdzTrainer) { window.__mdzTrainer.toggle(); return; }

  /* ==========================================================================
   * 常量
   * ======================================================================== */

  var STORE_KEY = '__mdz_trainer_v1';
  // 定位缓存分版本：旧版本用宽松规则写进去的错位记录必须作废，否则会一直被沿用
  var PROFILE_KEY = '__mdz_trainer_profiles_v2';
  var PROFILE_KEY_OLD = '__mdz_trainer_profiles';
  var CSS_HREF = 'app://game/_launcher/trainer/trainer.css';
  var DEFAULT_HOTKEY = 'F8';
  var TICK_MS = 120;          // 锁定刷新间隔：够快，又不至于拖慢游戏循环
  var UI_REFRESH_MS = 500;    // 面板数值刷新间隔

  /**
   * 玩家状态对象的实例变量个数下限。
   * 实测：对局中的玩家对象有 53 个实例变量；而主菜单里那些「看起来像状态」的
   * 系统对象分别只有 41 个（t556）和 33 个（t829）。用个数做硬门槛，
   * 比靠数值区间猜要可靠得多——菜单里的 0/0/1/8 序列在数值上是「合法」的。
   */
  var MIN_PLAYER_VARS = 45;

  /** 玩家状态字段 → 实例变量下标映射（本构建实测值，profile 里可覆盖） */
  var STAT_KEYS = ['food', 'water', 'hp', 'temp'];
  var STAT_LABELS = { food: '饥饿', water: '口渴', hp: '生命', temp: '体温' };
  /**
   * 关键：这四个状态在本游戏里**不是连续排列的**。
   * 实测（mdz-cangshu-v233）：饥饿 13、口渴 14、体温 16、生命 50；
   * 而 13/14 后面的 15 是一个滚动计数器（每帧上涨、会归零），16 之后也不是生命。
   * 之前按「连续 4 个」去找，才会出现「生命 13750」这种离谱读数。
   */
  var DEFAULT_OFFSETS = { food: 13, water: 14, hp: 50, temp: 16 };
  /**
   * 真正实测过 DEFAULT_OFFSETS 的游戏构建（签名 = 对象类型数:全局变量数）。
   * 不在表里的构建仍会用默认偏移，但界面上会标注「未校核」——
   * 宁可让用户看到提示，也不要悄悄往错误字段写数值。
   */
  var VERIFIED_SIGS = { '1429:610': true };   // mdz-cangshu-v233

  /** 「敌人伤害归零」涉及的全局变量（默认值在启用时记录，关闭时还原） */
  var DAMAGE_VARS = ['Zed_dmg', 'Zed_army_dmg', 'Zed_fast_dmg', 'Wolf_dmg'];

  /** 掉落 / 刷新相关的默认值（原版数值，作为关闭时的还原值兜底） */
  var LOOT_VAR = 'LOOT_RESPAWN_TIME';
  var LOOT_FAST = 60;
  var LOOT_DEFAULT = 1480;
  var ZED_RESPAWN_VAR = 'ZED_RESPAWN_TIME';
  var ZED_SLOW = 600;
  var ZED_DEFAULT = 60;

  /* ==========================================================================
   * 设置（localStorage，跨版本共享；锁定的开关与数值会被记住）
   * ======================================================================== */

  var DEFAULTS = {
    open: true,
    tab: 'player',
    collapsed: false,
    locks: {
      hp: { on: false, value: 100 },
      food: { on: false, value: 100 },
      water: { on: false, value: 100 },
      temp: { on: false, value: 100 }
    },
    god: false,
    noDamage: false,
    debug: false,
    time: { freeze: false, value: 480 },
    rain: false,
    fastLoot: false,
    slowZeds: false
  };

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function loadSettings() {
    var base = clone(DEFAULTS);
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return base;
      var saved = JSON.parse(raw);
      // 只覆盖已知字段，避免旧版本残留字段污染
      Object.keys(DEFAULTS).forEach(function (key) {
        if (!(key in saved)) return;
        if (key === 'locks') {
          STAT_KEYS.forEach(function (k) {
            var v = saved.locks && saved.locks[k];
            if (v && typeof v === 'object') {
              base.locks[k].on = !!v.on;
              if (isFinite(v.value)) base.locks[k].value = clamp(v.value, 0, 100);
            }
          });
        } else if (key === 'time') {
          if (saved.time && typeof saved.time === 'object') {
            base.time.freeze = !!saved.time.freeze;
            if (isFinite(saved.time.value)) base.time.value = clamp(saved.time.value, 0, 1439);
          }
        } else if (typeof base[key] === 'boolean') {
          base[key] = !!saved[key];
        } else {
          base[key] = saved[key];
        }
      });
    } catch (e) { /* 存储损坏就用默认值 */ }
    return base;
  }

  var settings = loadSettings();

  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* 忽略写入失败 */ }
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ==========================================================================
   * 运行时访问：顶层窗口 → 游戏窗口 → C2 运行时
   * ======================================================================== */

  /**
   * 找承载 C2 运行时的窗口。
   * 两种壳页都要支持：独立游戏窗口（game-window.html 里的 iframe）、
   * 启动器内嵌播放（index.html 里的 #embed-frame）。
   */
  function gameWindow() {
    var cands = [];
    try {
      var emb = document.getElementById('embed-frame');
      if (emb) cands.push(emb);
      var all = document.querySelectorAll('iframe');
      for (var i = 0; i < all.length; i++) if (all[i] !== emb) cands.push(all[i]);
    } catch (e) { /* 忽略 */ }

    for (var n = 0; n < cands.length; n++) {
      try {
        var w = cands[n].contentWindow;
        if (w && w.cr_getC2Runtime) return w;
      } catch (e2) { /* 跨域/未加载 */ }
    }
    if (window.cr_getC2Runtime) return window;
    return null;
  }

  function getRuntime() {
    var w = gameWindow();
    if (!w) return null;
    try { return w.cr_getC2Runtime() || null; } catch (e) { return null; }
  }

  var gvRuntime = null;
  var gvMap = null;
  var gvCount = -1;

  /**
   * 全局变量表（rt.tD 里 name 未混淆；按运行时对象缓存）。
   * 缓存要连「条目数」一起比：C2 的运行时对象先创建、全局变量表随后才填满，
   * 只比运行时对象的话，早期缓存下来的空表会一直用下去（表现为变量列表空白）。
   */
  function globalVars(rt) {
    var count = rt.tD ? rt.tD.length : 0;
    if (gvRuntime === rt && gvMap && gvCount === count) return gvMap;
    gvRuntime = rt;
    gvCount = count;
    gvMap = {};
    (rt.tD || []).forEach(function (item) {
      if (item && item.name) gvMap[item.name] = item;
    });
    return gvMap;
  }

  function gGet(name) {
    var rt = getRuntime();
    if (!rt) return null;
    var item = globalVars(rt)[name];
    return item ? item.data : null;
  }

  function gSet(name, value) {
    var rt = getRuntime();
    if (!rt) return false;
    var item = globalVars(rt)[name];
    if (!item) return false;
    item.data = value;
    return true;
  }

  /* ==========================================================================
   * 玩家状态定位
   * ======================================================================== */

  var player = {
    runtime: null,   // 定位时使用的运行时对象
    typeName: '',    // 具体对象类型（t181 这类混淆名）
    inst: null,      // 实例
    off: null,       // 四个状态字段 → 实例变量下标
    verified: false  // 该构建的偏移是否经过实测校核
  };

  /** 游戏签名：用于区分不同版本/不同构建，缓存定位结果 */
  function gameSignature(rt) {
    var types = rt.types ? Object.keys(rt.types).length : 0;
    var vars = rt.tD ? rt.tD.length : 0;
    return types + ':' + vars;
  }

  var profiles = null;

  function loadProfiles() {
    if (profiles) return profiles;
    try {
      profiles = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}') || {};
    } catch (e) { profiles = {}; }
    // 顺手清掉旧版本的错误缓存
    try { localStorage.removeItem(PROFILE_KEY_OLD); } catch (e) { /* 忽略 */ }
    return profiles;
  }

  function saveProfile(sig, prof) {
    try {
      var all = loadProfiles();
      all[sig] = prof;
      localStorage.setItem(PROFILE_KEY, JSON.stringify(all));
    } catch (e) { /* 忽略 */ }
  }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /** 四个下标处必须都是「像状态」的数字，否则说明这个对象/偏移不成立 */
  function offsetsSane(cc, off) {
    if (!off) return false;
    for (var k = 0; k < STAT_KEYS.length; k++) {
      var v = cc[off[STAT_KEYS[k]]];
      if (!isNum(v) || v < -5 || v > 130) return false;
    }
    return true;
  }

  /**
   * 找玩家状态对象：单实例 + 具体类型（排除 family 聚合）+ 实例变量数够多。
   * 变量下标不做「连续 4 个」的猜测，直接用 DEFAULT_OFFSETS / profile 里的映射，
   * 再用 offsetsSane 复核这几个位置确实是合理数值。
   */
  function detectPlayer(rt) {
    var names = rt.types ? Object.keys(rt.types) : [];

    for (var n = 0; n < names.length; n++) {
      var type = rt.types[names[n]];
      if (!type || !type.q || type.q.length !== 1) continue;

      var inst = type.q[0];
      if (!inst || !inst.cc || inst.cc.length < MIN_PLAYER_VARS) continue;
      if (inst.type !== type) continue;                       // family：跳过
      if (!offsetsSane(inst.cc, DEFAULT_OFFSETS)) continue;   // 状态位不像

      return { typeName: names[n], len: inst.cc.length, off: DEFAULT_OFFSETS };
    }
    return null;
  }

  var lastScanAt = 0;

  /** 用缓存/自动定位结果绑定玩家实例；找不到就返回 null */
  function ensurePlayer(rt) {
    if (!rt) return null;

    // 已绑定的实例还活着就直接复用
    if (player.runtime === rt && player.inst) {
      var cachedType = rt.types && rt.types[player.typeName];
      if (cachedType && cachedType.q && cachedType.q[0] === player.inst &&
          player.inst.cc && offsetsSane(player.inst.cc, player.off)) {
        return player.inst;
      }
      player.inst = null;
    }

    var sig = gameSignature(rt);
    var prof = loadProfiles()[sig];
    if (prof && prof.typeName && prof.off && isFinite(prof.len)) {
      var t = rt.types && rt.types[prof.typeName];
      var inst = t && t.q && t.q[0];
      // 缓存要连「变量个数 + 四个状态位」一起校验：换版本/变量顺序变了就不能盲信
      if (inst && inst.cc && prof.len >= MIN_PLAYER_VARS &&
          inst.cc.length === prof.len && offsetsSane(inst.cc, prof.off)) {
        player.runtime = rt;
        player.typeName = prof.typeName;
        player.inst = inst;
        player.off = prof.off;
        player.verified = !!VERIFIED_SIGS[sig];
        return inst;
      }
    }

    // 菜单 / 未进对局时没有玩家对象：全量扫描很贵，最多每秒一次
    var now = Date.now();
    if (now - lastScanAt < 1000) return null;
    lastScanAt = now;

    var found = detectPlayer(rt);
    if (!found) return null;

    player.runtime = rt;
    player.typeName = found.typeName;
    player.inst = rt.types[found.typeName].q[0];
    player.off = found.off;
    player.verified = !!VERIFIED_SIGS[sig];
    saveProfile(sig, { typeName: found.typeName, off: found.off, len: found.len });
    return player.inst;
  }

  function readStat(key) {
    var inst = player.inst;
    if (!inst || !inst.cc || !player.off) return null;
    var v = inst.cc[player.off[key]];
    return isNum(v) ? v : null;
  }

  function writeStat(key, value) {
    var inst = player.inst;
    if (!inst || !inst.cc || !player.off) return false;
    var idx = player.off[key];
    if (!isFinite(idx)) return false;
    inst.cc[idx] = value;
    return true;
  }

  /* ==========================================================================
   * 功能：应用 / 撤销
   * ======================================================================== */

  /** 记录功能开启前的原值，关闭时还原（避免把玩家的世界设置永久改坏） */
  var originals = {};

  function remember(name) {
    if (!(name in originals)) originals[name] = gGet(name);
  }

  function restore(name, fallback) {
    if (name in originals && originals[name] !== null) gSet(name, originals[name]);
    else if (typeof fallback !== 'undefined') gSet(name, fallback);
    delete originals[name];
  }

  /** 一次性写入（不会每帧重复），用于开关类功能 */
  function applyStaticToggles() {
    // 上帝模式 / 调试模式：每帧兜底重写，防止被游戏逻辑重置
    gSet('God_mode', settings.god ? 1 : 0);
    gSet('Debug_mode', settings.debug ? 1 : 0);

    // 敌人伤害归零（只在「启用时记录过原值」的情况下还原，避免每帧覆盖游戏自身数值）
    if (settings.noDamage) {
      DAMAGE_VARS.forEach(function (name) { remember(name); gSet(name, 0); });
    } else {
      DAMAGE_VARS.forEach(function (name) { if (name in originals) restore(name, 6); });
    }

    // 掉落刷新加速
    if (settings.fastLoot) { remember(LOOT_VAR); gSet(LOOT_VAR, LOOT_FAST); }
    else if (LOOT_VAR in originals) restore(LOOT_VAR, LOOT_DEFAULT);

    // 僵尸刷新变慢
    if (settings.slowZeds) { remember(ZED_RESPAWN_VAR); gSet(ZED_RESPAWN_VAR, ZED_SLOW); }
    else if (ZED_RESPAWN_VAR in originals) restore(ZED_RESPAWN_VAR, ZED_DEFAULT);

    // 下雨
    if (settings.rain) { remember('Rain'); gSet('Rain', 1); }
    else if ('Rain' in originals) restore('Rain', 0);
  }

  /** 每 TICK_MS 调用一次：应用锁定值 */
  function tick() {
    var rt = getRuntime();
    if (!rt) { setStatus('wait', '等待游戏…'); return; }

    ensurePlayer(rt);
    applyStaticToggles();

    // 角色状态锁定
    var lockedCount = 0;
    STAT_KEYS.forEach(function (key) {
      if (!settings.locks[key].on) return;
      if (writeStat(key, settings.locks[key].value)) lockedCount++;
    });

    if (settings.time.freeze) gSet('Timer_ALL', settings.time.value);

    if (!player.inst) setStatus('warn', '未进入对局');
    else if (lockedCount || settings.time.freeze) setStatus('ok', '锁定中');
    else setStatus('ok', '已连接');
  }

  /* ==========================================================================
   * UI
   * ======================================================================== */

  var ui = {
    root: null,
    pill: null,
    toastTimer: 0,
    body: null
  };

  var HOTKEY = (window.__mdzTrainerHotkey || DEFAULT_HOTKEY).toUpperCase();

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }

  function injectStyle() {
    if (document.getElementById('mdz-tr-css')) return;
    var link = document.createElement('link');
    link.id = 'mdz-tr-css';
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    (document.head || document.documentElement).appendChild(link);
  }

  function setStatus(kind, text) {
    if (!ui.root) return;
    var node = ui.root.querySelector('.mdz-tr-state');
    if (!node) return;
    node.className = 'mdz-tr-state ' + (kind === 'ok' ? 'ok' : (kind === 'warn' ? 'warn' : ''));
    node.textContent = text;
  }

  function toast(text) {
    var node = document.getElementById('mdz-tr-toast');
    if (!node) {
      node = el('div', '', '');
      node.id = 'mdz-tr-toast';
      document.body.appendChild(node);
    }
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(function () { node.classList.remove('show'); }, 1600);
  }

  /* ---------------------------------------------------------------- 面板骨架 */

  var TABS = [
    { id: 'player', label: '角色' },
    { id: 'world', label: '世界' },
    { id: 'progress', label: '成长' },
    { id: 'debug', label: '调试' }
  ];

  function buildPanel() {
    var root = el('div', '');
    root.id = 'mdz-trainer';

    var tabsHtml = TABS.map(function (tab) {
      return '<button class="mdz-tr-tab' + (settings.tab === tab.id ? ' active' : '') +
        '" data-tab="' + tab.id + '">' + tab.label + '</button>';
    }).join('');

    root.innerHTML =
      '<div class="mdz-tr-head">' +
        '<div class="mdz-tr-logo">M</div>' +
        '<div class="mdz-tr-title">MDZ 修改器</div>' +
        '<div class="mdz-tr-state">初始化…</div>' +
        '<button class="mdz-tr-icon" data-act="collapse" title="收起">—</button>' +
        '<button class="mdz-tr-icon" data-act="close" title="关闭（' + HOTKEY + ' 重新打开）">×</button>' +
      '</div>' +
      '<div class="mdz-tr-tabs">' + tabsHtml + '</div>' +
      '<div class="mdz-tr-body">' +
        panePlayer() +
        paneWorld() +
        paneProgress() +
        paneDebug() +
      '</div>' +
      '<div class="mdz-tr-foot">' +
        '<span>按<span class="mdz-tr-kbd">' + HOTKEY + '</span>显示 / 隐藏</span>' +
        '<span style="margin-left:auto">锁定类功能每 120ms 生效</span>' +
      '</div>';

    document.body.appendChild(root);
    ui.root = root;
    ui.body = root.querySelector('.mdz-tr-body');
    bindPanelEvents(root);
    applyTabVisibility();
    if (settings.collapsed) root.classList.add('mdz-tr-collapsed');
    if (!settings.open) { root.style.display = 'none'; showPill(); }
  }

  function panePlayer() {
    return '' +
      '<div class="mdz-tr-pane' + (settings.tab === 'player' ? ' active' : '') + '" data-pane="player">' +
        '<div class="mdz-tr-group-title">状态锁定</div>' +
        statRow('hp', '生命', 1, 100) +
        statRow('food', '饥饿', 0, 100) +
        statRow('water', '口渴', 0, 100) +
        statRow('temp', '体温', 0, 100) +
        '<div class="mdz-tr-btns">' +
          '<button class="mdz-tr-btn" data-act="heal">全恢复（F9）</button>' +
          '<button class="mdz-tr-btn ghost" data-act="lockAll">全部锁定</button>' +
        '</div>' +
        '<div class="mdz-tr-group-title">战斗</div>' +
        toggleRow('god', '上帝模式', '游戏内置开关 God_mode=1') +
        toggleRow('noDamage', '敌人伤害归零', '僵尸 / 军装僵尸 / 跑尸 / 狼') +
        '<div class="mdz-tr-tip">数值直接写在运行中的游戏对象上；游戏内保存后才会写入存档。</div>' +
      '</div>';
  }

  function paneWorld() {
    return '' +
      '<div class="mdz-tr-pane' + (settings.tab === 'world' ? ' active' : '') + '" data-pane="world">' +
        '<div class="mdz-tr-group-title">时间</div>' +
        '<div class="mdz-tr-row">' +
          '<div class="mdz-tr-label">当前时刻<small>拖动后立即生效（游戏内时间会继续走）</small></div>' +
          '<div class="mdz-tr-val" data-bind="clock">--:--</div>' +
        '</div>' +
        '<div class="mdz-tr-row">' +
          '<div class="mdz-tr-slider"><input type="range" min="0" max="1439" step="10" data-act="timeSlider" value="' + settings.time.value + '"></div>' +
        '</div>' +
        '<div class="mdz-tr-btns">' +
          '<button class="mdz-tr-btn ghost" data-act="time" data-value="360">06:00</button>' +
          '<button class="mdz-tr-btn ghost" data-act="time" data-value="720">12:00</button>' +
          '<button class="mdz-tr-btn ghost" data-act="time" data-value="1080">18:00</button>' +
          '<button class="mdz-tr-btn ghost" data-act="time" data-value="0">00:00</button>' +
        '</div>' +
        '<div class="mdz-tr-row">' +
          '<div class="mdz-tr-label">冻结时间<small>持续写回同一时刻（游戏会自己推进时间）</small></div>' +
          '<label class="mdz-tr-switch"><input type="checkbox" data-toggle="timeFreeze"' + (settings.time.freeze ? ' checked' : '') + '><span></span></label>' +
        '</div>' +
        '<div class="mdz-tr-group-title">环境</div>' +
        toggleRow('rain', '下雨', '全局 Rain=1（画面与体温会同步变化）') +
        '<div class="mdz-tr-group-title">刷新</div>' +
        toggleRow('fastLoot', '物资快速刷新', 'LOOT_RESPAWN_TIME → 60 秒') +
        toggleRow('slowZeds', '僵尸刷新变慢', 'ZED_RESPAWN_TIME → 600 秒') +
      '</div>';
  }

  function paneProgress() {
    return '' +
      '<div class="mdz-tr-pane' + (settings.tab === 'progress' ? ' active' : '') + '" data-pane="progress">' +
        '<div class="mdz-tr-group-title">点数</div>' +
        '<div class="mdz-tr-row">' +
          '<div class="mdz-tr-label">业力<small>karma_points</small></div>' +
          '<input class="mdz-tr-num" type="number" data-num="karma_points" placeholder="—">' +
          '<button class="mdz-tr-btn" data-act="applyKarma">写入</button>' +
        '</div>' +
        '<div class="mdz-tr-row">' +
          '<div class="mdz-tr-label">经验<small>expierence_points</small></div>' +
          '<input class="mdz-tr-num" type="number" data-num="expierence_points" placeholder="—">' +
          '<button class="mdz-tr-btn" data-act="applyExp">写入</button>' +
        '</div>' +
        '<div class="mdz-tr-btns">' +
          '<button class="mdz-tr-btn ghost" data-act="readProgress">读取当前值</button>' +
        '</div>' +
        '<div class="mdz-tr-group-title">特长</div>' +
        '<div class="mdz-tr-btns">' +
          '<button class="mdz-tr-btn" data-act="unlockPerks">一键解锁全部 perk</button>' +
        '</div>' +
        '<div class="mdz-tr-tip">解锁会把这些 perk 变量设为 1（跳过 perk_cost / *_time 这类非开关变量）。' +
          '部分特长的效果要重新进入对局或重载页面后才会体现。</div>' +
      '</div>';
  }

  function paneDebug() {
    return '' +
      '<div class="mdz-tr-pane' + (settings.tab === 'debug' ? ' active' : '') + '" data-pane="debug">' +
        '<div class="mdz-tr-group-title">诊断</div>' +
        '<div class="mdz-tr-diag" data-bind="diag">正在读取…</div>' +
        '<div class="mdz-tr-btns">' +
          '<button class="mdz-tr-btn ghost" data-act="recalibrate">重新定位玩家</button>' +
          '<button class="mdz-tr-btn ghost" data-act="reloadGame">重新载入游戏页</button>' +
        '</div>' +
        toggleRow('debug', '调试模式', 'Debug_mode=1') +
        '<div class="mdz-tr-group-title">全局变量</div>' +
        '<input class="mdz-tr-num mdz-tr-search" type="text" data-act="gvSearch" placeholder="搜索变量名，如 perk / Zed / Timer">' +
        '<div class="mdz-tr-gv-list" data-bind="gvList"></div>' +
      '</div>';
  }

  function statRow(key, label, min, max) {
    var lock = settings.locks[key];
    return '' +
      '<div class="mdz-tr-row">' +
        '<div class="mdz-tr-label">' + label + '</div>' +
        '<div class="mdz-tr-val" data-bind="stat-' + key + '">—</div>' +
        '<div class="mdz-tr-slider"><input type="range" min="' + min + '" max="' + max + '" step="1" ' +
          'data-lock="' + key + '" value="' + lock.value + '"></div>' +
        '<label class="mdz-tr-switch"><input type="checkbox" data-lockon="' + key + '"' + (lock.on ? ' checked' : '') + '><span></span></label>' +
      '</div>';
  }

  function toggleRow(key, label, hint) {
    return '' +
      '<div class="mdz-tr-row">' +
        '<div class="mdz-tr-label">' + label + '<small>' + hint + '</small></div>' +
        '<label class="mdz-tr-switch"><input type="checkbox" data-toggle="' + key + '"' + (settings[key] ? ' checked' : '') + '><span></span></label>' +
      '</div>';
  }

  function showPill() {
    if (ui.pill) { ui.pill.style.display = 'block'; return; }
    var pill = el('button', '', 'MDZ 修改器（' + HOTKEY + '）');
    pill.id = 'mdz-trainer-pill';
    pill.addEventListener('click', function () { show(true); });
    document.body.appendChild(pill);
    ui.pill = pill;
  }

  function hidePill() {
    if (ui.pill) ui.pill.style.display = 'none';
  }

  function show(force) {
    settings.open = true;
    saveSettings();
    if (!ui.root) buildPanel();
    ui.root.style.display = 'flex';
    hidePill();
    if (force) refreshLiveValues();
  }

  function hide() {
    settings.open = false;
    saveSettings();
    if (ui.root) ui.root.style.display = 'none';
    showPill();
  }

  function toggle() {
    if (settings.open) hide(); else show(true);
  }

  function applyTabVisibility() {
    if (!ui.root) return;
    var tabs = ui.root.querySelectorAll('.mdz-tr-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === settings.tab);
    }
    var panes = ui.root.querySelectorAll('.mdz-tr-pane');
    for (var j = 0; j < panes.length; j++) {
      panes[j].classList.toggle('active', panes[j].getAttribute('data-pane') === settings.tab);
    }
    if (settings.tab === 'progress') readProgress();
    if (settings.tab === 'debug') { renderDiag(); renderGlobalList(''); }
  }

  /* ---------------------------------------------------------------- 事件绑定 */

  function bindPanelEvents(root) {
    // 键盘事件在捕获阶段就地拦下：面板在直开窗口里和游戏同属一个 document，
    // 不拦的话输入框里的 WASD / 空格会同时驱动角色；同时在此处理全局变量编辑的 Enter。
    root.addEventListener('keydown', function (e) {
      var name = e.target.getAttribute && e.target.getAttribute('data-gv');
      if (name && e.key === 'Enter') commitGlobal(name, e.target.value);
      e.stopPropagation();
    }, true);
    ['keyup', 'keypress'].forEach(function (type) {
      root.addEventListener(type, function (e) { e.stopPropagation(); }, true);
    });

    root.addEventListener('click', function (e) {
      var tab = e.target.closest('.mdz-tr-tab');
      if (tab) {
        settings.tab = tab.getAttribute('data-tab');
        saveSettings();
        applyTabVisibility();
        return;
      }
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'collapse') {
        settings.collapsed = !settings.collapsed;
        root.classList.toggle('mdz-tr-collapsed', settings.collapsed);
        saveSettings();
      } else if (act === 'close') {
        hide();
      } else if (act === 'heal') {
        healAll();
      } else if (act === 'lockAll') {
        STAT_KEYS.forEach(function (k) { settings.locks[k].on = true; });
        saveSettings();
        syncLockInputs();
        toast('生命 / 饥饿 / 口渴 / 体温 已全部锁定');
      } else if (act === 'time') {
        setTime(Number(btn.getAttribute('data-value')));
      } else if (act === 'applyKarma') {
        writeNumberField('karma_points');
      } else if (act === 'applyExp') {
        writeNumberField('expierence_points');
      } else if (act === 'readProgress') {
        readProgress(true);
      } else if (act === 'unlockPerks') {
        unlockPerks();
      } else if (act === 'recalibrate') {
        recalibrate();
      } else if (act === 'reloadGame') {
        reloadGamePage();
      }
    });

    // 开关（锁定开关 + 功能开关）
    root.addEventListener('change', function (e) {
      var input = e.target;
      var lockKey = input.getAttribute('data-lockon');
      if (lockKey) {
        settings.locks[lockKey].on = input.checked;
        saveSettings();
        if (input.checked) healOnce(lockKey);
        return;
      }
      var toggle = input.getAttribute('data-toggle');
      if (!toggle) return;
      if (toggle === 'timeFreeze') {
        settings.time.freeze = input.checked;
        if (input.checked) settings.time.value = currentClockMinutes() || settings.time.value;
        saveSettings();
        toast(input.checked ? '时间已冻结' : '时间恢复流动');
        return;
      }
      settings[toggle] = input.checked;
      saveSettings();
      applyStaticToggles();
    });

    // 滑块（锁定值）
    root.addEventListener('input', function (e) {
      var key = e.target.getAttribute('data-lock');
      if (key) {
        settings.locks[key].value = Number(e.target.value);
        var label = root.querySelector('[data-bind="stat-' + key + '"]');
        if (label) label.textContent = settings.locks[key].value;
        saveSettings();
        writeStat(key, settings.locks[key].value);
        return;
      }
      if (e.target.getAttribute('data-act') === 'timeSlider') {
        setTime(Number(e.target.value));
      }
    });

    // 全局变量搜索
    root.addEventListener('input', function (e) {
      if (e.target.getAttribute('data-act') !== 'gvSearch') return;
      renderGlobalList(e.target.value.trim());
    });

    // 全局变量编辑（Enter 提交；输入框在 keydown 捕获阶段已就地处理）

    // 拖动
    var dragging = null;
    var head = root.querySelector('.mdz-tr-head');
    head.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) return;
      var rect = root.getBoundingClientRect();
      dragging = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      root.style.right = 'auto';
      root.style.left = rect.left + 'px';
      root.style.top = rect.top + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var x = clamp(e.clientX - dragging.dx, 0, window.innerWidth - 80);
      var y = clamp(e.clientY - dragging.dy, 0, window.innerHeight - 40);
      root.style.left = x + 'px';
      root.style.top = y + 'px';
    });
    window.addEventListener('mouseup', function () { dragging = null; });
  }

  function syncLockInputs() {
    if (!ui.root) return;
    STAT_KEYS.forEach(function (key) {
      var box = ui.root.querySelector('[data-lockon="' + key + '"]');
      if (box) box.checked = settings.locks[key].on;
      var slider = ui.root.querySelector('[data-lock="' + key + '"]');
      if (slider) slider.value = settings.locks[key].value;
    });
  }

  /* ---------------------------------------------------------------- 动作 */

  function healOnce(key) {
    var inst = ensurePlayer(getRuntime());
    if (!inst) { toast('还没进入游戏'); return; }
    writeStat(key, settings.locks[key].value);
  }

  function healAll() {
    var rt = getRuntime();
    if (!rt) { toast('还没进入游戏'); return; }
    if (!ensurePlayer(rt)) { toast('还没进入游戏'); return; }
    STAT_KEYS.forEach(function (key) {
      var target = settings.locks[key].on ? settings.locks[key].value : 100;
      writeStat(key, target);
    });
    refreshLiveValues();
    toast('生命 / 饥饿 / 口渴 / 体温 已恢复');
  }

  function currentClockMinutes() {
    var v = gGet('Timer_ALL');
    return isNum(v) ? v : null;
  }

  function setTime(minutes) {
    var value = clamp(Math.round(minutes), 0, 1439);
    settings.time.value = value;
    saveSettings();
    gSet('Timer_ALL', value);
    var slider = ui.root && ui.root.querySelector('[data-act="timeSlider"]');
    if (slider) slider.value = value;
    updateClockLabel(value);
  }

  function updateClockLabel(minutes) {
    if (!ui.root) return;
    var node = ui.root.querySelector('[data-bind="clock"]');
    if (!node) return;
    var v = isNum(minutes) ? minutes : currentClockMinutes();
    if (!isNum(v)) { node.textContent = '--:--'; return; }
    var h = Math.floor(v / 60) % 24;
    var m = Math.floor(v % 60);
    node.textContent = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function readProgress(showToast) {
    if (!gGet) return;
    var karma = gGet('karma_points');
    var exp = gGet('expierence_points');
    var karmaInput = ui.root && ui.root.querySelector('[data-num="karma_points"]');
    var expInput = ui.root && ui.root.querySelector('[data-num="expierence_points"]');
    if (karmaInput && isNum(karma)) karmaInput.value = Math.round(karma);
    if (expInput && isNum(exp)) expInput.value = Math.round(exp);
    if (showToast) toast('已读取：业力 ' + karma + ' / 经验 ' + exp);
  }

  function writeNumberField(name) {
    if (!ui.root) return;
    var input = ui.root.querySelector('[data-num="' + name + '"]');
    if (!input) return;
    var value = Number(input.value);
    if (!isFinite(value)) { toast('请输入数字'); return; }
    if (gSet(name, value)) toast(name + ' = ' + value);
    else toast('写入失败：' + name);
  }

  /** 全局变量编辑框提交：数字按数字写入，其它按字符串写入 */
  function commitGlobal(name, raw) {
    var value = (raw !== '' && isFinite(raw)) ? Number(raw) : raw;
    if (gSet(name, value)) toast(name + ' = ' + value);
    else toast('写入失败：' + name);
  }

  function unlockPerks() {
    var rt = getRuntime();
    if (!rt) { toast('还没进入游戏'); return; }
    var map = globalVars(rt);
    var names = [];
    Object.keys(map).forEach(function (name) {
      if (name.indexOf('perk_') !== 0) return;
      if (name === 'perk_cost' || /_time$/.test(name)) return;   // 这两类是数值不是开关
      if (!(map[name].data >= 1)) map[name].data = 1;            // 已经是更高等级的不要降回去
      names.push(name);
    });
    // 少数 perk_* 其实是「等级」而非开关，写进去后会被游戏自己改回，
    // 所以回读一次，把真正生效的数量如实报出来，不虚报。
    setTimeout(function () {
      var rt2 = getRuntime();
      if (!rt2) { toast('已写入 ' + names.length + ' 个 perk 变量'); return; }
      var map2 = globalVars(rt2);
      var kept = 0;
      names.forEach(function (n) { if (map2[n] && map2[n].data >= 1) kept++; });
      toast(kept === names.length
        ? ('已解锁全部 ' + names.length + ' 个 perk')
        : ('已解锁 ' + kept + ' / ' + names.length + ' 个 perk（其余由游戏逻辑接管）'));
    }, 800);
  }

  function recalibrate() {
    player.runtime = null;
    player.inst = null;
    player.off = null;
    var rt = getRuntime();
    if (!rt) { toast('还没进入游戏'); return; }
    // 丢掉签名对应的旧记录，强制重新扫描（否则会立刻又绑回同一条缓存）
    try {
      var all = loadProfiles();
      delete all[gameSignature(rt)];
      localStorage.setItem(PROFILE_KEY, JSON.stringify(all));
    } catch (e) { /* 忽略 */ }
    lastScanAt = 0;
    var inst = ensurePlayer(rt);
    toast(inst ? ('已定位：' + player.typeName + '（生命下标 ' + player.off.hp + '）') : '没找到玩家状态对象');
    renderDiag();
  }

  function reloadGamePage() {
    try {
      var w = gameWindow();
      if (w && w !== window) w.location.reload();
      else window.location.reload();
    } catch (e) { toast('重载失败：' + e.message); }
  }

  /* ---------------------------------------------------------------- 诊断 / 全局变量列表 */

  function renderDiag() {
    if (!ui.root) return;
    var node = ui.root.querySelector('[data-bind="diag"]');
    if (!node) return;
    var rt = getRuntime();
    if (!rt) { node.textContent = '游戏运行时还没就绪。'; return; }

    var sig = gameSignature(rt);
    var lines = [];
    lines.push('<b>游戏签名</b> ' + sig + '（对象类型数 : 全局变量数）');
    lines.push('<b>全局变量</b> ' + (rt.tD ? rt.tD.length : 0) + ' 个，按名字读写');
    if (player.inst && player.inst.cc) {
      lines.push('<b>玩家对象</b> ' + player.typeName + '（' + player.inst.cc.length + ' 个实例变量）');
      lines.push('<b>状态下标</b> 饥饿 ' + player.off.food + ' / 口渴 ' + player.off.water +
        ' / 生命 ' + player.off.hp + ' / 体温 ' + player.off.temp);
      lines.push('<b>当前值</b> ' + readStat('food') + ' / ' + readStat('water') + ' / ' +
        readStat('hp') + ' / ' + readStat('temp'));
      lines.push('<b>偏移来源</b> ' + (player.verified
        ? '本版本实测，可直接使用'
        : '默认值（该游戏版本未校核，请先核对上面四个数值是否符合实际状态）'));
    } else {
      lines.push('<b>玩家对象</b> 未找到（还在菜单 / 已死亡 / 尚未进入对局）');
    }
    node.innerHTML = '<span class="mdz-tr-code">' + lines.join('\n') + '</span>';
  }

  function renderGlobalList(keyword) {
    if (!ui.root) return;
    var host = ui.root.querySelector('[data-bind="gvList"]');
    if (!host) return;
    var rt = getRuntime();
    if (!rt) { host.innerHTML = '<div class="mdz-tr-diag">游戏运行时还没就绪。</div>'; return; }

    var map = globalVars(rt);
    var names = Object.keys(map).sort();
    var kw = (keyword || '').toLowerCase();
    if (kw) names = names.filter(function (n) { return n.toLowerCase().indexOf(kw) >= 0; });
    var shown = names.slice(0, 80);

    host.innerHTML = shown.map(function (name) {
      var value = map[name].data;
      var text = (value === null || typeof value === 'undefined') ? '' : String(value);
      return '<div class="mdz-tr-gv">' +
        '<span class="mdz-tr-gv-name" title="' + name + '">' + name + '</span>' +
        '<input class="mdz-tr-num" data-gv="' + name + '" value="' + escapeAttr(text) + '">' +
        '</div>';
    }).join('') + (names.length > shown.length
      ? '<div class="mdz-tr-diag">还有 ' + (names.length - shown.length) + ' 个，继续输入以缩小范围…</div>'
      : '');
  }

  function escapeAttr(text) {
    return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  /* ---------------------------------------------------------------- 实时刷新 */

  var uiTick = 0;

  function refreshLiveValues() {
    if (!ui.root || !settings.open) return;
    var rt = getRuntime();
    if (!rt) return;
    ensurePlayer(rt);

    STAT_KEYS.forEach(function (key) {
      var node = ui.root.querySelector('[data-bind="stat-' + key + '"]');
      if (!node) return;
      var v = readStat(key);
      node.textContent = isNum(v) ? Math.round(v) : '—';
    });
    updateClockLabel();
    if (settings.tab === 'debug') renderDiag();
  }

  /* ---------------------------------------------------------------- 快捷键 */

  var hookedWindows = [];

  function matchHotkey(e) {
    return String(e.key || '').toUpperCase() === HOTKEY;
  }

  function onKeyDown(e) {
    if (e.repeat) return;
    if (matchHotkey(e)) {
      e.preventDefault();
      e.stopPropagation();
      toggle();
      return;
    }
    if (String(e.key || '').toUpperCase() === 'F9') {
      e.preventDefault();
      e.stopPropagation();
      healAll();
    }
  }

  /** 快捷键要同时挂在顶层窗口和游戏 iframe 上：焦点在 iframe 里时事件不会冒泡到父页面 */
  function hookKeys() {
    var targets = [window];
    var gw = gameWindow();
    if (gw && gw !== window) targets.push(gw);
    targets.forEach(function (w) {
      if (!w || hookedWindows.indexOf(w) >= 0) return;
      try { w.addEventListener('keydown', onKeyDown, true); hookedWindows.push(w); } catch (e) { /* 忽略 */ }
    });
  }

  /* ==========================================================================
   * 启动
   * ======================================================================== */

  function start() {
    injectStyle();
    if (settings.open) buildPanel();
    else { buildPanel(); hide(); }

    hookKeys();
    tick();
    setInterval(tick, TICK_MS);

    setInterval(function () {
      hookKeys();                       // iframe 重载后重新挂快捷键
      if (!settings.open) return;
      uiTick++;
      if (uiTick % Math.max(1, Math.round(UI_REFRESH_MS / TICK_MS)) === 0) refreshLiveValues();
    }, TICK_MS);

    window.__mdzTrainer = {
      show: function () { show(true); },
      hide: hide,
      toggle: toggle,
      heal: healAll,
      settings: settings,
      status: function () {
        return {
          typeName: player.typeName,
          offsets: player.off,
          hp: readStat('hp'),
          food: readStat('food'),
          water: readStat('water'),
          temp: readStat('temp'),
          hotkey: HOTKEY
        };
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
