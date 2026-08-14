// SweepWise 前端逻辑（零依赖）
const $ = (s) => document.querySelector(s);
const state = { tab: 'overview', scan: null, sel: new Set() };

const I18N = {
  tab: { overview: '总览', leftovers: '卸载残留', caches: '缓存清理', agents: 'Agent 工作区', trash: '隔离区' },
  theme: { on: '切换浅色', off: '切换深色' }
};

function humanSize(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

function badge(tier) {
  const label = tier === 'cleanable' ? '可清理' : tier === 'ask' ? '先询问' : '禁动';
  return `<span class="badge ${tier}">${label}</span>`;
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---- 主题 ----
function initTheme() {
  const saved = localStorage.getItem('sweepwise-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = saved;
  $('#theme-toggle').textContent = I18N.theme[saved === 'dark' ? 'on' : 'off'];
}
$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = cur;
  localStorage.setItem('sweepwise-theme', cur);
  $('#theme-toggle').textContent = I18N.theme[cur === 'dark' ? 'on' : 'off'];
});

// ---- 导航 ----
function setTab(tab) {
  state.tab = tab;
  state.sel.clear();
  $('#page-title').textContent = I18N.tab[tab];
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  render();
}
document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

// ---- 渲染 ----
function render() {
  const content = $('#content');
  if (state.tab === 'overview') return renderOverview(content);
  if (state.tab === 'trash') return renderTrash(content);
  renderModule(content, state.tab);
}

function renderOverview(content) {
  content.innerHTML = '<div class="loading">正在扫描系统，可能需要几秒…</div>';
  const fresh = !!state.forceFresh; state.forceFresh = false;
  api('/api/scan?t=all' + (fresh ? '&fresh=1' : '')).then((d) => {
    state.scan = { findings: d.findings, stats: d.stats };
    const s = d.stats;
    const byModule = {};
    for (const f of d.findings) { (byModule[f.module] = byModule[f.module] || []).push(f); }
    const MOD = {
      leftovers: ['卸载残留', '对账注册表找出的孤儿目录'],
      caches: ['缓存清理', '开发工具 / 浏览器 / 系统缓存'],
      agents: ['Agent 工作区', 'opencode / Claude / Codex / Cursor 等']
    };
    content.innerHTML = `
      <div class="cards">
        <div class="card"><div class="lbl">发现项</div><div class="num">${s.total}</div></div>
        <div class="card"><div class="lbl">可清理</div><div class="num" style="color:var(--green-txt)">${s.tier.cleanable || 0}</div></div>
        <div class="card"><div class="lbl">先询问</div><div class="num" style="color:var(--amber-txt)">${s.tier.ask || 0}</div></div>
        <div class="card"><div class="lbl">禁动</div><div class="num" style="color:var(--red-txt)">${s.tier.locked || 0}</div></div>
        <div class="card"><div class="lbl">可释放估算</div><div class="big">${humanSize(s.size)}</div></div>
        <div class="card"><div class="lbl">禁动项占用</div><div class="big dim">${humanSize(s.sizeLocked || 0)}</div></div>
      </div>
      <div class="banner">
        <div>
          <div class="tt">安全模型</div>
          <div class="dd">删除一律先进隔离区（可一键恢复）· 系统路径硬黑名单双重拦截 · 禁动项即时标红 · 每步写入审计日志</div>
          <div class="dd">上次扫描 ${new Date(d.at || Date.now()).toLocaleTimeString()}${d.cached ? '（缓存）' : ''}</div>
        </div>
        <button class="btn primary" id="cbtn-all">清理所有「可清理」项</button>
      </div>
      ${Object.keys(byModule).map((m) => {
        const list = byModule[m];
        const sz = list.reduce((a, b) => a + b.size, 0);
        return `<div class="banner">
          <div><div class="tt">${MOD[m][0]} <span class="small">(${MOD[m][1]})</span></div>
          <div class="dd">${list.length} 项 · 合计 ${humanSize(sz)} · 可清 ${list.filter((f) => f.tier === 'cleanable').length} / 先问 ${list.filter((f) => f.tier === 'ask').length} / 禁动 ${list.filter((f) => f.tier === 'locked').length}</div></div>
          <button class="btn" data-goto="${m}">详情</button></div>`;
      }).join('')}
    `;
    $('#cbtn-all').addEventListener('click', async () => {
      const items = d.findings.filter((f) => f.tier === 'cleanable');
      if (!items.length) return toast('没有可清理项');
      await runClean(items);
    });
    document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.goto)));
  }).catch((e) => { content.innerHTML = `<div class="empty">扫描失败：${e.message}</div>`; toast('扫描失败'); });
}

function renderModule(content, tab) {
  const T = { leftovers: ['卸载残留', '扫描本地与漫游目录，识别疑似孤儿目录'], caches: ['缓存清理', '常用软件的缓存目录'], agents: ['Agent 工作区', 'AI 工具与开发环境目录'] };
  content.innerHTML = `
    <div class="banner">
      <div><div class="tt">${T[tab][0]}</div><div class="dd">${T[tab][1]} · 只做只读预览，勾选后确认才会隔离</div></div>
      <div><button class="btn" id="b-scan">重新扫描</button></div>
    </div>
    <div id="module-body"><div class="loading">点击「扫描」查看结果</div></div>
  `;
  $('#b-scan').addEventListener('click', () => scanModule(tab, true));
  scanModule(tab, false);
}

function scanModule(tab, fresh) {
  const body = $('#module-body');
  body.innerHTML = fresh ? '<div class="loading">正在重新扫描…</div>' : '<div class="loading">加载中…</div>';
  const renderStat = (d) => {
    const s = d.stats;
    body.innerHTML = `
      <div class="cards">
        <div class="card"><div class="lbl">发现项</div><div class="num">${s.total}</div></div>
        <div class="card"><div class="lbl">可清理</div><div class="num" style="color:var(--green-txt)">${s.tier.cleanable || 0}</div></div>
        <div class="card"><div class="lbl">先询问</div><div class="num" style="color:var(--amber-txt)">${s.tier.ask || 0}</div></div>
        <div class="card"><div class="lbl">禁动</div><div class="num" style="color:var(--red-txt)">${s.tier.locked || 0}</div></div>
        <div class="card"><div class="lbl">合计大小</div><div class="big">${humanSize(s.size)}</div></div>
      </div>
      <div class="actions">
        <button class="btn" id="selall">全选可清理</button>
        <button class="btn primary" id="doselect">清理所选（进隔离区）</button>
        <span class="sel-info">已选 <b id="selcount">0</b> 项 · <b id="selsize">0</b></span>
      </div>
      <div class="small" style="margin: -8px 0 12px">上次扫描 ${new Date(d.at || Date.now()).toLocaleTimeString()}${d.cached ? '（缓存）' : ''} · 需要最新结果点「重新扫描」</div>
      <div class="sheet">
        <table>
          <thead><tr><th class="checkbox-col"></th><th>名称</th><th>路径</th><th></th><th>置信度</th><th class="num">大小</th><th>说明</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    `;
    const tbody = $('#rows');
    for (const f of d.findings) {
      const tr = document.createElement('tr');
      const chk = f.tier === 'locked' ? '' : `<input type="checkbox" data-path="${escapeAttr(f.path)}">`;
      tr.innerHTML = `<td class="checkbox-col">${chk}</td>
        <td>${f.name} ${badge(f.tier)}</td>
        <td class="path">${f.path}</td>
        <td>${f.tier !== 'locked' ? `<button class="btn ghost small" data-ignore="${escapeAttr(f.path)}">忽略</button>` : ''}</td>
        <td>${f.confidence}%</td>
        <td class="num">${humanSize(f.size)}</td>
        <td class="small">${f.note}</td>`;
      tbody.appendChild(tr);
      const cb = tr.querySelector('input[type=checkbox]');
      if (cb) {
        cb.checked = state.sel.has(f.path);
        cb.addEventListener('change', () => {
          if (cb.checked) state.sel.add(f.path); else state.sel.delete(f.path);
          updateSel();
        });
      }
      const ig = tr.querySelector('[data-ignore]');
      if (ig) ig.addEventListener('click', async () => {
        await api('/api/ignore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: ig.dataset.ignore }) });
        toast('已忽略该项');
        scanModule(tab);
      });
    }
    $('#selall').addEventListener('click', () => {
      for (const f of d.findings) if (f.tier !== 'locked') state.sel.add(f.path);
      scanModule(tab);
    });
    $('#doselect').addEventListener('click', async () => {
      const items = d.findings.filter((f) => state.sel.has(f.path));
      if (!items.length) return toast('请先勾选项目');
      await runClean(items);
      state.sel.clear();
      scanModule(tab);
    });
    updateSel();
  };
  api(`/api/scan?t=${tab}${fresh ? '&fresh=1' : ''}`).then(renderStat).catch((e) => { body.innerHTML = `<div class="empty">扫描失败：${e.message}</div>`; });
}

function updateSel() {
  const c = $('#selcount'); const s = $('#selsize');
  if (!c) return;
  const items = state.scan ? state.scan.findings.filter((f) => state.sel.has(f.path)) : [];
  c.textContent = items.length;
  s.textContent = humanSize(items.reduce((a, b) => a + b.size, 0));
}

async function runClean(items) {
  const res = await api('/api/clean', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
  const skipped = (res.results || []).filter((r) => r.skipped).length;
  if (res.failed && res.failed.length) {
    toast(`清理 ${res.done} 项，${skipped} 项已不存在跳过，${res.failed.length} 项失败（权限/占用）`);
  } else if (skipped) {
    toast(`已隔离 ${res.done} 项，${skipped} 项已不存在自动跳过`);
  } else {
    toast(`已隔离 ${res.done} 项（可在隔离区恢复）`);
  }
}

function renderTrash(content) {
  content.innerHTML = '<div class="loading">加载中…</div>';
  Promise.all([api('/api/quarantine'), api('/api/audit?n=100')]).then(([q, a]) => {
    const items = q.items;
    content.innerHTML = `
      <div class="banner"><div><div class="tt">隔离区</div>
      <div class="dd">删除的本体移到这里，随时可一键恢复。确认无用后再「彻底删除」真正释放磁盘。</div></div></div>
      ${items.length ? `<div class="sheet"><table>
        <thead><tr><th>名称</th><th>原位置</th><th>模块</th><th class="num">大小</th><th>时间</th><th>操作</th></tr></thead>
        <tbody>${items.map((m, i) => `<tr>
          <td>${m.name}</td><td class="path">${m.orig}</td>
          <td>${m.module}</td><td class="num">${humanSize(m.size)}</td><td class="small">${(m.at || '').slice(0, 19)}</td>
          <td><button class="btn" data-restore="${m.id}">恢复</button>
          <button class="btn danger" data-purge="${m.id}">彻底删除</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">隔离区为空</div>'}
      <h2 class="sec">审计日志（最近 ${a.items.length} 条）</h2>
      <div class="sheet"><table>
        <thead><tr><th>时间</th><th>动作</th><th>事项</th><th class="num">大小</th></tr></thead>
        <tbody>${a.items.map((l) => `<tr><td class="small">${(l.ts || l.at || '').slice(0, 19)}</td>
          <td>${l.action}</td><td class="path">${l.path || l.item || l.raw || ''}</td>
          <td class="num">${l.size ? humanSize(l.size) : ''}</td></tr>`).join('')}</tbody></table></div>
    `;
    document.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
      const r = await api('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.restore }) });
      toast(r.ok ? '已恢复' : '恢复失败');
      renderTrash(content);
    }));
    document.querySelectorAll('[data-purge]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('彻底删除不可恢复，确认？')) return;
      const r = await api('/api/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.purge }) });
      toast(r.ok ? '已彻底删除' : '删除失败');
      renderTrash(content);
    }));
  }).catch((e) => { content.innerHTML = `<div class="empty">加载失败：${e.message}</div>`; });
}

$('#btn-scan-all').addEventListener('click', () => { state.forceFresh = true; state.tab = 'overview'; setTab('overview'); });
$('#btn-export').addEventListener('click', () => { window.location.href = '/api/export'; });

// ---- 更新 ----
async function checkUpdateUI(silent) {
  const chip = $('#ver-chip');
  const btn = $('#btn-update');
  btn.disabled = true;
  try {
    const r = await api('/api/update/check');
    if (r.ok) {
      chip.textContent = `v${r.current}`;
      if (r.hasUpdate) {
        chip.classList.add('has-update');
        btn.textContent = `升级到 v${r.latest}`;
      } else if (!silent) {
        toast(`当前已是最新版本 v${r.current}`);
      }
    } else if (!silent) {
      toast(`检查更新失败：${r.error || '无法连接 GitHub'}`);
    }
  } catch (e) {
    if (!silent) toast(`检查更新失败：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

$('#btn-update').addEventListener('click', async () => {
  const r = await api('/api/update/check');
  if (!r.ok) return toast(`检查更新失败：${r.error || '无法连接 GitHub'}`);
  if (!r.hasUpdate) return toast(`当前已是最新版本 v${r.current}`);
  if (!confirm(`发现新版本 v${r.latest}（当前 v${r.current}）\n将自动下载并重启应用。确定更新？`)) return;
  const btn = $('#btn-update');
  btn.disabled = true;
  btn.textContent = '正在下载并更新…';
  try {
    const a = await api('/api/update/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (a.ok) {
      toast('更新完成，应用即将重启…');
      setTimeout(() => location.reload(), 4000);
    } else {
      toast(`更新失败：${a.error}`);
      btn.textContent = '重试';
    }
  } catch (e) {
    toast(`更新失败：${e.message}`);
    btn.textContent = '重试';
  }
});

checkUpdateUI(true);

function escapeAttr(s) { return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

initTheme();
setTab('overview');