# 像素放置 · PixelIdle

一款像素风放置挂机游戏，为飞牛 fnOS 应用中心开发。

纯 HTML5 Canvas 实现，前端零依赖；后端仅用 Node 内置模块，无数据库。

[MIT License](LICENSE) · 仓库：https://github.com/cancan315/PixelIdle

## 玩法

- 英雄自动攻击敌人，敌人自动反击，全程无需操作
- **御剑攻击**：英雄掷出飞剑，剑飞到敌人身上才结算伤害（命中瞬间触发暴击闪光、火花与顿帧）
- 击杀获得经验与金币，升级提升属性
- 每个关卡 10 只敌人：前 5 普通、6–9 精英、10 首领；打完首领并达到等级要求才进入下一关
- **关卡门槛**：普通怪需四槽稀有、精英需传说、首领需传说且强化 +10（不达标自动退回上一关刷取）
- **强化系统**：强化石按关卡等级掉落，每级 3 颗、每级 +6%，上限 +10
- 5 种技能可提升：攻击力、最大生命、攻速、暴击率、生命回复
- **装备系统**：4 槽位 / 3 品质（普通·稀有·传说）/ 自动装备；按怪物种类固定掉落，实测增益 +24%~+45%
- **敌人变体**：第 7 关起出现「精英 / 腐化」变体，配色不同、属性更强、金色或绿色描边
- **关卡背景**：每个关卡背景都不一样，按本关怪物种类生成（沼泽 / 洞窟 / 墓园 / 熔岩）
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
  index.html    按顺序引入下面两个脚本
  game.js       游戏逻辑
  vendor/
    pixelfx.fx.js   pixelfx 特效包（由 scripts/build-fx.js 生成，勿手改）
vendor/pixelfx/ pixelfx 源码子集（MIT，见 THIRD-PARTY-NOTICES.md）
app/www/        构建产物（单文件，由 scripts/build-web.js 生成，勿手改）
```

`src/` 只用于开发，不进 `.fpk`；打包时按 `index.html` 里的顺序内联成 `app/www/index.html`。
顺序不能乱：`pixelfx.fx.js` 定义的 `PixelFX` 必须先于 `game.js` 出现。

### 特效系统（pixelfx）

命中特效来自 [patch-gg/pixelfx](https://github.com/patch-gg/pixelfx)（MIT）。
它是 ES Module，而本项目是单文件零依赖，所以多了一层构建：

```
vendor/pixelfx/  --esbuild-->  src/vendor/pixelfx.fx.js  --内联-->  app/www/index.html
```

```bash
node scripts/build-fx.js     # 改了 vendor/ 或入口清单后要跑
node scripts/build-web.js    # 内联成单文件
npm run build                # 两步一起
```

`scripts/release.sh` 已包含这两步，正常发版不用手动跑。

想加新特效：编辑 `vendor/pixelfx/entry.js` 增加 import/export，再跑一遍构建。
每个特效约增加 2~6 KB（压缩后），核心部分是一次性成本（约 19 KB）。
没有被 `entry.js` 引用的特效不会进产物。

游戏侧通过 `Svc.get('film')` 使用，它是一个独立图层：

```js
Svc.get('film').hit(x, y, crit)        // 命中特效
Svc.get('film').play(mod, x, y, opts)  // 播任意已打包的特效
```

用独立离屏 canvas 而不是直接画在舞台上，是为了不动 `render` 的绘制模型。
若 `pixelfx.fx.js` 缺失，`film` 会安静降级为零特效，游戏照常运行。

> 关卡与强化规则见 [docs/STAGE-DESIGN.md](docs/STAGE-DESIGN.md)。

> 升级上游：`./scripts/vendor-pixelfx.sh [git URL 或本地路径]`，
> 它会重新拉取被引用的文件并逐字节校验。除 `core/index.js`（有意裁剪过）外，
> vendor 下的文件应与上游完全一致。

### 美术资源（零图片文件）

游戏画面里没有任何 `.png` / `.jpg`，全部由代码生成或还原：

| 类别 | 做法 |
| --- | --- |
| 精灵（主角/敌人/飞剑） | 手绘像素写成 ASCII 字母矩阵 + 调色板表，运行时查表转成 `ImageData` → 离屏 canvas |
| 关卡背景 | CPU 2D 程序化：按怪物种类选主题 + 按关卡号做差异（见下） |
| 特效 | pixelfx 粒子模拟（见上） |

精灵示例（`SPRITES`）：

```js
skeleton: {
  pal: { s: '#e8e6d8', d: '#a8a597', e: '#ff5b5b', k: '#2a2a35' },
  art: ['...ssss...', '..ssssss..', '..sessse..', ...]
}
```

**注意**：像素的颜色是**人写死的**，代码只负责查表。这和「程序化噪声生成贴图」是两回事——
像素风的可读性恰恰来自每个像素都被刻意放置。

#### 关卡背景

**每 10 个敌人一关**（`TUNE.stage.enemiesPerStage = 10`）。每关的背景不同，
由两层决定：

1. **主题**：`TUNE.themes` 按本关出现的**怪物种类**选配色与装饰

   | 怪物 | 主题 | 装饰 |
   | --- | --- | --- |
   | slime | 沼泽 | 远景树、水洼、上浮孢子 |
   | bat | 洞窟 | 钟乳石岩顶、石笋、发光水晶 |
   | skeleton | 墓园 | 月亮、墓碑、枯树、低空雾 |
   | golem | 熔岩 | 岩脊、地面裂缝、上升火星、岩浆脉动 |

2. **关卡种子**：`stage` 作为随机种子，抖动山体数量/振幅/明度、星星位置、
   装饰位置数量 —— 所以同为沼泽的第 1 关和第 7 关看起来也不一样。

实现上分两半：

- **静态部分**烘焙成一张 320×180 的离屏 canvas，只在**换关**时重建
- **动态部分**（孢子/火星/雾/水晶脉动/星光）每帧叠加，≤ 26 个点

这样背景不占逐帧开销：整帧渲染 **0.21 ms**（含换关时重建背景）。

#### 调色板皮肤（敌人变体）

`SKINS` 给同一份 `art` 换一套 `pal`，就是新变体，**零新增像素、零体积增长**：

```js
SKINS.golem = {
  elite:     { g: '#b8a8ff', d: '#6b5f9a', c: '#ffd23c' },   // 金边紫岩
  corrupted: { g: '#7a6a52', d: '#4a3f2e', c: '#8dff5a' }    // 绿边腐岩
};
```

变体由 `TUNE.variants` 控制，在 `tier >= 1`（第 7 关起）按关卡号**确定性**出现：

```js
TUNE.variants.elite = { skin:'elite', label:'精英',
  hpMul:1.8, atkMul:1.35, goldMul:2.4, xpMul:1.9, every:11, at:4 };
```

变体除了配色，还在精灵外圈描一圈变体色轮廓光（`SKIN_OUTLINE`），
一眼就能分辨「这只不一样」——不用文字，因为 7px 的中文看不清。

#### 损伤贴花

敌人血量降到 75% / 50% / 25% 三档时，叠加一层预先算好的硬边损伤图：

- **掉块**：轮廓边缘的 2×2 块以较高概率被打成近黑，越靠边越先崩
- **污渍**：整块压暗，保留色相

三条经验都踩过坑：

1. 必须**按 2×2 块**判定，不能逐像素——方块状精灵的边是一整列，逐像素会啃出一条条竖直暗带
2. 密度必须低，10×12 的精灵塞满噪点就糊成脏污
3. 损伤图在**构建期算好**（用确定性哈希，不随机），否则每帧重算会闪

#### 缓存

`spriteCache` 的 key 是 `name::skin`（`spriteKey()`）。**不含皮肤的 key 会导致换表不生效**——
这是做变体时最容易漏的一处。

实测：建全部缓存 + 首帧 11 ms，渲染 0.474 ms/帧（320×180，含背景/轮廓光/损伤/特效层）。

> 这套「同配方出多变体」的思路参考了 [Saltline](https://github.com/) 的程序化材质系统
> （一个 `surf()` 配方配不同 `seed` 出无数张贴图）。但 PixelIdle 的美术是手绘数据，
> 形状改不了，所以只取了「调色板这一层」——形状变体仍需要重画字母矩阵。

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

**写入（双写）**

1. 同步写 `localStorage` —— 保证任何情况下不丢
2. 异步 `POST /api/save` —— 服务端留一份，支持多端

**触发时机**

| 时机 | 说明 |
| --- | --- |
| 每 5 秒 | 定时保存 |
| 升级 / 买技能 / 进新关 | 关键进度立刻落盘 |
| 页面隐藏、`pagehide`、`beforeunload` | 用 `sendBeacon`，比 fetch 更可能送达 |

**读取（冲突解决）**

先取服务端和本地，**比较 `time` 时间戳，用较新的那份**。
若本地较新，启动后立即回写服务端对齐。

> 早期版本无条件信任服务端，服务宕机期间玩的进度会在下次启动时被回滚。已修正。

**容错**

| 场景 | 处理 |
| --- | --- |
| 存档 JSON 损坏 | 忽略，退回另一份；服务端 GET 也返回 `null` |
| 缺少 `v` 字段（历史存档） | 按 v1 迁移 |
| 版本高于当前（应用被降级） | 拒绝，避免误读 |
| 数值越界/被篡改 | 钳制到合法范围（等级 ≤9999、金币 ≥0 等） |

**服务端写入是原子的**：先写 `.tmp` 再 `rename`，进程中途被杀也不会产生半截文件。

**迁移位**

未来存档格式升级时，在 `save.migrate()` 里加 `v1 -> v2` 分支即可，
不会让老玩家进度清零。

### 安全处理

- 静态文件路径解析后校验仍在 `www/` 内，拒绝目录穿越
- 存档文件按 uid 隔离，uid 白名单过滤
- 存档大小限制 64KB，写入前校验 JSON 合法性
- 响应带 `X-Content-Type-Options: nosniff`

### 目录结构

```
PixelIdle/
├── manifest              # 版本号、依赖 nodejs_v22
├── THIRD-PARTY-NOTICES.md # 第三方代码声明（随 .fpk 一起发布）
├── src/                  # 开发源码（不进 .fpk）
│   ├── index.html
│   ├── game.js
│   └── vendor/pixelfx.fx.js  # pixelfx 特效包（生成物）
├── vendor/pixelfx/       # pixelfx 源码子集（MIT）
├── scripts/
│   ├── dev.sh            # 开发服务器（热更新）
│   ├── sync.sh           # 同步到已安装应用（需 root）
│   ├── release.sh        # 升版本 + 打包 + 打标签
│   ├── build-fx.js       # vendor/ 编译为 src/vendor/pixelfx.fx.js
│   ├── calibrate-gear.js # 装备增益 + 关卡击杀时长校准
│   ├── build-web.js      # src/ 内联为 app/www/index.html
│   └── vendor-pixelfx.sh # 重新拉取 / 校验 vendor 源码
├── app/
│   ├── server/server.js  # 网关后端（零依赖）
│   ├── ui/
│   │   ├── config        # gatewayPrefix + gatewaySocket
│   │   └── images/
│   ├── www/index.html    # 构建产物（勿手改）
│   └── THIRD-PARTY-NOTICES.md  # 由 release.sh 从根目录同步，勿手改
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

## License

本项目采用 [MIT License](LICENSE) 授权。

Copyright (c) 2026 cancan315

本项目包含来自 [patch-gg/pixelfx](https://github.com/patch-gg/pixelfx) 的代码
（MIT，Copyright (c) 2026 Patch 与 Hugo Duprez），详见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
