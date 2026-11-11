import { getStore } from '@netlify/blobs';
import { randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Netlify Functions 版墙面 API。
 *
 * 和 Node 版的区别：
 *   data/wall.json      →  Netlify Blobs（跨部署持久化）
 *   Server-Sent Events  →  不支持长连接，前端改为 4 秒轮询
 *   常驻进程限流         →  每个函数实例内存中的 best-effort 限流
 *
 * 所有接口都挂在这个函数的 /api/* 路径下，避免 Netlify 的重定向改写
 * 丢掉 POST body。
 */

const STORE_NAME = 'who-came-wall';
const WALL_KEY = 'prints';
const MAX_BODY_BYTES = 8192;
const STYLES = new Set(['cat', 'dog', 'bear', 'rainbow']);
const INKS = new Set(['soot', 'cinnabar', 'indigo', 'moss', 'ochre']);

const MAX_PRINTS = intEnv('MAX_PRINTS', 240, 20, 1000);
const STAMP_COOLDOWN_MS = intEnv('STAMP_COOLDOWN_MS', 1000, 0, 60000);
const POLL_MS = intEnv('POLL_MS', 8000, 2500, 60000);
const CLEAR_PASSWORD = process.env.CLEAR_PASSWORD || '114514';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const lastStampAt = new Map();
const clearAttempts = new Map();
let writeChain = Promise.resolve();
let strongConsistencyUnavailable = false;

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

function httpError(status, message, headers = {}) {
  const error = new Error(message);
  error.status = status;
  error.headers = headers;
  return error;
}

function methodNotAllowed(allow) {
  return json(
    { error: 'method_not_allowed', message: '不支持这个请求方法。' },
    405,
    { Allow: allow }
  );
}

function errorResponse(error) {
  const status = Number.isInteger(error && error.status) ? error.status : 500;
  if (status >= 500) {
    console.error('Netlify wall API error:', error && error.stack ? error.stack : error);
  }
  const message = status >= 500
    ? '墙那边出了点小状况，稍后再试。'
    : (error && error.message ? error.message : '请求没有完成。');
  return json({
    error: status === 429 ? 'rate_limited' : 'request_failed',
    message
  }, status, error && error.headers ? error.headers : {});
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a == null ? '' : a));
  const right = Buffer.from(String(b == null ? '' : b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function clientKey(request) {
  const raw = request.headers.get('x-nf-client-connection-ip')
    || request.headers.get('x-forwarded-for')
    || '';
  return raw.split(',')[0].trim() || 'unknown';
}

function assertSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return;

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch (error) {
    throw httpError(403, '请求来源不可信。');
  }

  const candidates = new Set();
  try {
    candidates.add(new URL(request.url).host);
  } catch (error) {
    /* URL 解析失败就只比 Host 头 */
  }
  const hostHeader = request.headers.get('host');
  if (hostHeader) candidates.add(hostHeader);

  if (!candidates.has(originHost)) {
    throw httpError(403, '请求来源不可信。');
  }
}

async function readJsonBody(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw httpError(415, '请用 JSON 提交这枚爪印。');
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw httpError(413, '爪印太大了。');
  }
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw httpError(400, '这一页爪印没有读懂。');
  }
}

/* ------------------------------------------------------------------ *
 * 爪印数据
 * ------------------------------------------------------------------ */

function readName(raw) {
  const value = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(value).slice(0, 12).join('');
}

function cleanName(raw) {
  return readName(raw) || '无名氏';
}

function numeric(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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

function normalizeList(list) {
  const seen = new Set();
  return list
    .map(normalizeStoredPrint)
    .filter((print) => {
      if (!print || seen.has(print.id)) return false;
      seen.add(print.id);
      return true;
    })
    .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
}

function buildPrint(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, '爪印的格式不对。');
  }
  const name = readName(body.n);
  if (!name) throw httpError(400, '请先写下名字。');
  if (!STYLES.has(body.s)) throw httpError(400, '请选择一种爪型。');
  if (!INKS.has(body.c)) throw httpError(400, '请选择一种墨色。');

  const x = Number(body.x);
  const y = Number(body.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw httpError(400, '没有找到落爪的位置。');
  }

  return {
    id: randomUUID(),
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

function wallStore(consistency) {
  return getStore({ name: STORE_NAME, consistency });
}

async function readStoredPrints() {
  let data;
  if (strongConsistencyUnavailable) {
    data = await wallStore('eventual').get(WALL_KEY, { type: 'json' });
  } else {
    try {
      data = await wallStore('strong').get(WALL_KEY, {
        type: 'json',
        consistency: 'strong'
      });
    } catch (error) {
      if (!error || error.name !== 'BlobsConsistencyError') throw error;
      strongConsistencyUnavailable = true;
      console.warn('Netlify Blobs strong consistency unavailable; falling back to eventual reads.');
      data = await wallStore('eventual').get(WALL_KEY, { type: 'json' });
    }
  }
  if (!data) return [];
  const source = Array.isArray(data)
    ? data
    : (Array.isArray(data.prints) ? data.prints : []);
  if (!source.length) return [];
  return normalizeList(source).slice(-MAX_PRINTS);
}

async function writeStoredPrints(prints) {
  await wallStore('eventual').setJSON(WALL_KEY, prints);
}

function withLock(task) {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => {});
  return run;
}

/* ------------------------------------------------------------------ *
 * 限流
 * ------------------------------------------------------------------ */

function checkStampCooldown(request) {
  if (STAMP_COOLDOWN_MS <= 0) return;
  const key = clientKey(request);
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

function checkClearAttempts(request) {
  const key = clientKey(request);
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

/* ------------------------------------------------------------------ *
 * 路由与处理
 * ------------------------------------------------------------------ */

async function listPrints() {
  const prints = await readStoredPrints();
  return json({
    prints,
    count: prints.length,
    max: MAX_PRINTS,
    backend: 'netlify',
    serverTime: Date.now()
  });
}

async function createPrint(request) {
  assertSameOrigin(request);
  const body = await readJsonBody(request);
  checkStampCooldown(request);

  return withLock(async () => {
    const existing = await readStoredPrints();
    const print = buildPrint(body);
    const appended = existing.concat(print);
    const removed = appended.length > MAX_PRINTS
      ? appended.slice(0, appended.length - MAX_PRINTS)
      : [];
    const next = appended.slice(-MAX_PRINTS);

    await writeStoredPrints(next);
    return json({
      print,
      removed: removed.map((item) => item.id),
      count: next.length,
      max: MAX_PRINTS,
      backend: 'netlify',
      serverTime: Date.now()
    }, 201);
  });
}

async function clearWithPassword(request) {
  assertSameOrigin(request);
  const body = await readJsonBody(request);
  checkClearAttempts(request);

  const provided = body && typeof body === 'object' ? body.password : '';
  if (!safeEqual(provided, CLEAR_PASSWORD)) {
    return json({ error: 'unauthorized', message: '密码不正确。' }, 401);
  }

  clearAttempts.delete(clientKey(request));
  await withLock(async () => {
    await writeStoredPrints([]);
  });
  return json({ ok: true, count: 0, backend: 'netlify' });
}

async function clearWithAdminToken(request) {
  if (!ADMIN_TOKEN) {
    return json({ error: 'admin_disabled', message: '管理员清墙功能未开启。' }, 403);
  }
  const provided = request.headers.get('authorization') || '';
  if (!safeEqual(provided, `Bearer ${ADMIN_TOKEN}`)) {
    return json({ error: 'unauthorized', message: '管理员口令不正确。' }, 401);
  }

  await withLock(async () => {
    await writeStoredPrints([]);
  });
  return json({ ok: true, count: 0, backend: 'netlify' });
}

function configResponse() {
  return json({
    live: false,
    pollMs: POLL_MS,
    max: MAX_PRINTS,
    backend: 'netlify',
    serverTime: Date.now()
  });
}

function requestPath(request) {
  const pathname = new URL(request.url).pathname;
  const functionPrefix = '/.netlify/functions/api';
  if (pathname === functionPrefix) return '/api';
  if (pathname.startsWith(`${functionPrefix}/`)) {
    return `/api${pathname.slice(functionPrefix.length)}`;
  }
  return pathname;
}

async function route(request) {
  const path = requestPath(request);
  const method = request.method || 'GET';

  if (path === '/api/config') {
    if (method !== 'GET') return methodNotAllowed('GET');
    return configResponse();
  }

  if (path === '/api/events') {
    if (method !== 'GET') return methodNotAllowed('GET');
    // Netlify Functions 不适合长连接 SSE；前端会读取 /api/config 后改走轮询。
    return new Response(null, {
      status: 204,
      headers: { 'Cache-Control': 'no-store' }
    });
  }

  if (path === '/api/prints') {
    if (method === 'GET') return listPrints();
    if (method === 'POST') return createPrint(request);
    return methodNotAllowed('GET, POST');
  }

  if (path === '/api/clear') {
    if (method !== 'POST') return methodNotAllowed('POST');
    return clearWithPassword(request);
  }

  if (path === '/api/admin/clear') {
    if (method !== 'POST') return methodNotAllowed('POST');
    return clearWithAdminToken(request);
  }

  return json({ error: 'not_found', message: '没有这个接口。' }, 404);
}

export default async (request) => {
  try {
    return await route(request);
  } catch (error) {
    return errorResponse(error);
  }
};

export const config = {
  path: '/api/*',
  method: ['GET', 'POST']
};
