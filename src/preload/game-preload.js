'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 从 URL app://game/version/<id>/index.html 解析版本 id
let dbKey = 'default';
let versionId = 'default';
let calibrate = false;
try {
  const qs = new URLSearchParams(window.location.search);
  dbKey = qs.get('dbKey') || 'default';
  calibrate = qs.get('calibrate') === '1';
  const segs = window.location.pathname.split('/').filter(Boolean);
  if (segs[0] === 'version' && segs[1]) versionId = decodeURIComponent(segs[1]);
} catch (e) {}

contextBridge.exposeInMainWorld('__launcher', {
  versionId: dbKey,          // 存档隔离后缀（隔离补丁读取，必须等于 dbKey）
  gameId: versionId,         // 版本 id（config 键）
  calibrate,
  backToLauncher: () => ipcRenderer.send('game:back-to-launcher'),
  // 键盘映射（按键 -> 屏幕按钮坐标），按版本 id 存取
  getKeymap: () => ipcRenderer.invoke('config:getKeymap', versionId),
  saveKeymap: (map) => ipcRenderer.invoke('config:saveKeymap', versionId, map)
});
