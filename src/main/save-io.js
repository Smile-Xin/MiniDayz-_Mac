'use strict';
const { dialog } = require('electron');
const fs = require('fs');

/** 存档导出：渲染层已采集好 JSON，主进程负责弹"另存为"写盘
 *  v0.6.59：文件名用备份备注（槽名）——exportJson 接受可选 fileName（如 '我的备份.json'）
 *  v1.0.15：兜底文件名的时间戳改**本地时间**（原来 toISOString 是 UTC，国内看早 8 小时） */
function localStamp() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes());
}
async function exportJson(win, payload, fileName) {
  const res = await dialog.showSaveDialog(win, {
    title: '导出存档',
    defaultPath: fileName && String(fileName).trim()
      ? String(fileName).replace(/[\\/:*?"<>|\r\n]+/g, '_')
      : ('mdz-save_' + localStamp() + '.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  fs.writeFileSync(res.filePath, text, 'utf8');
  return { canceled: false, filePath: res.filePath };
}

/** 存档导入：弹"打开"读文件，返回文本交给渲染层恢复 */
async function importJson(win) {
  const res = await dialog.showOpenDialog(win, {
    title: '导入存档',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  const text = fs.readFileSync(res.filePaths[0], 'utf8');
  return { canceled: false, filePath: res.filePaths[0], text };
}

module.exports = { exportJson, importJson };
