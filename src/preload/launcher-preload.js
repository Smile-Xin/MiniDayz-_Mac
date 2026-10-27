'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__launcherNative', {
  platform: process.platform, // mac 移植：渲染层据此隐藏「便携模式」等 Windows 专属选项
  versionsList: () => ipcRenderer.invoke('versions:list'),
  pickZip: () => ipcRenderer.invoke('versions:pickZip'),
  doImport: (candidate, overrides) => ipcRenderer.invoke('versions:doImport', candidate, overrides),
  removeVersion: (id) => ipcRenderer.invoke('versions:remove', id),
  launch: (id, mode, res) => ipcRenderer.send('versions:launch', id, mode, res), // v0.7.11：res={w,h} 可选——窗口模式按启动器所选分辨率开窗
  launchKeymap: (id) => ipcRenderer.send('versions:launchKeymap', id),
  getConfig: () => ipcRenderer.invoke('config:get'),
  trainerGet: () => ipcRenderer.invoke('trainer:get'),
  trainerSet: (patch) => ipcRenderer.invoke('trainer:set', patch),
  setDataMode: (mode) => ipcRenderer.invoke('config:setDataMode', mode),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'), // v0.7.19：数据目录切换后需重启（userData 只能在 ready 前设定）
  setResolution: (id, res) => ipcRenderer.invoke('config:setResolution', id, res),
  saveExport: (json, fileName) => ipcRenderer.invoke('save:export', json, fileName),
  saveImport: () => ipcRenderer.invoke('save:import'),
  keymapExport: (id) => ipcRenderer.invoke('keymap:export', id),
  keymapImport: (id) => ipcRenderer.invoke('keymap:import', id),
  getKeymap: (id) => ipcRenderer.invoke('config:getKeymap', id),
  saveKeymap: (id, map) => ipcRenderer.invoke('config:saveKeymap', id, map),
  closeGame: () => ipcRenderer.send('game:close'), // v0.6.37：导入存档前关闭游戏窗口（防自动保存覆盖导入数据）
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // ===== v0.7.22：局域网/服务器（信令服务器 / 客户端分发 / 建房程序）=====
  lanStatus: () => ipcRenderer.invoke('lan:status'),
  setLan: (patch) => ipcRenderer.invoke('config:setLan', patch),
  lanSignal: (action) => ipcRenderer.invoke('lan:signal', action),   // 'start' | 'stop'
  lanServe: (action) => ipcRenderer.invoke('lan:serve', action),     // 'start' | 'stop'
  lanHost: (action) => ipcRenderer.invoke('lan:host', action),       // 'start' | 'stop'
  lanPickHostDir: () => ipcRenderer.invoke('lan:pickHostDir'),
  lanPlay: (override) => ipcRenderer.invoke('lan:play', override),   // 播放服务器分发的客户端
  onLanLog: (cb) => ipcRenderer.on('lan:log', (e, line) => cb(line)),

  // ===== v1.0.1：存档传输（同步 IPC —— 与安卓端 saveTransfer 同形，页面代码两端几乎一样）=====
  transferStatus: () => ipcRenderer.sendSync('transfer:status'),
  transferStart: (port, token) => ipcRenderer.sendSync('transfer:start', port, token),
  transferStop: () => ipcRenderer.sendSync('transfer:stop'),
  transferList: () => ipcRenderer.sendSync('transfer:list'),
  transferGet: (id) => ipcRenderer.sendSync('transfer:get', id),
  transferRemove: (id) => ipcRenderer.sendSync('transfer:remove', id),
  transferExport: (fileName, text) => ipcRenderer.sendSync('transfer:export', fileName, text),
  onTransferLog: (cb) => ipcRenderer.on('transfer:log', (e, line) => cb(line)),
  onLanStatus: (cb) => ipcRenderer.on('lan:status', (e, st) => cb(st))
});
