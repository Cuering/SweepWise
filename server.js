// server.js — 零依赖 HTTP 服务：静态 UI + 扫描/清理 API + GitHub 自更新
import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanLeftovers, scanCaches, scanAgents } from './src/engine.js';
import { quarantine, restore, purge, listQuarantine, readAudit, exportAudit, addIgnore, removeIgnore } from './src/trash.js';
import { checkUpdate, downloadUpdate, applyUpdate } from './src/updater.js';
import { VERSION } from './src/version.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 7310;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(ROOT, 'ui');

// 编译进 exe 时由 build.mjs 生成 src/ui-files.js；缺失则开发模式读磁盘
let UI_FILES = null;
try { UI_FILES = (await import('./src/ui-files.js')).UI_FILES; } catch { UI_FILES = null; }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const SCAN_TTL = 5 * 60 * 1000;
const scanCache = new Map(); // key=`t:all` -> { at, data }（任意模块请求共享同一份全量缓存）

function computeStats(findings) {
  const tier = { cleanable: 0, ask: 0, locked: 0 };
  let size = 0, sizeLocked = 0;
  for (const f of findings) {
    tier[f.tier] = (tier[f.tier] || 0) + 1;
    if (f.tier === 'locked') sizeLocked += f.size; else size += f.size;
  }
  return { total: findings.length, tier, size, sizeLocked };
}

function respondScan(res, t, data, cached) {
  const filtered = t === 'all' ? data.findings : data.findings.filter((f) => f.module === t);
  return sendJson(res, 200, {
    type: t, findings: filtered, at: data.at, cached,
    stats: computeStats(filtered)
  });
}

function invalidateScan() { scanCache.clear(); }

async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  if (!data) return {};
  try { return JSON.parse(data); } catch { return {}; }
}

async function handleApi(req, res, url) {
  const up = new URL(url, 'http://127.0.0.1');
  const p = up.pathname;
  if (p === '/api/ping') return sendJson(res, 200, { pong: true, time: Date.now(), version: VERSION });

  if (p === '/api/scan' && req.method === 'GET') {
    const t = up.searchParams.get('t') || 'all';
    const fresh = up.searchParams.get('fresh') === '1';
    if (!fresh) {
      const hit = scanCache.get('t:all');
      if (hit && Date.now() - hit.at < SCAN_TTL) return respondScan(res, t, hit.data, true);
    }
    const [leftovers, caches, agents] = await Promise.all([scanLeftovers(), scanCaches(), scanAgents()]);
    const data = { type: 'all', findings: [...leftovers, ...caches, ...agents], stats: null, at: Date.now() };
    data.stats = computeStats(data.findings);
    scanCache.set('t:all', { at: data.at, data });
    return respondScan(res, t, data, false);
  }

  if (p === '/api/clean' && req.method === 'POST') {
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items.filter((it) => it && it.path && (it.tier === 'cleanable' || it.tier === 'ask')) : [];
    const results = await quarantine(items);
    if (body.items && body.items.length) invalidateScan();
    return sendJson(res, 200, { ok: true, done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), results });
  }

  if (p === '/api/restore' && req.method === 'POST') {
    const body = await readBody(req);
    const r = await restore(body.id);
    if (r.ok) invalidateScan();
    return sendJson(res, 200, r);
  }

  if (p === '/api/purge' && req.method === 'POST') {
    const body = await readBody(req);
    const r = await purge(body.id);
    if (r.ok) invalidateScan();
    return sendJson(res, 200, r);
  }

  if (p === '/api/quarantine') return sendJson(res, 200, { items: await listQuarantine() });

  if (p === '/api/audit') {
    const n = parseInt(up.searchParams.get('n') || '200', 10);
    return sendJson(res, 200, { items: await readAudit(n) });
  }

  if (p === '/api/export') {
    const txt = await exportAudit();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="sweepwise-audit.jsonl"' });
    return res.end(txt || '');
  }

  if (p === '/api/ignore' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.path) return sendJson(res, 200, await addIgnore(body.path));
    return sendJson(res, 400, { ok: false, error: '缺 path' });
  }

  if (p === '/api/unignore' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.path) return sendJson(res, 200, await removeIgnore(body.path));
    return sendJson(res, 400, { ok: false, error: '缺 path' });
  }

  if (p === '/api/update/check' && req.method === 'GET') {
    try {
      return sendJson(res, 200, { ok: true, ...(await checkUpdate(VERSION)) });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e), current: VERSION, latest: '', hasUpdate: false });
    }
  }

  if (p === '/api/update/apply' && req.method === 'POST') {
    try {
      const info = await checkUpdate(VERSION);
      if (!info.hasUpdate) return sendJson(res, 200, { ok: false, error: '当前已是最新版本' });
      const { tmp } = await downloadUpdate(info);
      const r = await applyUpdate(tmp);
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
}

function staticFile(res, relPath) {
  // 优先内存内嵌（exe 模式），否则读磁盘（开发模式）
  if (UI_FILES && UI_FILES[relPath] !== undefined) {
    const ext = path.extname(relPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(UI_FILES[relPath]);
  }
  const p = path.join(UI, relPath);
  fsp.readFile(p).then((buf) => {
    const ext = path.extname(p).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  }).catch(() => {
    res.writeHead(404); res.end('not found');
  });
}

const handler = (req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/api/')) return handleApi(req, res, url).catch((e) => sendJson(res, 500, { ok: false, error: String(e.message || e) }));
  if (url === '/' || url === '/index.html') return staticFile(res, 'index.html');
  if (url.startsWith('/ui/')) return staticFile(res, url.slice(4));
  res.writeHead(302, { Location: '/' }); res.end();
};

// 端口占用自动升位（绿色软件双击场景）
function listenWithRetry(port, triesLeft) {
  const s = http.createServer(handler);
  s.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && triesLeft > 0) {
      listenWithRetry(port + 1, triesLeft - 1);
    } else {
      console.error('server error', e);
    }
  });
  s.listen(port, '127.0.0.1', () => {
    const actual = s.address().port;
    console.log(`SweepWise 残件管家 v${VERSION} → http://127.0.0.1:${actual}`);
    if (!process.env.SWEEPWISE_NO_OPEN) {
      execFile('cmd', ['/c', 'start', '', `http://127.0.0.1:${actual}`], { windowsHide: true }, () => {});
    }
  });
}

listenWithRetry(PORT, 10);
