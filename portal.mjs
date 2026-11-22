// AGY 共享工作区门户
// - 每个用户在 users/<name>/ 拥有独立文件夹（只能看到/修改自己的）
// - 支持拖拽上传、下载、文件夹打包 zip、文本/图片预览
// 零依赖，只用 Node 标准库。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { detectEngines, attachEngineSession, shutdownAllEngines } from './tools/acp-engines.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CFG_FILE = process.env.AGY_CFG_FILE || path.join(ROOT, 'users.json');
const USERS_DIR = process.env.AGY_USERS_DIR || path.join(ROOT, 'users');
const ONLY_USER = (process.env.AGY_ONLY_USER || '').trim().toLowerCase();
const LOG_DIR = process.env.AGY_LOG_DIR || path.join(ROOT, 'logs');
const DATA_DIR = process.env.AGY_DATA_DIR || (ONLY_USER ? path.join(LOG_DIR, 'workbench-data') : path.join(ROOT, 'workbench-data'));
const ST_CONFIG_XML = path.join(ROOT, 'syncthing', 'config', 'config.xml');
const MAX_UPLOAD = 512 * 1024 * 1024;

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!ONLY_USER) fs.mkdirSync(USERS_DIR, { recursive: true });

// 每次请求/升级时重新读取 users.json，实现成员增删、密钥重置“热生效”（不用重启门户）
function ensureCfgExists() {
  if (fs.existsSync(CFG_FILE)) return;
  const ex = path.join(ROOT, 'users.example.json');
  if (!fs.existsSync(ex)) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(ex, 'utf8').replace(/^\uFEFF/, ''));
    for (const u of cfg.users || []) {
      if (!u.token || String(u.token).startsWith('REPLACE') || String(u.token).length < 16) {
        u.token = crypto.randomBytes(18).toString('hex');
      }
    }
    fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {}
}
ensureCfgExists();

function readCfg() {
  return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8').replace(/^\uFEFF/, ''));
}
function buildUsers() {
  const cfg = readCfg();
  const map = new Map(); // token -> { name, root }
  for (const u of cfg.users || []) {
    if (!u || !u.name || !u.token) continue;
    const name = String(u.name).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) continue;
    if (ONLY_USER && name !== ONLY_USER) continue;
    const root = path.join(USERS_DIR, name);
    try { fs.mkdirSync(root, { recursive: true }); } catch {}
    map.set(String(u.token), { name, root });
  }
  return map;
}
function ports() {
  const cfg = readCfg();
  return {
    portal: Number(process.env.AGY_PORTAL_PORT || cfg.portalPort || 3088),
    relay: Number(process.env.AGY_RELAY_PORT || cfg.relayPort || 3090),
  };
}
const startCfg = ports();
const PORTAL_PORT = startCfg.portal;
const RELAY_PORT = startCfg.relay;
buildUsers();

function log(m) { console.log(new Date().toISOString(), m); }

function lanIPv4() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const it of list || []) if (it.family === 'IPv4' && !it.internal) out.push(it.address);
  }
  return out;
}

function safeJoin(root, rel) {
  const p = path.normalize(path.join(root, rel || ''));
  if (p !== root && !p.startsWith(root + path.sep)) return null;
  return p;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function human(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function relTime(sec) {
  if (sec < 10) return '刚刚';
  if (sec < 60) return sec + ' 秒前';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
  return Math.floor(sec / 86400) + ' 天前';
}
function encodeRelPath(rel) {
  return String(rel || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.stfolder', '.stversions']);
const ACT_MAX_DEPTH = 6;
const ACT_MAX_ITEMS = 500;
const ACT_MAX_WALK = 5000;

function scanActivity(userRoot, userName) {
  const collected = [];
  let truncated = false;

  function walk(dirAbs, relPrefix, depth) {
    if (collected.length >= ACT_MAX_WALK) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (collected.length >= ACT_MAX_WALK) { truncated = true; break; }
      if (ent.isSymbolicLink && ent.isSymbolicLink()) continue;
      const childAbs = path.join(dirAbs, ent.name);
      const childRel = relPrefix ? (relPrefix + '/' + ent.name) : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || depth >= ACT_MAX_DEPTH) continue;
        walk(childAbs, childRel, depth + 1);
      } else if (ent.isFile()) {
        let st;
        try { st = fs.statSync(childAbs); } catch { continue; }
        collected.push({ path: childRel, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }

  walk(userRoot, '', 0);
  collected.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const nowMs = Date.now();
  let recent5mCount = 0;
  let hotCount = 0;
  for (const it of collected) {
    const diffMs = Math.max(0, nowMs - it.mtimeMs);
    if (diffMs < 300000) recent5mCount++;
    if (diffMs < 60000) hotCount++;
  }

  if (collected.length > ACT_MAX_ITEMS) truncated = true;
  const sliced = collected.slice(0, ACT_MAX_ITEMS);
  const items = sliced.map(it => {
    const ageSec = Math.max(0, Math.floor((nowMs - it.mtimeMs) / 1000));
    return {
      path: it.path,
      size: it.size,
      sizeHuman: human(it.size),
      mtimeMs: it.mtimeMs,
      mtimeIso: new Date(it.mtimeMs).toISOString(),
      mtimeLocal: new Date(it.mtimeMs).toLocaleString(),
      ageSec,
      relative: relTime(ageSec),
      hot: ageSec < 60,
    };
  });

  const latest = items.length > 0 ? items[0] : null;
  const status = hotCount > 0 ? 'active' : (recent5mCount > 0 ? 'recent' : 'idle');

  return {
    user: userName,
    root: userRoot,
    generatedAt: nowMs,
    generatedAtIso: new Date(nowMs).toISOString(),
    totalFiles: collected.length,
    returnedFiles: items.length,
    truncated,
    hotCount,
    recent5mCount,
    latestMtimeMs: latest ? latest.mtimeMs : null,
    latestAgeSec: latest ? latest.ageSec : null,
    latestRelative: latest ? latest.relative : '无文件',
    status,
    items,
  };
}

const CLIENT_JS = `
async function readAllEntries(reader) {
  const out = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch || batch.length === 0) break;
    out.push(...batch);
  }
  return out;
}
async function walkEntry(entry, prefix) {
  if (!entry) return [];
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    const relPath = prefix ? (prefix + '/' + file.name) : file.name;
    return [{ file, relPath }];
  }
  if (entry.isDirectory) {
    const nextPrefix = prefix ? (prefix + '/' + entry.name) : entry.name;
    const children = await readAllEntries(entry.createReader());
    const out = [];
    for (const child of children) {
      out.push(...await walkEntry(child, nextPrefix));
    }
    return out;
  }
  return [];
}
async function collectDropItems(dt) {
  const items = dt && dt.items ? Array.from(dt.items) : [];
  const entries = items.map(it => it.webkitGetAsEntry ? it.webkitGetAsEntry() : null).filter(Boolean);
  if (entries.length > 0) {
    const out = [];
    for (const ent of entries) {
      out.push(...await walkEntry(ent, ''));
    }
    return out;
  }
  return Array.from((dt && dt.files) || []).map(f => ({ file: f, relPath: f.webkitRelativePath || f.name }));
}
async function uploadEntries(entries, dirRel) {
  if (!entries || entries.length === 0) return;
  const statusEl = document.getElementById('up-status');
  const failed = [];
  let okCount = 0;
  for (let i = 0; i < entries.length; i++) {
    const it = entries[i];
    const name = String(it.relPath || it.file.name).replace(/^\\/+/, '');
    if (statusEl) statusEl.textContent = '正在上传 ' + (i + 1) + ' / ' + entries.length + ': ' + name;
    try {
      const r = await fetch('/upload?dir=' + encodeURIComponent(dirRel || '') + '&name=' + encodeURIComponent(name), { method: 'POST', body: it.file });
      if (r.ok) okCount++;
      else failed.push(name + ': 失败 ' + r.status);
    } catch (e) {
      failed.push(name + ': 网络错误');
    }
  }
  if (statusEl) statusEl.textContent = '上传完成：成功 ' + okCount + ' 个' + (failed.length ? ('，失败 ' + failed.length + ' 个') : '');
  if (failed.length > 0) {
    alert('部分文件上传失败（成功 ' + okCount + ' 个）：\\n' + failed.slice(0, 15).join('\\n'));
  }
  location.reload();
}
function initDrop() {
  const zone = document.getElementById('drop');
  if (!zone) return;
  const dir = zone.dataset.dir || '';
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('hot'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('hot'));
  zone.addEventListener('drop', async e => {
    e.preventDefault();
    zone.classList.remove('hot');
    const list = await collectDropItems(e.dataTransfer);
    await uploadEntries(list, dir);
  });
  const inp = document.getElementById('pick');
  if (inp) inp.addEventListener('change', () => {
    const list = Array.from(inp.files || []).map(f => ({ file: f, relPath: f.webkitRelativePath || f.name }));
    uploadEntries(list, dir);
  });
  const inpDir = document.getElementById('pick-dir');
  if (inpDir) inpDir.addEventListener('change', () => {
    const list = Array.from(inpDir.files || []).map(f => ({ file: f, relPath: f.webkitRelativePath || f.name }));
    uploadEntries(list, dir);
  });
}
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function encRel(rel) {
  return String(rel || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}
function initActivity() {
  const app = document.getElementById('activity-app');
  if (!app) return;
  const tbody = document.getElementById('act-tbody');
  const summaryEl = document.getElementById('act-summary');
  const updatedEl = document.getElementById('act-updated');
  const autoEl = document.getElementById('act-auto');
  const only5mEl = document.getElementById('act-only5m');
  const filterEl = document.getElementById('act-filter');
  const refreshBtn = document.getElementById('act-refresh');
  let lastData = null;
  let inFlight = false;

  function renderData(d) {
    if (!d) return;
    lastData = d;
    const dotCls = d.status === 'active' ? 'hot' : (d.status === 'recent' ? 'warm' : 'idle');
    const stateLabel = d.status === 'active'
      ? 'Agent 正在活跃写入'
      : (d.status === 'recent' ? '近期有文件变化' : '当前空闲（60秒内无写入）');
    const truncNote = d.truncated ? '（已截断，仅展示前 ' + d.returnedFiles + ' 条）' : '';
    summaryEl.innerHTML =
      '<span class="dot ' + dotCls + '"></span>' +
      '<div>' +
        '<div><b>' + escHtml(stateLabel) + '</b></div>' +
        '<div class="muted">最近活动：<b>' + escHtml(d.latestRelative || '无文件') + '</b>' +
        ' · 最近 5 分钟 <b>' + Number(d.recent5mCount || 0) + '</b> 个文件变化' +
        ' · 60 秒内活跃 <b>' + Number(d.hotCount || 0) + '</b> 个' +
        ' · 共 ' + Number(d.totalFiles || 0) + ' 个文件' + escHtml(truncNote) + '</div>' +
      '</div>';

    updatedEl.textContent = '上次刷新：' + new Date(d.generatedAt || Date.now()).toLocaleTimeString();

    const q = (filterEl && filterEl.value || '').trim().toLowerCase();
    const only5m = !!(only5mEl && only5mEl.checked);
    const list = (d.items || []).filter(it => {
      if (only5m && it.ageSec >= 300) return false;
      if (q && !String(it.path || '').toLowerCase().includes(q)) return false;
      return true;
    });

    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">暂无匹配的文件活动</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(it => {
      const enc = encRel(it.path);
      const badge = it.hot ? '<span class="badge-hot">编辑中 &lt;60s</span>' : '';
      return '<tr class="' + (it.hot ? 'hot' : '') + '">' +
        '<td><code>' + escHtml(it.path) + '</code>' + badge + '</td>' +
        '<td class="muted">' + escHtml(it.sizeHuman) + '</td>' +
        '<td class="muted">' + escHtml(it.mtimeLocal || new Date(it.mtimeMs).toLocaleString()) + '</td>' +
        '<td>' + escHtml(it.relative) + '</td>' +
        '<td class="muted"><a href="/preview/' + enc + '" target="_blank">预览</a> · <a href="/download/' + enc + '">下载</a></td>' +
      '</tr>';
    }).join('');
  }

  async function pull() {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await fetch('/activity.json', { cache: 'no-store' });
      if (r.status === 401) { location.href = '/'; return; }
      if (!r.ok) return;
      const d = await r.json();
      renderData(d);
    } catch (e) {
      if (updatedEl) updatedEl.textContent = '刷新失败（将重试）';
    } finally {
      inFlight = false;
    }
  }

  if (refreshBtn) refreshBtn.addEventListener('click', pull);
  if (only5mEl) only5mEl.addEventListener('change', () => renderData(lastData));
  if (filterEl) filterEl.addEventListener('input', () => renderData(lastData));

  pull();
  setInterval(() => {
    if (!autoEl || autoEl.checked) pull();
  }, 3000);
}
document.addEventListener('DOMContentLoaded', () => { initDrop(); initActivity(); });
`;

function page(title, body, user) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#111418;color:#e6e6e6;font:15px/1.55 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
a{color:#7ab8ff;text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid #24292f;background:#151920;flex-wrap:wrap}
header b{font-size:16px}header .sp{flex:1}
main{padding:20px;max-width:1100px;margin:0 auto}
.drop{border:2px dashed #3a4450;border-radius:12px;padding:22px;text-align:center;color:#9aa4b2;margin:16px 0;transition:.15s}
.drop.hot{border-color:#4c9aff;background:#131c2b;color:#cfe3ff}
table{width:100%;border-collapse:collapse}td,th{padding:8px 10px;border-bottom:1px solid #222a33;text-align:left;vertical-align:top}
th{color:#8b96a5;font-weight:500;font-size:13px}
tr:hover td{background:#161d26}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;background:#1d2732;color:#9fb3c8;font-size:12px}
.muted{color:#8b96a5;font-size:13px}
input[type=password],input[type=text]{background:#0d1117;border:1px solid #30363d;color:#e6e6e6;padding:8px 10px;border-radius:8px;width:min(340px,80vw)}
button{background:#2563eb;border:0;color:#fff;padding:8px 16px;border-radius:8px;cursor:pointer}
button.sec{background:#21262d;border:1px solid #30363d;color:#d0d7de;padding:6px 12px}
pre{background:#0d1117;border:1px solid #222a33;border-radius:8px;padding:12px;overflow:auto;max-height:70vh}
img{max-width:100%;border-radius:8px;max-height:70vh}
.summary-bar{display:flex;align-items:center;gap:12px;padding:12px 16px;border:1px solid #24292f;border-radius:10px;background:#151920;margin:12px 0;flex-wrap:wrap}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex:0 0 auto}
.dot.hot{background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.22)}
.dot.warm{background:#f59e0b;box-shadow:0 0 0 4px rgba(245,158,11,.18)}
.dot.idle{background:#64748b}
.controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:10px 0 14px}
.controls label{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:#b1bac4;cursor:pointer}
tr.hot td{background:#132a22}
tr.hot:hover td{background:#17352b}
tr.hot td:first-child{border-left:3px solid #22c55e}
.badge-hot{display:inline-block;background:#166534;color:#86efac;padding:1px 7px;border-radius:999px;font-size:12px;margin-left:8px;vertical-align:middle}
</style></head><body>
<header><b>AGY 共享工作区</b><span class="muted">agent: ws://${esc(String(RELAY_PORT))}/</span><span class="sp"></span>${user ? `<span class="tag">${esc(user.name)}</span> <a href="/workbench">工作台</a> <a href="/files/">我的文件</a> <a href="/activity">文件活动</a> <a href="/logout">退出</a>` : ''}</header>
<main>${body}</main>
<script>${CLIENT_JS}</script>
</body></html>`;
}

function renderActivity(res, user) {
  const snap = scanActivity(user.root, user.name);
  const dotCls = snap.status === 'active' ? 'hot' : (snap.status === 'recent' ? 'warm' : 'idle');
  const stateLabel = snap.status === 'active'
    ? 'Agent 正在活跃写入'
    : (snap.status === 'recent' ? '近期有文件变化' : '当前空闲（60秒内无写入）');
  const initialRows = snap.items.map(it => {
    const enc = encodeRelPath(it.path);
    const badge = it.hot ? '<span class="badge-hot">编辑中 &lt;60s</span>' : '';
    return `<tr class="${it.hot ? 'hot' : ''}"><td><code>${esc(it.path)}</code>${badge}</td><td class="muted">${esc(it.sizeHuman)}</td><td class="muted">${esc(it.mtimeLocal)}</td><td>${esc(it.relative)}</td><td class="muted"><a href="/preview/${enc}" target="_blank">预览</a> · <a href="/download/${enc}">下载</a></td></tr>`;
  }).join('');

  const body = `
<div id="activity-app">
  <h2 style="margin-top:0">文件活动监控</h2>
  <p class="muted" style="margin-top:-6px">目录：<code>${esc(user.root)}</code> · 每 3 秒自动刷新，<b>&lt;60 秒</b>内修改的文件绿色高亮（用于判断 agent 正在编辑还是卡住）。</p>
  <div class="summary-bar" id="act-summary">
    <span class="dot ${dotCls}"></span>
    <div>
      <div><b>${esc(stateLabel)}</b></div>
      <div class="muted">最近活动：<b>${esc(snap.latestRelative)}</b> · 最近 5 分钟 <b>${snap.recent5mCount}</b> 个文件变化 · 60 秒内活跃 <b>${snap.hotCount}</b> 个 · 共 ${snap.totalFiles} 个文件</div>
    </div>
  </div>
  <div class="controls">
    <button type="button" class="sec" id="act-refresh">立即刷新</button>
    <label><input type="checkbox" id="act-auto" checked> 3 秒自动刷新</label>
    <label><input type="checkbox" id="act-only5m"> 只看最近 5 分钟</label>
    <input type="text" id="act-filter" placeholder="过滤路径关键字..." style="width:min(240px,70vw);padding:5px 9px">
    <span class="muted" id="act-updated"></span>
  </div>
  <table>
    <thead><tr><th>相对路径</th><th>大小</th><th>修改时间</th><th>相对时间</th><th>操作</th></tr></thead>
    <tbody id="act-tbody">${initialRows || '<tr><td colspan="5" class="muted">暂无文件</td></tr>'}</tbody>
  </table>
</div>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(page('文件活动', body, user));
}

function renderListing(res, user, rel) {
  const dirAbs = safeJoin(user.root, rel);
  if (!dirAbs) { res.writeHead(400); res.end('bad path'); return; }
  let items;
  try { items = fs.readdirSync(dirAbs, { withFileTypes: true }); }
  catch { res.writeHead(404); res.end('not found'); return; }
  items.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name, 'zh') : a.isDirectory() ? -1 : 1));

  const crumbs = [];
  let acc = '';
  for (const part of rel.split('/').filter(Boolean)) { acc = acc ? acc + '/' + part : part; crumbs.push({ name: part, path: acc }); }

  const rows = items.map(it => {
    const childRel = rel ? rel + '/' + it.name : it.name;
    let st; try { st = fs.statSync(path.join(dirAbs, it.name)); } catch { return ''; }
    if (it.isDirectory()) {
      return `<tr><td>📁 <a href="/files/${encodeURI(childRel)}/">${esc(it.name)}</a></td><td class="muted">文件夹</td><td class="muted">${st.mtime.toLocaleString()}</td><td class="muted"><a href="/zip/${encodeURI(childRel)}">打包下载</a></td></tr>`;
    }
    return `<tr><td>📄 <a href="/download/${encodeURI(childRel)}">${esc(it.name)}</a></td><td class="muted">${human(st.size)}</td><td class="muted">${st.mtime.toLocaleString()}</td>
      <td class="muted"><a href="/preview/${encodeURI(childRel)}" target="_blank">预览</a> · <a href="/download/${encodeURI(childRel)}">下载</a></td></tr>`;
  }).join('');

  const up = rel ? `<a href="/files/${encodeURI(rel.split('/').slice(0, -1).join('/'))}/">⬆ 上一级</a>` : '';
  const crumbHtml = ['<a href="/files/">我的文件</a>'].concat(crumbs.map(c => `<a href="/files/${encodeURI(c.path)}/">${esc(c.name)}</a>`)).join(' / ');

  const body = `
<h2 style="margin-top:0">${crumbHtml}</h2>
<div class="muted">${up}</div>
<div class="drop" id="drop" data-dir="${esc(rel)}">把文件或整个文件夹拖到这里上传，或点击选择：<br>
<div style="margin-top:8px;display:flex;gap:14px;justify-content:center;flex-wrap:wrap">
  <label class="muted">选文件：<input id="pick" type="file" multiple></label>
  <label class="muted">选文件夹：<input id="pick-dir" type="file" webkitdirectory directory multiple></label>
</div>
<div id="up-status" class="muted" style="margin-top:8px"></div>
<div class="muted" style="margin-top:6px">上传到 users/${esc(user.name)}/${esc(rel)} · agent 会话目录已自动映射到 <code>${esc(user.root)}</code></div></div>
<p class="muted">共 ${items.length} 项 · <a href="/zip/${encodeURI(rel)}">打包下载当前文件夹 (.zip)</a></p>
<table><thead><tr><th>名称</th><th>大小</th><th>修改时间</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">空文件夹</td></tr>'}</tbody></table>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page('我的文件', body, user));
}

function serveFile(res, user, rel, download) {
  const p = safeJoin(user.root, rel);
  if (!p) { res.writeHead(400); res.end('bad path'); return; }
  let st; try { st = fs.statSync(p); } catch { res.writeHead(404); res.end('not found'); return; }
  if (st.isDirectory()) {
    if (download) { zipFolder(res, p); return; }
    const cleanRel = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    res.writeHead(302, { Location: cleanRel ? `/files/${encodeURI(cleanRel)}/` : '/files/' });
    res.end();
    return;
  }
  const ext = path.extname(p).toLowerCase();
  const inline = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  }[ext];
  const textExts = ['.txt', '.md', '.json', '.js', '.mjs', '.ts', '.css', '.py', '.log', '.csv', '.yml', '.yaml', '.toml', '.sh', '.ps1', '.bat', '.c', '.h', '.cpp', '.java', '.go', '.rs', '.do', '.ado', '.r', '.rmd', '.tex', '.bib'];
  const headers = { 'Content-Length': st.size };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`;
  if (inline) { headers['Content-Type'] = inline; }
  else if (!download && (ext === '.html' || ext === '.htm')) { headers['Content-Type'] = 'text/html; charset=utf-8'; }
  else if (!download && textExts.includes(ext)) { headers['Content-Type'] = 'text/plain; charset=utf-8'; }
  else { headers['Content-Type'] = 'application/octet-stream'; if (!download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`; }
  res.writeHead(200, headers);
  fs.createReadStream(p).pipe(res);
}

function zipFolder(res, dirAbs) {
  const tmp = path.join(LOG_DIR, 'tmp-zip-' + crypto.randomBytes(6).toString('hex') + '.zip');
  const child = spawn('tar.exe', ['-a', '-c', '-f', tmp, '-C', path.dirname(dirAbs), path.basename(dirAbs)], { windowsHide: true });
  child.on('exit', code => {
    if (code !== 0 || !fs.existsSync(tmp)) { res.writeHead(500); res.end('zip failed'); return; }
    const baseName = path.basename(dirAbs) || 'workspace';
    const zipName = baseName + '.zip';
    const asciiFallback = zipName.replace(/[^\x20-\x7E]|["\\]/g, '_') || 'folder.zip';
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
      'Content-Length': fs.statSync(tmp).size,
    });
    const s = fs.createReadStream(tmp);
    s.pipe(res);
    s.on('close', () => { try { fs.unlinkSync(tmp); } catch {} });
  });
}

function getToken(req) {
  const url = new URL(req.url, 'http://x');
  let token = url.searchParams.get('t') || '';
  if (!token) {
    const m = /(?:^|;\s*)agy_token=([^;]+)/.exec(req.headers.cookie || '');
    if (m) token = decodeURIComponent(m[1]);
  }
  return { token, url };
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limitBytes) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const txt = Buffer.concat(chunks).toString('utf8').trim();
        resolve(txt ? JSON.parse(txt) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function validateRelSegments(raw) {
  const segs = String(raw || '').split(/[\\/]+/).filter(Boolean);
  if (segs.length === 0) return null;
  if (segs.some(s => s === '.' || s === '..' || s.includes(':') || s.includes('\0'))) return null;
  return segs.join('/');
}

function isProtectedName(rel) {
  const low = String(rel || '').replace(/\\/g, '/').toLowerCase();
  return low === '.stfolder' || low.startsWith('.stfolder/') ||
         low === '.stversions' || low.startsWith('.stversions/') ||
         low === '.stignore';
}

function getStApiKey() {
  try {
    const raw = fs.readFileSync(ST_CONFIG_XML, 'utf8');
    const m = /<apikey>([^<]+)<\/apikey>/.exec(raw);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

function stGetJson(apiKey, apiPath) {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port: 8384,
      path: apiPath,
      method: 'GET',
      headers: apiKey ? { 'X-API-Key': apiKey } : {},
      timeout: 1200,
    }, resp => {
      let body = '';
      resp.setEncoding('utf8');
      resp.on('data', d => { body += d; });
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          try { resolve(JSON.parse(body)); return; } catch {}
        }
        resolve(null);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function getUserSyncthingStatus(userName) {
  const folderId = 'agy-' + userName;
  const apiKey = getStApiKey();
  if (!apiKey) return { available: false, folderId, state: 'unavailable', error: 'no config', pairedDevices: 0, connectedDevices: 0 };

  const [statusRes, folderRes, connRes, sysRes] = await Promise.all([
    stGetJson(apiKey, '/rest/db/status?folder=' + encodeURIComponent(folderId)),
    stGetJson(apiKey, '/rest/config/folders/' + encodeURIComponent(folderId)),
    stGetJson(apiKey, '/rest/system/connections'),
    stGetJson(apiKey, '/rest/system/status'),
  ]);

  if (!statusRes) {
    return { available: false, folderId, state: 'offline', error: '', pairedDevices: 0, connectedDevices: 0 };
  }

  const myId = sysRes && sysRes.myID ? String(sysRes.myID) : '';
  const peers = (folderRes && Array.isArray(folderRes.devices))
    ? folderRes.devices.map(d => String(d.deviceID || '')).filter(id => id && id !== myId)
    : [];
  const conns = (connRes && connRes.connections) || {};
  const connectedDevices = peers.filter(id => conns[id] && conns[id].connected).length;

  return {
    available: true,
    folderId,
    myId,
    state: statusRes.state || 'idle',
    error: statusRes.error || '',
    localFiles: Number(statusRes.localFiles || 0),
    globalFiles: Number(statusRes.globalFiles || 0),
    pairedDevices: peers.length,
    connectedDevices,
  };
}

function buildTree(userRoot) {
  const MAX_DEPTH = 6;
  const MAX_NODES = 1200;
  let count = 0;
  const nowMs = Date.now();

  function walk(dirAbs, relPrefix, depth) {
    if (count >= MAX_NODES) return [];
    let entries;
    try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return []; }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name, 'zh') : a.isDirectory() ? -1 : 1));
    const nodes = [];
    for (const ent of entries) {
      if (count >= MAX_NODES) break;
      if (ent.isSymbolicLink && ent.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(ent.name)) continue;
      const childAbs = path.join(dirAbs, ent.name);
      const childRel = relPrefix ? (relPrefix + '/' + ent.name) : ent.name;
      let st;
      try { st = fs.statSync(childAbs); } catch { continue; }
      count++;
      if (ent.isDirectory()) {
        const children = depth < MAX_DEPTH ? walk(childAbs, childRel, depth + 1) : [];
        nodes.push({
          name: ent.name,
          path: childRel,
          type: 'dir',
          size: 0,
          sizeHuman: '',
          mtimeMs: st.mtimeMs,
          hot: (nowMs - st.mtimeMs) < 60000,
          children,
        });
      } else if (ent.isFile()) {
        nodes.push({
          name: ent.name,
          path: childRel,
          type: 'file',
          size: st.size,
          sizeHuman: human(st.size),
          mtimeMs: st.mtimeMs,
          hot: (nowMs - st.mtimeMs) < 60000,
        });
      }
    }
    return nodes;
  }

  return walk(userRoot, '', 0);
}

const PREVIEW_TEXT_EXTS = new Set([
  '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss',
  '.py', '.log', '.csv', '.yml', '.yaml', '.toml', '.sh', '.ps1', '.bat', '.cmd',
  '.c', '.h', '.cpp', '.hpp', '.java', '.go', '.rs', '.sql', '.xml', '.ini', '.env',
  '.do', '.ado', '.r', '.rmd', '.tex', '.bib',
  '.gitignore', '.stignore', '.svg',
]);

function readFilePreview(user, rel) {
  const cleanRel = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const abs = safeJoin(user.root, cleanRel);
  if (!abs) return { status: 400, error: 'bad path' };
  let st;
  try { st = fs.statSync(abs); } catch { return { status: 404, error: 'not found' }; }

  if (st.isDirectory()) {
    let rawEntries = [];
    try { rawEntries = fs.readdirSync(abs, { withFileTypes: true }); } catch {}
    const visibleEntries = rawEntries
      .filter(ent => {
        if (ent.isSymbolicLink && ent.isSymbolicLink()) return false;
        if (ent.isDirectory() && SKIP_DIRS.has(ent.name)) return false;
        const itemRel = cleanRel ? `${cleanRel}/${ent.name}` : ent.name;
        if (isProtectedName(itemRel)) return false;
        return ent.isDirectory() || ent.isFile();
      })
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN');
      });

    const enc = cleanRel ? encodeRelPath(cleanRel) : '';
    const zipUrl = '/zip/' + enc;
    return {
      status: 200,
      data: {
        path: cleanRel,
        name: cleanRel ? path.basename(abs) : `${user.name} (工作区根目录)`,
        size: 0,
        sizeHuman: `${visibleEntries.length} 项`,
        mtimeMs: st.mtimeMs,
        ext: '',
        kind: 'directory',
        itemCount: visibleEntries.length,
        items: visibleEntries.slice(0, 60).map(ent => {
          const itemRel = cleanRel ? `${cleanRel}/${ent.name}` : ent.name;
          const isDir = ent.isDirectory();
          let itemSize = '';
          if (!isDir) {
            try { itemSize = human(fs.statSync(path.join(abs, ent.name)).size); } catch {}
          }
          return {
            name: ent.name,
            path: itemRel,
            type: isDir ? 'dir' : 'file',
            sizeHuman: itemSize,
            downloadUrl: (isDir ? '/zip/' : '/download/') + encodeRelPath(itemRel),
          };
        }),
        previewUrl: '/files/' + enc,
        downloadUrl: zipUrl,
        zipUrl,
      },
    };
  }

  if (!st.isFile()) return { status: 400, error: 'not a file' };

  const ext = path.extname(abs).toLowerCase();
  const base = path.basename(abs).toLowerCase();
  const imgExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
  const maxBytes = 262144;

  let kind = 'binary';
  if (imgExts.has(ext)) kind = 'image';
  else if (ext === '.md' || ext === '.mdx') kind = 'markdown';
  else if (ext === '.html' || ext === '.htm') kind = 'html';
  else if (ext === '.pdf') kind = 'pdf';
  else if (['.mp4', '.webm', '.mov'].includes(ext)) kind = 'video';
  else if (['.mp3', '.wav', '.ogg', '.m4a'].includes(ext)) kind = 'audio';
  else if (PREVIEW_TEXT_EXTS.has(ext) || base === '.stignore' || base === '.gitignore') kind = 'text';

  let content = null;
  let truncated = false;
  if (kind === 'text' || kind === 'markdown' || kind === 'html' || (kind === 'binary' && st.size <= 65536)) {
    const toRead = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(toRead);
    const fd = fs.openSync(abs, 'r');
    try { fs.readSync(fd, buf, 0, toRead, 0); } finally { fs.closeSync(fd); }
    if (kind === 'binary') {
      if (!buf.includes(0)) { kind = 'text'; }
    }
    if (kind !== 'binary') {
      content = buf.toString('utf8');
      truncated = st.size > maxBytes;
    }
  }

  return {
    status: 200,
    data: {
      path: String(rel).replace(/\\/g, '/'),
      name: path.basename(abs),
      size: st.size,
      sizeHuman: human(st.size),
      mtimeMs: st.mtimeMs,
      ext,
      kind,
      content,
      truncated,
      previewUrl: '/preview/' + encodeRelPath(rel),
      downloadUrl: '/download/' + encodeRelPath(rel),
    },
  };
}

function sessionsFileFor(userName) {
  return path.join(DATA_DIR, userName + '.json');
}

function readSessions(userName) {
  const f = sessionsFileFor(userName);
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (raw && Array.isArray(raw.sessions)) return raw.sessions;
  } catch {}
  return [];
}

function writeSessions(userName, sessions) {
  const f = sessionsFileFor(userName);
  const tmp = f + '.tmp-' + process.pid;
  const trimmed = sessions
    .slice()
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, 100);
  fs.writeFileSync(tmp, JSON.stringify({ sessions: trimmed }, null, 2), 'utf8');
  fs.renameSync(tmp, f);
  return trimmed;
}

function getUiVersion() {
  let maxMtime = 0;
  for (const rel of ['workbench.html', 'workbench.css', 'workbench.js']) {
    try {
      const st = fs.statSync(path.join(PUBLIC_DIR, rel));
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
    } catch {}
  }
  return String(Math.floor(maxMtime));
}

function redactHostPaths(text, userRoot) {
  let out = String(text || '');
  if (userRoot) {
    const escapedRoot = String(userRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escapedRoot + '[\\\\/]?', 'gi'), './');
  }
  return out.replace(/[A-Za-z]:\\Users\\[^\\/\s"']+/gi, '<host>');
}

const runtimeProcCache = new Map();
const runtimeProcInflight = new Map();

function probeWorkspaceProcesses(user) {
  const now = Date.now();
  const cached = runtimeProcCache.get(user.name);
  if (cached && now - cached.at < 2500) return Promise.resolve(cached.list);
  if (runtimeProcInflight.has(user.name)) return runtimeProcInflight.get(user.name);

  if (process.platform !== 'win32') return Promise.resolve([]);

  const psScript = [
    "$r = [Environment]::GetEnvironmentVariable('PROBE_ROOT')",
    "$names = @('powershell.exe','pwsh.exe','cmd.exe','python.exe','python3.exe','node.exe','Rscript.exe','StataMP-64.exe','StataSE-64.exe','Stata-64.exe')",
    "$out = @()",
    "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {",
    "  if ($names -notcontains $_.Name) { return }",
    "  $cmd = [string]$_.CommandLine",
    "  if (-not $cmd) { return }",
    "  if ($cmd -match 'portal\\.mjs|stdio-to-ws|httpsbridge|baton-mcp|chrome-devtools-mcp|acp-engines|codex-acp|claude-agent-acp|PROBE_ROOT') { return }",
    "  if ($r -and $cmd.IndexOf($r, [StringComparison]::OrdinalIgnoreCase) -ge 0) {",
    "    $age = 0",
    "    if ($_.CreationDate) { $age = [int][Math]::Max(0, ([DateTime]::Now - $_.CreationDate).TotalSeconds) }",
    "    $out += [PSCustomObject]@{ pid = $_.ProcessId; name = $_.Name; cmd = $cmd; ageSec = $age }",
    "  }",
    "}",
    "ConvertTo-Json -InputObject $out -Compress",
  ].join('; ');

  const prom = new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      {
        windowsHide: true,
        timeout: 4500,
        env: { ...process.env, PROBE_ROOT: user.root },
      },
      (err, stdout) => {
        runtimeProcInflight.delete(user.name);
        let list = [];
        if (!err && stdout) {
          try {
            const parsed = JSON.parse(stdout.trim() || '[]');
            const arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
            list = arr.slice(0, 8).map(item => ({
              pid: Number(item.pid || 0),
              name: String(item.name || ''),
              cmd: redactHostPaths(String(item.cmd || '').replace(/\s+/g, ' ').trim(), user.root).slice(0, 180),
              ageSec: Number(item.ageSec || 0),
            }));
          } catch {}
        }
        runtimeProcCache.set(user.name, { at: Date.now(), list });
        resolve(list);
      }
    );
  });
  runtimeProcInflight.set(user.name, prom);
  return prom;
}

function readSessionLiveLog(user, sessionId) {
  if (!sessionId || !/^[0-9a-f-]{16,64}$/i.test(sessionId)) return null;
  const userSessions = readSessions(user.name);
  if (!userSessions.some(s => s && s.acpSessionId === sessionId)) return null;

  const home = os.homedir();
  const baseCandidates = [
    path.join(home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated'),
    path.join(home, '.gemini', 'antigravity', 'brain', sessionId, '.system_generated'),
  ];

  let latest = null;
  const cutoff = Date.now() - 600000;
  for (const baseDir of baseCandidates) {
    if (!fs.existsSync(baseDir)) continue;
    const tasksDir = path.join(baseDir, 'tasks');
    try {
      for (const name of fs.readdirSync(tasksDir)) {
        if (!/^task-.*\.log$/i.test(name)) continue;
        const abs = path.join(tasksDir, name);
        const st = fs.statSync(abs);
        if (st.isFile() && st.mtimeMs >= cutoff && (!latest || st.mtimeMs > latest.mtimeMs)) {
          latest = { abs, source: `tasks/${name}`, mtimeMs: st.mtimeMs, size: st.size };
        }
      }
    } catch {}

    const stepsDir = path.join(baseDir, 'steps');
    try {
      for (const stepId of fs.readdirSync(stepsDir)) {
        const abs = path.join(stepsDir, stepId, 'output.txt');
        try {
          const st = fs.statSync(abs);
          if (st.isFile() && st.mtimeMs >= cutoff && (!latest || st.mtimeMs > latest.mtimeMs)) {
            latest = { abs, source: `steps/${stepId}/output.txt`, mtimeMs: st.mtimeMs, size: st.size };
          }
        } catch {}
      }
    } catch {}
  }

  if (!latest) return null;
  const maxBytes = 6144;
  const toRead = Math.min(latest.size, maxBytes);
  if (toRead <= 0) return { source: latest.source, mtimeMs: latest.mtimeMs, size: latest.size, tail: '' };
  try {
    const buf = Buffer.alloc(toRead);
    const fd = fs.openSync(latest.abs, 'r');
    try { fs.readSync(fd, buf, 0, toRead, Math.max(0, latest.size - toRead)); } finally { fs.closeSync(fd); }
    let tail = buf.toString('utf8');
    if (latest.size > toRead) {
      const nl = tail.indexOf('\n');
      if (nl >= 0 && nl < 200) tail = tail.slice(nl + 1);
    }
    tail = redactHostPaths(tail, user.root);
    return { source: latest.source, mtimeMs: latest.mtimeMs, size: latest.size, tail };
  } catch {
    return null;
  }
}

function servePublicFile(res, relFile, contentType) {
  const abs = safeJoin(PUBLIC_DIR, relFile);
  if (!abs || !fs.existsSync(abs)) { res.writeHead(404); res.end('not found'); return; }
  const buf = fs.readFileSync(abs);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const { token, url } = getToken(req);
  let usersNow;
  try { usersNow = buildUsers(); } catch (e) { usersNow = new Map(); log('users.json reload failed: ' + e.message); }
  const user = token ? usersNow.get(token) : null;
  const p = url.pathname;

  // 从 URL 里的 ?t=TOKEN 自动换成 cookie，之后链接不用带 token
  if (user && url.searchParams.get('t')) {
    res.setHeader('Set-Cookie', `agy_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`);
  }

  try {
    if (p === '/assets/workbench.css' && req.method === 'GET') {
      servePublicFile(res, 'workbench.css', 'text/css; charset=utf-8'); return;
    }
    if (p === '/assets/workbench.js' && req.method === 'GET') {
      servePublicFile(res, 'workbench.js', 'application/javascript; charset=utf-8'); return;
    }
    if (p === '/logout') {
      res.writeHead(302, { 'Set-Cookie': 'agy_token=; Path=/; Max-Age=0', Location: '/' });
      res.end(); return;
    }
    if (p === '/' && req.method === 'GET') {
      if (user && fs.existsSync(path.join(PUBLIC_DIR, 'workbench.html'))) {
        servePublicFile(res, 'workbench.html', 'text/html; charset=utf-8');
        return;
      }
      const badMsg = url.searchParams.get('bad') ? '<p style="color:#f87171">Token 无效，请检查后重试</p>' : '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('LanCode Workbench · 登录', `
        <div style="max-width:460px;margin:48px auto;padding:24px;border:1px solid #24292f;border-radius:12px;background:#151920">
          <h2 style="margin-top:0">LanCode Workbench</h2>
          <p class="muted">一台主机登录，全组局域网隔离共用 · 输入管理员给你的个人 token（或直接打开带 <code>?t=</code> 的专属链接）</p>
          ${badMsg}
          <form method="post" action="/login" style="display:flex;gap:8px;margin-top:14px">
            <input type="password" name="token" placeholder="输入个人 token" autofocus style="flex:1">
            <button>进入工作台</button>
          </form>
        </div>`, null));
      return;
    }
    if (p === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        const t = new URLSearchParams(body).get('token') || '';
        if (usersNow.has(t)) res.writeHead(302, { 'Set-Cookie': `agy_token=${encodeURIComponent(t)}; Path=/; HttpOnly; SameSite=Lax`, Location: '/workbench' });
        else res.writeHead(302, { Location: '/?bad=1' });
        res.end();
      });
      return;
    }

    if (p.startsWith('/api/') || p === '/activity.json') {
      if (!user) { sendJson(res, 401, { error: 'unauthorized' }); return; }

      if (p === '/activity.json') {
        sendJson(res, 200, scanActivity(user.root, user.name)); return;
      }
      if (p === '/api/me' && req.method === 'GET') {
        const [st, eng] = await Promise.all([
          getUserSyncthingStatus(user.name),
          Promise.resolve(detectEngines(ROOT)),
        ]);
        sendJson(res, 200, { user: user.name, root: user.root, portalPort: PORTAL_PORT, syncthing: st, ...eng });
        return;
      }
      if (p === '/api/engines' && req.method === 'GET') {
        sendJson(res, 200, detectEngines(ROOT));
        return;
      }
      if (p === '/api/ui-version' && req.method === 'GET') {
        sendJson(res, 200, { version: getUiVersion() });
        return;
      }
      if (p === '/api/runtime-status' && req.method === 'GET') {
        const sid = String(url.searchParams.get('sessionId') || '').trim();
        const processes = await probeWorkspaceProcesses(user);
        const liveLog = readSessionLiveLog(user, sid);
        sendJson(res, 200, { now: Date.now(), processes, liveLog });
        return;
      }
      if (p === '/api/tree' && req.method === 'GET') {
        sendJson(res, 200, { user: user.name, root: user.root, generatedAt: Date.now(), tree: buildTree(user.root) });
        return;
      }
      if (p === '/api/file' && req.method === 'GET') {
        const rel = url.searchParams.get('path') || '';
        const result = readFilePreview(user, rel);
        if (result.status !== 200) sendJson(res, result.status, { error: result.error });
        else sendJson(res, 200, result.data);
        return;
      }
      if (p === '/api/mkdir' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const rel = validateRelSegments(body.path);
        if (!rel || isProtectedName(rel)) { sendJson(res, 400, { error: 'invalid path' }); return; }
        const abs = safeJoin(user.root, rel);
        if (!abs) { sendJson(res, 400, { error: 'bad path' }); return; }
        fs.mkdirSync(abs, { recursive: true });
        sendJson(res, 200, { ok: true, path: rel });
        return;
      }
      if (p === '/api/rename' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const fromRel = validateRelSegments(body.from);
        const toRel = validateRelSegments(body.to);
        if (!fromRel || !toRel || isProtectedName(fromRel) || isProtectedName(toRel)) {
          sendJson(res, 400, { error: 'invalid path' }); return;
        }
        const fromAbs = safeJoin(user.root, fromRel);
        const toAbs = safeJoin(user.root, toRel);
        if (!fromAbs || !toAbs || fromAbs === user.root || toAbs === user.root) {
          sendJson(res, 400, { error: 'bad path' }); return;
        }
        if (!fs.existsSync(fromAbs)) { sendJson(res, 404, { error: 'source not found' }); return; }
        fs.mkdirSync(path.dirname(toAbs), { recursive: true });
        fs.renameSync(fromAbs, toAbs);
        sendJson(res, 200, { ok: true, from: fromRel, to: toRel });
        return;
      }
      if (p === '/api/delete' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const rel = validateRelSegments(body.path);
        if (!rel || isProtectedName(rel)) { sendJson(res, 400, { error: 'invalid or protected path' }); return; }
        const abs = safeJoin(user.root, rel);
        if (!abs || abs === user.root) { sendJson(res, 400, { error: 'bad path' }); return; }
        if (!fs.existsSync(abs)) { sendJson(res, 404, { error: 'not found' }); return; }
        fs.rmSync(abs, { recursive: true, force: true });
        sendJson(res, 200, { ok: true, path: rel });
        return;
      }
      if (p === '/api/sessions' && req.method === 'GET') {
        const sessions = readSessions(user.name).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
        sendJson(res, 200, { sessions });
        return;
      }
      if (p === '/api/sessions' && req.method === 'POST') {
        const body = await readJsonBody(req, 4 * 1024 * 1024);
        const id = String(body.id || '').trim();
        if (!id || id.length > 128) { sendJson(res, 400, { error: 'missing session id' }); return; }
        const sessions = readSessions(user.name);
        const idx = sessions.findIndex(s => s && s.id === id);
        const now = Date.now();
        const prev = idx >= 0 ? sessions[idx] : {};
        const next = {
          id,
          engineId: typeof body.engineId === 'string' ? body.engineId : (prev.engineId || ''),
          acpSessionId: typeof body.acpSessionId === 'string' ? body.acpSessionId : (prev.acpSessionId || ''),
          title: typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : (prev.title || '新对话'),
          subdir: typeof body.subdir === 'string' ? body.subdir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : (prev.subdir || ''),
          modelId: typeof body.modelId === 'string' ? body.modelId : (prev.modelId || ''),
          modeId: typeof body.modeId === 'string' ? body.modeId : (prev.modeId || 'default'),
          clientId: typeof body.clientId === 'string' ? body.clientId : (prev.clientId || ''),
          createdAt: Number(prev.createdAt || body.createdAt || now),
          updatedAt: now,
          messages: Array.isArray(body.messages) ? body.messages.slice(-80) : (prev.messages || []),
        };
        if (idx >= 0) sessions[idx] = next;
        else sessions.unshift(next);
        writeSessions(user.name, sessions);
        sendJson(res, 200, { ok: true, session: next });
        return;
      }
      if (p === '/api/sessions' && req.method === 'DELETE') {
        const id = url.searchParams.get('id') || '';
        if (!id) { sendJson(res, 400, { error: 'missing id' }); return; }
        const sessions = readSessions(user.name).filter(s => s && s.id !== id);
        writeSessions(user.name, sessions);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (p === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-store',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        let debounceTimer = null;
        let lastFile = '';
        let watcher = null;
        try {
          watcher = fs.watch(user.root, { recursive: true }, (_eventType, filename) => {
            const rel = String(filename || '').replace(/\\/g, '/');
            if (rel && (isProtectedName(rel) || rel.includes('node_modules') || rel.startsWith('.git'))) return;
            lastFile = rel;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              try {
                res.write(`event: fs\ndata: ${JSON.stringify({ at: Date.now(), file: lastFile })}\n\n`);
              } catch {}
            }, 250);
          });
        } catch {}
        const pingTimer = setInterval(() => {
          try { res.write(': ping\n\n'); } catch {}
        }, 20000);
        req.on('close', () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          clearInterval(pingTimer);
          if (watcher) { try { watcher.close(); } catch {} }
        });
        return;
      }
      sendJson(res, 404, { error: 'unknown api' });
      return;
    }

    if (!user) { res.writeHead(302, { Location: '/' }); res.end(); return; }

    if (p === '/workbench' && req.method === 'GET') {
      servePublicFile(res, 'workbench.html', 'text/html; charset=utf-8');
      return;
    }
    if (p === '/activity') {
      renderActivity(res, user);
      return;
    }
    if (p.startsWith('/files')) {
      let rel = decodeURIComponent(p.slice('/files'.length)).replace(/^\/+|\/+$/g, '');
      renderListing(res, user, rel);
      return;
    }
    if (p.startsWith('/download/')) { serveFile(res, user, decodeURIComponent(p.slice('/download/'.length)), true); return; }
    if (p.startsWith('/preview/')) { serveFile(res, user, decodeURIComponent(p.slice('/preview/'.length)), false); return; }
    if (p.startsWith('/zip')) {
      const rel = decodeURIComponent(p.slice('/zip'.length)).replace(/^\/+|\/+$/g, '');
      const abs = safeJoin(user.root, rel);
      if (!abs || !fs.existsSync(abs)) { res.writeHead(404); res.end('not found'); return; }
      const target = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
      zipFolder(res, target); return;
    }
    if (p === '/upload' && req.method === 'POST') {
      const rawName = url.searchParams.get('name') || 'upload.bin';
      const segs = rawName.split(/[\\/]+/).filter(Boolean);
      if (segs.length === 0 || segs.some(s => s === '.' || s === '..' || s.includes(':') || s.includes('\0'))) {
        res.writeHead(400); res.end('bad name'); return;
      }
      const relName = segs.join('/');
      const dirAbs = safeJoin(user.root, url.searchParams.get('dir') || '');
      if (!dirAbs) { res.writeHead(400); res.end('bad dir'); return; }
      const dest = safeJoin(dirAbs, relName);
      if (!dest || !safeJoin(user.root, path.relative(user.root, dest))) {
        res.writeHead(400); res.end('bad path'); return;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const stream = fs.createWriteStream(dest);
      req.pipe(stream);
      stream.on('finish', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, name: relName })); });
      stream.on('error', e => { res.writeHead(500); res.end(e.message); });
      return;
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    if (e && (e.message === 'invalid json' || e.message === 'payload too large')) {
      try { sendJson(res, e.message === 'payload too large' ? 413 : 400, { error: e.message }); } catch {}
      return;
    }
    log('ERR ' + (e && e.stack || e));
    try { res.writeHead(500); res.end('server error'); } catch {}
  }
});

// ---- WebSocket 代理：/agent?t=TOKEN -> 127.0.0.1:RELAY_PORT ----
// 让每个室友用自己的 token 连 agent（未带正确 token 一律 401），
// 并自动把会话 params.cwd 重写到各自目录 users/<name>，防止客户端选了本地盘符或越权路径。
function isInsideRoot(candidate, rootDir) {
  if (!candidate || typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
  const cand = path.resolve(candidate).toLowerCase();
  const root = path.resolve(rootDir).toLowerCase();
  return cand === root || cand.startsWith(root + path.sep);
}

function rewriteClientPayload(rawText, user) {
  const m = /^(Content-Length:\s*\d+\r?\n\r?\n)([\s\S]*)$/i.exec(rawText);
  const hasHeader = !!m;
  const body = hasHeader ? m[2] : rawText;
  const parts = body.split('\n');
  let changed = false;

  const outParts = parts.map(part => {
    const cr = part.endsWith('\r') ? '\r' : '';
    const trimmed = (cr ? part.slice(0, -1) : part).trim();
    if (!trimmed || !trimmed.startsWith('{')) return part;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params) && typeof obj.params.cwd === 'string') {
        if (!isInsideRoot(obj.params.cwd, user.root)) {
          const oldCwd = obj.params.cwd;
          obj.params.cwd = user.root;
          changed = true;
          log(`WS cwd rewritten (${user.name}): ${oldCwd} -> ${user.root}`);
          return JSON.stringify(obj) + cr;
        }
      }
    } catch {}
    return part;
  });

  if (!changed) return rawText;
  const nextBody = outParts.join('\n');
  if (hasHeader) {
    return `Content-Length: ${Buffer.byteLength(nextBody, 'utf8')}\r\n\r\n` + nextBody;
  }
  return nextBody;
}

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const fail = (code, msg) => {
    try { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
    socket.destroy();
  };
  try {
    const url = new URL(req.url, 'http://x');
    let token = url.searchParams.get('t') || '';
    if (!token) {
      const m = /(?:^|;\s*)agy_token=([^;]+)/.exec(req.headers.cookie || '');
      if (m) token = decodeURIComponent(m[1]);
    }
    const user = token ? buildUsers().get(token) : null;
    if (!user) { log('WS rejected (bad token) ' + (req.socket.remoteAddress || '')); fail(401, 'Unauthorized'); return; }

    wss.handleUpgrade(req, socket, head, clientWs => {
      const cid = req.headers['x-client-id'] || url.searchParams.get('cid') || '';
      const reqEngine = (url.searchParams.get('engine') || '').trim().toLowerCase();
      const useExternalRelay = process.env.AGY_USE_EXTERNAL_RELAY === '1' && (!reqEngine || reqEngine === 'relay');

      const ka = setInterval(() => {
        try {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.ping();
        } catch {}
      }, 25000);
      clientWs.on('close', () => clearInterval(ka));

      if (!useExternalRelay) {
        attachEngineSession({
          rootDir: ROOT,
          engineId: reqEngine,
          clientId: String(cid || ''),
          user,
          ws: clientWs,
          rewritePayload: rewriteClientPayload,
          log,
        }).catch(err => {
          log('ACP attach error (' + user.name + '): ' + (err && err.stack || err));
          try { clientWs.close(1011, 'Attach error'); } catch {}
        });
        return;
      }

      const headers = {};
      if (cid) headers['x-client-id'] = String(cid);
      const upstream = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/`, { headers });
      const pending = [];

      const closeBoth = (wsA, wsB) => {
        for (const ws of [wsA, wsB]) {
          try {
            if (ws.readyState === WebSocket.OPEN) ws.close();
            else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
          } catch {
            try { ws.terminate(); } catch {}
          }
        }
      };

      upstream.on('open', () => {
        log('WS proxy connected (external relay): ' + user.name);
        while (pending.length > 0 && upstream.readyState === WebSocket.OPEN) {
          const item = pending.shift();
          upstream.send(item.payload, { binary: item.isBinary });
        }
      });

      clientWs.on('message', (data, isBinary) => {
        const payload = isBinary ? data : rewriteClientPayload(data.toString('utf8'), user);
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(payload, { binary: isBinary });
        } else if (upstream.readyState === WebSocket.CONNECTING) {
          pending.push({ payload, isBinary });
        }
      });

      upstream.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: isBinary });
        }
      });

      clientWs.on('close', () => closeBoth(upstream, clientWs));
      upstream.on('close', () => closeBoth(clientWs, upstream));
      clientWs.on('error', () => closeBoth(upstream, clientWs));
      upstream.on('error', err => {
        log('WS upstream error (' + user.name + '): ' + (err && err.message || err));
        closeBoth(clientWs, upstream);
      });
    });
  } catch (e) {
    log('WS upgrade error ' + (e && e.message || e));
    fail(500, 'Upgrade Failed');
  }
});

server.listen(PORTAL_PORT, '0.0.0.0', () => {
  const eng = detectEngines(ROOT);
  const availList = eng.engines.filter(e => e.available).map(e => e.id).join(', ') || 'none';
  log(`LanCode portal listening on 0.0.0.0:${PORTAL_PORT} (defaultEngine=${eng.defaultEngine}; available=[${availList}])`);
  const ips = lanIPv4();
  for (const [t, u] of buildUsers()) {
    log(`user ${u.name}: ` + ips.map(ip => `portal http://${ip}:${PORTAL_PORT}/?t=${t}  |  agent ws://${ip}:${PORTAL_PORT}/agent?t=${t}`).join('  ;  '));
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`Received ${sig}, shutting down ACP engines...`);
    shutdownAllEngines();
    try { server.close(() => process.exit(0)); } catch { process.exit(0); }
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
