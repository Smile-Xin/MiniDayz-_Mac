'use strict';
/**
 * builtin-sync —— 内置版本与数据目录的一致性整理（启动时跑一次）
 *
 * 历史背景：早期版本会把内置游戏复制进数据目录，后来改成「直接由内置根提供」
 * （见 version-manager.getBuiltinRoots / protocol 的回退查找）。这里负责清理历史残留：
 *
 *   1) 旧版复制进来的 minidayz-mp 副本（带 metadata/builtin-ver.txt 标记）→ 删除
 *   2) 数据目录里与内置源「内容完全一致」的同名副本 → 删除（用户改过的副本保留）
 *
 * 两条清理都只删「启动器自己造出来的副本」，绝不碰用户导入的版本。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/** 内置版清单：probe 用于判断该目录是否是某内置版；sync 用于和副本做内容比较 */
const BUILTINS = [
  { id: 'minidayz-pc', probe: path.join('v141', 'index.html'), sync: path.join('v141', 'data.js') },
  { id: 'mdz-plus-v120', probe: 'index.html', sync: 'data.js' },
  { id: 'minidayz-mp', probe: path.join('client', 'index.html'), sync: path.join('client', 'data.js') }
];

function safeResolve(p) {
  try { return path.resolve(p); } catch (e) { return p; }
}

/** 两个文件内容是否完全一致（任一缺失视为不一致） */
function sameFile(a, b) {
  try {
    return fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch (e) {
    return false;
  }
}

/**
 * 清理旧版遗留的 minidayz-mp 副本。
 * v1.0.16 起内置版本统一放在 versions/ 下，而 dev/便携模式下 versionsRoot 可能正好就是内置源目录，
 * 必须先把「内置源」排除掉，否则会把源删了。
 */
function removeStaleMpCopy(versionsRoot) {
  const stale = path.join(versionsRoot, 'minidayz-mp');
  const sourceDirs = [
    path.join(process.resourcesPath || '', 'versions', 'minidayz-mp'),
    path.join(app.getAppPath(), 'versions', 'minidayz-mp')
  ].map(safeResolve);
  if (sourceDirs.indexOf(safeResolve(stale)) >= 0) return;
  try {
    if (fs.existsSync(path.join(stale, 'metadata', 'builtin-ver.txt'))) {
      fs.rmSync(stale, { recursive: true, force: true });
      console.log('[builtin] removed stale built-in minidayz-mp -> ' + stale);
    }
  } catch (e) {
    console.warn('[builtin] cleanup minidayz-mp: ' + e.message);
  }
}

/**
 * 删除数据目录里与内置源内容一致的同名副本（用户改过的保留）。
 * @returns {boolean} 是否在本根目录下找到了内置源
 */
function removeDuplicateCopies(base, versionsRoot) {
  let found = false;
  for (const builtin of BUILTINS) {
    try {
      const srcDir = path.join(base, builtin.id);
      if (!fs.existsSync(path.join(srcDir, builtin.probe))) continue;
      found = true;

      const dest = path.join(versionsRoot, builtin.id);
      if (safeResolve(srcDir) === safeResolve(dest)) continue;  // 数据根就是内置源 → 不动
      if (!fs.existsSync(dest)) continue;                       // 没有副本 → 无需清理

      const rel = builtin.sync || builtin.probe;
      if (!sameFile(path.join(srcDir, rel), path.join(dest, rel))) {
        console.log('[builtin] kept user copy (content differs) -> ' + dest);
        continue;
      }
      fs.rmSync(dest, { recursive: true, force: true });
      console.log('[builtin] removed duplicate built-in copy (now served from resources) -> ' + dest);
    } catch (e) {
      console.warn('[builtin] ' + builtin.id + ' cleanup failed: ' + e.message);
    }
  }
  return found;
}

/** 入口：启动时调用一次 */
function syncBuiltinVersions(versionManager) {
  const versionsRoot = versionManager.getVersionsRoot();
  removeStaleMpCopy(versionsRoot);

  // 候选顺序与「内置版本从哪读」由 version-manager 统一维护（新布局优先，旧布局兜底）
  for (const base of versionManager.getBuiltinRoots()) {
    if (removeDuplicateCopies(base, versionsRoot)) return;
  }
  console.log('[builtin] no builtin source found (dev without builtin/minidayz-pc?)');
}

module.exports = { syncBuiltinVersions };
