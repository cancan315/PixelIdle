#!/usr/bin/env node
/**
 * 像素放置 · PixelIdle — 统一网关后端服务
 *
 * 职责：
 *   1. 监听 ${TRIM_APPDEST}/app.sock（飞牛统一网关转发目标）
 *   2. 提供静态文件服务与存档读写接口
 *
 * 零外部依赖，仅使用 Node.js 内置模块。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const SOCKET_PATH = process.env.SOCKET_PATH || '';
const GATEWAY_PREFIX = (process.env.GATEWAY_PREFIX || '/app/PixelIdle').replace(/\/+$/, '');
const PORT = process.env.PORT || '';
const HOST = process.env.HOST || '127.0.0.1';
const APP_DIR = process.env.TRIM_APPDEST || path.resolve(__dirname, '..');
const DATA_DIR = process.env.TRIM_PKGVAR || path.join(APP_DIR, 'data');
const WWW_DIR = process.env.WWW_DIR
  ? path.resolve(process.env.WWW_DIR)
  : path.join(APP_DIR, 'www');
const MAX_SAVE = 64 * 1024; // 存档上限 64KB

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------- 版本信息 ---------------- */

/** 读取应用版本：优先环境变量，其次安装清单 */
function readVersion() {
  if (process.env.TRIM_APPVER) return process.env.TRIM_APPVER;
  const candidates = [
    process.env.TRIM_APPLICATION || '',
    '/var/apps/PixelIdle/manifest',
    path.join(APP_DIR, '..', 'manifest')
  ].filter(Boolean);
  for (const f of candidates) {
    try {
      const m = /^\s*version\s*=\s*(.+)$/m.exec(fs.readFileSync(f, 'utf8'));
      if (m) return m[1].trim();
    } catch (e) { /* 继续尝试下一个 */ }
  }
  return 'dev';
}

const APP_VERSION = readVersion();

/** 计算首页指纹，便于确认热更新是否生效 */
function buildInfo() {
  const f = path.join(WWW_DIR, 'index.html');
  try {
    const st = fs.statSync(f);
    const size = st.size;
    const mtime = st.mtime.toISOString();
    // 用大小 + mtime 生成短指纹，避免引入 crypto 依赖
    const fp = (size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36)).slice(-12);
    return { version: APP_VERSION, size, mtime, fingerprint: fp };
  } catch (e) {
    return { version: APP_VERSION, size: 0, mtime: null, fingerprint: 'missing' };
  }
}

/* ---------------- 工具 ---------------- */

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function safeUser(uid) {
  // 只允许数字/字母/下划线，防止路径注入
  return String(uid || 'local').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function saveFileFor(uid) {
  return path.join(DATA_DIR, `save-${safeUser(uid)}.json`);
}

function gatewayUser(req) {
  // 网关已校验登录态，这里读取转发的身份 Header
  return {
    uid: req.headers['x-trim-userid'] || 'local',
    isAdmin: req.headers['x-trim-isadmin'] === 'true',
    username: req.headers['x-trim-username'] || ''
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, code, body, headers) {
  const h = Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, headers || {});
  res.writeHead(code, h);
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---------------- 请求处理 ---------------- */

async function handle(req, res) {
  const user = gatewayUser(req);

  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    return send(res, 400, 'Bad Request');
  }

  // 归一化网关前缀：同时兼容带/不带前缀的转发
  let rel = urlPath;
  if (rel === GATEWAY_PREFIX) rel = '/';
  else if (rel.startsWith(GATEWAY_PREFIX + '/')) rel = rel.slice(GATEWAY_PREFIX.length);

  /* ---- 存档接口 ---- */
  if (rel === '/api/save') {
    const file = saveFileFor(user.uid);

    if (req.method === 'GET') {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(raw);
      } catch (e) {
        // 无存档时返回空对象，前端据此走新游戏流程
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end('null');
      }
    }

    if (req.method === 'POST') {
      try {
        const body = await readBody(req, MAX_SAVE);
        JSON.parse(body); // 校验是合法 JSON
        fs.writeFileSync(file, body, 'utf8');
        return send(res, 200, '{"ok":true}', { 'Content-Type': 'application/json; charset=utf-8' });
      } catch (e) {
        return send(res, 400, '{"ok":false,"error":"invalid save"}', {
          'Content-Type': 'application/json; charset=utf-8'
        });
      }
    }

    if (req.method === 'DELETE') {
      try { fs.unlinkSync(file); } catch (e) { /* 不存在则忽略 */ }
      return send(res, 200, '{"ok":true}', { 'Content-Type': 'application/json; charset=utf-8' });
    }

    return send(res, 405, 'Method Not Allowed');
  }

  /* ---- 版本信息（用于确认热更新是否生效）---- */
  if (rel === '/api/version') {
    return send(res, 200, JSON.stringify(buildInfo(), null, 2), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
  }

  /* ---- 健康检查 ---- */
  if (rel === '/api/health') {
    return send(res, 200, JSON.stringify({
      ok: true,
      uid: user.uid,
      prefix: GATEWAY_PREFIX,
      wwwDir: WWW_DIR,
      wwwExists: fs.existsSync(WWW_DIR),
      appDir: APP_DIR
    }), { 'Content-Type': 'application/json; charset=utf-8' });
  }

  /* ---- 静态文件 ---- */
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed');
  }

  if (rel === '/' || rel === '') rel = '/index.html';

  // 目录穿越防护：解析后必须仍在 WWW_DIR 内
  const target = path.normalize(path.join(WWW_DIR, rel));
  if (target !== WWW_DIR && !target.startsWith(WWW_DIR + path.sep)) {
    return send(res, 403, 'Forbidden');
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch (e) {
    return send(res, 404, '404 Not Found');
  }

  if (stat.isDirectory()) {
    return serveFile(res, path.join(target, 'index.html'), false);
  }

  return serveFile(res, target, req.method === 'HEAD');
}

function serveFile(res, file, headOnly) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch (e) {
    return send(res, 404, '404 Not Found');
  }

  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const isIndex = path.basename(file) === 'index.html';

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': data.length,
    'Cache-Control': isIndex ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff'
  });

  if (headOnly) return res.end();
  res.end(data);
}

/* ---------------- 启动 ---------------- */

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log('handler error:', err && err.message);
    try { send(res, 500, 'Internal Server Error'); } catch (e) { /* 响应可能已发送 */ }
  });
});

function start() {
  if (SOCKET_PATH) {
    // 统一网关模式：监听 Unix Socket
    try { fs.unlinkSync(SOCKET_PATH); } catch (e) { /* 不存在则忽略 */ }

    server.listen(SOCKET_PATH, () => {
      try { fs.chmodSync(SOCKET_PATH, 0o777); } catch (e) { /* 权限调整失败不影响启动 */ }
      log(`PixelIdle listening on socket ${SOCKET_PATH}`);
      log(`gateway prefix: ${GATEWAY_PREFIX}`);
      log(`www dir: ${WWW_DIR} (exists=${fs.existsSync(WWW_DIR)})`);
    });

    server.on('error', (err) => {
      log('socket server error:', err.message);
      process.exit(1);
    });
  } else if (PORT) {
    server.listen(PORT, HOST, () => {
      log(`PixelIdle listening on http://${HOST}:${PORT}`);
      log(`www dir: ${WWW_DIR} (exists=${fs.existsSync(WWW_DIR)})`);
      if (HOST === '0.0.0.0') log('局域网可访问（开发模式）');
    });
  } else {
    log('no SOCKET_PATH or PORT provided');
    process.exit(1);
  }
}

process.on('SIGTERM', () => { log('SIGTERM, shutting down'); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT, shutting down'); process.exit(0); });

start();
