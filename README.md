# 像素放置 · PixelIdle

一款像素风放置挂机游戏，为飞牛 fnOS 应用中心开发。

纯 HTML5 Canvas 实现，前端零依赖；后端仅用 Node 内置模块，无数据库。

## 玩法

- 英雄自动攻击敌人，敌人自动反击，全程无需操作
- 击杀获得经验与金币，升级提升属性
- 每击杀 10 只敌人进入下一关，敌人属性按 1.55 倍逐层增长
- 5 种技能可提升：攻击力、最大生命、攻速、暴击率、生命回复
- 存档双写：localStorage + 服务端，支持多端同步；进度按手机/电脑等设备共享
- 离线收益上限 8 小时

## 开发流程（重要）

### 为什么以前每次都要卸载重装

应用中心安装 `.fpk` 时，**版本号必须比已安装的大** 才会走「升级」流程。
如果版本号不变（或更小），系统只能当作重装处理，于是要先卸载——
这就是你每次都要卸载旧版本的根因。

现在用 `scripts/release.sh` 自动递增版本号，这个问题不再出现。

### 三种开发方式

| 方式 | 命令 | 需要 root | 用途 |
| --- | --- | --- | --- |
| ① 开发服务器 | `./scripts/dev.sh` | 否 | **日常开发首选**，改完刷新即可 |
| ② 同步到已装应用 | `sudo ./scripts/sync.sh` | 是 | 在真实网关下验证 |
| ③ 正式发布 | `./scripts/release.sh` | 否 | 升版本 + 打包 + 打标签 |

#### ① 开发服务器（推荐）

```bash
./scripts/dev.sh            # 默认端口 8899
./scripts/dev.sh 9000       # 指定端口
```

- 直接服务 `src/` 目录，**改文件刷新浏览器即生效**，不打包、不安装
- 监听 `0.0.0.0`，可用 `http://<NAS的IP>:8899/app/PixelIdle/` 在电脑上打开
- 存档写到 `.devdata/`，不污染正式数据
- 停止：`kill $(cat .devdata/dev.pid)`

改前端（`src/game.js` / `src/index.html`）**完全不用重启**，
因为服务端每次请求都实时读文件。

#### ② 同步到已安装的应用

想在真实网关 `/app/PixelIdle` 下验证时用：

```bash
sudo ./scripts/sync.sh
```

需要 root，因为已安装目录属主是 `PixelIdle` 用户。
脚本会重建前端、rsync 到 `/vol1/@appcenter/PixelIdle`、重启服务。

#### ③ 正式发布

```bash
./scripts/release.sh patch "修复了xxx"   # 1.0.2 -> 1.0.3
./scripts/release.sh minor "新增装备系统" # 1.0.3 -> 1.1.0
./scripts/release.sh major "重构"        # 1.1.0 -> 2.0.0
```

自动完成：版本号递增 → 更新 changelog → 内联前端 → 打包 `.fpk` → git 提交 → 打 tag。

然后把新的 `PixelIdle.fpk` 在应用中心安装即可，**无需卸载**。

### 源码结构

```
src/            开发源码（可读，带 game.js 独立文件）
  index.html    <script src="game.js">
  game.js       游戏逻辑
app/www/        构建产物（单文件，由 scripts/build-web.js 生成，勿手改）
```

`src/` 只用于开发，不进 `.fpk`；打包时内联成 `app/www/index.html`。

### 确认版本是否生效

- 浏览器打开 `/app/PixelIdle/api/version`
- 或游戏内「设置」页底部查看版本与指纹

指纹由 `index.html` 的大小 + 修改时间生成，一眼可判断是否更新成功。

### 关于「真正的热更新」

需要注意区分两类：

**A. 开发期热更新**（本文档的方式）——改代码即时生效，完全可行，已实现。

**B. 线上自动热更新**（应用自己从服务器拉新版本代码覆盖运行文件）——
技术上能做（服务已有写自身 `www/` 的权限），但**不建议**：

- 绕过应用中心审核，第三方应用上架时通常不被接受
- 拉取通道一旦被劫持等于远程执行任意代码
- 版本状态与 `manifest` 不一致，出问题极难排查

如果只是想让**数值/关卡配置**可变，更安全的做法是抽一个 `config.json`
由服务端下发，逻辑仍随 `.fpk` 版本走。

## 架构（参考 Saltline）

代码按三层组织，新增功能不必改动其他层：

```
TUNE      所有数值常量（唯一平衡入口）
  ↓
Bus       事件总线（模块之间只发事件，不直接调用）
  ↓
Svc       服务定位器（combat / fx / save / render / ui）
```

### TUNE —— 数值集中

攻击曲线、成长公式、敌人属性、手感参数、离线收益全部在文件顶部一个对象里：

```js
TUNE.hero.baseAtk        // 基础攻击
TUNE.stage.tierMul       // 每层敌人倍率
TUNE.feel.hitStopKill    // 击杀顿帧时长
TUNE.telegraph.melee     // 近身攻击预警时长
```

调平衡只改这里，不必翻查逻辑代码。

### Bus —— 事件总线

逻辑层只负责算，表现层订阅事件决定怎么演：

| 事件 | 触发时机 |
| --- | --- |
| `enemy:spawn` | 敌人出现 |
| `enemy:telegraph` | **敌人出手前的预警** |
| `hero:swing` | 英雄命中 |
| `enemy:killed` | 敌人死亡 |
| `hero:hurt` | 英雄受伤 |
| `hero:levelup` | 升级 |
| `stage:change` | 进入下一关 |
| `skill:bought` | 技能升级 |
| `save:written` | 存档写入 |

加新表现（比如音效、成就、连击）只需 `bus.on('enemy:killed', ...)`，
不用碰战斗逻辑。

调试时可在控制台交互：

```js
__pixelidle.bus.on('enemy:killed', e => console.log(e))
__pixelidle.state.gold = 99999
```

### Svc —— 服务定位器

逻辑通过 `Svc.get('fx').hit(...)` 取能力，不依赖具体实现。
想换渲染方式或换成 WebGL，只要替换 `render` 服务，逻辑层零改动。

### 预警机制（telegraph）

借鉴 Saltline：敌人**出手前先进 `windup` 状态**，屏幕给视觉信号，再结算伤害。

```
idle → windup(0.42~0.62s, 红色脉动光环 + 发光爬升) → strike → recover
```

- 近身攻击预警短（0.42s），远程长（0.62s）——威胁越近，反应窗口越紧
- 已用事件计数验证：**37 次受击，0 次缺少前置预警**
- 敌人可能在预警期间被击杀，预警自然中断（不影响平衡）

### 打击感（借鉴 Saltline 的反馈层）

| 手段 | 参数 | 效果 |
| --- | --- | --- |
| 顿帧 | 命中 35ms / 击杀 100ms，时间缩放 0.08 | 命中"咬住" |
| 屏幕抖动 | 命中 1.1 / 击杀 2.6，指数衰减 9/s | 力度分级 |
| 光斑 | 加法混合径向渐变 | 命中闪亮 |
| 暗角 | 径向渐变 | 收拢视线 |
| 受伤红屏 | 0.6s 淡出 | 危险反馈 |

## 构建

```bash
./scripts/release.sh patch "说明"   # 推荐：自动升版本 + 打包
# 或手动打包（不升版本，仅本地测试用）
../tools/fnpack build
```

## 测试

`.fpk` 安装到飞牛设备：

1. 打开 **应用中心** → 手动安装 → 选择 `PixelIdle.fpk`
2. 从桌面打开 **像素放置**
3. 也可用 CLI：`appcenter-cli install-fpk PixelIdle.fpk`

本地不装飞牛直接试玩：打开 `dist/PixelIdle-standalone.html`（单文件，双击即可）。

## 技术说明

### 为什么用统一网关（关键）

**v1.0.0 使用 `index.cgi` 在本机实测无法打开**，已确认根因：

| 访问路径 | 实测结果 |
| --- | --- |
| `/cgi/ThirdParty/PixelIdle/index.cgi/` | 302 重定向 |
| 经 5666 端口访问同一路径 | 200 `invalid token` |

`index.cgi` 路径需要一套 token 机制，第三方应用无法自行满足。
而本机所有能正常工作的应用（miyin、fn-deepseek-harness 等）
**全部使用统一网关**（`gatewayPrefix` + `gatewaySocket`）。

因此 v1.0.1 改为：

```
浏览器 → /app/PixelIdle → fnOS 校验登录态 → target/app.sock → Node 服务
```

- 网关负责鉴权，并通过 `X-Trim-Userid` 等 Header 转发用户身份
- Node 服务监听 Unix Socket，提供静态文件与存档接口
- 依赖 `nodejs_v22` 提供运行时（`install_dep_apps`）

### 服务接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/app/PixelIdle/` | 游戏页面 |
| GET | `/app/PixelIdle/api/save` | 读取当前用户存档，无存档返回 `null` |
| POST | `/app/PixelIdle/api/save` | 保存存档（上限 64KB，校验 JSON） |
| DELETE | `/app/PixelIdle/api/save` | 清除存档 |
| GET | `/app/PixelIdle/api/health` | 健康检查，返回路径与运行状态 |
| GET | `/app/PixelIdle/api/version` | 返回版本号与前端指纹，用于确认更新是否生效 |

服务同时兼容**带前缀**和**不带前缀**的转发，避免网关行为差异导致 404。

### 存档策略

双写：

1. 先写 `localStorage`，保证任何情况下不丢进度
2. 再 `POST` 到服务端，实现多端同步

读取时**优先服务端**，失败回退 `localStorage`。
存档按 `X-Trim-Userid` 隔离，每个用户一个 `save-<uid>.json`。
uid 会做白名单过滤（仅保留字母数字下划线），防止路径注入。

### 安全处理

- 静态文件路径解析后校验仍在 `www/` 内，拒绝目录穿越
- 存档文件按 uid 隔离，uid 白名单过滤
- 存档大小限制 64KB，写入前校验 JSON 合法性
- 响应带 `X-Content-Type-Options: nosniff`

### 目录结构

```
PixelIdle/
├── manifest              # 版本号、依赖 nodejs_v22
├── src/                  # 开发源码（不进 .fpk）
│   ├── index.html
│   └── game.js
├── scripts/
│   ├── dev.sh            # 开发服务器（热更新）
│   ├── sync.sh           # 同步到已安装应用（需 root）
│   ├── release.sh        # 升版本 + 打包 + 打标签
│   └── build-web.js      # src/ 内联为 app/www/index.html
├── app/
│   ├── server/server.js  # 网关后端（零依赖）
│   ├── ui/
│   │   ├── config        # gatewayPrefix + gatewaySocket
│   │   └── images/
│   └── www/index.html    # 构建产物（勿手改）
├── cmd/                  # 生命周期脚本（含升级备份）
└── config/               # privilege / resource
```

### 排错

服务日志：`/vol1/@appdata/PixelIdle/app.log`
健康检查：访问 `/app/PixelIdle/api/health`

若打不开，先确认：

```bash
ls -l /var/apps/PixelIdle/target/app.sock   # socket 是否已创建
cat /vol1/@appdata/PixelIdle/app.log        # 服务是否报错
```
