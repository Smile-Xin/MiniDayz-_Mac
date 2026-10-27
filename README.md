# MDZ Launcher · macOS 移植版

原项目是 Windows 版 Electron 启动器（`MDZ/resources/app.asar`，作者 QCHAI秋柴，MIT）。  
这个目录是把 `app.asar` 还原成可构建工程后、按 macOS 做平台适配的版本。

## 当前状态

已验证可用（macOS 26 / Apple Silicon / Electron 33.4.11）：

| 功能                                                                | 状态                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------ |
| 启动器界面、版本列表、系列分组、封面/图标                                             | ✅ 截图确认                                                       |
| 用 `version-core` 真实导入 `mdz-cangshu-v233`（写 version.json + 注入存档补丁） | ✅                                                            |
| 启动游戏窗口（`app://` 协议 + 壳页 + 缩放）                                     | ✅ 仓鼠版进入主菜单                                                   |
| 存档隔离（IndexedDB 库名加 `_mdz_cangshu_v233` 后缀）                        | ✅ 运行时断言 `dbPatch: true`                                      |
| 联机页 UI、信令服务器启停                                                    | ✅（信令服务器纯 Node，mac 可跑）                                        |
| 游戏内修改器（覆盖层面板，F8 显示 / F9 全恢复）                                     | ✅ 仓鼠版实测：状态锁定、时间冻结、全局变量读写逐项验证                                 |
| 建房程序（NW.js 服务端包）                                                  | ⚠️ 代码已按平台找 `nwjs.app/Contents/MacOS/nwjs`，但需自备 macOS 版 NW.js |
| 打包成 .app / dmg                                                    | ⚠️ 未完成，见文末                                                   |

## 目录

```
MDZ-mac/
├── src/main/       主进程（模块职责见下）
├── src/preload/    两个 preload：launcher（白名单 IPC）/ game（游戏页桥）
├── src/renderer/   启动器界面（index.html + launcher.js + 平台适配层）
├── versions/       游戏版本目录（**不入库**，见「获取游戏版本」）
├── lan/            局域网工具包（信令服务器 / 客户端分发 / 游戏端模组，**不入库**）
└── package.json    electron 33.4.11 + adm-zip + electron-builder 配置
```

数据目录（运行时）：`~/Library/Application Support/MDZLauncher/{data,versions}`。

### 主进程模块地图

| 模块 | 职责 | 依赖方向 |
|---|---|---|
| `main.js` | 启动编排：定数据目录 → 初始化各子系统 → 注册 IPC → 开窗口 → 生命周期 | 只依赖下面的模块 |
| `app-paths.js` | 数据目录布局、便携模式引导、profile 迁移 | → `version-core` |
| `version-core.js` | 纯 Node 逻辑：zip 检查/安全解压、`index.html` 注入、版本目录扫描 | 无（可单独 require） |
| `version-manager.js` | 数据目录里的配置读写（分辨率/按键映射/联机设置）、版本增删、模式切换 | → `version-core`、`app-paths` |
| `builtin-sync.js` | 清理历史遗留的内置版副本（不改用户自己导入的版本） | → `version-manager` |
| `protocol.js` | `app://` 自定义协议：启动器 UI、版本静态文件、HTML 响应注入存档补丁 | → `mp-paths` |
| `mp-paths.js` | 「多人版客户端目录可能在哪」的唯一知识来源 | 无 |
| `game-windows.js` | 游戏窗口控制器：direct / 壳页 / 服务器客户端，含画面模式与分辨率切换 | → `menus`、`keymap-tools`、`inject-scripts`、`game-version` |
| `menus.js` | 三套原生菜单模板 + mac/Windows 挂载策略 | → electron `Menu` |
| `game-version.js` | 版本规则：是否键鼠原生、默认分辨率、合成联机客户端 | 无 |
| `keymap-tools.js` | 按键映射结构规范化 / 导入导出文件 | → electron `dialog` |
| `inject-scripts.js` | 注入到游戏页的脚本片段（存档隔离、mapper、画面缩放） | 无 |
| `ipc.js` | 全部 34 个 IPC 通道 | → `keymap-tools`、`game-version` |
| `lan-services.js` | 信令服务器、客户端分发、建房程序、本地客户端 | → `version-manager`、`mp-paths` |
| `save-transfer.js` | 存档传输服务管理（与安卓端同协议） | → `mdz-save-service` |
| `dev-harness.js` | 开发期截图钩子 + console 格式化 | 无 |
| `uitest.js` | `MDZ_UITEST=1` 的 UI 全路径回归 | → `dev-harness` |

依赖只允许自上而下：`main → 控制器/服务 → 纯逻辑`。纯逻辑模块（`version-core`、`mp-paths`、`game-version`、`inject-scripts`）不依赖 Electron，方便单测与脚本复用。

### 代码约定

- 主进程统一 ES2015+：`const`/`let`、`camelCase`、早返回，不用 `var`；渲染层 `launcher.js` 与上游网页版共用，保持 ES5 写法避免两套代码分叉。
- 函数做一件事，超过约 40 行就考虑拆；`main.js` 里只允许出现「创建 + 接线」，不允许出现业务分支。
- 平台差异集中在三处：`IS_MAC` 常量、`menus.createMenuHost`、`lan-services.HOST_BIN_CANDIDATES`。新增平台分支前先检查这三处能否覆盖。
- 外部资源失败一律降级而不是抛错（协议层缺图返回透明 PNG、单条 profile 复制失败继续、注入失败只 warn），只有「用户操作导致的数据问题」才 throw 给界面显示。
- 每个模块头部注释写「为什么」，行内注释写「反直觉的点」（例如为什么必须在 `dom-ready` 前注入、为什么不能在菜单点击回调里重建菜单）。

## 获取游戏版本

`versions/`（游戏本体）和 `lan/`（局域网工具包）都在 `.gitignore` 里，**仓库只含源码**。
克隆后这两个目录是空的，启动器会提示还没有任何版本 —— 这是正常的，不是文件缺失。

用界面的「导入…」加入自己准备好的游戏包：

1. `npm start` 打开启动器
2. 点「导入…」，选中游戏 zip（解压后能找到 `index.html` 的那一层）
3. 启动器写入 `version.json`、注入存档隔离补丁，随后出现在版本列表里

游戏包是第三方资源，不随本仓库分发。已验证可导入的构建：`mdz-cangshu-v233`（仓鼠版）、
`minidayz-pc`、`mdz-plus-v120`、`minidayz-mp`。

> 修改器的四个状态下标是按仓鼠版实测校准的。换其他构建时「调试」页会标注「未校核」，
> 全局变量、时间、上帝模式等功能仍可用，但别直接采信生命/饥饿/口渴/体温那四行读数。

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

1. **便携模式整体禁用**（`app-paths.js` / `version-manager.js` / `pc-adapter.js`）：  
   `.app` 是签名只读包，没有 Windows 那种「便携单文件 exe」；`PORTABLE_EXECUTABLE_DIR` 也不存在。  
   mac 上一律用 `~/Library/Application Support/MDZLauncher`，设置页也不再显示便携选项。
2. **菜单体系**（`menus.js`）：macOS 的菜单是应用级的，`win.setMenu()` / `setMenuBarVisibility()` 都是空操作。  
   三个 `build*Menu` 只返回模板数组，由 `createMenuHost(isMac)` 决定挂窗口菜单（Windows）还是 `Menu.setApplicationMenu()`（macOS）；  
   游戏窗口关闭时 `restoreAppMenu()` 恢复基础菜单。
3. **建房程序可执行文件**（`lan-services.js`）：按平台找 `nw.exe` 或 `nwjs.app/Contents/MacOS/nwjs`；  
   停止进程从 `taskkill` 换成 `process.kill(-pid)`。
4. **文案**（`launcher.js`）：联机页里 `nw.exe` 字样在 mac 上显示为 `nwjs（macOS 构建）`。
5. **调试钩子**（`dev-harness.js`，仅环境变量触发，不影响正常使用）：
   - `MDZ_SHOT=/path/out.png`：启动器首帧截图后退出
   - `MDZ_VIEW=versions|saves|lan|settings|transfer`：截图前切到指定页
   - `MDZ_SHOT2=/path/game.png MDZ_LAUNCH=<版本id>`：再开一次游戏窗口并截图（会打印 URL / iframe / 存档补丁状态）
   - `MDZ_SMOKE=1`：冒烟（列版本 → 启动首个版本 → 等 `did-finish-load` 后退出）
   - `MDZ_UITEST=1`：渲染层全路径回归（依赖真实窗口，较慢）
   - `MDZ_TIMING=1`：打印启动各阶段耗时；`MDZ_DEVTOOLS=1`：给每个窗口开 devtools；`MDZ_SOFT=1`：回退软件渲染

## 改动后怎么验证

重构/改动主进程后，按这四步确认没有行为变化：

```bash
cd MDZ-mac

# 1) 语法
for f in src/main/*.js src/preload/*.js src/renderer/*.js; do node --check "$f" || echo "FAIL $f"; done

# 2) 冒烟：应看到 versions found: N → game did-finish-load OK → hasCanvas:true
MDZ_SMOKE=1 env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .

# 3) 逐页截图（纯 UI 页面在改动前后应逐字节一致）
MDZ_VIEW=lan MDZ_SHOT=/tmp/v-lan.png env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .

# 4) 游戏窗口 + 存档隔离：日志里 dbPatch 应为 true
MDZ_SHOT=/tmp/a.png MDZ_SHOT2=/tmp/g.png MDZ_LAUNCH=mdz-cangshu-v233 env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .
```

注意：游戏画面带随机背景动画，两次运行的截图 hash 必然不同，别把游戏截图当回归基准；  
要判断游戏是否正常，看日志里的 URL、`hasFrame`、`dbPatch` 三个字段。

## 游戏内修改器

启动器侧栏「修改器」页只配两个参数：是否注入、热键（F6–F9，默认 F8）。  
覆盖层本身是 `src/renderer/trainer/`（`trainer.js` + `trainer.css`），**不修改游戏文件、不碰存档文件**，
只在运行时读写内存里的数值：

- **角色**：生命 / 饥饿 / 口渴 / 体温（滑块实时写、每 120ms 锁回指定值）、全恢复（F9）、上帝模式（`God_mode`）、敌人伤害归零
- **世界**：设置当前时刻、冻结时间（游戏每帧自增 `Timer_ALL`，所以冻结是持续写回）、下雨、物资/僵尸刷新间隔
- **成长**：业力 / 经验直接写入、一键解锁全部 `perk_*`
- **调试**：玩家对象定位诊断、610 个全局变量的搜索与就地改值

### 两条注入链路

| 播放方式 | 壳页 | 注入点 |
|---|---|---|
| 窗口模式（独立 `game-window`） | `game-window.html`（URL 带 `&tr=1&trk=<hotkey>`） | `injectTrainer()` 插 `<script>`；直开窗口走 `inject-scripts.trainerLoader` |
| 内嵌画面（启动器里 iframe） | `index.html`（启动器自己） | `launcher.js` 的 `ensureTrainerOverlay()`，在 `gameReady` 里调用 |

覆盖层始终挂在**顶层壳页**上，通过同源 iframe 拿 `cr_getC2Runtime()`；`gameWindow()` 优先找 `#embed-frame`，
其次找任意带运行时的 iframe。关闭播放时 `closePlayer()` 会先收起面板（放在函数最前面，
避免后面 `renderDetail()` 抛异常导致面板残留）。

### 玩家状态字段（重要，别照搬「连续 4 个」的想当然）

`data.js` 的对象名与实例变量名都是混淆的，只能实测。仓鼠版 `mdz-cangshu-v233`（签名 `1429:610`）实测：

| 状态 | 实例变量 | HUD 条对象 | 满值宽度 |
|---|---|---|---|
| 饥饿 | `cc[13]` | `t3` | 72 |
| 口渴 | `cc[14]` | `t8` | 72 |
| 体温 | `cc[16]` | `t11` | 72 |
| 生命 | `cc[50]` | `t27` | 72 |

四点注意：

1. **四个状态不连续**：`cc[15]` 是个滚动计数器（每帧上涨、会归零），早期按「连续 4 个变量」去扫，
   才会读出「生命 13750」这种离谱数字；生命实际在 `cc[50]`。
2. `t2`（生命条左边那根 72px 的条）是**底色框不是填充**，所以写血量它不会变——别用它判断对错。
3. 状态条不是每帧轮询，**直接写变量后 HUD 可能不刷新**；判断是否写对应看 `读回来的数值`，
   或者用「把衰减速率调大（`Starving_current` / `Player_temperature`）再差异对比」的办法反推下标。
4. `DEFAULT_OFFSETS` 只对签名 `1429:610` 做过实测（`VERIFIED_SIGS`）。其他构建仍会用默认偏移，
   但调试页会标注「未校核」——宁可提示，也不要悄悄往错误字段写数。

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
