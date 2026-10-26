'use strict';
/**
 * dev-harness —— 开发期诊断钩子（环境变量触发，正常使用完全不参与）
 *
 *   MDZ_SHOT=<png>       启动器首帧稳定后截图并退出（验证 UI 渲染）
 *   MDZ_SHOT_DELAY=ms    截图前等待（默认 2500）
 *   MDZ_VIEW=<view>      截图前切到指定页面（versions / saves / lan / settings / transfer）
 *   MDZ_LAUNCH=<id>      顺带启动一次游戏窗口
 *   MDZ_SHOT2=<png>      游戏窗口截图
 *   MDZ_SHOT2_DELAY=ms   等待游戏加载（默认 25000）
 *   MDZ_DEVTOOLS=1       给每个窗口打开独立开发者工具
 *   MDZ_SOFT=1           退化为软件渲染（GPU 兼容问题时用）
 *   MDZ_TIMING=1         打印启动各阶段耗时
 */
const fs = require('fs');

/** 兼容 Electron 新旧两种 console-message 事件签名 */
function formatConsoleMessage(args) {
  try {
    if (args.length >= 2 && typeof args[1] === 'object' && args[1] !== null && 'message' in args[1]) {
      return `[${args[1].level}] ${String(args[1].message).slice(0, 400)}`;
    }
    const [event, level, message, line, source] = args;
    return `[${level}] ${String(message).slice(0, 400)} (${source}:${line})`;
  } catch (err) {
    return String(args);
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 安装截图钩子。没有 MDZ_SHOT 时直接返回，不留任何监听器。
 *
 * @param {object} opts
 * @param {BrowserWindow} opts.launcherWin
 * @param {object} opts.windows  game-windows 控制器（复用真实的启动/关窗流程）
 * @param {object} opts.versionManager
 * @param {object} opts.app
 */
function attachShotHarness(opts) {
  const shotPath = process.env.MDZ_SHOT;
  if (!shotPath) return;

  const { launcherWin, windows, versionManager, app } = opts;
  launcherWin.webContents.once('did-finish-load', async () => {
    await delay(Number(process.env.MDZ_SHOT_DELAY || 2500));
    try {
      if (process.env.MDZ_VIEW) {
        await launcherWin.webContents.executeJavaScript(
          "document.querySelector('[data-view=\"" + process.env.MDZ_VIEW + "\"]').click()");
        await delay(1200);
      }
      const image = await launcherWin.webContents.capturePage();
      fs.writeFileSync(shotPath, image.toPNG());
      const cards = await launcherWin.webContents.executeJavaScript("document.querySelectorAll('.card').length");
      console.log('[shot] saved ' + shotPath + ' cards=' + cards);
    } catch (e) {
      console.log('[shot] failed: ' + e.message);
    }

    // 顺带验证「app:// 协议 + 壳页 + 存档补丁」这条链路
    if (process.env.MDZ_SHOT2 && process.env.MDZ_LAUNCH) {
      const version = versionManager.getVersion(process.env.MDZ_LAUNCH);
      if (!version) {
        console.log('[shot] version not found: ' + process.env.MDZ_LAUNCH);
      } else {
        try {
          windows.openPlayer(version, { fit: 'scale' });
          await delay(Number(process.env.MDZ_SHOT2_DELAY || 25000));
          const game = windows.getGame();
          const image = await game.webContents.capturePage();
          fs.writeFileSync(process.env.MDZ_SHOT2, image.toPNG());
          const info = await game.webContents.executeJavaScript(
            'JSON.stringify({url:location.href,hasFrame:!!document.querySelector("iframe"),' +
            'dbPatch:(function(){try{var w=document.querySelector("iframe").contentWindow;' +
            'return /endsWith|suffix/.test(String(w.indexedDB.open));}catch(e){return "n/a";}})()})');
          console.log('[shot] game saved ' + process.env.MDZ_SHOT2 + ' ' + info);
        } catch (e) {
          console.log('[shot] game capture failed: ' + e.message);
        }
      }
    }
    app.exit(0);
  });
}

module.exports = { attachShotHarness, formatConsoleMessage };
