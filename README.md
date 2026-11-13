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

## 构建

```bash
# 打包为可安装的 .fpk（在本目录执行）
../tools/fnpack build
# 产物：PixelIdle.fpk
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
├── manifest              # 含 install_dep_apps = nodejs_v22
├── app/
│   ├── server/server.js  # 网关后端（零依赖）
│   ├── ui/
│   │   ├── config        # gatewayPrefix + gatewaySocket
│   │   └── images/
│   └── www/index.html    # 单文件游戏（已内联 JS）
├── cmd/main              # 启动/停止 Node 服务
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
