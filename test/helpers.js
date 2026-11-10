/* 测试工具:临时数据目录启动服务端;无头 Chrome */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

async function startServer(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-test-'));
  const port = 18000 + Math.floor(Math.random() * 2000);
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, DEMO_TODAY: '2026-11-09', FEISHU_WEBHOOK: '', FEISHU_APP_ID: '', ANTHROPIC_API_KEY: '', BRIEF_TIME: '' }, env || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  p.stdout.on('data', d => { log += d; }); p.stderr.on('data', d => { log += d; });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + '/api/version'); if (r.ok) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 100));
  }
  return { base, dir, proc: p, log: () => log, stop: () => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
async function api(base, method, url, body) {
  const r = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { j = t; }
  return { status: r.status, body: j };
}
async function browser() {
  const puppeteer = require('puppeteer-core');
  return puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'] });
}
/* 打开页面并收集 JS 错误 */
async function open(br, url, opts) {
  const page = await br.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('HTTP ' + r.status() + ' ' + r.url()); });
  await page.setViewport(opts && opts.viewport || { width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(e => { if (!/networkidle/.test(String(e))) throw e; });
  page.errors = errors;
  return page;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
function check(cond, msg) { if (cond) console.log('  ✓ ' + msg); else { failed++; console.log('  ✗ ' + msg); } }
function done() { if (failed) { console.log('\n' + failed + ' 项检查失败'); process.exit(1); } console.log('\n全部通过'); }
module.exports = { startServer, api, browser, open, sleep, check, done, ROOT };
