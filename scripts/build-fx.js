#!/usr/bin/env node
/**
 * 把 vendor/pixelfx 里用到的特效打成一个自包含的 IIFE，输出 src/vendor/pixelfx.fx.js。
 *
 * 为什么需要这一步：pixelfx 是 ES Module（每个特效一个文件，用 import 引用 core），
 * 而本项目是「单文件、零依赖、双击即玩」的形态，浏览器里不能有裸模块。
 * 所以构建期用 esbuild 把它们收敛成一个全局对象，再由 scripts/build-web.js 内联。
 *
 * esbuild 只在构建期需要，不进 .fpk、不进最终产物。
 *
 * 用法：node scripts/build-fx.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'vendor', 'pixelfx', 'entry.js');
const outFile = path.join(root, 'src', 'vendor', 'pixelfx.fx.js');

// 署名横幅：MIT 要求版权声明随副本保留，但 --minify 会把每个源文件顶部的注释全部剥掉
// （实测 --legal-comments=inline 也救不回来，因为那些注释没有 @license 标记）。
// 所以在压缩产物外面显式注入一条，保证发布出去的文件里始终带着来源与许可。
const BANNER = [
  '/*!',
  ' * PixelIdle FX bundle — 由 vendor/pixelfx 编译生成，请勿手改。',
  ' *',
  ' * 包含来自 patch-gg/pixelfx 的代码（MIT License）：',
  ' *   Copyright (c) 2026 Patch',
  ' *   Copyright (c) 2026 Hugo Duprez (Sprite Fusion, https://www.spritefusion.com/pixel-art-vfx)',
  ' *',
  ' * 完整声明见项目根目录 THIRD-PARTY-NOTICES.md。',
  ' */',
].join('\n');

function findEsbuild() {
  const local = path.join(root, 'node_modules', '.bin', 'esbuild');
  if (fs.existsSync(local)) return local;
  try {
    return execFileSync('command', ['-v', 'esbuild'], { shell: true, encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

const esbuild = findEsbuild();
if (!esbuild) {
  console.error('找不到 esbuild。装一个即可：npm i -D esbuild');
  console.error('（esbuild 仅构建期需要，不会进入 .fpk 产物。）');
  process.exit(1);
}

if (!fs.existsSync(entry)) {
  console.error('缺少入口：' + path.relative(root, entry));
  process.exit(1);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });

execFileSync(esbuild, [
  entry,
  '--bundle',
  '--format=iife',
  '--global-name=PixelFX',
  '--minify',
  '--target=es2020',
  '--banner:js=' + BANNER,
  '--outfile=' + outFile,
], { stdio: 'inherit' });

const bytes = fs.statSync(outFile).size;
console.log('已生成', path.relative(root, outFile), '（', bytes, '字节 ）');
