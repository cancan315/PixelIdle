// pixelfx 核心入口（裁剪版）
// ---------------------------------------------------------------------------
// 上游：https://github.com/patch-gg/pixelfx（MIT，Copyright (c) 2026 Patch /
// Hugo Duprez）。本项目的完整来源与许可声明见 THIRD-PARTY-NOTICES.md。
//
// 与上游 src/core/index.js 的唯一区别：**去掉了 act / rig / poses / chain /
// scene 的 re-export**。这些模块在顶层有副作用（rig.js 会构建角色调色板、
// act.js 会创建角色帧），未被用到却会被打进产物：保留它们要 30.4 KB，
// 去掉后同功能只需 19.2 KB。
//
// 其余被 vendor 的每个文件都与上游逐字节一致，请勿在本地修改——
// 升级时用 scripts/vendor-pixelfx.sh 重新拉取，改动只应留在这里。
// ---------------------------------------------------------------------------

export * from "./math.js";
export * from "./color.js";
export * from "./particles.js";
export * from "./shapes.js";
export { Particles, Bits, Lights, Blazes, P, PF, B, GRAVITY, FIRE_RAMP, SMOKE_RAMP, sparkle, flare, band, crystal } from "./sim.js";
export { Painter } from "./painter.js";
export { FONTS, textWidth } from "./font.js";
export { createFrame, clearFrame, createFx, composite, painterFor, resolveOptions } from "./fx.js";
export { stockActor, drawActor, actorAlphaOf, HERO, HERO2, HERO_PAL, DUMMY_PAL } from "./actor.js";
