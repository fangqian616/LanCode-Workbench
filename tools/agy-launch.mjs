// Generic Antigravity (agy CLI) launcher with automatic proxy & binary discovery.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SHARED_AGY = path.join(SCRIPT_DIR, 'agy-shared', 'agy.exe');

export function proxyUrl(value) {
  let text = String(value ?? '').trim();
  if (!text.includes('://') && text.includes('=')) {
    const entries = Object.fromEntries(text.split(';').map(s => {
      const [k, v] = s.trim().split(/=(.*)/s);
      return [k.toLowerCase(), v?.trim()];
    }));
    text = entries.https ?? entries.http ?? (entries.socks ? `socks5://${entries.socks}` : '');
  }
  if (!text) return '';
  if (!text.includes('://')) text = `http://${text}`;
  try {
    const u = new URL(text);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol) || !u.hostname) return '';
    return u.href.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function reachable(value) {
  let u;
  try { u = new URL(value); } catch { return Promise.resolve(false); }
  return new Promise(resolve => {
    const socket = net.createConnection({
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
    });
    let done = false;
    const finish = ok => { if (!done) { done = true; socket.destroy(); resolve(ok); } };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function proxyEnvironment(original, selected) {
  const env = { ...original };
  for (const key of Object.keys(env)) {
    if (/^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(key)) delete env[key];
  }
  if (selected) {
    env.HTTP_PROXY = selected;
    env.HTTPS_PROXY = selected;
    env.ALL_PROXY = selected;
  }
  const existing = original.NO_PROXY ?? original.no_proxy ?? '';
  env.NO_PROXY = [...new Set([...existing.split(',').filter(Boolean), 'localhost', '127.0.0.1', '::1', '.local'])].join(',');
  return env;
}

export async function resolveProxy() {
  const explicitRaw = String(process.env.AGY_PROXY_URL || '').trim();
  if (/^(off|direct|none)$/i.test(explicitRaw)) {
    return { url: '', source: 'AGY_PROXY_URL=off (direct)' };
  }
  if (explicitRaw) {
    const url = proxyUrl(explicitRaw);
    if (!url || !await reachable(url)) throw new Error(`Configured AGY_PROXY_URL is unreachable: ${explicitRaw}`);
    return { url, source: 'AGY_PROXY_URL' };
  }

  try {
    const query = "$p=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue; if($p){@{enabled=$p.ProxyEnable;server=$p.ProxyServer}|ConvertTo-Json -Compress}";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', query], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
    if (out) {
      const reg = JSON.parse(out);
      const sysUrl = proxyUrl(reg.server);
      if (reg.enabled === 1 && sysUrl && await reachable(sysUrl)) {
        return { url: sysUrl, source: 'Windows system proxy' };
      }
    }
  } catch {}

  for (const port of [10808, 10809, 7890, 7897, 1080, 2080, 8889, 8118, 3128]) {
    const url = `http://127.0.0.1:${port}`;
    if (await reachable(url)) return { url, source: `local proxy port ${port}` };
  }

  return { url: '', source: 'direct (no local proxy detected)' };
}

export function resolveAgyExecutable() {
  const candidates = [
    process.env.AGY_EXE_PATH,
    DEFAULT_SHARED_AGY,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : '',
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  try {
    const found = execFileSync('where.exe', ['agy'], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
      .split(/\r?\n/)
      .map(s => s.trim())
      .find(p => p && existsSync(p));
    if (found) return found;
  } catch {}
  return '';
}

export async function main(argv) {
  const target = argv.shift();
  if (!['cli', 'diagnose'].includes(target)) {
    throw new Error('Usage: agy-launch.mjs cli [agy arguments] | diagnose');
  }
  const selected = await resolveProxy();
  const env = proxyEnvironment(process.env, selected.url);
  const exe = resolveAgyExecutable();

  if (target === 'diagnose') {
    const args = ['-sS', '--max-time', '15', '-o', 'NUL', '-w', '%{http_code}'];
    args.push(...(selected.url ? ['--proxy', selected.url] : ['--noproxy', '*']), 'https://oauth2.googleapis.com/token');
    let code = '000';
    try {
      code = execFileSync('curl.exe', args, { encoding: 'utf8', env, windowsHide: true, timeout: 20000 }).trim();
    } catch {}
    console.log(JSON.stringify({
      source: selected.source,
      proxy: selected.url || '(direct)',
      agyExe: exe || '(not found)',
      oauthHttpStatus: code,
    }));
    return;
  }

  if (!exe) throw new Error('agy.exe not found in AGY_EXE_PATH, tools/agy-shared/agy.exe, %LOCALAPPDATA%\\agy\\bin\\agy.exe, or PATH.');
  const child = spawn(exe, argv, { env, stdio: 'inherit', windowsHide: false });
  child.once('error', err => { console.error(err.message); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(err => { console.error(err.message); process.exitCode = 1; });
}
