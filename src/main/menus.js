'use strict';
/**
 * menus —— 游戏窗口的原生菜单模板
 *
 * 历史上有三套菜单（direct 直开窗口 / wrapper 壳页窗口 / 服务器分发的客户端），
 * 「文件」「显示」「按键映射」三段几乎逐字重复。这里把公共结构抽出来，
 * 各菜单只声明自己的差异项；具体行为全部由调用方（game-windows.js）以 handlers 传入。
 *
 * 所有 build* 函数返回「模板数组」而不是已构建的 Menu——因为 macOS 的菜单是应用级的，
 * 必须由 menuHost 决定挂到窗口还是挂到应用（见 createMenuHost）。
 */
const { Menu } = require('electron');

/** 分辨率预设（菜单「显示 → 分辨率」；标签里的尺寸字样也用于窗口标题，保持一致） */
const RESOLUTION_PRESETS = [
  { label: '850×890（PC 原生）', w: 850, h: 890 },
  { label: '1024×768（PE 原生）', w: 1024, h: 768 },
  { label: '1280×720', w: 1280, h: 720 },
  { label: '1366×768', w: 1366, h: 768 },
  { label: '1600×900', w: 1600, h: 900 },
  { label: '1920×1080', w: 1920, h: 1080 }
];

/** 壳页窗口的三种画面模式 */
const FIT_MODES = [
  { value: 'fixed', label: '固定窗口大小' },
  { value: 'follow', label: '自由窗口大小' },
  { value: 'scale', label: '固定分辨率缩放' }
];

/** 分辨率子菜单项：当前项打勾，点击交给 handlers.selectResolution */
function resolutionItems(current, handlers) {
  const isCurrent = (p) => current.w === p.w && current.h === p.h;
  return RESOLUTION_PRESETS.map((preset) => ({
    label: preset.label + (isCurrent(preset) ? ' ✓' : ''),
    type: 'checkbox',
    checked: isCurrent(preset),
    click: () => {
      if (isCurrent(preset)) return;
      handlers.selectResolution(preset);
    }
  }));
}

/** 「显示」里的全屏项（按住 F11 切换） */
function fullscreenItem(isFullScreen, handlers) {
  return {
    label: '全屏',
    accelerator: 'F11',
    type: 'checkbox',
    checked: !!isFullScreen,
    click: () => handlers.toggleFullscreen()
  };
}

/** 「文件」菜单：游戏窗口版（返回启动器 / 退出） */
function fileMenu(handlers) {
  return {
    label: '文件',
    submenu: [
      { label: '返回启动器', click: () => handlers.backToLauncher({ createIfMissing: true }) },
      { type: 'separator' },
      { label: '退出', click: () => handlers.quit() }
    ]
  };
}

/** 「按键映射」菜单：三套游戏窗口共用 */
function keymapMenu(handlers) {
  return {
    label: '按键映射',
    submenu: [
      { label: '以校准模式启动', click: () => handlers.launchCalibrate() },
      { type: 'separator' },
      { label: '导出按键映射…', click: () => handlers.exportKeymap() },
      { label: '导入按键映射…', click: () => handlers.importKeymap() }
    ]
  };
}

/**
 * wrapper 壳页窗口菜单（三种画面模式：fixed / follow / scale）
 * @param {object} opts
 * @param {{w:number,h:number}} opts.resolution 当前逻辑分辨率
 * @param {'fixed'|'follow'|'scale'} opts.fit 当前画面模式
 */
function buildPlayerMenu(opts) {
  const { resolution, fit, isFullScreen, handlers } = opts;
  return [
    fileMenu(handlers),
    {
      label: '显示',
      submenu: [
        fullscreenItem(isFullScreen, handlers),
        { type: 'separator' },
        {
          label: '画面模式',
          submenu: FIT_MODES.map((mode) => ({
            label: mode.label,
            type: 'checkbox',
            checked: fit === mode.value,
            click: () => handlers.selectFit(mode.value)
          }))
        },
        { label: '分辨率', submenu: resolutionItems(resolution, handlers) }
      ]
    },
    keymapMenu(handlers)
  ];
}

/**
 * direct 直开窗口菜单（两种画面模式：fixed 固定分辨率 / free 自由缩放）
 * 与壳页菜单的差别：没有「跟随窗口」，全屏退出时固定分辨率需要把窗口锁回不可缩放。
 */
function buildGameMenu(opts) {
  const { resolution, scaleMode, isFullScreen, handlers } = opts;
  return [
    fileMenu(handlers),
    {
      label: '显示',
      submenu: [
        fullscreenItem(isFullScreen, handlers),
        { type: 'separator' },
        {
          label: '画面模式',
          submenu: [
            { label: '固定分辨率', type: 'checkbox', checked: scaleMode === 'fixed', click: () => handlers.selectScaleMode('fixed') },
            { label: '自由缩放窗口', type: 'checkbox', checked: scaleMode === 'free', click: () => handlers.selectScaleMode('free') }
          ]
        },
        { label: '分辨率', submenu: resolutionItems(resolution, handlers) }
      ]
    },
    keymapMenu(handlers)
  ];
}

/**
 * 服务器分发的客户端窗口菜单（http 页面，用缩放而不是分辨率）
 * 注意：这里的「返回启动器」不会新建启动器窗口（与其它两套菜单不同，保持原行为）。
 */
function buildServerMenu(opts) {
  const { url, label, fit, handlers } = opts;
  const fitRadio = (value, text) => ({
    label: text,
    type: 'radio',
    checked: fit === value,
    click: () => handlers.selectFit(value)
  });
  return [
    {
      label: '文件',
      submenu: [
        { label: '返回启动器', accelerator: 'Esc', click: () => handlers.backToLauncher({ createIfMissing: false }) },
        { type: 'separator' },
        { label: '退出启动器', role: 'quit' }
      ]
    },
    {
      label: '显示',
      submenu: [
        { label: '全屏 (F11)', accelerator: 'F11', click: () => handlers.toggleFullscreen() },
        { type: 'separator' },
        fitRadio('fixed', '画面模式：固定窗口大小'),
        fitRadio('follow', '画面模式：自由窗口大小'),
        fitRadio('scale', '画面模式：固定分辨率缩放'),
        { type: 'separator' },
        { label: '放大画面', click: () => handlers.zoomIn() },
        { label: '缩小画面', click: () => handlers.zoomOut() },
        { label: '重置缩放', click: () => handlers.zoomReset() }
      ]
    },
    { label: label || url, enabled: false }
  ];
}

/**
 * 菜单挂载器：把模板挂到正确的位置。
 * - Windows：win.setMenu（窗口级菜单栏）
 * - macOS ：Menu.setApplicationMenu（应用级菜单；win.setMenu 在 mac 上是空操作）
 *   mac 还额外补 appMenu / editMenu / windowMenu，否则 Cmd+C/V、最小化等标准项会消失。
 */
function createMenuHost(isMac) {
  const macChrome = (template) => [{ role: 'appMenu' }, ...template, { role: 'windowMenu' }];
  const BASE_APP_MENU = [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }];

  function setWinMenu(win, template) {
    if (!win || (win.isDestroyed && win.isDestroyed()) || !Array.isArray(template)) return;
    try {
      if (isMac) {
        Menu.setApplicationMenu(Menu.buildFromTemplate(macChrome(template)));
        try { win.setMenu(null); } catch (e) { /* 无窗口菜单，忽略 */ }
      } else {
        win.setMenu(Menu.buildFromTemplate(template));
      }
    } catch (e) { console.warn('[menu] 设置菜单失败: ' + e.message); }
  }

  /** 回到无游戏窗口时的基础应用菜单（仅 macOS 有意义） */
  function restoreAppMenu() {
    if (!isMac) return;
    try { Menu.setApplicationMenu(Menu.buildFromTemplate(BASE_APP_MENU)); } catch (e) { /* 忽略 */ }
  }

  return { setWinMenu, restoreAppMenu };
}

module.exports = {
  RESOLUTION_PRESETS,
  FIT_MODES,
  buildPlayerMenu,
  buildGameMenu,
  buildServerMenu,
  createMenuHost
};
