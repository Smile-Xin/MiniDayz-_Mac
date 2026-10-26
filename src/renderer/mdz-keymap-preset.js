/* MDZ 启动器 · 默认键位映射方案（部署后可修改本文件，无需重新打包）
 * 由启动器注入游戏页的 mapper.js 读取，作为每个版本的「默认」方案初始内容。
 * 键码：标准 KeyboardEvent.code（KeyW / KeyA / Space / Digit1 / ArrowUp 等）。
 * 格式：{ 键码: { action: '动作名', type: 'hold'|'tap', pos: [x, y] | null } }
 *   - type: hold=按住（按下触发、松开结束）；tap=单击（按下自动松开）
 *   - pos: 画布内相对位置（0~1）；null = 未校准（需在游戏内 F10 校准）
 * 也可以在启动器存档管理/配置弹窗导出方案 JSON，导入到游戏后覆盖使用。
 */
window.__mdzKeymapPreset = {
  "KeyE": {
    "action": "背包",
    "type": "tap",
    "pos": [0.0266, 0.9472]
  },
  "KeyF": {
    "action": "交互",
    "type": "tap",
    "pos": [0.9719, 0.4847]
  },
  "Space": {
    "action": "攻击",
    "type": "tap",
    "pos": [0.9672, 0.6278]
  },
  "KeyR": {
    "action": "换弹",
    "type": "tap",
    "pos": [0.9688, 0.775]
  },
  "KeyQ": {
    "action": "当前武器切换",
    "type": "tap",
    "pos": [0.9719, 0.95]
  },
  "KeyM": {
    "action": "地图",
    "type": "tap",
    "pos": [0.9773, 0.2014]
  },
  "Tab": {
    "action": "备用武器切换",
    "type": "tap",
    "pos": [0.8953, 0.9514]
  }
};
