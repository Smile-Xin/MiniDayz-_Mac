# MDZ Launcher · macOS 移植版

把 Windows 版的 Mini DAYZ 多版本启动器移植到 macOS，并额外附一个游戏内修改器。

原项目是 Windows 版 Electron 应用（`MDZ/resources/app.asar`，作者 QCHAI秋柴，MIT 许可）。
本仓库把 `app.asar` 还原成可构建的工程结构，逐项做了 macOS 平台适配，并新增了覆盖在游戏画面上的修改器面板。

- **不修改游戏本体**：所有改动都在启动器层，游戏包原样保留
- **存档自动隔离**：每个版本独立的 IndexedDB 库，互不覆盖
- **修改器只读写运行时内存**：不碰游戏文件，不碰存档文件

---

## 目录

- [功能](#功能)
- [快速开始](#快速开始)
- [添加游戏版本](#添加游戏版本)
- [游戏内修改器](#游戏内修改器)
- [项目结构](#项目结构)
- [实现要点](#实现要点)
- [开发](#开发)
- [macOS 适配差异](#macos-适配差异)
- [打包](#打包)
- [已知限制](#已知限制)
- [许可](#许可)

---

## 功能

### 启动器

| 功能 | 说明 |
|---|---|
| 版本管理 | 用 zip 导入版本，自动写 `version.json`、按系列分组、显示封面与图标 |
| 启动游戏 | `app://` 自定义协议 + 壳页 + 画面缩放，支持窗口 / 全屏、自定义分辨率 |
| 存档管理 | 直接读写各版本 IndexedDB，支持导出、导入、备份、删除（无需启动游戏） |
| 存档传输 | 与安卓端同协议，手机与电脑互相推送存档 |
| 联机配置 | 信令服务器启停、客户端分发、建房程序 |
| 按键映射 | 游戏内 F10 打开校准面板，支持多套方案，可按版本独立保存与导入导出 |
| 游戏内修改器 | 见[下文](#游戏内修改器) |

### 验证状态

已验证环境：macOS 26 / Apple Silicon / Electron 33.4.11。

| 项目 | 状态 |
|---|---|
| 启动器界面、版本列表、系列分组、封面图标 | ✅ 截图确认 |
| 导入 `mdz-cangshu-v233`（仓鼠版） | ✅ 写入 `version.json` 并注入存档补丁 |
| 启动游戏窗口进入主菜单 | ✅ |
| 存档隔离 | ✅ 运行时断言 `dbPatch: true` |
| 联机页 UI、信令服务器启停 | ✅ 信令服务器为纯 Node，mac 可跑 |
| 游戏内修改器 | ✅ 仓鼠版实测：状态锁定、时间冻结、全局变量读写逐项验证 |
| 建房程序（NW.js 服务端包） | ⚠️ 代码已按平台查找 `nwjs.app/Contents/MacOS/nwjs`，需自备 macOS 版 NW.js |
| 打包 .app / dmg | ⚠️ 配置就绪但未产出，见[打包](#打包) |

---

## 快速开始

**环境要求**：macOS（Apple Silicon）、Node.js 18+、npm

```bash
git clone https://github.com/Smile-Xin/MiniDayz-_Mac.git
cd MiniDayz-_Mac
npm install
npm start
```

如果 npmjs 拉取缓慢：

```bash
npm install --registry=https://registry.npmmirror.com
```

> **踩坑提示**：终端里若存在 `ELECTRON_RUN_AS_NODE=1`（部分 Electron 系 IDE 会自动设置），
> `electron .` 会退化成纯 Node 执行，报 `Cannot read properties of undefined (reading 'commandLine')`。
> 改用 `env -u ELECTRON_RUN_AS_NODE npm start` 即可。

启动后是空的版本列表 —— 这是正常的，游戏包需要自己导入，见下一节。

---

## 添加游戏版本

`versions/`（游戏本体）和 `lan/`（局域网工具包）都在 `.gitignore` 中，**仓库只含源码**。
克隆后这两个目录是空的，不是文件缺失。

启动器启动后，点界面上的「导入…」选择游戏 zip：

1. 选中 zip 文件（解压后能找到 `index.html` 的那一层）
2. 启动器校验路径穿越、解压到 `.import-*` 临时目录后再改名，安全落地
3. 写入 `version.json` 并注入存档隔离补丁，版本随即出现在列表中

已验证可导入的构建：`mdz-cangshu-v233`（仓鼠版）、`minidayz-pc`、`mdz-plus-v120`、`minidayz-mp`。

游戏包是第三方资源，不随本仓库分发，请自行合法取得。

---

## 游戏内修改器

启动器侧栏「修改器」页配置两个参数：**是否注入**、**热键**（F6–F9，默认 F8）。

覆盖层代码在 `src/renderer/trainer/`（`trainer.js` + `trainer.css`），挂在游戏壳页顶层，
通过同源 iframe 访问 Construct 2 运行时，**只在运行时读写内存数值**。

| 页签 | 功能 |
|---|---|
| **角色** | 生命 / 饥饿 / 口渴 / 体温四项滑块（实时写入，每 120ms 锁回指定值）、全恢复、上帝模式（`God_mode`）、敌人伤害归零 |
| **世界** | 设置当前时刻、冻结时间、下雨、物资刷新间隔、僵尸刷新间隔 |
| **成长** | 业力 / 经验直接写入、一键解锁全部 `perk_*` |
| **调试** | 玩家对象定位诊断、610 个全局变量的搜索与就地改值 |

**热键**

| 键 | 作用 |
|---|---|
| `F8` | 显示 / 收起修改器面板 |
| `F9` | 全恢复（四项状态拉满） |
| `F10` | 打开按键映射校准面板（这是游戏原有功能，不冲突） |

时间冻结需要持续写回 —— 游戏每帧自增 `Timer_ALL`，写一次会被立刻覆盖，
所以「冻结」的实现是每 tick 重新赋值，而不是设个标志位。

---

## 项目结构

```
MDZ-mac/
├── src/main/       主进程（19 个模块，职责见下表）
├── src/preload/    launcher-preload（白名单 IPC） / game-preload（游戏页桥）
├── src/renderer/   启动器界面 + 修改器覆盖层
├── versions/       游戏版本目录（不入库，见「添加游戏版本」）
├── lan/            局域网工具包（不入库）
└── package.json    electron 33.4.11 + adm-zip + electron-builder 配置
```

运行时数据目录：`~/Library/Application Support/MDZLauncher/{data,versions}`

### 主进程模块

| 模块 | 职责 | 依赖方向 |
|---|---|---|
| `main.js` | 启动编排：定数据目录 → 初始化各子系统 → 注册 IPC → 开窗口 → 生命周期 | 只依赖下面的模块 |
| `app-paths.js` | 数据目录布局、便携模式引导、profile 迁移 | → `version-core` |
| `version-core.js` | 纯 Node 逻辑：zip 检查与安全解压、`index.html` 注入、版本目录扫描 | 无（可单独 require） |
| `version-manager.js` | 配置读写（分辨率 / 按键映射 / 联机设置）、版本增删、模式切换 | → `version-core`、`app-paths` |
| `builtin-sync.js` | 清理历史遗留的内置版副本（不动用户自己导入的版本） | → `version-manager` |
| `protocol.js` | `app://` 自定义协议：启动器 UI、版本静态文件、HTML 响应注入存档补丁 | → `mp-paths` |
| `mp-paths.js` | 「多人版客户端目录可能在哪」的唯一知识来源 | 无 |
| `game-windows.js` | 游戏窗口控制器：direct / 壳页 / 服务器客户端，含画面模式与分辨率切换 | → `menus`、`keymap-tools`、`inject-scripts`、`game-version` |
| `menus.js` | 三套原生菜单模板 + macOS / Windows 挂载策略 | → electron `Menu` |
| `game-version.js` | 版本规则：是否键鼠原生、默认分辨率、合成联机客户端 | 无 |
| `keymap-tools.js` | 按键映射结构规范化、导入导出文件 | → electron `dialog` |
| `inject-scripts.js` | 注入到游戏页的脚本片段（存档隔离、mapper、画面缩放、修改器加载） | 无 |
| `ipc.js` | 全部 34 个 IPC 通道 | → `keymap-tools`、`game-version` |
| `lan-services.js` | 信令服务器、客户端分发、建房程序、本地客户端 | → `version-manager`、`mp-paths` |
| `save-io.js` | 存档导出：渲染层采集好数据，主进程弹「另存为」写盘 | → electron `dialog` |
| `save-transfer.js` | 存档传输服务管理（与安卓端同协议） | → `mdz-save-service` |
| `mdz-save-service.js` | 零依赖 HTTP 存档服务，作为注入手机 APK 的桥接脚本的接收端 | 无（只用 Node 内置模块） |
| `dev-harness.js` | 开发期截图钩子 + console 格式化 | 无 |
| `uitest.js` | `MDZ_UITEST=1` 时的 UI 全路径回归 | → `dev-harness` |

依赖只允许自上而下：`main → 控制器/服务 → 纯逻辑`。
纯逻辑模块（`version-core`、`mp-paths`、`game-version`、`inject-scripts`、`mdz-save-service`）
不依赖 Electron，方便单测和脚本复用。

### 渲染层

| 文件 | 职责 |
|---|---|
| `index.html` / `launcher.css` | 启动器界面骨架与样式 |
| `launcher.js` | 主逻辑，与上游网页版共用（刻意保持 ES5 写法） |
| `pc-adapter.js` | 平台适配层：注入 `window.__mdzPlatform`、PC 独有的导入按钮与数据目录卡 |
| `save-manager.js` | 启动器页内的 IndexedDB 读写（与游戏同源，无需启动游戏） |
| `mapper.js` | 按键映射器，注入游戏 iframe，F10 开关校准面板 |
| `mdz-keymap-preset.js` | 默认键位方案，部署后可直接改此文件而无需重新打包 |
| `game-window.html` | 游戏窗口壳页，负责 iframe 布局与修改器注入 |
| `trainer/` | 修改器覆盖层（`trainer.js` + `trainer.css`） |

---

## 实现要点

### 存档隔离

所有版本共用 `app://game` 同源（这样才能跨版本操作 IndexedDB），
靠 `dbKey` 给库名加后缀实现隔离：`_C2SaveStates_<dbKey>` / `localforage_<dbKey>`。

补丁在两处写入，互为兜底：`protocol.js` 在 HTML 响应头注入，`version-core.js` 在导入时再写一份。

### 安全边界

这几条是刻意设计，改动前请先想清楚：

- 所有窗口 `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`，
  preload 只暴露白名单 IPC，渲染层拿不到 Node。
- zip 导入做路径穿越校验，限制 2 GB / 5 万条目，先解到 `.import-*` 再原子改名，
  避免半成品目录被当成有效版本。
- 局域网存档服务默认无鉴权，设了配对码（token）后 `/save*`、`/saves` 都要求携带。

### 修改器的两条注入链路

| 播放方式 | 壳页 | 注入点 |
|---|---|---|
| 窗口模式（独立窗口） | `game-window.html`，URL 带 `&tr=1&trk=<hotkey>` | `injectTrainer()` 插入 `<script>`；直开窗口走 `inject-scripts.trainerLoader` |
| 内嵌画面（启动器内 iframe） | `index.html`（启动器自身） | `launcher.js` 的 `ensureTrainerOverlay()`，在 `gameReady` 回调中调用 |

覆盖层始终挂在**顶层壳页**上，通过同源 iframe 拿 `cr_getC2Runtime()`。
`gameWindow()` 优先找 `#embed-frame`，其次找任意带运行时的 iframe。
关闭播放时 `closePlayer()` 会先收起面板 —— 这行必须放在函数最前面，
否则后面的 `renderDetail()` 一旦抛异常，面板就会残留在启动器上。

### 玩家状态字段实测

`data.js` 里对象类型名和实例变量名都是混淆的，只能实测。仓鼠版 `mdz-cangshu-v233`（签名 `1429:610`）结果：

| 状态 | 实例变量 | HUD 条对象 | 满值宽度 |
|---|---|---|---|
| 饥饿 | `cc[13]` | `t3` | 72 px |
| 口渴 | `cc[14]` | `t8` | 72 px |
| 体温 | `cc[16]` | `t11` | 72 px |
| 生命 | `cc[50]` | `t27` | 72 px |

四个状态**并不连续**，这是最容易踩的坑：

1. `cc[15]` 是个滚动计数器（每帧上涨、会归零）。按「连续 4 个变量」扫描会读出「生命 13750」这种数字，
   生命实际在 `cc[50]`。
2. `t2` 是生命条左侧那根 72px 的**底色框，不是填充**，写血量它不会变 —— 别拿它判断对错。
3. 状态条不是每帧轮询，**直接写变量后 HUD 可能不刷新**。要确认写对了，看读回来的数值，
   或者用「把衰减速率调大（`Starving_current` / `Player_temperature`）再对所有实例变量做差异对比」反推下标。
4. `DEFAULT_OFFSETS` 只对签名 `1429:610` 实测过（记录在 `VERIFIED_SIGS`）。其他构建仍用默认偏移，
   但调试页会标注「未校核」—— 宁可提示，也不要悄悄往错误字段写数。

---

## 开发

### 代码约定

- 主进程统一 ES2015+：`const`/`let`、`camelCase`、早返回，不用 `var`；
  渲染层 `launcher.js` 与上游网页版共用，保持 ES5 写法避免两套代码分叉。
- 函数做一件事，超过约 40 行就考虑拆；`main.js` 里只允许出现「创建 + 接线」，不允许出现业务分支。
- 平台差异集中在三处：`IS_MAC` 常量、`menus.createMenuHost`、`lan-services.HOST_BIN_CANDIDATES`。
  新增平台分支前先检查这三处能否覆盖。
- 外部资源失败一律降级而不是抛错（协议层缺图返回透明 PNG、单条 profile 复制失败继续、注入失败只 warn），
  只有「用户操作导致的数据问题」才 throw 给界面显示。
- 每个模块头部注释写「为什么」，行内注释写「反直觉的点」
  （例如为什么必须在 `dom-ready` 前注入、为什么不能在菜单点击回调里重建菜单）。

### 改动后怎么验证

```bash
# 1) 语法检查
for f in src/main/*.js src/preload/*.js src/renderer/*.js src/renderer/trainer/*.js; do
  node --check "$f" || echo "FAIL $f"
done

# 2) 冒烟：应看到 versions found: N → game did-finish-load OK → hasCanvas:true
MDZ_SMOKE=1 env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .

# 3) 逐页截图（纯 UI 页面在改动前后应逐字节一致）
MDZ_VIEW=lan MDZ_SHOT=/tmp/v-lan.png env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .

# 4) 游戏窗口 + 存档隔离：日志里 dbPatch 应为 true
MDZ_SHOT=/tmp/a.png MDZ_SHOT2=/tmp/g.png MDZ_LAUNCH=mdz-cangshu-v233 \
  env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .
```

> 游戏画面带随机背景动画，两次运行的截图 hash 必然不同，**别把游戏截图当回归基准**。
> 判断游戏是否正常，看日志里的 URL、`hasFrame`、`dbPatch` 三个字段。

### 调试环境变量

均需环境变量触发，不影响正常使用。

| 变量 | 作用 |
|---|---|
| `MDZ_SHOT=/path/out.png` | 启动器首帧截图后退出 |
| `MDZ_VIEW=versions\|saves\|lan\|settings\|transfer` | 截图前切到指定页 |
| `MDZ_SHOT2=/path/game.png MDZ_LAUNCH=<版本id>` | 再开一次游戏窗口并截图，打印 URL / iframe / 存档补丁状态 |
| `MDZ_SMOKE=1` | 冒烟：列版本 → 启动首个版本 → 等 `did-finish-load` 后退出 |
| `MDZ_UITEST=1` | 渲染层全路径回归（依赖真实窗口，较慢） |
| `MDZ_TIMING=1` | 打印启动各阶段耗时 |
| `MDZ_DEVTOOLS=1` | 给每个窗口开 DevTools |
| `MDZ_SOFT=1` | 回退软件渲染（GPU 异常时用） |

---

## macOS 适配差异

1. **便携模式整体禁用**（`app-paths.js` / `version-manager.js` / `pc-adapter.js`）：
   `.app` 是签名只读包，没有 Windows 那种「便携单文件 exe」，`PORTABLE_EXECUTABLE_DIR` 也不存在。
   macOS 上一律用 `~/Library/Application Support/MDZLauncher`，设置页不再显示便携选项。
2. **菜单体系**（`menus.js`）：macOS 菜单是应用级的，`win.setMenu()` / `setMenuBarVisibility()` 都是空操作。
   三个 `build*Menu` 只返回模板数组，由 `createMenuHost(isMac)` 决定挂窗口菜单（Windows）
   还是 `Menu.setApplicationMenu()`（macOS）；游戏窗口关闭时 `restoreAppMenu()` 恢复基础菜单。
3. **建房程序可执行文件**（`lan-services.js`）：按平台找 `nw.exe` 或 `nwjs.app/Contents/MacOS/nwjs`；
   停止进程从 `taskkill` 换成 `process.kill(-pid)`。
4. **文案**（`launcher.js`）：联机页里 `nw.exe` 字样在 mac 上显示为 `nwjs（macOS 构建）`。

---

## 打包

`electron-builder` 已配置在 `package.json` 的 `build` 字段（arm64 dmg，`identity: null` 免签名）：

```bash
npm run pack:mac     # 只出 .app（dist/mac-arm64/）
npm run dist:mac     # 出 dmg
```

需要在**普通终端**里运行（沙箱环境无法执行 `sandbox-exec` / `codesign`，
会报 `sandbox-exec: data object length ... exceeds maximum`）。

产出未签名，首次打开需右键 → 打开，或执行：

```bash
xattr -dr com.apple.quarantine "MDZ Launcher.app"
```

打包后体积约 400 MB（Electron 200 MB + 内置版本 80 MB + 已导入版本 43 MB）。

---

## 已知限制

- **未签名**：没有 Apple Developer ID，正式分发前需要签名 + notarize
- **仅 Apple Silicon**：`build` 里只配了 `arm64`，Intel Mac 需自行改 target
- **建房程序需自备 NW.js**：代码会按平台查找 `nwjs.app/Contents/MacOS/nwjs`，
  但仓库不含 macOS 版 NW.js 运行时
- **图标分辨率不足**：现有 `icon-256.png` 只有 256px，macOS 建议 ≥512
- **修改器偏移只校核过一个构建**：其他构建的状态读数仅供参考，见[上文](#玩家状态字段实测)

### 待办

- [ ] 出 .app / dmg，补 512px 以上的 icns 图标
- [ ] 建房程序：下载 NW.js `osx-arm64` 构建，与 `package.nw` 一起放进 `host/`
- [ ] 全局菜单快捷键按 macOS 习惯调整（F11 与系统冲突）
- [ ] Apple Developer ID 签名 + notarize

---

## 许可

启动器代码采用 MIT（见 [`LICENSE`](LICENSE)），保留两个版权声明：

- 原始 Windows 版 MDZ Launcher：QCHAI秋柴
- macOS 移植、本仓库的修改与游戏内修改器：Smile Xin（2026）

许可证**只覆盖代码**。MiniDayZ 及任何游戏本体、素材的版权归各自权利人所有，
仓库不分发这些内容（`versions/` 在 `.gitignore` 中）。使用本启动器请自行合法取得游戏包。
