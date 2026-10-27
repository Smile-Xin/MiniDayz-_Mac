'use strict';
/* MDZ 网页版启动器（浏览器版，与 PC 启动器同一套 UI 逻辑）
 * - 无 Electron：配置存 localStorage，存档同源直读 IndexedDB
 * - 版本清单：versions.php（PHP 动态扫描，目录即真相）；纯静态托管（Halo 等）回退 versions.json
 * - 播放：内嵌(iframe) / 新窗口 / 全屏；mapper 由本页注入子文档（不修改游戏 index）
 * - 版本目录：默认 <页面所在目录>/versions/<id>/；可经 window.__mdzConfig.versionsRoot 覆盖
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const BASE = new URL('.', location.href).href;
  // v1.0.37：安卓环境判断（UA 兜底，不依赖 android-adapter 是否加载）——安卓按钮 pointer 直绑通道用
  const isAndroidEnv = () => !!(window.__mdzIsAndroid || /Android|Capacitor/i.test((navigator.userAgent || '') + ' ' + (navigator.platform || '')));
  // 平台适配钩子（安卓 adapter 注入覆盖；web/桌面保持默认行为）
  const PLAT = window.__mdzPlatform || {};
  // v1.0.3-修复：以下两个常量会被初始化早期的 bindHelp / renderAbout / bindExternalLinks 读取，
  // 必须声明在 init 之前（原先在文件后部 helpers 区 → TDZ ReferenceError 中断 init prep：
  // 「关于」整块未渲染、了解更多/查看更新消失、bindDownloadGame 未绑定）
  const BACK_NAV = !PLAT.isPC && !PLAT.isAndroid; // 仅浏览器场景（PC 无返回键；安卓原生返回自管）
  const RESTRICTED_WEBVIEW = /QQ\/|QQBrowser|MQQBrowser|MicroMessenger|WeiBo|UCBrowser|Quark|baiduboxapp|DingTalk/i.test(navigator.userAgent || '');
  // v1.0.3-修复：公告缓存键同样会在 init 早期（readNoticeCache）被读取 → 声明提前，避免 TDZ 被 catch 吞掉导致缓存快路径失效
  const NOTICE_CACHE_KEY = 'mdz-notice-cache';
  // v1.0.3：启动器更新说明页（三端共用；安卓原先用 ANDROID_UPDATE_URL 同址）
  const LAUNCHER_UPDATE_URL = 'https://moyu-camp.info/archives/minidayz-launcher-update';
  // v0.3.20：状态变量声明提前到 IIFE 顶部 + init 立即调用——初始化与顶层后续代码解耦，
  // 顶层任何异常都不再阻断 init → __webApp 必定义 → 列表加载/导入刷新/原生推送刷新必可用
  const THEMES = [
    { mode: 'auto', label: '跟随系统', ico: 'monitor' },
    { mode: 'light', label: '浅色', ico: 'sun' },
    { mode: 'dark', label: '深色', ico: 'moon' }
  ];
  let themeMode = 'auto';
  let versions = [];
  let staticEnv = false; // true = 纯静态托管（无 PHP）：隐藏仅 PHP 环境可用的设置项
  let selectedId = null;
  let listSelMuted = false; // v0.6.61 修正④：点快捷启动后版本列表不高亮同版本（列表手动选择才恢复高亮）
  let qlActiveId = null; // v0.6.64：快捷启动自身「当前选中」——只由快捷启动内交互更新；
  // 与版本列表高亮（selectedId）解耦：在版本列表选版本不再让快捷启动同版本也出现选择框（用户多次强调不重复），
  // 而点快捷启动里的版本仍保留快捷启动内的选中提示（head/子列表对应行高亮）
  // ===== v0.6.67：存档页状态变量提前到 init 之前声明（原声明在文件后部，安卓等环境下 init→refresh→
  // renderSaveList 若在其声明前触达会抛 TDZ「Cannot access 'saveScanDirty' before initialization」→ 存档页空白/导入异常）=====
  const SAVES_PAGE_SIZE = 5; // 存档页每页卡片数
  let savesPage = 0;         // 当前页（0 起）
  let savesQuery = '';       // 搜索关键字
  let saveScanCache = null;  // dbKey -> {v, orphan, hasData, hasSlots}（Map 保序：versions 顺序 + 孤儿尾随）
  let saveScanDirty = true;  // 数据变更 → 重扫
  let saveScanRun = null;    // 进行中的扫描 promise（防并发重复扫描）
  let saveDrawTok = 0;       // v0.6.71：存档页绘制并发令牌（预取异步后丢弃过期绘制）
  let saveGotoTargetId = null; // v0.6.76：「前往存档管理」定位中的目标卡 id——渲染期直接折叠非目标卡（防先展开再收起闪动）
  let libView = 'list'; // 版本列表始终列表布局优先（不记忆上次切换，刷新/重开都是列表）
  const LIST_PAGE_SIZE = 10; // 列表布局：每页固定 10 个（多版本时避免一次渲染全部 + 全量读元数据变慢）
  let libPage = 0; // 当前页码（0-based）
  // 手持设备判断：触屏设备（手机/平板）统一 mobile 模式——v1.0.4 起 coarse 指针（触屏）即算移动端：
  // 平板横屏（宽视口 + 触屏）此前被误判 PC 模式 → 播放方式变 PC、全屏画面窄（用户反馈小米平板）；
  // 触屏统一走手机播放模式（设备默认分辨率直接填满全屏）。非触屏宽屏（PC 桌面）仍桌面模式。
  const isMobile = () => window.matchMedia('(pointer: coarse)').matches ||
    window.matchMedia('(max-width: 820px)').matches;
  let mobileSession = isMobile();
  let libQuery = ''; // 版本搜索（v0.5.0：按名称/ID；v0.6.0：加版本号，web/PC 一致）
  let openSeriesKey = null; // 当前展开的系列 key（单开，内存态不持久化）
  const DEFAULT_HELP_URL = 'https://moyu-camp.info/archives/minidayz-help';
  const DEFAULT_MORE_URL = 'https://moyu-camp.info/archives/minidayz-launcher';
  const ANDROID_UPDATE_URL = 'https://moyu-camp.info/archives/minidayz-launcher-update-android'; // v1.0.44：安卓「关于」查看更新按钮
// v0.7.16：PC「关于 → 查看更新」跳转页（PC 更新文章未建前先用资源/发布页；站长出 PC 文章后改这一行）
const PC_UPDATE_URL = 'https://moyu-camp.info/archives/minidayz-download';
  // v1.0.45：内置版本特殊行为 registry——按版本 id 声明与通用 C2 流程的差异（通用网页游戏启动器的第一批扩展点）。
  // minidayz-pc：PC 专用网页版（C2 1.41 + mods 系统，存档在 localStorage 由游戏自带 mods 管理）。
  //   directUrl=true   直链 iframe 加载（入口含 ../mods.js 跨目录模块，srcdoc+base 注入会 404；直链天然零注入 → 无需隔离）
  //   noSave=true      启动器不提供该版本存档功能（备份/导出/导入/删除——游戏自带 save-export-import mod）
  //   noKeymap=true    不注入键盘映射（PC 键鼠原生，无触屏映射需求）
  //   desktopOnly=true web 手机端不可见（仅桌面视口/PC 显示与可启动）
  //   sortFirst=true   版本列表默认排序置顶
  // v1.0.6：PC 系列名——单机版（minidayz-pc）与多人版（minidayz-mp）同系列，列表置顶块内折叠为一条系列项
  const PC_SERIES = 'MINIDAYZ PC版';
  const BUILTIN_SPECIAL = {
    'minidayz-pc': { directUrl: true, noSave: true, noKeymap: true, desktopOnly: true, sortFirst: true, defaultRes: { w: 850, h: 890 }, series: PC_SERIES }, // v0.7.8：defaultRes=默认/推荐分辨率（待用户实测定稿替换；自由分辨率已与普通版本一致）
    // v1.0.6 新增：PC 多人版（C2 网页客户端 + mods，内置 mp-server-simulator 模拟官方后端）——仅电脑端可见
    'minidayz-mp': { directUrl: true, noSave: true, noKeymap: true, desktopOnly: true, sortFirst: true, defaultRes: { w: 1280, h: 720 }, series: PC_SERIES },
  };
  function decorateVersion(v) {
    const s = BUILTIN_SPECIAL[v && v.id];
    if (s) { for (const k in s) v[k] = s[k]; }
    return v;
  }
  function isDesktopHidden(v) { return !!(v && v.desktopOnly && isMobile()); }
  /**
   * 版本资源根目录（每次调用实时读取，方便配置热切换）：
   * - 默认 <启动器所在目录>/versions/（与部署包、versions.php 扫描目录一致）；
   * - 纯静态托管（Halo 等）若把游戏目录放在别处（如网站根 /games/、或独立 CDN 域名），
   *   可在页面加载前执行 window.__mdzConfig = { versionsRoot: '...' }（可选 mdz-config.js）。
   *   绝对路径（/xxx、https://...、//...）原样使用；相对路径按启动器页 URL 解析。
   */
  function versionsRoot() {
    const cfg = (window.__mdzConfig && typeof window.__mdzConfig === 'object') ? window.__mdzConfig : null;
    let r = (cfg && cfg.versionsRoot) ? String(cfg.versionsRoot).trim() : '';
    if (!r) return BASE + 'versions/';
    if (!/^(?:https?:)?\/\//.test(r) && r.charAt(0) !== '/') r = new URL(r, location.href).href;
    return r.replace(/\/+$/, '') + '/';
  }

  // ===== 统一图标（内联 SVG，stroke=currentColor，随主题变色；避免散乱 emoji） =====
  const ICONS = {
    gamepad: '<path d="M6 12h4M8 10v4"/><path d="M15 11h.01M18 13h.01"/><path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59c-.01.05-.01.1-.02.15C2.6 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.42.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.54-.6-6.58-.68-7.26-.01-.05-.01-.1-.02-.15A4 4 0 0 0 17.32 5z"/>',
    play: '<polygon points="6 4 20 12 6 20" fill="currentColor" stroke="none"/>',
    save: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    fs: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    more: '<circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
    res: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M10 14h4"/>',
    export: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
    import: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6"/>',
    chevronL: '<path d="M15 18l-6-6 6-6"/>',
    chevronR: '<path d="M9 18l6-6-6-6"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>'
  };
  function ico(name, cls) {
    return '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  // ================= init（v0.3.20：提前执行，位于 ico/ICONS 等全部依赖定义之后、其余顶层代码之前——
  // 与顶层后续代码解耦，顶层任何异常都不再阻断 init → __webApp 必定义 → 列表/导入刷新/推送刷新必可用） =================
  (async function init() {
    initStep('init-start');
    try {
      applyTheme(readThemeMode());
      applyBrandConfig();
      bindHelp(); // v0.4.7：帮助链接
      bindDownloadGame(); // v0.6.71：下载游戏（浏览器链接，同帮助按钮机制）
      renderAbout();
      ensureIosHomeButton(); // v0.6.20：iOS 手机端「添加到主屏幕」按钮
      // v1.0.2：公告按钮只在有公告内容时出现——有上次缓存 → 立即插入（刷新不再晚出现）；
      // 无缓存则等 ensureNotice() 拉到内容后再插入（见 refresh 之后）
      if (!PLAT.hideNotice) { try { if (readNoticeCache()) addNoticeNavButton(); } catch (e) {} }
    } catch (e) { console.error('[init] prep:', e); }
    initStep('prep-done');
    try {
      await refresh();
    } catch (e) { console.error('[init] refresh:', e); }
    // 测试钩子 / 平台适配（refresh 已分步容错保证必达此处 → __webApp 必定定义）
    window.__webApp = { versions: () => versions.length, getVersions: () => versions, refresh, launchEmbed: (id, cal) => { const v = versions.find(x => x.id === id); if (v) openPlayer(v, 'embed', !!cal); }, launch: (id, mode, cal) => { const v = versions.find(x => x.id === id); if (!v) return false; openPlayer(v, mode || 'embed', !!cal); return true; }, gameUrl: (id) => { const v = versions.find(x => x.id === id); return v ? gameUrl(v) : ''; } };
    /* v1.0.23：本基线 = **v1.0.12 的存档等实现** + 新增「左右黑边」；回归探针据此判断哪些组该跑
       （v1.0.13~v1.0.22 的改动都不在这个基线里，除非用户点名要）。 */
    window.__mdzBaseline = 'v1.0.12+左右黑边';
    window.__mdzHasResidueFix = true;
    window.__mdzHasAudioGuard = true;
    window.__mdzEnsureNoGameForSave = function () { return ensureNoGameForSave(); }; // v1.0.25：回归探针用（用户界面零影响）
    window.__mdzDeleteSavesGuarded = function (k) { return deleteSavesGuarded(k); };   // v1.0.27：回归探针用
    window.__mdzFrameDbCount = function () { try { const f = $('embed-frame'); const w = f && f.contentWindow; return (w && typeof w.__mdzDbCount === 'function') ? w.__mdzDbCount() : -1; } catch (e) { return -2; } }; // v1.0.28：回归探针用
    try { if (!PLAT.hideNotice) ensureNotice(); } catch (e) {} // v1.0.2：拉取公告 → 有内容才显示按钮/弹窗（PC 版 PLAT.hideNotice 关闭——本地版无公告）
    // v0.5.0：安卓返回键支持（adapter __mdzOnBack 调用）
    window.__mdzIsPlaying = function () { try { return isPlaying(); } catch (e) { return false; } };
    window.__mdzClosePlayer = function () { try { closePlayer(); return true; } catch (e) { return false; } };
    initStep('init-done');
  })();
  // 手机端内嵌强制横版：竖屏设置分辨率自动转横（游戏本身是横版）
  function embedRes(v) {
    const r = resFor(v.id);
    return mobileSession && r.h > r.w ? { w: r.h, h: r.w } : r;
  }

  const PRESETS = [
    { label: '850×890（PC 原生）', w: 850, h: 890 }, // v0.7.6：minidayz-pc（PC 版/directUrl）原生画面尺寸/默认
    { label: '1024×768（PE 原生）', w: 1024, h: 768 }, // v0.7.12：普通（PE）版原生 4:3——标签带归属，避免两「原生」混淆
    { label: '1280×720', w: 1280, h: 720 },
    { label: '1366×768', w: 1366, h: 768 },
    { label: '1600×900', w: 1600, h: 900 },
    { label: '1920×1080', w: 1920, h: 1080 },
    { label: '自定义…', custom: true }
  ];
  const DEFAULT_RES = { w: 1280, h: 720 }; // v0.7.13：普通（导入）版本默认 1280×720；PC 版由 defaultRes(850×890) 覆盖

  // ===== 存储适配 =====
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function resFor(id) {
    const v = versions.find((x) => x.id === id);
    const r = lsGet('mdz-res-' + id, null);
    if (r && r.w && r.h) return r;
    // v0.7.8：directUrl 版（minidayz-pc）无用户设置时用其推荐默认 defaultRes（decorateVersion 从
    // BUILTIN_SPECIAL 带入；默认可自由调整，与普通版本完全一致——无高度限制）
    if (v && v.directUrl) return (v.defaultRes && v.defaultRes.w && v.defaultRes.h) ? { w: v.defaultRes.w, h: v.defaultRes.h } : { w: 850, h: 890 };
    return DEFAULT_RES;
  }
  // ===== 快捷启动（v0.6.56 起；v0.6.58：上次游玩与置顶合并为单父级卡） =====
  function isPinned(v) { try { return localStorage.getItem('mdz-pinned-' + v.id) === '1'; } catch (e) { return false; } }
  function setPinned(v, on) { try { localStorage.setItem('mdz-pinned-' + v.id, on ? '1' : '0'); } catch (e) {} }
  function lastLaunchedId() {
    try { const o = JSON.parse(localStorage.getItem('mdz-last-launched') || 'null'); return (o && o.id) ? o.id : null; } catch (e) { return null; }
  }
  function setLastLaunched(v) { try { localStorage.setItem('mdz-last-launched', JSON.stringify({ id: v.id, t: Date.now() })); } catch (e) {} }
  /** v0.6.58：快捷启动单父级卡 = series-block（视觉同版本列表系列折叠）。
   *  v0.6.60：head（父级）= 优先上次游玩、无则第一个置顶版本，只带 配置 - 启动 按钮；
   *  展开/收起置顶列表按钮移到「快捷启动」标题行水平右侧（布局同版本列表 library-head）；
   *  子列表 = 其余置顶版本（排除父级已显示项，避免重复），listRow 完整行。
   *  展开状态 mdz-qlopen-ql（裸 localStorage '0'=收起，默认展开）。 */
  function qlCard(parentV, children, open) {
    const hasKids = children.length > 0;
    const isRecent = lastLaunchedId() === parentV.id;
    // v0.6.64：快捷启动选中提示 = qlActiveId（仅 ql 内交互更新）——版本列表选同版本不会在这里重复出现框
    const wrap = document.createElement('div');
    wrap.className = 'series-block ql-card' + ((parentV.id === qlActiveId) ? ' selected' : '') + (open && hasKids ? ' open' : '');
    const head = document.createElement('div');
    head.className = 'list-row series-head ql-head';
    head.append(coverEl(parentV, 'lr-cover', true));
    const info = document.createElement('div');
    info.className = 'lr-info';
    info.innerHTML = '<h4>' + esc(parentV.name || parentV.id) + '</h4><span>' +
      esc((parentV.version || '—') + ' · ' + (isRecent ? '上次游玩' : '置顶')) + '</span>';
    head.appendChild(info);
    // v0.6.60：父级行不再放展开/收起按钮（移到标题行右侧）
    // v1.0.5：与版本列表行同款——CSS 驱动的图标化（手机端/安卓端只显示图标；桌面观感同 v1.0.3）
    const cfgBtn = document.createElement('button');
    cfgBtn.className = 'lr-config lr-rowbtn';
    cfgBtn.innerHTML = ico('gear', 'lr-icon-compact') + '<span class="lr-label">配置</span>';
    cfgBtn.setAttribute('aria-label', '启动配置');
    cfgBtn.title = '启动配置（播放方式、分辨率）';
    cfgBtn.onclick = (e) => { e.stopPropagation(); openConfigDialog(parentV); };
    head.appendChild(cfgBtn);
    const playBtn = document.createElement('button');
    playBtn.className = 'primary lr-play lr-rowbtn';
    playBtn.innerHTML = ico('play') + '<span class="lr-label">启动</span>';
    playBtn.setAttribute('aria-label', '启动');
    playBtn.onclick = (e) => { e.stopPropagation(); launchVersion(parentV, modeFor(parentV.id), undefined, true); };
    head.appendChild(playBtn);
    // v0.6.62 修正④：点快捷启动父级行 = qlSelect（详情切换，版本列表静默收起不加框）
    head.onclick = () => qlSelect(parentV.id);
    wrap.appendChild(head);
    if (hasKids) {
      const subEl = document.createElement('div');
      subEl.className = 'series-children' + (open ? '' : ' hidden');
      for (const v of children) {
        const row = listRow(v, true, true); // qlRow：行高亮/点击都按快捷启动语义
        row.classList.add('series-child-row');
        subEl.appendChild(row);
      }
      wrap.appendChild(subEl);
    }
    return wrap;
  }
  /** 快捷启动块渲染：单父级卡——head = 上次游玩版本（无则第一个置顶）；子列表 = 其余置顶版本；
   *  既无上次游玩也无置顶时整块隐藏；「展开/收起置顶列表」按钮在快捷启动标题行水平右侧 */
  function renderQuickLaunch() {
    const ql = $('quick-launch');
    if (!ql) return;
    // v0.6.56：PC 游戏播放期间（详情块隐藏）快捷启动不显示——即使被 resize 等路径重渲染也不露头
    if (document.body.classList.contains('game-active') && !mobileSession) { ql.classList.add('hidden'); return; }
    ql.innerHTML = '';
    // v1.0.45：desktopOnly 版本不进快捷启动（手机端不可见，避免置顶/最近在手机上显示）
    const qlVisible = versions.filter((v) => !isDesktopHidden(v));
    const lastId = lastLaunchedId();
    const lastV = qlVisible.find((x) => x.id === lastId) || null;
    const pinnedAll = qlVisible.filter((v) => isPinned(v));
    const parentV = lastV || pinnedAll[0] || null; // 父级：上次游玩优先，否则第一个置顶
    const show = !!parentV;
    ql.classList.toggle('hidden', !show);
    if (!show) return;
    let open = true;
    try { open = localStorage.getItem('mdz-qlopen-ql') !== '0'; } catch (e) { open = true; }
    // 子列表 = 置顶版本排除父级（避免父级在 head 与子列表重复出现）
    const children = pinnedAll.filter((v) => v.id !== parentV.id);
    // v0.6.60：标题行 = 快捷启动（左）+ 展开/收起置顶列表按钮（右，布局同版本列表 library-head）
    const headRow = document.createElement('div');
    headRow.className = 'quick-launch-head';
    const title = document.createElement('h2');
    title.className = 'quick-launch-title';
    title.textContent = '快捷启动';
    headRow.appendChild(title);
    if (children.length) {
      const tools = document.createElement('div');
      tools.className = 'quick-launch-tools';
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'ql-toggle';
      toggleBtn.textContent = open ? '收起置顶列表' : '展开置顶列表';
      toggleBtn.title = '展开/收起置顶版本列表';
      toggleBtn.onclick = () => {
        try { localStorage.setItem('mdz-qlopen-ql', open ? '0' : '1'); } catch (e2) {}
        renderQuickLaunch();
      };
      tools.appendChild(toggleBtn);
      headRow.appendChild(tools);
    }
    ql.appendChild(headRow);
    ql.appendChild(qlCard(parentV, children, open));
  }
  // v0.6.50：手机端「画面显示」顶部模式（mdz-game-top-<id>）——仅 web iOS/安卓浏览器显示（安卓 APK 不需要，
  // 用户确认）：'' = 占满全屏（画面延伸到顶部状态栏/刘海区，默认）；'1' = 避开顶部（顶部留黑边，
  // 状态栏/刘海不挡游戏 UI）。lsGet/lsSet JSON 一致存取。
  function gameTopInset(v) {
    try { return lsGet('mdz-game-top-' + (v && v.id), '') === '1'; } catch (e) { return false; }
  }
  // 兼容PC分辨率（v0.4.9）：手动指定分辨率存 mdz-compat-res-<id>；未指定（自动）时：
  // v0.5.3 修复——**逻辑宽度固定为 PC 级 1280**（防黑屏上限），高度按手机横屏比例算出。
  // 之前自动模式直接用手机横屏尺寸（如 844×390）作逻辑分辨率，游戏按 844 宽布局
  // （比 PC 1024/1280 窄），同一 UI 元素占比更大 → 视觉放大；固定 1280 宽后与手动
  // 选 1280×720 效果一致（游戏按 PC 宽度布局），transform 等比缩放填满手机屏幕。
  const TARGET_W = 1280; // PC 级逻辑宽度（C2 大画布 + 强缩放在部分设备黑屏，勿再增大）
  /** v0.6.43：物理屏幕模式——固定用屏幕物理横屏比例（auto 全屏失败留边时的可选方案） */
  function physicalCompatRes() {
    let sw = screen.width, sh = screen.height;
    if (sw && sh) { const a = Math.max(sw, sh); const b = Math.min(sw, sh); sw = a; sh = b; }
    else { sw = window.innerWidth || 1280; sh = window.innerHeight || 720; if (sh > sw) { const t = sw; sw = sh; sh = t; } }
    return { w: TARGET_W, h: Math.max(240, Math.round(TARGET_W * (sh / sw))), auto: false, mode: 'physical' };
  }
  /* v1.0.23（本轮新增「左右黑边」）：按版本存 mdz-game-bar-left/right-<id>（px，0 = 不留）。
     自定义时这两值**就是**那一侧黑边的宽度（不与自动值相加）。 */
  function barPadVal(v, side) {
    try {
      const p = parseInt(lsGet('mdz-game-bar-' + side + '-' + (v && v.id), 0), 10);
      return (p >= 0 && p <= 400) ? p : 0;
    } catch (e) { return 0; }
  }
  /* v1.0.23：「避开刘海」留下的黑边是**实打实占掉屏幕**的（stage padding）→ 自动逻辑分辨率与
     适配缩放都按"扣掉黑边后的可用区"算：比例一致 → 画面正好铺满可用区，不裁切、上下不多出黑边。 */
  function availBox() {
    let padX = 0, padY = 0;
    const stage = $('embed-stage');
    try {
      const cs = getComputedStyle(stage);
      padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    } catch (e) {}
    let w = window.innerWidth || 1280, h = window.innerHeight || 720;
    try {
      if (stage && stage.clientWidth >= w * 0.6 && stage.clientHeight >= h * 0.6) { w = stage.clientWidth; h = stage.clientHeight; }
    } catch (e) {}
    w = Math.max(160, w - padX);
    h = Math.max(120, h - padY);
    if (h > w) { const t = w; w = h; h = t; } // 横屏化（手机端锁定横屏）
    return { w: w, h: h };
  }
  function compatResFor(v) {
    const manual = lsGet('mdz-compat-res-' + v.id, null);
    if (manual && manual.physical) return physicalCompatRes(); // v0.6.43：物理屏幕选项
    if (manual && manual.w && manual.h) return { w: manual.w, h: manual.h, auto: false };
    /* v1.0.23：auto 改读**可用显示区（stage 内容盒）比例**——留了黑边还按整屏比例算逻辑高，
       缩放到"扣掉黑边的可用区"时比例就不匹配 → 上下额外冒黑边（用户实测）。 */
    const box = availBox();
    let sw = box.w, sh = box.h;
    let isLandscape = true;
    try { isLandscape = !window.matchMedia || window.matchMedia('(orientation: landscape)').matches; } catch (e) {}
    if (!isLandscape || sh > sw) {
      const pw = screen.width, ph = screen.height;
      if (pw && ph) { sw = Math.max(pw, ph); sh = Math.min(pw, ph); }
      else if (sh > sw) { const t = sw; sw = sh; sh = t; }
    }
    const w = TARGET_W;
    const h = Math.max(240, Math.round(TARGET_W * (sh / sw))); // 高度按手机横屏比例
    return { w, h, auto: true };
  }
  // v-防黑专项(2026-09-09)：安全边距（全局每侧 px，最小 1，默认 6）
  function safePadVal() { const p = parseInt(lsGet('mdz-safe-pad', '6'), 10); return (p >= 1 && p <= 64) ? p : 6; }
  // 「防黑安全分辨率」：逻辑宽固定 PC 级 1280（兼容 PC 观感、不放大）；高度按【可用显示区
  // （外层−2×边距）比例】计算——缩放到可用区时四边留白严格等于边距、无多余黑边；
  // 显示 contain、scale≤1 只缩不放、居中 → 不超屏不黑屏。
  function safeResFor() {
    const pad = safePadVal();
    const box = availBox(); // v1.0.23：与 fitPlayer 同一块可用区（已扣掉左右黑边）
    const availW = Math.max(160, box.w - pad * 2);
    const availH = Math.max(120, box.h - pad * 2);
    const w = TARGET_W;
    const h = Math.max(240, Math.round(TARGET_W * (availH / availW)));
    return { w, h, auto: false, mode: 'safe' };
  }
  // 播放方式：fullscreen（窗口模式/全屏）/embed（内嵌画面）/compat（兼容电脑分辨率，仅手机/安卓）
  // v0.6.6：PC 端播放方式恢复可选（全屏/内嵌/新窗口，默认内嵌）；
  // v0.7.12：桌面曾只留「窗口模式 / 内嵌画面」；v1.0.2：按用户要求恢复「新窗口」（PC/桌面与手机端选项均置于最后）
  // v-防黑专项(2026-09-09)：新增 safe「防黑安全分辨率」（仅手机/安卓；画面=显示区域-安全边距，不放大）
  const PLAY_MODES = { fullscreen: '全屏', embed: '内嵌', compat: '兼容电脑分辨率', safe: '防黑安全分辨率', window: '新窗口' };
  function modeFor(id) {
    const m = lsGet('mdz-playmode-' + id, null);
    const vv = versions.find((x) => x.id === id);
    // v0.7.3：directUrl 内置版本（如 minidayz-pc）——可直接显示在启动器内，也可开独立窗口
    // v0.7.16：PC 默认「窗口模式」启动（含内置 PC 版）
    if (vv && vv.directUrl) {
      if (m && (m === 'fullscreen' || m === 'embed' || m === 'window')) return m;
      return (PLAT.isPC && !isMobile()) ? 'fullscreen' : 'embed';
    }
    if (PLAT.isAndroid || isMobile()) {
      // v0.6.10：安卓与 web 手机端一致；v1.0.2：恢复「新窗口」（选项置最后）
      const allowed = ['fullscreen', 'compat', 'safe', 'window']; // v-防黑：新增防黑安全分辨率
      if (m && allowed.indexOf(m) >= 0) return m;
      return 'compat'; // 手机/安卓默认「兼容电脑分辨率」
    }
    if (m && (m === 'fullscreen' || m === 'embed' || m === 'window')) return m;
    return (PLAT.isPC && !isMobile()) ? 'fullscreen' : 'embed'; // v0.7.16：PC 默认窗口模式；web 桌面仍默认内嵌
  }

  // ===== 主题 =====
  // v1.0.41：auto（跟随系统）改为 JS 解析——安卓 WebView 上纯 CSS @media(prefers-color-scheme)
  // 收不到系统深浅切换（auto 恒浅色，需点按钮固化才变），改由原生推送 --mdz-system-dark（1/0）
  // 或 matchMedia 判定实际深浅并写入 data-theme；系统切换时经 window.__mdzSystemThemeChange 即时刷新。
  // v1.0.42：读取清洗——历史脏值（曾被 lsSet/JSON.stringify 写入带引号 "auto"，读端 getItem 未还原，
  // 且每次 applyTheme 再 stringify 一层引号翻倍累积）剥掉包裹引号后归一；非法一律回 auto。
  function readThemeMode() {
    try {
      let v = localStorage.getItem('mdz-theme');
      if (v == null || v === '') return 'auto';
      v = String(v).trim();
      while (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') {
        v = v.slice(1, -1).trim();
      }
      return (v === 'auto' || v === 'light' || v === 'dark') ? v : 'auto';
    } catch (e) { return 'auto'; }
  }
  function resolveAutoDark() {
    try {
      const cv = getComputedStyle(document.documentElement).getPropertyValue('--mdz-system-dark').trim();
      if (cv === '1' || cv === '0') return cv === '1' ? 'dark' : 'light'; // 安卓：原生可信值
    } catch (e) {}
    try { return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; } catch (e) { return 'light'; }
  }
  function applyTheme(mode) {
    themeMode = mode;
    // v1.0.42：裸值存储（原 lsSet=JSON.stringify 存成 "auto" 带引号，读端 getItem 又未还原 → 主题不保存/不跟随）
    try { localStorage.setItem('mdz-theme', mode); } catch (e) {}
    document.documentElement.setAttribute('data-theme', mode === 'auto' ? resolveAutoDark() : mode);
    // 主题切换平滑过渡（v0.4.2）：切换瞬间给根元素加 class，CSS 里对全部元素启用颜色过渡，
    // 避免黑/白跳变；350ms 后移除，平时零开销
    clearTimeout(window.__themeT);
    document.documentElement.classList.add('theme-switching');
    window.__themeT = setTimeout(function () { document.documentElement.classList.remove('theme-switching'); }, 350);
    const t = THEMES.find((x) => x.mode === mode) || THEMES[0];
    $('theme-label').textContent = t.label;
    $('theme-ico').innerHTML = ico(t.ico);
    document.querySelectorAll('input[name=theme]').forEach((r) => { r.checked = (r.value === mode); });
  }
  // 系统深浅变化 → auto 模式下即时切换（原生 onConfigurationChanged 调此钩子；web/PC 用 matchMedia 监听）
  window.__mdzSystemThemeChange = function () {
    try { if (themeMode === 'auto') document.documentElement.setAttribute('data-theme', resolveAutoDark()); } catch (e) {}
  };
  $('theme-toggle').onclick = () => {
    const idx = THEMES.findIndex((x) => x.mode === themeMode);
    applyTheme(THEMES[(idx + 1) % THEMES.length].mode);
  };
  document.querySelectorAll('input[name=theme]').forEach((r) => { r.onchange = () => applyTheme(r.value); });
  // web/PC 平台：浏览器会推送 prefers-color-scheme 变化（安卓由原生 --mdz-system-dark 路径驱动）
  try {
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (mq) {
      if (mq.addEventListener) mq.addEventListener('change', () => { if (window.__mdzSystemThemeChange) window.__mdzSystemThemeChange(); });
      else if (mq.addListener) mq.addListener(() => { if (window.__mdzSystemThemeChange) window.__mdzSystemThemeChange(); });
    }
  } catch (e) {}

  // ===== v1.0.1：返回键（浏览器后退）对齐安卓版 + 受限内置浏览器兼容 =====
  // ① 返回键语义（与安卓版一致）：游戏播放中 → 关闭游戏回启动器；存档/设置等页 → 回版本库首页；
  //    首页 → 不拦截（正常返回上一页）。配合「iframe 不用 srcdoc/src 导航」消除 iframe 历史条目
  //    （见 loadGameInto）——否则手机端按返回会先退回 iframe 里的游戏画面（黑屏）。
  // ② QQ/微信等内置浏览器：window.open 常被静默拦截（用户反馈「点下载没反应」），a.download 也可能无效。
  // （v1.0.3-修复：BACK_NAV / RESTRICTED_WEBVIEW 两个常量已上移到 IIFE 顶部，避免 init 早期 TDZ）
  let backSentinel = 0;    // 已压入的返回哨兵条数
  let backIgnore = 0;      // 程序内消费哨兵时需忽略的 popstate 次数
  let backIgnoreAt = 0;    // 忽略窗口起点（history.back() 无历史时不产生 popstate → 超时作废，防误吞真实返回）
  let backClosing = false; // 由返回键触发的 closePlayer（避免重复消费哨兵）
  function backPush(tag) {
    if (!BACK_NAV) return;
    try { history.pushState({ mdz: tag || 'view' }, ''); backSentinel++; } catch (e) {}
  }
  function backConsume() {
    if (!BACK_NAV || backSentinel <= 0) return;
    backSentinel--; backIgnore++; backIgnoreAt = Date.now();
    try { history.back(); } catch (e) { backIgnore--; }
  }
  function activeViewId() {
    const el = document.querySelector('.view.active');
    return el ? el.id.replace(/^view-/, '') : 'versions';
  }
  function backToHome() {
    const nav = document.querySelector('.nav-item[data-view="versions"]');
    if (nav) nav.click();
  }
  if (BACK_NAV) {
    window.addEventListener('popstate', function () {
      // 程序内 history.back() 消费哨兵时忽略这次事件；超过 1.5s 未收到（无历史可退）则作废，防误吞真实返回
      if (backIgnore > 0 && (Date.now() - backIgnoreAt) < 1500) { backIgnore--; return; }
      if (backIgnore > 0) backIgnore = 0;
      if (backSentinel > 0) backSentinel--;
      // ① 游戏播放中 → 关闭游戏（回启动器，不再退到 iframe 里的游戏画面）
      if (isPlaying()) {
        backClosing = true;
        try { closePlayer(); } catch (e) { try { if (window.__mdzClosePlayer) window.__mdzClosePlayer(); } catch (e2) {} }
        backClosing = false;
        return;
      }
      // ② 非首页视图（存档/设置/关于…）→ 回版本库首页
      if (activeViewId() !== 'versions') { backToHome(); return; }
      // ③ 首页：不拦截（正常离开/返回上一页）
    });
  }
  /** 外链跳转（帮助/下载/公告链接）：受限内置浏览器改当前页跳转（window.open 会被静默拦截） */
  function openExternalUrl(url, opts) {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) { toast('链接无效: ' + u, true); return false; }
    if (PLAT.openExternal) { try { PLAT.openExternal(u); return true; } catch (e) {} } // 安卓：原生跳系统浏览器
    if (RESTRICTED_WEBVIEW && !(opts && opts.forceNew)) {
      try { location.href = u; return true; } catch (e) {}
    }
    let w = null;
    try { w = window.open(u, '_blank', 'noopener'); } catch (e) {}
    if (!w) { try { location.href = u; return true; } catch (e) {} } // 弹窗被拦截 → 兜底当前页跳转
    return !!w;
  }
  /** 文件下载（存档/按键映射/清单导出）：不支持 a.download 的内置浏览器回退新窗口打开 blob */
  function downloadBlob(blob, filename, okMsg) {
    try {
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      if (typeof a.download !== 'undefined') {
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 6000);
        if (okMsg) toast(okMsg);
        return true;
      }
      const w = window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      if (w) { if (okMsg) toast(okMsg); return true; }
      toast('当前浏览器不支持直接下载，请点右上角菜单「在浏览器打开」后重试', true);
      return false;
    } catch (e) {
      toast('下载失败: ' + e.message, true);
      return false;
    }
  }
  /** v1.0.1：受限内置浏览器（QQ/微信）中 target=_blank 外链点击可能被静默拦截 → 容器内 http 外链改当前页跳转 */
  function bindExternalLinks(root) {
    if (!RESTRICTED_WEBVIEW || !root || !root.querySelectorAll) return;
    try {
      root.querySelectorAll('a[href^="http"]').forEach(function (a) {
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          openExternalUrl(a.getAttribute('href'));
        });
      });
    } catch (e) {}
  }

  // ===== 视图切换 =====
  // v1.0.8：**网页版/安卓版一律不显示「联机配置」**（用户要求：web 只当播放器、不提供服务器；
  //   多人版的服务器地址直接写在该版本的配置弹窗里）。只有 PC 原生（PLAT.isPC）才保留该页。
  try {
    if (PLAT.hideLanPage || !PLAT.isPC) {
      const lanNav = document.querySelector('.nav-item[data-view="lan"]');
      if (lanNav && lanNav.parentNode) lanNav.parentNode.removeChild(lanNav);
      const lanView = document.getElementById('view-lan');
      if (lanView && lanView.parentNode) lanView.parentNode.removeChild(lanView);
    }
  } catch (e) {}
  /* ===== 游戏内修改器（v1.1.0）=====
     启动器这一页只负责「是否注入 + 热键」两个启动参数；
     修改器自身的功能开关、锁定数值、玩家对象定位结果都存在游戏页的 localStorage 里，
     由游戏窗口里的覆盖层自己管理（见 src/renderer/trainer/trainer.js）。 */
  let trainerCfg = { enabled: true, hotkey: 'F8' };

  function trainerNative() {
    const n = window.__launcherNative;
    return (n && n.trainerGet && n.trainerSet) ? n : null;
  }

  function renderTrainerPage() {
    const box = $('tr-enabled');
    const sel = $('tr-hotkey');
    if (box) box.checked = !!trainerCfg.enabled;
    if (sel) sel.value = trainerCfg.hotkey || 'F8';
  }

  async function loadTrainerConfig() {
    const n = trainerNative();
    if (!n) return;
    try { trainerCfg = await n.trainerGet(); } catch (e) { return; }
    renderTrainerPage();
  }

  function bindTrainerForm() {
    const box = $('tr-enabled');
    const sel = $('tr-hotkey');

    const save = async (patch) => {
      const n = trainerNative();
      if (!n) { toast('当前环境不支持修改器设置', true); return; }
      try {
        trainerCfg = await n.trainerSet(patch);
        renderTrainerPage();
        toast('已保存，重开游戏窗口后生效');
      } catch (e) {
        toast('保存失败：' + e.message, true);
      }
    };

    if (box) box.onchange = () => save({ enabled: box.checked });
    if (sel) sel.onchange = () => save({ hotkey: sel.value });
  }

  bindTrainerForm();
  loadTrainerConfig();

  /* 内嵌播放时的修改器注入。
     独立游戏窗口由主进程在 dom-ready 注入（见 main/inject-scripts.js 的 trainerLoader）；
     内嵌模式的壳页是启动器自己，所以由这里补上——覆盖层挂在启动器页面，
     trainer.js 内部会优先找 #embed-frame 里的运行时。 */
  let trainerInjected = false;

  function ensureTrainerOverlay() {
    if (!trainerCfg.enabled) return;
    // 只在真的在播游戏时显示：gameReady 可能比「关闭播放」晚到，不能把面板再弹回来
    if (window.__mdzTrainer) {
      try { if (isPlaying()) window.__mdzTrainer.show(); } catch (e) {}
      return;
    }
    if (trainerInjected) return;
    trainerInjected = true;
    window.__mdzTrainerHotkey = trainerCfg.hotkey || 'F8';
    const s = document.createElement('script');
    s.id = 'mdz-trainer-js';
    s.src = 'app://game/_launcher/trainer/trainer.js';
    s.onerror = () => { trainerInjected = false; };
    // 竞态：脚本是异步加载的，如果用户在这之前就退出了游戏，面板不能再自己弹出来
    s.onload = () => {
      try { if (!isPlaying() && window.__mdzTrainer) window.__mdzTrainer.hide(); } catch (e) {}
    };
    (document.head || document.documentElement).appendChild(s);
  }

  document.querySelectorAll('.nav-item').forEach((btn) => {
    // v0.5.8：跳过无 data-view 的项（帮助按钮已改为 <a target=_blank>，点击应跳转而非切视图）
    if (!btn.dataset || !btn.dataset.view) return;
    btn.onclick = () => {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + btn.dataset.view));
      // v1.0.1：返回键栈——离开首页时最多压一个哨兵（多次切视图不堆积）、回首页消费
      if (btn.dataset.view === 'versions') backConsume();
      else if (backSentinel === 0) backPush('view');
      // v0.6.61 需求②：进入存档页刷新数据（只显示有存档/备份的版本；游戏玩过/外部变更后回来要新）
      if (btn.dataset.view === 'saves') { try { enterSavesView(); } catch (e) {} }
      if (btn.dataset.view === 'transfer') { try { enterTransferView(); } catch (e) {} }   // v1.0.1：存档传输页
      // v1.0.7：进入「联机配置」页刷新联机状态（服务器/分发/建房程序）
      if (btn.dataset.view === 'lan') { try { renderLanPage(); lanRefresh(); } catch (e) {} }
      // v1.1.0：修改器页——每次进入重新读一次配置（配置文件可能被外部改过）
      if (btn.dataset.view === 'trainer') { try { renderTrainerPage(); loadTrainerConfig(); } catch (e) {} }
      if (isMobile()) document.body.classList.remove('sidebar-open'); // 手机端选中后收起抽屉
    };
  });

  // 手机端侧边栏：顶栏 ☰ 开关 + 点击遮罩关闭
  $('btn-menu').onclick = () => document.body.classList.toggle('sidebar-open');
  $('sidebar-backdrop').onclick = () => document.body.classList.remove('sidebar-open');

  // ===== 状态 =====
  let currentVersion = null; // 正在播放的版本
  let currentMode = 'embed'; // 当前播放方式：embed | window | fullscreen
  // 手机/PC 适配开关：打开播放器时一次性判定并固化。
  // 不能在全屏后的 fitPlayer 里再按视口判断——全屏视口=屏幕尺寸（如横屏手机 900px+），
  // 会误判成 PC 而走 transform 缩放（黑屏/窄画面）。

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function encSegs(p) { return String(p).split('/').filter(Boolean).map(encodeURIComponent).join('/'); }
  /* ===== 多人联机（网页版 = 只当播放器；服务器/建房程序在别人那台电脑上跑）=====
     用户需求（v1.0.8）：「多人版入口 + 只填一个 IP」——不填 = 用本站自带的副本（单机模拟）；填了就连房主。
     v1.0.9 语义（按用户实测反馈「启动的是原版、看不见自建服务器里的房间」重定）：
       · 只填 IP（可带端口，如 192.168.1.5 / 192.168.1.5:8787）= **用本站客户端 + 连这台机器的信令服务器**
         （房主只需开着「信令服务器」，不必开分发服务）→ 本站客户端已内置 mdz-signal 模组，认 ?signal=
       · 填 http://IP:8088/... = 直接用房主**分发**出来的客户端副本（房主开了分发服务时用；https 站点只有这条路）
     一个输入框同时接受：1.2.3.4 / 1.2.3.4:8787 / ws://1.2.3.4:8787 / http://1.2.3.4:8088 */
  const MP_SERVER_KEY = 'mdz-mp-server';
  function mpServerRaw() { return String(lsGet(MP_SERVER_KEY, '') || '').trim(); }
  /* v1.0.10：多人版玩家名称（客户端上游原本 prompt 输入；这里配置后随 URL ?user= 注入） */
  const MP_USER_KEY = 'mdz-mp-user';
  function mpUserRaw() { return String(lsGet(MP_USER_KEY, '') || '').trim().slice(0, 16); }
  /** 追加给客户端的公共参数：玩家名 + mdz=1（客户端页据此隐藏滚动条） */
  function mpExtraQuery() {
    let q = 'mdz=1';
    const u = mpUserRaw();
    if (u) q += '&user=' + encodeURIComponent(u);
    return q;
  }
  function isMpVersion(v) {
    if (!v) return false;
    if (v.id === 'minidayz-mp' || String(v.id).indexOf('__lan') === 0) return true;
    return !!(v.series && String(v.series).indexOf('多人') >= 0);
  }
  /** 解析「一个地址」→ {host, httpPort, signalPort, viaDispatch, secure}；空/非法返回 null */
  function mpParseServer(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    let proto = '';
    const m1 = /^(https?|wss?):\/\//i.exec(s);
    if (m1) { proto = m1[1].toLowerCase(); s = s.slice(m1[0].length); }
    s = s.replace(/\/.*$/, '').replace(/\s+/g, '');
    let host = s, port = 0;
    const m2 = /^(.*):(\d{1,5})$/.exec(s);
    if (m2) { host = m2[1]; port = parseInt(m2[2], 10); }
    host = host.replace(/^\[|\]$/g, '');
    if (!host) return null;
    const viaDispatch = (proto === 'http' || proto === 'https');
    const secure = (proto === 'wss' || proto === 'https');
    return {
      host: host,
      viaDispatch: viaDispatch,
      // 分发模式：给定端口=分发端口（默认 8088），信令端口默认 8787
      // 直连模式（裸 IP / ws://）：给定端口=信令端口（默认 8787）
      httpPort: viaDispatch ? (port > 0 ? port : 8088) : 8088,
      signalPort: viaDispatch ? 8787 : (port > 0 ? port : 8787),
      secure: secure
    };
  }
  function mpSignalUrl(s) { return (s.secure ? 'wss://' : 'ws://') + s.host + ':' + s.signalPort; }
  /** 房主分发的客户端副本地址（只有 http:// 前缀，或 https 站点被迫升级时才用）；否则返回 '' = 用本站副本 */
  function mpClientUrl(v, calibrate) {
    if (PLAT.isPC || !isMpVersion(v)) return '';
    const s = mpParseServer(mpServerRaw());
    if (!s) return '';
    const https = (typeof location !== 'undefined' && location.protocol === 'https:');
    if (!s.viaDispatch && !https) return '';
    const host = s.host;
    const httpPort = s.viaDispatch ? s.httpPort : 8088;
    const sig = (s.secure ? 'wss://' : 'ws://') + host + ':' + (s.viaDispatch ? 8787 : s.signalPort);
    const q = 'signal=' + encodeURIComponent(sig) + '&' + mpExtraQuery() + (calibrate ? '&calibrate=1' : '');
    /* v1.0.12（修正）：分发副本走房主的 http 服务 —— 只有「填了 https:// 的房主地址」才用 https，
       不能因为信令写的是 wss:// 就把它拼成 https（那是两回事）。 */
    const scheme = (s.viaDispatch && s.secure) ? 'https://' : 'http://';
    return scheme + host + ':' + httpPort + '/client/index.html?' + q;
  }
  /** 本站副本要带的信令参数（裸 IP / ws:// 模式，且本站不是 https）：'' = 不带 */
  function mpSignalQuery(v, calibrate) {
    if (PLAT.isPC || !isMpVersion(v)) return '';
    const s = mpParseServer(mpServerRaw());
    if (!s || s.viaDispatch) return '';
    const https = (typeof location !== 'undefined' && location.protocol === 'https:');
    if (https) return ''; // https 站点连不了明文 ws:// → 上面 mpClientUrl 已接管（房主副本 + 新窗口）
    return 'signal=' + encodeURIComponent(mpSignalUrl(s)) + '&' + mpExtraQuery() + (calibrate ? '&calibrate=1' : '');
  }
  function gameUrl(v, calibrate) {
    if (PLAT.gameUrl) { const u = PLAT.gameUrl(v, calibrate); if (u) return u; }
    // v1.0.8/1.0.9：网页版多人版——只当播放器：
    //   ① 房主分发了客户端（填 http://…）→ 直接用它那份；
    //   ② 只填了 IP → 用**本站自带副本** + ?signal=ws://<房主>:8787（本站副本已内置 mdz-signal 模组）；
    //   ③ 没填 → 本站副本原样（单机模拟，自己逛）。
    const remote = mpClientUrl(v, calibrate);
    if (remote) return remote;
    let q = mpSignalQuery(v, calibrate);
    /* v1.0.12（bug 修复）：多人版**即使没填服务器**（用本站自带副本单人模拟）也要带 mdz=1 + 玩家名，
       否则这条路径的客户端页没有防滚动补丁 → 画面右侧仍有滚动条。 */
    if (!q && isMpVersion(v) && !PLAT.isPC) q = mpExtraQuery() + (calibrate ? '&calibrate=1' : '');
    if (!q && calibrate) q = 'calibrate=1';
    return versionsRoot() + encodeURIComponent(v.id) + '/' + encSegs(v.entry || 'index.html') + (q ? '?' + q : '');
  }
  function mediaUrl(v, p) {
    if (PLAT.mediaUrl) { const u = PLAT.mediaUrl(v, p); if (u) return u; }
    return versionsRoot() + encodeURIComponent(v.id) + '/' + encSegs(p);
  }
  // v0.3.5：图标走 mediaUrl（含 PLAT 钩子）——安卓导入版本图标在应用私有目录，经 file 桥加载；
  // 无平台钩子时回退默认 versionsRoot 路径（与旧行为一致）
  function iconUrl(v) { return mediaUrl(v, v.icon || 'icon-256.png'); }
  /** 竖版封面（2:3）；未配置则回退图标 */
  function coverUrl(v) { return v.cover ? mediaUrl(v, v.cover) : ''; }
  function screenshotUrls(v) {
    // config 中截图路径相对 metadata/ 目录 → 统一转成相对版本根（幂等）
    return (v.screenshots || []).map((s) => mediaUrl(v, String(s).indexOf('metadata/') === 0 ? s : 'metadata/' + s));
  }
  /** v0.6.3：截图点击 → 应用内全屏预览（替代 window.open——安卓 WebView 打开图片页占满全屏且无法返回）。
   *  遮罩/×/ESC 关闭；安卓返回键经 adapter __mdzOnBack 关闭（查 .shot-preview）。 */
  function openShotPreview(src) {
    const old = document.querySelector('.shot-preview');
    if (old) old.remove();
    const ov = document.createElement('div');
    ov.className = 'shot-preview';
    ov.innerHTML = '<div class="shot-preview-bg"></div>' +
      '<img src="' + src + '" alt="截图预览">' +
      '<button class="shot-preview-close" title="关闭预览">×</button>';
    const close = () => {
      ov.remove();
      document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    ov.querySelector('.shot-preview-close').onclick = (e) => { e.stopPropagation(); close(); };
    ov.querySelector('.shot-preview-bg').onclick = close;
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
  }
  /** 网格卡片封面比例（仅网格布局）：元数据 cardRatio 支持 "3:2"/"3:4"，默认 "3:4" */
  function cardRatioFor(v) {
    const m = String(v.cardRatio || '3:4').match(/^(\d+):(\d+)$/);
    return m ? (m[1] + '/' + m[2]) : '3/4';
  }
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    t.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t.classList.add('hidden'), 4500);
  }
  function getSel() {
    const v = versions.find((x) => x.id === selectedId) || null;
    // v1.0.45：手机端不可选 desktopOnly 内置版本（列表已隐藏；若选中态残留则视作未选中）
    return (v && !isDesktopHidden(v)) ? v : null;
  }

  // v0.6.5：封面渲染重构——「来回切换白一下」根治（占位符深色化/交叉淡入不放占位符/统一加载兜底）。
  // v0.6.6：修复「列表图标/网格封面一闪一闪」回归——v0.6.5 删掉已加载直接显示分支后，安卓 Capacitor
  // file 桥每次都重新请求图片（img.complete 恒 false）→ 每次重建都重放淡入 = 闪；
  // ① 恢复 loadedCoverUrls 直接显示分支（本会话加载过 → 不再淡入）；
  // ② 新增 dataURL 位图缓存（首载成功后把位图转 dataURL 存内存，重建时同步显示——零网络、零淡入）。
  const loadedCoverUrls = new Set();  // 本会话成功加载过的 URL
  const coverDataUrl = new Map();     // src -> dataURL（已解码位图，重建时同步显示）
  /** 把已加载 img 的位图转 dataURL——重渲染时不再重新请求。
   *  v0.6.70：usePng=true（图标）用 PNG 编码保留透明通道——JPEG 会把透明区压成黑色（列表图标透明背景变黑）；
   *  封面（不透明照片）继续 JPEG 控制体积 */
  function imgToDataUrl(img, usePng) {
    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || 0;
      c.height = img.naturalHeight || 0;
      if (!c.width || !c.height) return '';
      c.getContext('2d').drawImage(img, 0, 0);
      return usePng ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
    } catch (e) { return ''; }
  }
  /** useIcon=true 时强制使用方形图标（列表布局），否则封面优先（网格/详情）；oldImg=切换前详情封面 img（交叉淡入） */
  function coverEl(v, cls, useIcon, oldImg) {
    const div = document.createElement('div');
    div.className = cls;
    const ph = document.createElement('div');
    ph.className = 'cover-ph';
    ph.innerHTML = ico('gamepad');
    const src = useIcon ? iconUrl(v) : (coverUrl(v) || iconUrl(v));
    const ck = src + (useIcon ? '#i' : '#c'); // v0.6.71：图标/封面缓存键分离（防旧 JPEG 图标缓存被复用导致透明变黑）
    // 交叉淡入：旧封面垫底保持可见，新封面加载好后淡入覆盖（v0.6.4）；仅旧图已加载完成时启用
    const cross = !!(oldImg && oldImg.getAttribute('src') && oldImg.getAttribute('src') !== src && oldImg.complete && oldImg.naturalWidth > 0);
    if (cross) {
      oldImg.style.opacity = '1';
      oldImg.classList.add('cover-old');
      div.appendChild(oldImg);
    }
    const img = document.createElement('img');
    img.alt = '';
    if (src) {
      const cached = (!useIcon) ? coverDataUrl.get(ck) : null; // v0.6.72：图标不走 dataURL 缓存（彻底防透明编码变黑）
      if (cached) {
        // 位图缓存：同步解码显示（零网络、零淡入）——安卓「列表/网格不闪」的关键
        img.src = cached;
        loadedCoverUrls.add(ck);
        if (cross) { oldImg.remove(); } // 新图立即可见 → 旧图直接移除
      } else if (loadedCoverUrls.has(ck)) {
        // 本会话加载过（dataURL 缓存失败时兜底）：直接显示不淡入；请求期间占位符垫底
        img.style.opacity = '1';
        img.onload = () => { if (cross) setTimeout(() => { if (oldImg.parentNode === div) oldImg.remove(); }, 350); };
        img.onerror = () => img.remove();
        img.src = src;
      } else {
        // 首次加载：先隐藏（占位符/旧封面垫底可见，绝不露空白）→ 加载完成 → 淡入；成功后转 dataURL 缓存
        img.style.opacity = '0';
        img.style.transition = 'opacity .35s ease';
        const show = () => {
          loadedCoverUrls.add(ck); // v0.6.74：键与上方 has(ck) 一致（此前误记 src，has 永不命中 → 图标每次重建重放淡入 = 点击闪）
          const d = useIcon ? "" : imgToDataUrl(img, false); // v0.6.72：图标不存 dataURL（直链渲染，彻底防变黑）
          if (d) {
            coverDataUrl.set(ck, d);
            // v0.7.1：内存位图缓存上限（防长期使用内存无限增长——超过 80 张淘汰最旧一张）
            if (coverDataUrl.size > 80) {
              const it = coverDataUrl.keys().next();
              if (!it.done) coverDataUrl.delete(it.value);
            }
          }
          if (ph.parentNode === div) ph.remove();
          requestAnimationFrame(() => {
            img.style.opacity = '1';
            if (cross) setTimeout(() => { if (oldImg.parentNode === div) oldImg.remove(); }, 450);
          });
        };
        img.onload = show;
        img.onerror = () => img.remove();
        img.src = src;
        if (img.complete) {
          if (img.naturalWidth > 0) show(); // 浏览器缓存命中已解码 → 立即显示（不闪）
          else img.remove(); // 已失败：保留占位
        }
      }
    } else {
      img.remove();
    }
    if (cross) {
      div.appendChild(img); // 交叉淡入：新图叠在旧图之上，不放占位符（占位符会盖住旧封面）
    } else if (useIcon) {
      div.appendChild(img); // v0.6.73：图标不放占位符垫底（透明底直显——占位符会在重建请求期盖成深块 = 点击列表图标闪）
    } else {
      div.append(ph, img);
    }
    return div;
  }

  // ================= 刷新 =================
  /** 纯静态托管兜底（目录即真相）：versions.json 是构建时的快照，服务器上删了目录后入口会 404，
   *  刷新时自动把这些版本从列表剔除（并提示重新生成清单）。仅静态回退启用；PHP 环境 versions.php
   *  已动态扫描，不做此检查。网络异常不误删（keep）。 */
  async function pruneMissingVersions(list) {
    if (!Array.isArray(list) || !list.length) return list;
    const kept = [];
    let removed = 0;
    for (const v of list) {
      try {
        const r = await fetch(gameUrl(v), { cache: 'no-store' });
        if (r.ok) kept.push(v);
        else { removed++; console.warn('[web] 版本入口不存在，已从列表剔除: ' + v.id); }
      } catch (e) { kept.push(v); }
    }
    if (removed) toast('已隐藏 ' + removed + ' 个入口不存在的版本（服务器上已删除？请重新运行 build-web-dist / build-web-manifest 生成新清单）', true);
    return kept;
  }
  /** 从版本目录读取元数据并覆盖清单字段（v0.4.1）：
   *  描述/作者/版本号/系列/封面/截图等以目录里的 metadata/config.json 为准——修改文件即生效，
   *  无需重新生成 versions.json（PHP 环境 versions.php 已动态扫描，此步仅静态清单来源执行）。
   *  config 内 icon/cover/screenshots 路径相对 metadata/，统一转成相对版本根（幂等）。 */
  async function enrichVersionMeta(v) {
    const base = versionsRoot() + encodeURIComponent(v.id) + '/';
    for (const p of ['metadata/config.json', 'metadata/metadata.json', 'metadata.json', 'version.json']) {
      try {
        const r = await fetch(base + p, { cache: 'no-store' });
        if (!r.ok) continue;
        const m = await r.json();
        if (!m || typeof m !== 'object') continue;
        const mf = (s) => (String(s).indexOf('metadata/') === 0 ? String(s) : 'metadata/' + String(s));
        return {
          ...v,
          name: (m.name !== undefined && m.name !== '') ? m.name : v.name,
          dbKey: (m.dbKey !== undefined && m.dbKey !== '') ? m.dbKey : v.dbKey,
          entry: (m.entry !== undefined && m.entry !== '') ? m.entry : v.entry,
          desc: (m.desc !== undefined) ? m.desc : v.desc,
          author: (m.author !== undefined) ? m.author : v.author,
          version: (m.version !== undefined) ? m.version : v.version,
          // v1.0.6：metadata 的 series 为空串时不再覆盖清单/内置标记里的系列（否则内置版同系列无法折叠成系列项）
          series: (m.series !== undefined && String(m.series).trim() !== '') ? m.series : v.series,
          cardRatio: (m.cardRatio !== undefined && m.cardRatio !== '') ? m.cardRatio : v.cardRatio,
          icon: (m.icon !== undefined && m.icon !== '') ? mf(m.icon) : v.icon,
          cover: (m.cover !== undefined && m.cover !== '') ? mf(m.cover) : v.cover,
          screenshots: Array.isArray(m.screenshots) ? m.screenshots.map(String).filter(Boolean).map(mf) : v.screenshots,
          download: (m.download !== undefined && m.download !== '') ? String(m.download) : v.download
        };
      } catch (e) { /* 读不到就用清单值 */ }
    }
    return v;
  }
  /** v0.3.18：fetch 超时包装（网络/本地资源请求永不挂起，超时 reject） */
  function fetchTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      const t = setTimeout(function () { reject(new Error('fetch timeout ' + ms + 'ms')); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }
  /** v0.3.19：写初始化进度（调试条显示），定位卡死环节 */
  function initStep(s) {
    try { const d = (window.__mdzDiag = window.__mdzDiag || {}); d.initStep = s; } catch (e) {}
  }
  async function fetchVersionList() {
    initStep('fetch-start');
    // v0.3.19：安卓环境（adapter 脚本执行即设 window.__mdzIsAndroid，不依赖 Capacitor 注入时机）
    // 但平台钩子未就绪 → 等待其就绪（最多 3s）。此前误走 web 逻辑 fetch versions.php
    // 在安卓上挂起 → init 卡死 → 列表永远空 + __webApp 永不定义（推送刷新被跳过）
    let P = window.__mdzPlatform || PLAT;
    if (!P.getVersions && window.__mdzIsAndroid) {
      for (let i = 0; i < 30; i++) {
        if (window.__mdzPlatform && window.__mdzPlatform.getVersions) break;
        await new Promise(function (r) { setTimeout(r, 100); });
      }
      P = window.__mdzPlatform || PLAT;
    }
    if (P.getVersions) { initStep('plat-getVersions'); return P.getVersions(); } // 安卓：内置 + 本地导入清单
    let arr = null;
    staticEnv = false;
    // 1) 动态清单（PHP 环境：versions.php 扫描部署目录，目录即真相）——fetch 加超时防挂起
    try {
      const res = await fetchTimeout(fetch('versions.php?t=' + Date.now(), { cache: 'no-store' }), 5000);
      if (res && res.ok) { const j = await res.json(); if (Array.isArray(j)) arr = j; }
    } catch (e) { arr = null; }
    // 2) 静态清单（Halo 等纯静态托管无 PHP：versions.php 404 → 回退 build-web-manifest.js 生成的 versions.json）
    if (!arr) {
      const res = await fetchTimeout(fetch('versions.json?t=' + Date.now(), { cache: 'no-store' }), 5000);
      if (!res || !res.ok) throw new Error('版本清单 ' + (res ? res.status : '超时'));
      const j = await res.json();
      if (Array.isArray(j)) arr = j;
      arr = await pruneMissingVersions(arr); // 快照兜底：剔除入口 404 的版本
      staticEnv = true;
    }
    if (Array.isArray(arr) && arr.length && staticEnv) {
      // 惰性元数据（v0.4.6 分页）：静态清单只含基础字段（id/dbKey/entry 等），
      // 名称/版本号/封面等从版本目录 metadata 读取较慢——只在渲染到某页时再逐版本读取（见 ensurePageMeta），
      // 避免多版本一次性全量 fetch metadata 导致启动慢。
      arr = arr.map((v) => { v._metaLoaded = false; return v; });
    }
    return arr || [];
  }
  /** 仅 PHP 环境可用的设置项：纯静态托管时隐藏（如「生成静态部署清单」按钮）；
   *  v0.7.5：PC 本地版（PLAT.hideStaticSettings）同样无 PHP 端点 → 隐藏该卡 */
  function updateSettingsVisibility() {
    const card = $('settings-export-card');
    if (card) card.style.display = (staticEnv || PLAT.hideStaticSettings) ? 'none' : '';
  }
  /** v0.6.1：版本列表排序——按名称（缺省用 id）升序，名称相同按版本号（自然序）再排。web/PC 一致。
   *  v1.0.45：sortFirst 标记（内置置顶版本，如 minidayz-pc）恒排最前（多者按名称），其余照旧。 */
  function sortVersions(list) {
    return (list || []).slice().sort((a, b) => {
      if (!!a.sortFirst !== !!b.sortFirst) return a.sortFirst ? -1 : 1;
      const na = String(a.name || a.id || '').toLowerCase();
      const nb = String(b.name || b.id || '').toLowerCase();
      const r = na.localeCompare(nb, undefined, { numeric: true, sensitivity: 'base' });
      if (r !== 0) return r;
      return String(a.version || '').localeCompare(String(b.version || ''), undefined, { numeric: true, sensitivity: 'base' });
    });
  }
  async function refresh() {
    // v0.3.19：分步容错重写——任何一步异常都不阻断整体流程（此前某步抛错会让 init 的
    // await refresh() 中断 → __webApp 永不定义 → 列表空 + 导入/推送刷新全被跳过）
    try {
      const raw = await fetchVersionList();
      (raw || []).forEach(decorateVersion); // v1.0.45：内置特殊版本打标（directUrl/noSave/noKeymap/desktopOnly/sortFirst）
      versions = sortVersions(raw); // v0.6.1：加载后统一排序（名称 → 版本号）
    } catch (e) {
      console.error(e);
      try { toast('加载版本清单失败: ' + e.message, true); } catch (e2) {}
      versions = [];
    }
    initStep('fetch-done');
    try { if (!getSel() && versions.length) selectedId = versions[0].id; listSelMuted = false; qlActiveId = null; } catch (e) {} // v0.6.62/64：刷新回列表语境恢复正常高亮、清快捷启动选中态
    try { renderDetail(); } catch (e) { console.error('[refresh] renderDetail:', e); }
    try { renderLibrary(); } catch (e) { console.error('[refresh] renderLibrary:', e); }
    try { renderSaveList(true); } catch (e) { console.error('[refresh] renderSaveList:', e); } // v0.6.61：强制重扫（数据变更后准确）
    try { syncControls(getSel()); } catch (e) { console.error('[refresh] syncControls:', e); }
    try { updateSettingsVisibility(); } catch (e) {} // 静态托管时隐藏仅 PHP 可用的设置项
    initStep('render-done');
  }
  $('btn-refresh').onclick = refresh;

  // ================= 详情 =================
  // 【实验性布局（可能删除）】v0.4.6：详情面板改为「浏览器窗口式」——顶部栏与游戏内嵌播放器
  // 的 player-bar 同尺寸；v0.4.8：顶部栏显示「版本信息」标题（左居中），内嵌播放时整个详情块隐藏（标题自然不出现）。
  function renderDetail() {
    const panel = $('detail-panel');
    const v = getSel();
    if (!v) { panel.innerHTML = '<div class="detail-empty">从下方选择一个版本开始。</div>'; return; }
    const cur = resFor(v.id);
    // v0.6.4：切换版本前先摘出旧详情封面 img——清空后交给新 coverEl 做交叉淡入（旧图保持到新图加载好）
    let oldCoverImg = panel.querySelector('.detail-window .detail-cover img');
    if (oldCoverImg) oldCoverImg.remove();
    panel.innerHTML = '';

    const win = document.createElement('div');
    win.className = 'detail-window';
    const bar = document.createElement('div');
    bar.className = 'detail-window-bar';
    const barTitle = document.createElement('span');
    barTitle.className = 'detail-window-title';
    barTitle.textContent = '版本信息';
    bar.appendChild(barTitle); // v0.4.8：标题移到详情窗口顶部栏（左居中）
    const body = document.createElement('div');
    body.className = 'detail-window-body';

    const left = document.createElement('div');
    left.className = 'detail-left';
    left.appendChild(coverEl(v, 'detail-cover', false, oldCoverImg));

    const btns = document.createElement('div');
    btns.className = 'detail-btns';
    const launchBtn = document.createElement('button');
    launchBtn.className = 'primary btn-launch';
    launchBtn.innerHTML = ico('play') + '<span>启动</span>';
    const cfgBtn = document.createElement('button');
    cfgBtn.className = 'btn-more';
    cfgBtn.innerHTML = ico('gear');
    cfgBtn.title = '配置：播放方式、分辨率、存档、按键映射、版本信息';
    btns.append(launchBtn, cfgBtn);
    left.appendChild(btns);
    // v0.5.0：下载按钮（启动/配置下方）——链接优先级：版本元数据 download > mdz-config 默认下载链接
    // v1.0.43：安卓不创建（侧边栏已有「下载游戏」入口，无需重复；此前靠 adapter CSS 隐藏，DOM 仍渲染）
    // v0.7.11：PC 详情同样不创建（本地版无下载需求；侧边栏「下载游戏」保留）
    if (!PLAT.isAndroid && !PLAT.hideDownload) {
      const dlBtn = document.createElement('button');
      dlBtn.className = 'btn-download';
      dlBtn.innerHTML = ico('import') + '<span>下载</span>';
      dlBtn.title = '下载本版本';
      dlBtn.onclick = (e) => { e.stopPropagation(); openDownload(v); };
      left.appendChild(dlBtn);
    }

    const info = document.createElement('div');
    info.className = 'detail-info';
    // v0.4.6：详情 meta 不显示版本号/ID/dbKey（版本号移到标题旁徽标；ID/dbKey 移到配置弹窗）
    // v1.0.45：directUrl 内置版本无分辨率概念（直链画布自管）→ meta 不显示分辨率行
    const meta = [
      ['作者', v.author || '—'],
      ['系列', v.series || '—']
    ];
    meta.push(['分辨率', cur.w + '×' + cur.h]); // v0.7.6：directUrl 版也显示（默认 850×890 原生，宽可调）
    meta.push(['添加时间', v.builtin ? '自带' : (v.addedAt ? new Date(v.addedAt).toLocaleDateString() : '—')]);
    const shots = screenshotUrls(v);
    // v0.4.6：标题旁徽标显示版本号（v.version）而非 key/id；无版本号则不显示徽标
    info.innerHTML =
      '<h3>' + esc(v.name || v.id) + (v.version ? ' <span class="badge">' + esc(v.version) + '</span>' : '') + '</h3>' +
      '<div class="dmeta">' + meta.map(([k, val]) => '<div class="dline"><span>' + esc(k) + '</span><b>' + esc(val) + '</b></div>').join('') + '</div>' +
      (shots.length ? '<div class="shot-row">' + shots.map((u) => '<img class="shot" src="' + u + '" alt="截图">').join('') + '</div>' : '') +
      (v.desc ? '<p class="muted detail-hint">' + esc(v.desc) + '</p>' : '');
    body.append(left, info);
    win.append(bar, body);
    panel.appendChild(win);

    // v0.6.3：截图点击 → 应用内预览（openShotPreview），不再 window.open
    info.querySelectorAll('.shot').forEach((im) => {
      im.onclick = (e) => { e.stopPropagation(); openShotPreview(im.src); };
    });

    launchBtn.onclick = () => launchVersion(v, modeFor(v.id));
    cfgBtn.onclick = (e) => { e.stopPropagation(); openConfigDialog(v); };
  }

  // ================= 库（v0.4.6 分页：列表 10 个/页，网格按当前可视尺寸计算每页数量） =================
  function setLibView(mode) { libView = mode; libPage = 0; renderLibrary(); }
  $('view-toggle-grid').onclick = () => setLibView('grid');
  $('view-toggle-list').onclick = () => setLibView('list');
  // v0.5.0：版本搜索（按名称/ID 过滤，web/PC 一致）
  (function () {
    const inp = $('lib-search');
    if (!inp) return;
    inp.addEventListener('input', () => { libQuery = inp.value; libPage = 0; renderLibrary(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { inp.value = ''; libQuery = ''; libPage = 0; renderLibrary(); inp.blur(); } });
  })();

  /** 网格每页数量：按当前容器宽度算列数（与 CSS auto-fill minmax 一致）× 可视高度可放行数 */
  function gridPageSize() {
    const wrap = $('versions');
    let w = wrap ? wrap.clientWidth : 0;
    if (w <= 0) w = window.innerWidth - (isMobile() ? 28 : 300); // 视图隐藏时按窗口宽估算
    const mq = isMobile();
    const min = mq ? 108 : 150;
    const gap = mq ? 10 : 14;
    const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
    const rowH = Math.round(min * 4 / 3) + 46 + gap; // 封面(4:3) + 名称行 + 间距
    const rows = Math.max(2, Math.floor((window.innerHeight - 240) / rowH));
    return cols * rows;
  }
  function pageSizeFor() { return libView === 'list' ? LIST_PAGE_SIZE : gridPageSize(); }
  function filteredVersions() {
    // v1.0.45：desktopOnly 版本在手机端（触屏/窄视口）不可见——桌面视口照常显示（列表/搜索/分页统一走这里）
    const base = versions.filter((v) => !isDesktopHidden(v));
    const q = libQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter((v) =>
      (v.name || '').toLowerCase().indexOf(q) >= 0 ||
      (v.id || '').toLowerCase().indexOf(q) >= 0 ||
      (v.version || '').toLowerCase().indexOf(q) >= 0
    );
  }
  // v0.6.0：列表布局系列分组（简单版）——同一系列（≥2 个版本）折叠为一条「系列项」。
  // v0.6.2：交互重做——①单开（openSeriesKey 单值：点击其他列表项时其他展开的系列自动收起）；
  // ②点击系列头=选中首版+展开自己；展开按钮=切换；点击子项目保持所属系列展开；
  // ③排序：系列项整体在前（按系列名）、单版本在后（名称→版本号）。
  /** 列表布局条目化：系列分组（系列项在前）+ 单版本行；网格布局返回原版本数组 */
  function listItems() {
    const list = sortVersions(filteredVersions()); // v0.6.1 全局排序（名称缺省 id → 版本号）
    if (libView !== 'list') return list;
    /** v1.0.6：把一组版本按 series 折叠（≥2 个成员才是系列项；单成员摊平成普通行）
     *  keepOrder=true 按传入顺序排系列项（置顶块用；false 按系列名排序） */
    function groupSeries(arr, keepOrder) {
      const items = [];
      const singles = [];
      const groups = new Map();
      for (const v of arr) {
        const key = (v.series || '').trim();
        if (!key) { singles.push(v); continue; }
        let g = groups.get(key);
        if (!g) { g = []; groups.set(key, g); items.push({ series: key, children: g, sortFirst: !!v.sortFirst }); }
        g.push(v);
      }
      // 只有 1 个版本的系列摊平为普通行（折叠无意义）；多版本系列保留为系列项
      const flat = [];
      const kept = [];
      for (const it of items) {
        if (it.children.length === 1) flat.push(it.children[0]); else kept.push(it);
      }
      kept.sort(keepOrder
        ? (a, b) => arr.indexOf(a.children[0]) - arr.indexOf(b.children[0])
        : (a, b) => String(a.series).localeCompare(String(b.series), undefined, { numeric: true, sensitivity: 'base' }));
      return { kept, singles: singles.concat(flat) };
    }
    // v1.0.45：sortFirst 内置版本恒置顶（如 minidayz-pc）——即使其它版本同 series 折叠成系列项也在其前；
    // v1.0.6：置顶块内部也按 series 折叠 → PC 单机版 + 多人版 = 一条系列项（父级行 + 展开子项；随后接虚线分隔，见 renderPageCards）
    const firsts = [];
    const rest = [];
    for (const v of list) { (v.sortFirst ? firsts : rest).push(v); }
    const fi = groupSeries(firsts, true);
    const ri = groupSeries(rest, false);
    return [...fi.kept, ...fi.singles, ...ri.kept, ...sortVersions(ri.singles)];
  }
  /* ===== v1.0.7：联机配置页（服务器（信令）/ 客户端分发 / 房间创建程序）=====
     三件套都能在启动器里一键启停，也都能脱离启动器单独使用；
     原生能力由 window.__launcherNative 提供（PC 启动器）；网页版没有原生能力时只显示地址与说明。 */
  let lanStatus = null;
  let lanLogs = [];   // 联机配置页的日志缓冲（主进程 lan:log 事件累积）
  function lanNative() {
    try { return (window.__launcherNative && window.__launcherNative.lanStatus) ? window.__launcherNative : null; } catch (e) { return null; }
  }
  function lanRefresh() {
    const n = lanNative();
    if (!n) { lanStatus = null; try { renderLanPage(); } catch (e) {} return; }
    n.lanStatus().then((st) => { lanStatus = st; renderLanPage(); }).catch(() => {});
    if (!lanRefresh.hooked) {
      lanRefresh.hooked = true;
      try { if (n.onLanStatus) n.onLanStatus((st) => { lanStatus = st; renderLanPage(); }); } catch (e) {}
      try {
        if (n.onLanLog) n.onLanLog((line) => {
          lanLogs.push(line);
          if (lanLogs.length > 80) lanLogs.shift();
          const box = document.getElementById('lan-log');
          if (box) { box.textContent = lanLogs.join('\n'); box.scrollTop = box.scrollHeight; }
        });
      } catch (e) {}
    }
  }
  function lanCard(title, tip) {
    const card = document.createElement('div');
    card.className = 'settings-card';
    const h = document.createElement('h4');
    h.textContent = title;
    card.appendChild(h);
    if (tip) {
      const p = document.createElement('p');
      p.className = 'muted settings-tip';
      p.style.whiteSpace = 'pre-line';
      p.textContent = tip;
      card.appendChild(p);
    }
    return card;
  }
  function lanAction(text, fn, opts) {
    const b = document.createElement('button');
    b.className = 'settings-btn';
    b.textContent = text;
    if (opts && opts.ghost) b.style.opacity = '0.85';
    if (opts && opts.margin) b.style.marginRight = '8px';
    b.onclick = fn;
    return b;
  }
  /** 联机配置页渲染（进入视图或状态变化时调用；原生能力缺失时显示说明） */
  function renderLanPage() {
    const host = document.getElementById('lan-panel');
    if (!host) return;
    const n = lanNative();
    const st = lanStatus;
    if (!n) {
      if (!host.dataset.built) {
        host.dataset.built = '1';
        host.innerHTML = '';
        const card = lanCard('多人联机（网页版说明）',
          '网页版不能启动本机服务（浏览器不能监听端口/起进程）。玩法：\n' +
          '① 房主在自己的电脑上运行「建房程序」+「服务器（信令）」；\n' +
          '② 把服务器的分发地址发给玩家，玩家用浏览器打开即可进入多人版；\n' +
          '③ 想用别人开的服务器，就把它的地址填到下面。');
        const row = document.createElement('div');
        row.className = 'row';
        const lab = document.createElement('span'); lab.className = 'muted'; lab.textContent = '服务器地址';
        const inp = document.createElement('input');
        inp.type = 'text'; inp.className = 'res-select'; inp.style.minWidth = '240px';
        inp.placeholder = '例如 192.168.1.11 或 服务器域名';
        inp.value = lsGet('mdz-lan-host', '');
        inp.onchange = () => { lsSet('mdz-lan-host', inp.value.trim()); toast('已记住服务器地址：' + (inp.value.trim() || '（本机）')); };
        row.appendChild(lab); row.appendChild(inp);
        card.appendChild(row);
        host.appendChild(card);
      }
      return;
    }
    // 每次重建（状态会变；结构简单，重建最稳）
    host.innerHTML = '';
    host.dataset.built = '1';
    const lan = (st && st.lan) || {};
    const ep = (st && st.endpoints) || {};
    const sig = (st && st.signal) || {};
    const serve = (st && st.serve) || {};
    const hst = (st && st.host) || {};

    // ① 服务器（信令）
    const c1 = lanCard('服务器（信令）',
      '谁在线、有哪些房间、转发握手包；游戏数据走 P2P 不经过它。\n' +
      '「本机对外地址」= 房主告诉别人用的 IP（留空 = 127.0.0.1）；具体要连的地址与玩家名称在「多人版 → 配置」里改。');
    const r1 = document.createElement('div');
    r1.className = 'row';
    const lb1 = document.createElement('span'); lb1.className = 'muted'; lb1.textContent = '本机对外地址';
    const inHost = document.createElement('input');
    inHost.type = 'text'; inHost.className = 'res-select'; inHost.style.minWidth = '220px';
    inHost.placeholder = '留空 = 本机';
    inHost.value = lan.serverHost || '';
    const lb2 = document.createElement('span'); lb2.className = 'muted'; lb2.textContent = '信令端口';
    const inSig = document.createElement('input');
    inSig.type = 'number'; inSig.className = 'res-select'; inSig.style.width = '90px';
    inSig.value = lan.signalPort || 8787;
    const lb3 = document.createElement('span'); lb3.className = 'muted'; lb3.textContent = '分发端口';
    const inHttp = document.createElement('input');
    inHttp.type = 'number'; inHttp.className = 'res-select'; inHttp.style.width = '90px';
    inHttp.value = lan.httpPort || 8088;
    /* v1.0.11：玩家名称已挪到「多人版」条目的配置弹窗里（见 openConfigDialog），此处不再重复 */
    r1.append(lb1, inHost, lb2, inSig, lb3, inHttp);
    c1.appendChild(r1);
    const r1b = document.createElement('div');
    r1b.className = 'row';
    r1b.appendChild(lanAction('保存设置', () => {
      n.setLan({ serverHost: inHost.value, signalPort: inSig.value, httpPort: inHttp.value }).then((r) => {
        toast('联机设置已保存');
        if (r && r.status) { lanStatus = r.status; renderLanPage(); lanRefresh(); }
      });
    }, { margin: true }));
    r1b.appendChild(lanAction(sig.running ? '停止信令服务器' : '启动信令服务器', () => {
      n.lanSignal(sig.running ? 'stop' : 'start').then((s) => { lanStatus = s; renderLanPage(); });
    }, { margin: true }));
    c1.appendChild(r1b);
    const s1 = document.createElement('p');
    s1.className = 'muted settings-tip';
    s1.style.whiteSpace = 'pre-line';
    s1.textContent = '状态：' + (sig.running ? ('已启动 0.0.0.0:' + sig.port + '（在线 ' + (sig.clients || 0) + '，房间 ' + ((sig.games || []).length) + '）') : '未启动') +
      '\n当前地址：信令 ' + (ep.signalUrl || '') + (st && !st.lanDir ? '\n⚠ 没找到工具包脚本目录（signal-server / lan-host）' : '');
    c1.appendChild(s1);
    host.appendChild(c1);

    // ② 客户端分发
    const c2 = lanCard('客户端分发（把游戏发给别人）',
      '把多人版客户端用 http 发给同网络的玩家；在他们浏览器里打开下面的地址即可（信令地址会自动指向这台）。');
    const r2 = document.createElement('div');
    r2.className = 'row';
    r2.appendChild(lanAction(serve.running ? '停止分发' : '启动分发', () => {
      n.lanServe(serve.running ? 'stop' : 'start').then((s) => { lanStatus = s; renderLanPage(); });
    }, { margin: true }));
    r2.appendChild(lanAction('复制分发地址', () => {
      const urls = serve.urls || [];
      const u = urls[0] || ep.clientUrl || '';
      if (!u) { toast('先启动分发服务', true); return; }
      try { navigator.clipboard.writeText(u); toast('已复制：' + u); } catch (e) { toast(u); }
    }, { ghost: true, margin: true }));
    r2.appendChild(lanAction('打开客户端', () => {
      n.lanPlay({ w: (lsGet('mdz-res-__lan_client__', null) || {}).w, h: (lsGet('mdz-res-__lan_client__', null) || {}).h }).then((r) => {
        if (r && r.error) toast(r.error, true);
      });
    }, { margin: true }));
    c2.appendChild(r2);
    const s2 = document.createElement('p');
    s2.className = 'muted settings-tip';
    s2.style.whiteSpace = 'pre-line';
    const urls = (serve.urls || []);
    s2.textContent = '状态：' + (serve.running ? '已启动（端口 ' + serve.port + '）' : '未启动') +
      (urls.length ? ('\n玩家地址：\n' + urls.map((u) => '  ' + u).join('\n')) : ('\n本机地址：' + (ep.clientUrl || '')));
    c2.appendChild(s2);
    host.appendChild(c2);

    // ③ 房间创建程序（建房程序）—— v1.0.7：随启动器自带（PC），不再让用户选路径
    // macOS 移植：NW.js 在 mac 上的可执行文件是 nwjs.app/Contents/MacOS/nwjs，这里的提示文案按平台走
    const NW_LABEL = (window.__launcherNative && window.__launcherNative.platform === 'darwin')
      ? 'nwjs（macOS 构建）' : 'nw.exe';
    const c3 = lanCard('房间创建程序（建房）',
      '真正建房的是这份「服务端」程序（NW.js）。启动后在它的窗口里填服务器名 → 点 [Launch server] 建房。' +
      (hst.bundled ? '\n（已随启动器自带，无需手动指定目录）' : ''));
    const r3 = document.createElement('div');
    r3.className = 'row';
    if (hst.bundled) {
      const lbB = document.createElement('span');
      lbB.className = 'muted';
      lbB.textContent = '程序位置：随启动器自带';
      r3.appendChild(lbB);
    } else {
      const lb4 = document.createElement('span'); lb4.className = 'muted'; lb4.textContent = '程序目录';
      const inDir = document.createElement('input');
      inDir.type = 'text'; inDir.className = 'res-select'; inDir.style.minWidth = '300px';
      inDir.placeholder = '含 ' + NW_LABEL + ' 的目录（留空自动探测）';
      inDir.value = lan.hostDir || (hst.dir || '');
      const pickBtn = lanAction('选择…', () => {
        if (!n.lanPickHostDir) return;
        n.lanPickHostDir().then((r) => {
          if (r && r.canceled) return;
          toast('建房程序目录已保存');
          if (r && r.status) { lanStatus = r.status; renderLanPage(); }
        });
      }, { margin: true });
      const saveDirBtn = lanAction('保存目录', () => {
        n.setLan({ hostDir: inDir.value }).then((r) => { toast('已保存'); if (r && r.status) { lanStatus = r.status; renderLanPage(); } });
      }, { margin: true });
      r3.append(lb4, inDir, pickBtn, saveDirBtn);
    }
    c3.appendChild(r3);
    const r3b = document.createElement('div');
    r3b.className = 'row';
    r3b.appendChild(lanAction(hst.running ? '关闭建房程序' : '启动建房程序', () => {
      n.lanHost(hst.running ? 'stop' : 'start').then((s) => { lanStatus = s; renderLanPage(); toast(hst.running ? '已关闭建房程序' : '已启动建房程序：在它的窗口里点 Launch server'); });
    }));
    c3.appendChild(r3b);
    const s3 = document.createElement('p');
    s3.className = 'muted settings-tip';
    s3.style.whiteSpace = 'pre-line';
    s3.textContent = '状态：' + (hst.running ? ('运行中（pid ' + hst.pid + '）') : (hst.exists ? ('未运行 · 已找到 ' + NW_LABEL + '（' + (hst.dir || '') + '）') : '未找到 ' + NW_LABEL + ' —— 把服务端包解压到该目录，或点「选择…」指定'));
    c3.appendChild(s3);
    host.appendChild(c3);

    // ④ 日志
    const c4 = lanCard('运行日志（最近）', '');
    const logBox = document.createElement('pre');
    logBox.id = 'lan-log';
    logBox.style.cssText = 'max-height:180px;overflow:auto;font-size:11.5px;line-height:1.55;opacity:.85;white-space:pre-wrap;margin:0;';
    logBox.textContent = lanLogs.join('\n') || '（暂无日志）';
    c4.appendChild(logBox);
    host.appendChild(c4);
  }
  function pageCount() { return Math.max(1, Math.ceil(listItems().length / pageSizeFor())); }
  function pagedItems() {
    const list = listItems();
    const size = pageSizeFor();
    const pages = Math.max(1, Math.ceil(list.length / size));
    if (libPage >= pages) libPage = pages - 1;
    return list.slice(libPage * size, libPage * size + size);
  }
  /** 惰性元数据：只对当前页条目展开后的版本读取目录 metadata（静态托管时多版本逐版本 fetch 是启动慢主因） */
  async function ensurePageMeta() {
    // v0.7.2：v && 防御——静态分支异步重入/翻页时 page 可能含已被置换的条目，跳过未定义元素
    const page = pagedItems().flatMap((it) => (it.series ? it.children : [it]));
    await Promise.all(page.filter((v) => v && !v._metaLoaded).map(async (v) => {
      try { Object.assign(v, await enrichVersionMeta(v)); } catch (e) {}
      v._metaLoaded = true;
    }));
  }
  /** 重渲染当前页卡片（元数据到位后调用，不改页码） */
  function renderPageCards() {
    const wrap = $('versions');
    wrap.innerHTML = '';
    const items = pagedItems();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const el = libView === 'list' ? (it.children ? seriesBlock(it) : listRow(it)) : gridItem(it);
      // v1.0.45：列表布局——sortFirst 内置版本（置顶块）与后续普通版本之间插虚线分隔
      if (libView === 'list' && it.sortFirst) el.classList.add('list-first-row');
      wrap.appendChild(el);
      if (libView === 'list' && it.sortFirst && i + 1 < items.length && !items[i + 1].sortFirst) {
        const sep = document.createElement('div');
        sep.className = 'list-first-sep';
        wrap.appendChild(sep);
      }
    }
  }
  /** 系列折叠项：整体卡片（系列头 + 展开的子版本行）；v0.6.3：选择框挂整体块（open/selected） */
  function seriesBlock(it) {
    const wrap = document.createElement('div');
    const open = openSeriesKey === it.series;
    const sel = it.children.some((c) => c.id === selectedId) && !listSelMuted; // v0.6.62：ql 静默期不高亮
    wrap.className = 'series-block' + (open ? ' open' : '') + (sel ? ' selected' : '');
    const head = document.createElement('div');
    head.className = 'list-row series-head';
    head.append(coverEl(it.children[0], 'lr-cover', true)); // 系列图标 = 排序后第一个版本的图标（children 按 listItems 排序顺序 push，v0.6.1 确认记录）
    const info = document.createElement('div');
    info.className = 'lr-info';
    info.innerHTML = '<h4>' + esc(it.series) + '</h4><span>' + it.children.length + ' 个版本</span>';
    const expandBtn = document.createElement('button');
    expandBtn.className = 'lr-config series-expand';
    expandBtn.textContent = open ? '收起' : '展开';
    expandBtn.title = '展开/收起该系列版本';
    // v0.6.2 交互（单开）：展开按钮 = 切换（展开时收起其他）；系列头 = 选中首版 + 展开自己；
    // 子项目点击（listRow isChild）保持所属系列展开；点击单版本行收起所有展开系列（见 listRow）
    expandBtn.onclick = (e) => {
      e.stopPropagation();
      openSeriesKey = (openSeriesKey === it.series) ? null : it.series;
      renderLibrary();
    };
    head.onclick = () => {
      openSeriesKey = it.series; // 展开自己（单开：其他系列自动收起）
      selectVersion(it.children[0].id); // 选中系列首版（selectVersion 内部 renderLibrary）
    };
    head.append(info, expandBtn);
    wrap.appendChild(head);
    const sub = document.createElement('div');
    sub.className = 'series-children' + (open ? '' : ' hidden');
    for (const c of it.children) {
      const row = listRow(c, true); // isChild：点击子项目不收起所属系列
      row.classList.add('series-child-row');
      sub.appendChild(row);
    }
    wrap.appendChild(sub);
    return wrap;
  }
  function renderPager() {
    let pg = $('lib-pager');
    if (!pg) {
      pg = document.createElement('div');
      pg.id = 'lib-pager';
      pg.className = 'pager';
      pg.innerHTML =
        '<button id="pg-prev" title="上一页">' + ico('chevronL') + '</button>' +
        '<span id="pg-info" class="pg-info"></span>' +
        '<button id="pg-next" title="下一页">' + ico('chevronR') + '</button>';
      $('versions').after(pg);
      pg.querySelector('#pg-prev').onclick = () => { if (libPage > 0) { libPage--; renderLibrary(); } };
      pg.querySelector('#pg-next').onclick = () => { if (libPage < pageCount() - 1) { libPage++; renderLibrary(); } };
    }
    const pages = pageCount();
    pg.classList.toggle('hidden', pages <= 1);
    pg.querySelector('#pg-info').textContent = libPage + 1 + ' / ' + pages + '（共 ' + listItems().length + '）';
    pg.querySelector('#pg-prev').disabled = libPage <= 0;
    pg.querySelector('#pg-next').disabled = libPage >= pages - 1;
  }
  async function renderLibrary() {
    const wrap = $('versions');
    wrap.className = 'cards ' + (libView === 'list' ? 'list' : 'grid');
    const list = filteredVersions();
    $('empty-tip').classList.toggle('hidden', list.length > 0);
    $('lib-count').textContent = list.length ? '(' + list.length + ')' : '';
    $('view-toggle-grid').classList.toggle('active', libView !== 'list');
    $('view-toggle-list').classList.toggle('active', libView === 'list');
    renderPageCards();
    renderPager();
    renderQuickLaunch(); // v0.6.56：快捷启动（最近 + 置顶）——列表渲染后同步（含选中高亮）
    if (staticEnv) { // 静态托管：当前页元数据就绪后重渲染（名称/版本号/封面更新）
      const mark = libPage;
      await ensurePageMeta();
      if (mark === libPage) { renderPageCards(); renderPager(); try { renderQuickLaunch(); } catch (e) {} }
    }
  }
  /** 版本列表内手动选中（行/卡/系列头点击）——恢复列表高亮并收起其他展开系列；
   *  快捷启动自身的选中提示被清空（焦点在版本列表，避免同版本两处选择框） */
  function selectVersion(id) {
    listSelMuted = false; // 用户在版本列表操作 → 列表恢复正常选中高亮
    selectedId = id;
    qlActiveId = null;
    renderDetail();
    renderLibrary();
    syncControls(getSel());
  }
  /** v0.6.62/64：点击快捷启动（置顶列表 head/子行/启动）→ 详情切换 + 版本列表静默（收起系列、同版本不加框）；
   *  快捷启动自身选中提示记入 qlActiveId（只由这里更新——版本列表高亮不会传导到快捷启动，反之亦然） */
  function qlSelect(id) {
    listSelMuted = true;
    selectedId = id;
    qlActiveId = id;
    openSeriesKey = null; // 版本列表系列自动收起（同版本列表点击单行一样归位）
    renderDetail();
    renderLibrary();
    syncControls(getSel());
  }

  function gridItem(v) {
    const el = document.createElement('div');
    el.className = 'cover-card' + ((v.id === selectedId && !listSelMuted) ? ' selected' : '');
    const cover = coverEl(v, 'cover');
    cover.style.aspectRatio = cardRatioFor(v); // 网格卡片比例可配置（3:2 / 3:4），图片 contain 不裁切
    const badge = document.createElement('span');
    badge.className = 'cover-badge';
    badge.textContent = v.version || v.id; // 版本号优先（如 v2.3.3），无版本号回退 id
    cover.appendChild(badge);
    // 启动：卡片居中白色播放图标（hover 显示），非整块按钮
    const chip = document.createElement('div');
    chip.className = 'launch-chip';
    chip.title = '启动 ' + (v.name || v.id);
    chip.innerHTML = ico('play');
    chip.onclick = (e) => { e.stopPropagation(); launchVersion(v, modeFor(v.id)); };
    cover.appendChild(chip);
    el.append(cover);
    const info = document.createElement('div');
    info.className = 'cover-info';
    info.innerHTML = '<div class="cn">' + esc(v.name || v.id) + '</div>';
    el.append(info);
    el.onclick = () => selectVersion(v.id);
    return el;
  }
  /** 列表布局行。qlRow=true → 该行属于快捷启动（children）：
   *  点击走 qlSelect；选中高亮跟随 qlActiveId（仅 ql 内交互更新）——版本列表的高亮不会传导到这里 */
  function listRow(v, isChild, qlRow) {
    const el = document.createElement('div');
    el.className = 'list-row' + ((qlRow ? (v.id === qlActiveId) : (v.id === selectedId && !listSelMuted)) ? ' selected' : '');
    el.append(coverEl(v, 'lr-cover', true)); // 列表布局用方形图标，不用竖版封面
    const info = document.createElement('div');
    info.className = 'lr-info';
    // v0.4.6：名称下方显示版本号（v.version），不再显示 key/id；无版本号显示「—」
    info.innerHTML = '<h4>' + esc(v.name || v.id) + '</h4><span>' + esc(v.version || '—') + '</span>';
    // v1.0.5：行按钮「图标化」改为 **CSS 驱动**（媒体查询实时生效——PC 浏览器窗口缩到手机宽度立即切换，
    // 不需要刷新/重渲染）。结构固定：配置 = 齿轮(仅紧凑态显示) + 文字；启动 = 播放图标 + 文字(紧凑态隐藏)。
    // 桌面观感与 v1.0.3 完全一致（齿轮 display:none 不占位）；紧凑判定见 launcher.css（pointer:coarse / ≤820px）。
    const cfgBtn = document.createElement('button');
    cfgBtn.className = 'lr-config lr-rowbtn';
    cfgBtn.innerHTML = ico('gear', 'lr-icon-compact') + '<span class="lr-label">配置</span>';
    cfgBtn.setAttribute('aria-label', '启动配置');
    cfgBtn.title = '启动配置（播放方式、分辨率）';
    cfgBtn.onclick = (e) => { e.stopPropagation(); openConfigDialog(v); };
    const btn = document.createElement('button');
    btn.className = 'primary lr-play lr-rowbtn';
    btn.innerHTML = ico('play') + '<span class="lr-label">启动</span>';
    btn.setAttribute('aria-label', '启动');
    btn.onclick = (e) => { e.stopPropagation(); launchVersion(v, modeFor(v.id), undefined, qlRow); };
    el.append(info, cfgBtn, btn);
    // v0.6.2：点击单版本行 → 收起展开的系列（聚焦）；系列子行（isChild）→ 保持所属系列展开
    // v0.6.62 修正④：快捷启动行（qlRow）→ qlSelect（版本列表自动收起 + 同版本不加选中框）
    el.onclick = () => {
      if (qlRow) { qlSelect(v.id); return; }
      if (!isChild) openSeriesKey = null;
      selectVersion(v.id);
    };
    return el;
  }

  // ================= 分辨率控件 =================
  /** 兼容PC分辨率专属控件（v0.4.9）：「自动（最佳）」默认，或手动选预设/自定义；
   *  值存 mdz-compat-res-<id>（区别于普通 mdz-res-<id>），未设置=自动 */
  function buildCompatResControl(v) {
    const wrap = document.createElement('div');
    wrap.className = 'res-row';
    const label = document.createElement('span');
    label.className = 'res-label';
    label.textContent = '逻辑分辨率';
    const sel = document.createElement('select');
    sel.className = 'res-select';
    const cur = lsGet('mdz-compat-res-' + v.id, null);
    // 选项：自动（视口最佳）+ 物理屏幕 + 预设 + 自定义（v0.6.43：新增物理屏幕）
    const optAuto = document.createElement('option');
    optAuto.value = 'auto';
    optAuto.textContent = '自动（视口最佳）';
    sel.appendChild(optAuto);
    const optPhys = document.createElement('option');
    optPhys.value = 'physical';
    optPhys.textContent = '物理屏幕（按硬件比例）';
    sel.appendChild(optPhys);
    for (const p of PRESETS) {
      const o = document.createElement('option');
      o.value = p.custom ? 'custom' : (p.w + 'x' + p.h);
      o.textContent = p.label;
      sel.appendChild(o);
    }
    const isCustom = cur && !cur.physical && !PRESETS.some((p) => !p.custom && p.w === cur.w && p.h === cur.h);
    sel.value = cur ? (cur.physical ? 'physical' : (isCustom ? 'custom' : (cur.w + 'x' + cur.h))) : 'auto';
    const customBox = document.createElement('div');
    customBox.className = 'res-custom hidden';
    const wInp = document.createElement('input');
    wInp.type = 'number'; wInp.min = '320'; wInp.max = '7680'; wInp.value = (cur && cur.w) || 1280;
    const xSpan = document.createElement('span');
    xSpan.textContent = ' × ';
    const hInp = document.createElement('input');
    hInp.type = 'number'; hInp.min = '240'; hInp.max = '4320'; hInp.value = (cur && cur.h) || 720;
    const applyBtn = document.createElement('button');
    applyBtn.className = 'res-apply';
    applyBtn.textContent = '应用';
    customBox.append(wInp, xSpan, hInp, applyBtn);
    if (sel.value === 'custom') customBox.classList.remove('hidden');
    function applyCustom() {
      const w = parseInt(wInp.value, 10), h = parseInt(hInp.value, 10);
      if (!Number.isFinite(w) || !Number.isFinite(h)) { toast('分辨率无效', true); return; }
      lsSet('mdz-compat-res-' + v.id, { w, h });
      toast('已设为 ' + w + '×' + h + '（兼容模式）');
    }
    sel.onchange = () => {
      if (sel.value === 'auto') { try { localStorage.removeItem('mdz-compat-res-' + v.id); } catch (e) {} toast('已设为自动（视口最佳）'); customBox.classList.add('hidden'); return; }
      if (sel.value === 'physical') { lsSet('mdz-compat-res-' + v.id, { physical: true }); toast('已设为物理屏幕比例（兼容模式）'); customBox.classList.add('hidden'); return; }
      if (sel.value === 'custom') { customBox.classList.remove('hidden'); return; }
      const [w, h] = sel.value.split('x').map(Number);
      lsSet('mdz-compat-res-' + v.id, { w, h });
      toast('已设为 ' + w + '×' + h + '（兼容模式）');
      customBox.classList.add('hidden');
    };
    applyBtn.onclick = () => { applyCustom(); customBox.classList.add('hidden'); };
    wrap.append(label, sel, customBox);
    return wrap;
  }
  function buildResControl(v) {
    const cur = resFor(v.id);
    const wrap = document.createElement('div');
    wrap.className = 'res-row';
    const label = document.createElement('span');
    label.className = 'res-label';
    label.textContent = '分辨率';
    const sel = document.createElement('select');
    sel.className = 'res-select';
    for (const p of PRESETS) {
      const opt = document.createElement('option');
      opt.value = p.custom ? 'custom' : (p.w + 'x' + p.h);
      opt.textContent = p.label;
      if (!p.custom && cur.w === p.w && cur.h === p.h) opt.selected = true;
      if (p.custom && !PRESETS.some((x) => !x.custom && x.w === cur.w && x.h === cur.h)) opt.selected = true;
      sel.appendChild(opt);
    }
    const customBox = document.createElement('div');
    customBox.className = 'res-custom hidden';
    const wInp = document.createElement('input');
    wInp.type = 'number'; wInp.min = '320'; wInp.max = '7680'; wInp.value = cur.w;
    const xSpan = document.createElement('span');
    xSpan.textContent = ' × ';
    const hInp = document.createElement('input');
    hInp.type = 'number'; hInp.min = '240'; hInp.max = '4320'; hInp.value = cur.h;
    const applyBtn = document.createElement('button');
    applyBtn.className = 'res-apply';
    applyBtn.textContent = '应用';
    customBox.append(wInp, xSpan, hInp, applyBtn);
    // 当前分辨率不在预设中（= 自定义）时，初始化即展开输入框，
    // 否则 select 显示「自定义…」但输入框 hidden，重开弹窗后没法直接改（v0.4.6 修复）
    const curIsCustom = !PRESETS.some((p) => !p.custom && p.w === cur.w && p.h === cur.h);
    if (curIsCustom) customBox.classList.remove('hidden');

    function applyRes(w, h) {
      if (!Number.isFinite(w) || !Number.isFinite(h)) { toast('分辨率无效', true); return; }
      lsSet('mdz-res-' + v.id, { w, h });
      const hit = PRESETS.find((p) => !p.custom && p.w === w && p.h === h);
      sel.value = hit ? (hit.w + 'x' + hit.h) : 'custom';
      if (sel.value !== 'custom') customBox.classList.add('hidden');
      toast('分辨率已设为 ' + w + '×' + h);
      // v0.7.8：分辨率自由调整（无高度限制），与普通版本完全一致
      if (currentVersion && currentVersion.id === v.id) applyFrameSize(w, h);
    }
    sel.onchange = () => {
      if (sel.value === 'custom') { customBox.classList.remove('hidden'); return; }
      const [w, h] = sel.value.split('x').map(Number);
      applyRes(w, h);
    };
    applyBtn.onclick = () => applyRes(parseInt(wInp.value, 10), parseInt(hInp.value, 10));
    wrap.append(label, sel, customBox);
    return wrap;
  }

  // ================= 通用配置弹窗（v0.4.6：整合「更多」菜单 + 列表「配置」按钮） =================
  // 打开入口：详情页 ⚙（原「更多」）、列表行「配置」。内容分类：播放 / 存档 / 按键映射 / 版本信息。
  // 选项左右布局：左侧标签、右侧控件。用户后续会根据效果再提改动。
  function ensureConfigDialog() {
    let dlg = document.getElementById('mdz-config-dialog');
    if (dlg) return dlg;
    dlg = document.createElement('div');
    dlg.id = 'mdz-config-dialog';
    dlg.className = 'config-dialog hidden';
    dlg.innerHTML =
      '<div class="config-box">' +
      '<div class="cd-head"><h4 class="cd-title"></h4><button class="cd-close" title="关闭">✕</button></div>' +
      '<div class="cd-body"></div>' +
      '</div>';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.classList.add('hidden'); });
    dlg.querySelector('.cd-close').onclick = () => dlg.classList.add('hidden');
    return dlg;
  }
  /** 配置弹窗内一行：左标签 + 右控件（左右布局） */
  function cdRow(labelText) {
    const row = document.createElement('div');
    row.className = 'cd-row';
    const lab = document.createElement('span');
    lab.textContent = labelText;
    row.appendChild(lab);
    return row;
  }
  /** 配置弹窗分类小标题 */
  function cdGroup(title) {
    const g = document.createElement('div');
    g.className = 'cd-group';
    g.textContent = title;
    return g;
  }
  function openConfigDialog(v) {
    const dlg = ensureConfigDialog();
    dlg.querySelector('.cd-title').textContent = '配置 · ' + (v.name || v.id);
    const body = dlg.querySelector('.cd-body');
    body.innerHTML = '';

    // —— 多人联机（v1.0.8 web / v1.0.11 PC：进多人版的**客户端**设置都在这里）——
    // PC：「服务器地址」+「玩家名称」→ 写 config.json 的 lan{serverHost,signalPort,playerName}（原生 IPC）
    // web：「服务器地址」+「玩家名称」→ 本地存储（网页版不提供服务器）
    if (isMpVersion(v)) {
      body.appendChild(cdGroup('多人联机'));
      if (PLAT.isPC) {
        /* ===== PC：客户端要连的服务器 + 自己的名字（用户要求从「联机配置」页挪到这里）===== */
        const n = lanNative();
        const lanNow = (lanStatus && lanStatus.lan) ? lanStatus.lan : null;
        if (!n) {
          const tip0 = document.createElement('p');
          tip0.className = 'muted settings-tip';
          tip0.textContent = '（当前环境没有原生联机能力：仅 PC 启动器可用）';
          body.appendChild(tip0);
        } else if (!lanNow) {
          // 还没取过联机状态 → 拉一次后重画弹窗（避免显示空值误导）
          const tipW = document.createElement('p');
          tipW.className = 'muted settings-tip';
          tipW.textContent = '正在读取联机设置…';
          body.appendChild(tipW);
          n.lanStatus().then((st) => { lanStatus = st; openConfigDialog(v); }).catch(() => {});
        } else {
          const pcSrvRow = cdRow('服务器地址');
          const pcSrvInp = document.createElement('input');
          pcSrvInp.type = 'text';
          pcSrvInp.className = 'res-select';
          pcSrvInp.style.cssText = 'flex:1;min-width:0';
          pcSrvInp.placeholder = '留空 = 本机；如 192.168.1.5 或 192.168.1.5:8787';
          pcSrvInp.value = lanNow.serverHost || '';
          const pcSrvBtn = document.createElement('button');
          pcSrvBtn.className = 'btn btn-primary';
          pcSrvBtn.style.flex = 'none';
          pcSrvBtn.textContent = '保存';
          pcSrvBtn.onclick = () => {
            const val = String(pcSrvInp.value || '').trim();
            const parsed = val ? mpParseServer(val) : null;
            if (val && !parsed) { toast('地址看不清，请填 192.168.1.5 这样的一台机器地址', true); return; }
            const patch = { serverHost: parsed ? parsed.host : '' };
            if (parsed && parsed.signalPort) patch.signalPort = parsed.signalPort; // 只填 IP 时=默认 8787
            n.setLan(patch).then((r) => {
              if (r && r.status) lanStatus = r.status;
              toast(val ? ('已保存：多人版客户端连 ' + (r && r.status ? r.status.endpoints.signalUrl : (parsed.host))) : '已清空：连本机（127.0.0.1）');
              openConfigDialog(v);
            });
          };
          pcSrvRow.append(pcSrvInp, pcSrvBtn);
          body.appendChild(pcSrvRow);

          const pcNameRow = cdRow('玩家名称');
          const pcNameInp = document.createElement('input');
          pcNameInp.type = 'text';
          pcNameInp.className = 'res-select';
          pcNameInp.style.cssText = 'flex:1;min-width:0';
          pcNameInp.maxLength = 16;
          pcNameInp.placeholder = 'MiniPlayer';
          pcNameInp.value = lanNow.playerName || 'MiniPlayer';
          const pcNameBtn = document.createElement('button');
          pcNameBtn.className = 'btn btn-primary';
          pcNameBtn.style.flex = 'none';
          pcNameBtn.textContent = '保存';
          pcNameBtn.onclick = () => {
            const val = String(pcNameInp.value || '').trim().slice(0, 16) || 'MiniPlayer';
            n.setLan({ playerName: val }).then((r) => {
              if (r && r.status) lanStatus = r.status;
              toast('玩家名称已设为「' + val + '」（下次启动多人版生效）');
              openConfigDialog(v);
            });
          };
          pcNameRow.append(pcNameInp, pcNameBtn);
          body.appendChild(pcNameRow);

          const pcTip = document.createElement('p');
          pcTip.className = 'muted settings-tip';
          pcTip.style.cssText = 'margin:2px 0 0;font-size:11.5px;line-height:1.6';
          pcTip.textContent = '这里只管**进游戏**：服务器地址 = 房主电脑（跑建房程序那台）的 IP，留空=本机；玩家名称会随客户端启动注入（游戏内显示的名字）。' +
            '端口、建房程序、信令/分发服务的启停与日志在侧边栏「联机配置」页。' +
            '当前信令：' + ((lanStatus.endpoints && lanStatus.endpoints.signalUrl) || '—') + '（改完下次启动生效）';
          body.appendChild(pcTip);
        }
      } else {
      const srvRow = cdRow('服务器地址');
      const srvInp = document.createElement('input');
      srvInp.type = 'text';
      srvInp.className = 'res-select';
      srvInp.style.cssText = 'flex:1;min-width:0';
      srvInp.placeholder = '留空 = 本站自带；如 192.168.1.5';
      srvInp.value = mpServerRaw();
      const srvBtn = document.createElement('button');
      srvBtn.className = 'btn btn-primary';
      srvBtn.style.flex = 'none';
      srvBtn.textContent = '保存';
      srvBtn.onclick = () => {
        const val = String(srvInp.value || '').trim();
        const parsed = mpParseServer(val);
        if (val && !parsed) { toast('地址看不清，请填 192.168.1.5 这样的一台机器地址', true); return; }
        lsSet(MP_SERVER_KEY, val);
        toast(val ? ('已保存：连 ' + parsed.host + '（' + (parsed.viaDispatch
          ? ('房主分发的客户端 · 分发 ' + parsed.httpPort + ' · 信令 ' + parsed.signalPort)
          : ('信令 ws://' + parsed.host + ':' + parsed.signalPort)) + '）')
          : '已清空：多人版用本站自带副本');
      };
      srvRow.append(srvInp, srvBtn);
      body.appendChild(srvRow);
      /* v1.0.10：玩家名称（多人版里的名字；留空 = MiniPlayer） */
      const nameRow = cdRow('玩家名称');
      const nameInp = document.createElement('input');
      nameInp.type = 'text';
      nameInp.className = 'res-select';
      nameInp.style.cssText = 'flex:1;min-width:0';
      nameInp.maxLength = 16;
      nameInp.placeholder = 'MiniPlayer';
      nameInp.value = mpUserRaw();
      const nameBtn = document.createElement('button');
      nameBtn.className = 'btn btn-primary';
      nameBtn.style.flex = 'none';
      nameBtn.textContent = '保存';
      nameBtn.onclick = () => {
        const val = String(nameInp.value || '').trim().slice(0, 16);
        lsSet(MP_USER_KEY, val);
        toast(val ? ('玩家名称已设为「' + val + '」（下次启动多人版生效）') : '玩家名称已清空（用 MiniPlayer）');
      };
      nameRow.append(nameInp, nameBtn);
      body.appendChild(nameRow);
      const srvTip = document.createElement('p');
      srvTip.className = 'muted settings-tip';
      srvTip.style.cssText = 'margin:2px 0 0;font-size:11.5px;line-height:1.6';
      const cur = mpParseServer(mpServerRaw());
      srvTip.textContent = '填房主电脑（跑信令服务器/建房程序那台）的 IP：如 192.168.1.5 → 用本站客户端连它的信令服务器（房主不必开分发服务）；' +
        '填 http://192.168.1.5:8088 → 直接用房主分发出来的客户端副本。留空 = 本站自带副本（单人模拟，只能自己逛）。' +
        (cur ? '当前：' + cur.host + ' · ' + (cur.viaDispatch ? ('房主分发副本 · 分发 ' + cur.httpPort) : ('信令 ' + cur.signalPort)) : '') +
        (location.protocol === 'https:' ? '（本站是 https，画面会另开新窗口打开——浏览器不允许 https 页面连接/内嵌局域网明文服务器）' : '');
      body.appendChild(srvTip);
      } // else：网页/安卓（本站副本 + 本地存储）
    } // if isMpVersion(v)

    // —— 快捷启动（v0.6.56）：置顶此版本 ——
    body.appendChild(cdGroup('快捷启动'));
    const pinRow = cdRow('置顶');
    const pinTip = document.createElement('span');
    pinTip.textContent = '置顶后显示在快捷启动（版本列表上方）';
    pinTip.style.cssText = 'flex:1;min-width:0;width:auto;font-size:11px;color:var(--muted);opacity:.8;text-align:left';
    const pinSel = document.createElement('select');
    pinSel.className = 'res-select';
    pinSel.style.cssText = 'flex:none;width:110px';
    const pOff = document.createElement('option'); pOff.value = '0'; pOff.textContent = '否';
    const pOn = document.createElement('option'); pOn.value = '1'; pOn.textContent = '是';
    pinSel.appendChild(pOff); pinSel.appendChild(pOn);
    pinSel.value = isPinned(v) ? '1' : '0';
    pinSel.onchange = () => {
      setPinned(v, pinSel.value === '1');
      try { renderQuickLaunch(); } catch (e) {}
      toast(pinSel.value === '1' ? '已置顶到「快捷启动」' : '已取消置顶');
    };
    pinRow.appendChild(pinSel);
    pinRow.appendChild(pinTip);
    body.appendChild(pinRow);

    // —— 播放 ——
    // —— 播放 ——（v0.7.8：所有版本统一「播放方式 + 分辨率」，分辨率自由调整（含 directUrl/minidayz-pc，
    // 默认取 BUILTIN_SPECIAL.defaultRes）；Canvas fix mod 把画布宽设为 iframe 宽 → 分辨率即视野宽）
    body.appendChild(cdGroup('播放'));
    const resHost = document.createElement('div');
    function buildSafePadControl(v) {
      const wrap = document.createElement('div');
      wrap.className = 'res-row';
      wrap.style.flexDirection = 'column';
      wrap.style.alignItems = 'flex-start';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
      const label = document.createElement('span');
      label.className = 'res-label';
      label.textContent = '安全边距';
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '1'; inp.max = '64'; inp.step = '1';
      inp.value = safePadVal();
      inp.style.cssText = 'width:58px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:12px';
      const px = document.createElement('span');
      px.textContent = 'px/侧';
      px.className = 'muted';
      row.append(label, inp, px);
      const tip = document.createElement('p');
      tip.className = 'muted settings-tip';
      tip.style.cssText = 'margin:2px 0 0;font-size:11.5px;line-height:1.6';
      tip.textContent = '画面 = 显示区域四周各留该边距（最小 1px），内层画面永不大于显示窗口 → 不会因画面过大黑屏；该模式不可选分辨率。';
      inp.onchange = () => {
        let p = parseInt(inp.value, 10);
        if (!(p >= 1 && p <= 64)) { p = 6; inp.value = 6; }
        lsSet('mdz-safe-pad', p);
        toast('安全边距已设为每侧 ' + p + 'px（下次启动生效）');
      };
      wrap.append(row, tip);
      wrap.append(row, tip);
      return wrap;
    }
    function resRowFor(mode) {
      let wrap;
      if (mode === 'safe') wrap = buildSafePadControl(v);
      else wrap = mode === 'compat' ? buildCompatResControl(v) : buildResControl(v);
      // v1.0.2：新窗口模式由系统窗口自管尺寸 → 不显示分辨率控件（桌面/手机端一致）
      if (mode === 'window') wrap.classList.add('hidden');
      else if (isMobile() && mode !== 'compat' && mode !== 'safe') wrap.classList.add('mobile-hidden'); // 手机端仅 compat/safe 显示
      return wrap;
    }
    if (isMobile()) {
      // v0.6.55：手机端「画面显示」——占满全屏 / 避开刘海（避开时黑边高度可：自动 / 自定义）。
      // 仅 web（iOS/安卓浏览器）显示；安卓 APK 不需要（用户确认）
      if (!PLAT.isAndroid) {
        const insetRow = cdRow('画面显示');
        const insetSel = document.createElement('select');
        insetSel.className = 'res-select';
        const iFull = document.createElement('option'); iFull.value = ''; iFull.textContent = '占满全屏（刘海区显示画面）';
        const iInset = document.createElement('option'); iInset.value = '1'; iInset.textContent = '避开刘海（黑边不挡UI）';
        insetSel.appendChild(iFull); insetSel.appendChild(iInset);
        insetSel.value = gameTopInset(v) ? '1' : '';
        insetSel.onchange = () => {
          lsSet('mdz-game-top-' + v.id, insetSel.value);
          barRow.style.display = insetSel.value === '1' ? '' : 'none';
          toast(insetSel.value === '1' ? '画面已设为避开刘海' : '画面已设为占满全屏');
        };
        insetRow.appendChild(insetSel);
        body.appendChild(insetRow);
        /* v1.0.23（用户要求，本轮新增）：黑边只留**一项「左右黑边」**——
           下拉「自动（按手机安全区）/ 自定义（左/右自己填）」+ 左、右两个 px 输入框（仅自定义时显示）。
           **自定义值就是那一侧黑边的宽度本身**，不与自动值相加；老版本的单值「黑边高度」
           （mdz-game-notch-px-<id>）在打开弹窗时自动迁移成左右两侧初值。
           容器必须用 div.cd-ctl（不能用 <span>：.cd-row > span 固定 92px 宽会把控件挤成一团），
           提示文字加 flex:none + width:100% 独占一行。 */
        const barRow = cdRow('左右黑边');
        barRow.style.flexWrap = 'wrap';
        const barWrap = document.createElement('div');
        barWrap.className = 'cd-ctl';
        const barModeSel = document.createElement('select');
        barModeSel.className = 'res-select';
        const bAuto = document.createElement('option'); bAuto.value = 'auto'; bAuto.textContent = '自动（按手机安全区）';
        const bCust = document.createElement('option'); bCust.value = 'custom'; bCust.textContent = '自定义（左/右自己填）';
        barModeSel.appendChild(bAuto); barModeSel.appendChild(bCust);
        const barModeKey = 'mdz-game-notch-mode-' + v.id;
        barModeSel.value = (lsGet(barModeKey, 'auto') === 'custom') ? 'custom' : 'auto';
        const legacyPx = parseInt(lsGet('mdz-game-notch-px-' + v.id, 0), 10);
        if (legacyPx > 0) {
          if (lsGet('mdz-game-bar-left-' + v.id, null) == null) lsSet('mdz-game-bar-left-' + v.id, legacyPx);
          if (lsGet('mdz-game-bar-right-' + v.id, null) == null) lsSet('mdz-game-bar-right-' + v.id, legacyPx);
        }
        const mkBarInput = (side, labelTxt) => {
          const box = document.createElement('span');
          box.className = 'bar-num';
          const lab = document.createElement('span');
          lab.className = 'bar-num-lab';
          lab.textContent = labelTxt;
          const inp = document.createElement('input');
          inp.type = 'number'; inp.min = '0'; inp.max = '400'; inp.step = '2';
          inp.value = barPadVal(v, side);
          inp.onchange = () => {
            let p = parseInt(inp.value, 10);
            if (!(p >= 0 && p <= 400)) p = 0;
            inp.value = p;
            lsSet('mdz-game-bar-' + side + '-' + v.id, p);
            toast((side === 'left' ? '左' : '右') + '侧黑边已设为 ' + p + 'px（下次启动生效）');
          };
          const unit = document.createElement('span');
          unit.className = 'bar-num-unit';
          unit.textContent = 'px';
          box.append(lab, inp, unit);
          return box;
        };
        const barInputs = document.createElement('span');
        barInputs.className = 'bar-nums';
        barInputs.append(mkBarInput('left', '左'), mkBarInput('right', '右'));
        barInputs.style.display = barModeSel.value === 'custom' ? '' : 'none';
        barModeSel.onchange = () => {
          lsSet(barModeKey, barModeSel.value);
          barInputs.style.display = barModeSel.value === 'custom' ? '' : 'none';
          toast(barModeSel.value === 'custom' ? '左右黑边：自定义' : '左右黑边：自动（按手机安全区）');
        };
        barWrap.append(barModeSel, barInputs);
        const barTip = document.createElement('p');
        barTip.className = 'muted settings-tip';
        barTip.style.cssText = 'margin:4px 0 0;font-size:11.5px;line-height:1.6;flex:none;width:100%';
        barTip.textContent = '自动 = 按手机安全区；自定义 = 左/右按填的 px（0 = 不留）。';
        barRow.appendChild(barWrap);
        barRow.appendChild(barTip);
        barRow.style.display = insetSel.value === '1' ? '' : 'none';
        body.appendChild(barRow);
      }
      const modeRow = cdRow('播放方式');
      const modeSel = document.createElement('select');
      modeSel.className = 'res-select';
      // v0.6.10：安卓与 web 手机端一致；v1.0.2：恢复「新窗口」（选项置最后）
      // v-防黑专项：新增「防黑安全分辨率」（safe）——不可选分辨率、可调安全边距
      const modeOptions = [
        ['fullscreen', '设备默认分辨率'], ['compat', '兼容电脑分辨率'], ['safe', '防黑安全分辨率'], ['window', '新窗口']
      ];
      modeOptions.forEach(([val, label]) => {
        const o = document.createElement('option');
        o.value = val; o.textContent = label;
        modeSel.appendChild(o);
      });
      modeSel.value = modeFor(v.id);
      modeSel.onchange = () => {
        lsSet('mdz-playmode-' + v.id, modeSel.value);
        toast('播放方式已设为「' + modeSel.options[modeSel.selectedIndex].text + '」');
        resHost.innerHTML = ''; // v0.6.0：切换播放方式后分辨率控件立即跟随（无需重开弹窗）
        resHost.appendChild(resRowFor(modeSel.value));
      };
      modeRow.appendChild(modeSel);
      body.appendChild(modeRow);
    } else {
      // v0.6.6：PC 端播放方式恢复可选（v0.6.0 曾归档强制内嵌，用户要求找回）；
      // v0.7.11 PC 命名「窗口模式 / 内嵌画面」；v1.0.2 恢复「新窗口」（选项置最后）
      // web 桌面保持原名与页面全屏行为
      const modeRow = cdRow('播放方式');
      const modeSel = document.createElement('select');
      modeSel.className = 'res-select';
      const modeOptions = PLAT.isPC
        ? [['fullscreen', '窗口模式'], ['embed', '内嵌画面']]   // v1.0.7：PC 只保留「窗口模式 / 内嵌画面」（用户要求去掉「新窗口」）
        : [['fullscreen', '全屏'], ['embed', '内嵌'], ['window', '新窗口']];
      modeOptions.forEach(([val, label]) => {
        const o = document.createElement('option');
        o.value = val; o.textContent = label;
        modeSel.appendChild(o);
      });
      modeSel.value = modeFor(v.id);
      modeSel.onchange = () => {
        lsSet('mdz-playmode-' + v.id, modeSel.value);
        toast('播放方式已设为「' + modeSel.options[modeSel.selectedIndex].text + '」');
      };
      modeRow.appendChild(modeSel);
      body.appendChild(modeRow);
    }
    resHost.appendChild(resRowFor(modeFor(v.id)));
    body.appendChild(resHost);

    // —— 存档 ——（v1.0.45：noSave 内置版本隐藏整个存档组——其存档由游戏自带 mods 管理，启动器不介入）
    if (!v.noSave) {
    body.appendChild(cdGroup('存档'));
    // v0.7.2：配置弹窗内可直接备份当前存档
    const backupRow = cdRow('备份当前存档');
    const backupBtn = document.createElement('button');
    backupBtn.className = 'cd-btn';
    backupBtn.innerHTML = ico('save') + '<span>备份</span>';
    backupBtn.onclick = async () => {
      dlg.classList.add('hidden');
      try {
        if (await ensureNoGameForSave()) toast('已先关闭正在运行的游戏，再备份存档'); // v1.0.25
        const dbKey = v.dbKey || ('version_' + v.id);
        const name = await window.__saveManager.nextSlotName(dbKey);
        const r = await window.__saveManager.createSlot(dbKey, name);
        toast('已备份当前存档到「' + name + '」（' + r.count + ' 条记录）');
        // v0.6.40：配置弹窗备份后同步刷新存档页槽列表（此前不刷新，需手动刷新页面/切视图才出现）
        const card = document.getElementById('save-card-' + String(v.id).replace(/[^\w\u4e00-\u9fa5-]/g, '_'));
        if (card && window.__saveManager) {
          try { loadSlots(card, dbKey); } catch (e) {}
        }
      } catch (e) { toast('备份失败: ' + e.message, true); }
    };
    backupRow.appendChild(backupBtn);
    body.appendChild(backupRow);
    const expRow = cdRow('导出存档');
    const expBtn = document.createElement('button');
    expBtn.className = 'cd-btn';
    expBtn.innerHTML = ico('export') + '<span>导出</span>';
    expBtn.onclick = () => { dlg.classList.add('hidden'); doExport(v); };
    expRow.appendChild(expBtn);
    body.appendChild(expRow);
    const impRow = cdRow('导入存档');
    const impBtn = document.createElement('button');
    impBtn.className = 'cd-btn';
    impBtn.innerHTML = ico('import') + '<span>导入</span>';
    impBtn.onclick = () => { dlg.classList.add('hidden'); doImport(v); };
    impRow.appendChild(impBtn);
    body.appendChild(impRow);
    // v0.5.1：单独删除该版本存档
    const delSavesRow = cdRow('删除存档');
    const delSavesBtn = document.createElement('button');
    delSavesBtn.className = 'cd-btn danger';
    delSavesBtn.innerHTML = ico('trash') + '<span>删除</span>';
    delSavesBtn.onclick = async () => {
      if (!confirm('确定删除版本「' + (v.name || v.id) + '」的当前存档？（备份会保留）')) return;
      try {
        // v0.6.23：先关游戏 + 复查（防删除无效「刷新又回来」）+ 连备份槽一起删
        const r = await deleteSavesGuarded(v.dbKey || ('version_' + v.id));
        if (r.remains) return;
        saveScanDirty = true; // v0.6.61：存档数据变更（下次进存档页/刷新重扫）
        toast('已删除存档' + (r.del && r.del.length ? '（' + r.del.length + ' 个库）' : ''));
      } catch (e) { toast('删除存档失败: ' + e.message, true); }
    };
    delSavesRow.appendChild(delSavesBtn);
    body.appendChild(delSavesRow);
    // v0.7.2：前往存档管理；v0.6.59：折叠其他版本卡 + 目标卡高亮（版本列表同款选中框）
    const gotoRow = cdRow('存档管理');
    const gotoBtn = document.createElement('button');
    gotoBtn.className = 'cd-btn';
    gotoBtn.innerHTML = ico('list') + '<span>前往</span>';
    gotoBtn.onclick = () => {
      dlg.classList.add('hidden');
      gotoFocusSaveCard(v);
    };
    gotoRow.appendChild(gotoBtn);
    body.appendChild(gotoRow);
    }

    // —— 按键映射（安卓触屏版 / 手机端无键盘映射，隐藏该组；v1.0.45：noKeymap 内置版本也隐藏） ——
    if (!PLAT.isAndroid && !isMobile() && !v.noKeymap) {
      body.appendChild(cdGroup('按键映射'));
      const kmRow = cdRow('校准面板');
      const kmBtn = document.createElement('button');
      kmBtn.className = 'cd-btn';
      kmBtn.innerHTML = ico('keyboard') + '<span>以校准模式启动</span>';
      kmBtn.onclick = () => {
        dlg.classList.add('hidden');
        toast('正在以校准模式启动（面板将自动打开），游戏内也可按 F10 开关');
        launchVersion(v, modeFor(v.id), true);
      };
      kmRow.appendChild(kmBtn);
      body.appendChild(kmRow);
      const kmExpRow = cdRow('导出按键映射');
      const kmExpBtn = document.createElement('button');
      kmExpBtn.className = 'cd-btn';
      kmExpBtn.innerHTML = ico('export') + '<span>导出</span>';
      kmExpBtn.onclick = () => { dlg.classList.add('hidden'); exportKeymap(v); };
      kmExpRow.appendChild(kmExpBtn);
      body.appendChild(kmExpRow);
      const kmImpRow = cdRow('导入按键映射');
      const kmImpBtn = document.createElement('button');
      kmImpBtn.className = 'cd-btn';
      kmImpBtn.innerHTML = ico('import') + '<span>导入</span>';
      kmImpBtn.onclick = () => { dlg.classList.add('hidden'); importKeymap(v); };
      kmImpRow.appendChild(kmImpBtn);
      body.appendChild(kmImpRow);
    }

    // —— 版本信息（v0.4.6：ID/dbKey 从详情 meta 移到这里显示） ——
    // v1.0.7：内置/合成版（单机版、多人版等）不显示 ID / 存档 dbKey（对用户没意义，且容易误删改）
    const hideIds = !!(v.sortFirst || String(v.id).indexOf('__') === 0 || v.builtin);
    if (!hideIds) {
    body.appendChild(cdGroup('版本信息'));
    const idRow = cdRow('版本 ID');
    const idVal = document.createElement('code');
    idVal.className = 'cd-val';
    idVal.textContent = v.id;
    idRow.appendChild(idVal);
    body.appendChild(idRow);
    const dbRow = cdRow('存档 dbKey');
    const dbVal = document.createElement('code');
    dbVal.className = 'cd-val';
    dbVal.textContent = v.dbKey || '—';
    dbRow.appendChild(dbVal);
    body.appendChild(dbRow);
    }   // v1.0.7：内置/合成版跳过「版本信息」块

    // —— 其他 ——
    body.appendChild(cdGroup('其他'));
    // v1.0.7：内置版（单机版/多人版等 sortFirst 或 __ 开头的合成版）不允许删除——删了会被启动器重建，且属于随包内容
    const isBuiltin = !!(v.sortFirst || String(v.id).indexOf('__') === 0 || v.builtin);
    if (PLAT.removeVersion && !isBuiltin) {
      const delRow = cdRow('删除版本');
      const delBtn = document.createElement('button');
      delBtn.className = 'cd-btn danger';
      delBtn.innerHTML = ico('trash') + '<span>删除</span>';
      delBtn.onclick = async () => {
        dlg.classList.add('hidden');
        if (!confirm('确定删除版本 ' + (v.name || v.id) + '？（游戏文件将被删除）')) return;
        // v0.5.1：可选择保留存档数据
        let delSaves = false;
        try { delSaves = confirm('是否同时删除该版本的当前存档？\n【确定】= 删除当前存档（备份保留）\n【取消】= 保留存档（重装该版本后仍可继续）'); } catch (e) {}
        if (delSaves) {
          try {
            // v0.6.23：先关游戏 + 复查（防删除无效）+ 连备份槽一起删
            const r = await deleteSavesGuarded(v.dbKey || ('version_' + v.id));
            if (!r.remains) toast('已删除该版本存档');
          } catch (e) { toast('删除存档失败: ' + e.message, true); }
        }
        try {
          await PLAT.removeVersion(v);
          toast('已删除 ' + (v.name || v.id));
          if (selectedId === v.id) { selectedId = null; listSelMuted = false; }
          refresh();
        } catch (e) { toast('删除失败: ' + e.message, true); }
      };
      delRow.appendChild(delBtn);
      body.appendChild(delRow);
    }
    const resetBtn = document.createElement('button');
    resetBtn.className = 'cd-reset';
    resetBtn.textContent = '重置该版本设置（分辨率/播放方式/按键映射）';
    resetBtn.onclick = () => {
      if (!confirm('确定重置该版本的启动器设置？游戏存档不受影响。')) return;
      try { localStorage.removeItem('mdz-res-' + v.id); } catch (e) {}
      try { localStorage.removeItem('mdz-compat-res-' + v.id); } catch (e) {}
      try { localStorage.removeItem('mdz-playmode-' + v.id); } catch (e) {}
      try { localStorage.removeItem('mdz-keymap-' + v.id); } catch (e) {} // 旧单方案
      try { localStorage.removeItem('mdz-keymaps-' + v.id); } catch (e) {} // v0.6.27 多方案
      toast('已重置，请刷新页面后重新启动游戏');
    };
    body.appendChild(resetBtn);
    dlg.classList.remove('hidden');
  }

  /** 手机端游戏视口"抖动"：真实改 iframe 尺寸(+1px 再恢复)触发 window resize + 派发 orientationchange，
   *  让游戏按手机视口重排 GUI（覆盖 PC 存档坐标）。仅移动端播放会话使用。 */
  // ================= 播放器 =================
  // v0.6.24：游戏播放期间（body.game-active）阻止启动器页面的右键菜单与复制——
  // 游戏 iframe 内的事件是独立文档，不会冒泡到这里，游戏内右键/复制不受影响
  document.addEventListener('contextmenu', function (e) {
    try { if (document.body.classList.contains('game-active') && !e.target.closest('iframe')) e.preventDefault(); } catch (err) {}
  }, true);
  document.addEventListener('copy', function (e) {
    try { if (document.body.classList.contains('game-active')) e.preventDefault(); } catch (err) {}
  }, true);
  function injectMapper(win) {
    if (PLAT.isAndroid) return; // 安卓是触屏游戏，不需要键盘映射
    try {
      const doc = win.document;
      if (!doc || doc.getElementById('mdz-web-mapper')) return;
      // v0.6.27：先注入默认方案配置（mdz-keymap-preset.js，部署可改），再注入映射器
      if (!doc.getElementById('mdz-keymap-preset')) {
        const ps = doc.createElement('script');
        ps.id = 'mdz-keymap-preset';
        ps.src = BASE + 'mdz-keymap-preset.js?v=20261118a';
        doc.head.appendChild(ps);
      }
      const s = doc.createElement('script');
      s.id = 'mdz-web-mapper';
      s.src = BASE + 'mapper.js?v=20261118a'; // 版本号防浏览器缓存（v1.0.5：默认方案可修改/不可删除——删除即重置预设）
      doc.head.appendChild(s);
    } catch (e) { console.warn('[web] inject mapper failed:', e.message); }
  }
  // ===== 运行时注入（免命令导入：不改游戏 index.html 文件） =====
  // v0.6.34：统一 dbKey（存档隔离后缀）——所有使用点必须一致（游戏注入/导出/导入/备份/删除），
  // 否则 dbKey 缺失的版本会出现「游戏读 _ 库、导入写 _undefined 库」的错位 → 导入后游戏读不到。
  function dbKeyOf(v) { return (v && v.dbKey) || ('version_' + (v ? v.id : '')); }
  // 启动器 fetch 游戏入口 HTML → 在 <head> 插入隔离补丁(dbKey) + <base>(相对路径重写)
  // → iframe 用 srcdoc（内嵌/全屏）/ 新窗口用 document.write 加载。游戏磁盘文件保持原样。
  /* v1.0.24（用户反馈"返回启动器页面游戏声音还在、进程可能没关"）：**音频守卫**。
     Construct 2 用 WebAudio，AudioContext 在宿主文档被清空/替换后**仍可能继续出声**（iOS/WebKit 尤其明显），
     所以 closePlayer 里"清 srcdoc + 写空文档"只是卸载了页面、声音还在。守卫在游戏页最先执行：
     登记所有 AudioContext，暴露 __mdzSilence()（挂起=静音）/ __mdzResume()（恢复）/ __mdzKill()（挂起+close+暂停媒体元素）；
     游戏页自己被隐藏/失焦时静音、回来时恢复。**纯音频，不碰存档**。 */
  const AUDIO_GUARD_JS = '(function(){try{if(window.__mdzAudioGuard)return;window.__mdzAudioGuard=1;var ctxs=[];' +
    'function wrap(n){var C=window[n];if(!C||!C.prototype||C.__mdzWrapped)return;' +
    'var W=function(){var a=[].slice.call(arguments),inst=null;try{inst=Reflect.construct(C,a,C);}catch(e1){try{inst=new (Function.prototype.bind.apply(C,[null].concat(a)))();}catch(e2){inst=new C();}}try{ctxs.push(inst);}catch(e3){}return inst;};' +
    'W.prototype=C.prototype;C.__mdzWrapped=1;W.__mdzWrapped=1;' +
    'try{for(var k in C){try{if(Object.prototype.hasOwnProperty.call(C,k))W[k]=C[k];}catch(e4){}}}catch(e5){}window[n]=W;}' +
    'wrap("AudioContext");wrap("webkitAudioContext");' +
    'function muteMedia(){try{var els=document.querySelectorAll("audio,video");for(var i=0;i<els.length;i++){try{els[i].pause();els[i].muted=true;}catch(e){}}}catch(e){}}' +
    'window.__mdzSilence=function(){for(var i=0;i<ctxs.length;i++){try{if(ctxs[i].state==="running")ctxs[i].suspend();}catch(e){}}muteMedia();};' +
    'window.__mdzResume=function(){for(var i=0;i<ctxs.length;i++){try{if(ctxs[i].state==="suspended")ctxs[i].resume();}catch(e){}}};' +
    'window.__mdzKill=function(){for(var i=0;i<ctxs.length;i++){try{ctxs[i].close();}catch(e){}}muteMedia();ctxs=[];};' +
    /* v1.0.28：登记游戏页打开的 IndexedDB 连接 —— 关游戏时必须把它们关掉，否则连接会一直占着库
       （删除/导入被 blocked、下次启动读到异常数据「卡画面」）。只登记+关闭，**不改库名**。 */
    'if(!window.__mdzDbReg){window.__mdzDbReg=1;var __mdzDbs=[];var __mdzClosed=0;var __mdzOpen0=window.indexedDB.open.bind(window.indexedDB);' +
    'window.indexedDB.open=function(){var rq=__mdzOpen0.apply(null,arguments);try{rq.addEventListener("success",function(){try{if(__mdzClosed){rq.result.close();return;}__mdzDbs.push(rq.result);}catch(e){}});}catch(e){}return rq;};' +
    'window.__mdzCloseDbs=function(){__mdzClosed=1;for(var i=0;i<__mdzDbs.length;i++){try{__mdzDbs[i].close();}catch(e){}}var n=__mdzDbs.length;__mdzDbs=[];window.__mdzDbsClosed=(window.__mdzDbsClosed||0)+n;return n;};' +
    'window.__mdzDbReset=function(){__mdzClosed=0;__mdzDbs=[];};' +
    'window.__mdzDbCount=function(){return __mdzDbs.length;};}' +
    'document.addEventListener("visibilitychange",function(){try{if(document.hidden){window.__mdzSilence();}else{window.__mdzResume();}}catch(e){}});' +
    'window.addEventListener("blur",function(){try{window.__mdzSilence();}catch(e){}});' +
    'window.addEventListener("focus",function(){try{window.__mdzResume();}catch(e){}});' +
    '}catch(e){}})();';
  /** 给同源窗口补装音频守卫（直链版本没法在加载前注入 → load 后补装） */
  function installAudioGuardIn(win) {
    try {
      if (!win || win.__mdzAudioGuard) return;
      const d = win.document;
      if (!d || !d.createElement) return;
      const s = d.createElement('script');
      s.textContent = AUDIO_GUARD_JS;
      (d.head || d.documentElement).appendChild(s);
    } catch (e) {}
  }
  /** 让某个游戏窗口立刻安静：kill=true → 彻底断声（挂起 + close + 暂停媒体元素） */
  function silenceGame(win, kill) {
    try {
      if (!win) return;
      if (kill) {
        try { if (typeof win.__mdzKill === 'function') win.__mdzKill(); } catch (e) {}
        /* v1.0.28（用户实测：关游戏关不彻底 → 启动一两次后再删除就失效/概率卡画面）：
           把游戏页里打开的 IndexedDB 连接**显式关掉** —— 只清文档是不会释放连接的。 */
        try { if (typeof win.__mdzCloseDbs === 'function') win.__mdzCloseDbs(); } catch (e) {}
      }
      try { if (typeof win.__mdzSilence === 'function') win.__mdzSilence(); } catch (e) {}
    } catch (e) {}
    try {
      const d = win && win.document;
      if (d && d.querySelectorAll) {
        const els = d.querySelectorAll('audio,video');
        for (let i = 0; i < els.length; i++) { try { els[i].pause(); els[i].muted = true; } catch (e) {} }
      }
    } catch (e) {}
  }
  /** 「新窗口」模式的游戏窗口：返回启动器时**关掉它**（手机端；桌面端只静音，避免误关用户在用的窗口） */
  function stopPoppedGame() {
    try {
      const w = mdzPopWin;
      if (!w || w.closed) return;
      silenceGame(w, true);
      if (mobileSession || isMobile()) {
        try { w.close(); } catch (e) {}
        if (!w.closed) { try { const d = w.document; if (d) { d.open(); d.write(''); d.close(); } } catch (e) {} }
      }
      mdzPopWin = null;
    } catch (e) {}
  }
  let mdzPopWin = null; // v1.0.24：「新窗口」模式的游戏窗口引用（返回启动器时关掉/静音）
  function buildIsolationPatch(dbKey, calibrate, versionId) {
    const k = String(dbKey || '').replace(/[^A-Za-z0-9_-]/g, '');
    const vid = String(versionId || '').replace(/[^A-Za-z0-9_-]/g, '');
    // 注意 IIFE 必须写成 (function(){...})()——括号闭合错误会导致注入脚本语法错误、隔离完全不生效
    return '<script>/* MDZ 运行时注入：存档隔离 + SW 屏蔽 + 校准标记 */\n' +
      'try{(function(){var s="_' + k + '",o=window.indexedDB.open.bind(window.indexedDB);' +
      // v0.6.41：endsWith 判断后缀——旧 `indexOf(s)!==n.length-s.length` 在 n.length===s.length-1 时
      // indexOf 与长度差都为 -1 → 误判"已带后缀" → 不追加 → 游戏读无后缀库（mdz_plus_v121 触发：_C2SaveStates 12字符 vs 后缀13字符）
      'window.indexedDB.open=function(n,v){if(n&&typeof n==="string"&&!n.endsWith(s))return o(n+s,v);return o(n,v);};})()}catch(e){}\n' +
      'try{if(navigator.serviceWorker&&navigator.serviceWorker.register)navigator.serviceWorker.register=function(){return Promise.resolve({});};}catch(e){}\n' +
      'window.__mdzCalibrate=' + (calibrate ? 'true' : 'false') + ';window.__mdzVersion=' + JSON.stringify(vid) + ';window.__mdzDbKey=' + JSON.stringify(k) + ';</script>';
  }
  // v0.6.44：确保游戏页 viewport 带 viewport-fit=cover——安卓异形屏（挖孔/刘海）全屏沉浸式关键：
  // WebView 内容只有 viewport-fit=cover 才延伸到切孔/刘海区域（配合原生 layoutInDisplayCutoutMode）
  function ensureViewportFit(html) {
    const vp = /<meta[^>]+name=["']viewport["'][^>]*>/i;
    if (!vp.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />');
    return html.replace(vp, (m) => (m.indexOf('viewport-fit') >= 0) ? m : m.replace(/>\s*$/, ', viewport-fit=cover>'));
  }
  /** 注入后的完整 HTML：base 无条件加（srcdoc 下相对路径必须指向版本目录）；旧版已落盘注入的版本不重复注入隔离补丁，但仍补校准标记 */
  function buildInjectedHtml(v, calibrate, html) {
    // base 指向版本真实目录：安卓经 PLAT.baseUrl（file 桥），web 用版本根（默认 versions/<id>/，可经 versionsRoot 覆盖）
    const base = PLAT.baseUrl ? PLAT.baseUrl(v) : (versionsRoot() + encodeURIComponent(v.id) + '/');
    const patch = html.includes('MDZ_LAUNCHER_INJECT')
      ? '<script>window.__mdzCalibrate=' + (calibrate ? 'true' : 'false') + ';window.__mdzVersion=' + JSON.stringify(String(v.id).replace(/[^A-Za-z0-9_-]/g, '')) + ';window.__mdzDbKey=' + JSON.stringify(String(v.dbKey || 'version_' + v.id).replace(/[^A-Za-z0-9_-]/g, '')) + ';</script>'
      : buildIsolationPatch(dbKeyOf(v), calibrate, v.id);
    html = ensureViewportFit(html); // v0.6.44：异形屏 viewport-fit=cover
    /* v1.0.24：音频守卫**无条件**注入（与存档隔离无关）——返回启动器/关闭播放时才能真正断声 */
    const guard = '<script>' + AUDIO_GUARD_JS + '</script>';
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + '<base href="' + base + '">' + patch + guard);
    return '<base href="' + base + '">' + patch + guard + html;
  }
  // v0.6.34：buildIsolationPatch 用统一 dbKeyOf（原裸 v.dbKey，缺失时与存档管理错位）
  async function fetchGameHtml(v, calibrate) {
    try {
      const res = await fetch(gameUrl(v, calibrate), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      toast('加载游戏页面失败: ' + e.message, true);
      return null;
    }
  }
  async function loadGameInto(frame, v, calibrate, onReady) {
    // v1.0.45：directUrl 内置版本（如 minidayz-pc）直链 iframe 加载——
    // 不 fetch/srcdoc/注入：入口含跨目录模块（../mods.js），srcdoc+base 会解析错；
    // 直链天然零注入 → 无需存档隔离/键盘映射（noSave/noKeymap 语义由该加载模式自然满足）
    if (v && v.directUrl) {
      frame.removeAttribute('srcdoc');
      frame.src = gameUrl(v, calibrate);
      return;
    }
    const html = await fetchGameHtml(v, calibrate);
    if (html == null) return;
    const injected = buildInjectedHtml(v, calibrate, html);
    // v1.0.1：改用 document.write 写入 iframe（about:blank 文档）——srcdoc 赋值属于「导航」，
    // 会新增浏览器历史条目：手机端按返回键会先退回 iframe 里的游戏画面（黑屏）而不是回到启动器。
    // write 不产生导航条目（onload 不会再触发 → 手动执行 onReady：fitPlayer + mapper 注入）。
    // 兼容开关：window.__mdzConfig.iframeWrite === false 时回退 srcdoc（老浏览器/异常兜底）。
    let wrote = false;
    try {
      const cfgW = (window.__mdzConfig && typeof window.__mdzConfig === 'object') ? window.__mdzConfig.iframeWrite : undefined;
      if (cfgW !== false) {
        const d = frame.contentDocument;
        if (d) { d.open(); d.write(injected); d.close(); wrote = true; }
      }
    } catch (e) { wrote = false; }
    if (wrote) {
      setTimeout(function () { try { if (typeof onReady === 'function') onReady(); } catch (e) {} }, 60);
      return;
    }
    frame.srcdoc = injected; // 兜底：由 frame.onload(=onReady) 触发后续处理
  }
  async function openWindowPlayer(v, calibrate) {
    // v1.0.45：directUrl 内置版本（如 minidayz-pc）——直接以真实 URL 打开新窗口/标签，
    // 游戏页自管布局与滚屏（内嵌 iframe 对这类页面会黑屏/出滚动条）；不注入任何内容
    if (v && v.directUrl) {
      const u = gameUrl(v, calibrate);
      const w = window.open(u, '_blank');
      if (!w) { toast('弹窗被浏览器拦截，请允许弹出窗口', true); return; }
      mdzPopWin = w; // v1.0.24：记住游戏窗口，返回启动器时关掉/静音
      try { w.focus(); } catch (e) {}
      /* v1.0.24：直链页没法在加载前注入 → load 后补装音频守卫（同源窗口才装得上） */
      try { w.addEventListener('load', () => { installAudioGuardIn(w); }); } catch (e) {}
      return;
    }
    const w = window.open('', '_blank');
    if (!w) { toast('弹窗被浏览器拦截，请允许弹出窗口', true); return; }
    mdzPopWin = w; // v1.0.24：记住游戏窗口，返回启动器时关掉/静音
    const html = await fetchGameHtml(v, calibrate);
    if (html == null) { w.close(); return; }
    w.document.open();
    w.document.write(buildInjectedHtml(v, calibrate, html));
    w.document.close();
    w.addEventListener('load', () => {
      if (!PLAT.isAndroid && !(v && v.noKeymap)) injectMapper(w);
    });
  }

  // 手机端横屏锁定（多次重试，尽力而为）
  function lockLandscape() {
    try {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(function () {
          setTimeout(function () {
            try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {}); } catch (e) {}
          }, 600);
        });
      }
    } catch (e) {}
  }
  function unlockOrientation() {
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
  }

  const NATIVE_W = 1024, NATIVE_H = 768; // 游戏原生 4:3
  /**
   * 播放器适配（手机 / PC 分开）：
   * - 手机端（默认）：直接填满播放区域（无 transform，避免缩放黑屏与窄画面）
   * - 手机端「兼容PC分辨率」（v0.4.7 实验性）：iframe 用 PC 分辨率逻辑尺寸 + transform 等比缩放到播放区
   * - PC 端：固定分辨率布局尺寸 + transform 等比缩放（内嵌不放大；全屏等比放大铺满）
   */
  // v0.7.8：directUrl 内置版本（minidayz-pc）分辨率与普通版本完全一致（自由 W×H，无 890/914 高度限制）；
  // 默认/推荐分辨率见 BUILTIN_SPECIAL.defaultRes（resFor 读取）。画面高度由所选分辨率决定，
  // onload 仍去 body margin/滚动（suppressDirectScroll）→ iframe 内无滚动条。
  function suppressDirectScroll(frame) {
    // v0.7.3：同源直链 iframe 内页面（mods UI/游戏）滚动条删除——
    // body 固定高画布超出视口即滚；去 margin + overflow hidden，画面完整由 fitPlayer contain 保证
    try {
      const d = frame.contentDocument;
      if (!d || d.getElementById('__mdz_dscroll')) return;
      const st = d.createElement('style');
      st.id = '__mdz_dscroll';
      st.textContent = 'html,body{margin:0 !important;padding:0 !important;overflow:hidden !important}';
      (d.head || d.documentElement).appendChild(st);
      // v0.7.7：PC 平台游戏兼容补丁（浏览器正常、Electron 软件渲染下 C2 纹理函数返回 CanvasPattern，
      // drawImage 收到 pattern 抛 TypeError → 地图一白屏；用 createPattern 记录源图、
      // drawImage 遇 pattern 换回源图绘制 → 与浏览器端画面一致）。仅 PLAT.canvasPatternFix（PC adapter）注入。
      if (PLAT.canvasPatternFix && !d.getElementById('__mdz_cpfx')) {
        const sc = d.createElement('script');
        sc.id = '__mdz_cpfx';
        sc.textContent = '(function(){try{' +
          'if(window.__mdzCpfxDone)return;window.__mdzCpfxDone=1;' +
          'var P=CanvasRenderingContext2D.prototype,srcs=typeof WeakMap!=="undefined"?new WeakMap():null;' +
          'var ocp=P.createPattern;P.createPattern=function(img,rep){var p=ocp.apply(this,arguments);if(p&&srcs&&img&&(img.nodeName==="IMG"||img.nodeName==="CANVAS")){try{srcs.set(p,img);}catch(e){}}return p;};' +
          'var odi=P.drawImage;P.drawImage=function(){var a=arguments,i=a[0];' +
          'if(i&&i.toString&&String(i)==="[object CanvasPattern]"&&srcs&&srcs.get(i)){var s=srcs.get(i),ar=[s];for(var n=1;n<a.length;n++)ar.push(a[n]);return odi.apply(this,ar);}' +
          'return odi.apply(this,a);};' +
          '}catch(e){console.warn("[mdz] canvasPatternFix fail",e);}})();';
        (d.head || d.documentElement).appendChild(sc);
      }
    } catch (e) {}
  }
  function fitPlayer() {
    // v0.6.53：避开刘海模式——全屏后 env(safe-area-inset-*) 归零读不到，改用：
    // 启动前读的刘海高度（--mdz-game-notch）+ 当前屏幕方向（横屏避左/右、竖屏避顶部）
    try {
      const notch = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mdz-game-notch')) || 0;
      const st = document.documentElement.style;
      /* v1.0.23：「左右黑边」= 自定义时左右就是填的 px，自动时按手机给的安全区。
         三个变量**每次都写**（自动模式下写 0），否则从"自定义"切回"自动"会残留上一轮的内联值。 */
      const barCustom = (lsGet('mdz-game-notch-mode-' + (currentVersion && currentVersion.id), 'auto') === 'custom');
      const cL = barPadVal(currentVersion, 'left');
      const cR = barPadVal(currentVersion, 'right');
      let autoT = 0, autoL = 0, autoR = 0;
      if (notch > 0) {
        if (window.innerWidth > window.innerHeight) {
          // 横屏：刘海在设备顶部旋转到左（angle≈90）或右（angle≈270）；无法判断时两端都避
          let angle = 0;
          try { angle = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : 0; } catch (e2) {}
          if (Math.abs(angle - 90) <= 45) autoL = notch;
          else if (Math.abs(angle - 270) <= 45 || Math.abs(angle + 90) <= 45) autoR = notch;
          else { autoL = notch; autoR = notch; }
        } else autoT = notch;
      }
      st.setProperty('--mdz-game-safe-top', autoT + 'px');
      st.setProperty('--mdz-game-safe-left', (barCustom ? cL : autoL) + 'px');
      st.setProperty('--mdz-game-safe-right', (barCustom ? cR : autoR) + 'px');
    } catch (e) {}
    const stage = $('embed-stage');
    const frame = $('embed-frame');
    const wrap = $('embed-wrap');
    if (!stage || !frame) return;
    const fw = parseInt(frame.dataset.resW, 10) || NATIVE_W;
    const fh = parseInt(frame.dataset.resH, 10) || NATIVE_H;
    if (mobileSession) {
      /* v1.0.23：padding 必须在**两个分支之前**取——写在 compat 分支内，非 compat 模式（设备默认分辨率）
         引用不到会抛 ReferenceError → fitPlayer 整段中断 → 画面黑屏。 */
      const scs = getComputedStyle(stage);
      const padL = parseFloat(scs.paddingLeft) || 0, padR = parseFloat(scs.paddingRight) || 0;
      const padT = parseFloat(scs.paddingTop) || 0, padB = parseFloat(scs.paddingBottom) || 0;
      if (frame.dataset.compat === '1') {
        const isSafe = frame.dataset.safe === '1';
        // 兼容模式：固定 PC 分辨率逻辑尺寸 + contain 等比缩放（不黑屏：画面完整可见，可能留少量边）
        // v-防黑：safe「防黑安全分辨率」= 逻辑 1280（PC 观感），按外层窗口实际尺寸−安全边距
        // contain 等比缩放且永不放大（scale≤1），居中 → 画面永远不会超出屏幕
        // v1.0.23：按**内容盒**（扣掉左右黑边）算，否则画面只是被 overflow 裁掉、看不到黑边
        const stageW = Math.max(160, stage.clientWidth - padL - padR);
        const stageH = Math.max(120, stage.clientHeight - padT - padB);
        let scale;
        if (isSafe) {
          const pad = safePadVal();
          const availW = Math.max(120, stageW - pad * 2);
          const availH = Math.max(80, stageH - pad * 2);
          scale = Math.min(1, availW / fw, availH / fh);
        } else {
          scale = Math.min(stageW / fw, stageH / fh);
        }
        frame.style.width = fw + 'px';
        frame.style.height = fh + 'px';
        frame.style.transform = Math.abs(scale - 1) < 0.001 ? 'none' : 'scale(' + scale + ')';
        frame.style.transformOrigin = 'top left';
        if (wrap) {
          if (isSafe) {
            // 安全模式：逻辑画布 = 1280 × (可用区比例算高) → 缩放到可用区(外层−边距)时四边留白=边距，
            // 严格等距、无 contain 多余黑边；wrap=stage 定位画布，frame 单元素 transform 缩放+居中
            const pad = safePadVal();
            const availW = Math.max(160, stageW - pad * 2);
            const availH = Math.max(120, stageH - pad * 2);
            const logW = TARGET_W;
            const logH = Math.max(240, Math.round(TARGET_W * (availH / availW)));
            const k = Math.min(1, availW / logW, availH / logH);
            wrap.style.width = stageW + 'px';
            wrap.style.height = stageH + 'px';
            wrap.style.marginLeft = '0';
            wrap.style.marginTop = '0';
            frame.style.width = logW + 'px';
            frame.style.height = logH + 'px';
            frame.style.transformOrigin = '0 0';
            const offX = Math.max(0, Math.round((stageW - logW * k) / 2));
            const offY = Math.max(0, Math.round((stageH - logH * k) / 2));
            const kTxt = Math.abs(k - 1) < 0.001 ? '' : ' scale(' + k + ')';
            frame.style.transform = 'translate(' + offX + 'px,' + offY + 'px)' + kTxt;
          } else {
            wrap.style.width = Math.round(fw * scale) + 'px';
            wrap.style.height = Math.round(fh * scale) + 'px';
            wrap.style.marginLeft = '0';
            wrap.style.marginTop = '0';
          }
        }
        return;
      }
      // 手机端：直接填满播放区（v0.2.1/v1.0.0 定稿：C2 自适应全屏视口，无 transform）。
      // v1.0.23：「避开刘海」留出的黑边要真正避开 → 画面填满**内容盒**（扣掉左右/上下黑边）。
      const w = Math.max(160, stage.clientWidth - padL - padR);
      const h = Math.max(120, stage.clientHeight - padT - padB);
      frame.style.width = w + 'px';
      frame.style.height = h + 'px';
      frame.style.transform = 'none';
      if (wrap) { wrap.style.width = w + 'px'; wrap.style.height = h + 'px'; }
    } else {
      const upscale = frame.dataset.upscale === '1';
      const availW = Math.max(160, stage.clientWidth - 32);
      const availH = Math.max(120, stage.clientHeight - 32);
      // v0.7.8：分辨率自由调整——所有版本统一规则（内嵌按宽≤1 缩放、全屏 contain 铺满），
      // directUrl 版（minidayz-pc）不再有固定画面高/contain 特判
      const scale = upscale ? Math.min(availW / fw, availH / fh) : Math.min(1, availW / fw);
      frame.style.width = fw + 'px';
      frame.style.height = fh + 'px';
      frame.style.transform = Math.abs(scale - 1) < 0.001 ? 'none' : 'scale(' + scale + ')';
      frame.style.transformOrigin = 'top left';
      if (wrap) { wrap.style.width = Math.round(fw * scale) + 'px'; wrap.style.height = Math.round(fh * scale) + 'px'; }
    }
  }

  let closeTimer = 0;
  let fsGuardT = null; // v1.0.1-修复：手机端退出全屏「事件丢失」兜底守护
  // 场景：部分浏览器（如 iOS Safari 元素全屏）退出全屏不派发 fullscreenchange → onFsExit/400ms 关闭都不执行，
  // 播放器（embed-player）保持显示 = 返回启动器页面后「下方残留内嵌窗口」。守护只在：
  // 手机端播放曾进入全屏 → 已退出且连续 ≥1s 不在全屏、而播放器仍未隐藏（理应已回启动器）→ 强制 closePlayer。
  // 正常路径（事件驱动 400ms 关闭 / 点「关闭」按钮）不触发；closePlayer 会 stopFsGuard 自停。
  function startFsGuard() {
    try { if (fsGuardT) { clearInterval(fsGuardT); fsGuardT = null; } } catch (e) {}
    let seenFs = false;
    let sinceExit = 0;
    fsGuardT = setInterval(function () {
      try {
        const fs = isFsActive();
        if (fs) { seenFs = true; sinceExit = 0; return; }
        if (!seenFs) return; // 尚未进入过全屏（加载中被中断等）→ 不归守护管
        if (!sinceExit) { sinceExit = Date.now(); return; }
        if (Date.now() - sinceExit >= 1000 && currentVersion &&
          !$('embed-player').classList.contains('hidden')) {
          clearInterval(fsGuardT); fsGuardT = null;
          closePlayer();
        }
      } catch (e) {}
    }, 350);
  }
  function stopFsGuard() {
    try { if (fsGuardT) { clearInterval(fsGuardT); fsGuardT = null; } } catch (e) {}
  }
  // ===== 全屏适配（iOS Safari 兜底，v0.3.3+） =====
  // iOS 旧版 Safari 的 Fullscreen API 仅对 video 元素生效，普通元素 requestFullscreen 无效
  // （iOS 16.4+ 起支持标准 Element 全屏）。统一封装：原生可用走原生；不可用时用 CSS 伪全屏
  // （fixed 铺满视口 + 100dvh）。内嵌（embed-player）与独立全屏（embed-stage）两种模式都覆盖。
  const fsFullEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  function fsNative() {
    if (window.__mdzForcePseudoFs) return false; // 测试钩子：强制走伪全屏分支
    return typeof Element.prototype.requestFullscreen === 'function' &&
      !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  }
  function isFsActive() { return !!(fsFullEl() || window.__iosFsEl); }
  function fsTarget() { return fsFullEl() || window.__iosFsEl || null; }
  function onFsEnter() {
    clearTimeout(closeTimer);
    if (mobileSession && currentVersion) setGameBg(true); // v1.0.6-修复：退出全屏→旋转→400ms 内重进全屏时恢复黑底
    try { document.body.classList.remove('game-fs-fade'); } catch (e) {} // v1.0.1-修复：全屏已就绪（原生 fullscreenchange / 伪全屏同步）→ 去过渡黑
    if (mobileSession && currentVersion) {
      // v1.0.1-修复：旋转 400ms 窗口内重进全屏 → 恢复被 onFsExit 立即隐藏的播放器（重新进入全屏显示）
      try { if ($('embed-player').classList.contains('hidden')) $('embed-player').classList.remove('hidden'); } catch (e) {}
    }
    reparentDialogToTopLayer(); // 原生全屏就绪后，把「建议横屏」弹窗移入全屏元素（top layer 之上）
    const frame = $('embed-frame');
    frame.dataset.upscale = '1';
    if (currentMode === 'compat' && currentVersion) {
      // 兼容PC分辨率模式：保持 compat 逻辑尺寸（自动/手动，v0.4.9）
      const cr = compatResFor(currentVersion);
      applyFrameSize(cr.w, cr.h);
    } else {
      const r = embedRes(currentVersion);
      applyFrameSize(r.w, r.h); // v0.7.8：自由分辨率（无 directUrl 高度特判）——保持设置分辨率（不用设备分辨率，避免游戏 resize 递归崩溃）
    }
    if (mobileSession) lockLandscape();
  }
  function onFsExit() {
    const playerEl = $('embed-player');
    const frame = $('embed-frame');
    if (!currentVersion) return;
    if (mobileSession) {
      // v1.0.6-修复：退出全屏瞬间立即恢复浅色背景——原实现等 400ms 延迟 closePlayer 才恢复，
      // 期间启动器页面已露出却仍黑底（体感=「关闭游戏后背景残留黑」）；旋转重进全屏由 onFsEnter 恢复
      setGameBg(false);
      // v1.0.1-修复：退出全屏瞬间【立即隐藏播放器】——原实现 fitPlayer 把画面打回页面态停留约 400ms
      // （= 返回启动器后「内嵌窗口短暂闪现一下」）；延迟 closePlayer 仅保留防旋转瞬时退出误杀语义，
      // 旋转后 400ms 内重进全屏 → onFsEnter 恢复显示；正常返回 → 播放器立即消失、无短暂停留
      try { $('embed-player').classList.add('hidden'); } catch (e) {}
      clearTimeout(closeTimer);
      closeTimer = setTimeout(function () {
        if (!isFsActive() && currentVersion) closePlayer();
      }, 400);
    } else if (!playerEl.classList.contains('hidden')) {
      // PC：不关闭播放器。
      // 全屏模式退出 → 保持页面内放大铺满（app-mode，浏览器窗口里游戏 + 顶部选项栏）；
      // 内嵌模式退出 → 恢复页面内固定分辨率。
      frame.dataset.upscale = currentMode === 'fullscreen' ? '1' : '';
      applyFrameSize(resFor(currentVersion.id).w, resFor(currentVersion.id).h); // v0.7.8：自由分辨率（同普通版本）
    }
  }
  /** 进入全屏：优先原生 Fullscreen API；不可用（iOS 旧版）或**原生调用被拒**（iOS HTTP 环境、
   *  浏览器限制等）时回退 CSS 伪全屏——否则播放器以页面窄条显示，画布逻辑分辨率被压缩，
   *  游戏 UI 相对画面会变得巨大（v0.4.4 修复） */
  function enterFs(el) {
    if (fsNative()) {
      lockLandscape(); // 用户手势上下文内先尝试锁横屏
      let p = null;
      try { p = (el.requestFullscreen || el.webkitRequestFullscreen || function () {}).call(el); } catch (e) { p = null; }
      if (p && p.then) {
        p.then(function () { lockLandscape(); }).catch(function () { applyPseudoFs(el); });
      } else if (!p) {
        applyPseudoFs(el); // 调用即失败（无 promise 返回）→ 直接回退
      }
      return;
    }
    applyPseudoFs(el);
  }
  /** CSS 伪全屏（iOS/全屏不可用兜底）：fixed 铺满视口，切换目标前清理旧残留（防挡屏黑屏） */
  function applyPseudoFs(el) {
    if (window.__iosFsEl && window.__iosFsEl !== el) window.__iosFsEl.classList.remove('ios-fs');
    if (window.__iosFsEl === el) { fitPlayer(); return; }
    window.__iosFsEl = el;
    el.classList.add('ios-fs');
    document.body.classList.add('ios-fs-on');
    onFsEnter();
    lockLandscape(); // 尽力（Safari 非全屏页面不允许锁方向，失败静默）
    fitPlayer();
  }
  /** 退出全屏（原生 + 伪全屏统一） */
  function exitFs() {
    if (fsFullEl()) {
      (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
    }
    if (window.__iosFsEl) {
      window.__iosFsEl.classList.remove('ios-fs');
      window.__iosFsEl = null;
      document.body.classList.remove('ios-fs-on');
      onFsExit();
    }
  }
  /** 伪全屏兜底清理：任何路径（含异常/重启）都强制移除 .ios-fs，防止残留元素挡住页面（黑屏） */
  function cleanupPseudoFs() {
    document.querySelectorAll('.ios-fs').forEach(function (el) { el.classList.remove('ios-fs'); });
    document.body.classList.remove('ios-fs-on');
    window.__iosFsEl = null;
  }
  function onFsChange() {
    const el = fsFullEl();
    const playerEl = $('embed-player');
    if (el === playerEl || el === $('embed-stage') || window.__iosFsEl) onFsEnter();
    else if (currentVersion) onFsExit();
  }
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // ===== 手机端竖屏启动弹窗（v0.3.6）：建议横屏后再开始，确认/忽略后才加载游戏 =====
  // iOS/安卓通用：竖屏点「启动」→ 先弹提示，用户点「确认开始」或「忽略」→ 才开始加载游戏；
  // 若等待期间用户已横屏（旋转触发），自动确认并开始加载。
  let pendingLandscapeLoad = null;
  function ensureLandscapeDialog() {
    let dlg = document.getElementById('mdz-landscape-dialog');
    if (dlg) return dlg;
    dlg = document.createElement('div');
    dlg.id = 'mdz-landscape-dialog';
    dlg.className = 'landscape-dialog hidden';
    dlg.innerHTML =
      '<div class="landscape-box">' +
      '<div class="ld-ico">↻</div>' +
      '<p class="ld-text">建议横屏后开始游戏，以获得最佳体验<br><span class="ld-sub">（5 秒后自动开始）</span></p>' +
      '<div class="ld-btns">' +
      '<button class="ld-ok">确认开始</button>' +
      '<button class="ld-skip">忽略</button>' +
      '</div></div>';
    document.body.appendChild(dlg);
    return dlg;
  }
  /** 弹窗挂载点：原生全屏元素处于浏览器 top layer（任何 z-index 都盖不过），
   *  必须把弹窗挂进全屏元素内部才能显示在全屏之上；伪全屏/页面态挂 body 即可 */
  function dialogHost() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.body;
  }
  /** 原生全屏就绪后调用：把弹窗 re-parent 到全屏元素内（requestFullscreen 异步，挂载时可能未就绪） */
  function reparentDialogToTopLayer() {
    const dlg = document.getElementById('mdz-landscape-dialog');
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (dlg && fs && dlg.parentElement !== fs) fs.appendChild(dlg);
  }
  function showLandscapeDialog(doLoad) {
    const dlg = ensureLandscapeDialog();
    const host = dialogHost();
    if (dlg.parentElement !== host) host.appendChild(dlg); // 原生全屏时 re-parent 到全屏元素内
    dlg.classList.remove('hidden');
    pendingLandscapeLoad = doLoad;
    // 兜底：5 秒内未操作（未确认/未忽略/未横屏）→ 视为「无视」，自动开始加载，
    // 避免任何情况下因等待确认而一直黑屏
    clearTimeout(dlg._autoT);
    dlg._autoT = setTimeout(function () {
      if (pendingLandscapeLoad) {
        const fn = pendingLandscapeLoad;
        pendingLandscapeLoad = null;
        hideLandscapeDialog();
        fn();
      }
    }, 5000);
    dlg.querySelector('.ld-ok').onclick = function () { hideLandscapeDialog(); pendingLandscapeLoad = null; doLoad(); };
    dlg.querySelector('.ld-skip').onclick = function () { hideLandscapeDialog(); pendingLandscapeLoad = null; doLoad(); };
  }
  function hideLandscapeDialog() {
    const dlg = document.getElementById('mdz-landscape-dialog');
    if (dlg) { clearTimeout(dlg._autoT); dlg.classList.add('hidden'); }
  }
  /** 等待横屏提示期间视口已为横屏（含自动横屏设备全屏后自动转横）→ 自动确认并开始加载。
   *  不设时间保护：真实竖屏手机全屏后视口仍是竖屏，不会误触发；自动横屏设备全屏后视口
   *  立即变横屏 → 自动继续加载，无需用户再点弹窗。__mdzNoAutoConfirm 为冒烟测试钩子。 */
  function autoConfirmLandscape() {
    if (!pendingLandscapeLoad || window.__mdzNoAutoConfirm) return;
    if (window.innerHeight <= window.innerWidth) {
      const fn = pendingLandscapeLoad;
      pendingLandscapeLoad = null;
      hideLandscapeDialog();
      fn();
    }
  }

  async function openPlayer(v, mode, calibrate, autoFs) {
    // v0.6.61 需求③：启动游戏 → 启动器内容页滚动回顶部（避免停留在列表深处看不到游戏/播放器入口）
    try { window.scrollTo({ top: 0 }); } catch (e) {}
    try { document.documentElement.scrollTop = 0; if (document.body) document.body.scrollTop = 0; } catch (e) {}
    // v0.6.56：记录最近启动（快捷启动块显示「上次游玩」）
    try { setLastLaunched(v); } catch (e) {}
    try { renderQuickLaunch(); } catch (e) {} // 启动即刷新内容（窗口模式弹窗返回后立即可见新「上次游玩」）
    // v0.6.41：启动前迁移无后缀遗留存档（隔离补丁修复后游戏读带后缀库，无后缀旧数据自动迁移不丢）
    try {
      const sm = window.__saveManager;
      if (sm && sm.migrateLegacyDbs) await sm.migrateLegacyDbs(dbKeyOf(v));
    } catch (e) {}
    clearTimeout(closeTimer);
    const backWasPlaying = isPlaying(); // v1.0.1：播放中重启（改分辨率/自动切安全模式）不重复压返回哨兵
    currentVersion = v;
    // v1.0.8/1.0.9：https 站点里，局域网明文 ws:// 与内嵌 http 画面都会被浏览器拦（混合内容）→
    // 只要配了服务器地址就自动改走「新窗口」（顶层窗口加载房主的 http 副本，可正常连 ws://）。
    // 注意：只改本次播放方式，不写入用户设置（mdz-playmode-<id> 保持原值）。
    if (location.protocol === 'https:' && mpServerRaw() && isMpVersion(v)) {
      mode = 'window';
      try { toast('多人版画面以新窗口打开（本站是 https，无法内嵌/连接局域网明文服务器）'); } catch (e) {}
    }
    currentMode = mode;
    // v0.6.24：游戏播放期间禁用启动器页面选取/复制/长按菜单/触摸手势（CSS body.game-active + 事件阻止）
    document.body.classList.add('game-active');
    mobileSession = isMobile(); // 本次播放会话的端判定（全屏期间不再按视口重判）
    // v1.0.6：手机端游戏播放时页面背景置黑——iOS 主屏/全屏未占满区域（safe-area 白边）不再露白
    // v1.0.6-修复：body+html 双置黑（html 盖满视口/overscroll 区，原只黑 body）；恢复统一走 setGameBg(false)，任何退出路径都不残留
    if (mobileSession) setGameBg(true);
    if (mobileSession) startFsGuard(); // v1.0.1-修复：手机端播放会话启退全屏兜底守护（退出事件丢失时确保回启动器页面不再残留播放器）
    // v0.6.50：手机端「画面显示」顶部模式——仅 web（iOS/安卓浏览器）显示；安卓 APK 不需要（用户确认）
    if (mobileSession && $('embed-stage')) {
      $('embed-stage').classList.toggle('inset-top', !PLAT.isAndroid && gameTopInset(v));
    }
    // v0.6.53：进入全屏前（页面态）读取刘海高度存 --mdz-game-notch——全屏后 env 归零读不到，
    // 避开刘海模式靠它 + 屏幕方向决定黑边位置（横屏左/右、竖屏顶部）
    /* v1.0.23（用户纠正）：①「左右黑边 = 自定义」时不用这里的单值（左右由 mdz-game-bar-left/right-<id>
       直接给）→ 置 0；②「自动」时**按手机真实安全区原样**（不再 +12 余量、读不到就不加，手机给 0 就不留）。 */
    if (mobileSession && !PLAT.isAndroid && gameTopInset(v)) {
      let notchVal = 0;
      const barCustom = (lsGet('mdz-game-notch-mode-' + v.id, 'auto') === 'custom');
      if (!barCustom) {
        try {
          const el = document.createElement('div');
          el.style.cssText = 'position:fixed;top:-9999px;left:0;width:0;height:0;' +
            'padding-top:env(safe-area-inset-top,0px);padding-left:env(safe-area-inset-left,0px);' +
            'padding-right:env(safe-area-inset-right,0px);visibility:hidden;pointer-events:none';
          document.body.appendChild(el);
          const cs = getComputedStyle(el);
          const px = (s) => { const m = /([\d.]+)px/.exec(s || ''); return m ? parseFloat(m[1]) : 0; };
          notchVal = Math.max(px(cs.paddingTop), px(cs.paddingLeft), px(cs.paddingRight));
          el.remove();
        } catch (e) { notchVal = 0; }
      }
      document.documentElement.style.setProperty('--mdz-game-notch', notchVal + 'px');
    }
    // v0.7.11/12：PC 播放标题新版命名（内嵌画面/窗口模式）；手机端保持设备默认/兼容语义；v1.0.2：新窗口
    const modeLabel = (PLAT.isPC && !isMobile())
      ? (mode === 'fullscreen' ? '窗口模式' : (mode === 'window' ? '新窗口' : '内嵌画面'))
      : (mode === 'fullscreen' ? '设备默认分辨率' : (mode === 'compat' ? '兼容电脑分辨率' : (mode === 'safe' ? '防黑安全分辨率' : (mode === 'window' ? '新窗口' : '内嵌'))));
    $('embed-title').textContent = (v.name || v.id) + ' · ' + modeLabel;
    syncControls(v);
    const frame = $('embed-frame');
    const gameReady = () => {
      if (!PLAT.isAndroid && !(v && v.noKeymap)) injectMapper(frame.contentWindow); // v1.0.45：noKeymap 版本不注入（PC 键鼠原生）
      if (v && v.directUrl) suppressDirectScroll(frame); // v0.7.3：直链页面删 iframe 内滚动条（body 固定高画面）
      try { ensureTrainerOverlay(); } catch (e) {} // 内嵌模式的修改器覆盖层
      fitPlayer();
      // v0.6.12：自动聚焦游戏 iframe——否则焦点留在父页，F10 校准面板收不到按键（需先点击游戏才有焦点）
      try { frame.focus(); } catch (e) {}
    };
    frame.onload = gameReady;
    // v1.0.1：进入播放态压一个返回哨兵——手机/浏览器返回键 = 退出游戏回启动器（安卓版同语义）；
    // 播放中重启（改分辨率/自动切安全模式）不重复压，避免返回栈堆积
    // v1.0.2：恢复「新窗口」播放方式——window.open 打开独立标签/窗口播放（桌面与手机端选项最后一项）；
    // 被浏览器拦截时 openWindowPlayer 内部 toast 提示。放在压返回哨兵之前：启动器页面不进入播放态。
    if (mode === 'window') {
      $('embed-player').classList.add('hidden');
      $('embed-player').classList.remove('app-mode');
      document.body.classList.remove('app-mode-on');
      $('detail-panel').classList.remove('hidden');
      renderDetail();
      try {
        frame.removeAttribute('srcdoc');
        const dw = frame.contentDocument;
        if (dw) { dw.open(); dw.write(''); dw.close(); }
      } catch (e) {}
      frame.onload = null;
      openWindowPlayer(v, calibrate);
      currentVersion = null; // 启动器页面不处于播放态（避免后续退出/全屏逻辑误判）
      currentMode = 'window';
      /* v1.0.24：这条分支提前 return、不走 closePlayer —— 以前只撤 game-active，
         手机端还会剩 body/html 置黑（「背景变黑」）与滚动锁、全屏守护、过渡黑遮罩（「点不动」）
         → 统一走 resetPlaybackResidue()（纯 UI 复位）。 */
      resetPlaybackResidue();
      return;
    }
    if (!backWasPlaying) backPush('game');
    /* v1.0.10：进入内嵌/全屏播放 → 锁页面滚动。
       不锁的话窗口右侧永远有一条**页面级滚动条**（版本列表把页面撑得比视口高），用户反馈「web 版有滚动条」。
       放在「新窗口」分支之后：那个分支不进入播放态，不能锁（否则回启动器页面就滚不动了）。 */
    try {
      document.documentElement.style.overflow = 'hidden';
      if (document.body) document.body.style.overflow = 'hidden';
    } catch (e) {}
    // 窗口模式（fullscreen）= PC 开独立游戏窗口（web 桌面为页面假全屏）；「新窗口」见上分支
    // 窗口模式（fullscreen）= PC 开独立游戏窗口：main createGameWindow 按所选分辨率定窗，
    // 原生菜单「显示」内置 F11 全屏 + 分辨率预设（改分辨率先弹「请先回到主菜单保存进度」确认再重启）。
    if (mode === 'fullscreen' && PLAT.isPC && !isMobile()) {
      $('embed-player').classList.add('hidden');
      $('embed-player').classList.remove('app-mode');
      document.body.classList.remove('app-mode-on');
      $('detail-panel').classList.remove('hidden');
      renderDetail();
      frame.src = '';
      if (PLAT.launchWindow) PLAT.launchWindow(v, !!calibrate);
      else openWindowPlayer(v, calibrate); // 兜底（正常 PC 必有 launchWindow）
      resetPlaybackResidue(); // v1.0.24：同为「提前 return 不进播放态」的分支，别把播放态样式留在启动器页
      return;
    }
    // 先卸载旧游戏再改尺寸（避免向运行中的游戏派发 resize，规避 C2 事件递归报错）；
    // v1.0.1：不用 src 赋值卸载（会新增历史条目）→ 清 srcdoc + write 空文档
    /* v1.0.28：上一个游戏实例若还留着 IndexedDB 连接，这里先关掉（否则它会一直占着库） */
    try {
      const pw = frame.contentWindow;
      if (pw && typeof pw.__mdzCloseDbs === 'function') pw.__mdzCloseDbs();
    } catch (e) {}
    frame.removeAttribute('srcdoc');
    /* 复位闸门：新一局游戏要能正常持有自己的连接（晚到的 success 不再被立刻关掉） */
    try {
      const pw2 = frame.contentWindow;
      if (pw2 && typeof pw2.__mdzDbReset === 'function') pw2.__mdzDbReset();
    } catch (e) {}
    try {
      const d0 = frame.contentDocument;
      if (d0) { d0.open(); d0.write(''); d0.close(); } else { frame.src = 'about:blank'; }
    } catch (e) { try { frame.src = 'about:blank'; } catch (e2) {} }
    // v1.0.1-修复：手机端播放器显示→原生全屏生效之间会渲染页面态帧（PC「内嵌」形态闪现）。
    // 同一同步块先盖全屏黑遮罩（body.game-fs-fade，onFsEnter 全屏就绪移除）；已在全屏（重启）不加。
    if (mobileSession && !isFsActive()) { try { document.body.classList.add('game-fs-fade'); } catch (e) {} }
    $('embed-player').classList.remove('hidden');
    $('embed-player').classList.remove('bare');
    // 手机端保留详情块；PC 端用游戏画面替换详情块
    if (!isMobile()) { $('detail-panel').classList.add('hidden'); try { $('quick-launch').classList.add('hidden'); } catch (e) {} } // v0.6.56：游戏播放时快捷启动块与详情块一起隐藏（回到列表恢复）
    /* v1.0.23：模式切换不能残留——compat/safe 之外的方式（设备默认分辨率/新窗口/内嵌）先清掉这两个标记，
       否则同一次会话从「兼容电脑分辨率」切到「设备默认分辨率」还会按兼容逻辑渲染。 */
    try { frame.dataset.compat = ''; frame.dataset.safe = ''; } catch (e) {}
    if (isMobile()) {
      if (mode === 'compat' || mode === 'safe') {
        // ===== 手机端「兼容PC分辨率」模式（v0.4.7 实验性，不动原播放模式） =====
        // 手机视口分辨率通常 < PC（如 390×844 vs 1024×768），C2 存档保存的是运行时屏幕坐标，
        // 手机直接填满会把 PC 存档的 UI 坐标错位/放大。此模式让 iframe 用「PC 分辨率」逻辑尺寸，
        // 再 transform 等比缩放到手机全屏 —— 画面完整不黑屏，且存档 UI 布局与 PC 一致。
        // v-防黑专项：safe「防黑安全分辨率」同一入口——画布=横屏可用显示 − 每侧安全边距（1:1 不放大）
        $('embed-player').classList.remove('app-mode');
        document.body.classList.remove('app-mode-on');
        frame.dataset.upscale = '1';
        frame.dataset.compat = '1';
        frame.dataset.safe = mode === 'safe' ? '1' : '';
        const isSafe = mode === 'safe';
        const portraitStart = window.innerHeight > window.innerWidth; // 进入全屏前的页面态视口判定（全屏后视口=屏幕尺寸，会误判）
        enterFs($('embed-stage')); // 纯画面全屏（无顶栏）
        if (PLAT.setFullscreen) PLAT.setFullscreen(true); // 安卓：游戏播放时隐藏系统栏
        const startCompat = () => {
          // ① 先尽力强制横屏（用户手势上下文内；iOS 16.4+ 原生全屏下有效）
          lockLandscape();
          // ② 若已横屏直接读分辨率启动；否则等 orientationchange/resize 横屏，1.5s 超时兜底
          const doLoad = () => {
            const cr = isSafe ? safeResFor() : compatResFor(v); // 此刻视口已横屏 → 读到横屏尺寸
            if (isSafe) {
              toast('防黑安全分辨率：' + cr.w + '×' + cr.h + '（1280 PC 观感，按显示区域−边距等比缩放、永不放大，不会黑屏）');
            } else if (cr.mode === 'physical') toast('兼容电脑分辨率：物理屏幕比例 ' + cr.w + '×' + cr.h);
            else if (cr.auto) toast('兼容电脑分辨率：自动适配视口 ' + cr.w + '×' + cr.h);
            else {
              // v-防黑：手动分辨率大于当前屏幕可用范围 → 启动提示（不拦截）
              const manual = lsGet('mdz-compat-res-' + v.id, null);
              const vw = window.innerWidth || screen.width || 1280;
              const vh = window.innerHeight || screen.height || 720;
              if (manual && manual.w && manual.h && (cr.w > vw || cr.h > vh)) {
                toast('画面分辨率 ' + cr.w + '×' + cr.h + ' 大于当前屏幕可用范围，低端机可能黑屏——建议改用「防黑安全分辨率」', true);
              } else {
                toast('兼容电脑分辨率：画面按 ' + cr.w + '×' + cr.h + ' 逻辑尺寸缩放');
              }
            }
            applyFrameSize(cr.w, cr.h); // 固定逻辑分辨率（safe=显示−边距，1:1）
            loadGameInto(frame, v, calibrate, gameReady); // 启动游戏
            startFpsWatch(v, isSafe); // v-防黑：启动后检测渲染帧，冻结则提示并自动切安全模式
          };
          if (window.innerWidth > window.innerHeight) { doLoad(); return; } // 已横屏
          let done = false;
          const onLandscape = () => { if (window.innerWidth > window.innerHeight) finish(); };
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(compatWaitT);
            window.removeEventListener('orientationchange', onLandscape);
            window.removeEventListener('resize', onLandscape);
            doLoad();
          };
          const compatWaitT = setTimeout(finish, 1500); // 锁横屏失败兜底（用当前视口）
          window.addEventListener('orientationchange', onLandscape);
          window.addEventListener('resize', onLandscape);
        };
        if (mobileSession && portraitStart) {
          showLandscapeDialog(startCompat); // 竖屏：先提示横屏，点确定/已横屏/超时后强制横屏再读分辨率启动
        } else {
          startCompat();
        }
        return;
      }
      // ===== 手机端（与 PC 完全分开） =====
      // 内嵌 = 内嵌窗口全屏化（顶部栏可见），画面直接填满播放区：
      //         无 transform 缩放（解决黑屏），宽度填满（解决画面窄）。
      // 全屏 = 全屏画面（无顶部栏），同样直接填满。
      $('embed-player').classList.remove('app-mode');
      document.body.classList.remove('app-mode-on');
      frame.dataset.upscale = '1';
      applyFrameSize(resFor(v.id).w, resFor(v.id).h); // 仅供 fitPlayer 读取；手机端实际填满播放区
      const portraitStart = window.innerHeight > window.innerWidth; // 进入全屏前的页面态视口判定（全屏后视口=屏幕尺寸，会误判）
      enterFs((mode === 'fullscreen') ? $('embed-stage') : $('embed-player')); // iOS 不支持原生全屏时自动走 CSS 伪全屏
      if (PLAT.setFullscreen) PLAT.setFullscreen(true); // 安卓：游戏播放时隐藏系统栏
      // 手机端竖屏：先弹「建议横屏」提示，用户确认/忽略后才加载游戏（v0.3.6）
      if (mobileSession && portraitStart) {
        showLandscapeDialog(() => loadGameInto(frame, v, calibrate, gameReady));
      } else {
        loadGameInto(frame, v, calibrate, gameReady); // 运行时注入后加载（不改游戏文件）
      }
    } else {
      // ===== PC 端 =====
      // 内嵌 = 页面内按设置分辨率播放（不放大）；⛶ 全屏 = 固定分辨率 transform 等比缩放全屏。
      // 全屏模式（独立）= F11 式真全屏；退出全屏后【不关闭播放器、不回启动页】：
      //   app-mode 让页面内 stage 撑满浏览器窗口、游戏等比放大铺满，顶栏选项栏保留，
      //   形态类似手机端内嵌的非全屏态。全程不给运行中的游戏改真实尺寸，规避 C2 递归报错。
      $('embed-player').classList.toggle('app-mode', mode === 'fullscreen');
      document.body.classList.toggle('app-mode-on', mode === 'fullscreen'); // 隐藏页面其他内容，播放器占满窗口
      frame.dataset.upscale = mode === 'fullscreen' ? '1' : '';
      // v0.7.8：分辨率自由调整（同普通版本，无高度限制）
      applyFrameSize(resFor(v.id).w, resFor(v.id).h);
      // autoFs 默认 true；restartGame 传当前全屏状态——在 app-mode 页面态改分辨率/模式时不再自动跳回全屏
      if (mode === 'fullscreen' && autoFs !== false) enterFs($('embed-stage'));
      loadGameInto(frame, v, calibrate, gameReady); // 运行时注入后加载（不改游戏文件）
    }
    // v0.6.61 需求③：PC 内嵌/窗口启动后不再平滑滚动——启动开头已回顶部，游戏画面在页面顶部区域直接可见
  }

  function applyFrameSize(w, h) {
    const frame = $('embed-frame');
    frame.dataset.resW = w;
    frame.dataset.resH = h;
    fitPlayer();
  }
  window.addEventListener('resize', () => {
    // 仅页面态（未播放）按视口刷新端判定；播放会话期间保持 openPlayer 捕获的判定，
    // 否则进入全屏瞬间视口变屏幕尺寸，resize 会把手机误判成 PC（黑屏/窄画面）。
    if (!isPlaying()) mobileSession = isMobile();
    autoConfirmLandscape(); // 横屏提示等待期间视口已横屏（含自动横屏设备）→ 自动开始加载
    clearTimeout(window.__fitT); window.__fitT = setTimeout(fitPlayer, 150);
    // 网格分页按当前可视尺寸重算（列数随容器宽度变化）
    if (libView === 'grid' && versions.length) renderLibrary();
  });
  window.addEventListener('orientationchange', () => { autoConfirmLandscape(); clearTimeout(window.__fitT2); window.__fitT2 = setTimeout(fitPlayer, 250); });

  // v-防黑专项(2026-09-09)：渲染帧黑屏检测——注入 rAF 计数；启动约 8s 后仍几乎无帧即判定冻结：
  // 非安全模式 → 自动切换「防黑安全分辨率」并提示；已安全模式 → 提示建议设备默认/重启
  let fpsWatchT = null;
  function startFpsWatch(v, isSafe) {
    try { if (fpsWatchT) { clearInterval(fpsWatchT); fpsWatchT = null; } } catch (e) {}
    const t0 = Date.now();
    let injected = false;
    const injectFrame = () => {
      try {
        const w = frame.contentWindow;
        if (!w || !w.document) return false;
        if (!w.__mdzFps) {
          w.__mdzFps = 0;
          (function tick() { try { w.__mdzFps = (w.__mdzFps || 0) + 1; } catch (e2) {} try { w.requestAnimationFrame(tick); } catch (e2) {} })();
        }
        return true;
      } catch (e) { return false; }
    };
    (function tryInject() { if (injectFrame()) { injected = true; return; } if (Date.now() - t0 > 9000) return; setTimeout(tryInject, 250); })();
    fpsWatchT = setInterval(() => {
      try {
        if (!injected) return;
        const w = frame.contentWindow;
        const f = w ? (w.__mdzFps || 0) : 0;
        const dt = Date.now() - t0;
        if (dt >= 8000 && f <= 5) { // 8 秒几乎无帧 → 判定黑屏/冻结
          clearInterval(fpsWatchT); fpsWatchT = null;
          if (currentVersion && currentVersion.id === v.id) {
            if (!isSafe) {
              try { lsSet('mdz-playmode-' + currentVersion.id, 'safe'); } catch (e) {}
              toast('检测到画面异常（可能黑屏），已自动切换「防黑安全分辨率」', true);
            } else {
              toast('「防黑安全分辨率」下仍无画面，请尝试「设备默认分辨率」或重启设备', true);
            }
            setTimeout(() => { try { openPlayer(currentVersion, 'safe'); } catch (e3) {} }, 700);
          }
        }
      } catch (e) {}
    }, 600);
  }
  /** v1.0.6-修复：播放期页面背景置黑统一开关——body+html 同步置黑/恢复。
   *  css 里 html.game-black-bg 规则此前从未被触发（JS 只加 body）；同步后视口 overscroll/状态栏区也盖黑，
   *  且所有退出路径收敛到 setGameBg(false) 可靠恢复主题背景，杜绝残留黑。 */
  function setGameBg(on) {
    try { document.body.classList.toggle('game-black-bg', !!on); } catch (e) {}
    try { document.documentElement.classList.toggle('game-black-bg', !!on); } catch (e) {}
  }
  /** v1.0.24（用户要求，移植 v1.0.16 的修复）：「新窗口」启动后返回启动器 → 清掉播放态残留。
   *  症状：返回后**背景变黑 + 点不动**（body/html 置黑、game-active、滚动锁、全屏守护/过渡黑遮罩、
   *  stage 的 inset-top、横屏弹窗、方向锁都留在启动器页上）。
   *  **只做 UI 状态复位**：不碰存档、不卸载游戏帧、不断音频——避免影响已有的存档运行流程。 */
  function resetPlaybackResidue() {
    /* v1.0.24：返回启动器（切回页面/恢复焦点）时，页面里若还留着**在跑的游戏帧** → 断声 + 卸载
       （与 closePlayer 同样的卸载方式，不改任何存档逻辑），避免「启动器已经回来了、游戏还在后台跑/出声」。 */
    try {
      const fr = $('embed-frame');
      if (fr && fr.contentWindow && fr.contentWindow.__mdzAudioGuard) {
        silenceGame(fr.contentWindow, true);
        try {
          fr.removeAttribute('srcdoc');
          const d0 = fr.contentDocument;
          if (d0) { d0.open(); d0.write(''); d0.close(); }
        } catch (e) {}
      }
    } catch (e) {}
    try { setGameBg(false); } catch (e) {}
    try { document.body.classList.remove('game-active'); } catch (e) {}
    try { document.body.classList.remove('game-fs-fade'); } catch (e) {}
    try { stopFsGuard(); } catch (e) {}
    try { document.documentElement.style.overflow = ''; if (document.body) document.body.style.overflow = ''; } catch (e) {}
    try { if (fpsWatchT) { clearInterval(fpsWatchT); fpsWatchT = null; } } catch (e) {}
    try { cleanupPseudoFs(); } catch (e) {}
    try { const stg = $('embed-stage'); if (stg) stg.classList.remove('inset-top'); } catch (e) {}
    try { hideLandscapeDialog(); } catch (e) {}
    try { unlockOrientation(); } catch (e) {}
    try { if (PLAT.setFullscreen) PLAT.setFullscreen(false); } catch (e) {}
    try { mobileSession = isMobile(); } catch (e) {}
  }
  /** 从后台/bfcache 恢复、或窗口重新获得焦点时兜底清残留（不在播放态就不该有播放态样式）。 */
  function guardResidueOnResume() {
    try { if (isPlaying()) return; resetPlaybackResidue(); } catch (e) {}
    /* v1.0.24：「新窗口」模式启动的游戏在另一个窗口/标签里跑 —— 一回到启动器就把它停掉
       （断声 + 手机端关闭该窗口），否则用户听到的就是「返回了游戏还没关」。 */
    try { if (!isPlaying()) stopPoppedGame(); } catch (e) {}
  }
  window.addEventListener('pageshow', guardResidueOnResume);
  window.addEventListener('focus', guardResidueOnResume);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) guardResidueOnResume(); });
  function closePlayer() {
    // 内嵌修改器覆盖层最先收起：它挂在启动器页面上，下面任何一步抛异常都不该把它留在界面上
    try {
      if (window.__mdzTrainer) {
        window.__mdzTrainer.hide();
        const pill = document.getElementById('mdz-trainer-pill');
        if (pill) pill.style.display = 'none';
      }
    } catch (e) {}
    // v1.0.6-修复：恢复页面背景与交互优先于一切——即使后续清理抛异常/被打断，黑底也绝不残留
    try { setGameBg(false); } catch (e) {} // v1.0.6：恢复页面主题背景（iOS 白边置黑解除）
    try { document.body.classList.remove('game-fs-fade'); } catch (e) {} // v1.0.1-修复：兜底去过渡黑（异常中断/未全屏退出也不残留）
    try { stopFsGuard(); } catch (e) {} // v1.0.1-修复：关停全屏退出守护（避免重复触发）
    try { document.body.classList.remove('game-active'); } catch (e) {} // v0.6.24：退出游戏恢复页面选取/手势
    // v1.0.10：恢复页面滚动（与 openPlayer 的锁成对；任何退出路径都恢复，绝不残留滚不动）
    try { document.documentElement.style.overflow = ''; if (document.body) document.body.style.overflow = ''; } catch (e) {}
    try { if (fpsWatchT) { clearInterval(fpsWatchT); fpsWatchT = null; } } catch (e) {} // v-防黑：退出播放停检测
    cleanupPseudoFs(); // 伪全屏残留兜底清理（防 .ios-fs 挡住页面黑屏）
    pendingLandscapeLoad = null;
    hideLandscapeDialog(); // 关闭可能残留的「建议横屏」弹窗
    const stg = $('embed-stage'); if (stg) { stg.classList.remove('inset-top'); stg.style.height = ''; } // v0.7.3：复位 directUrl 内嵌固定高
    $('embed-player').classList.add('hidden');
    $('embed-player').classList.remove('app-mode');
    document.body.classList.remove('app-mode-on');
    $('detail-panel').classList.remove('hidden');
    renderDetail();
    const frame = $('embed-frame');
    /* v1.0.24：**先断声再卸载**——C2 的 AudioContext 在文档被 document.write('') 清掉后仍可能继续播放
       （iOS/WebKit 尤其明显）→ 先把守卫登记过的 AudioContext suspend+close、媒体元素 pause，再清文档。 */
    try { silenceGame(frame.contentWindow, true); } catch (e) {}
    try { stopPoppedGame(); } catch (e) {}
    // 彻底卸载游戏（清 srcdoc + 空文档写入，避免游戏继续运行；v1.0.1：不再用 src 赋值——会产生历史条目）
    frame.removeAttribute('srcdoc');
    frame.removeAttribute('data-compat'); // v0.4.7：清兼容模式标记
    try {
      const d1 = frame.contentDocument;
      if (d1) { d1.open(); d1.write(''); d1.close(); } else { frame.src = 'about:blank'; }
    } catch (e) { try { frame.src = 'about:blank'; } catch (e2) {} }
    frame.onload = null;
    currentVersion = null;
    currentMode = 'embed';
    unlockOrientation();
    if (PLAT.setFullscreen) PLAT.setFullscreen(false); // 安卓：退出播放恢复系统栏
    if (isFsActive()) exitFs(); // 原生 + iOS 伪全屏统一退出
    syncControls(getSel());
    try { renderQuickLaunch(); } catch (e) {} // v0.6.56：回到启动器后「上次游玩」更新
    // v0.6.61 需求③：返回启动器页面 → 内容页滚动回顶部
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { try { window.scrollTo(0, 0); } catch (e2) {} }
    // v1.0.1：程序内关闭（点关闭/自动关）→ 消费返回哨兵，避免下次返回键「空按一次」；
    // 由返回键触发的关闭（backClosing）不再消费（那一次后退本身已消耗历史条目）
    if (!backClosing) backConsume();
  }
  $('btn-embed-close').onclick = closePlayer;

  // ===== 分辨率 / 播放方式（顶栏 + 播放器栏；改动时重启游戏需确认） =====
  function populateRes(sel, v) {
    const cur = resFor(v.id);
    sel.innerHTML = '';
    for (const p of PRESETS) {
      const o = document.createElement('option');
      o.value = p.custom ? 'custom' : (p.w + 'x' + p.h);
      o.textContent = p.label;
      if (!p.custom && cur.w === p.w && cur.h === p.h) o.selected = true;
      if (p.custom && !PRESETS.some((x) => !x.custom && x.w === cur.w && x.h === cur.h)) o.selected = true;
      sel.appendChild(o);
    }
  }

  function isPlaying() { return !!currentVersion && !$('embed-player').classList.contains('hidden'); }

  function syncControls(v) {
    if (!v) return;
    // v0.7.6：directUrl 版（minidayz-pc）恢复可调分辨率（下拉常显）——见 resFor 的宽生效语义
    populateRes($('embed-res'), v);
    $('embed-res-custom').classList.add('hidden');
  }

  function restartGame() {
    const v = currentVersion;
    if (v) openPlayer(v, modeFor(v.id), false, isFsActive()); // 保持当前全屏状态（原生 + iOS 伪全屏）
  }

  function applyResSetting(v, w, h) {
    if (!Number.isFinite(w) || !Number.isFinite(h)) { toast('分辨率无效', true); return; }
    const playing = isPlaying();
    if (playing && !confirm('这会重启游戏，请确保处于主菜单页面。')) { syncControls(v); return; }
    lsSet('mdz-res-' + v.id, { w, h });
    syncControls(v);
    toast('分辨率已设为 ' + w + '×' + h + (playing ? '，游戏已重启' : ''));
    if (playing) restartGame();
  }

  function bindResControls(selId, customId, wId, hId, applyId) {
    $(selId).onchange = () => {
      const v = currentVersion || getSel();
      if (!v) return;
      const sel = $(selId);
      if (sel.value === 'custom') {
        const cur = resFor(v.id);
        $(wId).value = cur.w;
        $(hId).value = cur.h;
        $(customId).classList.remove('hidden');
        return;
      }
      const [w, h] = sel.value.split('x').map(Number);
      applyResSetting(v, w, h);
    };
    $(applyId).onclick = () => {
      const v = currentVersion || getSel();
      if (!v) return;
      applyResSetting(v, parseInt($(wId).value, 10), parseInt($(hId).value, 10));
      $(customId).classList.add('hidden');
    };
  }
  bindResControls('embed-res', 'embed-res-custom', 'embed-res-w', 'embed-res-h', 'embed-res-apply');

  $('btn-embed-fs').onclick = () => {
    const stage = $('embed-stage');
    const player = $('embed-player');
    if (mobileSession && isFsActive() && fsTarget() === player) {
      // 手机端内嵌全屏：⛶ 去掉顶部栏，变为纯游戏全屏（不退回启动器页面）；
      // 再点 ⛶ 恢复顶栏；退出全屏用「关闭」按钮（iOS 伪全屏无系统手势）
      player.classList.toggle('bare');
      fitPlayer();
      return;
    }
    if (isFsActive()) exitFs();
    else enterFs(stage);
  };

  // ===== 按键映射导入/导出（keymap 存 localStorage 'mdz-keymap-<id>'，同源持久=浏览器缓存） =====
  function keymapLSKey(v) { return 'mdz-keymap-' + v.id; }
  // v0.6.27：按键映射多方案存储（新 key mdz-keymaps-<id> = {active, schemes}；旧单方案 key 迁移）
  function keymapSchemesKey(v) { return 'mdz-keymaps-' + (v.id || 'default'); }
  function keymapLSKey(v) { return 'mdz-keymap-' + (v.id || 'default'); }
  function exportKeymap(v) {
    let obj = null;
    try { obj = JSON.parse(localStorage.getItem(keymapSchemesKey(v)) || 'null'); } catch (e) {}
    if (!obj || !obj.schemes) {
      // 旧单方案兜底（迁移）
      try { const old = JSON.parse(localStorage.getItem(keymapLSKey(v)) || 'null'); if (old && typeof old === 'object') obj = { active: '默认', schemes: { '默认': old } }; } catch (e) {}
    }
    if (!obj || !obj.schemes || !Object.keys(obj.schemes).length) { toast('该版本还没有按键映射配置（先在游戏内 F10 校准过）', true); return; }
    const name = (obj.active && obj.schemes[obj.active]) ? obj.active : Object.keys(obj.schemes)[0];
    const map = obj.schemes[name];
    if (PLAT.exportKeymap) { PLAT.exportKeymap(map, v); return; }
    const blob = new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' });
    // v1.0.1：统一下载封装（受限内置浏览器 a.download 可能无效）
    downloadBlob(blob, 'mdz-keymap-' + v.id + '-' + name + '.json',
      '已导出按键映射方案「' + name + '」（' + Object.keys(map).length + ' 个按键）');
  }
  function importKeymap(v) {
    // v0.7.5：PC 平台按键映射导入走原生对话框（PLAT.importKeymap 钩子）
    if (PLAT.importKeymap) { PLAT.importKeymap(v); return; }
    const fi = document.createElement('input');
    fi.type = 'file';
    fi.accept = '.json,application/json';
    fi.onchange = () => {
      const f = fi.files && fi.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const obj = JSON.parse(String(reader.result));
          if (!obj || typeof obj !== 'object') throw new Error('无效的按键映射文件');
          const sk = keymapSchemesKey(v);
          let store = null;
          try { store = JSON.parse(localStorage.getItem(sk) || 'null'); } catch (e) {}
          if (!store || !store.schemes) store = { active: '默认', schemes: {} };
          if (obj.schemes && typeof obj.schemes === 'object') {
            // 完整方案包：合并导入
            Object.keys(obj.schemes).forEach((n) => { store.schemes[n] = obj.schemes[n]; });
            if (obj.active && store.schemes[obj.active]) store.active = obj.active;
            toast('已导入按键映射方案包（' + Object.keys(obj.schemes).length + ' 套，重启游戏生效）');
          } else {
            const name = String(f.name || '').replace(/\.json$/i, '') || ('导入' + Date.now().toString(36));
            store.schemes[name] = obj;
            store.active = name;
            toast('已导入按键映射方案「' + name + '」（' + Object.keys(obj).length + ' 个按键，重启游戏生效）');
          }
          localStorage.setItem(sk, JSON.stringify(store));
        } catch (e) { toast('导入按键映射失败: ' + e.message, true); }
      };
      reader.readAsText(f);
    };
    fi.click();
  }

  function launchVersion(v, mode, calibrate, fromQl) {
    lsSet('mdz-playmode-' + v.id, mode);
    // v0.6.61 需求①：列表/置顶/详情点「启动」→ 版本信息切到启动的版本（含列表选中框、快捷启动高亮同步）
    // v0.6.62 修正④：来源为快捷启动（fromQl）→ qlSelect（版本列表静默收起、同版本不加框）
    try {
      if (selectedId !== v.id) {
        if (fromQl) qlSelect(v.id); else selectVersion(v.id);
      }
    } catch (e) { console.warn('[launchVersion] select:', e); }
    openPlayer(v, mode, calibrate);
  }

  // v0.5.0：下载按钮——链接优先级：版本元数据 download 字段 > mdz-config 默认下载链接 > 内置默认
  const DEFAULT_DOWNLOAD_URL = 'https://moyu-camp.info/archives/minidayz-download';
  function downloadUrlFor(v) {
    if (v && v.download) return String(v.download);
    const cfg = (window.__mdzConfig && typeof window.__mdzConfig === 'object') ? window.__mdzConfig : null;
    const d = (cfg && cfg.downloadDefault) ? String(cfg.downloadDefault) : '';
    return d || DEFAULT_DOWNLOAD_URL;
  }
  function openDownload(v) {
    const url = downloadUrlFor(v);
    // v1.0.1：QQ/微信等内置浏览器 window.open 会被静默拦截（用户反馈「点下载没反应」）→ 统一外链封装
    openExternalUrl(url);
  }

  // ================= 存档 =================
  async function doExport(v) {
    try {
      /* v1.0.25：导出前先停游戏——游戏运行中导出会读到「写了一半」的库（用户实测：失效时导出的存档也有问题） */
      const gameWasRunning = await ensureNoGameForSave();
      const { backup, count, c2Missing, c2State } = await window.__saveManager.exportVersion(dbKeyOf(v));
      if (count === 0) { toast('未找到该版本的存档数据（可能还没玩过）', true); return; }
      // v0.6.38：导出内容状态提示（对局中 / 主菜单）——防导出非对局状态而不自知
      const stateTxt = c2State ? ('【' + c2State + '】') : (c2Missing ? '【无对局进度】' : '');
      // v0.6.32：C2 存档库缺失警告——防用户导出「只有设置、缺进度」的小文件而不自知
      if (c2Missing && !window.confirm('该版本未找到游戏存档（进度）数据，导出将仅包含设置数据。\n可能原因：从未保存过、存档被删除、或旧存档在无后缀遗留库中。\n仍要导出吗？')) return;
      if (PLAT.saveExport) { await PLAT.saveExport(backup, v); return; } // 安卓：写文件 + 分享
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      // v1.0.1：受限内置浏览器（QQ/微信）a.download 可能无效 → 统一下载封装（不支持时回退新窗口/blob 提示）
      downloadBlob(blob, 'mdz-save_' + v.id + '_' + new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '') + '.json',
        '已导出 ' + count + ' 条记录 ' + stateTxt + (gameWasRunning ? '（已先关闭正在运行的游戏）' : ''));
    } catch (e) { toast('导出失败: ' + e.message, true); }
  }
  function doImport(v) {
    // v0.7.5：PC 平台（__launcherNative）存档导入走原生打开对话框（PLAT.saveImport 钩子）
    if (PLAT.saveImport) { PLAT.saveImport(v); return; }
    const fi = $('file-import');
    fi.onchange = () => {
      const f = fi.files && fi.files[0];
      fi.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        // v0.6.37：导入前必须先关闭游戏——游戏运行中会自动保存，把导入的数据覆盖回旧进度
        // （用户实测：导入显示 55 条成功，但重开游戏还是当前存档；日志显示游戏 Saved 覆盖了导入的 mysave）
        // v1.0.25：统一走 ensureNoGameForSave（页面内播放 + 「新窗口」里的游戏都算"在跑"）
        ensureNoGameForSave().then((needClose) => {
        if (needClose) toast('游戏运行中，已先关闭游戏再导入…');
        const doIt = () => {
          window.__saveManager.importVersion(dbKeyOf(v), String(reader.result)).then((res) => {
            saveScanDirty = true; // v0.6.61：导入后存档数据变更（下次进存档页/刷新重扫）
            // v0.6.35：明确显示 C2 存档（进度）与设置数据分别恢复条数
            const c2Txt = (res.c2Count !== undefined && res.c2Count > 0)
              ? ('已恢复游戏进度 ' + res.c2Count + ' 条' + (res.restored - res.c2Count > 0 ? ' + 设置 ' + (res.restored - res.c2Count) + ' 条' : ''))
              : '未恢复游戏进度（存档文件中没有 C2 进度数据，仅恢复设置 ' + res.restored + ' 条）';
            const src = (function () { try { return JSON.parse(String(reader.result))._dbKey; } catch (e) { return null; } })();
            const extra = (needClose ? '（已关闭游戏，重新打开生效）' : '') + (src && src !== dbKeyOf(v) ? '（存档来自「' + src + '」，已迁移到当前版本）' : '') + (res.skipped ? '（跳过 ' + res.skipped + ' 个非本版本库）' : '');
            toast(c2Txt + extra);
            /* v1.0.26：写完**复查**——导入显示成功、实际没写进去（还有窗口占着库/被游戏自动保存覆盖）时要说清楚，
               否则用户看到「成功」却还是旧存档。 */
            /* v1.0.27：复查没写进去 → 再写一遍（游戏可能刚好在那一刻覆盖过），仍然不行才报可操作的错误 */
            try {
              if (res.restored > 0 && window.__saveManager.hasSaveData) {
                window.__saveManager.hasSaveData(dbKeyOf(v)).then(function (hasNow) {
                  if (hasNow) return;
                  return window.__saveManager.importVersion(dbKeyOf(v), String(reader.result)).then(function () {
                    return window.__saveManager.hasSaveData(dbKeyOf(v));
                  }).then(function (again) {
                    if (!again) toast('导入没有真正生效：还有窗口/标签占用该版本存档库（游戏还开着）→ 关掉游戏窗口后重试', true);
                  });
                }).catch(function () {});
              }
            } catch (e) {}
          }).catch((e) => toast('导入失败: ' + e.message, true));
        };
        doIt(); // ensureNoGameForSave 里已经等过连接释放（防最后一刻自动保存覆盖）
        });
      };
      reader.readAsText(f);
    };
    fi.click();
  }

  // ================= 导出 Halo 静态清单（PHP 环境小皮面板部署用） =================
  // versions.php?export=1：PHP 扫描 versions/ 目录并写出 versions.json → 前端下载；
  // 把该文件 + 新增版本目录上传到 Halo 等纯静态托管覆盖即可（免打命令更新版本列表）。
  async function exportManifest() {
    try {
      const res = await fetch('versions.php?export=1&t=' + Date.now(), { cache: 'no-store' });
      if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '-'));
      const j = await res.json();
      if (!Array.isArray(j)) throw new Error('返回格式异常');
      const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' });
      // v1.0.1：统一下载封装（受限内置浏览器 a.download 可能无效）
      downloadBlob(blob, 'versions.json', '已生成 versions.json（' + j.length + ' 个版本）并下载，上传到 Halo 覆盖即可');
    } catch (e) {
      toast('生成失败: ' + e.message + '（需在 PHP 环境的小皮面板部署中操作）', true);
    }
  }
  // v1.0.37：安卓 build 会删除「静态部署清单」卡与「查看存档库」按钮 → 顶层直绑 null.onclick 抛错
  // 会中断其后全部顶层静态绑定（搜索监听、折叠/展开按钮在安卓失效的根因）→ 统一做存在性保护
  const btnExportManifest = $('btn-export-manifest');
  if (btnExportManifest) btnExportManifest.onclick = exportManifest;

  // ================= 存档管理视图 =================
  // 诊断：列出本浏览器该站点所有 IndexedDB 库（排查游戏读取/导入写入的库不一致）
  {
    const btnDbs = $('btn-dbs');
    if (btnDbs) btnDbs.onclick = async () => {
      // v1.0.3：诊断结果放「设置 → 存档库（诊断）」卡内，不再插到存档列表上方
      const host = $('db-list-host');
      // v1.0.3-修复：点击切换——已展开则收起（原先每次点击都重新渲染内容，看起来收不起来）
      const shown = $('db-list');
      if (shown) { try { shown.remove(); } catch (e) {} if (host) host.textContent = ''; return; }
      const box = document.createElement('div');
      box.id = 'db-list';
      box.className = 'card';
      box.innerHTML = '<h4>IndexedDB 库（本浏览器 · 本站点）</h4>';
      const pre = document.createElement('pre');
      pre.className = 'db-list-pre';
      pre.textContent = '枚举中…';
      box.appendChild(pre);
      if (host) { host.textContent = ''; host.appendChild(box); }
      else { const wrap = $('save-list'); if (wrap && wrap.parentElement) wrap.parentElement.insertBefore(box, wrap); } // 兜底（旧页面）
      try {
        const dbs = await window.__saveManager.listDbs();
        pre.textContent = dbs.length
          ? dbs.map((d) => d.name + (d.stores.length ? '  → [' + d.stores.join(', ') + ']' : '')).join('\n')
          : '（没有 IndexedDB 库）';
      } catch (e) { pre.textContent = 'ERR ' + e.message; }
    };
  }

  /* v1.0.25（用户实测：「内嵌画面时没关游戏，直接去存档页备份/删除 → 失效；先正常关掉游戏再备份就没事」）：
     **存档操作的统一前置条件 = 先让游戏停下来**。游戏（页面内 iframe / 「新窗口」里的游戏）会一直持有该版本
     IndexedDB 的连接 → `deleteDatabase` 被 blocked（删了刷新又回来）、导出读到「写了一半」的数据、
     导入进去的数据被游戏的自动保存覆盖回去。
     统一收口两条停止路径：①页面内在跑的播放 → `closePlayer()`；②「新窗口」模式的游戏窗口 → `stopPoppedGame()`；
     然后等连接释放（400ms）再让调用方读写存档。**不改任何存档命名/读写逻辑，只保证「读写时游戏没在跑」。** */
  async function ensureNoGameForSave() {
    let stopped = false;
    try { if (isPlaying()) { closePlayer(); stopped = true; } } catch (e) {}
    try { if (mdzPopWin && !mdzPopWin.closed) { stopPoppedGame(); stopped = true; } } catch (e) {}
    if (stopped) await new Promise(function (r) { setTimeout(r, 800); }); // v1.0.27：等久一点（400→800）——游戏那边的最后一批写/连接释放可能是异步的
    return stopped;
  }
  // v0.6.23：删除存档前确保游戏已关闭（现统一走 ensureNoGameForSave）；删除后复查，仍删不掉就明确提示
  async function deleteSavesGuarded(dbKey) {
    const closedGame = await ensureNoGameForSave();
    let del = [];
    let remains = false;
    let rounds = 0;
    /* v1.0.27（用户实测：删除时不时失效）：删除做成「删一轮 → 等一会 → 复查 → 没干净再来一轮」，最多 3 轮。
       为什么需要复查再删：删除成功那一刻库确实没了，但游戏那边若还有没落盘的写/未释放的连接，
       会在这之后把库又写回来 —— 表现为「刚显示删掉了，过一会存档又回来了」。 */
    const SETTLE_MS = 1400; // 删除后的"稳定窗口"：这段时间内持续复查
    const STEP_MS = 350;
    for (rounds = 1; rounds <= 3; rounds++) {
      try {
        if (window.__saveManager && window.__saveManager.deleteVersionSaves) {
          const d = await window.__saveManager.deleteVersionSaves(dbKey);
          if (d && d.length) del = d;
        }
      } catch (e) {}
      /* 只查一次是不够的：删除成功那一刻库确实没了，但游戏那边晚一步的写/未释放的连接会把它写回来
         （回归测试 save-flow-test 的「抢写」用例复现过：查一次 remains=false，700ms 后库又回来了）。
         所以这里盯住一个稳定窗口，期间任何一次查到数据就再来一轮。 */
      let clean = true;
      const t0 = Date.now();
      while (Date.now() - t0 < SETTLE_MS) {
        await new Promise(function (r) { setTimeout(r, STEP_MS); });
        let still = false;
        try {
          if (window.__saveManager && window.__saveManager.hasSaveData) {
            still = !!(await window.__saveManager.hasSaveData(dbKey));
          }
        } catch (e) { still = false; }
        if (still) { clean = false; break; }
      }
      remains = !clean;
      if (clean) break;
    }
    if (remains) {
      /* 复查仍然查得到：把原因说清楚（多半是还有窗口/标签占着这个库） */
      toast('存档没删掉：还有窗口/标签正在占用该版本的存档库（游戏可能还开着）→ 关掉那个游戏窗口后重试', true);
      return { del: del, remains: true, stopped: closedGame, rounds: rounds };
    }
    return { del: del, remains: false, stopped: closedGame, rounds: rounds };
  }

  // v0.6.3：备份列表折叠状态持久化 key 前缀（localStorage；web/PC/安卓一致——重建卡片/切视图回来仍保持，
  // 根治「莫名来回展开收起」）
  const SLOTS_FOLD_PREFIX = 'mdz-slots-folded-';
  // v0.6.4：备份存在性缓存（卡片重建时同步决定初始折叠，不等 listSlots 异步返回 → 根治「来回展开收起」）；
  // 存档卡「无存档整卡收起」缓存（hasdata 是否有存档数据、open 用户是否手动展开过）
  const SLOTS_HAS_PREFIX = 'mdz-slots-has-';
  const SAVECARD_HAS_PREFIX = 'mdz-savecard-hasdata-';
  const SAVECARD_OPEN_PREFIX = 'mdz-savecard-open-';

  // ================= v0.6.62：存档管理 = 始终显示全部版本（含无存档）+ 分页 + 搜索 =================
  // （v0.6.61 曾改为「只显示有存档/备份的版本」，用户反馈安卓端存档全看不见 → 回退为全量显示；
  //   状态变量 SAVES_PAGE_SIZE/savesPage/savesQuery/saveScanCache/saveScanDirty/saveScanRun 已上移到文件顶部，
  //   防 init→renderSaveList 提前触达造成 TDZ）

  /** 后台补全：孤儿 dbKey 并入 + 备份槽存在性刷新（v0.6.70 起不再逐版本 hasSaveData——
   *  渲染与卡片自检已覆盖“有无存档”判定，扫描只承担孤儿发现与槽统计，避免每次进存档页把大库全量读一遍） */
  async function collectSaveScan() {
    const out = new Map();
    const sm = window.__saveManager;
    if (!sm) return out;
    const seen = new Set();
    let slotCounts = {};
    try { if (sm.slotDbKeyCounts) slotCounts = await sm.slotDbKeyCounts(); } catch (e) {}
    versions.forEach((v) => {
      // v1.0.45：noSave 内置版本不进入存档管理（其存档由游戏自带 mods 管，无启动器可管理的 IndexedDB 库）
      if (v.noSave) return;
      const dbKey = v.dbKey || ('version_' + v.id);
      seen.add(dbKey);
      out.set(dbKey, { v: v, orphan: false, hasData: false, hasSlots: !!slotCounts[dbKey] });
    });
    // 孤儿：已删除版本但保留存档/备份的 dbKey（v0.7.2）——始终显示
    try {
      if (sm.allDbKeysWithData) {
        const keys = await sm.allDbKeysWithData();
        for (const k of keys) {
          if (seen.has(k)) continue;
          seen.add(k);
          out.set(k, { v: { id: 'orphan_' + k, name: '（已删除版本）' + String(k).replace(/^version_/, ''), dbKey: k, _orphan: true }, orphan: true, hasData: true, hasSlots: !!slotCounts[k] });
        }
      }
    } catch (e) {}
    return out;
  }
  /** 按搜索规则展开的可见条目（保序：全部版本 + 孤儿） */
  function saveVisibleEntries() {
    const q = savesQuery.trim().toLowerCase();
    const out = [];
    if (!saveScanCache) return out;
    for (const [dbKey, rec] of saveScanCache) {
      if (q) {
        const hay = String(((rec.v && (rec.v.name || '')) || '') + ' ' + ((rec.v && (rec.v.id || '')) || '') + ' ' + ((rec.v && (rec.v.version)) || '') + ' ' + dbKey).toLowerCase();
        if (hay.indexOf(q) < 0) continue;
      }
      /* v1.0.32：把「当前存档和备份都删干净」的版本从存档管理里去掉（用户反馈：删完卡片还在）。
         安全网：只有 scanned===true（逐库查询成功过的才可信）且 hasData/hasSlots 都为假才隐藏；
         未确认（scanned 缺省/假，例如安卓上扫描异常、老 WebView）与孤儿卡一律照旧显示，
         避免重演 v0.6.61「只显示有数据的版本 → 安卓端存档全看不见」的回归。 */
      if (rec.scanned === true && !rec.hasData && !rec.hasSlots) continue;
      out.push({ dbKey: dbKey, rec: rec });
    }
    return out;
  }
  /** 同步绘制当前页（依赖扫描缓存已就绪） */
  async function drawSavePage() {
    const wrap = $('save-list');
    if (!wrap) return;
    if (!saveScanCache) { renderSaveList(); return; }
    const entries = saveVisibleEntries();
    if (!entries.length) {
      wrap.innerHTML = '<p class="muted empty-tip">' + (savesQuery ? '没有匹配的存档。' : '还没有版本。') + '</p>';
      const pg = $('save-pager'); if (pg) pg.classList.add('hidden');
      const ct = $('save-count'); if (ct) ct.textContent = '';
      return;
    }
    const pages = Math.max(1, Math.ceil(entries.length / SAVES_PAGE_SIZE));
    if (savesPage >= pages) savesPage = pages - 1;
    const drawTok = ++saveDrawTok;
    const slice = entries.slice(savesPage * SAVES_PAGE_SIZE, savesPage * SAVES_PAGE_SIZE + SAVES_PAGE_SIZE);
    // v0.6.71：预取当前页各卡备份槽 → 渲染时同步填充（防「备份子列表先塌着、数据回来才撑开」）
    const pref = new Map();
    const smd = window.__saveManager;
    try {
      await Promise.all(slice.map(async (it) => {
        try { if (smd && smd.listSlots) pref.set(it.dbKey, await smd.listSlots(it.dbKey)); } catch (e2) {}
      }));
    } catch (e2) {}
    if (drawTok !== saveDrawTok) return; // 并发翻页/搜索：丢弃过期绘制
    wrap.innerHTML = '';
    let failed = 0;
    for (const it of slice) {
      try {
        appendSaveCard(wrap, it.rec.v, it.rec.hasData, pref.get(it.dbKey)); // 第三参：确认有数据 → 跳过卡内重复 hasSaveData 检测（无数据卡仍渲染，自动折叠）
      } catch (e) { failed++; console.warn('[saves] card render skip:', e && e.message); }
    }
    if (failed === slice.length && slice.length > 0) {
      wrap.innerHTML = '<p class="muted empty-tip">存档卡片渲染失败，请反馈开发者。</p>';
      const pg2 = $('save-pager'); if (pg2) pg2.classList.add('hidden');
      const ct2 = $('save-count'); if (ct2) ct2.textContent = '';
      return;
    }
    renderSavePager(entries.length, pages);
    const ct = $('save-count');
    if (ct) ct.textContent = savesQuery ? (entries.length + ' 个匹配 / 共 ' + saveScanCache.size + ' 个版本') : (entries.length + ' 个版本');
    // v1.0.33/35/37（安卓专项）：渲染完成走动态链补绑静态工具（搜索过滤 / 折叠按钮）——安卓曾因顶层 null.onclick
    // 抛错跳过静态绑定段（v1.0.37 已修根因），此补绑仍保留作双保险
    try { bindSaveSearch(); } catch (e) {}
    try { ensureSaveToolsBound(); } catch (e) {}
    try { ensureSaveToolsPointer(); } catch (e) {}
    try { ensureSaveSearchDelegate(); } catch (e) {}
  }
  /** 翻页后把分页条就近带回视口（新页高度可能变化——防列表深处空白/跳动感） */
  function alignSavePager() {
    try { const el = $('save-pager'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }
  /** 存档页分页条（复用 .pager 样式） */
  function renderSavePager(total, pages) {
    let pg = $('save-pager');
    const wrap = $('save-list');
    if (!wrap) return;
    if (!pg) {
      pg = document.createElement('div');
      pg.id = 'save-pager';
      pg.className = 'pager';
      pg.innerHTML =
        '<button id="spg-prev" title="上一页">' + ico('chevronL') + '</button>' +
        '<span id="spg-info" class="pg-info"></span>' +
        '<button id="spg-next" title="下一页">' + ico('chevronR') + '</button>';
      wrap.after(pg);
      pg.querySelector('#spg-prev').onclick = async () => { if (savesPage > 0) { savesPage--; await drawSavePage(); alignSavePager(); } };
      pg.querySelector('#spg-next').onclick = async () => { if (savesPage < Math.max(1, Math.ceil(saveVisibleEntries().length / SAVES_PAGE_SIZE)) - 1) { savesPage++; await drawSavePage(); alignSavePager(); } };
    }
    pg.classList.toggle('hidden', pages <= 1);
    pg.querySelector('#spg-info').textContent = (savesPage + 1) + ' / ' + pages + '（共 ' + total + '）';
    pg.querySelector('#spg-prev').disabled = savesPage <= 0;
    pg.querySelector('#spg-next').disabled = savesPage >= pages - 1;
  }
  /** 存档搜索（输入实时过滤 + 回到第一页）。
   *  v0.6.70：加 change/search 事件 + 60ms 去抖——安卓 IME/软键盘某些输入法 input 事件不连续/延迟，
   *  失焦(change)与键盘搜索键/清除(search)也能触发过滤。
   *  v1.0.33（安卓专项）：抽为函数 + 幂等标志，除静态注册外每次进/渲染存档视图补绑一次——
   *  Android WebView 个别环境 launcher.js 中部静态段可能被早期异常跳过（实测搜索不过滤+折叠按钮无响应，
   *  而动态绑定的卡箭头/启动正常）→ 走「渲染后动态补绑」这条已验证可用的路径兜底 */
  let saveSearchBound = false;
  function bindSaveSearch() {
    try {
      if (saveSearchBound) return;
      const inp = $('save-search');
      if (!inp) return;
      let st = null;
      const apply = () => {
        clearTimeout(st);
        st = setTimeout(() => {
          savesQuery = inp.value;
          savesPage = 0;
          if (saveScanCache) drawSavePage(); else renderSaveList();
        }, 60);
      };
      inp.addEventListener('input', apply);
      inp.addEventListener('change', apply);
      inp.addEventListener('search', apply);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          clearTimeout(st);
          inp.value = '';
          savesQuery = '';
          savesPage = 0;
          if (saveScanCache) drawSavePage();
          inp.blur();
        }
      });
      saveSearchBound = true;
    } catch (e) { console.warn('[save-search] bind fail:', e && e.message); }
  }
  bindSaveSearch();
  // v1.0.35（安卓专项）：搜索过滤再加 document capture 委托通道（input/change/search 捕获阶段可达，
  // 元素直绑若失效仍有此兜底；与元素通道双处理幂等——每次各 60ms 去抖，最终一致）
  let saveSearchDelegateOn = false;
  function ensureSaveSearchDelegate() {
    if (saveSearchDelegateOn) return;
    try {
      saveSearchDelegateOn = true;
      let st = null;
      const applyFrom = (inp) => {
        clearTimeout(st);
        st = setTimeout(() => {
          if (!inp || inp.id !== 'save-search') return;
          savesQuery = inp.value;
          savesPage = 0;
          if (saveScanCache) drawSavePage(); else renderSaveList();
        }, 60);
      };
      document.addEventListener('input', (ev) => { const t = ev.target; if (t && t.id === 'save-search') applyFrom(t); }, true);
      document.addEventListener('change', (ev) => { const t = ev.target; if (t && t.id === 'save-search') applyFrom(t); }, true);
      document.addEventListener('search', (ev) => { const t = ev.target; if (t && t.id === 'save-search') applyFrom(t); }, true);
    } catch (e) {}
  }
  ensureSaveSearchDelegate();
  // v0.6.81：存档页「折叠全部 / 展开列表」——作用于全部 dbKey（跨页，写缓存），当前渲染页同步折叠/展开
  /** 折叠全部：所有存档卡 + 备份子列表全收（含手动展开过的、goto 目标）；写 open=0/slots-folded=1 缓存，翻页后任一侧保持一致收起 */
  function collapseAllSaveCards() {
    const keys = new Set();
    if (saveScanCache) saveScanCache.forEach((rec, k) => keys.add(k));
    for (const v of versions) keys.add(v.dbKey || ('version_' + v.id)); // 兜底：缓存未建也收齐
    keys.forEach((dbKey) => {
      try {
        localStorage.setItem(SAVECARD_OPEN_PREFIX + dbKey, '0');
        localStorage.setItem(SLOTS_FOLD_PREFIX + dbKey, '1');
      } catch (e) {}
    });
    document.querySelectorAll('#save-list .save-card').forEach((c) => {
      const body = c.querySelector('.save-card-body');
      if (body) { body.classList.add('hidden'); c.classList.remove('goto-focus'); }
      c.classList.add('collapsed');
      const sw = c.querySelector('.save-slots-wrap');
      if (sw) { sw.classList.add('folded'); sw.dataset.userSet = '1'; }
    });
    try { toast('已全部收起'); } catch (e) {}
  }
  /** 展开列表：只展开「有当前存档或有备份」的卡——有备份的卡连带展开备份子列表，无备份不展开子列表；无档无备份卡保持折叠。
   *  逐 dbKey 查询后写 open=1 / slots-folded=0 缓存（跨页），当前渲染页同步调整 */
  async function expandSaveCardsWithData() {
    const sm = window.__saveManager;
    const dbKeys = new Set();
    if (saveScanCache) saveScanCache.forEach((rec, k) => dbKeys.add(k));
    for (const v of versions) dbKeys.add(v.dbKey || ('version_' + v.id)); // 兜底：缓存未建也展开全部分
    document.querySelectorAll('#save-list .save-card').forEach((c) => { const k = c.dataset.dbkey; if (k) dbKeys.add(k); });
    const info = new Map();
    await Promise.all(Array.from(dbKeys).map(async (dbKey) => {
      let hasData = false, hasBackup = false;
      try { hasData = await sm.hasSaveData(dbKey); } catch (e) {}
      try { const slots = await sm.listSlots(dbKey); hasBackup = !!(slots && slots.length); } catch (e) {}
      info.set(dbKey, { hasData, hasBackup });
      if (!(hasData || hasBackup)) return;
      try {
        localStorage.setItem(SAVECARD_OPEN_PREFIX + dbKey, '1');
        if (hasBackup) localStorage.setItem(SLOTS_FOLD_PREFIX + dbKey, '0');
      } catch (e) {}
    }));
    document.querySelectorAll('#save-list .save-card').forEach((c) => {
      const it = info.get(c.dataset.dbkey || '');
      const body = c.querySelector('.save-card-body');
      if (!body || !it) return;
      if (it.hasData || it.hasBackup) {
        body.classList.remove('hidden');
        c.classList.remove('collapsed');
        const sw = c.querySelector('.save-slots-wrap');
        if (sw && it.hasBackup) { sw.classList.remove('folded'); sw.dataset.userSet = '1'; }
      }
    });
    toast('已展开有存档或有备份的版本');
  }
  // v0.7.1+ / v1.0.33（安卓专项）：折叠/展开按钮绑定抽为幂等 ensureSaveToolsBound——
  // 静态注册 + 每次进/渲染存档视图补绑（Android WebView 实测中部静态段可能被早期异常跳过，
  // 而渲染期动态绑定正常 → 借渲染路径补绑兜底）。触发通道：onclick 直绑 + document capture 委托
  // （click/pointerup）+ button touchend/pointerup 直绑，250ms 去重；collapse toast『已全部收起』；
  // window.__mdzSaveTools 供 chrome://inspect 手动调用。
  let saveToolsBound = false;
  function ensureSaveToolsBound() {
    if (saveToolsBound) return;
    try {
      const fireSaveTool = (which) => fireSaveToolGlobal(which); // v1.0.35：统一走模块级执行（去重/日志一致）
      const bindSaveTool = (id, which) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.onclick = () => fireSaveTool(which);
        btn.addEventListener('touchend', (e) => { e.preventDefault(); fireSaveTool(which); }, { passive: false });
        btn.addEventListener('pointerup', (e) => { e.preventDefault(); fireSaveTool(which); }, { passive: false });
        btn.addEventListener('pointerdown', () => { btn.dataset.pd = '1'; }, { passive: true });
      };
      bindSaveTool('btn-save-collapse', 'collapse');
      bindSaveTool('btn-save-expand', 'expand');
      // document capture 委托（click + pointerup 双通道；Pointer Events 在 Android WebView 更早分发）
      const saveToolDelegate = (ev) => {
        const t = ev.target;
        const hit = t && t.closest ? t.closest('#btn-save-collapse, #btn-save-expand') : null;
        if (!hit) return;
        const which = hit.id === 'btn-save-collapse' ? 'collapse' : 'expand';
        try { if (ev.cancelable) ev.preventDefault(); } catch (e) {}
        fireSaveTool(which);
      };
      document.addEventListener('click', saveToolDelegate, true);
      document.addEventListener('pointerup', saveToolDelegate, true);
      document.addEventListener('touchend', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('#btn-save-collapse, #btn-save-expand')) { try { e.preventDefault(); } catch (e2) {} }
      }, { capture: true, passive: false });
      window.__mdzSaveTools = { collapse: collapseAllSaveCards, expand: expandSaveCardsWithData };
      saveToolsBound = true;
    } catch (e) { console.warn('[save-tools] bind fail:', e && e.message); }
  }
  ensureSaveToolsBound();
  // v1.0.35（安卓专项）：模块级去重 + 直接执行（不依赖任何按钮绑定链是否成功）；
  // document 顶层 capture 的 pointerdown 在安卓可达 → 命中折叠/展开按钮时直接执行。
  let saveToolFireAt = 0;
  function fireSaveToolGlobal(which) {
    const now = Date.now();
    if (now - saveToolFireAt < 250) return; // 同一次物理点击多路触发 → 只跑一次
    saveToolFireAt = now;
    if (which === 'collapse') collapseAllSaveCards();
    else expandSaveCardsWithData();
  }
  function ensureSaveToolsPointer() {
    try {
      if (isAndroidEnv() && !window.__mdzSavePointerOn) {
        window.__mdzSavePointerOn = true;
        document.addEventListener('pointerdown', (ev) => {
          const t = ev.target;
          const hit = t && t.closest ? t.closest('#btn-save-collapse, #btn-save-expand') : null;
          if (!hit) return;
          fireSaveToolGlobal(hit.id === 'btn-save-collapse' ? 'collapse' : 'expand');
        }, true);
      }
    } catch (e) {}
  }
  /** 局部重查单个版本的存档状态并写回扫描缓存（删除/导入等操作后同步，不触发全量重扫） */
  async function refreshSaveRec(dbKey) {
    const sm = window.__saveManager;
    if (!saveScanCache || !sm) return;
    let hasData = false, hasSlots = false;
    let okData = false, okSlots = false;
    try { if (sm.hasSaveData) { hasData = await sm.hasSaveData(dbKey); okData = true; } } catch (e) {}
    try { const sl = await sm.listSlots(dbKey); hasSlots = !!(sl && sl.length); okSlots = true; } catch (e) {}
    /* v1.0.32（用户要求：删干净后卡片不该还在）：两个查询都成功 → 这次结果是**可信**的，
       打 scanned=true（saveVisibleEntries 只隐藏「可信且确认无数据无备份」的版本）。 */
    const scanned = okData && okSlots;
    let rec = saveScanCache.get(dbKey);
    if (!rec) {
      if (!(hasData || hasSlots)) return;
      const vv = versions.find((x) => (x.dbKey || ('version_' + x.id)) === dbKey);
      if (vv) saveScanCache.set(dbKey, { v: vv, orphan: false, hasData: hasData, hasSlots: hasSlots, scanned: scanned });
      return;
    }
    rec.hasData = hasData;
    rec.hasSlots = hasSlots;
    if (scanned) rec.scanned = true;
    else if (!rec.scanned) rec.scanned = false;
  }
  /** v0.6.61：进入存档视图。
   *  v0.6.68：不再整页重建——切走再切回时重建会让展开的卡/备份子列表「先收起再展开」（闪动）；
   *  卡片状态由局部维护（loadSlots 等）+ 后台 rescanSaves 保持；仅首次进入（缓存未建）或数据变更（dirty）才重建 */
  /** v0.6.78：退出 goto 定位态时，恢复被 goto 强折叠的卡（data-goto-folded）。
   *  按 localStorage 缓存判定各卡默认折叠态（HAS=1/OPEN=1 → 展开）——与整页重建的判定一致，
   *  避免「有存档的卡被 goto 折叠后一直保持折叠」（用户点击退出/超时/再次 goto 时调用） */
  function restoreGotoFolded() {
    document.querySelectorAll('#save-list .save-card[data-goto-folded="1"]').forEach((c) => {
      let open = false;
      try {
        const dbKey = c.dataset.dbkey || '';
        open = localStorage.getItem(SAVECARD_HAS_PREFIX + dbKey) === '1' ||
               localStorage.getItem(SAVECARD_OPEN_PREFIX + dbKey) === '1';
      } catch (e) {}
      if (open) {
        const b = c.querySelector('.save-card-body');
        if (b) { b.classList.remove('hidden'); c.classList.remove('collapsed'); }
      }
      delete c.dataset.gotoFolded;
    });
  }
  /** v0.6.77：清除「前往存档管理」一次性定位残留（高亮 + 点击监听 + 渲染模式标志）。
   *  rebuild=true 时整页重建——按缓存恢复各卡折叠态（正常导航进入存档页仍残留 goto 强折叠时用）；
   *  rebuild=false（用户点击/超时）时恢复被强折叠的卡 DOM */
  function clearGotoFocus(rebuild) {
    if (!rebuild) restoreGotoFolded();
    document.querySelectorAll('.save-card.goto-focus').forEach((x) => x.classList.remove('goto-focus'));
    if (window.__mdzGotoOffFn) { document.removeEventListener('click', window.__mdzGotoOffFn, true); window.__mdzGotoOffFn = null; }
    saveGotoTargetId = null;
    if (rebuild) { renderSaveList(true); }
  }
  /* ===== v1.0.1（PC）：存档传输页（「存档管理」下面的新页面）=====
     背景：直接装到手机上的游戏包（自己打包的 APK）没有启动器这套存档隔离/文件能力，
     没法导出存档；解法 = 游戏里注入 mdz-save-bridge.js（悬浮球）→ 填本页显示的地址 → 发送/接收。
     本页是**安卓独有**：PLAT.saveTransfer 由 android-adapter.js 提供，底层是 MainActivity 里
     SaveBridgeServer 的 HTTP 服务（接口与 PC 端 Node 版 mdz-save-service.js 完全一致），
     所以同一个游戏脚本既能发到 PC 启动器、也能发到这台手机上的启动器。
     侧边栏/视图切换完全走通用机制（data-view + .view），不自己接管 onclick——保证和其它按钮同步。 */
  const TR_PORT_KEY = 'mdz-transfer-port';
  const TR_TOKEN_KEY = 'mdz-transfer-token';

  function trApi() { return (PLAT && PLAT.saveTransfer) ? PLAT.saveTransfer : null; }
  function trLog(line) {
    const box = $('transfer-log');
    if (!box) return;
    const lines = ((box.textContent || '') + '\n' + line).split('\n').filter((x) => x !== '');
    box.textContent = lines.slice(-40).join('\n');
    box.scrollTop = box.scrollHeight;
  }
  /* v1.0.72：服务端日志统一入口 —— 顺便做「收到存档自动刷新」 */
  let trLastRefresh = 0;
  function trAutoRefresh() {
    if (Date.now() - trLastRefresh < 800) return;   // 防抖：一次上传可能带几行日志
    trLastRefresh = Date.now();
    try { trRefresh(); } catch (e) {}
  }
  const onSvcLog = (s) => { trLog('· ' + s); if (/收到存档/.test(String(s))) trAutoRefresh(); };
  window.__mdzSaveSvcLog = onSvcLog;   // 原生侧日志推送（主进程/前台服务 → 本页日志区）
  try { if (PLAT && PLAT.onTransferLog) PLAT.onTransferLog(onSvcLog); } catch (e) {}
  /* 兜底轮询：传输页可见时每 4s 轻量刷新（服务日志没推过来 / 服务在别的进程里时也能看到新存档） */
  setInterval(() => {
    try {
      const v = document.getElementById('view-transfer');
      if (!v || !v.classList.contains('active') || document.hidden) return;
      trAutoRefresh();
    } catch (e) {}
  }, 4000);

  function trPrefsLoad() {
    const p = $('transfer-port'), t = $('transfer-token');
    try { if (p && !p.value) p.value = localStorage.getItem(TR_PORT_KEY) || ''; } catch (e) {}
    try { if (t && !t.value) t.value = localStorage.getItem(TR_TOKEN_KEY) || ''; } catch (e) {}
  }
  function trPrefsSave() {
    try { localStorage.setItem(TR_PORT_KEY, String(($('transfer-port') || {}).value || '')); } catch (e) {}
    try { localStorage.setItem(TR_TOKEN_KEY, String(($('transfer-token') || {}).value || '')); } catch (e) {}
  }
  function trSize(n) {
    n = Number(n) || 0;
    return n < 1024 ? (n + 'B') : (n < 1048576 ? ((n / 1024).toFixed(1) + 'KB') : ((n / 1048576).toFixed(2) + 'MB'));
  }
  function trTime(ms) { try { return new Date(Number(ms) || Date.now()).toLocaleString(); } catch (e) { return ''; } }

  /** 进入「存档传输」页（nav 点击时调用，和存档页一样每次进来刷新） */
  function enterTransferView() {
    const api = trApi();
    if (!api) {
      if ($('transfer-state')) $('transfer-state').textContent = '此端不支持（存档服务是安卓启动器内置的）';
      ['btn-transfer-start', 'btn-transfer-stop', 'btn-transfer-refresh'].forEach((id) => { const b = $(id); if (b) b.disabled = true; });
      if ($('transfer-url')) $('transfer-url').textContent = '—';
      if ($('transfer-empty')) $('transfer-empty').textContent = '安卓启动器里才有这个页面。';
      return;
    }
    trPrefsLoad();
    trRefresh();
  }

  function trRefresh() {
    const api = trApi();
    if (!api) return;
    let st = {};
    try { st = api.status() || {}; } catch (e) { trLog('取状态失败: ' + (e && e.message || e)); }
    if (st.error) trLog('原生返回错误：' + st.error);
    if ($('transfer-state')) {
      $('transfer-state').textContent = st.running
        ? ('运行中 · 端口 ' + st.port + ' · ' + (st.saves || 0) + ' 份存档' + (st.fgService ? ' · 前台常驻（通知栏可停止）' : (PLAT.isPC ? ' · 启动器主进程常驻' : ' · 兜底模式（后台可能被系统冻结）')))
        : (st.error ? ('未启动（' + st.error + '）') : '未启动');
    }
    /* v1.0.67：连通情况——服务端真实收到的请求数。游戏那边说「连不上」时，看这里就能定位：
       计数不动 = 请求根本没到（游戏侧 WebView/明文拦、地址端口不对）；
       计数在涨但游戏端超时/无响应 = 服务进程被冻结（已改前台服务，正常不会再发生）。 */
    if ($('transfer-conn')) {
      const c = $('transfer-conn');
      if (st.running) {
        const n = Number(st.reqCount) || 0;
        if (n > 0) {
          c.textContent = '已收到 ' + n + ' 次请求 · 最近 ' + (st.lastReqAt ? trTime(st.lastReqAt) : '—') +
            (st.lastRequester ? ('（来自 ' + st.lastRequester + '）') : '') + (st.lastReq ? (' · ' + st.lastReq) : '');
          c.className = '';
        } else {
          c.textContent = '服务在跑，但还没收到过任何请求（游戏里点过「导出存档」后这里还是 0，就是请求没到）';
          c.className = 'muted';
        }
      } else {
        c.textContent = '—（先启动服务）';
        c.className = 'muted';
      }
    }
    if ($('transfer-url')) {
      if (st.running) {
        const tok = ($('transfer-token') || {}).value || '';
        trUrls.lan = String(st.primaryUrl || '');
        trUrls.local = 'http://127.0.0.1:' + st.port;
        /* v1.0.70：列出全部候选地址——自动挑的那个不一定对（多网卡/虚拟网卡），这里能直接换一个复制 */
        const others = (Array.isArray(st.urls) ? st.urls : []).filter((u) => u && u !== trUrls.lan && !/127\.0\.0\.1|localhost/.test(u));
        $('transfer-url').textContent = '局域网（别的手机/PC 用）：' + trUrls.lan + (st.tokenRequired && tok ? ('　配对码 ' + tok) : '') +
          '\n本机（游戏也在同一台设备上）：' + trUrls.local +
          (others.length ? ('\n其它可用地址：' + others.join('　')) : '');
      } else {
        trUrls.lan = ''; trUrls.local = '';
        $('transfer-url').textContent = '（先点上面的「启动服务」，这里会显示游戏里要填的地址）';
      }
    }
    const copyLan = $('btn-transfer-copy-lan'), copyLocal = $('btn-transfer-copy-local');
    if (copyLan) copyLan.disabled = !st.running;
    if (copyLocal) copyLocal.disabled = !st.running;
    if ($('btn-transfer-start')) $('btn-transfer-start').disabled = !!st.running;
    if ($('btn-transfer-stop')) $('btn-transfer-stop').disabled = !st.running;
    trRenderList();
  }

  /** 复制地址（游戏里粘贴用）：优先剪贴板 API，失败退回 textarea + execCommand */
  const trUrls = { lan: '', local: '' };
  function trCopy(which) {
    const url = which === 'local' ? trUrls.local : trUrls.lan;
    if (!url) { toast('先点「启动服务」', true); return; }
    const done = () => toast('已复制：' + url);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, () => trCopyFallback(url, done));
        return;
      }
    } catch (e) {}
    trCopyFallback(url, done);
  }
  function trCopyFallback(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) done(); else toast('复制失败，请长按上面的地址手动复制', true);
    } catch (e) { toast('复制失败：' + (e && e.message || e), true); }
  }

  /* v1.0.68：传输列表 = 「存档管理」的备份子列表同款（.slot-row）；
     按钮只要 导出 / 导入（图标+文字）、删除（只图标）——「导入到哪个版本」改由弹窗选，行里不再塞 select。 */
  /* v1.0.70：传输列表 = 「存档管理」的**单个存档卡**结构：
     父级栏（.save-card-bar）放标题 + 刷新/自检，子列表（.save-slots）放收到的存档行（.slot-row）。
     用户要求：「弄成和存档管理页面单个存档卡片一样的，父级内容里放刷新和自检，然后子目录放存档」。 */
  function trRenderList() {
    const api = trApi();
    const wrap = $('transfer-list');
    if (!wrap) return;
    let list = [];
    try { list = api.list() || []; } catch (e) { trLog('取列表失败: ' + (e && e.message || e)); }
    wrap.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'card save-card';
    card.innerHTML =
      '<div class="save-card-bar">' +
      '  <div class="save-card-title"><div class="avatar">' + ico('import') + '</div>' +
      '    <div class="save-card-names"><h3>收到的存档</h3><span class="badge">' + (list.length ? (list.length + ' 份') : '暂无') + '</span></div>' +
      '  </div>' +
      '  <div class="save-card-tools">' +
      '    <button class="icon-btn with-txt" id="btn-transfer-refresh" title="重新读取服务端存档目录">' + ico('refresh') + '<span>刷新</span></button>' +
      '    <button class="icon-btn with-txt" id="btn-transfer-selftest" title="从启动器自己的 WebView 访问本机服务（区分「服务没起来」和「游戏那边被拦」）">' + ico('keyboard') + '<span>自检</span></button>' +
      '  </div>' +
      '</div>' +
      '<div class="save-card-body"><div class="save-slots-wrap">' +
      '  <div class="save-block-head"><span class="save-block-title">存档文件</span>' +
      '    <span class="muted">导出 / 导入 / 删除</span></div>' +
      '  <div class="save-slots" id="transfer-slots"></div>' +
      '</div></div>';
    wrap.appendChild(card);
    const box = card.querySelector('#transfer-slots');
    if (!list.length) {
      box.innerHTML = '<p class="muted slots-empty">还没有收到存档。游戏里存一次档，再用游戏里的「存档桥」点「导出存档」。</p>';
    }
    list.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'slot-row';
      row.dataset.id = item.id;
      row.dataset.name = item.name || item.id;
      row.innerHTML =
        '<div class="slot-info"><span class="slot-name">' + esc(item.name || item.id) + '</span>' +
        '<span class="muted">' + trTime(item.at) + ' · ' + trSize(item.bytes) + (item.summary ? (' · ' + esc(item.summary)) : '') + '</span></div>' +
        '<div class="slot-btns">' +
        '<button class="slot-txt" data-act="export" title="导出为 JSON 文件">' + ico('export') + '<span>导出</span></button>' +
        '<button class="slot-txt" data-act="import" title="导入到某个版本">' + ico('import') + '<span>导入</span></button>' +
        '<button class="slot-del" data-act="delete" title="删除这份存档">' + ico('trash') + '</button>' +
        '</div>';
      box.appendChild(row);
    });
    const rb = card.querySelector('#btn-transfer-refresh');
    if (rb) rb.onclick = () => { trLog('刷新列表…'); trRefresh(); };
    const sb = card.querySelector('#btn-transfer-selftest');
    if (sb) sb.onclick = () => trSelfTest();
    if ($('transfer-empty')) $('transfer-empty').classList.add('hidden');
  }

  /* v1.0.70：自检服务——从**启动器自己的 WebView** 访问本机服务（原来写死在按钮里，现在按钮在卡片里动态生成） */
  function trSelfTest() {
    const api = trApi();
    const st = (api && api.status()) || {};
    if (!st.running) { toast('服务没启动，先点「启动服务」', true); trLog('自检：服务未启动，先点「启动服务」'); return; }
    const url = 'http://127.0.0.1:' + st.port + '/health';
    trLog('自检：从启动器访问 ' + url + ' …');
    try {
      const x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.timeout = 5000;
      x.onreadystatechange = () => {
        if (x.readyState !== 4) return;
        if (x.status === 200) {
          let info2 = {};
          try { info2 = JSON.parse(x.responseText); } catch (e) {}
          toast('服务正常：存档 ' + (info2.saves || 0) + ' 份');
          trLog('自检成功 ✓ 服务端 ' + (info2.primaryUrl || '') + ' · 存档 ' + (info2.saves || 0) +
            ' 份（服务本身没问题 → 游戏连不上就是那个游戏 APK 的 WebView/明文策略问题）');
        } else {
          toast('自检失败 HTTP ' + x.status, true);
          trLog('自检失败 HTTP ' + x.status, 'err');
        }
      };
      x.onerror = () => { toast('自检失败：连不上本机服务', true); trLog('自检失败：连不上（服务刚停？或系统拦了明文）', 'err'); };
      x.ontimeout = () => { toast('自检超时', true); trLog('自检超时', 'err'); };
      x.send();
    } catch (e) { toast('自检异常：' + (e && e.message || e), true); trLog('自检异常：' + (e && e.message || e), 'err'); }
  }

  /** v1.0.68：导入前弹窗选版本（复用配置弹窗那套 .config-dialog/.config-box/.cd-* 样式）
   *  v1.0.70：上一版重写传输列表时把本函数误删（点「导入」报 openVersionPicker is not defined），此轮补回。 */
  function ensurePickDialog() {
    let dlg = document.getElementById('mdz-pick-dialog');
    if (dlg) return dlg;
    dlg = document.createElement('div');
    dlg.id = 'mdz-pick-dialog';
    dlg.className = 'config-dialog hidden';
    dlg.innerHTML =
      '<div class="config-box">' +
      '<div class="cd-head"><h4 class="cd-title"></h4><button class="cd-close" title="关闭">✕</button></div>' +
      '<div class="cd-body"></div>' +
      '</div>';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.classList.add('hidden'); });
    dlg.querySelector('.cd-close').onclick = () => dlg.classList.add('hidden');
    return dlg;
  }
  function openVersionPicker(titleText, onPick) {
    const dlg = ensurePickDialog();
    dlg.querySelector('.cd-title').textContent = titleText;
    const body = dlg.querySelector('.cd-body');
    body.innerHTML = '';
    if (!versions.length) {
      body.innerHTML = '<p class="muted">还没有版本。先去「游戏启动」添加或下载一个游戏版本。</p>';
    } else {
      versions.forEach((v) => {
        const b = document.createElement('button');
        b.className = 'pk-item';
        b.innerHTML = '<span class="slot-name">' + esc(v.name || v.id) + '</span>' +
          '<span class="muted">' + esc(dbKeyOf(v)) + (v.version ? (' · ' + esc(String(v.version).replace(/^v/i, 'v'))) : '') + '</span>';
        b.onclick = () => { dlg.classList.add('hidden'); onPick(dbKeyOf(v), v); };
        body.appendChild(b);
      });
    }
    dlg.classList.remove('hidden');
  }

  function trGetText(id) {
    const api = trApi();
    const r = api.get(id) || {};
    if (!r.ok || !r.json) { toast('取存档失败: ' + (r.error || '未知错误'), true); return null; }
    return r.json;
  }
  async function trImport(id, dbKey) {
    const text = trGetText(id);
    if (!text) return;
    const v = versions.find((x) => dbKeyOf(x) === dbKey);
    const name = (v && (v.name || v.id)) || dbKey;
    if (!window.confirm('把这份存档写入「' + name + '」？\n该版本当前存档会被它覆盖（备份槽不受影响）。')) return;
    /* v1.0.68：写存档前先让游戏停下来（存档读写铁律）——游戏运行中会把导入的数据覆盖回去 */
    try { if (await ensureNoGameForSave()) toast('已先关闭正在运行的游戏，再导入存档'); } catch (e) {}
    window.__saveManager.importVersion(dbKey, text).then((res) => {
      saveScanDirty = true;   // 存档数据变了，下次进存档页重扫
      toast('已导入到「' + name + '」：恢复 ' + res.restored + ' 条' + (res.c2Count ? ('（其中进度 ' + res.c2Count + ' 条）') : ''));
    }).catch((e) => toast('导入失败: ' + (e && e.message || e), true));
  }

  (function trWire() {
    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    on('btn-transfer-start', () => {
      const api = trApi();
      if (!api) return;
      trPrefsSave();
      trLog('启动服务…');
      const st = api.start(($('transfer-port') || {}).value || '', ($('transfer-token') || {}).value || '') || {};
      trLog(st.ok === false ? ('启动失败: ' + (st.error || '未知')) : ('服务已启动 → ' + (st.primaryUrl || '')));
      trRefresh();
    });
    on('btn-transfer-stop', () => { const api = trApi(); if (!api) return; api.stop(); trLog('服务已停止'); trRefresh(); });
    on('btn-transfer-copy-lan', () => trCopy('lan'));
    on('btn-transfer-copy-local', () => trCopy('local'));
    // 返回启动器：直接点侧边栏的「游戏启动」按钮——复用同一套切换逻辑，保证 active 状态同步
    on('btn-transfer-back', () => {
      const nav = document.querySelector('.nav-item[data-view="versions"]');
      if (nav) nav.click();
    });
    const wrap = $('transfer-list');
    if (wrap) {
      wrap.onclick = (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
        if (!btn) return;
        const row = btn.closest('.slot-row');
        const id = row && row.dataset.id;
        const act = btn.getAttribute('data-act');
        if (!id || !trApi()) return;
        if (act === 'delete') {
          if (!window.confirm('删除这份传输存档？\n（服务器存档目录里的那份会被删掉；已导出到文件的副本不受影响）')) return;
          trApi().remove(id);
          trLog('已删除 ' + id);
          trRefresh();
        } else if (act === 'export') {
          const text = trGetText(id);
          if (!text) return;
          const api = trApi();
          if (api.exportText) { if (api.exportText(id + '.json', text)) trLog('已导出文件：' + id + '.json'); }
          else toast('此端不支持导出文件', true);
        } else if (act === 'import') {
          /* v1.0.68：先在弹窗里选「导入到哪个版本」，再确认覆盖 */
          const nm = (row && row.dataset.name) || id;
          openVersionPicker('把「' + nm + '」导入到哪个版本？', (dbKey) => trImport(id, dbKey));
        }
      };
    }
  })();

  function enterSavesView() {
    // v0.6.77：正常（侧边栏导航）进入存档视图——「前往」的一次性定位态不应残留：
    // 若上次 goto 的高亮/强折叠还在（用户未在存档页点击而离开过），先清理并重建恢复正常展示
    if (saveGotoTargetId || window.__mdzGotoOffFn) { clearGotoFocus(true); return; }
    if (!saveScanCache) { renderSaveList(); return; }
    if (saveScanDirty) { saveScanDirty = false; renderSaveList(true); return; }
    // v1.0.33/35（安卓专项）：进入存档视图动态补绑静态工具（防中部静态段被早期异常跳过）
    try { bindSaveSearch(); } catch (e) {}
    try { ensureSaveToolsBound(); } catch (e) {}
    try { ensureSaveToolsPointer(); } catch (e) {}
    try { ensureSaveSearchDelegate(); } catch (e) {}
    rescanSaves();
  }
  /** 后台重扫：孤儿 dbKey 并入 + 刷新 hasData/hasSlots（写回缓存，供重建卡片初始折叠态）。
   *  渲染不依赖它——全部版本卡同步渲染（v0.6.64：安卓老 WebView 扫描异常也不能让存档页空白） */
  function rescanSaves() {
    if (saveScanRun || !saveScanCache) return; // 已在扫
    saveScanRun = collectSaveScan()
      .then((fresh) => {
        if (!fresh || !saveScanCache) return;
        let orphanChanged = false;
        for (const [k, rec] of fresh) {
          const old = saveScanCache.get(k);
          if (old) {
            old.hasSlots = rec.hasSlots;
            if (rec.hasData) old.hasData = true; // v0.6.70：hasData 只升不降（不覆盖 false）
            /* 孤儿以本轮扫描为准（它由 allDbKeysWithData 生成，有数据才会出现在 fresh 里） */
            if (rec.orphan) { old.hasData = rec.hasData; old.scanned = true; }
          } else { saveScanCache.set(k, rec); orphanChanged = true; }
        }
        /* v1.0.33（用户澄清：版本删了、存档也删了，存档管理页就不该再有那张卡）：
           孤儿记录本轮不在 fresh 里 → 说明它的存档/备份已经没了 → 从缓存移除（正常版本一律保留）。 */
        for (const [k, rec] of Array.from(saveScanCache)) {
          if (rec.orphan && !fresh.has(k)) { saveScanCache.delete(k); orphanChanged = true; }
        }
        saveScanDirty = false;
        if (orphanChanged) drawSavePage(); // 孤儿出现 → 重绘纳入
      })
      .catch(() => {})
      .then(() => { saveScanRun = null; });
  }
  /** 重渲染存档页（v0.6.64：同步出卡，不等待扫描）。
   *  立即以「全部版本」构建缓存并绘制 → 无任何 IndexedDB 异步依赖，任何环境下版本卡都可见；
   *  force=true 强制重建缓存（refresh/删除版本后）；孤儿由后台 rescanSaves 并入 */
  async function renderSaveList(force) {
    const wrap = $('save-list');
    if (!wrap) return;
    if (!saveScanCache || force) {
      saveScanCache = new Map();
      for (const v of versions) {
        // v0.7.3：noSave 版本（minidayz-pc 等——存档在 localStorage 由游戏自带 mods 管，
        // 无启动器可管理的 IndexedDB 库）不进入存档管理视图（renderSaveList 初始缓存与
        // collectSaveScan 后台扫描口径一致）
        if (v.noSave) continue;
        const dbKey = v.dbKey || ('version_' + v.id);
        saveScanCache.set(dbKey, { v: v, orphan: false, hasData: false, hasSlots: false });
      }
      saveScanDirty = false;
    }
    drawSavePage();
    rescanSaves();
  }
  /** v0.7.2：渲染单个存档卡片（当前版本 / 已删除但保留存档的孤儿 dbKey 共用）；el.id 供配置弹窗跳转定位
   *  v0.6.61：knownHasData=true → 扫描已确认有数据，跳过卡内重复 hasSaveData 异步检测（省一次库内遍历） */
  function appendSaveCard(wrap, v, knownHasData, preSlots) {
      const el = document.createElement('div');
      el.className = 'card save-card';
      el.id = 'save-card-' + String(v.id).replace(/[^\w\u4e00-\u9fa5-]/g, '_');
      const cur = resFor(v.id);
      const dbKey = v.dbKey || ('version_' + v.id);
      el.dataset.dbkey = dbKey; // v0.6.78：供 goto 退出恢复时按缓存判折叠态
      // v0.5.3：上下布局——亮顶栏（图标+名称/id+折叠开关+垃圾桶）；暗内容块（当前存档按钮排 + 存档备份列表）
      el.innerHTML =
        '<div class="save-card-bar">' +
        '  <div class="save-card-title">' +
        '    <div class="avatar">' + ico('save') + '</div>' +
        '    <div class="save-card-names"><h3>' + esc(v.name || v.id) + '</h3><span class="badge">' + esc(v.id) + '</span></div>' +
        '  </div>' +
        '  <div class="save-card-tools">' +
        '    <button class="icon-btn act-del-saves" title="删除该版本全部存档">' + ico('trash') + '</button>' +
        '    <button class="icon-btn act-toggle" title="折叠/展开">' + ico('chevronR') + '</button>' +
        '  </div>' +
        '</div>' +
        '<div class="save-card-body">' +
        '  <div class="save-current">' +
        '    <div class="save-block-head"><span class="save-block-title">当前存档</span>' +
        '      <span class="muted">dbKey: ' + esc(dbKey) + ' · 分辨率 ' + cur.w + '×' + cur.h + '</span></div>' +
        '    <div class="actions">' +
        '      <button class="primary act-export">' + ico('export') + '<span>导出存档</span></button>' +
        '      <button class="act-import">' + ico('import') + '<span>导入存档</span></button>' +
        '      <button class="act-backup">' + ico('save') + '<span>备份当前存档</span></button>' +
        '    </div>' +
        '  </div>' +
        '  <div class="save-slots-wrap">' +
        '    <div class="save-block-head slots-head">' +
        '      <button class="icon-btn slot-fold" title="折叠/展开备份列表">' + ico('chevronR') + '</button>' +
        '      <span class="save-block-title">存档备份</span>' +
        '    </div>' +
        '    <div class="save-slots"></div>' +
        '  </div>' +
        '</div>';
      // 折叠开关（默认展开；收起时内容隐藏、箭头回转）
      // v0.6.4：用户手动展开过 → 无存档时也不再自动收起（记录持久化，防切后台回来又被收起）
      const toggle = el.querySelector('.act-toggle');
      toggle.onclick = () => {
        const hidden = el.querySelector('.save-card-body').classList.toggle('hidden');
        el.classList.toggle('collapsed', hidden);
        el.dataset.userCardOpen = '1';
        try { localStorage.setItem(SAVECARD_OPEN_PREFIX + dbKey, hidden ? '0' : '1'); } catch (e) {}
      };
      // v0.5.4：备份列表单独折叠（v0.6.2：记录用户手动状态，loadSlots 不再覆盖）
      // v0.6.3：折叠状态写入 localStorage——切视图/重建卡片后仍保持
      el.querySelector('.slots-head').onclick = () => {
        const w = el.querySelector('.save-slots-wrap');
        w.classList.toggle('folded');
        w.dataset.userSet = '1';
        try { localStorage.setItem(SLOTS_FOLD_PREFIX + dbKey, w.classList.contains('folded') ? '1' : '0'); } catch (e) {}
      };
      el.querySelector('.act-export').onclick = () => doExport(v);
      el.querySelector('.act-import').onclick = () => doImport(v);
      // 删除该版本全部存档（顶栏垃圾桶图标）
      // v0.6.23：先关游戏（防 IndexedDB 连接阻塞删除）+ 删除后复查
      // v0.6.24：只删当前存档保留备份——删除后仍有备份 → 保持展开显示备份（可恢复）；无备份 → 整卡收起
      el.querySelector('.act-del-saves').onclick = async () => {
        if (!confirm('确定删除版本「' + (v.name || v.id) + '」的当前存档？（备份会保留）')) return;
        try {
          const r = await deleteSavesGuarded(dbKey);
          if (r.stopped) toast('已先关闭正在运行的游戏，再删除存档'); // v1.0.26：让「删存档会先关游戏」可见
          if (r.remains) { loadSlots(el, dbKey); return; } // 未删净：保留状态让用户看到提示
          toast('已删除当前存档（备份已保留）');
          try { localStorage.setItem(SAVECARD_HAS_PREFIX + dbKey, '0'); } catch (e2) {}
          await refreshSaveRec(dbKey); // v0.6.61：同步扫描缓存（卡折叠态据此恢复）
          const rec = saveScanCache && saveScanCache.get(dbKey);
          let hasBackup = rec ? rec.hasSlots : false;
          if (!hasBackup) {
            try {
              const slots = await window.__saveManager.listSlots(dbKey);
              hasBackup = !!(slots && slots.length);
            } catch (e) {}
          }
          if (!hasBackup) {
            /* v1.0.32：逐库查询确认过（rec.scanned）且确实既无当前存档也无备份 → 整卡重绘掉（用户要求：删干净卡片不该还在） */
            const recNow = saveScanCache && saveScanCache.get(dbKey);
            if (recNow && recNow.scanned === true && !recNow.hasData && !recNow.hasSlots) { try { drawSavePage(); return; } catch (e5) {} }
            const bodyEl = el.querySelector('.save-card-body');
            if (bodyEl && !el.dataset.userCardOpen) {
              bodyEl.classList.add('hidden');
              el.classList.add('collapsed');
            }
          }
          loadSlots(el, dbKey);
        } catch (e) { toast('删除存档失败: ' + e.message, true); }
      };
      // 备份当前存档到新槽（v0.6.1：自动命名「备份_<id>_<时间到分钟>」；备份后只局部刷新槽列表——防整卡重建折叠闪动）
      el.querySelector('.act-backup').onclick = async () => {
        try {
          /* v1.0.25：备份当前存档前先停游戏（运行中备份会抓到写了一半的数据） */
          if (await ensureNoGameForSave()) toast('已先关闭正在运行的游戏，再备份存档');
          const name = await window.__saveManager.nextSlotName(dbKey);
          const r = await window.__saveManager.createSlot(dbKey, name);
          toast('已备份当前存档到「' + name + '」（' + r.count + ' 条记录）');
          const rec = saveScanCache && saveScanCache.get(dbKey);
          if (rec) { rec.hasSlots = true; rec.hasData = true; } // v0.6.61：同步扫描缓存（备份/存档存在）
          loadSlots(el, dbKey);
        } catch (e) { toast('备份失败: ' + e.message, true); }
      };
      // v0.6.81：折叠初始定态（同步一次到位，消除翻页/重建时的「展开再收起」中间帧）——
      // 优先级：goto 定位（目标展开 / 其他折叠）> 显式收起 openCached='0'（单卡箭头/折叠全部，含备份全收）
      // > 缓存确证（无档 + 无备份 → 折叠；有档或预取/缓存知有备份 → 展开）> 未知（先展开，correctFold 异步纠正）
      const bodyEl = el.querySelector('.save-card-body');
      let hasDataCached = null, openCached = null, slotsCached = null;
      try {
        hasDataCached = localStorage.getItem(SAVECARD_HAS_PREFIX + dbKey);
        openCached = localStorage.getItem(SAVECARD_OPEN_PREFIX + dbKey);
        slotsCached = localStorage.getItem(SLOTS_HAS_PREFIX + dbKey);
      } catch (e) {}
      // v0.6.66：把缓存中的「用户手动展开过」同步到 dataset——异步「无存档自动收起」检测尊重它
      if (openCached === '1') el.dataset.userCardOpen = '1';
      // v0.6.76：goto「前往存档管理」定位模式——目标卡视为用户展开过（初始不收起、异步检测不收起）；
      // 其余卡渲染即折叠（终端态，不再出现「先展开、定位后再收起」的闪动）
      if (saveGotoTargetId === el.id) {
        el.dataset.userCardOpen = '1';
      } else if (saveGotoTargetId) {
        el.dataset.gotoFolded = '1'; // v0.6.78：标记被 goto 强折叠 → 退出 goto 时按缓存恢复
        bodyEl.classList.add('hidden');
        el.classList.add('collapsed');
      } else {
        const userClosed = openCached === '0';
        const knownNoData = hasDataCached === '0';
        const knownSlots = !!(preSlots && preSlots.length) || slotsCached === '1';
        let initFold = false;
        if (userClosed) initFold = true;                       // 显式收起：含备份也收
        else if (knownNoData && !knownSlots) initFold = true;  // 缓存确证无档且无备份 → 默认折叠
        if (initFold) {
          bodyEl.classList.add('hidden');
          el.classList.add('collapsed');
        }
      }
      // 存档备份列表（v0.6.1 重构：局部刷新函数——备份/删除/重命名后只更新本卡片槽列表，不重建整卡）
      loadSlots(el, dbKey, preSlots);
      wrap.appendChild(el);
      // v0.6.77：goto 目标卡——入树前带高亮（首帧即有选中框，不再等轮询补加 = 无「框闪一下」）+ 槽列表展开
      // （放 loadSlots 之后，防缓存折叠态把槽列表又收回去）
      if (saveGotoTargetId === el.id) {
        el.classList.add('goto-focus');
        const sw = el.querySelector('.save-slots-wrap');
        if (sw) { sw.classList.remove('folded'); sw.dataset.userSet = '1'; }
      }
      // v0.6.79：检测实际数据后「纠正」折叠态（修正陈旧 HAS 缓存导致的误折叠）：
      // - 有当前存档 或 有备份槽 → 展开（备份可见可恢复，v0.6.24 语义；用户手动收起 openCached='0' 除外）
      // - 无存档无备份 → 折叠（无档默认收起）
      // 用户手动展开（userCardOpen）尊重不动；goto 定位会话内不干预非目标卡折叠（goto 管理，退出时 restoreGotoFolded 恢复）
      const correctFold = (hasData) => {
        const be = el.querySelector('.save-card-body');
        if (!be || el.dataset.userCardOpen) return;
        if (saveGotoTargetId && el.id !== saveGotoTargetId) return;
        const reveal = () => { be.classList.remove('hidden'); el.classList.remove('collapsed'); };
        const hide = () => { be.classList.add('hidden'); el.classList.add('collapsed'); };
        const userClosed = openCached === '0';
        const finish = (hasBackup) => {
          if (userClosed) { hide(); return; }
          if (hasData || hasBackup) reveal();
          else hide();
        };
        if (hasData) { finish(false); return; }
        window.__saveManager.listSlots(dbKey).then((slots) => finish(!!(slots && slots.length))).catch(() => {});
      };
      if (knownHasData) {
        try { localStorage.setItem(SAVECARD_HAS_PREFIX + dbKey, '1'); } catch (e2) {}
        correctFold(true);
      } else if (window.__saveManager && window.__saveManager.hasSaveData) {
        window.__saveManager.hasSaveData(dbKey).then((hasData) => {
          try { localStorage.setItem(SAVECARD_HAS_PREFIX + dbKey, hasData ? '1' : '0'); } catch (e2) {}
          correctFold(hasData);
        }).catch(() => {});
      }
    }
  /** 渲染单个存档卡片的备份槽列表；无备份时默认折叠（用户手动折叠/展开状态持久化，不覆盖） */
  function loadSlots(cardEl, dbKey, preSlots) {
    const slotsBox = cardEl.querySelector('.save-slots');
    if (!slotsBox || !window.__saveManager || !window.__saveManager.listSlots) return;
    const wrap = cardEl.querySelector('.save-slots-wrap');
    // v0.6.4：备份存在性缓存——卡片重建时同步决定初始折叠（不等 listSlots 异步返回，
    // 根治「切后台回来备份列表来回展开收起」：listSlots 返回前先按缓存定态，不再先展开后收起/收起后展开）
    let has = null;
    try { has = localStorage.getItem(SLOTS_HAS_PREFIX + dbKey); } catch (e) {}
    if (has !== null && !wrap.dataset.userSet) {
      if (has === '0') wrap.classList.add('folded'); else wrap.classList.remove('folded');
    }
    // v0.6.3：再恢复持久化的折叠状态（用户手动折叠/展开过 → 以用户为准）
    let saved = null;
    try { saved = localStorage.getItem(SLOTS_FOLD_PREFIX + dbKey); } catch (e) {}
    if (saved !== null) {
      if (saved === '1') wrap.classList.add('folded'); else wrap.classList.remove('folded');
      wrap.dataset.userSet = '1';
    }
    const fill = (slots) => { // v0.6.71：loadSlots 支持 preSlots（预取同步填充，防备份子列表「先塌后撑」）
      // v0.6.4：回写备份存在性缓存（供下次重建同步恢复）
      try { localStorage.setItem(SLOTS_HAS_PREFIX + dbKey, slots.length ? '1' : '0'); } catch (e) {}
      slotsBox.innerHTML = '';
      // v0.6.1：无备份时默认折叠；v0.6.2：用户手动折叠/展开后 loadSlots 不覆盖（防莫名来回展开收起）
      if (!slots.length) {
        slotsBox.innerHTML = '<p class="muted slots-empty">暂无备份（点击上方「备份当前存档」创建）</p>'; // v0.6.3：展开时显示空状态文案
        if (wrap && !wrap.dataset.userSet) wrap.classList.add('folded');
        return;
      }
      if (wrap && !wrap.dataset.userSet) wrap.classList.remove('folded');
      for (const s of slots) {
        const row = document.createElement('div');
        row.className = 'slot-row';
        const kb = s.size > 1024 * 1024 ? (s.size / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(s.size / 1024)) + ' KB';
        row.innerHTML =
          '<div class="slot-info"><span class="slot-name">' + esc(s.name) + '</span>' +
          '<span class="muted">' + new Date(s.created).toLocaleString() + ' · ' + kb + ' · ' + (s.count || 0) + ' 条</span></div>' +
          '<div class="slot-btns">' +
          '<button class="slot-export" title="导出此存档为 JSON 文件">' + ico('export') + '</button>' +
          '<button class="slot-import" title="导入此存档到当前存档（覆盖）">' + ico('import') + '</button>' +
          '<button class="slot-rename" title="重命名此存档">' + ico('list') + '</button>' +
          '<button class="slot-del" title="删除此存档">' + ico('trash') + '</button>' +
          '</div>';
        // 导出该槽
        row.querySelector('.slot-export').onclick = async () => {
          try {
            const rec = await window.__saveManager.getSlot(dbKey, s.name);
            if (!rec || !rec.data) { toast('备份不存在', true); return; }
            const backup = rec.data;
            const v = window.__webApp && window.__webApp.getVersions ? window.__webApp.getVersions().find((x) => (x.dbKey || ('version_' + x.id)) === dbKey) : null;
            // v0.6.59：导出文件名 = 备份备注（槽名）——三端一致；非法字符清理
            const fileName = String(s.name).replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || ('mdz-save_' + String(dbKey).replace(/^version_/, ''));
            if (PLAT.saveExport) { await PLAT.saveExport(backup, v, fileName + '.json'); return; } // 安卓：写文件
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            // v1.0.1：统一下载封装（受限内置浏览器 a.download 可能无效）
            downloadBlob(blob, fileName + '.json', '已导出备份「' + s.name + '」');
          } catch (e) { toast('导出失败: ' + e.message, true); }
        };
        // 导入（恢复）该槽到当前存档
        row.querySelector('.slot-import').onclick = async () => {
          if (!confirm('将备份「' + s.name + '」导入到当前存档？（当前存档将被覆盖）')) return;
          // v0.6.37：先关游戏（同 doImport——游戏运行中自动保存会覆盖导入的数据）
          // v1.0.25：统一走 ensureNoGameForSave（页面内播放 + 「新窗口」里的游戏都算"在跑"）
          const needClose = await ensureNoGameForSave();
          if (needClose) toast('游戏运行中，已先关闭游戏再导入…');
          try {
            await window.__saveManager.restoreSlot(dbKey, s.name);
            toast('已导入「' + s.name + '」到当前存档' + (needClose ? '（已关闭游戏，重新打开生效）' : ''));
            /* v1.0.26：复查是否真的写进去了 */
            try {
              if (window.__saveManager.hasSaveData) {
                window.__saveManager.hasSaveData(dbKey).then(function (hasNow) {
                  if (!hasNow) toast('导入没有真正生效：还有窗口/标签占用该版本存档库（游戏还开着）→ 关掉游戏窗口后重试', true);
                }).catch(function () {});
              }
            } catch (e) {}
          }
          catch (e) { toast('导入失败: ' + e.message, true); }
        };
        // v0.6.1：重命名（行内编辑，回车/失焦确认、Esc 取消——三端一致，不依赖 prompt）
        row.querySelector('.slot-rename').onclick = () => {
          const info = row.querySelector('.slot-info');
          const input = document.createElement('input');
          input.className = 'slot-rename-input';
          input.value = s.name;
          const commit = async (save) => {
            const nn = input.value.trim();
            if (save && nn && nn !== s.name) {
              try {
                await window.__saveManager.renameSlot(dbKey, s.name, nn);
                toast('已重命名为「' + nn + '」');
              } catch (e) { toast('重命名失败: ' + e.message, true); }
            }
            loadSlots(cardEl, dbKey);
          };
          input.onkeydown = (e) => {
            if (e.key === 'Enter') commit(true);
            else if (e.key === 'Escape') commit(false);
          };
          input.onblur = () => commit(true);
          info.replaceChildren(input);
          input.focus();
          input.select();
        };
        // 删除该槽（局部刷新；v0.6.62：卡始终显示——无备份/存档时整卡自动折叠）
        row.querySelector('.slot-del').onclick = async () => {
          if (!confirm('删除备份「' + s.name + '」？')) return;
          try {
            await window.__saveManager.deleteSlot(dbKey, s.name);
            toast('已删除备份');
            loadSlots(cardEl, dbKey);
            // v0.6.81：删除后重查实际数据——无当前存档且无剩余备份 → 整卡收起（默认态；用户手动展开过则不收）
            let hasDataNow = false, hasSlotsNow = false;
            try { hasSlotsNow = !!(await window.__saveManager.listSlots(dbKey)); } catch (e2) {}
            try { hasDataNow = await window.__saveManager.hasSaveData(dbKey); } catch (e2) {}
            const rec = saveScanCache && saveScanCache.get(dbKey);
            if (rec) { rec.hasSlots = hasSlotsNow; rec.hasData = hasDataNow; rec.scanned = true; }
            if (!hasDataNow && !hasSlotsNow) { try { drawSavePage(); } catch (e4) {} } // v1.0.32：删空 → 卡片当场消失
            const bodyEl2 = cardEl.querySelector('.save-card-body');
            if (!hasDataNow && !hasSlotsNow && bodyEl2 && !cardEl.dataset.userCardOpen) {
              bodyEl2.classList.add('hidden');
              cardEl.classList.add('collapsed');
              try {
                localStorage.setItem(SAVECARD_HAS_PREFIX + dbKey, '0');
                localStorage.setItem(SLOTS_HAS_PREFIX + dbKey, '0');
              } catch (e3) {}
            }
          } catch (e) { toast('删除失败: ' + e.message, true); }
        };
        slotsBox.appendChild(row);
      }
    };
    const fail = (e) => { slotsBox.innerHTML = '<p class="muted slots-empty">备份读取失败: ' + esc(String((e && e.message) || e)) + '</p>'; };
    if (preSlots !== undefined) { fill(preSlots); return; } // v0.6.71：已预取 → 同步填充（防先塌后撑）
    window.__saveManager.listSlots(dbKey).then(fill).catch(fail);
  }

  // v0.6.59：配置弹窗「前往存档管理」——切到存档页 + 定位目标卡（展开）+ 折叠其他版本卡 + 目标卡版本列表同款选中框
  // v0.6.60：进入先清上一次 goto 残留高亮/旧一次性监听——换版本再前往不再留下旧卡选中框
  async function gotoFocusSaveCard(v) {
    clearGotoFocus(false); // 清上一次 goto 残留高亮/监听/标志（换版本再前往不留下旧卡选中框）
    const dbKey = v.dbKey || ('version_' + v.id);
    const targetId = 'save-card-' + String(v.id).replace(/[^\w\u4e00-\u9fa5-]/g, '_');
    saveGotoTargetId = targetId; // v0.6.76：置位 goto 渲染模式——首次渲染即折叠非目标卡（防「先展开再收起」闪动）；用户点击/超时后清除
    // v0.6.62：清搜索 + 确保扫描新鲜（数据变更后重扫）——目标版本卡始终存在（全量显示）
    savesQuery = '';
    const si = $('save-search'); if (si) si.value = '';
    if (!saveScanCache) saveScanCache = new Map();
    // 目标必在全部版本中：按 versions 序预置目标页（孤儿只会尾随追加、不影响目标索引）
    const vidx = versions.findIndex((x) => (x.dbKey || ('version_' + x.id)) === dbKey);
    if (vidx >= 0) savesPage = Math.floor(vidx / SAVES_PAGE_SIZE);
    // 切到存档视图（手动切——绕过 nav handler 的 enterSavesView 后台重扫，避免覆盖本流程刚设置的状态）
    const nav = document.querySelector('.nav-item[data-view="saves"]');
    if (nav && !nav.classList.contains('active')) {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b === nav));
      document.querySelectorAll('.view').forEach((x) => x.classList.toggle('active', x.id === 'view-saves'));
      if (isMobile()) document.body.classList.remove('sidebar-open');
    }
    // 切视图后立即折叠已渲染的旧卡（除目标卡）——防新卡渲染前（预取等待期）旧展开卡可见
    // = 「其他卡先展开着、渲染完再收起」的闪动源；目标旧卡立即高亮（等待期选中框不缺席 = 防「框闪一下」）（v0.6.76/0.6.77）
    document.querySelectorAll('#save-list .save-card').forEach((c) => {
      if (c.id === targetId) {
        const b = c.querySelector('.save-card-body');
        if (b) { b.classList.remove('hidden'); c.classList.remove('collapsed'); }
        c.classList.add('goto-focus');
        const sw = c.querySelector('.save-slots-wrap');
        if (sw) { sw.classList.remove('folded'); sw.dataset.userSet = '1'; }
        return;
      }
      const b = c.querySelector('.save-card-body');
      if (b && !b.classList.contains('hidden')) {
        b.classList.add('hidden');
        c.classList.add('collapsed');
        c.dataset.gotoFolded = '1'; // v0.6.78：标记被 goto 强折叠 → 退出 goto 时按缓存恢复
      }
    });
    try { await renderSaveList(true); } catch (e) {} // 重建缓存 + 按已置位的目标页单次渲染（drawSavePage async：卡在预取后入 DOM → 下方 poll 守护；不再二次 drawSavePage，避免重复渲染闪动）
    let rec = saveScanCache.get(dbKey);
    if (!rec) { rec = { v: v, orphan: false, hasData: false, hasSlots: false }; saveScanCache.set(dbKey, rec); }
    else rec.v = v;
    // v0.6.75：drawSavePage 自 v0.6.71 起 async（渲染前 await 预取本页备份槽）→ 卡片出现被推迟，
    // 旧的「固定 120ms 单次 locate」在版本多/槽慢时扑空 → 不再折叠/不高亮。改为轮询等待目标卡
    // 出现后幂等应用；后台 rescan 并入孤儿触发整页重绘时会重建卡 → 持续守护直至用户点击或超时。
    let applied = false;
    const applyFocus = () => {
      const card = document.getElementById(targetId);
      if (!card) return false;
      const all = document.querySelectorAll('#save-list .save-card');
      all.forEach((c) => {
        const body = c.querySelector('.save-card-body');
        if (c === card) {
          // 目标：展开 + 版本列表同款 accent 选中框 + 展开备份列表
          if (body) { body.classList.remove('hidden'); c.classList.remove('collapsed'); }
          c.classList.add('goto-focus');
          c.dataset.userCardOpen = '1'; // 防「无存档自动收起」逻辑立刻收起目标
          const sw = c.querySelector('.save-slots-wrap');
          if (sw) { sw.classList.remove('folded'); sw.dataset.userSet = '1'; }
        } else {
          // 折叠其他版本卡（仅 DOM 层）
          if (body && !body.classList.contains('hidden')) {
            body.classList.add('hidden');
            c.classList.add('collapsed');
          }
        }
      });
      if (!window.__mdzGotoOffFn) {
        // 用户随后任意点击 → 退出 goto 定位态（清高亮/监听/标志；折叠态随下次进入存档页整页重建恢复）
        const off = () => { clearGotoFocus(false); };
        window.__mdzGotoOffFn = off;
        document.addEventListener('click', off, true);
      }
      try { if (card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
      return true;
    };
    const t0 = Date.now();
    const poll = () => {
      if (applied && !window.__mdzGotoOffFn) return; // 用户已点击 → 结束守护
      const card = document.getElementById(targetId);
      if (card && (!applied || !card.classList.contains('goto-focus'))) applied = applyFocus();
      if (Date.now() - t0 > 5000) { clearGotoFocus(false); return; } // 超时放弃定位（页面保持当前渲染，不报错）
      setTimeout(poll, 150);
    };
    setTimeout(poll, 60);
  }

  // ================= v0.6.20：iOS「添加到主屏幕」（PWA 独立模式全屏启动） =================
  /** iOS 识别（含 iPadOS 13+ 伪装 Mac：Mac 平台 + 触屏） */
  function isIOS() {
    try {
      const ua = navigator.userAgent || '';
      if (/iPhone|iPad|iPod/i.test(ua)) return true;
      return (navigator.platform === 'MacIntel' || ua.indexOf('Mac') >= 0) && navigator.maxTouchPoints > 1;
    } catch (e) { return false; }
  }
  /** 是否已从主屏幕启动（iOS navigator.standalone / PWA display-mode: standalone） */
  function isStandalone() {
    try {
      return navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    } catch (e) { return false; }
  }
  /** 引导弹窗：iOS Safari 手动「添加到主屏幕」步骤；已 standalone 则提示当前模式 */
  function showIosHomeHint() {
    const old = document.querySelector('.ios-home-hint');
    if (old) old.remove();
    const ov = document.createElement('div');
    ov.className = 'ios-home-hint';
    ov.innerHTML =
      '<div class="ios-home-hint-bg"></div>' +
      '<div class="ios-home-hint-box">' +
      '<h4>' + (isStandalone() ? '已从主屏幕启动' : '添加到主屏幕') + '</h4>' +
      (isStandalone()
        ? '<p>当前为独立模式（无 Safari 地址栏，可全屏游玩）。</p>'
        : '<p>1. 点底部 <b>分享</b> 按钮（方框上箭头）<br>2. 选择 <b>「添加到主屏幕」</b><br>3. 点右上角 <b>「添加」</b></p>' +
          '<p class="muted">添加到主屏后，从桌面图标启动即可独立全屏运行（无 Safari 地址栏）。</p>') +
      '<button class="ios-home-hint-close">知道了</button>' +
      '</div>';
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    ov.querySelector('.ios-home-hint-bg').onclick = close;
    ov.querySelector('.ios-home-hint-close').onclick = close;
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
  }
  /** 顶栏「添加到主屏幕」按钮：仅 iOS 手机端显示，文本按钮贴 #btn-menu 左侧（留 6px 间隔） */
  function ensureIosHomeButton() {
    try {
      if (!isIOS()) return;
      const bar = document.querySelector('.topbar');
      if (!bar || bar.querySelector('#btn-ios-home')) return;
      const btn = document.createElement('button');
      btn.id = 'btn-ios-home';
      btn.className = 'btn-mobile-only topbar-menu btn-ios-home'; // 与 #btn-menu 同显隐；样式见 CSS
      btn.title = isStandalone() ? '已从主屏幕启动（独立模式）' : '添加到主屏幕，实现全屏启动';
      btn.textContent = 'iOS不能全屏？'; // v0.6.20：文本按钮（用户要求不要图标）
      btn.onclick = showIosHomeHint;
      const menu = bar.querySelector('#btn-menu');
      if (menu) {
        bar.insertBefore(btn, menu);
        menu.style.marginLeft = '0'; // v0.6.20：auto 由 iOS 按钮独占靠右，开关紧贴（间隔由按钮 margin-right 提供）
      } else {
        bar.appendChild(btn);
      }
    } catch (e) { console.warn('[mdz] ios home button fail: ' + e.message); }
  }

  // ================= 品牌配置（v0.4.2） =================
  // 顶栏标题/副标题/Logo 可在 mdz-config.js 配置（window.__mdzConfig.title/subtitle/logo），
  // 部署后放一个 logo.png 在启动器目录即可替换 Logo（无需改代码/重新打包）
  function applyBrandConfig() {
    const cfg = (window.__mdzConfig && typeof window.__mdzConfig === 'object') ? window.__mdzConfig : null;
    if (cfg && cfg.title) { const t = $('brand-title'); if (t) t.textContent = cfg.title; }
    if (cfg && cfg.subtitle) { const s = $('brand-subtitle'); if (s) s.textContent = cfg.subtitle; }
    /* v1.0.30：默认 logo 带缓存令牌——logo.png 文件名固定，不加令牌浏览器会一直用缓存里的旧图 */
    const logoSrc = (cfg && cfg.logo) ? String(cfg.logo) : 'logo.png?v=20261117a';
    const img = new Image();
    img.alt = 'logo';
    img.className = 'brand-logo-img';
    img.onload = function () {
      const box = $('brand-logo');
      if (box) { box.innerHTML = ''; box.appendChild(img); }
    };
    img.onerror = function () { /* 无 logo 文件 → 保留 SVG 占位 */ };
    img.src = logoSrc;
  }
  /** 帮助（v0.4.7）：侧边栏「帮助」→ 配置的浏览器链接。
   *  配置：mdz-config.js 里 window.__mdzConfig = { help: { label: '帮助', url: 'https://...' } }；
   *  未配置 url 时用默认 DEFAULT_HELP_URL（v0.6.9）。
   *  v0.5.8：把帮助按钮【替换为真实 <a target="_blank"> 元素】——与「了解更多」按钮完全同款跳转
   *  机制（浏览器/Capacitor 对真实 a 标签的用户点击 = 系统浏览器/新标签页；此前 JS 动态
   *  a.click()/window.open/原生跳转在安卓上均出现空白页）。 */
  function bindHelp() {
    const btn = $('btn-help');
    if (!btn) return;
    // v0.7.11：PC 本地版无帮助入口（web/安卓专属；用户要求删除——侧边栏只留「下载游戏」）
    if (PLAT.hideHelp) { btn.style.display = 'none'; return; }
    const cfg = (window.__mdzConfig && typeof window.__mdzConfig === 'object') ? window.__mdzConfig : null;
    const h = (cfg && cfg.help && typeof cfg.help === 'object') ? cfg.help : null;
    const url = (h && h.url) ? String(h.url) : DEFAULT_HELP_URL;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = btn.className;
    a.innerHTML = btn.innerHTML;
    a.title = btn.title || '帮助';
    btn.replaceWith(a);
    bindExternalLinks(a.parentNode); // v1.0.1：QQ/微信内置浏览器外链兜底（当前页跳转）
    if (isMobile()) document.body.classList.remove('sidebar-open');
  }
  /** v0.6.71：侧边栏「下载游戏」→ 浏览器链接（与帮助按钮同款真实 <a target="_blank"> 机制；
   *  安卓 Capacitor 对真实 a 标签用户点击 = 系统浏览器。URL 为下载页，勿引用后置常量防 TDZ） */
  function bindDownloadGame() {
    const btn = $('btn-dl-game');
    if (!btn) return;
    const a = document.createElement('a');
    a.href = 'https://moyu-camp.info/archives/minidayz-download';
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = btn.className;
    a.innerHTML = btn.innerHTML;
    a.title = btn.title || '下载游戏';
    btn.replaceWith(a);
    bindExternalLinks(a.parentNode); // v1.0.1：QQ/微信内置浏览器外链兜底（当前页跳转）
    if (isMobile()) document.body.classList.remove('sidebar-open');
  }
  // 设置页「关于」：默认文案；mdz-config.js 可配置 about.text（自定义文本）与 about.links（链接列表）
  function renderAbout() {
    const box = $('about-content');
    if (!box) return;
    const cfg = (window.__mdzConfig && typeof window.__mdzConfig === 'object') ? window.__mdzConfig : null;
    const about = (cfg && cfg.about && typeof cfg.about === 'object') ? cfg.about : null;
    let html = '';
    if (about && about.text !== undefined && String(about.text) !== '') {
      html += '<p class="muted settings-tip">' + esc(about.text) + '</p>';
    } else {
      // v0.6.71：默认文案 = 功能简介 + 所有权（QCHAI秋柴）+ QQ 频道/群
      // v1.0.43：安卓简介不含「按键映射校准」（触屏无键盘映射，避免 PC/web 专属功能字样）
      const intro = PLAT.isAndroid
        ? '多版本 Mini DAYZ 启动器：版本导入与切换、快捷启动、播放方式与分辨率配置、存档导出导入与备份、多端存档互通。'
        : '多版本 Mini DAYZ 启动器：版本导入与切换、快捷启动、分辨率与播放方式配置、按键映射校准、存档导出导入与备份、多端存档互通。';
      html += '<p class="muted settings-tip">' + intro + '</p>' +
        '<p class="settings-tip about-owner">@QCHAI秋柴（B站）</p>' +
        '<p class="about-social">QQ频道 频道号：hww8wm3e79<br>QQ群聊 群号：833327032<br>QQ群聊 群号：647367349</p>';
    }
    if (about && Array.isArray(about.links) && about.links.length) {
      html += '<div class="about-links">' + about.links.map((l) =>
        '<a class="about-link" href="' + esc(l.url || '#') + '" target="_blank" rel="noopener">' + esc(l.label || l.url || '链接') + '</a>'
      ).join('') + '</div>';
    }
    // v0.6.9：「了解更多」按钮（mdz-config.js 的 about.moreUrl 可改链接，默认 minidayz-launcher 页）
    // v1.0.44：「查看更新」按钮三端统一显示；v1.0.3：web 版改为真实外链（启动器更新说明页，用户指定）
    const moreUrl = (about && about.moreUrl) ? String(about.moreUrl) : DEFAULT_MORE_URL;
    html += '<div class="about-more"><a class="about-more-btn" href="' + esc(moreUrl) + '" target="_blank" rel="noopener">了解更多</a>' +
      (PLAT.isAndroid
        ? '<a class="about-more-btn" href="' + esc(ANDROID_UPDATE_URL) + '" target="_blank" rel="noopener">查看更新</a>'
        : PLAT.isPC
          ? '<a class="about-more-btn" href="' + esc(PC_UPDATE_URL) + '" target="_blank" rel="noopener">查看更新</a>'
          : '<a class="about-more-btn" href="' + esc(LAUNCHER_UPDATE_URL) + '" target="_blank" rel="noopener">查看更新</a>') +
      '</div>';
    box.innerHTML = html;
    bindExternalLinks(box); // v1.0.1：QQ/微信内置浏览器外链兜底（当前页跳转）
  }

  // ================= 公告弹窗（v0.7.9） =================
  // 内容源 = 部署根 notice.json（独立文件随时可编辑）：{ "title": "公告", "html": "<p>...</p>" }
  // 规则：每次打开都会弹出（除非今天点过「今日不再弹出」，localStorage mdz-notice-muted=YYYY-MM-DD）；
  // 侧边栏「公告」按钮（设置上方）可随时再次打开查看。文件缺失/无 html → 不弹/提示暂无公告。
  function todayStr() {
    const t = new Date();
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  }
  let noticeCache = null; // 本次会话已取到的内容 { title, html }；null=尚未取/无
  // v1.0.2：公告按钮/弹窗只在 notice.json 有内容时出现；缓存上次内容 → 刷新时按钮立即出现（不必等网络），
  // 公告被删/清空后下次加载自动移除按钮与缓存（缓存键 NOTICE_CACHE_KEY 已上移到 IIFE 顶部）
  function readNoticeCache() {
    try {
      const o = JSON.parse(localStorage.getItem(NOTICE_CACHE_KEY) || 'null');
      if (o && o.html && String(o.html).trim()) return { title: o.title || '公告', html: String(o.html) };
    } catch (e) {}
    return null;
  }
  function writeNoticeCache(n) {
    try {
      if (n && n.html && String(n.html).trim()) {
        localStorage.setItem(NOTICE_CACHE_KEY, JSON.stringify({ title: n.title || '公告', html: String(n.html), at: Date.now() }));
      }
    } catch (e) {}
  }
  function clearNoticeCache() { try { localStorage.removeItem(NOTICE_CACHE_KEY); } catch (e) {} }
  function removeNoticeNavButton() {
    try { const b = document.getElementById('btn-notice'); if (b && b.parentNode) b.parentNode.removeChild(b); } catch (e) {}
  }
  /** 拉取 notice.json：有内容 → 写缓存 + 显示按钮 + 按 muted 规则弹窗；无内容 → 清缓存并移除按钮 */
  function ensureNotice() {
    loadNotice(function (n) {
      if (n && n.html && String(n.html).trim()) { writeNoticeCache(n); addNoticeNavButton(); maybeShowNotice(); }
      else { clearNoticeCache(); removeNoticeNavButton(); }
    });
  }
  function loadNotice(cb) {
    fetchTimeout(fetch('notice.json?t=' + Date.now(), { cache: 'no-store' }), 4000)
      .then((res) => { if (!res || !res.ok) return null; return res.json(); })
      .then((j) => {
        if (!j || typeof j !== 'object') { noticeCache = null; cb(null); return; }
        const title = (j.title !== undefined && String(j.title) !== '') ? String(j.title) : '公告';
        const html = (j.html !== undefined) ? String(j.html) : '';
        noticeCache = { title, html };
        cb(noticeCache);
      })
      .catch(() => { noticeCache = null; cb(null); });
  }
  function showNoticeCard(n) {
    try {
      if (!n || !n.html || !n.html.trim()) { toast('暂无公告'); return; }
      if (document.getElementById('mdz-notice')) return;
      if (!document.getElementById('mdz-notice-css')) {
        const st = document.createElement('style');
        st.id = 'mdz-notice-css';
        st.textContent = '#mdz-notice{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);padding:18px}' +
          // v-web公告专项：长内容/图片安全——卡片限宽限高 + 纵向滚动；多媒体等比限宽不溢出
          '#mdz-notice .n-card{position:relative;max-width:min(92vw,560px);width:100%;max-height:min(82vh,86vh);overflow-y:auto;' +
          'overscroll-behavior:contain;-webkit-overflow-scrolling:touch;background:var(--panel,#fff);color:var(--text,#222);' +
          'border:1px solid var(--border,#ddd);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.45);padding:20px 22px;box-sizing:border-box}' +
          '#mdz-notice .n-card::-webkit-scrollbar{width:8px}' +
          '#mdz-notice .n-card::-webkit-scrollbar-thumb{background:rgba(128,128,128,.4);border-radius:4px}' +
          '#mdz-notice .n-close{position:sticky;float:right;top:0;z-index:2;border:0;background:transparent;color:var(--muted,#999);font-size:22px;line-height:1;cursor:pointer;padding:4px 6px;margin-right:-6px}' +
          '#mdz-notice .n-title{font-size:16px;font-weight:700;margin:0 0 12px;padding-right:30px;word-break:break-word}' +
          '#mdz-notice .n-body{font-size:13.5px;line-height:1.65;word-break:break-word;overflow-wrap:anywhere}' +
          '#mdz-notice .n-body a{color:var(--accent,#4a90d9);word-break:break-all}' +
          '#mdz-notice .n-body img,#mdz-notice .n-body video,#mdz-notice .n-body iframe{max-width:100%;height:auto;border-radius:8px}' +
          '#mdz-notice .n-body img{max-height:55vh;object-fit:contain}' +
          '#mdz-notice .n-body table{display:block;max-width:100%;overflow-x:auto}' +
          '#mdz-notice .n-btns{display:flex;justify-content:center;gap:10px;margin:18px 0 2px;flex-wrap:wrap}' +
          '#mdz-notice .n-ok,.mdz-notice .n-mute{padding:9px 20px;border-radius:9px;font-size:14px;cursor:pointer;border:0}' +
          /* v1.0.29：深色主题 --accent 是近白色，写死 color:#fff 会出现白字白底 → 用全站主按钮同款 --accent-text */
    '#mdz-notice .n-ok{background:var(--accent,#4a90d9);color:var(--accent-text,#fff)}' +
          '#mdz-notice .n-mute{background:transparent;color:var(--muted,#888);border:1px solid var(--border,#ddd)}' +
          '@media (max-width:600px){#mdz-notice{padding:10px}#mdz-notice .n-card{max-width:100%;max-height:76vh;padding:16px;border-radius:12px}#mdz-notice .n-title{font-size:15px}#mdz-notice .n-body{font-size:13px}}';
        document.head.appendChild(st);
      }
      const ov = document.createElement('div');
      ov.id = 'mdz-notice';
      ov.innerHTML = '<div class="n-card" role="dialog" aria-label="' + esc(n.title) + '">' +
        '<button class="n-close" title="关闭">✕</button>' +
        '<h3 class="n-title">' + esc(n.title) + '</h3>' +
        '<div class="n-body">' + n.html + '</div>' +
        '<div class="n-btns">' +
        '<button class="n-mute" title="今天之内不再自动弹出（仍可点侧边栏公告查看）">今日不再弹出</button>' +
        '<button class="n-ok">知道了</button></div></div>';
      const closeOnly = () => { ov.remove(); };
      ov.querySelector('.n-close').onclick = closeOnly; // ✕：仅关闭本次（下次打开仍会弹）
      ov.querySelector('.n-ok').onclick = closeOnly; // 知道了：仅关闭本次
      ov.querySelector('.n-mute').onclick = () => { try { localStorage.setItem('mdz-notice-muted', todayStr()); } catch (e) {} ov.remove(); };
      ov.addEventListener('click', (e) => { if (e.target === ov) closeOnly(); }); // 点遮罩仅关闭本次
      bindExternalLinks(ov); // v1.0.1：公告内链接在 QQ/微信内置浏览器兜底（当前页跳转）
      document.body.appendChild(ov);
    } catch (e) {}
  }
  function maybeShowNotice() {
    try {
      // 公告自动弹（20261113c 定稿：全端包括手机每次打开都自动弹，避免没人看公告；
      // 点「今日不再弹出」当天不再自动弹，侧边栏「公告」按钮随时可手动查看）
      // v1.0.2：仅在已加载到公告内容时弹（noticeCache.html 非空）——无内容不弹、也不提示
      if (!noticeCache || !noticeCache.html || !String(noticeCache.html).trim()) return;
      let muted = null;
      try { muted = localStorage.getItem('mdz-notice-muted'); } catch (e) {}
      if (muted === todayStr()) return; // 今天已点「今日不再弹出」
      showNoticeCard(noticeCache);
    } catch (e) {}
  }
  function openNotice() {
    // 按钮手动查看：无视 muted；加载失败/无内容也给明确提示（手机端也一样可用）
    if (noticeCache && noticeCache.html && String(noticeCache.html).trim()) { showNoticeCard(noticeCache); return; } // 本次已取过 → 即时显示
    loadNotice((n) => {
      if (n && n.html && String(n.html).trim()) { writeNoticeCache(n); showNoticeCard(n); return; }
      clearNoticeCache(); removeNoticeNavButton();
      try { toast('公告加载失败或暂无内容'); } catch (e) {}
    });
  }
  function addNoticeNavButton() {
    try {
      if (document.getElementById('btn-notice')) return;
      const ref = document.querySelector('.nav-item[data-view="settings"]');
      if (!ref || !ref.parentNode) return;
      const b = document.createElement('button');
      b.id = 'btn-notice';
      b.className = 'nav-item';
      b.type = 'button';
      b.title = '公告';
      b.innerHTML = '<span class="nav-ico"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10v4a1 1 0 0 0 1 1h3l5 4V5L7 9H4a1 1 0 0 0-1 1z"/><path d="M16 8a5 5 0 0 1 0 8"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg></span>公告';
      b.onclick = () => { try { openNotice(); } catch (e) {} if (isMobile()) { try { document.body.classList.remove('sidebar-open'); } catch (e2) {} } };
      ref.parentNode.insertBefore(b, ref); // 插在「设置」按钮之前
    } catch (e) {}
  }
})();
