'use strict';

/**
 * Who Came Wall — Cloudflare Workers + Durable Objects 版本。
 *
 * 和 Node 版的对应关系：
 *   Node server.js              →  src/index.js（Worker 路由）
 *   data/wall.json              →  Durable Object 的 storage（单实例、串行写入）
 *   sseClients: Set<res>        →  Wall 里的 streams: Set<{controller}>
 *   进程内 Map 限流              →  Durable Object 内 Map（对象被回收即清空）
 *
 * 单实例语义由 Durable Object 本身保证：所有写请求都进入同一个对象，
 * 天然串行，不需要分布式锁。
 */

const MAX_BODY_BYTES = 8192;
const STREAM_PING_MS = 20000;
const STORAGE_KEY = 'prints';
const WALL_OBJECT_NAME = 'wall';
const CLIENT_IP_HEADER = 'x-wall-client-ip';

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

const encoder = new TextEncoder();

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function numeric(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function intEnv(raw, fallback, min, max) {
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
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

function normalizePrint(raw) {
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
    .map(normalizePrint)
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

function timingSafeEqual(a, b) {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * 响应
 * ------------------------------------------------------------------ */

function withSecurityHeaders(response) {
  // 只加安全头，响应体原样透传：Content-Type / Content-Encoding / Content-Length
  // 都保留，避免和实际字节对不上。
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

function text(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

function errorResponse(error) {
  const status = Number.isInteger(error && error.status) ? error.status : 500;
  if (status >= 500) {
    console.error(error && error.stack ? error.stack : error);
  }
  const message = status >= 500
    ? '墙那边出了点小状况，稍后再试。'
    : (error && error.message ? error.message : '请求没有完成。');
  return json({
    error: status === 429 ? 'rate_limited' : 'request_failed',
    message
  }, status, error && error.headers ? error.headers : {});
}

/* ------------------------------------------------------------------ *
 * 请求解析
 * ------------------------------------------------------------------ */

async function readJsonBody(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw httpError(415, '请用 JSON 提交这枚爪印。');
  }

  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw httpError(413, '爪印太大了。');
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

/**
 * 只接受同源提交。浏览器会带上 Origin，服务端伪造 Origin 无法阻止，
 * 但这里的目标是挡住第三方网页发起的跨站写入。
 */
function assertSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return;

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch (error) {
    throw httpError(403, '请求来源不可信。');
  }

  // 请求经过 Worker 转发到 Durable Object 后，URL 和 Host 头哪个被改写都不一定，
  // 两个都认；两者都由服务端/浏览器填入，客户端脚本改不了 Host。
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

/* ------------------------------------------------------------------ *
 * Durable Object：整面墙的唯一真相
 * ------------------------------------------------------------------ */

export class Wall {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.prints = [];
    this.streams = new Set();
    this.lastStampAt = new Map();
    this.clearAttempts = new Map();
    this.pingTimer = null;
    this.writeQueue = Promise.resolve();

    this.maxPrints = intEnv(env.MAX_PRINTS, 240, 20, 1000);
    this.cooldownMs = intEnv(env.STAMP_COOLDOWN_MS, 1000, 0, 60000);
    this.adminToken = typeof env.ADMIN_TOKEN === 'string' ? env.ADMIN_TOKEN.trim() : '';
    this.clearPassword = typeof env.CLEAR_PASSWORD === 'string' && env.CLEAR_PASSWORD.trim()
      ? env.CLEAR_PASSWORD
      : '114514';

    // 阻塞式加载：在读完存储之前，对象不会处理任何请求。
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get(STORAGE_KEY);
      const list = Array.isArray(stored) ? stored : [];
      this.prints = normalizeList(list).slice(-this.maxPrints);
    });
  }

  /* -------------------------- 路由 -------------------------- */

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method || 'GET';

    try {
      if (path === '/api/config') {
        if (method !== 'GET') {
          return json(
            { error: 'method_not_allowed', message: '只支持 GET。' },
            405,
            { Allow: 'GET' }
          );
        }
        return json({
          live: true,
          pollMs: 30000,
          max: this.maxPrints,
          backend: 'cloudflare',
          serverTime: Date.now()
        });
      }

      if (path === '/api/prints') {
        if (method === 'GET') return this.listPrints();
        if (method === 'POST') return await this.createPrint(request);
        return json(
          { error: 'method_not_allowed', message: '不支持这个请求方法。' },
          405,
          { Allow: 'GET, POST' }
        );
      }

      if (path === '/api/events') {
        if (method !== 'GET') {
          return json(
            { error: 'method_not_allowed', message: '不支持这个请求方法。' },
            405,
            { Allow: 'GET' }
          );
        }
        return this.openStream(request);
      }

      if (path === '/api/clear') {
        if (method !== 'POST') {
          return json(
            { error: 'method_not_allowed', message: '只支持 POST。' },
            405,
            { Allow: 'POST' }
          );
        }
        return await this.clearWallWithPassword(request);
      }

      if (path === '/api/admin/clear') {
        if (method !== 'POST') {
          return json(
            { error: 'method_not_allowed', message: '只支持 POST。' },
            405,
            { Allow: 'POST' }
          );
        }
        return await this.clearWall(request);
      }

      return json({ error: 'not_found', message: '没有这个接口。' }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  }

  listPrints() {
    return json({
      prints: this.prints,
      count: this.prints.length,
      max: this.maxPrints,
      serverTime: Date.now()
    });
  }

  /* -------------------------- 写爪印 -------------------------- */

  async createPrint(request) {
    assertSameOrigin(request);
    const body = await readJsonBody(request);

    const result = await this.withLock(async () => {
      const print = buildPrint(body);
      this.checkRateLimit(request);

      const previous = this.prints;
      const appended = previous.concat(print);
      const overflow = appended.length > this.maxPrints
        ? appended.slice(0, appended.length - this.maxPrints)
        : [];
      const next = appended.slice(-this.maxPrints);

      try {
        await this.state.storage.put(STORAGE_KEY, next);
      } catch (error) {
        console.error('Could not persist the wall:', error);
        throw httpError(500, '爪印没能保存下来，稍后再试。');
      }

      this.prints = next;
      return {
        print,
        removed: overflow.map((item) => item.id),
        count: next.length,
        max: this.maxPrints,
        serverTime: Date.now()
      };
    });

    this.broadcast('stamp', result);
    return json(result, 201);
  }

  async clearWall(request) {
    if (!this.adminToken) {
      return json({ error: 'admin_disabled', message: '管理员清墙功能未开启。' }, 403);
    }

    const provided = request.headers.get('authorization') || '';
    if (!timingSafeEqual(provided, `Bearer ${this.adminToken}`)) {
      return json({ error: 'unauthorized', message: '管理员口令不正确。' }, 401);
    }

    const result = await this.emptyWall();
    this.broadcast('clear', { count: 0, serverTime: Date.now() });
    return json({ ok: true, count: result.count });
  }

  async clearWallWithPassword(request) {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    this.checkClearAttempts(request);

    const provided = body && typeof body === 'object' ? body.password : '';
    if (!timingSafeEqual(String(provided == null ? '' : provided), this.clearPassword)) {
      return json({ error: 'unauthorized', message: '密码不正确。' }, 401);
    }

    this.clearAttempts.delete(request.headers.get(CLIENT_IP_HEADER) || 'unknown');
    const result = await this.emptyWall();
    this.broadcast('clear', { count: 0, serverTime: Date.now() });
    return json({ ok: true, count: result.count });
  }

  async emptyWall() {
    return this.withLock(async () => {
      const previous = this.prints;
      if (previous.length === 0) return { count: 0 };

      try {
        await this.state.storage.put(STORAGE_KEY, []);
      } catch (error) {
        console.error('Could not clear the wall:', error);
        throw httpError(500, '清墙没有保存成功，稍后再试。');
      }

      this.prints = [];
      return { count: 0 };
    });
  }

  /* -------------------------- 限流 -------------------------- */

  checkRateLimit(request) {
    if (this.cooldownMs <= 0) return;

    const key = request.headers.get(CLIENT_IP_HEADER) || 'unknown';
    const now = Date.now();
    const previous = this.lastStampAt.get(key) || 0;
    const elapsed = now - previous;

    if (elapsed < this.cooldownMs) {
      const retryAfter = Math.max(1, Math.ceil((this.cooldownMs - elapsed) / 1000));
      throw httpError(429, '爪印按得有点急，等一秒再试。', { 'Retry-After': String(retryAfter) });
    }

    this.lastStampAt.set(key, now);

    if (this.lastStampAt.size > 5000) {
      for (const [address, timestamp] of this.lastStampAt) {
        if (now - timestamp > 10 * 60 * 1000) this.lastStampAt.delete(address);
      }
    }
  }

  checkClearAttempts(request) {
    const key = request.headers.get(CLIENT_IP_HEADER) || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxAttempts = 8;

    let record = this.clearAttempts.get(key);
    if (!record || now > record.reset) {
      record = { count: 0, reset: now + windowMs };
      this.clearAttempts.set(key, record);
    }
    record.count += 1;

    if (record.count > maxAttempts) {
      const retryAfter = Math.max(1, Math.ceil((record.reset - now) / 1000));
      throw httpError(429, '密码试得太多，请稍后再试。', { 'Retry-After': String(retryAfter) });
    }

    if (this.clearAttempts.size > 5000) {
      for (const [address, attempt] of this.clearAttempts) {
        if (now > attempt.reset) this.clearAttempts.delete(address);
      }
    }
  }

  /* -------------------------- 实时推送 -------------------------- */

  openStream(request) {
    let stream = null;

    const body = new ReadableStream({
      start: (controller) => {
        stream = { controller, closed: false };
        this.streams.add(stream);
        this.startPing();

        controller.enqueue(encoder.encode('retry: 4000\n\n'));
        controller.enqueue(sseFrame('ready', { count: this.prints.length }));
      },
      cancel: () => {
        this.dropStream(stream);
      }
    });

    if (request.signal) {
      request.signal.addEventListener('abort', () => this.dropStream(stream), { once: true });
    }

    return new Response(body, {
      status: 200,
      headers: {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no'
      }
    });
  }

  broadcast(event, payload) {
    if (this.streams.size === 0) return;

    let chunk;
    try {
      chunk = sseFrame(event, payload);
    } catch (error) {
      console.error('Could not serialize a wall event:', error);
      return;
    }

    for (const stream of [...this.streams]) {
      if (stream.closed) continue;
      try {
        stream.controller.enqueue(chunk);
      } catch (error) {
        this.dropStream(stream);
      }
    }
  }

  dropStream(stream) {
    if (!stream || stream.closed) return;
    stream.closed = true;
    this.streams.delete(stream);

    try {
      stream.controller.close();
    } catch (error) {
      /* 客户端已经断开，流早就关闭了。 */
    }

    if (this.streams.size === 0) this.stopPing();
  }

  startPing() {
    if (this.pingTimer !== null) return;
    this.pingTimer = setInterval(() => {
      if (this.streams.size === 0) {
        this.stopPing();
        return;
      }
      for (const stream of [...this.streams]) {
        if (stream.closed) continue;
        try {
          stream.controller.enqueue(encoder.encode(': ping\n\n'));
        } catch (error) {
          this.dropStream(stream);
        }
      }
    }, STREAM_PING_MS);
  }

  stopPing() {
    if (this.pingTimer === null) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /* -------------------------- 串行写入 -------------------------- */

  withLock(task) {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => {});
    return run;
  }
}

/* ------------------------------------------------------------------ *
 * Worker：路由 + 静态资源
 * ------------------------------------------------------------------ */

function sseFrame(event, payload) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function proxyToWall(request) {
  const headers = new Headers(request.headers);
  // 覆盖客户端可能伪造的同名头，只用边缘节点写入的真实来源 IP。
  headers.set(CLIENT_IP_HEADER, request.headers.get('cf-connecting-ip') || '');
  return new Request(request, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/healthz') {
      return text('ok\n');
    }

    if (path === '/api' || path.startsWith('/api/')) {
      const id = env.WALL.idFromName(WALL_OBJECT_NAME);
      const stub = env.WALL.get(id);
      try {
        const response = await stub.fetch(proxyToWall(request));
        return withSecurityHeaders(response);
      } catch (error) {
        return errorResponse(error);
      }
    }

    // 其余全部交给静态资源（index.html、app.js）。
    const response = await env.ASSETS.fetch(request);
    return withSecurityHeaders(response);
  }
};
