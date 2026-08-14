// updater.js — GitHub 自动更新：检查版本 / 下载新版 exe / SHA256 校验 / 替换重启
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { BASE } from './trash.js';

const REPO_OWNER = 'Cuering';
const REPO_NAME = 'SweepWise';
const VERSION_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/version.json`;

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// 检查 GitHub 上的最新版本
export async function checkUpdate(currentVersion) {
  const remote = await fetchJson(VERSION_URL);
  const latest = String(remote.version || '');
  return {
    current: currentVersion,
    latest,
    hasUpdate: latest !== '' && latest !== currentVersion,
    url: remote.url || `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${latest}/SweepWise.exe`,
    sha256: remote.sha256 || '',
    size: remote.size || 0,
    note: remote.note || ''
  };
}

// 下载新版 exe 并做 SHA256 校验
export async function downloadUpdate(info) {
  const dir = path.join(BASE, 'update');
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, 'SweepWise.new.exe');
  const r = await fetch(info.url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (info.sha256) {
    const h = crypto.createHash('sha256').update(buf).digest('hex');
    if (h.toLowerCase() !== String(info.sha256).toLowerCase()) throw new Error('SHA256 校验不一致，已中止安装');
  }
  await fsp.writeFile(tmp, buf);
  return { tmp, size: buf.length };
}

// 替换自身 exe：写 .bat 延时杀进程→替换→重启（Windows 不能覆盖运行中的 exe）
export async function applyUpdate(tmp) {
  const exe = process.execPath;
  const exeName = path.basename(exe).toLowerCase();
  if (!exeName.endsWith('.exe') || exeName === 'node.exe' || exeName === 'bun.exe') {
    return { ok: false, error: '当前为开发模式(node/bun)运行，无法自替换；请用绿色版 SweepWise.exe' };
  }
  const dir = path.join(BASE, 'update');
  await fsp.mkdir(dir, { recursive: true });
  const bat = path.join(dir, 'apply.bat');
  const lines = [
    '@echo off',
    'timeout /t 2 /nobreak >nul',
    `taskkill /f /im ${exeName} >nul 2>&1`,
    `move /y "${tmp}" "${exe}" >nul`,
    `start "" "${exe}"`
  ];
  await fsp.writeFile(bat, lines.join('\r\n') + '\r\n', 'ascii');
  const child = spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', cwd: dir });
  child.unref();
  return { ok: true, bat };
}
