'use strict';
/**
 * game-version —— 与「某个游戏版本」相关的判定规则
 *
 * 这些规则被主进程多处复用（菜单、窗口、IPC、注入），集中在这里避免各处
 * 各写一份 id/名称字符串判断而逐渐分叉。
 */

/** 合成的「服务器分发客户端」版本 id：没有版本目录，素材来自随包的 mp-client */
const LAN_CLIENT_ID = '__lan_client__';

/** 内置 PC 版（键鼠原生、自带 mods 存档系统）的 id 前缀 */
const PC_VERSION_PREFIXES = ['minidayz-pc', 'minidayz-mp'];

function idStartsWith(version, prefixes) {
  const id = String((version && version.id) || '');
  return prefixes.some((p) => id.indexOf(p) === 0);
}

/** 名称里带这些字样的视为 PC 原生版（早期导入包没写 directUrl 时的兜底） */
function looksLikePcByName(version) {
  const name = String((version && version.name) || '');
  return name.indexOf('MiniDayZ PC') >= 0 || name.indexOf('多人版') >= 0;
}

function isLanClient(version) {
  return !!version && version.id === LAN_CLIENT_ID;
}

/**
 * 是否无需键盘映射（键鼠原生）：
 * 内置 PC 单机版 / 多人版，以及任何 directUrl 直链加载的版本。
 * 这些版本不注入 mapper.js，窗口壳页也带 nk=1。
 */
function isMapperDisabled(version) {
  if (!version) return false;
  return !!(version.noKeymap || version.directUrl || idStartsWith(version, PC_VERSION_PREFIXES) || looksLikePcByName(version));
}

/** PC 原生尺寸（850×890）与其他版本默认尺寸（1280×720） */
const PC_DEFAULT_RESOLUTION = { w: 850, h: 890 };
const DEFAULT_RESOLUTION = { w: 1280, h: 720 };

/** 版本的默认窗口分辨率（用户没设过、metadata 也没写时用） */
function defaultResolution(version) {
  if (idStartsWith(version, ['minidayz-pc']) || String((version && version.name) || '').indexOf('MiniDayZ PC') >= 0 || (version && version.directUrl)) {
    return { w: PC_DEFAULT_RESOLUTION.w, h: PC_DEFAULT_RESOLUTION.h };
  }
  return { w: DEFAULT_RESOLUTION.w, h: DEFAULT_RESOLUTION.h };
}

/**
 * 合成的联机客户端版本记录（不在磁盘上，素材走 mp-client）。
 * @param {string} name 显示名（不同入口历史上用了不同名字，保持原样）
 */
function createLanClientVersion(name) {
  return {
    id: LAN_CLIENT_ID,
    name: name || 'MiniDayZ 多人版',
    entry: 'client/index.html',
    dbKey: LAN_CLIENT_ID,
    directUrl: true,
    noSave: true,
    noKeymap: true
  };
}

module.exports = {
  LAN_CLIENT_ID,
  isLanClient,
  isMapperDisabled,
  defaultResolution,
  createLanClientVersion
};
