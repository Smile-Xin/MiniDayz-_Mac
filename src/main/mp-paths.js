'use strict';
/**
 * mp-paths —— 「多人版客户端（mp-client）」目录的定位
 *
 * 这份客户端有两种用途：
 *   1) protocol 把 `app://game/version/__lan_client__/*` 映射到它（播放器直接读本地文件）
 *   2) lan-services 把它分发给别人 / 在本地临时端口上发出来
 * 两处需要同一套「目录可能在哪」的知识，因此集中在这里。
 *
 * 查找顺序按布局迭代历史：新布局 versions/ 在前，旧布局 builtin/、mp-client/ 兜底。
 *   includeUserData=true 时额外找 <app>/../mp-client 与数据目录里的副本（分发服务需要，
 *   协议层不需要——历史原因，保持各自原有行为）。
 */
const fs = require('fs');
const path = require('path');

/** 候选目录（按优先级） */
function candidates(opts) {
  const o = opts || {};
  const list = [];
  const add = (dir) => { if (dir) list.push(dir); };

  add(o.resourcesPath && path.join(o.resourcesPath, 'versions', 'minidayz-mp'));  // 打包后 extraResources
  add(o.appPath && path.join(o.appPath, 'versions', 'minidayz-mp'));              // dev
  add(o.resourcesPath && path.join(o.resourcesPath, 'builtin', 'minidayz-mp'));   // 旧布局（≤1.0.15）
  add(o.appPath && path.join(o.appPath, 'builtin', 'minidayz-mp'));
  add(o.resourcesPath && path.join(o.resourcesPath, 'mp-client'));                // 更旧布局（≤0.7.33）
  add(o.appPath && path.join(o.appPath, 'mp-client'));
  if (o.includeUserData) {
    add(o.appPath && path.join(o.appPath, '..', 'mp-client'));
    add(o.versionsRoot && path.join(o.versionsRoot, 'minidayz-mp'));
  }
  return list;
}

/** 找到第一个含 client/index.html 的目录；都没有返回 '' */
function findClientDir(opts) {
  for (const dir of candidates(opts)) {
    try {
      if (fs.existsSync(path.join(dir, 'client', 'index.html'))) return path.resolve(dir);
    } catch (e) { /* 继续找 */ }
  }
  return '';
}

module.exports = { candidates, findClientDir };
