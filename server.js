'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PORT = integerEnv('PORT', 3000, 1, 65535);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const DATA_FILE = path.join(DATA_DIR, 'wall.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const CLEAR_PASSWORD = process.env.CLEAR_PASSWORD || '114514';
const MAX_PRINTS = integerEnv('MAX_PRINTS', 240, 20, 1000);
const STAMP_COOLDOWN_MS = integerEnv('STAMP_COOLDOWN_MS', 1000, 0, 60000);
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
const MAX_BODY_BYTES = 8192;

const STYLES = new Set(['cat', 'dog', 'bear', 'rainbow']);
const INKS = new Set(['soot', 'cinnabar', 'indigo', 'moss', 'ochre']);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': CSP
};

const ASSET_SPECS = [
  ['/', 'index.html', 'text/html; charset=utf-8', 'no-store'],
  ['/index.html', 'index.html', 'text/html; charset=utf-8', 'no-store'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8', 'no-cache'],
  ['/assets/graduation-notice.mp3', 'assets/graduation-notice.mp3', 'audio/mpeg', 'public, max-age=86400']
];

// 背景音乐是可选的：上传失败或漏传时，墙本身仍应能启动。
const OPTIONAL_ASSET_ROUTES = new Set(['/assets/graduation-notice.mp3']);

const assets = new Map();
const sseClients = new Set();
const lastStampAt = new Map();
const clearAttempts = new Map();

let prints = [];
let writeChain = Promise.resolve();
let storeLock = Promise.resolve();
let shuttingDown = false;

function integerEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function numeric(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function readName(raw) {
  const value = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(value).slice(0, 12).join('');
}

function cleanName(raw) {
  // 读旧数据时才需要"无名氏"兜底；新写入必须带名字。
  return readName(raw) || '无名氏';
}

function normalizeStoredPrint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 80) : '';
  const timestamp = Number(raw.t);
  if (!id || !Number.isFinite(timestamp)) return null;
  return {
    id,
    n: cleanName(raw.n),
    s: STYLES.has(raw.s) ? raw.s : 'cat',
    c: INKS.has(raw.c) ? raw.c : 'soot',
    x: clamp(numeric(raw.x, 50), 8, 92),
    y: clamp(numeric(raw.y, 50), 16, 80),
    z: Math.round(clamp(numeric(raw.z, 68), 56, 82)),
    r: clamp(numeric(raw.r, 0), -11, 11),
    t: timestamp
  };
}

function buildPrint(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, '爪印的格式不对。');
  }
  const name = readName(body.n);
  if (!name) {
    throw httpError(400, '请先写下名字。');
  }
  if (!STYLES.has(body.s)) {
    throw httpError(400, '请选择一种爪型。');
  }
  if (!INKS.has(body.c)) {
    throw httpError(400, '请选择一种墨色。');
  }
  const x = Number(body.x);
  const y = Number(body.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw httpError(400, '没有找到落爪的位置。');
  }
  return {
    id: crypto.randomUUID(),
    n: name,
    s: body.s,
    c: body.c,
    x: clamp(x, 8, 92),
    y: clamp(y, 16, 80),
    z: Math.round(58 + Math.random() * 23),
    r: Number((-9 + Math.random() * 18).toFixed(2)),
    t: Date.now()
  };
}

function httpError(status, message, headers = {}) {
  const error = new Error(message);
  error.status = status;
  error.headers = headers;
  return error;
}

function withStoreLock(task) {
  const run = storeLock.then(task, task);
  storeLock = run.catch(() => {});
  return run;
}

function persist() {
  const snapshot = JSON.stringify({ version: 1, prints }, null, 2);
  const tempFile = `${DATA_FILE}.${process.pid}.tmp`;
  const run = writeChain.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(tempFile, snapshot, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempFile, DATA_FILE);
  });
  writeChain = run.catch(() => {});
  return run;
}

async function loadStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
      await fs.rename(DATA_FILE, backup).catch(() => {});
      console.error(`Wall data was invalid JSON. Moved it to ${backup} and started with an empty wall.`);
      parsed = null;
    }

    if (parsed) {
      const source = Array.isArray(parsed)
        ? parsed
        : (parsed && Array.isArray(parsed.prints) ? parsed.prints : []);
      const seen = new Set();
      const normalized = source
        .map(normalizeStoredPrint)
        .filter((print) => {
          if (!print || seen.has(print.id)) return false;
          seen.add(print.id);
          return true;
        })
        .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
      prints = normalized.slice(-MAX_PRINTS);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // Rewriting once at boot both normalizes the file and verifies that the data
  // directory is writable before the server starts accepting prints.
  await persist();
}

async function loadAssets() {
  for (const [route, fileName, type, cache] of ASSET_SPECS) {
    try {
      const body = await fs.readFile(path.join(ROOT, fileName));
      assets.set(route, { body, type, cache });
    } catch (error) {
      if (OPTIONAL_ASSET_ROUTES.has(route)) {
        console.warn(
          `Optional asset unavailable: ${fileName} (${error.code || error.message}). `
          + 'The wall will still start; background music will be disabled.'
        );
        continue;
      }
      throw error;
    }
  }
}

function clientAddress(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const first = forwarded.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(req) {
  if (STAMP_COOLDOWN_MS <= 0) return;
  const key = clientAddress(req);
  const now = Date.now();
  const previous = lastStampAt.get(key) || 0;
  const elapsed = now - previous;
  if (elapsed < STAMP_COOLDOWN_MS) {
    const retryAfter = Math.max(1, Math.ceil((STAMP_COOLDOWN_MS - elapsed) / 1000));
    throw httpError(429, '爪印按得有点急，等一秒再试。', { 'Retry-After': String(retryAfter) });
  }
  lastStampAt.set(key, now);

  if (lastStampAt.size > 5000) {
    for (const [address, timestamp] of lastStampAt) {
      if (now - timestamp > 10 * 60 * 1000) lastStampAt.delete(address);
    }
  }
}

function isClearPassword(value) {
  const provided = Buffer.from(String(value == null ? '' : value));
  const expected = Buffer.from(CLEAR_PASSWORD);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function checkClearAttempts(req) {
  const key = clientAddress(req);
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxAttempts = 8;
  let record = clearAttempts.get(key);
  if (!record || now > record.reset) {
    record = { count: 0, reset: now + windowMs };
    clearAttempts.set(key, record);
  }
  record.count += 1;
  if (record.count > maxAttempts) {
    const retryAfter = Math.max(1, Math.ceil((record.reset - now) / 1000));
    throw httpError(429, '密码试得太多，请稍后再试。', { 'Retry-After': String(retryAfter) });
  }

  if (clearAttempts.size > 5000) {
    for (const [address, attempt] of clearAttempts) {
      if (now > attempt.reset) clearAttempts.delete(address);
    }
  }
}

async function addPrint(req, body) {
  return withStoreLock(async () => {
    const print = buildPrint(body);
    checkRateLimit(req);
    const previous = prints;
    const appended = previous.concat(print);
    const removedPrints = appended.length > MAX_PRINTS
      ? appended.slice(0, appended.length - MAX_PRINTS)
      : [];
    prints = appended.slice(-MAX_PRINTS);

    try {
      await persist();
    } catch (error) {
      prints = previous;
      console.error('Could not persist the wall:', error);
      throw httpError(500, '爪印没能保存下来，稍后再试。');
    }

    return {
      print,
      removed: removedPrints.map((item) => item.id),
      count: prints.length,
      max: MAX_PRINTS,
      serverTime: Date.now()
    };
  });
}

async function clearWall() {
  return withStoreLock(async () => {
    if (prints.length === 0) {
      return { count: 0 };
    }
    const previous = prints;
    prints = [];
    try {
      await persist();
    } catch (error) {
      prints = previous;
      console.error('Could not clear the wall:', error);
      throw httpError(500, '清墙没有保存成功，稍后再试。');
    }
    return { count: 0 };
  });
}

function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const provided = req.headers.authorization || '';
  const expected = `Bearer ${ADMIN_TOKEN}`;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch (error) {
    throw httpError(403, '请求来源不可信。');
  }
  if (!req.headers.host || originHost !== req.headers.host) {
    throw httpError(403, '请求来源不可信。');
  }
}

function readJsonBody(req) {
  const contentType = req.headers['content-type'] || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw httpError(415, '请用 JSON 提交这枚爪印。');
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(httpError(413, '爪印太大了。'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = raw ? JSON.parse(raw) : {};
        resolve(parsed);
      } catch (error) {
        reject(httpError(400, '这一页爪印没有读懂。'));
      }
    });

    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length),
    ...extraHeaders
  });
  res.end(body);
}

function sendText(res, status, text, extraHeaders = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length),
    ...extraHeaders
  });
  res.end(body);
}

function parseByteRange(value, total) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value || '').trim());
  if (!match) return null;
  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  if (!hasStart && !hasEnd) return null;

  let start;
  let end;
  if (!hasStart) {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = hasEnd ? Number(match[2]) : total - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= total || start > end) {
      return { invalid: true };
    }
    end = Math.min(end, total - 1);
  }

  return { start, end };
}

function serveAsset(req, res, asset) {
  const total = asset.body.length;
  const range = req.headers.range ? parseByteRange(req.headers.range, total) : null;
  const baseHeaders = {
    ...SECURITY_HEADERS,
    'Content-Type': asset.type,
    'Cache-Control': asset.cache,
    'Accept-Ranges': 'bytes'
  };

  if (range && range.invalid) {
    res.writeHead(416, {
      ...baseHeaders,
      'Content-Range': `bytes */${total}`,
      'Content-Length': '0'
    });
    res.end();
    return;
  }

  if (range) {
    const chunk = asset.body.subarray(range.start, range.end + 1);
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${range.start}-${range.end}/${total}`,
      'Content-Length': String(chunk.length)
    });
    if (req.method === 'HEAD') res.end();
    else res.end(chunk);
    return;
  }

  res.writeHead(200, {
    ...baseHeaders,
    'Content-Length': String(total)
  });
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(asset.body);
  }
}

function sendSseEvent(res, event, payload) {
  const data = JSON.stringify(payload);
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch (error) {
      sseClients.delete(client);
    }
  }
}

function handleSse(req, res) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 4000\n\n');
  sseClients.add(res);
  sendSseEvent(res, 'ready', { count: prints.length });

  req.on('close', () => {
    sseClients.delete(res);
  });
}

async function handleRequest(req, res) {
  const method = req.method || 'GET';
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (error) {
    sendJson(res, 400, { error: 'bad_request', message: '请求地址不对。' });
    return;
  }

  if (url.pathname === '/healthz' && (method === 'GET' || method === 'HEAD')) {
    sendText(res, 200, 'ok\n');
    return;
  }

  if (url.pathname === '/api/config') {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed', message: '只支持 GET。' }, { Allow: 'GET' });
      return;
    }
    sendJson(res, 200, {
      live: true,
      pollMs: 30000,
      max: MAX_PRINTS,
      backend: 'node',
      serverTime: Date.now()
    });
    return;
  }

  if (url.pathname === '/api/prints') {
    if (method === 'GET') {
      sendJson(res, 200, {
        prints,
        count: prints.length,
        max: MAX_PRINTS,
        serverTime: Date.now()
      });
      return;
    }

    if (method === 'POST') {
      assertSameOrigin(req);
      const body = await readJsonBody(req);
      const result = await addPrint(req, body);
      broadcast('stamp', result);
      sendJson(res, 201, result);
      return;
    }

    sendJson(res, 405, { error: 'method_not_allowed', message: '不支持这个请求方法。' }, { Allow: 'GET, POST' });
    return;
  }

  if (url.pathname === '/api/events') {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed', message: '不支持这个请求方法。' }, { Allow: 'GET' });
      return;
    }
    handleSse(req, res);
    return;
  }

  if (url.pathname === '/api/clear') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed', message: '只支持 POST。' }, { Allow: 'POST' });
      return;
    }
    assertSameOrigin(req);
    const body = await readJsonBody(req);
    checkClearAttempts(req);
    const providedPassword = body && typeof body === 'object' ? body.password : '';
    if (!isClearPassword(providedPassword)) {
      sendJson(res, 401, { error: 'unauthorized', message: '密码不正确。' });
      return;
    }
    clearAttempts.delete(clientAddress(req));
    const result = await clearWall();
    broadcast('clear', { count: 0, serverTime: Date.now() });
    sendJson(res, 200, { ok: true, count: result.count });
    return;
  }

  if (url.pathname === '/api/admin/clear') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed', message: '只支持 POST。' }, { Allow: 'POST' });
      return;
    }
    if (!ADMIN_TOKEN) {
      sendJson(res, 403, { error: 'admin_disabled', message: '管理员清墙功能未开启。' });
      return;
    }
    if (!isAdmin(req)) {
      sendJson(res, 401, { error: 'unauthorized', message: '管理员口令不正确。' });
      return;
    }
    const result = await clearWall();
    broadcast('clear', { count: 0, serverTime: Date.now() });
    sendJson(res, 200, { ok: true, count: result.count });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' });
    return;
  }

  const asset = assets.get(url.pathname);
  if (asset) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed\n', { Allow: 'GET, HEAD' });
      return;
    }
    serveAsset(req, res, asset);
    return;
  }

  sendText(res, 404, '没有这面墙。\n');
}

function errorResponse(res, error) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const status = Number.isInteger(error && error.status) ? error.status : 500;
  if (status >= 500) {
    console.error(error);
  }
  const message = status >= 500
    ? '墙那边出了点小状况，稍后再试。'
    : (error && error.message ? error.message : '请求没有完成。');
  sendJson(res, status, {
    error: status === 429 ? 'rate_limited' : 'request_failed',
    message
  }, error && error.headers ? error.headers : {});
}

async function main() {
  await loadAssets();
  await loadStore();

  if (ADMIN_TOKEN && ADMIN_TOKEN.length < 12) {
    console.warn('ADMIN_TOKEN is short. Use a long random value in production.');
  }
  if (CLEAR_PASSWORD === '114514') {
    console.warn('CLEAR_PASSWORD is the default "114514". Change it before exposing the wall publicly.');
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      errorResponse(res, error);
    });
  });

  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 65000;

  const pingTimer = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': ping\n\n');
      } catch (error) {
        sseClients.delete(client);
      }
    }
  }, 20000);
  pingTimer.unref();

  server.listen(PORT, HOST, () => {
    console.log(`Who Came Wall listening on http://${HOST}:${PORT}`);
    console.log(`Wall data: ${DATA_FILE}`);
    console.log(`Admin clear: ${ADMIN_TOKEN ? 'enabled' : 'disabled (set ADMIN_TOKEN to enable)'}`);
    console.log(
      'Background music: '
      + (assets.has('/assets/graduation-notice.mp3')
        ? 'enabled'
        : 'missing (wall still works, music disabled)')
    );
  });

  server.on('error', (error) => {
    console.error('HTTP server error:', error);
    process.exitCode = 1;
  });

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal}: closing the wall...`);
    clearInterval(pingTimer);
    for (const client of sseClients) {
      try {
        client.end();
      } catch (error) {
        /* already closed */
      }
    }
    sseClients.clear();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Could not start the wall:', error);
  const code = error && error.code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    console.error(
      'Hint: the data or asset directory is not writable. '
      + 'Point DATA_DIR at a writable persistent directory and check file permissions.'
    );
  } else if (code === 'ENOENT') {
    console.error(
      'Hint: a required file is missing. Deploy index.html, app.js and the assets/ directory together.'
    );
  }
  process.exit(1);
});
