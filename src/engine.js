// engine.js — 三类扫描引擎：已卸载残留 / 缓存 / Agent 工作区 + 安全分级
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ignoredSet } from './trash.js';

const execFileP = promisify(execFile);
const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ROAM = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const TEMP = os.tmpdir();
const PROGDATA = process.env.PROGRAMDATA || 'C:\\ProgramData';

const norm = (s) => String(s || '').toLowerCase().trim();

async function psJson(script) {
  const { stdout } = await execFileP('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
    { maxBuffer: 96 * 1024 * 1024, timeout: 60000 });
  const txt = stdout.replace(/^\uFEFF/, '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return null; }
}

function wordTokens(s) {
  const out = new Set();
  const low = norm(s);
  if (low) out.add(low);
  for (const w of low.split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (w.length >= 3 && /[a-z\u4e00-\u9fff]/.test(w)) out.add(w);
  }
  return out;
}

async function installedNames() {
  const set = new Set();
  const keys = [
    'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
  ];
  const script = keys
    .map((k) => `@(Get-ItemProperty "${k}" -ErrorAction SilentlyContinue | Select "DisplayName","Publisher","InstallLocation","UninstallString")`)
    .join(' + ');
  const data = await psJson(`${script} | ConvertTo-Json -Compress`);
  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  for (const r of rows) {
    for (const f of ['DisplayName', 'Publisher', 'InstallLocation', 'UninstallString']) {
      for (const t of wordTokens(r[f])) set.add(t);
    }
  }
  try {
    const { stdout } = await execFileP('winget.exe', ['list', '--accept-source-agreements', '--accept-package-agreements'],
      { maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
    for (const line of stdout.split(/\r?\n/).slice(4)) {
      if (!line.trim()) continue;
      const m = line.match(/^([^\t]+?)\s{2,}\S+\s+\S+/);
      if (m && m[1]) for (const t of wordTokens(m[1])) set.add(t);
    }
  } catch {}
  return set;
}

async function runningExes() {
  const set = new Set();
  const data = await psJson('@(Get-Process -ErrorAction SilentlyContinue | Select -Expand ProcessName) | ConvertTo-Json -Compress');
  for (const n of Array.isArray(data) ? data : (data ? [data] : [])) set.add(norm(n));
  return set;
}

// 运行中的产品/开发关键进程 —— 目录一律禁动
const PROTECTED = new Set([
  'opencode', 'selfforge', 'evolve', 'kbserve', 'node', 'nodejs', 'bun', 'npm', 'npx',
  'docker', 'powershell', 'pwsh', 'code', 'codex', 'claude', 'cursor', 'explorer',
  'wechat', 'weixin', 'qq', 'selfforge-dashboard'
]);

// 系统/通用目录 —— 即使看起来像孤儿也不动
const GENERIC_KEEP = new Set([
  'microsoft', 'windows', 'windowsapps', 'packages', 'virtualstore', 'programs',
  'microsoft edge', 'microsoft corporation', 'dotnet', 'cache'
]);

// 高置信度缓存/垃圾目录 —— 可直接清
const JUNK_HIGH = new Set([
  'crashdumps', 'crashreports', 'crashpad', 'temp', 'tmp', 'd3dscache', 'shelliconcache',
  'nvidia corporation', 'nvidia', 'installer', 'windows installer', 'turbocached', 'iconcache'
]);

// 已确认卸载的软件残留目录 —— 可直接清（放 installed 检查之前，覆盖旧版本同名目录）
const KNOWN_RESIDUAL = new Set([
  'secoresdk', 'mcafee', 'trae',
  'anythingllm-desktop-updater', 'aitools-updater', 'clash_win-updater'
]);

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };

// ---- 目录体积统计（跳符号链接，限制深度与条目数）----
export async function walkSize(dir, maxEntries = 400000, depth = 0, budget = { n: 0 }) {
  let size = 0, count = 0;
  if (budget.n > maxEntries || depth > 8) return { size, count };
  let ents;
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch { return { size, count }; }
  for (const e of ents) {
    if (budget.n > maxEntries) break;
    budget.n++;
    const p = path.join(dir, e.name);
    try {
      const st = await fsp.lstat(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        const sub = await walkSize(p, maxEntries, depth + 1, budget);
        size += sub.size; count += sub.count;
      } else if (st.isFile()) { size += st.size; count++; }
    } catch {}
  }
  return { size, count };
}

async function statExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

// 已安装软件目录内的纯缓存子目录名(可直接清)与数据类子目录名(先问)
const PURE_CACHE_NAMES = new Set([
  'cache', 'cacheddata', 'code cache', 'gpucache', 'crashdumps', 'shadercache',
  'optimizationcache', 'cachev2', '_cacache', 'thumbnail cache', 'v8-cache', 'compiledcache'
]);
const ASK_CACHE_NAMES = new Set(['logs', 'log', 'temp', 'tmp', 'backups', 'debug', 'old', 'bak', 'cache']);

// 在 root 下(≤maxDepth 层)找到子目录名匹配 matchers(字符串或正则,忽略大小写)的路径
async function findSubdirs(root, matchers, maxDepth = 3, out = [], d = 0) {
  if (!(await statExists(root)) || d > maxDepth) return out;
  let ents;
  try { ents = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name);
    const low = e.name.toLowerCase();
    if (matchers.some((m) => m instanceof RegExp ? m.test(low) : typeof m === 'function' ? m(low) : m === low)) out.push(p);
    if (d + 1 <= maxDepth) await findSubdirs(p, matchers, maxDepth, out, d + 1);
  }
  return out;
}

let cachedInstalled = null;
let cachedRunning = null;
let cachedLocations = null;

async function ensureBases() {
  if (!cachedInstalled) cachedInstalled = await installedNames();
  if (!cachedRunning) cachedRunning = await runningExes();
  if (!cachedLocations) cachedLocations = await installedLocations();
}

// 已安装软件的安装位置列表(含顶层目录名)，用于探索其缓存子目录
async function installedLocations() {
  if (cachedLocations) return cachedLocations;
  const keys = [
    'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
  ];
  const script = keys
    .map((k) => `@(Get-ItemProperty "${k}" -ErrorAction SilentlyContinue | Select "InstallLocation")`)
    .join(' + ') + ' | ConvertTo-Json -Compress';
  const data = await psJson(script);
  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  const locs = [];
  for (const r of rows) {
    const loc = String(r.InstallLocation || '').trim().replace(/[\\/]+$/, '');
    if (loc) locs.push({ name: path.basename(loc), loc });
  }
  cachedLocations = locs;
  return locs;
}

function classify(name, installed, running) {
  const low = norm(name);
  if (!low) return { tier: 'locked', confidence: 100, note: '空目录名' };
  if (running.has(low) || PROTECTED.has(low)) return { tier: 'locked', confidence: 100, note: '运行中的产品目录，禁止清理' };
  if (GENERIC_KEEP.has(low)) return { tier: 'locked', confidence: 100, note: '系统/通用目录' };
  if (KNOWN_RESIDUAL.has(low)) return { tier: 'cleanable', confidence: 92, note: '已确认卸载的软件残留目录' };
  if (/^@?[\w.-]*-updater$/i.test(low)) {
    if (low.includes('opencode')) return { tier: 'ask', confidence: 70, note: '桌面版更新器目录，先确认是否在使用' };
    return { tier: 'cleanable', confidence: 90, note: '已卸载软件的 updater 残留目录' };
  }
  if (installed.has(low)) return { tier: 'locked', confidence: 100, note: '已安装软件目录' };
  if (JUNK_HIGH.has(low)) return { tier: 'cleanable', confidence: 95, note: '高置信缓存/垃圾目录' };
  if (/^\{[0-9a-f-]{20,}\}$/i.test(low)) return { tier: 'ask', confidence: 70, note: 'MSI/GUID 缓存目录，可能是卸载残留' };
  if (/^[\da-f]{32}$/i.test(low)) return { tier: 'cleanable', confidence: 80, note: '哈希缓存目录' };
  // 普通疑似孤儿：给中置信度，且要求像"产品名"
  if (/[a-z\u4e00-\u9fff]/.test(low) && !/^[\d.\s]+$/.test(low)) {
    return { tier: 'ask', confidence: 55, note: '疑似已卸载软件残留，建议确认后清理' };
  }
  return { tier: 'locked', confidence: 100, note: '非产品形态目录' };
}

async function scanRoot(installed, running, ignore, root) {
  const findings = [];
  let ents;
  try { ents = await fsp.readdir(root, { withFileTypes: true }); } catch { return findings; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name);
    if (ignore.has(p.toLowerCase())) continue;
    const cls = classify(e.name, installed, running);
    const { size } = await walkSize(p);
    findings.push({
      id: `l_${findings.length}`,
      module: 'leftovers', name: e.name,
      path: p, size, tier: cls.tier, confidence: cls.confidence, note: cls.note
    });
  }
  return findings;
}

export async function scanLeftovers() {
  await ensureBases();
  const ignore = await ignoredSet();
  const roots = [LOCAL, ROAM];
  const all = [];
  for (const r of roots) all.push(...await scanRoot(cachedInstalled, cachedRunning, ignore, r));
  // 用户级安装目录 Programs 下的子目录
  const programs = path.join(LOCAL, 'Programs');
  if (await statExists(programs)) {
    let ents;
    try { ents = await fsp.readdir(programs, { withFileTypes: true }); } catch { ents = []; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const p = path.join(programs, e.name);
      if (ignore.has(p.toLowerCase())) continue;
      const cls = classify(e.name, cachedInstalled, cachedRunning);
      const { size } = await walkSize(p);
      all.push({
        id: `l_${all.length}`, module: 'leftovers', name: e.name,
        path: p, size, tier: cls.tier, confidence: cls.confidence, note: cls.note
      });
    }
  }
  return all;
}

// ---- 缓存规则表 ----
const CACHE_RULES = [
  { id: 'c_temp', name: '用户临时文件', path: TEMP, tier: 'cleanable', note: '百分百安全的临时目录' },
  { id: 'c_npm', name: 'npm 缓存', path: path.join(HOME, '.npm', '_cacache'), tier: 'cleanable', note: 'npm cache clean 内容' },
  { id: 'c_npm_old', name: 'npm 旧缓存', path: path.join(LOCAL, 'npm-cache'), tier: 'cleanable', note: '旧版 npm 全局缓存' },
  { id: 'c_pip', name: 'pip 缓存', path: path.join(LOCAL, 'pip', 'Cache'), tier: 'cleanable', note: 'pip 下载包缓存' },
  { id: 'c_bun', name: 'bun 安装缓存', path: path.join(HOME, '.bun', 'install', 'cache'), tier: 'cleanable', note: 'bun install 归档缓存' },
  { id: 'c_pnpm', name: 'pnpm store', path: path.join(LOCAL, 'pnpm', 'store'), tier: 'cleanable', note: 'pnpm 内容寻址缓存' },
  { id: 'c_yarn', name: 'yarn 缓存', path: path.join(LOCAL, 'Yarn', 'Cache'), tier: 'cleanable', note: 'yarn 包缓存' },
  { id: 'c_nuget', name: 'NuGet 缓存', path: path.join(LOCAL, 'NuGet', 'v3-cache'), tier: 'cleanable', note: 'NuGet 包缓存' },
  { id: 'c_cargo', name: 'cargo registry 缓存', path: path.join(LOCAL, 'cargo', 'registry', 'cache'), tier: 'cleanable', note: 'cargo 下载缓存' },
  { id: 'c_gocache', name: 'Go 构建缓存', path: path.join(LOCAL, 'go-build'), tier: 'cleanable', note: 'Go 编译缓存' },
  { id: 'c_crashdumps', name: '崩溃转储', path: path.join(LOCAL, 'CrashDumps'), tier: 'cleanable', note: '软件崩溃 dmp 文件' },
  { id: 'c_d3ds', name: 'GPU 着色器缓存', path: path.join(LOCAL, 'D3DSCache'), tier: 'cleanable', note: 'DirectX 着色器缓存' },
  { id: 'c_chrome', name: 'Chrome 缓存', path: path.join(LOCAL, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'), tier: 'cleanable', note: '浏览器页面缓存(不影响书签/密码)' },
  { id: 'c_chrome_code', name: 'Chrome 代码缓存', path: path.join(LOCAL, 'Google', 'Chrome', 'User Data', 'Default', 'Code Cache'), tier: 'cleanable', note: 'V8 编译缓存' },
  { id: 'c_edge', name: 'Edge 缓存', path: path.join(LOCAL, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'), tier: 'cleanable', note: '页面缓存' },
  { id: 'c_thumb', name: '缩略图缓存', path: path.join(LOCAL, 'Microsoft', 'Windows', 'Explorer'), tier: 'cleanable', note: 'thumbcache 缩略图(仅缓存)' },
  { id: 'c_wps_cache', name: 'WPS 缓存', path: path.join(LOCAL, 'Kingsoft', 'WPS Office'), tier: 'ask', note: '只应清其 Cache 子目录,先问' },
  { id: 'c_win_temp', name: 'Windows 临时目录', path: path.join(process.env.SystemDrive || 'C:', '\\Windows', 'Temp'), tier: 'ask', note: '需管理员,先问' },
  { id: 'c_winupdate', name: 'Windows 更新下载', path: path.join(process.env.SystemDrive || 'C:', '\\Windows', 'SoftwareDistribution', 'Download'), tier: 'ask', note: '更新安装包下载缓存,先问' },
  { id: 'c_hf', name: 'HuggingFace 模型缓存', path: path.join(HOME, '.cache', 'huggingface', 'hub'), tier: 'ask', note: '模型文件可能很大,先问' },
  { id: 'c_ollama', name: 'Ollama 模型', path: path.join(HOME, '.ollama', 'models'), tier: 'ask', note: '本地模型,先问' },
  { id: 'c_npm_roam', name: 'npm 漫游缓存', path: path.join(ROAM, 'npm', '_cacache'), tier: 'cleanable', note: 'npm 全局缓存(可重建)' },
  { id: 'c_playwright', name: 'Playwright 浏览器', path: path.join(LOCAL, 'ms-playwright'), tier: 'ask', note: '若不再用 Playwright 可整目录删' },
  { id: 'c_mcafee', name: 'McAfee 残留', path: path.join(PROGDATA, 'McAfee'), tier: 'cleanable', note: '已确认未安装的残留(若日后装回请先取消勾选)' },
  { id: 'c_zoog', name: 'ZoogVPN 数据', path: path.join(PROGDATA, 'ZoogVpn'), tier: 'ask', note: '仍装了 ZoogVPN,若不再用可考虑卸载后清' }
];

// 自我探索：对已安装软件的 AppData 同名目录下钻，发现其纯缓存/日志/临时子目录
// 新装任何软件后，这里会自动把它名下可清/先问的子目录找出来
async function exploreAppCaches() {
  await ensureBases();
  const out = [];
  const seen = new Set();
  const lls = await installedLocations();
  for (const { name } of lls) {
    if (!name || /^\{[\da-f-]+\}$/i.test(name)) continue;
    for (const root of [LOCAL, ROAM]) {
      const base = path.join(root, name);
      if (!(await statExists(base)) || seen.has(base)) continue;
      seen.add(base);
      const pure = await findSubdirs(base, [(n) => PURE_CACHE_NAMES.has(n)], 3);
      for (const sub of pure) {
        if (out.some((o) => o.path === sub)) continue;
        const { size } = await walkSize(sub);
        if (size > 0) out.push({
          id: `e_${out.length}`, module: 'caches', name: `发现缓存 · ${name}`,
          path: sub, size, tier: 'cleanable', confidence: 88, note: '已安装软件内发现的纯缓存子目录,可重建'
        });
      }
      const ask = await findSubdirs(base, [(n) => ASK_CACHE_NAMES.has(n)], 3);
      for (const sub of ask) {
        if (out.some((o) => o.path === sub)) continue;
        const { size } = await walkSize(sub);
        if (size > 0) out.push({
          id: `e_${out.length}`, module: 'caches', name: `发现数据 · ${name}`,
          path: sub, size, tier: 'ask', confidence: 60, note: '已安装软件内的日志/临时/备份子目录,先确认'
        });
      }
    }
  }
  return out;
}

export async function scanCaches() {
  const ignore = await ignoredSet();
  const out = [];
  for (const r of CACHE_RULES) {
    if (!(await statExists(r.path))) continue;
    if (ignore.has(r.path.toLowerCase())) continue;
    const { size } = await walkSize(r.path);
    out.push({
      id: `c_${out.length}`, module: 'caches', name: r.name,
      path: r.path, size, tier: r.tier, confidence: r.tier === 'cleanable' ? 92 : 60, note: r.note
    });
  }

  // 动态发现：NVIDIA 着色器缓存（只清缓存子目录，驱动核心不动）
  const nvDirs = [
    ...await findSubdirs(path.join(PROGDATA, 'NVIDIA Corporation'), [/nv_cache/i, /dxcache/i], 2),
    ...await findSubdirs(path.join(LOCAL, 'NVIDIA'), [/dxcache/i, /nv_cache/i], 2)
  ];
  for (const p of nvDirs) {
    if (ignore.has(p.toLowerCase())) continue;
    const { size } = await walkSize(p);
    out.push({ id: `c_${out.length}`, module: 'caches', name: 'NVIDIA 着色器缓存', path: p, size, tier: 'cleanable', confidence: 90, note: '仅缓存子目录,可重建' });
  }

  // 动态发现：WPS 缓存子目录（Cache / pool / backup，绝不碰云文档同步目录）
  const wpsDirs = await findSubdirs(path.join(LOCAL, 'Kingsoft'), ['cache', 'pool', 'backup'], 3);
  for (const p of wpsDirs) {
    if (ignore.has(p.toLowerCase())) continue;
    const { size } = await walkSize(p);
    out.push({ id: `c_${out.length}`, module: 'caches', name: 'WPS 缓存子目录', path: p, size, tier: 'cleanable', confidence: 90, note: '仅 Kingsoft 下 Cache/pool/backup,不碰云文档' });
  }

  // 自我探索：已安装软件的缓存子目录
  out.push(...await exploreAppCaches());
  return out;
}

// ---- Agent 工作区规则 ----
const AGENT_RULES = [
  { id: 'a_opencode', name: 'opencode (运行中)', path: path.join(HOME, '.opencode'), tier: 'locked', note: '当前正在运行,只报告体积,禁止清理' },
  { id: 'a_evolve', name: 'selfforge 主库 ~/.evolve', path: path.join(HOME, '.evolve'), tier: 'locked', note: '活跃 daemon 记忆主库,禁止清理' },
  { id: 'a_claude', name: 'Claude Code 工作区', path: path.join(HOME, '.claude'), tier: 'ask', note: '含设置与历史,优先清 shell-snapshots/旧会话' },
  { id: 'a_codex', name: 'OpenAI Codex', path: path.join(HOME, '.codex'), tier: 'ask', note: '会话历史仓库,先问' },
  { id: 'a_cursor', name: 'Cursor 编辑器', path: path.join(HOME, '.cursor'), tier: 'ask', note: '含缓存子目录,可精准清 CachedData/Code Cache' },
  { id: 'a_generic', name: '通用 ~/.cache', path: path.join(HOME, '.cache'), tier: 'ask', note: '含模型/工具缓存,先问' },
  { id: 'a_local', name: '通用 ~/.local', path: path.join(HOME, '.local'), tier: 'ask', note: '用户级数据目录,先问' },
  { id: 'a_bun', name: 'bun 目录 ~/.bun', path: path.join(HOME, '.bun'), tier: 'ask', note: 'bun 安装缓存可清,全局二进制保留' },
  { id: 'a_npm', name: 'npm 目录 ~/.npm', path: path.join(HOME, '.npm'), tier: 'ask', note: '_cacache 缓存可清,凭证保留' }
];

export async function scanAgents() {
  const ignore = await ignoredSet();
  const out = [];
  for (const r of AGENT_RULES) {
    if (!(await statExists(r.path))) continue;
    if (ignore.has(r.path.toLowerCase())) continue;
    const { size } = await walkSize(r.path);
    out.push({
      id: `a_${out.length}`, module: 'agents', name: r.name,
      path: r.path, size, tier: r.tier,
      confidence: r.tier === 'locked' ? 100 : 65, note: r.note
    });
  }
  return out;
}