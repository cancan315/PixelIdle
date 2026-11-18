#!/usr/bin/env node
/**
 * 把 src/ 下的脚本内联进 src/index.html，输出单文件到 app/www/index.html。
 *
 * 为什么内联：应用通过网关只服务静态文件，单文件可减少请求，
 * 也避免个别环境下的 MIME / 缓存问题。
 *
 * 内联顺序必须与 src/index.html 里的 <script src> 顺序一致，否则
 * vendor/pixelfx.fx.js 定义的 PixelFX 还没生成，game.js 就用不到。
 *
 * 用法：
 *   node scripts/build-fx.js    # 先编译 pixelfx 特效（源码有变时才需要）
 *   node scripts/build-web.js   # 再内联成单文件
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcHtml = path.join(root, 'src', 'index.html');
const outDir = path.join(root, 'app', 'www');
const outHtml = path.join(outDir, 'index.html');

// 按依赖顺序内联：先特效包，再游戏逻辑
const SCRIPTS = [
  { tag: '<script src="vendor/pixelfx.fx.js"></script>', file: path.join(root, 'src', 'vendor', 'pixelfx.fx.js') },
  { tag: '<script src="game.js"></script>', file: path.join(root, 'src', 'game.js') },
];

let html = fs.readFileSync(srcHtml, 'utf8');

for (const s of SCRIPTS) {
  if (!html.includes(s.tag)) {
    console.error('src/index.html 中未找到 ' + s.tag);
    process.exit(1);
  }
  if (!fs.existsSync(s.file)) {
    const hint = s.file.includes('pixelfx.fx.js')
      ? '（先跑 node scripts/build-fx.js 生成特效包）'
      : '';
    console.error('缺少源文件：' + path.relative(root, s.file) + hint);
    process.exit(1);
  }
  const js = fs.readFileSync(s.file, 'utf8');
  html = html.replace(s.tag, () => '<script>\n' + js + '\n</script>');
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outHtml, html, 'utf8');

console.log('已生成', path.relative(root, outHtml),
            '（', Buffer.byteLength(html, 'utf8'), '字节 ）');
