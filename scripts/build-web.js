#!/usr/bin/env node
/**
 * 把 src/game.js 内联进 src/index.html，输出单文件到 app/www/index.html。
 *
 * 为什么内联：应用通过网关只服务静态文件，单文件可减少一次请求，
 * 也避免个别环境下的 MIME / 缓存问题。
 *
 * 用法：node scripts/build-web.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcHtml = path.join(root, 'src', 'index.html');
const srcJs = path.join(root, 'src', 'game.js');
const outDir = path.join(root, 'app', 'www');
const outHtml = path.join(outDir, 'index.html');

const html = fs.readFileSync(srcHtml, 'utf8');
const js = fs.readFileSync(srcJs, 'utf8');
const TAG = '<script src="game.js"></script>';

if (!html.includes(TAG)) {
  console.error('src/index.html 中未找到 <script src="game.js"></script>');
  process.exit(1);
}

const out = html.replace(TAG, () => '<script>\n' + js + '\n</script>');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outHtml, out, 'utf8');

console.log('已生成', path.relative(root, outHtml),
            '（', Buffer.byteLength(out, 'utf8'), '字节 ）');
