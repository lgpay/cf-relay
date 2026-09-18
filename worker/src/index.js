/**
 * CF Relay —— 通用 HTTP(S) 下载中转（Cloudflare Worker）
 *
 * 【一、链接形态】把原始直链包装成中转链接：
 *   1) 查询参数：  https://<worker>/?url=https%3A%2F%2Fexample.com%2Fa.zip
 *   2) 带文件名：  https://<worker>/dl/my%20file.zip?url=<encoded>
 *   3) 路径拼接：  https://<worker>/https://example.com/a.zip
 *   &mode=info   → 只探测，返回 JSON（HEAD 上游）
 *   GET /        → 操作页面，粘贴直链生成中转链接
 *
 * 【二、JSON API】自描述索引见 GET /api，全部返回 JSON：
 *   GET      /api         接口索引 + curl 示例（公开）
 *   GET      /api/health  存活 / 版本 / 是否需令牌（公开）
 *   GET      /api/config  当前策略：域名名单、大小上限、缓存 TTL……（需令牌）
 *   GET|POST /api/link    生成中转链接，支持批量；POST 可带 info:true 一并探测（需令牌）
 *   GET|POST /api/info    探测上游：大小 / 类型 / 是否支持 Range（需令牌）
 *   GET|POST /api/check   只做策略预检（域名黑白名单），不发上游请求（需令牌）
 *   鉴权三选一：?token=xxx / Authorization: Bearer xxx / X-API-Key: xxx
 *
 * 环境变量（全部可选，不配即用默认宽松策略）：
 *   TOKEN            访问令牌，命中后必须 ?token=xxx 或 Authorization: Bearer xxx
 *   ALLOW_HOSTS      白名单，逗号分隔，支持 *.github.com / .github.com 通配
 *   DENY_HOSTS       黑名单，同上（优先级高于白名单）
 *   ALLOW_PRIVATE    设为 "1" 放行内网/元数据地址（默认阻断，防 SSRF）
 *   UA               覆盖发往源站的 User-Agent
 *   REFERER          覆盖发往源站的 Referer
 *   UPSTREAM_HEADERS 追加到源站请求的头，JSON 字符串，如 {"Authorization":"Bearer x"}
 *   CACHE_TTL        边缘缓存秒数，0 或留空 = 不缓存（大文件建议保持 0）
 *   MAX_BYTES        单文件大小上限（字节），超出直接拒绝
 */

const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
];

const RELAY_VERSION = '1.1.0';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CF-Relay/1.0';
const API_MAX_BATCH = 50;              // 单次批量最多处理多少个 url
const API_MAX_BODY = 64 * 1024;        // POST 请求体上限

/** 业务异常：统一转成 JSON 错误响应 */
class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // JSON API 命名空间：独立分支，任何情况都返回 JSON，不做链接形态解析
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return await handleApi(request, env, url);
    }

    // 无参数访问根路径 → 返回生成中转链接的小页面
    if (request.method === 'GET' && url.pathname === '/' && !hasTargetParam(url)) {
      return new Response(homePage(), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // 必须显式 no-store：否则首页可能被边缘/浏览器缓存，
          // 在 cache key 忽略 query string 时，带 ?url= 的请求会拿到缓存的首页 HTML
          'cache-control': 'no-store, max-age=0',
          'x-relay-version': RELAY_VERSION,
          ...corsHeaders(),
        },
      });
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      return jsonError(405, 'only GET / HEAD are supported');
    }

    if (env.TOKEN && !checkToken(request, url, env.TOKEN)) {
      return jsonError(401, 'missing or invalid token');
    }

    let target;
    try {
      target = resolveTarget(url);
    } catch (e) {
      return jsonError(400, e.message || 'bad target url');
    }

    const guard = checkHost(target, env);
    if (guard) return jsonError(403, guard);

    if (url.searchParams.get('mode') === 'info') {
      return await probe(target, env, url);
    }

    return await relay(request, target, env, url);
  },
};

/* ---------------------------------- 工具 ---------------------------------- */

function hasTargetParam(url) {
  return ['url', 'u', 'q'].some((k) => url.searchParams.has(k));
}

function checkToken(request, url, token) {
  if (url.searchParams.get('token') === token) return true;
  if (request.headers.get('x-api-key') === token) return true;
  const auth = request.headers.get('authorization') || '';
  return auth === `Bearer ${token}`;
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-expose-headers':
      'content-length, content-range, accept-ranges, content-disposition, ' +
      'x-relay-target, x-relay-filename, x-relay-version',
    'access-control-max-age': '86400',
  };
}

function jsonError(status, message, code) {
  return new Response(
    JSON.stringify({ ok: false, error: true, status, code: code || httpCode(status), message }, null, 2),
    {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store, max-age=0',
        'x-relay-version': RELAY_VERSION,
        ...corsHeaders(),
      },
    },
  );
}

function httpCode(status) {
  return {
    400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED', 413: 'TOO_LARGE', 502: 'UPSTREAM_FAILED',
  }[status] || 'ERROR';
}

/** 从请求里还原出原始下载链接 */
function resolveTarget(url) {
  const raw = url.searchParams.get('url') || url.searchParams.get('u') || url.searchParams.get('q');
  if (raw) return normalizeUrl(raw);

  const m = url.pathname.match(/^\/https?:\/*(.+)$/i);
  if (m) {
    const scheme = url.pathname.toLowerCase().startsWith('/https:') ? 'https' : 'http';
    let rest = m[1];
    const extra = buildUpstreamQuery(url);
    return `${scheme}://${rest}${extra}`;
  }
  throw new Error('no target: use ?url=<encoded> or /https://host/path');
}

function normalizeUrl(raw) {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) {
    if (/^https?:\/*/i.test(s)) s = s.replace(/^https?:\/*/i, (mm) => mm.replace(/\/*$/, '://'));
    else s = 'https://' + s.replace(/^\/+/, '');
  }
  const u = new URL(s);
  return u.toString();
}

/** 路径拼接形态时，把 token/url/name 之外的 query 透传给源站 */
function buildUpstreamQuery(url) {
  const skip = new Set(['url', 'u', 'q', 'token', 'name', 'mode']);
  const sp = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (!skip.has(k)) sp.append(k, v);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function checkHost(target, env) {
  const host = new URL(target).hostname.toLowerCase();
  const deny = splitList(env.DENY_HOSTS);
  if (deny.length && matchHost(host, deny)) return `host denied: ${host}`;

  const allow = splitList(env.ALLOW_HOSTS);
  if (allow.length && !matchHost(host, allow)) return `host not in allow list: ${host}`;

  if (env.ALLOW_PRIVATE !== '1' && isPrivateHost(host)) return `private/loopback address blocked: ${host}`;
  return null;
}

function splitList(v) {
  return String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function matchHost(host, patterns) {
  for (const p of patterns) {
    if (p === host) return true;
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      if (host === base || host.endsWith('.' + base)) return true;
    } else if (p.startsWith('.')) {
      if (host.endsWith(p) || host === p.slice(1)) return true;
    } else if (host.endsWith('.' + p)) {
      return true;
    }
  }
  return false;
}

function isPrivateHost(host) {
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', '169.254.169.254',
       'metadata.google.internal', 'metadata.goog', '100.100.100.200'].includes(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (host.includes(':')) { // IPv6
    const h = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
    return false;
  }
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/* -------------------------------- 探测接口 -------------------------------- */

/** 探测上游文件信息；HEAD 被拒或拿不到大小时，用 Range: bytes=0-0 兜底 */
async function probeInfo(target, env, reqUrl, extraHeaders) {
  const base = buildUpstreamHeaders(extraHeaders || null, env, reqUrl);
  let info = null;
  let headOk = true;

  try {
    const up = await fetch(target, { method: 'HEAD', headers: base, redirect: 'follow' });
    if (up.status < 400) info = describeUpstream(target, reqUrl, up);
    else headOk = false;
  } catch (_) {
    headOk = false;
  }

  if (!info || info.content_length === null) {
    const h = new Headers(base);
    h.set('range', 'bytes=0-0');
    const up2 = await fetch(target, { method: 'GET', headers: h, redirect: 'follow' });
    const alt = describeUpstream(target, reqUrl, up2);
    if (up2.body) { try { await up2.body.cancel(); } catch (_) { /* 忽略 */ } }
    alt.size_source = up2.status === 206 ? 'content-range' : 'content-length';
    if (!info || alt.content_length !== null) info = alt;
  }

  if (!info) throw new Error('upstream did not answer HEAD or Range probe');
  info.head_supported = headOk;
  return info;
}

function describeUpstream(target, reqUrl, res) {
  const rawLen = (res.headers.get('content-length') || '').trim();
  let size = /^\d+$/.test(rawLen) ? Number(rawLen) : null;
  let rangeOk = (res.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');

  const cr = res.headers.get('content-range') || '';
  if (cr.includes('/')) {
    const total = cr.split('/').pop().trim();
    if (/^\d+$/.test(total)) { size = Number(total); rangeOk = true; }
  }

  return {
    url: target,
    final_url: res.url || target,
    status: res.status,
    ok: res.ok,
    content_length: size,
    size_human: humanSize(size),
    content_type: res.headers.get('content-type'),
    accept_ranges: res.headers.get('accept-ranges') || (cr ? 'bytes' : ''),
    supports_range: rangeOk,
    last_modified: res.headers.get('last-modified'),
    etag: res.headers.get('etag'),
    filename: guessName(target, res.headers.get('content-disposition'), reqUrl),
    size_source: /^\d+$/.test(rawLen) ? 'content-length' : null,
  };
}

/** 兼容旧接口：?url=<encoded>&mode=info 仍返回裸 info 对象 */
async function probe(target, env, reqUrl, extraHeaders) {
  return apiJson(await probeInfo(target, env, reqUrl, extraHeaders));
}

/* -------------------------------- 中转主体 -------------------------------- */

async function relay(request, target, env, reqUrl) {
  const reqHeaders = buildUpstreamHeaders(request, env, reqUrl);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: reqHeaders,
      redirect: 'follow',
    });
  } catch (e) {
    return jsonError(502, `upstream fetch failed: ${e.message}`);
  }

  const max = Number(env.MAX_BYTES || 0);
  const len = Number(upstream.headers.get('content-length') || 0);
  if (max > 0 && len > max) {
    return jsonError(413, `file too large: ${len} > ${max}`);
  }

  const headers = new Headers(upstream.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  headers.delete('set-cookie');
  headers.delete('set-cookie2');
  headers.set('accept-ranges', headers.get('accept-ranges') || 'bytes');
  headers.set('x-relay-target', target);
  headers.set('x-relay-version', RELAY_VERSION);
  headers.set('timing-allow-origin', '*');
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);

  const name = guessName(target, upstream.headers.get('content-disposition'), reqUrl);
  if (name) {
    headers.set('content-disposition', contentDisposition(name));
    headers.set('x-relay-filename', encodeURIComponent(name));
  }

  const ttl = Number(env.CACHE_TTL || 0);
  headers.set('cache-control', ttl > 0 ? `public, max-age=${ttl}` : 'no-store');

  const status = upstream.status;
  const body = status === 204 || status === 304 ? null : upstream.body;
  return new Response(body, { status, statusText: upstream.statusText, headers });
}

function buildUpstreamHeaders(request, env, reqUrl) {
  const h = new Headers();
  if (request) {
    for (const [k, v] of request.headers) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk.startsWith('cf-') || lk.startsWith('x-forwarded-') || lk === 'x-relay-target') continue;
      if (HOP_BY_HOP.includes(lk)) continue;
      h.set(k, v);
    }
  }
  // 强制 identity，保证 content-length 与 Range 语义一致
  h.set('accept-encoding', 'identity');
  if (env.UA) h.set('user-agent', env.UA);
  if (!h.has('user-agent')) h.set('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CF-Relay/1.0');
  if (env.REFERER) h.set('referer', env.REFERER);
  if (env.UPSTREAM_HEADERS) {
    try {
      const extra = JSON.parse(env.UPSTREAM_HEADERS);
      for (const [k, v] of Object.entries(extra)) h.set(k, v);
    } catch (_) { /* 配错就忽略 */ }
  }
  return h;
}

function guessName(targetUrl, disposition, reqUrl) {
  const override = reqUrl && (reqUrl.searchParams.get('name') || pathNameOverride(reqUrl));
  if (override) return safeName(override);

  if (disposition) {
    let m = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
    if (m) { try { return safeName(decodeURIComponent(m[1].trim())); } catch (_) {} }
    m = /filename\s*=\s*"([^"]+)"/i.exec(disposition) || /filename\s*=\s*([^;]+)/i.exec(disposition);
    if (m) {
      const n = m[1].trim().replace(/^"|"$/g, '');
      if (n && !/^\?*$/.test(n)) return safeName(n);
    }
  }

  try {
    const u = new URL(targetUrl);
    const base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (base && base.includes('.')) return safeName(base);
  } catch (_) {}
  return '';
}

function pathNameOverride(reqUrl) {
  const m = reqUrl.pathname.match(/^\/dl\/([^/]+)\/?$/);
  if (m) { try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; } }
  return '';
}

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 200) || 'download';
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/* --------------------------------- JSON API --------------------------------- */
/*
 * 与链接形态完全分离的一层：路径以 /api 开头就只走这里，永远返回 JSON，
 * 不会被 /https://... 那种路径拼接规则误吞。
 */

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '').toLowerCase() || '/api';
  const isRead = request.method === 'GET' || request.method === 'HEAD';
  const isWrite = request.method === 'POST';

  try {
    // 两个公开接口：客户端靠它判断"这个 Worker 要不要令牌"，不该被鉴权挡住
    if (path === '/api' || path === '/api/index' || path === '/api/docs') {
      if (!isRead) throw new ApiError(405, 'GET / HEAD only', 'METHOD_NOT_ALLOWED');
      return apiJson(apiIndex(url, env));
    }
    if (path === '/api/health') {
      if (!isRead) throw new ApiError(405, 'GET / HEAD only', 'METHOD_NOT_ALLOWED');
      return apiJson({
        ok: true,
        service: 'cf-relay',
        version: RELAY_VERSION,
        time: new Date().toISOString(),
        token_required: Boolean(env.TOKEN),
      });
    }

    if (env.TOKEN && !checkToken(request, url, env.TOKEN)) {
      throw new ApiError(401, 'missing or invalid token', 'UNAUTHORIZED');
    }

    switch (path) {
      case '/api/config':
        if (!isRead) throw new ApiError(405, 'GET / HEAD only', 'METHOD_NOT_ALLOWED');
        return apiJson(apiConfig(env));

      case '/api/link':
        if (!isRead && !isWrite) throw new ApiError(405, 'GET / HEAD / POST only', 'METHOD_NOT_ALLOWED');
        return await apiLink(request, env, url);

      case '/api/info':
      case '/api/probe':
        if (!isRead && !isWrite) throw new ApiError(405, 'GET / HEAD / POST only', 'METHOD_NOT_ALLOWED');
        return await apiInfo(request, env, url);

      case '/api/check':
        if (!isRead && !isWrite) throw new ApiError(405, 'GET / HEAD / POST only', 'METHOD_NOT_ALLOWED');
        return await apiCheck(request, env, url);

      default:
        throw new ApiError(404, `unknown endpoint: ${path}，可用接口见 ${url.origin}/api`, 'NOT_FOUND');
    }
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e.status, e.message, e.code);
    return jsonError(500, `api failed: ${(e && e.message) || e}`, 'INTERNAL_ERROR');
  }
}

/** 生成中转链接（不请求上游，纯计算） */
async function apiLink(request, env, reqUrl) {
  const p = await readApiParams(request, reqUrl);
  const items = p.urls.map((it) => buildLinkItem(it, p, env, reqUrl));

  if (p.info) {
    await Promise.all(items.map(async (item) => {
      if (!item.allowed) return;
      try { item.info = await probeInfo(item.source, env, reqUrl); }
      catch (e) { item.info = { error: String((e && e.message) || e) }; }
    }));
  }

  return apiJson({
    ok: true,
    version: RELAY_VERSION,
    count: items.length,
    allowed: items.filter((i) => i.allowed).length,
    items,
  });
}

/** 探测上游文件信息（会真实请求上游，HEAD 优先，必要时降级到 1 字节 Range） */
async function apiInfo(request, env, reqUrl) {
  const p = await readApiParams(request, reqUrl);
  const items = [];
  for (const it of p.urls) {
    const item = buildLinkItem(it, p, env, reqUrl);
    if (!item.allowed) {
      item.reason = item.reason || 'blocked by policy';
    } else {
      try { item.info = await probeInfo(item.source, env, reqUrl); }
      catch (e) { item.info = { error: String((e && e.message) || e) }; }
    }
    items.push(item);
  }
  return apiJson({ ok: true, version: RELAY_VERSION, count: items.length, items });
}

/** 只做策略预检：不发上游请求，也不返回 403 —— 把判断结果交给调用方 */
async function apiCheck(request, env, reqUrl) {
  const p = await readApiParams(request, reqUrl);
  const items = p.urls.map((it) => {
    const out = { source: it.url, allowed: false, host: '', reason: null };
    try {
      const target = normalizeUrl(it.url);
      out.source = target;
      out.host = new URL(target).hostname.toLowerCase();
      const guard = checkHost(target, env);
      out.allowed = !guard;
      out.reason = guard || null;
    } catch (e) {
      out.reason = `invalid url: ${(e && e.message) || e}`;
    }
    return out;
  });
  return apiJson({
    ok: true,
    version: RELAY_VERSION,
    count: items.length,
    allowed: items.filter((i) => i.allowed).length,
    items,
  });
}

/** 单条：给出中转链接 + 策略判定结果。注意即使用户域名被拦，也照样返回链接，由调用方决定 */
function buildLinkItem(it, p, env, reqUrl) {
  const item = {
    source: it.url, ok: false, allowed: false, reason: null,
    filename: '', relay_url: '', relay_url_short: '',
  };

  let target;
  try {
    target = normalizeUrl(it.url);
  } catch (e) {
    item.reason = `invalid url: ${(e && e.message) || e}`;
    return item;
  }
  item.source = target;

  const guard = checkHost(target, env);
  item.allowed = !guard;
  item.reason = guard || null;
  item.ok = item.allowed;

  const override = it.name || p.name || '';
  item.filename = override ? safeName(override) : guessName(target, null, null);
  item.relay_url = buildRelayUrl(reqUrl.origin, target, item.filename, p);
  item.relay_url_short = target.includes('#') ? '' : `${reqUrl.origin}/${target}`;
  return item;
}

function buildRelayUrl(origin, target, name, p) {
  const qs = new URLSearchParams();
  qs.set('url', target);
  // 默认不把令牌写进链接（会随日志/分享外泄），需要时显式 embed_token=1
  if (p && p.embed_token && p.token) qs.set('token', p.token);
  const base = name ? `${origin}/dl/${encodeURIComponent(name)}` : `${origin}/`;
  return `${base}?${qs.toString()}`;
}

/** 读取 GET query 与 POST JSON 体，统一成 { urls:[{url,name}], name, token, info, embed_token } */
async function readApiParams(request, reqUrl) {
  const on = (v) => ['1', 'true', 'yes', 'on'].includes(String(v == null ? '' : v).toLowerCase());
  const p = {
    urls: [],
    name: reqUrl.searchParams.get('name') || '',
    token: reqUrl.searchParams.get('token') || '',
    info: on(reqUrl.searchParams.get('info')),
    embed_token: on(reqUrl.searchParams.get('embed_token')),
  };

  // url / u / q 可重复出现，实现 GET 批量
  for (const k of ['url', 'u', 'q']) {
    for (const v of reqUrl.searchParams.getAll(k)) {
      if (v.trim()) p.urls.push({ url: v.trim(), name: '' });
    }
  }

  if (request.method === 'POST') {
    const raw = await readBody(request);
    if (raw.trim()) {
      let body;
      try { body = JSON.parse(raw); }
      catch (_) { throw new ApiError(400, 'request body is not valid JSON', 'BAD_JSON'); }
      if (Array.isArray(body)) body = { urls: body };
      if (!body || typeof body !== 'object') {
        throw new ApiError(400, 'body must be a JSON object or array', 'BAD_BODY');
      }
      const list = body.urls !== undefined ? body.urls : body.url;
      for (const it of (Array.isArray(list) ? list : [list])) {
        if (typeof it === 'string') {
          if (it.trim()) p.urls.push({ url: it.trim(), name: '' });
        } else if (it && typeof it === 'object' && it.url) {
          p.urls.push({ url: String(it.url).trim(), name: it.name ? String(it.name) : '' });
        }
      }
      if (body.name !== undefined) p.name = String(body.name);
      if (body.token !== undefined) p.token = String(body.token);
      if (body.info !== undefined) p.info = on(body.info);
      if (body.embed_token !== undefined) p.embed_token = on(body.embed_token);
    }
  }

  // 去重（保序）
  const seen = new Set();
  p.urls = p.urls.filter((it) => {
    const k = `${it.url}\u0000${it.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (!p.urls.length) {
    throw new ApiError(400, 'no target: 用 ?url=<encoded> 或 POST {"urls":[...]}', 'NO_TARGET');
  }
  if (p.urls.length > API_MAX_BATCH) {
    throw new ApiError(413, `too many urls: ${p.urls.length} > ${API_MAX_BATCH}`, 'TOO_MANY_URLS');
  }
  return p;
}

async function readBody(request) {
  const buf = await request.arrayBuffer();
  if (buf.byteLength > API_MAX_BODY) {
    throw new ApiError(413, `request body too large: ${buf.byteLength} > ${API_MAX_BODY}`, 'BODY_TOO_LARGE');
  }
  return new TextDecoder().decode(buf);
}

function apiConfig(env) {
  let upstreamHeaderKeys = [];
  if (env.UPSTREAM_HEADERS) {
    try { upstreamHeaderKeys = Object.keys(JSON.parse(env.UPSTREAM_HEADERS)); } catch (_) { /* 配错就忽略 */ }
  }
  return {
    ok: true,
    service: 'cf-relay',
    version: RELAY_VERSION,
    token_required: Boolean(env.TOKEN),
    allow_hosts: splitList(env.ALLOW_HOSTS),
    deny_hosts: splitList(env.DENY_HOSTS),
    allow_private: env.ALLOW_PRIVATE === '1',
    max_bytes: Number(env.MAX_BYTES || 0),
    cache_ttl: Number(env.CACHE_TTL || 0),
    user_agent: env.UA || DEFAULT_UA,
    referer: env.REFERER || '',
    upstream_header_keys: upstreamHeaderKeys, // 只暴露键名，不暴露值
    max_batch: API_MAX_BATCH,
    endpoints: ['/api', '/api/health', '/api/config', '/api/link', '/api/info', '/api/check'],
  };
}

/** 自描述索引：让调用方不用看文档也能知道怎么用 */
function apiIndex(reqUrl, env) {
  const o = reqUrl.origin;
  const E = encodeURIComponent;
  return {
    ok: true,
    service: 'cf-relay',
    version: RELAY_VERSION,
    description: '把 HTTP(S) 下载直链包装成 Cloudflare Worker 中转链接；中转链接本身即可直接下载，支持 Range 断点续传。',
    auth: {
      required: Boolean(env && env.TOKEN),
      methods: ['?token=xxx', 'Authorization: Bearer xxx', 'X-API-Key: xxx'],
      note: '/api 与 /api/health 始终公开，其余接口在 Worker 配置了 TOKEN 时才需要令牌',
    },
    max_batch: API_MAX_BATCH,
    endpoints: [
      {
        method: 'GET', path: '/api', auth: false,
        desc: '本索引。',
        example: `${o}/api`,
      },
      {
        method: 'GET', path: '/api/health', auth: false,
        desc: '存活检测：版本、时间、是否需令牌。',
        example: `${o}/api/health`,
      },
      {
        method: 'GET', path: '/api/config', auth: true,
        desc: '当前策略：域名黑白名单、大小上限、缓存 TTL、User-Agent 等。',
        example: `${o}/api/config`,
      },
      {
        method: 'GET / POST', path: '/api/link', auth: true,
        desc: '生成中转链接。GET 用重复的 url 参数批量，POST 用 {"urls":[...]}；加 info=true 会顺带探测。',
        example: `${o}/api/link?url=${E('https://example.com/a.zip')}`,
        example_post: `curl -X POST ${o}/api/link -H 'content-type: application/json' `
          + `-d '{"urls":["https://example.com/a.zip"],"info":true}'`,
      },
      {
        method: 'GET / POST', path: '/api/info', auth: true,
        desc: '探测上游：大小、类型、是否支持 Range、最终 URL（跟随 302 后）。',
        example: `${o}/api/info?url=${E('https://example.com/a.zip')}`,
      },
      {
        method: 'GET', path: '/api/check', auth: true,
        desc: '策略预检：只判断域名是否放行，不发上游请求，不返回 403。',
        example: `${o}/api/check?url=${E('https://example.com/a.zip')}`,
      },
    ],
    link_forms: {
      query: `${o}/?url=${E('https://example.com/a.zip')}`,
      with_name: `${o}/dl/${encodeURIComponent('a.zip')}?url=${E('https://example.com/a.zip')}`,
      path_join: `${o}/https://example.com/a.zip`,
      probe: `${o}/?url=${E('https://example.com/a.zip')}&mode=info`,
    },
    notes: [
      '中转链接与 API 共用同一套域名白/黑名单与 SSRF 防护，被拦时下载会得到 403 JSON。',
      'relay_url 默认不含令牌；需要「拿去就能打开」的链接时传 embed_token=1，令牌会被写进链接。',
      'Worker 转发时强制 Accept-Encoding: identity，因此 content_length 与实际字节数一致。',
    ],
  };
}

function apiJson(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-relay-version': RELAY_VERSION,
      ...corsHeaders(),
    },
  });
}

function humanSize(n) {
  if (!n || n <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.max(Math.floor(Math.log(n) / Math.log(1024)), 0), units.length - 1);
  return `${(n / 1024 ** i).toFixed(2)}${units[i]}`;
}

/* -------------------------------- 首页页面 -------------------------------- */

// 注意：下方用 String.raw 包裹，避免 HTML 内嵌 JS 的正则被模板字符串转义
function homePage() {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CF Relay · 下载链接中转</title>
<style>
  :root{
    --bg:#f5f6f7; --fg:#0c0d0f; --sub:#9aa0a6; --card:#ffffff;
    --line:#e8eaed; --solid:#111214; --solid-fg:#ffffff;
    --ico-bg:#eaf1ff; --ico-fg:#2f6fed;
    --shadow:0 1px 2px rgba(16,24,40,.05), 0 14px 34px rgba(16,24,40,.07);
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#0a0b0d; --fg:#f1f2f4; --sub:#8a9099; --card:#141619;
      --line:#282c31; --solid:#f1f2f4; --solid-fg:#0c0d0f;
      --ico-bg:#16233c; --ico-fg:#6ea8ff;
      --shadow:0 1px 2px rgba(0,0,0,.5), 0 18px 44px rgba(0,0,0,.45);
    }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased}
  main{max-width:800px;margin:0 auto;padding:96px 24px 72px}
  h1{margin:0 0 16px;font-size:46px;line-height:1.1;font-weight:700;letter-spacing:-.025em;text-align:center}
  .sub{margin:0 auto 60px;max-width:470px;text-align:center;color:var(--sub);font-size:14px;line-height:1.9}
  .bar{display:flex;align-items:center;gap:10px;background:var(--card);border-radius:14px;
    padding:10px 10px 10px 14px;box-shadow:var(--shadow);transition:box-shadow .18s}
  .bar:focus-within{box-shadow:inset 0 0 0 1.5px var(--ico-fg), var(--shadow)}
  @keyframes flash{
    0%{box-shadow:inset 0 0 0 1.5px var(--ico-fg), var(--shadow)}
    100%{box-shadow:var(--shadow)}
  }
  .bar.flash{animation:flash .9s ease-out}
  .ico{flex:none;width:30px;height:30px;border-radius:8px;background:var(--ico-bg);color:var(--ico-fg);
    display:flex;align-items:center;justify-content:center}
  input{flex:1;min-width:0;border:0;background:transparent;color:var(--fg);font:inherit;font-size:14.5px;
    padding:12px 2px;outline:none}
  input::placeholder{color:var(--sub)}
  button{flex:none;display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13.5px;
    cursor:pointer;border-radius:10px;padding:11px 16px;border:1px solid transparent;
    white-space:nowrap;transition:opacity .15s,border-color .15s}
  .solid{background:var(--solid);color:var(--solid-fg);border-color:var(--solid)}
  .solid:hover{opacity:.86}
  .ghost{background:var(--card);color:var(--fg);border-color:var(--line)}
  .ghost:hover{border-color:var(--sub)}
  kbd{font:11px/1 ui-monospace,Consolas,monospace;color:var(--sub);border:1px solid var(--line);
    border-radius:5px;padding:3px 5px;margin-left:2px}
  .foot{margin-top:34px;text-align:center;color:var(--sub);font-size:12px;line-height:2.1}
  .foot code{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;background:var(--card);
    border:1px solid var(--line);border-radius:5px;padding:2px 6px;color:var(--fg);word-break:break-all}
  .foot a{color:inherit;text-underline-offset:2px;text-decoration-color:var(--line)}
  .foot a:hover{color:var(--fg);text-decoration-color:currentColor}
  .adv{margin-top:26px}
  .adv summary{list-style:none;cursor:pointer;color:var(--sub);font-size:12px;text-align:center}
  .adv summary::-webkit-details-marker{display:none}
  .adv[open] summary{margin-bottom:12px}
  .adv .bar{padding:4px 10px 4px 14px;box-shadow:none;border:1px solid var(--line);margin-bottom:8px}
  .adv .bar input{font-size:13px;padding:9px 2px}
  .toast{position:fixed;left:50%;bottom:36px;transform:translate(-50%,20px);opacity:0;
    background:var(--solid);color:var(--solid-fg);font-size:13px;padding:9px 16px;border-radius:10px;
    transition:.25s;pointer-events:none}
  .toast.on{opacity:1;transform:translate(-50%,0)}
  @media (max-width:560px){
    main{padding:64px 16px 56px}
    h1{font-size:36px}
    .sub{margin-bottom:40px}
  }
</style>
</head>
<body>
<main>
  <h1>CF Relay</h1>
  <p class="sub">把下载直链交给 Cloudflare 边缘节点中转，换一条更稳定的链接。支持 Range 断点续传，可直接打开或复制分享。</p>

  <div class="bar" id="bar">
    <span class="ico">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M4 21h16"></path>
      </svg>
    </span>
    <input id="src" placeholder="粘贴下载直链，自动生成中转链接…" autocomplete="off" spellcheck="false" autofocus>
    <button class="solid" id="open">打开 ↗</button>
    <button class="ghost" id="copy">复制 <kbd id="kc">Ctrl C</kbd></button>
  </div>

  <details class="adv">
    <summary>高级选项</summary>
    <div class="bar"><input id="name" placeholder="指定保存的文件名，如 setup.exe（留空则按源站推断）" autocomplete="off"></div>
    <div class="bar"><input id="token" placeholder="访问令牌，仅当 Worker 配置了 TOKEN 时才需要" autocomplete="off"></div>
  </details>

  <p class="foot">
    也可以在地址栏直接拼接：<code id="eg"></code><br>
    <span id="api" hidden>程序化调用：<a id="apilink" href="/api">JSON API</a>
      <code>/api/link</code> <code>/api/info</code> <code>/api/check</code></span>
    <span id="note" hidden>当前是本地预览，域名是占位符；部署到 Cloudflare 后会自动换成你自己的 Worker 域名</span>
    <span id="ready" hidden>输入即生成中转链接 · 支持 Range 断点续传 · 大文件建议用 cfget.py 多线程下载</span>
  </p>
</main>
<div class="toast" id="toast">已复制</div>

<script>
(function(){
  var IS_FILE = location.protocol === 'file:';
  var RELAY = (IS_FILE ? 'https://cf-relay.demo.workers.dev' : location.origin).replace(/\/+$/, '');

  var $ = function(id){ return document.getElementById(id); };
  var src = $('src'), nameI = $('name'), tokenI = $('token');
  var bar = $('bar'), toastEl = $('toast'), tmr = null, rawCache = '';

  $('kc').textContent = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? '\u2318C' : 'Ctrl C';
  $('eg').textContent = RELAY + '/https://example.com/file.zip';
  $('note').hidden = !IS_FILE;
  $('ready').hidden = IS_FILE;
  $('api').hidden = IS_FILE;
  $('apilink').setAttribute('href', RELAY + '/api');

  function toast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(tmr);
    tmr = setTimeout(function(){ toastEl.classList.remove('on'); }, 1400);
  }

  // 已经是我们自己的代理链接就不再二次包装
  function isRelayed(s){
    return s.indexOf(RELAY + '/') === 0 && s.indexOf('url=') > -1;
  }

  function build(raw){
    var n = nameI.value.trim(), t = tokenI.value.trim();
    var u = RELAY + (n ? '/dl/' + encodeURIComponent(n) : '/') + '?url=' + encodeURIComponent(raw);
    if (t) u += '&token=' + encodeURIComponent(t);
    return u;
  }

  // 就地转换：输入原始链接 -> 框内直接变成代理链接
  function convert(animate){
    var v = src.value.trim();
    if (!v){ rawCache = ''; src.removeAttribute('title'); return ''; }
    if (isRelayed(v)) return v;

    rawCache = v;
    var out = build(v);
    src.value = out;
    src.setAttribute('title', '\u539f\u59cb\u94fe\u63a5\uff1a' + v);
    try { src.setSelectionRange(out.length, out.length); } catch (e) {}
    if (animate){
      bar.classList.remove('flash');
      void bar.offsetWidth;
      bar.classList.add('flash');
    }
    return out;
  }

  function finalUrl(){
    var v = src.value.trim();
    if (!v) return '';
    return isRelayed(v) ? v : convert(false);
  }

  var debounce = null;
  src.addEventListener('input', function(){
    clearTimeout(debounce);
    debounce = setTimeout(function(){ convert(true); }, 220);
  });
  src.addEventListener('paste', function(){
    clearTimeout(debounce);
    setTimeout(function(){ convert(true); }, 0);
  });
  src.addEventListener('keydown', function(e){
    if (e.key === 'Enter'){ e.preventDefault(); clearTimeout(debounce); convert(true); }
  });
  src.addEventListener('blur', function(){
    clearTimeout(debounce);
    convert(false);
  });

  // 参数变化 -> 用缓存的原始链接重新生成，避免在代理链接上套娃
  function rebuild(){
    if (!rawCache) return;
    var out = build(rawCache);
    src.value = out;
    src.setAttribute('title', '\u539f\u59cb\u94fe\u63a5\uff1a' + rawCache);
  }
  nameI.addEventListener('input', rebuild);
  tokenI.addEventListener('input', rebuild);

  function copyText(text){
    if (navigator.clipboard && navigator.clipboard.writeText){
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function(resolve, reject){
      try {
        src.select();
        var ok = document.execCommand('copy');
        src.setSelectionRange(text.length, text.length);
        ok ? resolve() : reject(new Error('execCommand failed'));
      } catch (e) { reject(e); }
    });
  }

  $('open').addEventListener('click', function(){
    var v = finalUrl();
    if (!v){ toast('请先粘贴下载直链'); src.focus(); return; }
    window.open(v, '_blank', 'noopener');
  });

  $('copy').addEventListener('click', function(){
    var v = finalUrl();
    if (!v){ toast('请先粘贴下载直链'); src.focus(); return; }
    copyText(v).then(function(){
      toast('中转链接已复制');
      var btn = $('copy'), old = btn.innerHTML;
      btn.textContent = '已复制';
      setTimeout(function(){ btn.innerHTML = old; }, 1200);
    }).catch(function(){ toast('复制失败，请手动选中后复制'); });
  });

  document.addEventListener('keydown', function(e){
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); $('open').click(); }
  });
})();
</script>
</body>
</html>`;
}
