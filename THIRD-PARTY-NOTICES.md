# 第三方代码声明

PixelIdle 本体以 MIT 授权（见 [LICENSE](LICENSE)）。除此之外，本项目包含以下第三方代码。

---

## pixelfx

- **来源**：https://github.com/patch-gg/pixelfx
- **许可**：MIT License
- **版权**：Copyright (c) 2026 Patch
- **取用方式**：源码复制到 `vendor/pixelfx/`（未作为 npm 依赖引入）

被引入的文件：

| 位置 | 说明 |
| --- | --- |
| `vendor/pixelfx/core/math.js` | 数学工具 |
| `vendor/pixelfx/core/color.js` | 调色板与颜色换算 |
| `vendor/pixelfx/core/particles.js` | 粒子系统 |
| `vendor/pixelfx/core/shapes.js` | 图形辅助 |
| `vendor/pixelfx/core/sim.js` | 粒子物理（火花、碎片、光） |
| `vendor/pixelfx/core/painter.js` | 像素绘制器 |
| `vendor/pixelfx/core/font.js` | 位图字体 |
| `vendor/pixelfx/core/fx.js` | 帧缓冲与特效实例 |
| `vendor/pixelfx/core/actor.js` | 角色遮罩 |
| `vendor/pixelfx/fx/impacts/hit-spark.js` | 命中特效（本项目实际使用） |
| `vendor/pixelfx/fx/impacts/_lib.js` | 上述特效的辅助函数 |
| `vendor/pixelfx/core/index.js` | 入口（**已裁剪**，见下） |
| `vendor/pixelfx/entry.js` | 构建入口（本项目新增，非上游文件） |

### 关于 `core/index.js`

上游同名文件会 re-export `act.js` / `rig.js` / `poses.js` / `chain.js` / `scene.js`。
这些模块在顶层有副作用（`rig.js` 构建角色调色板、`act.js` 创建角色帧），
即使不被使用也会进入打包产物：保留它们需 30.4 KB，去掉后同等功能只需 19.2 KB。
因此本项目版本的 `index.js` 去掉了这几个 re-export，其余内容与上游一致。

**这是唯一被修改的上游文件。** 其他 vendor 文件与上游逐字节一致，
可用 `scripts/vendor-pixelfx.sh` 校验或重新拉取。

### 嵌套的第三方来源

pixelfx 自身也改编了第三方 MIT 代码。按 MIT 要求一并声明：

**Hugo Duprez（Sprite Fusion）** — https://www.spritefusion.com/pixel-art-vfx
Copyright (c) 2026 Hugo Duprez，MIT License
影响本项目所用文件的部分：`core/sim.js`，以及 `fx/impacts/hit-spark.js`
与 `fx/impacts/_lib.js` 中的火花、光斑与碎片行为。

**rehan-remade（Hollow Crown）** — https://github.com/rehan-remade/hollow-crown
Copyright (c) 2026 rehan-remade，MIT License
影响 `core/act.js`（停顿、震动、弹簧靶子的节奏）。本项目**未使用** `act.js`，
仅为完整声明上游许可链而列出。

### 字体不在授权范围内

上游仓库 `gallery/fonts/PatchPixel-Regular.woff2` 是 Patch 自有字体，
**明确不覆盖 MIT 授权**。本项目未引入 `gallery/` 目录的任何内容，
也未使用该字体。

### 署名如何保留到产物里

MIT 要求版权声明随副本保留。上游的许可注释写在每个源文件顶部，
但 `esbuild --minify` 会把它们全部剥离（实测 `--legal-comments=inline` 同样无效，
因为那些注释没有 `@license` 标记）。因此 `scripts/build-fx.js` 用 `--banner:js`
在压缩产物外显式注入署名横幅，保证 `src/vendor/pixelfx.fx.js`
与最终 `app/www/index.html` 中都带着来源与许可信息。
经校验，两个产物里均能检索到本文件的名称。

---

## 许可全文

```
MIT License

Copyright (c) 2026 Patch
Copyright (c) 2026 Hugo Duprez
Copyright (c) 2026 rehan-remade

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
