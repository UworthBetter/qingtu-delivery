#!/usr/bin/env node
/* 擎图 · 交付管家 服务端(零依赖 Node)
   - 托管 index.html / 手机报工页等静态文件
   - JSON 文件持久化(data/store.json),多终端共享
   - REST API + SSE 实时推送(大屏 / 项目页即时刷新)
   运行:node server.js   (可选 .env,见 .env.example) */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
loadEnv(path.join(ROOT, '.env'));
const E = require('./engine.js');
const Store = require('./lib/store.js');
const ctx = { E, env: process.env, root: ROOT };

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

/* ---------- .env(简单解析,不覆盖已存在的环境变量) ---------- */
function loadEnv(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  txt.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) return;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
}

/* ---------- 数据 ---------- */
ctx.today = () => E.today(process.env.DEMO_TODAY || null);
const store = new Store(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'), ctx);
ctx.store = store;

/* 局域网地址:二维码需要手机能访问到的地址 */
function lanIp() {
  const nets = os.networkInterfaces();
  for (const k of Object.keys(nets)) for (const n of nets[k] || []) {
    if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return '127.0.0.1';
}
ctx.baseUrl = (req) => {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const host = req && req.headers.host;
  if (host && !/^(localhost|127\.)/.test(host)) return 'http://' + host;
  return 'http://' + lanIp() + ':' + PORT;
};

/* ---------- SSE ---------- */
const clients = new Set();
function broadcast(type, data) {
  const msg = 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of clients) { try { res.write(msg); } catch (e) { clients.delete(res); } }
}
ctx.broadcast = broadcast;
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); } } }, 20000).unref();

/* ---------- HTTP 工具 ---------- */
function send(res, code, body, type, extra) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' }, extra || {}));
  res.end(buf);
}
const json = (res, obj, code) => send(res, code || 200, obj);
const fail = (res, code, msg) => send(res, code, { ok: false, error: msg });
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > (limit || 2e6)) { reject(Object.assign(new Error('请求过大'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const b = await readBody(req, limit);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch (e) { throw Object.assign(new Error('JSON 格式错误'), { status: 400 }); }
}
ctx.readBody = readBody; ctx.readJson = readJson; ctx.json = json; ctx.fail = fail; ctx.send = send;

/* ---------- 静态文件 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8' };
const STATIC_OK = /^\/(index\.html|engine\.js|m\.html|c\.html|vendor\/[\w.-]+|uploads\/[\w.-]+)$/;
function serveStatic(req, res, p) {
  if (!STATIC_OK.test(p)) return fail(res, 404, '未找到');
  const file = p.startsWith('/uploads/') ? path.join(store.dir, p) : path.join(ROOT, p);
  fs.readFile(file, (err, buf) => {
    if (err) return fail(res, 404, '未找到');
    send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', { 'Cache-Control': p.startsWith('/uploads/') ? 'max-age=86400' : 'no-cache' });
  });
}

/* 启动注入:让 index.html 同步拿到共享数据,无闪烁 */
function bootJs(req) {
  const boot = { server: true, today: E.fmtFull(ctx.today()), version: store.data.version, baseUrl: ctx.baseUrl(req), data: store.snapshot(), features: features() };
  return 'window.QT_BOOT=' + JSON.stringify(boot).replace(/</g, '\\u003c') + ';\n';
}
function features() {
  const f = { feishuBot: !!process.env.FEISHU_WEBHOOK, feishuApp: !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET), feishuOwner: !!(process.env.FEISHU_OWNER_OPEN_ID || process.env.FEISHU_OWNER_EMAIL), llm: !!process.env.ANTHROPIC_API_KEY };
  return f;
}
ctx.features = features;

/* ---------- 路由 ---------- */
const routes = [];
function route(method, pattern, fn) { routes.push({ method, re: pattern instanceof RegExp ? pattern : new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn }); }
ctx.route = route;

route('GET', '/config.js', (req, res) => send(res, 200, bootJs(req), MIME['.js']));
route('GET', '/api/info', (req, res) => json(res, { ok: true, today: E.fmtFull(ctx.today()), version: store.data.version, baseUrl: ctx.baseUrl(req), features: features() }));
route('GET', '/api/data', (req, res) => json(res, Object.assign({ ok: true, version: store.data.version, today: E.fmtFull(ctx.today()) }, store.snapshot())));
route('GET', '/api/version', (req, res) => json(res, { ok: true, version: store.data.version }));

/* 前端编辑:按项目整体覆盖(带项目版本号,冲突返回 409 让前端刷新) */
route('PUT', '/api/projects', async (req, res) => {
  const b = await readJson(req, 5e6);
  const r = store.applyClientChanges(b.upsert || {}, b.remove || [], b.revs || {});
  if (!r.ok) return json(res, Object.assign({ ok: false, conflict: r.conflict, version: store.data.version }, store.snapshot()), 409);
  broadcast('data', { version: store.data.version, origin: b.client || null, pids: r.pids });
  json(res, { ok: true, version: store.data.version, revs: store.data.rev });
});
route('POST', '/api/reset', async (req, res) => {
  store.reset();
  broadcast('data', { version: store.data.version, origin: null, reset: true });
  json(res, { ok: true, version: store.data.version });
});
route('GET', '/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\nevent: hello\ndata: ' + JSON.stringify({ version: store.data.version }) + '\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

/* 各阶段功能模块(按存在加载) */
['report', 'insight', 'import', 'promise', 'parts', 'seed'].forEach(m => {
  const f = path.join(ROOT, 'lib', m + '.js');
  if (fs.existsSync(f)) require(f)(ctx);
});
store.load();   /* 模块注册完种子钩子后再载入 / 生成数据 */
(ctx.afterLoad || []).forEach(fn => fn());
const flush = () => { try { store.saveNow(); } catch (e) {} process.exit(0); };
process.on('SIGINT', flush); process.on('SIGTERM', flush);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = decodeURIComponent(u.pathname);
  req.query = u.searchParams;
  try {
    for (const r of routes) {
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      const m = p.match(r.re);
      if (m) { req.params = m.groups || {}; return await r.fn(req, res); }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 404, '未找到');
    if (p === '/') p = '/index.html';
    serveStatic(req, res, p);
  } catch (e) {
    if (!e.status) console.error('[error]', req.method, p, e);
    if (!res.headersSent) fail(res, e.status || 500, e.message || '服务器错误');
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const f = features();
    console.log('擎图 · 交付管家 已启动');
    console.log('  大屏 / 电脑:  http://localhost:' + PORT);
    console.log('  手机扫码地址: ' + ctx.baseUrl(null));
    console.log('  数据文件:     ' + path.relative(ROOT, store.file));
    console.log('  飞书机器人:   ' + (f.feishuBot ? '已配置' : '未配置(演示模式,消息显示在「飞书消息预览」)'));
    console.log('  飞书开放平台: ' + (f.feishuApp ? '已配置' : '未配置'));
    console.log('  大模型:       ' + (f.llm ? '已配置' : '未配置(使用模板)'));
    if (ctx.onListen) ctx.onListen.forEach(fn => fn());
  });
}
module.exports = { server, ctx };
