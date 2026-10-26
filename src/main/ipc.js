'use strict';
/**
 * ipc —— 渲染层 ↔ 主进程的全部 IPC 通道
 *
 * 约定：
 *   invoke/handle  用于「有返回值、可能要等」的操作（列表、导入、导出…）
 *   on/send        用于「单向通知」（启动游戏、关窗口）
 *   on + returnValue 用于存档传输（页面侧要同步返回，与安卓端 API 同形）
 *
 * 所有通道集中在这里注册，main.js 只负责准备依赖，避免主进程入口被 200 行 handler 淹没。
 */
const { dialog, shell, app } = require('electron');
const rules = require('./game-version');
const keymapTools = require('./keymap-tools');

/**
 * @param {object} ctx
 * @param {object} ctx.ipcMain
 * @param {object} ctx.versionManager
 * @param {object} ctx.lanServices
 * @param {object} ctx.saveTransfer
 * @param {object} ctx.saveIo
 * @param {object} ctx.windows game-windows 控制器
 * @param {()=>BrowserWindow|null} ctx.getLauncher
 * @param {()=>BrowserWindow|null} ctx.getGame
 * @param {()=>void} ctx.showLauncher 显示（必要时新建）启动器窗口
 */
function registerIpcHandlers(ctx) {
  const { ipcMain, versionManager, lanServices, saveTransfer, saveIo, windows } = ctx;
  const getLauncher = ctx.getLauncher;
  const getGame = ctx.getGame;
  /** 对话框父窗口：优先启动器，其次游戏窗口 */
  const dialogParent = () => getLauncher() || getGame();

  // ---------------------------------------------------------------- 版本

  ipcMain.handle('versions:list', () => versionManager.listVersions());

  ipcMain.handle('versions:pickZip', async () => {
    const res = await dialog.showOpenDialog(getLauncher(), {
      title: '选择游戏版本 zip（可多选）',
      filters: [{ name: '游戏版本包', extensions: ['zip'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (res.canceled || !res.filePaths.length) return null;
    const list = [];
    for (const zipPath of res.filePaths) {
      try { list.push(await versionManager.inspectZip(zipPath)); }
      catch (err) { list.push({ error: err.message }); }
    }
    return { list };
  });

  ipcMain.handle('versions:doImport', async (e, candidate, overrides) => {
    try { return await versionManager.importZip(candidate, overrides); }
    catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('versions:remove', async (e, id) => {
    try { await versionManager.removeVersion(id); return { ok: true }; }
    catch (err) { return { error: err.message }; }
  });

  /**
   * 启动游戏（窗口模式）。
   * mode='calibrate' 以校准模式启动；res={w,h} 为启动器侧选定的分辨率。
   */
  ipcMain.on('versions:launch', (e, id, mode, resolution) => {
    const version = (id === rules.LAN_CLIENT_ID)
      ? rules.createLanClientVersion('MiniDayZ PC多人版')
      : versionManager.getVersion(id);
    if (!version) { console.warn('[launcher] version not found: ' + id); return; }
    if (resolution && Number.isFinite(resolution.w) && Number.isFinite(resolution.h)) {
      try { versionManager.setResolution(id, { w: resolution.w, h: resolution.h }); }
      catch (err) { console.warn('[launcher] setResolution fail: ' + err.message); }
    }
    windows.openPlayer(version, { calibrate: mode === 'calibrate', fit: 'scale' });
  });

  /** 以校准模式启动（direct 窗口 + 游戏内校准面板） */
  ipcMain.on('versions:launchKeymap', (e, id) => {
    const version = versionManager.getVersion(id);
    if (version) windows.openDirect(version, { calibrate: true });
    else console.warn('[launcher] version not found: ' + id);
  });

  /** 导入存档前先关游戏窗口，防止游戏自动保存覆盖导入的数据 */
  ipcMain.on('game:close', () => windows.closeGame());

  ipcMain.on('game:back-to-launcher', () => {
    windows.closeGame();
    ctx.showLauncher();
  });

  // ---------------------------------------------------------------- 配置

  ipcMain.handle('config:get', () => versionManager.getConfig());
  ipcMain.handle('config:getKeymap', (e, id) => versionManager.getKeymap(id));
  ipcMain.handle('config:saveKeymap', (e, id, map) => versionManager.saveKeymap(id, map));

  ipcMain.handle('config:setLan', (e, patch) => {
    const lan = versionManager.setLan(patch);
    const endpoints = lanServices.endpoints();
    // 信令地址变了要重启本地客户端（重新注入地址）
    try { lanServices.restartLocalClient(); } catch (err) { /* 忽略 */ }
    return { lan, endpoints, status: lanServices.status() };
  });

  ipcMain.handle('config:setDataMode', async (e, mode) => {
    try { return await versionManager.setDataMode(mode); }
    catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('config:setResolution', (e, id, resolution) => {
    try {
      const applied = versionManager.setResolution(id, resolution);
      // 该版本游戏窗口正开着就立即调整
      windows.applyResolutionToOpenWindow(id, applied);
      return applied;
    } catch (err) { return { error: err.message }; }
  });

  /** 数据目录/便携 profile 切换后必须重启（Chromium userData 只能在 ready 前设定） */
  ipcMain.handle('app:relaunch', () => {
    setTimeout(() => { try { app.relaunch(); } catch (e) { /* 忽略 */ } app.exit(0); }, 600);
    return { ok: true };
  });

  // ---------------------------------------------------------------- 局域网 / 服务器

  ipcMain.handle('lan:status', () => lanServices.status());
  ipcMain.handle('lan:signal', (e, action) => (action === 'start' ? lanServices.startSignal() : lanServices.stopSignal()));
  ipcMain.handle('lan:serve', (e, action) => (action === 'start' ? lanServices.startServe() : lanServices.stopServe()));
  ipcMain.handle('lan:host', (e, action) => (action === 'start' ? lanServices.startHost() : lanServices.stopHost()));

  ipcMain.handle('lan:pickHostDir', async () => {
    const res = await dialog.showOpenDialog(getLauncher(), {
      title: '选择建房程序目录（里面有 nw.exe）',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    versionManager.setLan({ hostDir: res.filePaths[0] });
    return { dir: res.filePaths[0], status: lanServices.status() };
  });

  /**
   * 播放多人客户端：本地把 mp-client 发到 127.0.0.1 临时端口，
   * 信令地址用设置里的 IP/端口注入（不依赖局域网分发服务是否开着）。
   */
  ipcMain.handle('lan:play', async (e, override) => {
    const started = { signal: false, serve: false, local: false };
    const endpoints = lanServices.endpoints();
    const host = lanServices.hostOnly((override && override.serverHost) || '') || endpoints.host;
    const isLocalSignal = ['', '127.0.0.1', 'localhost', '::1'].indexOf(String(host)) >= 0;
    if (isLocalSignal) {
      const before = lanServices.status();
      if (!before.signal.running) { lanServices.startSignal(); started.signal = true; }
      if (started.signal) await new Promise((r) => setTimeout(r, 1200));
    }
    started.local = true;
    const version = rules.createLanClientVersion('MiniDayZ 多人版');
    windows.openPlayer(version, { fit: 'scale' });
    return { url: 'app://game/version/__lan_client__/' + version.entry, started, local: true };
  });

  /** 本地多人客户端地址（供界面内嵌播放；会顺带把本地服务拉起来） */
  ipcMain.handle('lan:clientUrl', async () => {
    const local = await lanServices.ensureLocalClient();
    if (!local) return { error: '本地多人客户端不可用' };
    return { url: local.url, port: local.port, signal: local.signal };
  });

  // ---------------------------------------------------------------- 存档传输（同步 IPC）

  ipcMain.on('transfer:status', (e) => { e.returnValue = saveTransfer.status(); });
  ipcMain.on('transfer:start', (e, port, token) => { e.returnValue = saveTransfer.start(port, token); });
  ipcMain.on('transfer:stop', (e) => { e.returnValue = saveTransfer.stop(); });
  ipcMain.on('transfer:list', (e) => { e.returnValue = saveTransfer.list(); });
  ipcMain.on('transfer:get', (e, id) => { e.returnValue = saveTransfer.get(id); });
  ipcMain.on('transfer:remove', (e, id) => { e.returnValue = saveTransfer.remove(id); });
  ipcMain.on('transfer:export', (e, fileName, text) => { e.returnValue = saveTransfer.exportText(fileName, text); });

  // ---------------------------------------------------------------- 存档导入导出 / 外链 / 按键映射文件

  ipcMain.handle('save:export', async (e, payload, fileName) => saveIo.exportJson(dialogParent(), payload, fileName));
  ipcMain.handle('save:import', async () => saveIo.importJson(dialogParent()));

  ipcMain.handle('shell:openExternal', async (e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('keymap:export', async (e, id) =>
    keymapTools.exportToFile(dialogParent(), id, versionManager.getKeymap(id)));

  ipcMain.handle('keymap:import', async (e, id) =>
    keymapTools.importFromFile(dialogParent(), id, versionManager));
}

module.exports = { registerIpcHandlers };
