# MDZ Launcher · macOS 移植版

原项目是 Windows 版 Electron 启动器（`MDZ/resources/app.asar`，作者 QCHAI秋柴，MIT）。
这个目录是把 `app.asar` 还原成可构建工程后、按 macOS 做平台适配的版本。

## 当前状态

已验证可用（macOS 26 / Apple Silicon / Electron 33.4.11）：

| 功能 | 状态 |
|---|---|
| 启动器界面、版本列表、系列分组、封面/图标 | ✅ 截图确认 |
| 用 `version-core` 真实导入 `mdz-cangshu-v233`（写 version.json + 注入存档补丁） | ✅ |
| 启动游戏窗口（`app://` 协议 + 壳页 + 缩放） | ✅ 仓鼠版进入主菜单 |
| 存档隔离（IndexedDB 库名加 `_mdz_cangshu_v233` 后缀） | ✅ 运行时断言 `dbPatch: true` |
| 联机页 UI、信令服务器启停 | ✅（信令服务器纯 Node，mac 可跑） |
| 建房程序（NW.js 服务端包） | ⚠️ 代码已按平台找 `nwjs.app/Contents/MacOS/nwjs`，但需自备 macOS 版 NW.js |
| 打包成 .app / dmg | ⚠️ 未完成，见文末 |

## 目录

```
MDZ-mac/
├── src/            从 app.asar 还原的源码（未压缩、带原注释）
├── versions/       内置版本：minidayz-pc / mdz-plus-v120 / minidayz-mp（+ 已导入的仓鼠版）
├── lan/            局域网工具包（信令服务器 / 客户端分发 / 游戏端模组）
└── package.json    electron 33.4.11 + adm-zip + electron-builder 配置
```

数据目录（运行时）：`~/Library/Application Support/MDZLauncher/{data,versions}`。

## 运行

```bash
cd MDZ-mac
npm install          # 首次；如 npmjs 不通：--registry=https://registry.npmmirror.com
npm start
```

**重要**：如果终端里存在 `ELECTRON_RUN_AS_NODE=1`（部分 Electron 系 IDE / 本会话环境会设置），
`electron .` 会退化成纯 Node 执行并报 `Cannot read properties of undefined (reading 'commandLine')`。解法：

```bash
env -u ELECTRON_RUN_AS_NODE npm start
```

## macOS 适配改了什么

1. **便携模式整体禁用**（`main.js` / `version-manager.js` / `pc-adapter.js`）：
   `.app` 是签名只读包，没有 Windows 那种「便携单文件 exe」；`PORTABLE_EXECUTABLE_DIR` 也不存在。
   mac 上一律用 `~/Library/Application Support/MDZLauncher`，设置页也不再显示便携选项。
2. **菜单体系**（`main.js`）：macOS 的菜单是应用级的，`win.setMenu()` / `setMenuBarVisibility()` 都是空操作。
   改成 `build*Menu` 返回模板数组，由 `setWinMenu()` 决定挂窗口菜单（Windows）还是 `Menu.setApplicationMenu()`（macOS）；
   游戏窗口关闭时 `restoreAppMenu()` 恢复基础菜单。
3. **建房程序可执行文件**（`lan-services.js`）：按平台找 `nw.exe` 或 `nwjs.app/Contents/MacOS/nwjs`；
   停止进程从 `taskkill` 换成 `process.kill(-pid)`。
4. **文案**（`launcher.js`）：联机页里 `nw.exe` 字样在 mac 上显示为 `nwjs（macOS 构建）`。
5. **调试钩子**（`main.js`，仅环境变量触发，不影响正常使用）：
   - `MDZ_SHOT=/path/out.png`：启动器首帧截图后退出
   - `MDZ_VIEW=lan|saves|settings`：截图前切到指定页
   - `MDZ_SHOT2=/path/game.png MDZ_LAUNCH=<版本id>`：再开一次游戏窗口并截图

## 原样保留的关键设计（别改坏）

- 所有版本共用 `app://game` 同源，靠 `dbKey` 给 IndexedDB 库名加后缀做存档隔离；
  `protocol.js` 在 HTML 响应头注入补丁，`version-core.js` 在导入时再写一份。
- zip 导入：路径穿越校验、2 GB / 5 万条目上限、先解到 `.import-*` 再 rename。
- `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`，preload 只暴露白名单 IPC。

## 打包（未完成的最后一步）

`electron-builder` 已装好、配置已写在 `package.json`（`build` 字段，arm64 dmg，`identity: null` 免签名）：

```bash
cd MDZ-mac
npm run pack:mac     # 只出 .app（dist/mac-arm64/）
npm run dist:mac     # 出 dmg
```

需要在**普通终端**里跑（本次会话的沙箱无法执行 `sandbox-exec`/`codesign`，报
`sandbox-exec: data object length ... exceeds maximum`）。产出未签名，首次打开要右键→打开，
或 `xattr -dr com.apple.quarantine "MDZ Launcher.app"`。

打包后体积约 400 MB（Electron 200 MB + 内置版本 80 MB + 已导入的仓鼠版 43 MB）。

## 待办

- [ ] 出 .app / dmg，补 icns 图标（现有 `icon-256.png` 只有 256px，macOS 建议 ≥512）
- [ ] 建房程序：下载 NW.js 的 `osx-arm64` 构建，与 `package.nw` 一起放进 `host/`
- [ ] 全局菜单里「文件 / 显示 / 按键映射」的快捷键在 mac 上按习惯调整（F11 与系统冲突）
- [ ] Apple Developer ID 签名 + notarize（要正式分发时）
