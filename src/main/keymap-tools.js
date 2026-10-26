'use strict';
/**
 * keymap-tools —— 键盘映射的数据结构与「导入/导出 JSON 文件」
 *
 * 结构（config.json 的 keymaps[versionId]）：
 *   多方案 { active: '方案名', schemes: { 方案名: { 按键码: {action,type,pos} } } }
 *   历史单方案 { 按键码: {...} } —— 读取时自动包成「默认」方案
 *
 * 导出/导入在「窗口菜单」和「启动器界面（IPC）」两处都要用，逻辑只留这一份。
 */
const fs = require('fs');
const { dialog } = require('electron');

const DEFAULT_SCHEME = '默认';
const KEYMAP_FILTER = [{ name: '按键映射', extensions: ['json'] }];

/** 规范化成多方案结构；非法输入返回 null */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.schemes && typeof raw.schemes === 'object') return raw;
  return { active: DEFAULT_SCHEME, schemes: { [DEFAULT_SCHEME]: raw } };
}

/** 取当前生效方案 { name, map }（active 失效时回退第一个方案）；没有配置返回 null */
function activeScheme(raw) {
  const normalized = normalize(raw);
  if (!normalized) return null;
  const name = (normalized.active && normalized.schemes[normalized.active]) ? normalized.active : Object.keys(normalized.schemes)[0];
  return (name && normalized.schemes[name]) ? { name, map: normalized.schemes[name] } : null;
}

/** 把外部 JSON（可能是单方案 plain map）转成可保存的多方案结构 */
function toSchemes(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return (raw.schemes && typeof raw.schemes === 'object') ? raw : { active: DEFAULT_SCHEME, schemes: { [DEFAULT_SCHEME]: raw } };
}

/**
 * 导出当前方案到用户选择的文件。
 * @param {BrowserWindow|null} parent 对话框父窗口
 * @param {string} versionId
 * @param {object|null} keymap config.json 里的原始值
 * @returns {Promise<{canceled?:boolean,error?:string,filePath?:string,scheme?:string}>}
 */
async function exportToFile(parent, versionId, keymap) {
  const scheme = activeScheme(keymap);
  if (!scheme) return { error: '该版本还没有按键映射配置' };
  const res = await dialog.showSaveDialog(parent, {
    title: '导出按键映射',
    defaultPath: 'mdz-keymap-' + versionId + '-' + scheme.name + '.json',
    filters: KEYMAP_FILTER
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  fs.writeFileSync(res.filePath, JSON.stringify(scheme.map, null, 2), 'utf8');
  return { filePath: res.filePath, scheme: scheme.name };
}

/**
 * 从用户选择的文件导入并保存（覆盖同名方案，其余保留）。
 * @returns {Promise<{canceled?:boolean,error?:string,ok?:boolean,count?:number}>}
 */
async function importFromFile(parent, versionId, versionManager) {
  const res = await dialog.showOpenDialog(parent, {
    title: '导入按键映射',
    filters: KEYMAP_FILTER,
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  // 解析失败按原样抛出：IPC 调用方会拿到 reject（界面提示失败原因），菜单调用方自行 catch
  const raw = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
  const schemes = toSchemes(raw);
  if (!schemes) return { error: '无效的按键映射文件' };
  versionManager.saveKeymap(versionId, schemes);
  return { ok: true, count: Object.keys(schemes.schemes).length };
}

module.exports = {
  DEFAULT_SCHEME,
  normalize,
  activeScheme,
  toSchemes,
  exportToFile,
  importFromFile
};
