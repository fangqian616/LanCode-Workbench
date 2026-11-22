// Multi-CLI ACP Engine Registry, Spawner & Session Proxy
// Zero external dependencies; uses Node.js built-ins + helpers from ./agy-launch.mjs.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProxy, proxyEnvironment, resolveAgyExecutable } from './agy-launch.mjs';

const MAX_BUFFER_ITEMS = 500;
const sessions = new Map(); // `${user}:${engine}:${cid}` -> session entry
let whereCache = { at: 0, map: new Map() };

function findInPath(cmdName) {
  const now = Date.now();
  if (now - whereCache.at < 15000 && whereCache.map.has(cmdName)) {
    return whereCache.map.get(cmdName);
  }
  let found = '';
  try {
    const tool = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(tool, [cmdName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 2500,
    });
    found = out
      .split(/\r?\n/)
      .map(s => s.trim())
      .find(p => p && existsSync(p)) || '';
  } catch {}
  if (now - whereCache.at >= 15000) {
    whereCache = { at: now, map: new Map() };
  }
  whereCache.map.set(cmdName, found);
  return found;
}

function quoteCmdArg(arg) {
  const s = String(arg ?? '');
  if (!/[\s"&|<>^()]/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

function buildSpawnSpec(exe, args) {
  const ext = path.extname(exe).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { command: process.execPath, args: [exe, ...args], windowsVerbatimArguments: false };
  }
  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    const line = [quoteCmdArg(exe), ...args.map(quoteCmdArg)].join(' ');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', '"' + line + '"'],
      windowsVerbatimArguments: true,
    };
  }
  return { command: exe, args, windowsVerbatimArguments: false };
}

function resolveSpecs(rootDir) {
  const home = os.homedir();
  const codexAdapter = path.join(rootDir, 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js');
  const claudeAdapter = path.join(rootDir, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js');
  const geminiModule = path.join(rootDir, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');

  const agyExe = resolveAgyExecutable();
  const geminiExe = [
    process.env.GEMINI_CLI_PATH,
    existsSync(geminiModule) ? geminiModule : '',
    findInPath('gemini'),
  ].find(p => p && existsSync(p)) || '';
  const opencodeExe = [
    process.env.OPENCODE_EXE_PATH,
    findInPath('opencode'),
  ].find(p => p && existsSync(p)) || '';

  const codexHostConfigured = Boolean(
    existsSync(path.join(home, '.codex')) ||
    process.env.OPENAI_API_KEY ||
    findInPath('codex')
  );
  const claudeHostConfigured = Boolean(
    existsSync(path.join(home, '.claude')) ||
    existsSync(path.join(home, '.claude.json')) ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    findInPath('claude')
  );
  const geminiHostConfigured = Boolean(
    geminiExe && (
      existsSync(path.join(home, '.gemini')) ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY
    )
  );

  return [
    {
      id: 'codex',
      name: 'OpenAI Codex',
      badge: 'Codex',
      available: existsSync(codexAdapter),
      hostConfigured: codexHostConfigured,
      hint: existsSync(codexAdapter)
        ? (codexHostConfigured ? 'codex-acp bundled · host auth detected' : 'codex-acp bundled · run codex login or set OPENAI_API_KEY')
        : 'Run Install.cmd to install @agentclientprotocol/codex-acp',
      exe: codexAdapter,
      args: [],
    },
    {
      id: 'claude',
      name: 'Claude Code',
      badge: 'Claude',
      available: existsSync(claudeAdapter),
      hostConfigured: claudeHostConfigured,
      hint: existsSync(claudeAdapter)
        ? (claudeHostConfigured ? 'claude-agent-acp bundled · host auth detected' : 'claude-agent-acp bundled · run claude login or set ANTHROPIC_API_KEY')
        : 'Run Install.cmd to install @agentclientprotocol/claude-agent-acp',
      exe: claudeAdapter,
      args: [],
    },
    {
      id: 'agy',
      name: 'Antigravity',
      badge: 'AGY',
      available: Boolean(agyExe),
      hostConfigured: Boolean(agyExe),
      hint: agyExe ? 'Native agy acp runtime detected' : 'Install Antigravity CLI or set AGY_EXE_PATH',
      exe: agyExe,
      args: ['acp'],
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      badge: 'Gemini',
      available: Boolean(geminiExe),
      hostConfigured: geminiHostConfigured,
      hint: geminiExe ? 'Native gemini --acp detected' : 'Install @google/gemini-cli globally or set GEMINI_CLI_PATH',
      exe: geminiExe,
      args: ['--acp'],
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      badge: 'OpenCode',
      available: Boolean(opencodeExe),
      hostConfigured: Boolean(opencodeExe),
      hint: opencodeExe ? 'Native opencode acp detected' : 'Install OpenCode CLI or set OPENCODE_EXE_PATH',
      exe: opencodeExe,
      args: ['acp'],
    },
  ];
}

export function detectEngines(rootDir) {
  const specs = resolveSpecs(rootDir);
  if (process.env.AGY_USE_EXTERNAL_RELAY === '1') {
    specs.unshift({
      id: 'relay',
      name: 'External Relay',
      badge: 'Relay',
      available: true,
      hostConfigured: true,
      hint: 'External stdio-to-ws relay (AGY_USE_EXTERNAL_RELAY=1)',
      exe: '',
      args: [],
    });
  }
  const byId = new Map(specs.map(s => [s.id, s]));

  const explicit = String(process.env.LANCODE_DEFAULT_ENGINE || process.env.AGY_DEFAULT_ENGINE || '')
    .trim()
    .toLowerCase();

  let defaultEngine = '';
  if (explicit && byId.has(explicit) && byId.get(explicit).available) {
    defaultEngine = explicit;
  } else if (process.env.AGY_USE_EXTERNAL_RELAY === '1') {
    defaultEngine = 'relay';
  } else {
    for (const candidateId of ['agy', 'codex', 'claude', 'gemini', 'opencode']) {
      const sp = byId.get(candidateId);
      if (sp && sp.available && sp.hostConfigured) {
        defaultEngine = sp.id;
        break;
      }
    }
  }
  if (!defaultEngine) {
    const firstAvail = specs.find(s => s.available);
    defaultEngine = firstAvail ? firstAvail.id : 'codex';
  }

  return {
    engines: specs.map(({ id, name, badge, available, hostConfigured, hint }) => ({
      id,
      name,
      badge,
      available,
      hostConfigured,
      hint,
    })),
    defaultEngine,
  };
}

export function killProcessTree(child) {
  if (!child) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.unref();
    }
  } catch {}
  try { child.kill('SIGTERM'); } catch {}
}

export function shutdownAllEngines() {
  for (const [, entry] of sessions) {
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    try {
      if (entry.ws && entry.ws.readyState === 1) entry.ws.close();
    } catch {}
    killProcessTree(entry.child);
  }
  sessions.clear();
}

function normalizeOutboundToChild(rawText, user, rewritePayload) {
  let body = rawText.replace(/^Content-Length:\s*\d+\r?\n\r?\n/i, '');
  if (typeof rewritePayload === 'function') {
    body = rewritePayload(body, user);
  }
  const kept = [];
  for (const line of body.split('\n')) {
    const trimmed = line.replace(/\r$/, '').trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj && obj.method === '$/ping') continue;
      } catch {}
    }
    kept.push(trimmed);
  }
  if (kept.length === 0) return '';
  return kept.join('\n') + '\n';
}

function sendOrBuffer(entry, payload) {
  if (entry.ws && entry.ws.readyState === 1) {
    try {
      entry.ws.send(payload);
      return;
    } catch {}
  }
  entry.buffer.push(payload);
  if (entry.buffer.length > MAX_BUFFER_ITEMS) {
    entry.buffer.splice(0, entry.buffer.length - MAX_BUFFER_ITEMS);
  }
}

function bindClientWs(entry, ws, user, rewritePayload, gracePeriodMs, log) {
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
  }
  entry.ws = ws;

  ws.on('message', (data, isBinary) => {
    if (isBinary || entry.exited || !entry.child || !entry.child.stdin || entry.child.stdin.destroyed) return;
    const out = normalizeOutboundToChild(data.toString('utf8'), user, rewritePayload);
    if (!out) return;
    try {
      entry.child.stdin.write(out);
    } catch (e) {
      log(`ACP stdin write error (${entry.engineId}/${user.name}): ${e && e.message || e}`);
    }
  });

  ws.on('close', () => {
    if (entry.ws === ws) entry.ws = null;
    if (entry.exited) {
      sessions.delete(entry.key);
      return;
    }
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = setTimeout(() => {
      if (sessions.get(entry.key) === entry) {
        log(`ACP session idle cleanup (${entry.engineId}/${user.name}): ${entry.clientId}`);
        sessions.delete(entry.key);
        killProcessTree(entry.child);
      }
    }, gracePeriodMs);
  });

  ws.on('error', () => {});
}

function entryAlive(entry) {
  return Boolean(entry && entry.child && entry.child.exitCode === null);
}

export async function attachEngineSession({
  rootDir,
  engineId,
  clientId,
  user,
  ws,
  rewritePayload,
  gracePeriodMs = 600000,
  log = console.log,
}) {
  const specs = resolveSpecs(rootDir);
  const meta = detectEngines(rootDir);
  const reqId = String(engineId || '').trim().toLowerCase() || meta.defaultEngine;
  const spec = specs.find(s => s.id === reqId);

  if (!spec || !spec.available || !spec.exe) {
    const msg = spec
      ? `Engine "${spec.name}" is not available on host (${spec.hint})`
      : `Unknown ACP engine "${reqId}"`;
    try {
      ws.send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: msg } }) + '\n');
      ws.close(1011, 'Engine unavailable');
    } catch {}
    return;
  }

  const cid = String(clientId || '').trim() || randomUUID();
  const key = `${user.name}:${spec.id}:${cid}`;
  const existing = sessions.get(key);
  if (existing && !existing.exited && entryAlive(existing)) {
    bindClientWs(existing, ws, user, rewritePayload, gracePeriodMs, log);
    try {
      ws.send(JSON.stringify({ type: 'reconnect', clientId: cid, engine: spec.id }) + '\n');
      while (existing.buffer.length > 0 && ws.readyState === 1) {
        ws.send(existing.buffer.shift());
      }
    } catch {}
    log(`ACP reconnected (${spec.id}/${user.name}): ${cid}`);
    return;
  }

  // Buffer any early WS frames (e.g. immediate JSON-RPC initialize on open) while async proxy discovery runs
  const earlyMessages = [];
  let wsClosedEarly = false;
  const onEarlyMsg = (data, isBinary) => {
    if (!isBinary) earlyMessages.push(data.toString('utf8'));
  };
  const onEarlyClose = () => { wsClosedEarly = true; };
  ws.on('message', onEarlyMsg);
  ws.once('close', onEarlyClose);

  const proxy = await resolveProxy().catch(() => ({ url: '', source: 'direct' }));
  ws.off('message', onEarlyMsg);
  ws.off('close', onEarlyClose);
  if (wsClosedEarly || ws.readyState !== 1) return;

  const env = proxyEnvironment(process.env, proxy.url);
  const spawnSpec = buildSpawnSpec(spec.exe, spec.args);
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: user.root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
  });

  const entry = {
    key,
    engineId: spec.id,
    clientId: cid,
    child,
    ws,
    buffer: [],
    stdoutCarry: '',
    stderrCarry: '',
    cleanupTimer: null,
    exited: false,
  };
  sessions.set(key, entry);
  bindClientWs(entry, ws, user, rewritePayload, gracePeriodMs, log);

  try {
    ws.send(JSON.stringify({ type: 'connected', clientId: cid, engine: spec.id }) + '\n');
  } catch {}
  log(`ACP started (${spec.id}/${user.name}): ${cid} via ${path.basename(spec.exe)}`);

  for (const rawEarly of earlyMessages) {
    if (entry.exited || !child.stdin || child.stdin.destroyed) break;
    const out = normalizeOutboundToChild(rawEarly, user, rewritePayload);
    if (out) {
      try { child.stdin.write(out); } catch {}
    }
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    entry.stdoutCarry += chunk;
    // Strip any Content-Length header if emitted by a LanguageServer-framed binary
    entry.stdoutCarry = entry.stdoutCarry.replace(/(^|\n)Content-Length:\s*\d+\r?\n\r?\n/gi, '$1');
    let idx;
    while ((idx = entry.stdoutCarry.indexOf('\n')) !== -1) {
      const line = entry.stdoutCarry.slice(0, idx).replace(/\r$/, '').trim();
      entry.stdoutCarry = entry.stdoutCarry.slice(idx + 1);
      if (!line) continue;
      sendOrBuffer(entry, line + '\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    entry.stderrCarry += chunk;
    let idx;
    while ((idx = entry.stderrCarry.indexOf('\n')) !== -1) {
      const line = entry.stderrCarry.slice(0, idx).replace(/\r$/, '').trim();
      entry.stderrCarry = entry.stderrCarry.slice(idx + 1);
      if (line) log(`[${spec.id}/${user.name} stderr] ${line.slice(0, 400)}`);
    }
  });

  child.once('error', (err) => {
    entry.exited = true;
    sessions.delete(key);
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    log(`ACP spawn error (${spec.id}/${user.name}): ${err && err.message || err}`);
    try {
      if (entry.ws && entry.ws.readyState === 1) {
        entry.ws.send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32002, message: String(err && err.message || err) } }) + '\n');
        entry.ws.close(1011, 'Process error');
      }
    } catch {}
  });

  child.once('exit', (code, signal) => {
    entry.exited = true;
    const leftover = entry.stdoutCarry.replace(/\r$/, '').trim();
    if (leftover && !/^Content-Length:/i.test(leftover)) {
      sendOrBuffer(entry, leftover + '\n');
    }
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    sessions.delete(key);
    log(`ACP exited (${spec.id}/${user.name}): code=${code} signal=${signal || '-'}`);
    try {
      if (entry.ws && entry.ws.readyState === 1) {
        entry.ws.close(1000, 'Process exited');
      }
    } catch {}
  });
}
