// trash.js — 隔离区(可恢复) + 审计日志 + 配置(忽略列表)
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const HOME = os.homedir();
export const BASE = path.join(HOME, '.sweepwise');
export const QUAR = path.join(BASE, 'quarantine');
const MANIFEST = path.join(BASE, 'manifest.json');
const AUDIT = path.join(BASE, 'audit.jsonl');
const CONFIG = path.join(BASE, 'config.json');

async function ensureBase() {
  await fsp.mkdir(QUAR, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const txt = await fsp.readFile(file, 'utf8');
    return txt.trim() ? JSON.parse(txt) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await ensureBase();
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

async function appendAudit(entry) {
  await ensureBase();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  await fsp.appendFile(AUDIT, line + '\n', 'utf8');
}

function safeName(p) {
  return path.basename(p).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

async function moveWithFallback(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch {
    await fsp.cp(src, dest, { recursive: true });
    await fsp.rm(src, { recursive: true, force: true });
  }
}

async function smartMove(src, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${Date.now()}_${safeName(src)}`);
  await moveWithFallback(src, dest);
  return dest;
}

// 把若干项移入隔离区，返回 [{id, orig, dest, size, ok, error}]
export async function quarantine(items) {
  await ensureBase();
  const manifest = await readJson(MANIFEST, []);
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const orig = it.path;
    const id = `q_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`;
    try {
      const st = await fsp.lstat(orig);
      if (!st.isDirectory() && !st.isFile()) throw new Error('不是常规文件/目录');
      const dest = await smartMove(orig, QUAR);
      const entry = {
        id, orig, dest, size: it.size || 0,
        module: it.module || 'unknown', name: it.name || path.basename(orig),
        at: new Date().toISOString()
      };
      manifest.push(entry);
      results.push({ id, orig, dest, size: entry.size, ok: true });
      await appendAudit({ action: 'quarantine', id, path: orig, size: entry.size, module: entry.module });
    } catch (e) {
      // 源已不存在（缓存过期、已被清过）视为幂等成功，不算失败
      if (e && e.code === 'ENOENT') {
        results.push({ orig, ok: true, skipped: 'not-found', error: '路径已不存在，已跳过' });
        await appendAudit({ action: 'skip-not-found', path: orig });
      } else {
        results.push({ orig, ok: false, error: String((e && e.message) || e), code: e && e.code });
      }
    }
  }
  await writeJson(MANIFEST, manifest);
  return results;
}

export async function listQuarantine() {
  const manifest = await readJson(MANIFEST, []);
  return [...manifest].reverse();
}

export async function restore(id) {
  const manifest = await readJson(MANIFEST, []);
  const idx = manifest.findIndex((m) => m.id === id);
  if (idx < 0) return { ok: false, error: '隔离区无此记录' };
  const m = manifest[idx];
  try {
    await fsp.mkdir(path.dirname(m.orig), { recursive: true });
    await moveWithFallback(m.dest, m.orig);
    manifest.splice(idx, 1);
    await writeJson(MANIFEST, manifest);
    await appendAudit({ action: 'restore', id, path: m.orig, size: m.size });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export async function purge(id) {
  const manifest = await readJson(MANIFEST, []);
  const idx = manifest.findIndex((m) => m.id === id);
  if (idx < 0) return { ok: false, error: '隔离区无此记录' };
  const m = manifest[idx];
  try {
    await fsp.rm(m.dest, { recursive: true, force: true });
    manifest.splice(idx, 1);
    await writeJson(MANIFEST, manifest);
    await appendAudit({ action: 'purge', id, path: m.orig, size: m.size });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export async function ignoredSet() {
  const cfg = await readJson(CONFIG, { ignore: [] });
  return new Set((cfg.ignore || []).map((p) => p.toLowerCase()));
}

export async function addIgnore(p) {
  const cfg = await readJson(CONFIG, { ignore: [] });
  if (!cfg.ignore.includes(p)) cfg.ignore.push(p);
  await writeJson(CONFIG, cfg);
  await appendAudit({ action: 'ignore', path: p });
  return { ok: true };
}

export async function removeIgnore(p) {
  const cfg = await readJson(CONFIG, { ignore: [] });
  cfg.ignore = (cfg.ignore || []).filter((x) => x !== p);
  await writeJson(CONFIG, cfg);
  return { ok: true };
}

export async function readAudit(n = 200) {
  try {
    const txt = await fsp.readFile(AUDIT, 'utf8');
    const lines = txt.trim().split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return { raw: l }; }
    });
    return lines.slice(-n).reverse();
  } catch {
    return [];
  }
}

export async function exportAudit() {
  try {
    return await fsp.readFile(AUDIT, 'utf8');
  } catch {
    return '';
  }
}
