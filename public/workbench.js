(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Strip ?t= from address bar cleanly once server sets cookie
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('t')) {
      u.searchParams.delete('t');
      const qs = u.searchParams.toString();
      history.replaceState(null, '', '/workbench' + (qs ? '?' + qs : ''));
    }
  } catch {}

  const state = {
    user: '',
    root: '',
    syncthing: null,
    tree: [],
    activity: null,
    sessions: [],
    openTabIds: [],
    activeSessionId: null,
    activeProjectFilter: '__all__',
    searchQuery: '',
    treeFilter: '',
    expandedDirs: new Set(),
    selectedFilePath: '',
    rightTab: 'tree',
    attachments: [],
    models: [],
    currentModelId: '',
    modes: [],
    currentModeId: 'default',
    engines: [],
    defaultEngine: 'codex',
    currentEngineId: localStorage.getItem('lancode_engine') || '',
    usage: null,
    wsConnected: false,
    wsReady: false,
    busy: false,
    autoAllow: localStorage.getItem('agy_auto_allow') === '1',
    clientId: sessionStorage.getItem('agy_wb_cid') || (() => {
      const id = 'wb-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('agy_wb_cid', id);
      return id;
    })(),
  };

  let ws = null;
  let rpcSeq = 1;
  let wsGen = 0;
  const pendingRpc = new Map();
  let reconnectTimer = null;
  let disconnectGraceTimer = null;
  let connectPromise = null;
  let connectTargetEngine = null;
  let suppressReconnectOnce = false;
  let acpLiveSessionId = null;
  let acpLiveCwd = null;
  let acpLiveEngineId = null;
  const loadedAcpSessions = new Set();
  const loadingAcpSessions = new Set();
  const busySessions = new Map(); // sess.id -> { startedAt, lastEventAt, phase, toolName, acpSessionId, runtimeProcesses, liveLog, disconnectedWhileBusy }
  const expandedDetails = new Set();
  let liveUiTimer = null;
  let runtimePollTimer = null;
  let runtimePollInflight = false;
  let initialUiVersion = '';
  let uploadTargetMode = 'composer'; // 'composer' | 'tree'
  let uploadTargetDir = '';
  let saveTimer = null;

  // ---------- Helpers ----------
  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function encRel(rel) {
    return String(rel || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  }

  function triggerBrowserDownload(url) {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { a.remove(); } catch {} }, 1000);
  }

  function relTime(ms) {
    if (!ms) return '';
    const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (sec < 10) return '刚刚';
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h';
    return Math.floor(sec / 86400) + 'd';
  }

  function cwdForSubdir(subdir) {
    if (!state.root) return '';
    const clean = String(subdir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!clean) return state.root;
    const sep = state.root.includes('\\') ? '\\' : '/';
    return state.root.replace(/[\\/]+$/, '') + sep + clean.split('/').join(sep);
  }

  async function apiJson(url, opts = {}) {
    const res = await fetch(url, { cache: 'no-store', ...opts });
    if (res.status === 401) { location.href = '/'; throw new Error('unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  function showToast(msg, ms = 2500) {
    const el = $('upload-toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    if (ms > 0) {
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.hidden = true; }, ms);
    }
  }

  function getActiveSession() {
    return state.sessions.find(s => s.id === state.activeSessionId) || null;
  }

  function scheduleSaveSession(sess) {
    if (!sess) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveSessionNow(sess).catch(() => {});
    }, 350);
  }

  function getEffectiveEngineId(sess = getActiveSession()) {
    const bySess = sess && sess.engineId ? String(sess.engineId).trim().toLowerCase() : '';
    const byPref = state.currentEngineId ? String(state.currentEngineId).trim().toLowerCase() : '';
    const isValid = (id) => {
      if (!id) return false;
      if (!state.engines.length) return true;
      const e = state.engines.find(x => x.id === id);
      return Boolean(e && e.available);
    };
    if (isValid(bySess)) return bySess;
    if (isValid(byPref)) return byPref;
    if (state.defaultEngine) return state.defaultEngine;
    const first = state.engines.find(x => x.available);
    return first ? first.id : 'agy';
  }

  function getEngineBadgeName(engineId) {
    const found = state.engines.find(e => e.id === engineId);
    if (found) return found.badge || found.name;
    if (!engineId) return 'AGY';
    return String(engineId).toUpperCase();
  }

  function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return String(m).padStart(2, '0') + ':' + String(rem).padStart(2, '0');
  }

  function isSessionBusy(sessId) {
    return Boolean(sessId && busySessions.has(sessId));
  }

  function isAnySessionBusy() {
    return busySessions.size > 0;
  }

  function syncActiveBusyState() {
    state.busy = isSessionBusy(state.activeSessionId);
    updateBusyUi();
  }

  function startLiveMonitors() {
    if (!liveUiTimer) {
      liveUiTimer = setInterval(() => {
        if (!isAnySessionBusy()) {
          stopLiveMonitors();
          return;
        }
        const active = getActiveSession();
        if (active && isSessionBusy(active.id)) {
          renderLiveBannerInPlace(active);
          updateRunningToolElapsedInPlace(active);
        }
      }, 1000);
    }
    if (!runtimePollTimer) {
      pollRuntimeStatusOnce();
      runtimePollTimer = setInterval(() => {
        if (isAnySessionBusy()) pollRuntimeStatusOnce();
      }, 3000);
    }
  }

  function stopLiveMonitors() {
    if (liveUiTimer) { clearInterval(liveUiTimer); liveUiTimer = null; }
    if (runtimePollTimer) { clearInterval(runtimePollTimer); runtimePollTimer = null; }
  }

  function setSessionBusy(sess, active, meta = {}) {
    if (!sess) return;
    if (active) {
      const prev = busySessions.get(sess.id) || {
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        phase: '正在思考与调度...',
        toolName: '',
        acpSessionId: sess.acpSessionId || '',
        runtimeProcesses: [],
        liveLog: null,
        disconnectedWhileBusy: false,
      };
      busySessions.set(sess.id, { ...prev, ...meta, lastEventAt: Date.now() });
      startLiveMonitors();
    } else {
      busySessions.delete(sess.id);
      if (!isAnySessionBusy()) stopLiveMonitors();
    }
    syncActiveBusyState();
    refreshHotUpdateBtnLabel();
  }

  function touchSessionBusy(sess, meta = {}) {
    if (!sess || !busySessions.has(sess.id)) return;
    const prev = busySessions.get(sess.id);
    busySessions.set(sess.id, { ...prev, ...meta, lastEventAt: Date.now(), disconnectedWhileBusy: false });
    if (sess.id === state.activeSessionId) {
      renderLiveBannerInPlace(sess);
    }
  }

  async function pollRuntimeStatusOnce() {
    if (runtimePollInflight || !isAnySessionBusy()) return;
    const active = getActiveSession();
    const targetSess = (active && isSessionBusy(active.id)) ? active : state.sessions.find(s => isSessionBusy(s.id));
    if (!targetSess) return;
    runtimePollInflight = true;
    try {
      const sid = encodeURIComponent(targetSess.acpSessionId || acpLiveSessionId || '');
      const data = await apiJson('/api/runtime-status?sessionId=' + sid);
      const entry = busySessions.get(targetSess.id);
      if (entry) {
        entry.runtimeProcesses = Array.isArray(data.processes) ? data.processes : [];
        entry.liveLog = data.liveLog || null;
        if (targetSess.id === state.activeSessionId) {
          renderLiveBannerInPlace(targetSess);
        }
      }
    } catch {}
    finally {
      runtimePollInflight = false;
    }
  }

  function refreshHotUpdateBtnLabel() {
    const btn = $('btn-hot-update');
    if (!btn || btn.hidden) return;
    btn.textContent = isAnySessionBusy()
      ? '✨ 工作台已更新（任务完成后可点此无损刷新）'
      : '✨ 工作台已热更新，点此刷新';
  }

  async function saveSessionNow(sess) {
    if (!sess) return;
    await apiJson('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: sess.id,
        engineId: sess.engineId || getEffectiveEngineId(sess),
        acpSessionId: sess.acpSessionId || '',
        title: sess.title,
        subdir: sess.subdir || '',
        modelId: sess.modelId || state.currentModelId || '',
        modeId: sess.modeId || state.currentModeId || 'default',
        clientId: state.clientId,
        createdAt: sess.createdAt,
        messages: (sess.messages || []).map(m => {
          if (m.role !== 'assistant') return m;
          return { ...m, _done: m._done !== false };
        }),
      }),
    });
  }

  // ---------- Safe Markdown Renderer ----------
  function resolveWorkspaceHref(rawHref) {
    const clean = String(rawHref || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    if (!clean) return { kind: 'external', href: '#' };

    const sameOriginPortalRe = /^\/(download|zip|preview|files|activity)(\/.*|\?.*)?$/i;
    const lanPortalRe = new RegExp(
      `^https?:\\/\\/(?:${escapeRegExp(location.host)}|localhost|\\d{1,3}(?:\\.\\d{1,3}){3})(?::\\d+)?\\/(download|zip|preview|files|activity)(\\/.*|\\?.*)?$`,
      'i'
    );
    const portalMatch = sameOriginPortalRe.exec(clean) || lanPortalRe.exec(clean);
    if (portalMatch) {
      const route = portalMatch[1].toLowerCase();
      if (route === 'activity') return { kind: 'same_origin_page', href: '/activity' };
      const tail = (portalMatch[2] || '').split(/[?#]/)[0];
      let rel = tail.replace(/^\/+|\/+$/g, '');
      try { rel = decodeURIComponent(rel); } catch {}
      rel = rel.replace(/^\/+|\/+$/g, '');
      if (route === 'download' || route === 'zip') {
        const dlUrl = (route === 'zip' || !rel) ? ('/zip/' + encRel(rel)) : ('/download/' + encRel(rel));
        return { kind: 'direct_download', rel, href: dlUrl };
      }
      return { kind: 'workspace', rel };
    }

    if (/^file:\/\//i.test(clean) || /^\/?[A-Za-z]:[\\/]/.test(clean)) {
      let p = clean.split('#')[0].split('?')[0];
      p = p.replace(/^file:\/\/+/i, '');
      try { p = decodeURIComponent(p); } catch {}
      p = p.replace(/\\/g, '/').replace(/^\/+([A-Za-z]:\/)/, '$1').replace(/\/+$/, '');

      const normRoot = String(state.root || '').replace(/\\/g, '/').replace(/\/+$/, '');
      if (normRoot) {
        const pLow = p.toLowerCase();
        const rLow = normRoot.toLowerCase();
        if (pLow === rLow) return { kind: 'workspace', rel: '' };
        if (pLow.startsWith(rLow + '/')) {
          return { kind: 'workspace', rel: p.slice(normRoot.length + 1) };
        }
      }
      if (state.user) {
        const userRe = new RegExp('/users/' + escapeRegExp(state.user) + '(?:/(.*))?$', 'i');
        const mUser = userRe.exec(p);
        if (mUser) return { kind: 'workspace', rel: mUser[1] || '' };
      }
      return { kind: 'outside_workspace', displayPath: p };
    }

    if (/^(?:https?:|mailto:)/i.test(clean)) {
      return { kind: 'external', href: clean };
    }

    let rel = clean.split('#')[0].split('?')[0];
    try { rel = decodeURIComponent(rel); } catch {}
    rel = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
    return { kind: 'workspace', rel };
  }

  function renderResolvedLinkHtml(labelHtml, rawHref) {
    const res = resolveWorkspaceHref(rawHref);
    if (res.kind === 'workspace') {
      const dlHref = res.rel ? ('/download/' + encRel(res.rel)) : '/zip/';
      return `<span class="ws-link-wrap"><a href="${escHtml(dlHref)}" class="ws-preview-link" data-rel="${escHtml(res.rel)}">${labelHtml}</a><a href="${escHtml(dlHref)}" class="ws-dl-chip" title="直接下载文件或打包下载文件夹">⬇</a></span>`;
    }
    if (res.kind === 'direct_download') {
      return `<a href="${escHtml(res.href)}" class="ws-direct-dl" title="直接下载">${labelHtml} ⬇</a>`;
    }
    if (res.kind === 'same_origin_page') {
      return `<a href="${escHtml(res.href)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;
    }
    if (res.kind === 'outside_workspace') {
      return `<span class="pill" title="工作区外路径: ${escHtml(res.displayPath)}">${labelHtml}</span>`;
    }
    return `<a href="${escHtml(res.href)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;
  }

  function hasUnwrappedCjk(tex) {
    const stripped = String(tex || '').replace(
      /\\(?:text|mathrm|textbf|textit|textrm|operatorname)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g,
      ' '
    );
    return /[\u4e00-\u9fff]/.test(stripped);
  }

  function renderMathHtml(tex, displayMode) {
    const cleanTex = String(tex || '').trim();
    if (!cleanTex) return '';
    if (window.katex && typeof window.katex.renderToString === 'function') {
      try {
        const rendered = window.katex.renderToString(cleanTex, {
          displayMode: Boolean(displayMode),
          throwOnError: false,
          strict: 'ignore',
          trust: false,
        });
        return displayMode
          ? `<div class="math-block">${rendered}</div>`
          : `<span class="math-inline">${rendered}</span>`;
      } catch {}
    }
    return displayMode
      ? `<pre class="preview-code"><code>${escHtml(cleanTex)}</code></pre>`
      : `<code>${escHtml(cleanTex)}</code>`;
  }

  function renderMarkdown(md) {
    const src = String(md || '').replace(/\r\n/g, '\n');
    const blocks = [];
    const rawCodes = [];
    const mathInlines = [];

    const stashCode = (raw) => {
      const idx = rawCodes.length;
      rawCodes.push(raw);
      return `\x00CODE${idx}\x00`;
    };
    const stashMath = (tex) => {
      const idx = mathInlines.length;
      mathInlines.push(renderMathHtml(tex, false));
      return `\x00MATH${idx}\x00`;
    };
    const stashDisplayMath = (tex, offset, fullStr) => {
      const lineStart = fullStr.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
      const linePrefix = fullStr.slice(lineStart, offset);
      if (/^\s*\|/.test(linePrefix) && !tex.includes('\n')) {
        return stashMath(tex);
      }
      const idx = blocks.length;
      blocks.push(renderMathHtml(tex, true));
      return `\n\x00BLOCK${idx}\x00\n`;
    };

    // 1. Extract fenced code blocks before HTML escaping / math parsing
    let text = src.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      const idx = blocks.length;
      const safeLang = escHtml(lang || 'text');
      const safeCode = escHtml(code.replace(/\n$/, ''));
      blocks.push(
        `<div class="code-block"><div class="code-head"><span>${safeLang}</span><button class="btn copy-code-btn" type="button" data-code="${idx}">复制</button></div><pre><code>${safeCode}</code></pre></div>`
      );
      return `\n\x00BLOCK${idx}\x00\n`;
    });

    // 2. Extract inline code spans so $VARS or LaTeX inside backticks stays literal
    text = text.replace(/`([^`\n]+)`/g, (_m, code) => stashCode(code));

    // 3. Extract display math $$...$$ and \[...\]
    text = text.replace(/(^|[^\\])\$\$([\s\S]+?)(?<!\\)\$\$/g, (m, lead, tex, offset, fullStr) => {
      if (!String(tex || '').trim()) return m;
      return lead + stashDisplayMath(tex, offset + lead.length, fullStr);
    });
    text = text.replace(/\\\[([\s\S]+?)\\\]/g, (m, tex, offset, fullStr) => {
      if (!String(tex || '').trim()) return m;
      return stashDisplayMath(tex, offset, fullStr);
    });

    // 4. Extract inline math \(...\) and $...$
    text = text.replace(/\\\((.+?)\\\)/g, (m, tex) => {
      if (!String(tex || '').trim()) return m;
      return stashMath(tex);
    });
    text = text.replace(/(^|[^\\$])\$(?!\$|\s)((?:\\.|[^$\\\n])+?)(?<!\s|\\)\$(?!\$|\d)/g, (m, lead, tex) => {
      if (hasUnwrappedCjk(tex)) return m;
      return lead + stashMath(tex);
    });

    // 5. Unescape literal \$ in prose after math spans are extracted
    text = text.replace(/\\\$/g, '$');

    text = escHtml(text);

    // Inline formatting
    const formatInline = (s) => {
      const inlines = [];
      const stash = (html) => {
        const k = `\x00INL${inlines.length}\x00`;
        inlines.push(html);
        return k;
      };
      let out = s;
      out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      out = out.replace(/\[([^\]]+)\]\(((?:[^()\n]|\([^()\n]*\))+)\)/g, (_m, label, href) => {
        return stash(renderResolvedLinkHtml(label, href));
      });
      out = out.replace(/((?:file:\/\/\/|https?:\/\/)[^\s\x00]+)/gi, (full) => {
        let candidate = full;
        let suffix = '';
        while (candidate) {
          const entM = /(&(?:lt|gt|quot|#39);)$/.exec(candidate);
          if (entM) {
            suffix = entM[1] + suffix;
            candidate = candidate.slice(0, -entM[1].length);
            continue;
          }
          const ch = candidate[candidate.length - 1];
          if (/[.,;:!?。，；：！？、]/.test(ch)) {
            suffix = ch + suffix;
            candidate = candidate.slice(0, -1);
            continue;
          }
          if (ch === ')' && (candidate.match(/\(/g) || []).length < (candidate.match(/\)/g) || []).length) {
            suffix = ch + suffix;
            candidate = candidate.slice(0, -1);
            continue;
          }
          break;
        }
        if (!candidate) return full;
        return stash(renderResolvedLinkHtml(candidate, candidate)) + suffix;
      });
      // Expand links first, then resolve inline code/math tokens (including inside link labels)
      out = out.replace(/\x00INL(\d+)\x00/g, (_m, idx) => inlines[Number(idx)] || '');
      out = out.replace(/\x00CODE(\d+)\x00/g, (_m, idx) => `<code>${escHtml(rawCodes[Number(idx)] ?? '')}</code>`);
      out = out.replace(/\x00MATH(\d+)\x00/g, (_m, idx) => mathInlines[Number(idx)] || '');
      return out;
    };

    const lines = text.split('\n');
    const html = [];
    let inUl = false;
    let inOl = false;
    const closeLists = () => {
      if (inUl) { html.push('</ul>'); inUl = false; }
      if (inOl) { html.push('</ol>'); inOl = false; }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const blockMatch = /^\x00BLOCK(\d+)\x00$/.exec(line.trim());
      if (blockMatch) {
        closeLists();
        html.push(blocks[Number(blockMatch[1])]);
        continue;
      }
      if (!line.trim()) {
        closeLists();
        continue;
      }
      const hMatch = /^(#{1,4})\s+(.+)$/.exec(line);
      if (hMatch) {
        closeLists();
        const lvl = hMatch[1].length;
        html.push(`<h${lvl}>${formatInline(hMatch[2])}</h${lvl}>`);
        continue;
      }
      const bqMatch = /^&gt;\s?(.*)$/.exec(line);
      if (bqMatch) {
        closeLists();
        html.push(`<blockquote>${formatInline(bqMatch[1])}</blockquote>`);
        continue;
      }
      const ulMatch = /^[-*+]\s+(.+)$/.exec(line);
      if (ulMatch) {
        if (inOl) { html.push('</ol>'); inOl = false; }
        if (!inUl) { html.push('<ul>'); inUl = true; }
        html.push(`<li>${formatInline(ulMatch[1])}</li>`);
        continue;
      }
      const olMatch = /^\d+\.\s+(.+)$/.exec(line);
      if (olMatch) {
        if (inUl) { html.push('</ul>'); inUl = false; }
        if (!inOl) { html.push('<ol>'); inOl = true; }
        html.push(`<li>${formatInline(olMatch[1])}</li>`);
        continue;
      }
      if (line.trim().startsWith('|') && i + 1 < lines.length && /^\|?[\s:|-]+\|/.test(lines[i + 1].trim())) {
        closeLists();
        const parseCells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const ths = parseCells(line).map(c => `<th>${formatInline(c)}</th>`).join('');
        i += 2;
        const bodyRows = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          const tds = parseCells(lines[i]).map(c => `<td>${formatInline(c)}</td>`).join('');
          bodyRows.push(`<tr>${tds}</tr>`);
          i++;
        }
        i--;
        html.push(`<table><thead><tr>${ths}</tr></thead><tbody>${bodyRows.join('')}</tbody></table>`);
        continue;
      }
      closeLists();
      html.push(`<p>${formatInline(line)}</p>`);
    }
    closeLists();

    let joined = html.join('');
    joined = joined.replace(/\x00BLOCK(\d+)\x00/g, (_m, n) => blocks[Number(n)] || '');
    return joined;
  }

  // ---------- ACP WebSocket Engine ----------
  function setWsBadge(mode, text) {
    const pill = $('ws-pill');
    const dot = $('ws-dot');
    const lbl = $('ws-label');
    if (!pill || !dot || !lbl) return;
    pill.className = 'pill ' + mode;
    dot.className = 'dot ' + (mode === 'ok' ? 'online' : mode);
    lbl.textContent = text;
  }

  function connectWs(forceEngineId) {
    const targetEngine = forceEngineId || getEffectiveEngineId();
    if (ws && ws.readyState === WebSocket.OPEN && acpLiveEngineId === targetEngine && state.wsReady) {
      return Promise.resolve();
    }
    if (connectPromise && connectTargetEngine === targetEngine) {
      return connectPromise;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) && acpLiveEngineId !== targetEngine) {
      suppressReconnectOnce = true;
      try { ws.close(); } catch {}
      ws = null;
      state.wsConnected = false;
      state.wsReady = false;
      acpLiveSessionId = null;
      acpLiveCwd = null;
      loadedAcpSessions.clear();
      loadingAcpSessions.clear();
    }

    connectTargetEngine = targetEngine;
    connectPromise = new Promise((resolve, reject) => {
      const myGen = ++wsGen;
      acpLiveEngineId = targetEngine;
      setWsBadge('warn', `连接 ${getEngineBadgeName(targetEngine)} ACP...`);
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      const socket = new WebSocket(`${proto}${location.host}/agent?cid=${encodeURIComponent(state.clientId)}&engine=${encodeURIComponent(targetEngine)}`);
      ws = socket;
      let initDone = false;
      let settled = false;
      let freshInitStarted = false;
      let fallbackTimer = null;

      const finishConnect = (ok, err) => {
        if (settled) return;
        settled = true;
        if (connectTargetEngine === targetEngine) connectPromise = null;
        if (ok) resolve();
        else reject(err || new Error('WS connect failed'));
      };

      const triggerFreshInit = async () => {
        if (freshInitStarted || ws !== socket || socket.readyState !== WebSocket.OPEN) return;
        freshInitStarted = true;
        // Brand-new backend child process cannot answer RPCs from an earlier closed process
        for (const [id, p] of Array.from(pendingRpc.entries())) {
          if (p.wsGen !== myGen) {
            pendingRpc.delete(id);
            if (p.timer) clearTimeout(p.timer);
            p.reject(new Error('后台进程已重启，未收到响应（请检查文件变动或重试）'));
          }
        }
        if (disconnectGraceTimer) { clearTimeout(disconnectGraceTimer); disconnectGraceTimer = null; }
        loadedAcpSessions.clear();
        loadingAcpSessions.clear();
        acpLiveSessionId = null;
        try {
          await sendRpc('initialize', {
            protocolVersion: 1,
            clientCapabilities: { terminal: false, fs: { readTextFile: false, writeTextFile: false } },
          }, 25000);
          if (ws !== socket) { finishConnect(false, new Error('WS superseded')); return; }
          state.wsReady = true;
          initDone = true;
          setWsBadge('ok', `${getEngineBadgeName(targetEngine)} ACP 就绪`);
          finishConnect(true);
        } catch (e) {
          setWsBadge('err', '初始化失败');
          finishConnect(false, e);
        }
      };

      socket.onopen = () => {
        if (ws !== socket) return;
        state.wsConnected = true;
        // Wait briefly for --persist server banner ('reconnect' vs 'connected') before calling initialize
        fallbackTimer = setTimeout(() => {
          triggerFreshInit();
        }, 350);
      };

      socket.onmessage = (ev) => {
        const raw = String(ev.data || '');
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          let msg;
          try { msg = JSON.parse(t); } catch { continue; }
          if (msg.type === 'reconnect') {
            clearTimeout(fallbackTimer);
            if (disconnectGraceTimer) { clearTimeout(disconnectGraceTimer); disconnectGraceTimer = null; }
            state.wsReady = true;
            initDone = true;
            for (const [, entry] of busySessions) entry.disconnectedWhileBusy = false;
            setWsBadge('ok', `${getEngineBadgeName(targetEngine)} ACP 就绪`);
            renderLiveBannerInPlace(getActiveSession());
            finishConnect(true);
            continue;
          }
          if (msg.type === 'connected') {
            clearTimeout(fallbackTimer);
            triggerFreshInit();
            continue;
          }
          handleRpcMessage(msg);
        }
      };

      socket.onclose = () => {
        clearTimeout(fallbackTimer);
        if (ws === socket) ws = null;
        state.wsConnected = false;
        state.wsReady = false;
        const wasSuppressed = suppressReconnectOnce;
        suppressReconnectOnce = false;

        let keptInfiniteCount = 0;
        for (const [id, p] of Array.from(pendingRpc.entries())) {
          if (wasSuppressed || p.finite) {
            pendingRpc.delete(id);
            if (p.timer) clearTimeout(p.timer);
            p.reject(new Error('WebSocket disconnected'));
          } else {
            keptInfiniteCount++;
          }
        }

        if (keptInfiniteCount > 0) {
          for (const [, entry] of busySessions) entry.disconnectedWhileBusy = true;
          renderLiveBannerInPlace(getActiveSession());
          if (disconnectGraceTimer) clearTimeout(disconnectGraceTimer);
          disconnectGraceTimer = setTimeout(() => {
            disconnectGraceTimer = null;
            for (const [id, p] of Array.from(pendingRpc.entries())) {
              if (!p.finite) {
                pendingRpc.delete(id);
                p.reject(new Error('WebSocket reconnect timeout (35s)'));
              }
            }
          }, 35000);
        }

        if (!initDone) finishConnect(false, new Error('WS closed before init'));
        if (!wasSuppressed) {
          setWsBadge('warn', keptInfiniteCount > 0 ? '网络波动重连中...' : '已断开，重连中...');
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => { connectWs().catch(() => {}); }, 1200);
        }
      };

      socket.onerror = () => {
        setWsBadge('err', '连接异常');
      };
    });
    return connectPromise;
  }

  function sendRpc(method, params, timeoutMs = 30000) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket not open'));
    }
    const id = rpcSeq++;
    const finite = timeoutMs > 0;
    return new Promise((resolve, reject) => {
      const timer = finite ? setTimeout(() => {
        pendingRpc.delete(id);
        reject(new Error('RPC timeout: ' + method));
      }, timeoutMs) : null;
      pendingRpc.set(id, { resolve, reject, timer, finite, wsGen });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function sendRpcResponse(id, result) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  function handleRpcMessage(msg) {
    // Response to our request
    if (msg.id !== undefined && !msg.method) {
      const entry = pendingRpc.get(msg.id);
      if (entry) {
        pendingRpc.delete(msg.id);
        if (entry.timer) clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
      }
      return;
    }

    // Server -> Client permission request
    if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      handlePermissionRequest(msg);
      return;
    }

    // Streaming updates
    if (msg.method === 'session/update' && msg.params) {
      handleSessionUpdate(msg.params);
    }
  }

  function findSessionForAcpId(sid) {
    if (sid) return state.sessions.find(s => s.acpSessionId === sid || s.id === sid) || null;
    return getActiveSession();
  }

  function getLastAssistantMsg(sess) {
    if (!sess) return null;
    for (let i = sess.messages.length - 1; i >= 0; i--) {
      if (sess.messages[i].role === 'assistant') return sess.messages[i];
    }
    return null;
  }

  function extractCommandMeta(tc) {
    const args = (tc && tc.args && typeof tc.args === 'object') ? tc.args : null;
    const rawCmd = args ? String(args.CommandLine || args.command || args.cmd || '').trim() : '';
    const summary = args ? String(args.toolSummary || args.Description || '').trim() : '';
    const nameStr = String((tc && (tc.name || tc.title)) || '');
    const isShell = Boolean(rawCmd || /run_command|execute|shell|bash|powershell|cmd/i.test(nameStr));
    let label = (tc && (tc.title || tc.name)) || 'tool';
    if (summary && rawCmd) {
      const shortCmd = rawCmd.replace(/\s+/g, ' ').slice(0, 88);
      label = `${summary} · ${shortCmd}`;
    } else if (rawCmd) {
      label = rawCmd.replace(/\s+/g, ' ').slice(0, 110);
    }
    return { label, summary, rawCmd, isShell };
  }

  function handleSessionUpdate(params) {
    const sid = params.sessionId;
    const sess = findSessionForAcpId(sid);
    const upd = params.update;
    if (!upd) return;

    if (upd.sessionUpdate === 'usage_update') {
      const used = Number(upd.used || 0);
      const size = Number(upd.size || 0);
      if (size > 0 && (!sess || sess.id === state.activeSessionId)) {
        const pct = Math.min(100, Math.round((used / size) * 100));
        const pill = $('usage-pill');
        if (pill) {
          pill.hidden = false;
          pill.textContent = `上下文 ${pct}% (${Math.round(used / 1000)}k/${Math.round(size / 1000)}k)`;
        }
      }
      return;
    }

    if (upd.sessionUpdate === 'current_mode_update' && upd.currentModeId) {
      if (!sess || sess.id === state.activeSessionId) {
        state.currentModeId = upd.currentModeId;
        renderModeButton();
      }
      if (sess) sess.modeId = upd.currentModeId;
      return;
    }

    // Drop history replay frames triggered while session/load is hydrating the backend
    if (sid && loadingAcpSessions.has(sid)) return;

    if (!sess) return;

    if (upd.sessionUpdate === 'session_info_update' && upd.title) {
      sess.title = upd.title;
      renderSidebar();
      renderTabs();
      scheduleSaveSession(sess);
      return;
    }

    const last = getLastAssistantMsg(sess);
    // Strict turn guard: never append or duplicate onto an already completed turn
    if (!last || last._done === true) return;

    // Auto-resume busy indicator if a page refresh/reconnect receives live tailing chunks
    if (!isSessionBusy(sess.id)) {
      setSessionBusy(sess, true, {
        phase: '已恢复实时输出流...',
        acpSessionId: sid || sess.acpSessionId || '',
      });
    }
    if (sid) loadedAcpSessions.add(sid);

    if (upd.sessionUpdate === 'agent_thought_chunk') {
      if (upd.content && upd.content.text) {
        last.thought = (last.thought || '') + upd.content.text;
        touchSessionBusy(sess, { phase: '模型推理中 (Thought)...' });
        if (sess.id === state.activeSessionId) updateStreamingDom(sess);
        scheduleSaveSession(sess);
      }
      return;
    }

    if (upd.sessionUpdate === 'agent_message_chunk') {
      if (upd.content && upd.content.text) {
        last.text = (last.text || '') + upd.content.text;
        touchSessionBusy(sess, { phase: '正在输出回复...' });
        if (sess.id === state.activeSessionId) updateStreamingDom(sess);
        scheduleSaveSession(sess);
      }
      return;
    }

    if (upd.sessionUpdate === 'tool_call' || upd.sessionUpdate === 'tool_call_update') {
      if (!Array.isArray(last.tools)) last.tools = [];
      const tid = upd.toolCallId || ('tool-' + last.tools.length);
      let tc = last.tools.find(t => t.id === tid);
      if (!tc) {
        tc = {
          id: tid,
          name: upd.name || upd.kind || 'tool',
          title: upd.title || upd.name || 'tool',
          status: upd.status || 'in_progress',
          args: upd.args || upd.rawInput,
          output: '',
          startedAt: Date.now(),
        };
        last.tools.push(tc);
      }
      if (upd.name) tc.name = upd.name;
      if (upd.title) tc.title = upd.title;
      if (upd.status) {
        tc.status = upd.status;
        if (upd.status === 'completed' || upd.status === 'failed') {
          tc.endedAt = tc.endedAt || Date.now();
        }
      }
      if (upd.args || upd.rawInput) tc.args = upd.args || upd.rawInput;
      if (upd.rawOutput && upd.rawOutput.output !== undefined) tc.output = String(upd.rawOutput.output);
      else if (Array.isArray(upd.content) && upd.content.length > 0) {
        const txtParts = upd.content.map(c => (c.content && c.content.text) ? c.content.text : '').filter(Boolean);
        if (txtParts.length) tc.output = txtParts.join('\n');
      }
      const meta = extractCommandMeta(tc);
      if (tc.status === 'in_progress') {
        touchSessionBusy(sess, {
          phase: meta.isShell ? `正在执行命令: ${meta.summary || meta.rawCmd || tc.name}` : `正在调用工具: ${meta.label}`,
          toolName: tc.name,
        });
        if (meta.isShell) pollRuntimeStatusOnce();
      } else {
        touchSessionBusy(sess, { phase: `工具已完成 (${tc.name})，等待下一步...` });
      }
      if (sess.id === state.activeSessionId) renderChat();
      scheduleSaveSession(sess);
      return;
    }
  }

  function handlePermissionRequest(msg) {
    const params = msg.params || {};
    const options = Array.isArray(params.options) ? params.options : [];
    const allowOpt = options.find(o => String(o.kind || '').startsWith('allow') || o.optionId === 'allow') || options[0];

    if (state.autoAllow && allowOpt) {
      sendRpcResponse(msg.id, { outcome: { outcome: 'selected', optionId: allowOpt.optionId } });
      return;
    }

    const sess = findSessionForAcpId(params.sessionId) || getActiveSession();
    const last = getLastAssistantMsg(sess);
    if (!last || last._done === true) {
      if (allowOpt) sendRpcResponse(msg.id, { outcome: { outcome: 'selected', optionId: allowOpt.optionId } });
      return;
    }
    if (!Array.isArray(last.permissions)) last.permissions = [];
    last.permissions.push({
      rpcId: msg.id,
      toolCall: params.toolCall || {},
      options,
      resolved: null,
    });
    if (sess.id === state.activeSessionId) renderChat();
  }

  async function ensureActiveAcpSession(targetSess = getActiveSession()) {
    const sess = targetSess;
    if (!sess) throw new Error('No active session');
    const targetEngine = getEffectiveEngineId(sess);
    if (!sess.engineId) sess.engineId = targetEngine;
    await connectWs(targetEngine);
    const targetCwd = cwdForSubdir(sess.subdir || '');

    if (sess.acpSessionId && loadedAcpSessions.has(sess.acpSessionId) && acpLiveCwd === targetCwd && acpLiveEngineId === targetEngine) {
      acpLiveSessionId = sess.acpSessionId;
      return sess.acpSessionId;
    }

    // Try session/load if we already have an ACP session ID from earlier (guarding replay chunks)
    let result = null;
    if (sess.acpSessionId) {
      loadingAcpSessions.add(sess.acpSessionId);
      try {
        result = await sendRpc('session/load', { sessionId: sess.acpSessionId, cwd: targetCwd, mcpServers: [] }, 15000);
        acpLiveSessionId = sess.acpSessionId;
        loadedAcpSessions.add(sess.acpSessionId);
      } catch {
        result = null;
      } finally {
        loadingAcpSessions.delete(sess.acpSessionId);
      }
    }

    if (!result) {
      result = await sendRpc('session/new', { cwd: targetCwd, mcpServers: [] }, 25000);
      acpLiveSessionId = result.sessionId;
      sess.acpSessionId = result.sessionId;
      loadedAcpSessions.add(result.sessionId);
    }
    acpLiveCwd = targetCwd;

    if (result.models) {
      state.models = result.models.availableModels || [];
      state.currentModelId = sess.modelId || result.models.currentModelId || (state.models[0] && state.models[0].modelId) || '';
      if (sess.modelId && result.models.currentModelId !== sess.modelId) {
        try {
          await sendRpc('session/set_model', { sessionId: acpLiveSessionId, modelId: sess.modelId }, 10000);
        } catch {}
      }
    }
    if (result.modes) {
      state.modes = result.modes.availableModes || [];
      state.currentModeId = sess.modeId || result.modes.currentModeId || 'default';
      if (sess.modeId && result.modes.currentModeId !== sess.modeId) {
        try {
          await sendRpc('session/set_mode', { sessionId: acpLiveSessionId, modeId: sess.modeId }, 10000);
        } catch {}
      }
    }

    renderModelButton();
    renderModeButton();
    scheduleSaveSession(sess);
    return acpLiveSessionId;
  }

  // ---------- Sessions & Sidebar ----------
  function getProjectSubdirs() {
    const dirs = [''];
    for (const n of state.tree || []) {
      if (n.type === 'dir') dirs.push(n.name);
    }
    return dirs;
  }

  function createLocalSession(subdir = '') {
    const id = 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const engId = getEffectiveEngineId(null);
    const sess = {
      id,
      engineId: engId,
      acpSessionId: null,
      title: subdir ? `${subdir} · 新对话` : '新对话',
      subdir,
      modelId: state.currentModelId || '',
      modeId: state.currentModeId || 'default',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    state.sessions.unshift(sess);
    if (!state.openTabIds.includes(id)) state.openTabIds.push(id);
    switchToSession(id);
    saveSessionNow(sess).catch(() => {});
    return sess;
  }

  function switchToSession(id) {
    state.activeSessionId = id;
    if (!state.openTabIds.includes(id)) state.openTabIds.push(id);
    const sess = getActiveSession();
    if (sess) {
      if (sess.engineId) state.currentEngineId = sess.engineId;
      if (sess.modelId) state.currentModelId = sess.modelId;
      if (sess.modeId) state.currentModeId = sess.modeId;
    }
    syncActiveBusyState();
    renderSidebar();
    renderTabs();
    renderSubbar();
    renderEngineButton();
    renderModelButton();
    renderModeButton();
    renderChat();
    // Never send session/load merely when switching tabs — prevents cancelling background turns!
  }

  function renderSidebar() {
    const chipsEl = $('project-chips');
    const listEl = $('session-list');
    if (!chipsEl || !listEl) return;

    const dirs = getProjectSubdirs();
    chipsEl.innerHTML = '';
    const allChip = document.createElement('button');
    allChip.className = 'chip' + (state.activeProjectFilter === '__all__' ? ' active' : '');
    allChip.textContent = '全部';
    allChip.onclick = () => { state.activeProjectFilter = '__all__'; renderSidebar(); };
    chipsEl.appendChild(allChip);

    for (const d of dirs) {
      const c = document.createElement('button');
      c.className = 'chip' + (state.activeProjectFilter === d ? ' active' : '');
      c.textContent = d || '根目录';
      c.onclick = () => { state.activeProjectFilter = d; renderSidebar(); };
      chipsEl.appendChild(c);
    }

    const q = state.searchQuery.trim().toLowerCase();
    const filtered = state.sessions.filter(s => {
      if (state.activeProjectFilter !== '__all__' && (s.subdir || '') !== state.activeProjectFilter) return false;
      if (q && !String(s.title || '').toLowerCase().includes(q) && !String(s.subdir || '').toLowerCase().includes(q)) return false;
      return true;
    });

    // Group by subdir
    const groups = new Map();
    for (const d of dirs) {
      if (state.activeProjectFilter === '__all__' || state.activeProjectFilter === d) {
        groups.set(d, []);
      }
    }
    for (const s of filtered) {
      const k = s.subdir || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }

    listEl.innerHTML = '';
    for (const [subdir, items] of groups) {
      if (items.length === 0 && subdir !== '' && state.activeProjectFilter === '__all__') {
        // Show empty project folder header with + button so user can start chat directly inside that folder
      }
      const hdr = document.createElement('div');
      hdr.className = 'dir-group-title';
      const lbl = document.createElement('span');
      lbl.textContent = subdir ? ('📁 ' + subdir) : '🏠 工作区根目录';
      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-icon';
      addBtn.title = '在此目录新建对话';
      addBtn.textContent = '+';
      addBtn.onclick = (e) => { e.stopPropagation(); createLocalSession(subdir); };
      hdr.append(lbl, addBtn);
      listEl.appendChild(hdr);

      for (const s of items) {
        const row = document.createElement('div');
        row.className = 'session-item' + (s.id === state.activeSessionId ? ' active' : '');
        row.onclick = () => switchToSession(s.id);

        const titleSpan = document.createElement('span');
        titleSpan.className = 'session-title';
        titleSpan.textContent = s.title || '新对话';

        const metaSpan = document.createElement('span');
        metaSpan.className = 'session-meta';
        metaSpan.textContent = relTime(s.updatedAt);

        const acts = document.createElement('span');
        acts.className = 'session-actions';

        const ren = document.createElement('button');
        ren.className = 'btn btn-icon';
        ren.textContent = '✎';
        ren.title = '重命名';
        ren.onclick = async (e) => {
          e.stopPropagation();
          const next = prompt('输入新对话标题：', s.title || '');
          if (next && next.trim()) {
            s.title = next.trim();
            renderSidebar(); renderTabs();
            await saveSessionNow(s).catch(() => {});
          }
        };

        const del = document.createElement('button');
        del.className = 'btn btn-icon btn-danger';
        del.textContent = '×';
        del.title = '删除对话';
        del.onclick = async (e) => {
          e.stopPropagation();
          state.sessions = state.sessions.filter(x => x.id !== s.id);
          state.openTabIds = state.openTabIds.filter(x => x !== s.id);
          await apiJson('/api/sessions?id=' + encodeURIComponent(s.id), { method: 'DELETE' }).catch(() => {});
          if (state.activeSessionId === s.id) {
            if (state.sessions.length > 0) switchToSession(state.sessions[0].id);
            else createLocalSession('');
          } else {
            renderSidebar(); renderTabs();
          }
        };

        acts.append(ren, del);
        row.append(titleSpan, metaSpan, acts);
        listEl.appendChild(row);
      }
    }
  }

  function renderTabs() {
    const tabList = $('tab-list');
    if (!tabList) return;
    tabList.innerHTML = '';
    for (const id of state.openTabIds) {
      const s = state.sessions.find(x => x.id === id);
      if (!s) continue;
      const tab = document.createElement('div');
      tab.className = 'tab-item' + (id === state.activeSessionId ? ' active' : '');
      tab.onclick = () => switchToSession(id);

      const lbl = document.createElement('span');
      lbl.className = 'tab-label';
      lbl.textContent = s.title || '新对话';

      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.onclick = (e) => {
        e.stopPropagation();
        if (state.openTabIds.length <= 1) return;
        state.openTabIds = state.openTabIds.filter(x => x !== id);
        if (state.activeSessionId === id) {
          switchToSession(state.openTabIds[state.openTabIds.length - 1]);
        } else {
          renderTabs();
        }
      };
      tab.append(lbl, close);
      tabList.appendChild(tab);
    }
  }

  function renderSubbar() {
    const sess = getActiveSession();
    const cwdEl = $('active-cwd');
    if (cwdEl) cwdEl.textContent = cwdForSubdir(sess ? sess.subdir : '');
  }

  // ---------- Chat Rendering & Streaming ----------
  function isNearBottom(el) {
    if (!el) return true;
    return (el.scrollHeight - el.scrollTop - el.clientHeight) < 140;
  }

  function buildLiveBannerHtml(sess, entry) {
    const elapsed = formatDuration(Date.now() - entry.startedAt);
    const silentSec = Math.max(0, Math.floor((Date.now() - entry.lastEventAt) / 1000));
    const procs = Array.isArray(entry.runtimeProcesses) ? entry.runtimeProcesses : [];
    const liveLog = entry.liveLog;
    const isWarn = Boolean(entry.disconnectedWhileBusy);
    const title = entry.disconnectedWhileBusy
      ? '⚠️ 网络闪断重连中… 服务器后台任务仍在继续执行，请勿重发消息'
      : (entry.phase || '正在执行中...');

    let procHtml = '';
    if (procs.length > 0) {
      procHtml = '<div class="live-proc-list">' + procs.map(p => (
        `<div class="live-proc-row" title="${escHtml(p.cmd)}"><span>⚡</span><b>${escHtml(p.name)}</b><span>(${p.ageSec}s)</span><span>${escHtml(p.cmd)}</span></div>`
      )).join('') + '</div>';
    }

    let logHtml = '';
    if (liveLog && liveLog.tail) {
      logHtml = `<div class="live-log-wrap"><div class="live-log-head"><span>实时输出 · ${escHtml(liveLog.source)}</span><span>${liveLog.size} B</span></div><pre class="live-log-tail">${escHtml(liveLog.tail)}</pre></div>`;
    }

    return `
      <div class="live-run-head">
        <span class="dot ${isWarn ? 'warn' : 'online'}"></span>
        <span class="live-run-title">${escHtml(title)}</span>
        <span class="live-run-meta">已运行 ${elapsed} · 最近活动 ${silentSec}s 前</span>
      </div>
      ${procHtml}
      ${logHtml}`;
  }

  function renderLiveBannerInPlace(sess) {
    if (!sess || sess.id !== state.activeSessionId) return;
    const wrap = $('streaming-assistant');
    if (!wrap) return;
    let banner = $('live-run-banner');
    const entry = busySessions.get(sess.id);
    if (!entry) {
      if (banner) banner.remove();
      return;
    }
    const scrollEl = $('chat-scroll');
    const keepScroll = isNearBottom(scrollEl);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'live-run-banner';
      wrap.appendChild(banner);
    }
    banner.className = 'live-run-banner' + (entry.disconnectedWhileBusy ? ' warn' : '');
    banner.innerHTML = buildLiveBannerHtml(sess, entry);
    const tailEl = banner.querySelector('.live-log-tail');
    if (tailEl) tailEl.scrollTop = tailEl.scrollHeight;
    if (keepScroll && scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function updateRunningToolElapsedInPlace(sess) {
    if (!sess || sess.id !== state.activeSessionId) return;
    const wrap = $('streaming-assistant');
    if (!wrap) return;
    const last = getLastAssistantMsg(sess);
    if (!last || !Array.isArray(last.tools)) return;
    for (const tc of last.tools) {
      if (tc.status !== 'in_progress' || !tc.startedAt) continue;
      const span = wrap.querySelector(`[data-tool-elapsed="${CSS.escape(String(tc.id))}"]`);
      if (span) span.textContent = formatDuration(Date.now() - tc.startedAt);
    }
  }

  function bindPersistedDetails(det, key) {
    det.addEventListener('toggle', () => {
      if (det.open) {
        expandedDetails.add(key);
        expandedDetails.delete('!' + key);
      } else {
        expandedDetails.delete(key);
        expandedDetails.add('!' + key);
      }
    });
  }

  function renderChat(forceScrollBottom = false) {
    const container = $('chat-messages');
    const scrollEl = $('chat-scroll');
    if (!container || !scrollEl) return;
    const keepScroll = forceScrollBottom || isNearBottom(scrollEl);
    const sess = getActiveSession();

    if (!sess || !sess.messages || sess.messages.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <h2>LanCode Workbench · ${escHtml(state.user || '')}</h2>
          <p>支持在工作台底部自由切换本地已授权的 CLI / 模型（支持目录隔离、拖拽文件夹、实时命令监控）。</p>
          <div class="empty-tips">
            <div class="tip-card"><b>拖入整个文件夹</b>直接拖进聊天框或右侧文件树，自动上传并引用。</div>
            <div class="tip-card"><b>Ctrl+V 贴截图</b>截图或图片粘贴即传，直接让 AI 看图分析。</div>
            <div class="tip-card"><b>实时文件预览</b>AI 改完代码或生成报告，右侧目录树自动刷新秒开。</div>
          </div>
        </div>`;
      return;
    }

    container.innerHTML = '';
    const activeBusy = isSessionBusy(sess.id);
    for (let i = 0; i < sess.messages.length; i++) {
      const m = sess.messages[i];
      if (m.role === 'user') {
        const row = document.createElement('div');
        row.className = 'msg-user-row';
        const bubble = document.createElement('div');
        bubble.className = 'msg-user-bubble';
        if (Array.isArray(m.attachments) && m.attachments.length > 0) {
          const atts = document.createElement('div');
          atts.className = 'msg-user-atts';
          for (const a of m.attachments) {
            if (a.isImage && a.relPath) {
              const img = document.createElement('img');
              img.className = 'msg-att-img';
              img.src = '/preview/' + encRel(a.relPath);
              img.onclick = () => openPreview(a.relPath);
              atts.appendChild(img);
            } else {
              const tag = document.createElement('span');
              tag.className = 'pill';
              tag.textContent = (a.isFolder ? '📁 ' : '📄 ') + a.label;
              atts.appendChild(tag);
            }
          }
          bubble.appendChild(atts);
        }
        const txt = document.createElement('div');
        txt.textContent = m.text || '';
        bubble.appendChild(txt);
        row.appendChild(bubble);
        container.appendChild(row);
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'msg-assistant';
        const isLast = (i === sess.messages.length - 1);
        if (isLast) wrap.id = 'streaming-assistant';

        if (m.thought) {
          const thKey = `thought:${sess.id}:${i}`;
          const det = document.createElement('details');
          det.className = 'thought-box';
          if (expandedDetails.has(thKey)) det.open = true;
          bindPersistedDetails(det, thKey);
          det.innerHTML = `<summary>思考过程</summary><div class="thought-body">${escHtml(m.thought)}</div>`;
          wrap.appendChild(det);
        }

        if (Array.isArray(m.tools)) {
          for (const tc of m.tools) {
            const tKey = `tool:${tc.id}`;
            const meta = extractCommandMeta(tc);
            const isRun = tc.status === 'in_progress';
            const det = document.createElement('details');
            det.className = 'tool-card' + (isRun ? ' is-running' : '');
            if (expandedDetails.has(tKey) || (isRun && meta.isShell && !expandedDetails.has('!' + tKey))) {
              det.open = true;
            }
            bindPersistedDetails(det, tKey);
            const stCls = tc.status === 'completed' ? 'done' : (tc.status === 'failed' ? 'err' : 'run');
            const stIcon = tc.status === 'completed' ? '✓' : (tc.status === 'failed' ? '✕' : '⋯');
            const elapsedTxt = (isRun && tc.startedAt)
              ? formatDuration(Date.now() - tc.startedAt)
              : ((tc.endedAt && tc.startedAt) ? formatDuration(tc.endedAt - tc.startedAt) : '');
            const argsStr = meta.rawCmd || (tc.args ? JSON.stringify(tc.args, null, 2) : '');
            det.innerHTML = `
              <summary>
                <span class="tool-status ${stCls}">${stIcon}</span>
                <span class="tool-title">${escHtml(meta.label)}</span>
                ${elapsedTxt ? `<span class="tool-elapsed" data-tool-elapsed="${escHtml(tc.id)}">${elapsedTxt}</span>` : ''}
              </summary>
              <div class="tool-body">${escHtml(argsStr)}${tc.output ? ('\n\n--- 输出 ---\n' + escHtml(tc.output)) : (isRun ? '\n\n(命令正在后台运行，等待返回结果...)' : '')}</div>`;
            wrap.appendChild(det);
          }
        }

        if (Array.isArray(m.permissions)) {
          for (const pm of m.permissions) {
            const card = document.createElement('div');
            card.className = 'perm-card';
            const title = (pm.toolCall && (pm.toolCall.title || pm.toolCall.name)) || '请求执行工具';
            card.innerHTML = `<div style="font-weight:600">需要权限确认：<code>${escHtml(title)}</code></div>`;
            const acts = document.createElement('div');
            acts.className = 'perm-actions';
            if (pm.resolved) {
              acts.innerHTML = `<span class="pill ok">已选择：${escHtml(pm.resolved)}</span>`;
            } else {
              for (const opt of pm.options || []) {
                const btn = document.createElement('button');
                btn.className = 'btn ' + (String(opt.kind || '').startsWith('allow') ? 'btn-primary' : '');
                btn.textContent = opt.name || opt.optionId;
                btn.onclick = () => {
                  pm.resolved = opt.name || opt.optionId;
                  sendRpcResponse(pm.rpcId, { outcome: { outcome: 'selected', optionId: opt.optionId } });
                  renderChat();
                };
                acts.appendChild(btn);
              }
            }
            card.appendChild(acts);
            wrap.appendChild(card);
          }
        }

        const prose = document.createElement('div');
        prose.className = 'prose';
        prose.innerHTML = m.text ? renderMarkdown(m.text) : (activeBusy && isLast ? '<span style="color:var(--text-muted)">正在思考…</span>' : '');
        wrap.appendChild(prose);

        if (m.error) {
          const err = document.createElement('div');
          err.className = 'pill err';
          err.textContent = '错误: ' + m.error;
          wrap.appendChild(err);
        }

        container.appendChild(wrap);
      }
    }
    if (activeBusy) renderLiveBannerInPlace(sess);
    if (keepScroll) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function updateStreamingDom(sess) {
    const wrap = $('streaming-assistant');
    const last = getLastAssistantMsg(sess);
    if (!wrap || !last) { renderChat(); return; }
    const scrollEl = $('chat-scroll');
    const keepScroll = isNearBottom(scrollEl);
    let prose = wrap.querySelector('.prose');
    if (prose) prose.innerHTML = last.text ? renderMarkdown(last.text) : '<span style="color:var(--text-muted)">正在生成…</span>';
    if (last.thought) {
      let det = wrap.querySelector('.thought-box');
      if (!det) {
        const msgIdx = Math.max(0, sess.messages.length - 1);
        const thKey = `thought:${sess.id}:${msgIdx}`;
        det = document.createElement('details');
        det.className = 'thought-box';
        if (expandedDetails.has(thKey)) det.open = true;
        bindPersistedDetails(det, thKey);
        det.innerHTML = `<summary>思考过程</summary><div class="thought-body"></div>`;
        wrap.insertBefore(det, prose);
      }
      det.querySelector('.thought-body').textContent = last.thought;
    }
    renderLiveBannerInPlace(sess);
    if (keepScroll && scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  // ---------- Send Prompt & Stop ----------
  async function sendPrompt() {
    const input = $('composer-input');
    const rawText = (input.value || '').trim();
    let sess = getActiveSession();
    if ((!rawText && state.attachments.length === 0) || (sess && isSessionBusy(sess.id))) return;

    if (!sess) sess = createLocalSession('');

    const atts = state.attachments.slice();
    state.attachments = [];
    input.value = '';
    input.style.height = 'auto';
    renderAttachments();

    const uiMsg = {
      role: 'user',
      text: rawText || '(仅附件)',
      attachments: atts.map(a => ({ label: a.label, relPath: a.relPath, isImage: a.isImage, isFolder: a.isFolder })),
    };
    const asstMsg = { role: 'assistant', text: '', thought: '', tools: [], permissions: [], _done: false };
    sess.messages.push(uiMsg, asstMsg);
    if (sess.title === '新对话' || sess.title.endsWith(' · 新对话')) {
      const hintTitle = (rawText || (atts[0] && atts[0].label) || '新对话').slice(0, 28);
      sess.title = sess.subdir ? `${sess.subdir} · ${hintTitle}` : hintTitle;
    }
    sess.updatedAt = Date.now();
    setSessionBusy(sess, true, {
      phase: '正在建立 ACP 会话并发送请求...',
      acpSessionId: sess.acpSessionId || '',
    });
    renderSidebar();
    renderTabs();
    renderChat(true);

    try {
      const sid = await ensureActiveAcpSession(sess);
      touchSessionBusy(sess, { phase: '已提交给 Agent，等待流响应...', acpSessionId: sid });
      const blocks = [];
      const contextNotes = [];

      for (const a of atts) {
        if (a.isImage && a.base64 && a.mimeType) {
          blocks.push({ type: 'image', mimeType: a.mimeType, data: a.base64 });
          contextNotes.push(`图片已保存到工作区: ${a.relPath}`);
        } else if (a.isFolder) {
          contextNotes.push(`文件夹已上传到工作区: ${a.relPath}（共 ${a.count} 个文件）`);
        } else {
          contextNotes.push(`文件已上传到工作区: ${a.relPath}`);
        }
      }

      const combinedText = contextNotes.length > 0
        ? `[工作区附件]\n${contextNotes.map(x => '- ' + x).join('\n')}\n\n${rawText || '请查看以上上传的文件/目录。'}`
        : rawText;
      blocks.push({ type: 'text', text: combinedText });

      const res = await sendRpc('session/prompt', { sessionId: sid, prompt: blocks }, 0);
      if (res && res.stopReason && res.stopReason !== 'end_turn' && !asstMsg.text) {
        asstMsg.text = `(${res.stopReason})`;
      }
    } catch (e) {
      asstMsg.error = e.message || String(e);
    } finally {
      asstMsg._done = true;
      setSessionBusy(sess, false);
      sess.updatedAt = Date.now();
      if (sess.id === state.activeSessionId) renderChat();
      saveSessionNow(sess).catch(() => {});
      refreshTreeAndActivity();
    }
  }

  function stopCurrentPrompt() {
    const sess = getActiveSession();
    const sid = (sess && sess.acpSessionId) || acpLiveSessionId;
    if (!sess || !isSessionBusy(sess.id) || !sid || !ws || ws.readyState !== WebSocket.OPEN) return;
    touchSessionBusy(sess, { phase: '正在停止当前运行...' });
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } }) + '\n');
  }

  function updateBusyUi() {
    $('btn-send').disabled = state.busy;
    $('btn-stop').hidden = !state.busy;
  }

  // ---------- Engine, Model & Mode Pickers ----------
  function renderEngineButton() {
    const btn = $('btn-engine-pick');
    if (!btn) return;
    const eid = getEffectiveEngineId();
    btn.textContent = '引擎: ' + getEngineBadgeName(eid) + ' ▾';
  }

  function toggleEngineMenu() {
    const menu = $('engine-menu');
    if (!menu) return;
    $('model-menu').hidden = true;
    $('mode-menu').hidden = true;
    if (!menu.hidden) { menu.hidden = true; return; }
    menu.innerHTML = '';
    const hdr = document.createElement('div');
    hdr.className = 'pop-group';
    hdr.textContent = '切换本地 CLI / ACP 引擎';
    menu.appendChild(hdr);

    const activeEid = getEffectiveEngineId();
    for (const eng of state.engines) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pop-item' + (eng.id === activeEid ? ' selected' : '');
      if (!eng.available) btn.style.opacity = '0.52';
      const statusTxt = eng.id === activeEid
        ? '✓'
        : (eng.available ? (eng.hostConfigured ? '就绪' : '可用') : '未安装');
      const statusCol = eng.available ? 'var(--status-online)' : 'var(--text-muted)';
      btn.title = eng.hint || eng.name;
      btn.innerHTML = `<span>${escHtml(eng.name)}</span><span style="font-size:10.5px;color:${statusCol}">${statusTxt}</span>`;
      btn.onclick = async () => {
        menu.hidden = true;
        if (!eng.available) {
          showToast(`${eng.name} 暂未安装：${eng.hint || ''}`, 3600);
          return;
        }
        if (isAnySessionBusy()) {
          showToast('当前仍有任务正在运行，请等待完成后再切换引擎', 2800);
          return;
        }
        if (eng.id === activeEid && state.wsReady) return;
        state.currentEngineId = eng.id;
        localStorage.setItem('lancode_engine', eng.id);
        const sess = getActiveSession();
        if (sess) {
          sess.engineId = eng.id;
          sess.acpSessionId = '';
          sess.modelId = '';
          scheduleSaveSession(sess);
        }
        state.models = [];
        state.modes = [];
        state.currentModelId = '';
        state.currentModeId = 'default';
        acpLiveSessionId = null;
        acpLiveCwd = null;
        loadedAcpSessions.clear();
        loadingAcpSessions.clear();
        renderEngineButton();
        renderModelButton();
        renderModeButton();
        if (ws) {
          suppressReconnectOnce = true;
          try { ws.close(); } catch {}
          ws = null;
          state.wsConnected = false;
          state.wsReady = false;
        }
        try {
          await ensureActiveAcpSession();
          showToast(`已切换引擎至 ${eng.name}`, 2000);
        } catch (err) {
          showToast(`切换 ${eng.name} 失败: ${err.message || err}`, 3500);
        }
      };
      menu.appendChild(btn);
    }
    menu.hidden = false;
  }

  function groupModels(models) {
    const groups = new Map([
      ['Claude', []],
      ['Codex / OpenAI', []],
      ['Gemini / Antigravity', []],
      ['其他模型', []],
    ]);
    for (const m of models) {
      const id = String(m.modelId || m.id || '').toLowerCase();
      if (id.includes('claude')) groups.get('Claude').push(m);
      else if (id.includes('gpt') || id.includes('codex') || /\bo[134]\b/.test(id)) groups.get('Codex / OpenAI').push(m);
      else if (id.includes('gemini') || id.includes('carbon') || id.includes('hydrogen') || id.includes('neon') || id.includes('argon')) groups.get('Gemini / Antigravity').push(m);
      else groups.get('其他模型').push(m);
    }
    return groups;
  }

  function renderModelButton() {
    const btn = $('btn-model-pick');
    if (!btn) return;
    const found = state.models.find(m => (m.modelId || m.id) === state.currentModelId);
    btn.textContent = '模型: ' + (found ? found.name : (state.currentModelId || '自动 / 点击选模型')) + ' ▾';
  }

  function renderModeButton() {
    const btn = $('btn-mode-pick');
    if (!btn) return;
    const found = state.modes.find(m => m.id === state.currentModeId);
    btn.textContent = '模式: ' + (found ? found.name : (state.currentModeId || 'Default')) + ' ▾';
  }

  function toggleModelMenu() {
    const menu = $('model-menu');
    $('mode-menu').hidden = true;
    const em = $('engine-menu');
    if (em) em.hidden = true;
    if (!menu.hidden) { menu.hidden = true; return; }
    if (state.models.length === 0) {
      ensureActiveAcpSession().then(() => { renderModelMenuItems(); menu.hidden = false; }).catch(() => {});
      return;
    }
    renderModelMenuItems();
    menu.hidden = false;
  }

  function renderModelMenuItems() {
    const menu = $('model-menu');
    menu.innerHTML = '';
    for (const [gname, items] of groupModels(state.models)) {
      if (items.length === 0) continue;
      const gh = document.createElement('div');
      gh.className = 'pop-group';
      gh.textContent = gname;
      menu.appendChild(gh);
      for (const m of items) {
        const mid = m.modelId || m.id;
        const btn = document.createElement('button');
        btn.className = 'pop-item' + (mid === state.currentModelId ? ' selected' : '');
        btn.innerHTML = `<span>${escHtml(m.name)}</span><span style="font-size:10.5px;color:var(--text-muted)">${mid === state.currentModelId ? '✓' : ''}</span>`;
        btn.onclick = async () => {
          menu.hidden = true;
          state.currentModelId = mid;
          const sess = getActiveSession();
          if (sess) { sess.modelId = mid; scheduleSaveSession(sess); }
          renderModelButton();
          if (acpLiveSessionId) {
            try { await sendRpc('session/set_model', { sessionId: acpLiveSessionId, modelId: mid }, 10000); } catch {}
          }
        };
        menu.appendChild(btn);
      }
    }
  }

  function toggleModeMenu() {
    const menu = $('mode-menu');
    $('model-menu').hidden = true;
    const em = $('engine-menu');
    if (em) em.hidden = true;
    if (!menu.hidden) { menu.hidden = true; return; }
    const modes = state.modes.length ? state.modes : [
      { id: 'default', name: 'Default' },
      { id: 'accept-edits', name: 'Accept edits' },
      { id: 'plan', name: 'Plan' },
    ];
    menu.innerHTML = '';
    for (const m of modes) {
      const btn = document.createElement('button');
      btn.className = 'pop-item' + (m.id === state.currentModeId ? ' selected' : '');
      btn.innerHTML = `<span>${escHtml(m.name)}</span><span style="font-size:10.5px;color:var(--text-muted)">${m.id === state.currentModeId ? '✓' : ''}</span>`;
      btn.onclick = async () => {
        menu.hidden = true;
        state.currentModeId = m.id;
        const sess = getActiveSession();
        if (sess) { sess.modeId = m.id; scheduleSaveSession(sess); }
        renderModeButton();
        if (acpLiveSessionId) {
          try { await sendRpc('session/set_mode', { sessionId: acpLiveSessionId, modeId: m.id }, 10000); } catch {}
        }
      };
      menu.appendChild(btn);
    }
    menu.hidden = false;
  }

  // ---------- Drag & Drop / Folder Upload / Paste ----------
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
    const entries = items.map(it => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    if (entries.length > 0) {
      const out = [];
      for (const ent of entries) out.push(...await walkEntry(ent, ''));
      return out;
    }
    return Array.from((dt && dt.files) || []).map(f => ({ file: f, relPath: f.webkitRelativePath || f.name }));
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const s = String(fr.result || '');
        const idx = s.indexOf(',');
        resolve(idx >= 0 ? s.slice(idx + 1) : s);
      };
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  async function uploadEntriesAndHandle(entries, targetSubdir, attachToComposer) {
    if (!entries || entries.length === 0) return;
    let ok = 0;
    const uploadedPaths = [];

    for (let i = 0; i < entries.length; i++) {
      const it = entries[i];
      const cleanRel = String(it.relPath || it.file.name).replace(/^\/+/, '');
      showToast(`正在上传 (${i + 1}/${entries.length}): ${cleanRel}`, 0);
      const r = await fetch(`/upload?dir=${encodeURIComponent(targetSubdir || '')}&name=${encodeURIComponent(cleanRel)}`, {
        method: 'POST',
        body: it.file,
      });
      if (r.ok) {
        ok++;
        const fullRel = targetSubdir ? (targetSubdir + '/' + cleanRel) : cleanRel;
        uploadedPaths.push({ fullRel, localRel: cleanRel, file: it.file });
      }
    }
    showToast(`上传完成：${ok} / ${entries.length} 个文件`, 2600);
    await refreshTreeAndActivity();

    if (attachToComposer && uploadedPaths.length > 0) {
      // Group folder uploads if multiple files share a top-level folder
      const topDirs = new Set(uploadedPaths.filter(u => u.localRel.includes('/')).map(u => u.localRel.split('/')[0]));
      if (uploadedPaths.length > 1 && topDirs.size === 1) {
        const dirName = [...topDirs][0];
        const dirRel = targetSubdir ? (targetSubdir + '/' + dirName) : dirName;
        state.attachments.push({
          label: `${dirName} (${uploadedPaths.length} 文件)`,
          relPath: dirRel,
          isFolder: true,
          count: uploadedPaths.length,
          isImage: false,
        });
      } else {
        for (const u of uploadedPaths) {
          const isImage = /^image\/(png|jpeg|gif|webp)$/i.test(u.file.type || '');
          let base64 = null;
          if (isImage && u.file.size <= 4 * 1024 * 1024) {
            try { base64 = await fileToBase64(u.file); } catch {}
          }
          state.attachments.push({
            label: u.file.name,
            relPath: u.fullRel,
            isFolder: false,
            isImage,
            mimeType: u.file.type || 'image/png',
            base64,
          });
        }
      }
      renderAttachments();
    }
  }

  function renderAttachments() {
    const bar = $('att-bar');
    if (!bar) return;
    if (state.attachments.length === 0) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    bar.innerHTML = '';
    state.attachments.forEach((a, idx) => {
      const chip = document.createElement('div');
      chip.className = 'att-chip';
      if (a.isImage && a.relPath) {
        const img = document.createElement('img');
        img.src = '/preview/' + encRel(a.relPath);
        chip.appendChild(img);
      }
      const txt = document.createElement('span');
      txt.textContent = (a.isFolder ? '📁 ' : (a.isImage ? '' : '📄 ')) + a.label;
      const rm = document.createElement('span');
      rm.className = 'att-rm';
      rm.textContent = '×';
      rm.onclick = () => { state.attachments.splice(idx, 1); renderAttachments(); };
      chip.append(txt, rm);
      bar.appendChild(chip);
    });
  }

  // ---------- Right Sidebar: Tree, Activity & Preview ----------
  function renderTree() {
    const el = $('tree-container');
    if (!el) return;
    const q = state.treeFilter.trim().toLowerCase();
    el.innerHTML = '';

    const renderNodes = (nodes, depth) => {
      for (const n of nodes) {
        if (n.type === 'file' && q && !n.name.toLowerCase().includes(q) && !n.path.toLowerCase().includes(q)) continue;
        if (n.type === 'dir' && q) {
          const matchesSelf = n.name.toLowerCase().includes(q);
          const hasMatchingDesc = JSON.stringify(n.children || []).toLowerCase().includes(q);
          if (!matchesSelf && !hasMatchingDesc) continue;
        }

        const row = document.createElement('div');
        row.className = 'tree-row' + (state.selectedFilePath === n.path ? ' selected' : '');
        row.style.paddingLeft = (8 + depth * 14) + 'px';
        row.dataset.path = n.path;
        row.dataset.type = n.type;

        if (n.type === 'dir') {
          const expanded = q ? true : state.expandedDirs.has(n.path);
          row.innerHTML = `<span>${expanded ? '▾' : '▸'} 📁</span><span class="tree-name">${escHtml(n.name)}</span>${n.hot ? '<span class="hot-dot" title="60秒内更新"></span>' : ''}`;
          row.onclick = () => {
            if (state.expandedDirs.has(n.path)) state.expandedDirs.delete(n.path);
            else state.expandedDirs.add(n.path);
            renderTree();
          };
          row.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); row.classList.add('drop-target'); });
          row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
          row.addEventListener('drop', async (e) => {
            e.preventDefault(); e.stopPropagation();
            row.classList.remove('drop-target');
            const items = await collectDropItems(e.dataTransfer);
            await uploadEntriesAndHandle(items, n.path, false);
          });
          const acts = document.createElement('span');
          acts.className = 'tree-actions';
          const zipA = document.createElement('a');
          zipA.className = 'btn btn-icon';
          zipA.textContent = '⬇';
          zipA.title = '打包下载';
          zipA.href = '/zip/' + encRel(n.path);
          zipA.onclick = (e) => e.stopPropagation();
          const delBtn = document.createElement('button');
          delBtn.className = 'btn btn-icon btn-danger';
          delBtn.textContent = '×';
          delBtn.title = '删除目录';
          delBtn.onclick = async (e) => {
            e.stopPropagation();
            if (!confirm('确认删除目录 ' + n.path + ' 及其全部内容？')) return;
            await apiJson('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: n.path }) });
            await refreshTreeAndActivity();
          };
          acts.append(zipA, delBtn);
          row.appendChild(acts);
          el.appendChild(row);

          if (expanded && Array.isArray(n.children)) renderNodes(n.children, depth + 1);
        } else {
          row.innerHTML = `<span>📄</span><span class="tree-name">${escHtml(n.name)}</span>${n.hot ? '<span class="hot-dot" title="60秒内更新"></span>' : ''}<span class="tree-size">${escHtml(n.sizeHuman)}</span>`;
          row.onclick = () => openPreview(n.path);
          const acts = document.createElement('span');
          acts.className = 'tree-actions';

          const citeBtn = document.createElement('button');
          citeBtn.className = 'btn btn-icon';
          citeBtn.textContent = '@';
          citeBtn.title = '引用到输入框';
          citeBtn.onclick = (e) => {
            e.stopPropagation();
            const inp = $('composer-input');
            inp.value = (inp.value ? inp.value + ' ' : '') + n.path;
            inp.focus();
          };

          const dlA = document.createElement('a');
          dlA.className = 'btn btn-icon';
          dlA.textContent = '⬇';
          dlA.title = '下载';
          dlA.href = '/download/' + encRel(n.path);
          dlA.onclick = (e) => e.stopPropagation();

          const delBtn = document.createElement('button');
          delBtn.className = 'btn btn-icon btn-danger';
          delBtn.textContent = '×';
          delBtn.title = '删除';
          delBtn.onclick = async (e) => {
            e.stopPropagation();
            if (!confirm('确认删除 ' + n.path + '？')) return;
            await apiJson('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: n.path }) });
            await refreshTreeAndActivity();
          };

          acts.append(citeBtn, dlA, delBtn);
          row.appendChild(acts);
          el.appendChild(row);
        }
      }
    };

    if (!state.tree || state.tree.length === 0) {
      el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px">空工作区，可拖入文件或整个文件夹</div>';
      return;
    }
    renderNodes(state.tree, 0);
  }

  function renderActivityList() {
    const el = $('act-container');
    const badge = $('act-badge');
    const sbAct = $('sb-activity');
    const d = state.activity;
    if (!d) return;

    if (badge) badge.textContent = d.hotCount > 0 ? `(${d.hotCount})` : '';
    if (sbAct) sbAct.textContent = `最近活动: ${d.latestRelative || '无'} · 5m变化 ${d.recent5mCount || 0}`;

    if (!el) return;
    const q = state.treeFilter.trim().toLowerCase();
    const items = (d.items || []).filter(it => !q || String(it.path || '').toLowerCase().includes(q));
    el.innerHTML = '';
    if (items.length === 0) {
      el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px">暂无匹配的活动记录</div>';
      return;
    }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'act-row' + (it.hot ? ' hot' : '');
      row.innerHTML = `<span class="act-path">${escHtml(it.path)}</span><span class="act-time">${escHtml(it.relative)}</span>`;
      row.onclick = () => openPreview(it.path);
      el.appendChild(row);
    }
  }

  function expandAncestorsFor(relPath) {
    const parts = String(relPath || '').split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      state.expandedDirs.add(parts.slice(0, i).join('/'));
    }
  }

  async function openPreview(relPath, opts = {}) {
    const cleanRel = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    state.selectedFilePath = cleanRel;
    expandAncestorsFor(cleanRel);
    renderTree();
    $('preview-title').textContent = cleanRel || '(工作区根目录)';
    const rawBtn = $('preview-raw');
    const dlBtn = $('preview-dl');
    const body = $('preview-body');
    body.innerHTML = '<div style="color:var(--text-muted);padding:16px">加载中...</div>';

    try {
      const d = await apiJson('/api/file?path=' + encodeURIComponent(cleanRel));
      rawBtn.href = d.previewUrl; rawBtn.hidden = false;
      dlBtn.href = d.zipUrl || d.downloadUrl;
      dlBtn.textContent = d.kind === 'directory' ? '下载 .zip' : '下载';
      dlBtn.hidden = false;

      if (d.kind === 'directory') {
        if (d.path) state.expandedDirs.add(d.path);
        renderTree();
        if (opts.fromChatLink) {
          triggerBrowserDownload(d.zipUrl || d.downloadUrl);
          showToast('📦 正在打包下载文件夹: ' + d.name + '.zip', 2800);
        }
        const itemsHtml = (d.items || []).map(it => {
          const icon = it.type === 'dir' ? '📁' : '📄';
          return `<div class="dir-preview-row" data-path="${escHtml(it.path)}"><span>${icon}</span><span class="dir-preview-name">${escHtml(it.name)}</span>${it.sizeHuman ? `<span class="dir-preview-size">${escHtml(it.sizeHuman)}</span>` : ''}<a href="${escHtml(it.downloadUrl)}" class="ws-dl-chip" title="下载">⬇</a></div>`;
        }).join('');
        body.innerHTML = `
          <div class="dir-preview-card">
            <div class="dir-preview-head">
              <div>
                <div class="dir-preview-title">📁 ${escHtml(d.name)}</div>
                <div class="dir-preview-sub">共 ${Number(d.itemCount || 0)} 个子项${(d.items && d.itemCount > d.items.length) ? '（仅展示前 ' + d.items.length + ' 项）' : ''}</div>
              </div>
              <div class="dir-preview-actions">
                <a class="btn btn-primary" href="${escHtml(d.zipUrl || d.downloadUrl)}">📦 打包下载整个文件夹 (.zip)</a>
              </div>
            </div>
            <div class="dir-preview-list">${itemsHtml || '<div style="padding:10px 0;color:var(--text-muted);font-size:12px">空文件夹</div>'}</div>
          </div>`;
      } else if (d.kind === 'image') {
        body.innerHTML = `<img class="preview-img" src="${escHtml(d.previewUrl)}?_=${Date.now()}" alt="${escHtml(d.name)}" />`;
      } else if (d.kind === 'html') {
        body.innerHTML = `<iframe class="preview-frame" sandbox="allow-scripts" src="${escHtml(d.previewUrl)}"></iframe>`;
      } else if (d.kind === 'pdf') {
        body.innerHTML = `<iframe class="preview-frame" src="${escHtml(d.previewUrl)}"></iframe>`;
      } else if (d.kind === 'video') {
        body.innerHTML = `<video controls style="max-width:100%;max-height:100%" src="${escHtml(d.previewUrl)}"></video>`;
      } else if (d.kind === 'audio') {
        body.innerHTML = `<audio controls style="width:100%" src="${escHtml(d.previewUrl)}"></audio>`;
      } else if (d.kind === 'markdown') {
        body.innerHTML = `<div class="prose">${renderMarkdown(d.content || '')}</div>`;
      } else if (d.kind === 'text') {
        const note = d.truncated ? '\n\n... [文件过大，仅预览前 256 KB] ...' : '';
        body.innerHTML = `<pre class="preview-code">${escHtml((d.content || '') + note)}</pre>`;
      } else {
        if (opts.fromChatLink) {
          triggerBrowserDownload(d.downloadUrl);
          showToast('⬇️ 正在下载文件: ' + d.name, 2400);
        }
        body.innerHTML = `
          <div class="binary-preview-card">
            <div class="dir-preview-title">📄 ${escHtml(d.name)}</div>
            <div class="dir-preview-sub">二进制/非纯文本文件（大小 ${escHtml(d.sizeHuman)}）暂不支持直接内嵌预览，可直接下载打开。</div>
            <div class="dir-preview-actions">
              <a class="btn btn-primary" href="${escHtml(d.downloadUrl)}">⬇️ 直接下载 ${escHtml(d.name)} (${escHtml(d.sizeHuman)})</a>
            </div>
          </div>`;
      }
    } catch (e) {
      rawBtn.hidden = true; dlBtn.hidden = true;
      body.innerHTML = `<div style="padding:16px;color:var(--danger)">预览失败: ${escHtml(e.message)}</div>`;
    }
  }

  // ---------- Refresh & SSE ----------
  async function refreshTreeAndActivity() {
    try {
      const [treeRes, actRes] = await Promise.all([
        apiJson('/api/tree'),
        apiJson('/activity.json'),
      ]);
      state.tree = treeRes.tree || [];
      state.activity = actRes;
      renderTree();
      renderActivityList();
      renderSidebar();
    } catch {}
  }

  function startSse() {
    const es = new EventSource('/api/events');
    es.addEventListener('fs', () => {
      refreshTreeAndActivity();
      if (state.selectedFilePath) openPreview(state.selectedFilePath).catch(() => {});
    });
    es.onerror = () => {
      // Browser EventSource reconnects automatically
    };
  }

  // ---------- Resizers & Theme ----------
  function initResizers() {
    const rootStyle = document.documentElement.style;
    const savedL = localStorage.getItem('agy_wb_left_w');
    const savedR = localStorage.getItem('agy_wb_right_w');
    const savedT = localStorage.getItem('agy_wb_top_r');
    if (savedL) rootStyle.setProperty('--left-width', savedL);
    if (savedR) rootStyle.setProperty('--right-width', savedR);
    if (savedT) rootStyle.setProperty('--right-top-ratio', savedT);

    const bindCol = (resizerId, panelId, cssVar, isLeft) => {
      const res = $(resizerId);
      const panel = $(panelId);
      if (!res || !panel) return;
      res.addEventListener('mousedown', (e) => {
        e.preventDefault();
        panel.classList.add('resizing');
        res.classList.add('dragging');
        const move = (ev) => {
          const w = isLeft ? ev.clientX : (window.innerWidth - ev.clientX);
          const clamped = Math.max(200, Math.min(560, w)) + 'px';
          rootStyle.setProperty(cssVar, clamped);
        };
        const up = () => {
          panel.classList.remove('resizing');
          res.classList.remove('dragging');
          localStorage.setItem(isLeft ? 'agy_wb_left_w' : 'agy_wb_right_w', rootStyle.getPropertyValue(cssVar));
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    };
    bindCol('resizer-left', 'panel-left', '--left-width', true);
    bindCol('resizer-right', 'panel-right', '--right-width', false);

    const rowRes = $('resizer-row');
    const rightPanel = $('panel-right');
    if (rowRes && rightPanel) {
      rowRes.addEventListener('mousedown', (e) => {
        e.preventDefault();
        rowRes.classList.add('dragging');
        const move = (ev) => {
          const rect = rightPanel.getBoundingClientRect();
          const pct = Math.max(22, Math.min(78, ((ev.clientY - rect.top) / rect.height) * 100));
          rootStyle.setProperty('--right-top-ratio', pct.toFixed(1) + '%');
        };
        const up = () => {
          rowRes.classList.remove('dragging');
          localStorage.setItem('agy_wb_top_r', rootStyle.getPropertyValue('--right-top-ratio'));
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    }
  }

  function initTheme() {
    const sel = $('theme-select');
    const saved = localStorage.getItem('agy_wb_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    if (sel) {
      sel.value = saved;
      sel.addEventListener('change', () => {
        document.documentElement.setAttribute('data-theme', sel.value);
        localStorage.setItem('agy_wb_theme', sel.value);
      });
    }
  }

  // ---------- Event Wiring ----------
  function bindEvents() {
    $('btn-toggle-left').onclick = () => {
      $('panel-left').classList.toggle('collapsed');
      $('resizer-left').classList.toggle('hidden');
    };
    $('btn-toggle-right').onclick = () => {
      $('panel-right').classList.toggle('collapsed');
      $('resizer-right').classList.toggle('hidden');
    };

    $('btn-new-chat').onclick = () => createLocalSession(state.activeProjectFilter === '__all__' ? '' : state.activeProjectFilter);
    $('btn-tab-new').onclick = () => createLocalSession(state.activeProjectFilter === '__all__' ? '' : state.activeProjectFilter);

    $('btn-new-dir').onclick = async () => {
      const name = prompt('输入新目录名称（例如：paper 或 src/demo）：');
      if (!name || !name.trim()) return;
      try {
        await apiJson('/api/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: name.trim() }),
        });
        await refreshTreeAndActivity();
        createLocalSession(name.trim());
      } catch (e) {
        alert('创建目录失败: ' + e.message);
      }
    };

    $('session-search').oninput = (e) => { state.searchQuery = e.target.value || ''; renderSidebar(); };
    $('tree-filter').oninput = (e) => { state.treeFilter = e.target.value || ''; renderTree(); renderActivityList(); };
    $('btn-tree-refresh').onclick = () => refreshTreeAndActivity();
    $('btn-zip-all').onclick = () => { location.href = '/zip/'; };

    $('tab-btn-tree').onclick = () => {
      state.rightTab = 'tree';
      $('tab-btn-tree').classList.add('active');
      $('tab-btn-act').classList.remove('active');
      $('tree-container').hidden = false;
      $('act-container').hidden = true;
    };
    $('tab-btn-act').onclick = () => {
      state.rightTab = 'activity';
      $('tab-btn-act').classList.add('active');
      $('tab-btn-tree').classList.remove('active');
      $('tree-container').hidden = true;
      $('act-container').hidden = false;
    };

    const chkAuto = $('chk-auto-allow');
    chkAuto.checked = state.autoAllow;
    chkAuto.onchange = () => {
      state.autoAllow = chkAuto.checked;
      localStorage.setItem('agy_auto_allow', state.autoAllow ? '1' : '0');
    };

    const engBtn = $('btn-engine-pick');
    if (engBtn) engBtn.onclick = (e) => { e.stopPropagation(); toggleEngineMenu(); };
    $('btn-model-pick').onclick = (e) => { e.stopPropagation(); toggleModelMenu(); };
    $('btn-mode-pick').onclick = (e) => { e.stopPropagation(); toggleModeMenu(); };
    document.addEventListener('click', () => {
      const engMenu = $('engine-menu');
      if (engMenu) engMenu.hidden = true;
      $('model-menu').hidden = true;
      $('mode-menu').hidden = true;
    });

    const input = $('composer-input');
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(190, input.scrollHeight) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
      } else if (e.key === 'Escape' && state.busy) {
        e.preventDefault();
        stopCurrentPrompt();
      }
    });
    input.addEventListener('paste', async (e) => {
      const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
      const imgs = items.filter(it => it.type && it.type.startsWith('image/'));
      if (imgs.length === 0) return;
      e.preventDefault();
      const entries = imgs.map((it, idx) => {
        const f = it.getAsFile();
        const ext = (f.type && f.type.split('/')[1]) || 'png';
        return { file: f, relPath: `_uploads/paste-${Date.now()}-${idx}.${ext}` };
      });
      const sess = getActiveSession();
      await uploadEntriesAndHandle(entries, sess ? sess.subdir : '', true);
    });

    $('btn-send').onclick = sendPrompt;
    $('btn-stop').onclick = stopCurrentPrompt;

    // Upload buttons
    $('btn-attach-file').onclick = () => { uploadTargetMode = 'composer'; uploadTargetDir = (getActiveSession() || {}).subdir || ''; $('hidden-file-input').click(); };
    $('btn-attach-dir').onclick = () => { uploadTargetMode = 'composer'; uploadTargetDir = (getActiveSession() || {}).subdir || ''; $('hidden-dir-input').click(); };
    $('btn-up-file').onclick = () => { uploadTargetMode = 'tree'; uploadTargetDir = ''; $('hidden-file-input').click(); };
    $('btn-up-dir').onclick = () => { uploadTargetMode = 'tree'; uploadTargetDir = ''; $('hidden-dir-input').click(); };

    $('hidden-file-input').onchange = async (e) => {
      const files = Array.from(e.target.files || []).map(f => ({ file: f, relPath: f.name }));
      e.target.value = '';
      await uploadEntriesAndHandle(files, uploadTargetDir, uploadTargetMode === 'composer');
    };
    $('hidden-dir-input').onchange = async (e) => {
      const files = Array.from(e.target.files || []).map(f => ({ file: f, relPath: f.webkitRelativePath || f.name }));
      e.target.value = '';
      await uploadEntriesAndHandle(files, uploadTargetDir, uploadTargetMode === 'composer');
    };

    // Drag & Drop onto Center Chat
    const chatDrop = $('chat-drop-zone');
    const chatOverlay = $('chat-drop-overlay');
    let dragCounter = 0;
    chatDrop.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      chatOverlay.hidden = false;
    });
    chatDrop.addEventListener('dragover', (e) => { e.preventDefault(); });
    chatDrop.addEventListener('dragleave', () => {
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) chatOverlay.hidden = true;
    });
    chatDrop.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      chatOverlay.hidden = true;
      const items = await collectDropItems(e.dataTransfer);
      const sess = getActiveSession();
      await uploadEntriesAndHandle(items, sess ? sess.subdir : '', true);
    });

    // Drag & Drop onto Right Tree Root
    const treeEl = $('tree-container');
    treeEl.addEventListener('dragover', (e) => { e.preventDefault(); treeEl.classList.add('drop-hot'); });
    treeEl.addEventListener('dragleave', (e) => { if (e.target === treeEl) treeEl.classList.remove('drop-hot'); });
    treeEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      treeEl.classList.remove('drop-hot');
      const items = await collectDropItems(e.dataTransfer);
      await uploadEntriesAndHandle(items, '', false);
    });

    // Delegated click handlers inside chat/preview (copy code & workspace preview links)
    document.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('.copy-code-btn');
      if (copyBtn) {
        const block = copyBtn.closest('.code-block');
        const code = block ? block.querySelector('pre code')?.textContent || '' : '';
        navigator.clipboard?.writeText(code).then(() => {
          copyBtn.textContent = '已复制';
          setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
        }).catch(() => {});
        return;
      }
      const prevLink = e.target.closest('.ws-preview-link');
      if (prevLink) {
        e.preventDefault();
        const rel = prevLink.dataset.rel ?? '';
        openPreview(rel, { fromChatLink: Boolean(prevLink.closest('#chat-messages')) });
        return;
      }
      const dirRow = e.target.closest('.dir-preview-row');
      if (dirRow && !e.target.closest('a')) {
        const rel = dirRow.dataset.path ?? '';
        openPreview(rel, { fromChatLink: false });
      }
    });
  }

  function ensureHotUpdateButton() {
    let btn = $('btn-hot-update');
    if (!btn) {
      const subbar = document.querySelector('.session-subbar');
      const usagePill = $('usage-pill');
      if (subbar) {
        btn = document.createElement('button');
        btn.id = 'btn-hot-update';
        btn.className = 'hot-update-btn';
        btn.hidden = true;
        if (usagePill) subbar.insertBefore(btn, usagePill);
        else subbar.appendChild(btn);
      }
    }
    if (btn) {
      btn.onclick = () => {
        if (isAnySessionBusy()) {
          showToast('当前仍有任务正在运行，完成后即可点此无损刷新', 3000);
          return;
        }
        location.reload();
      };
    }
  }

  async function checkUiVersionUpdate() {
    try {
      const data = await apiJson('/api/ui-version');
      if (data && data.version) {
        if (!initialUiVersion) {
          initialUiVersion = data.version;
        } else if (data.version !== initialUiVersion) {
          ensureHotUpdateButton();
          const btn = $('btn-hot-update');
          if (btn) {
            btn.hidden = false;
            refreshHotUpdateBtnLabel();
          }
        }
      }
    } catch {}
  }

  // ---------- Boot ----------
  async function boot() {
    initTheme();
    initResizers();
    bindEvents();
    ensureHotUpdateButton();

    try {
      const [me, treeRes, sessRes, actRes] = await Promise.all([
        apiJson('/api/me'),
        apiJson('/api/tree'),
        apiJson('/api/sessions'),
        apiJson('/activity.json'),
      ]);
      state.user = me.user;
      state.root = me.root;
      state.syncthing = me.syncthing;
      state.engines = me.engines || [];
      state.defaultEngine = me.defaultEngine || (state.engines.length ? 'codex' : 'agy');
      const prefEng = state.engines.find(e => e.id === state.currentEngineId && e.available);
      if (!prefEng) state.currentEngineId = state.defaultEngine;
      state.tree = treeRes.tree || [];
      state.sessions = sessRes.sessions || [];
      state.activity = actRes;
      renderEngineButton();

      $('sb-user').textContent = '用户: ' + state.user;
      const stEl = $('sb-syncthing');
      if (me.syncthing && me.syncthing.available) {
        const stOk = !me.syncthing.error && me.syncthing.connectedDevices > 0;
        stEl.textContent = `Syncthing: ${me.syncthing.folderId} (${me.syncthing.connectedDevices}/${me.syncthing.pairedDevices} 在线)`;
        stEl.style.color = stOk ? 'var(--status-online)' : 'var(--text-secondary)';
      } else {
        stEl.textContent = 'Syncthing: 未连接';
      }

      if (state.sessions.length > 0) {
        state.openTabIds = state.sessions.slice(0, 4).map(s => s.id);
        switchToSession(state.sessions[0].id);
      } else {
        createLocalSession('');
      }

      renderTree();
      renderActivityList();
      startSse();
      setInterval(() => refreshTreeAndActivity(), 15000);
      checkUiVersionUpdate();
      setInterval(() => checkUiVersionUpdate(), 30000);

      await connectWs();
      // Do not eagerly fire session/load on historical sessions during boot (avoids aborting active backend turns)
      const activeSess = getActiveSession();
      if (activeSess && !activeSess.acpSessionId && state.models.length === 0) {
        await ensureActiveAcpSession(activeSess).catch(() => {});
      }
    } catch (e) {
      setWsBadge('err', '启动异常: ' + (e.message || e));
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
