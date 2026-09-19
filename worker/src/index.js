/**
 * CF Relay —— 通用 HTTP(S) 下载中转（Cloudflare Worker）
 *
 * 【一、链接形态】把原始直链包装成中转链接：
 *   1) 路径拼接（推荐）：https://<worker>/https://example.com/a.zip
 *        —— 域名后面直接接原始直链，页面上「打开 / 复制」默认产出的就是这种
 *   2) 查询参数：  https://<worker>/?url=https%3A%2F%2Fexample.com%2Fa.zip
 *        —— 原始链接自带 query 且命中保留字（url/u/q/token/name/mode）时自动回退到这种
 *   3) 指定文件名：https://<worker>/dl/my%20file.zip?url=<encoded>
 *        —— 也可以给上面两种形态追加 ?name=<文件名>
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

/** Worker 自己占用的 query 参数名：路径拼接形态下会从透传里剥掉 */
const RESERVED_KEYS = new Set(['url', 'u', 'q', 'token', 'name', 'mode']);

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
      target = resolveTarget(url, env);
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
function resolveTarget(url, env) {
  const raw = url.searchParams.get('url') || url.searchParams.get('u') || url.searchParams.get('q');
  if (raw) return normalizeUrl(raw);

  // 路径拼接形态：https://<worker>/https://host/path —— 域名后面直接接原始直链
  const m = url.pathname.match(/^\/https?:\/*(.+)$/i);
  if (m) {
    const scheme = url.pathname.toLowerCase().startsWith('/https:') ? 'https' : 'http';
    const rest = m[1];
    const extra = buildUpstreamQuery(url, env);
    return `${scheme}://${rest}${extra}`;
  }
  throw new Error('no target: use /https://host/path or ?url=<encoded>');
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

/**
 * 路径拼接形态时，把 Worker 自己占用的参数之外的部分透传给源站。
 *
 * 注意：路径拼接形态下无法区分"我们的 token"与"源站自己的 token"，所以
 * 只在 Worker 真的配了 TOKEN 时才剥掉它 —— 否则源站自己的 ?token= 会被误吞。
 * name 始终是我们用于覆盖文件名的参数；源站若也需要同名参数，请改用 ?url= 形态。
 */
function buildUpstreamQuery(url, env) {
  const skip = new Set(['url', 'u', 'q', 'name', 'mode']);
  if (env && env.TOKEN) skip.add('token');
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
    filename: '', relay_url: '', relay_url_query: '', link_form: '',
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

  // 附加参数：文件名覆盖、可选内嵌令牌
  const extra = [];
  if (override) extra.push(['name', item.filename]);
  if (p && p.embed_token && p.token) extra.push(['token', p.token]);

  // 默认走路径拼接形态（域名后面直接接原始直链）；源站自带保留参数时回退到 ?url= 形态
  const reserved = targetQueryHasReservedKey(target);
  item.link_form = reserved ? 'query' : 'path';
  item.relay_url = reserved
    ? queryForm(reqUrl.origin, target, extra)
    : pathForm(reqUrl.origin, target, extra);
  item.relay_url_query = queryForm(reqUrl.origin, target, extra);
  return item;
}

/** 目标链接自带的 query 命中 Worker 保留字，路径拼接形态会把它吃掉 */
function targetQueryHasReservedKey(target) {
  const qi = target.indexOf('?');
  if (qi === -1) return false;
  const q = target.slice(qi + 1).split('#')[0];
  return q.split('&').some((kv) => kv && RESERVED_KEYS.has(kv.split('=')[0].toLowerCase()));
}

/** 路径拼接形态：域名后面直接接原始直链 */
function pathForm(origin, target, extra) {
  return `${origin}/${target}${appendQuery(extra, true)}`;
}

/** ?url= 形态：参数全在 url 里编码，绝不与源站参数冲突 */
function queryForm(origin, target, extra) {
  return `${origin}/?url=${encodeURIComponent(target)}${appendQuery(extra, false)}`;
}

function appendQuery(extra, startsQuery) {
  if (!extra.length) return '';
  const s = extra.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${startsQuery ? '?' : '&'}${s}`;
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
        desc: '生成中转链接，默认路径拼接形态（域名后面直接接原始直链）。GET 用重复的 url 参数批量，'
          + 'POST 用 {"urls":[...]}；加 info=true 会顺带探测。',
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
      path_join: `${o}/https://example.com/a.zip`,
      with_name: `${o}/https://example.com/a.zip?name=a.zip`,
      query: `${o}/?url=${E('https://example.com/a.zip')}`,
      probe: `${o}/https://example.com/a.zip?mode=info`,
    },
    notes: [
      '推荐路径拼接形态：域名后面直接接原始直链，如 ' + `${o}/https://example.com/a.zip` + '；'
        + '仅当原始链接自带的 query 命中保留字（url/u/q/token/name/mode）时，才会带上 ?url= 形式。',
      '路径拼接形态下，源站自己的 ?token= 只在 Worker 配置了 TOKEN 时才会被当作访问令牌而剥掉；'
        + '若源站依赖这几个保留参数名，请用 relay_url_query。',
      '被域名黑白名单拦下时，relay_url 仍会返回，只在 allowed / reason 里标注；'
        + '真正下载才会得到 403 JSON。',
      'relay_url 默认不含令牌；需要「拿去就能打开」的链接时传 embed_token=1。',
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
<meta name="color-scheme" content="light dark">
<title>CF Relay · 下载链接中转</title>
<style>
  :root{
    --bg:#f6f7f9; --fg:#0b0c0e; --fg-2:#3f444b; --sub:#6b7178; --card:#ffffff;
    --line:#e7e9ee; --line2:#f1f2f5;
    --solid-a:#1d2025; --solid-b:#0a0b0d; --solid-fg:#ffffff;
    --accent:#4f7cff; --accent-2:#8f6cff;
    --ico-bg:linear-gradient(150deg,#eaf1ff,#f2ecff); --ico-fg:#3f6bff;
    --glow-1:rgba(79,124,255,.17); --glow-2:rgba(143,108,255,.13);
    --soft:rgba(16,24,40,.035);
    --shadow:0 1px 1px rgba(16,24,40,.04),0 10px 24px -8px rgba(16,24,40,.10),0 30px 60px -26px rgba(16,24,40,.20);
    --ring:0 0 0 4px rgba(79,124,255,.14);
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#08090b; --fg:#f0f1f4; --fg-2:#c3c8d0; --sub:#9aa0a9; --card:#131519;
      --line:#272b31; --line2:#1b1e23;
      --solid-a:#f5f6f8; --solid-b:#d9dbe0; --solid-fg:#0b0c0e;
      --accent:#6d95ff; --accent-2:#a98cff;
      --ico-bg:linear-gradient(150deg,#16233c,#221a3d); --ico-fg:#7fa7ff;
      --glow-1:rgba(79,124,255,.20); --glow-2:rgba(143,108,255,.16);
      --soft:rgba(255,255,255,.04);
      --shadow:0 1px 1px rgba(0,0,0,.5),0 14px 30px -10px rgba(0,0,0,.55),0 40px 80px -30px rgba(0,0,0,.6);
      --ring:0 0 0 4px rgba(109,149,255,.18);
    }
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{
    margin:0;color:var(--fg);
    background:
      radial-gradient(880px 420px at 50% -180px,var(--glow-1),transparent 70%),
      radial-gradient(700px 340px at 88% -80px,var(--glow-2),transparent 72%),
      radial-gradient(620px 320px at 6% -40px,rgba(70,200,215,.10),transparent 72%),
      var(--bg);
    background-attachment:fixed;
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  ::selection{background:rgba(79,124,255,.22)}
  /* sticky footer：main 撑满一屏并纵向分栏，页脚靠 margin-top:auto 吸底。
     内容比一屏长时退回普通文档流，页脚跟在末尾，不会盖住内容。
     底部留白从 main 的 padding 挪到这里的 44px —— 否则页脚会被顶到离底边 80px 处悬空 */
  main{max-width:760px;margin:0 auto;padding:92px 24px 44px;
    min-height:100vh;min-height:100dvh;
    display:flex;flex-direction:column}

  @keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
  .mark,h1,.sub,.bar,.result,.chips,.adv,.foot{animation:rise .62s cubic-bezier(.22,.86,.28,1) both}
  .mark{animation-delay:.02s} h1{animation-delay:.07s} .sub{animation-delay:.12s}
  .bar{animation-delay:.17s} .result{animation-delay:.22s} .chips{animation-delay:.27s}
  .adv{animation-delay:.32s} .foot{animation-delay:.37s}
  @media (prefers-reduced-motion:reduce){
    *{animation:none !important;transition:none !important}
  }

  .mark{width:56px;height:56px;margin:0 auto 26px;border-radius:17px;
    background:linear-gradient(140deg,#5b83ff,#8f6cff);color:#fff;
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 10px 22px -8px rgba(79,124,255,.55),0 2px 6px rgba(16,24,40,.10)}
  /* padding-bottom 用来撑开「背景绘制区」：background-clip:text 只在 padding box 内取色，
     而 line-height:1.1 的盒高(50.6px)小于字体行高(ascent 50 + descent 12)，y 的降部落在盒外
     → 那几像素没有颜色可裁，直接透明（Segoe UI 实测被裁 4.7px）。预留 .15em，
     同时把 margin 减掉等量，保证与副标题的间距不变 */
  h1{margin:0 0 11px;padding-bottom:.15em;font-size:46px;line-height:1.1;font-weight:700;letter-spacing:-.03em;text-align:center;
    background:linear-gradient(180deg,var(--fg),var(--fg-2));
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:var(--fg)}
  .sub{margin:0 auto 44px;max-width:498px;text-align:center;color:var(--sub);font-size:14.5px;line-height:1.88}

  .bar{display:flex;align-items:center;gap:11px;background:var(--card);border-radius:18px;
    padding:11px 11px 11px 16px;border:1px solid var(--line2);box-shadow:var(--shadow);
    transition:box-shadow .22s cubic-bezier(.22,.86,.28,1),border-color .22s}
  .bar:hover{border-color:var(--line)}
  .bar:focus-within{border-color:transparent;box-shadow:var(--ring),var(--shadow)}
  @keyframes flash{
    0%{box-shadow:var(--ring),var(--shadow)}
    100%{box-shadow:var(--shadow)}
  }
  .bar.flash{animation:flash .9s ease-out}
  .ico{flex:none;width:34px;height:34px;border-radius:11px;background:var(--ico-bg);color:var(--ico-fg);
    display:flex;align-items:center;justify-content:center}
  input{flex:1;min-width:0;border:0;background:transparent;color:var(--fg);font:inherit;font-size:14.5px;
    padding:12px 2px;outline:none}
  input::placeholder{color:var(--sub)}
  button{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;
    font-size:13.5px;font-weight:500;cursor:pointer;border-radius:12px;padding:11px 16px;
    border:1px solid transparent;white-space:nowrap;
    transition:transform .16s,box-shadow .18s,border-color .18s,background-color .18s,opacity .16s}
  .solid{background:linear-gradient(180deg,var(--solid-a),var(--solid-b));color:var(--solid-fg);
    box-shadow:0 1px 2px rgba(16,24,40,.16),0 6px 14px -6px rgba(16,24,40,.36)}
  .solid:hover{transform:translateY(-1px);box-shadow:0 2px 4px rgba(16,24,40,.18),0 10px 20px -8px rgba(16,24,40,.42)}
  .solid:active{transform:translateY(0);box-shadow:0 1px 2px rgba(16,24,40,.2)}
  .ghost{background:transparent;color:var(--fg);border-color:var(--line)}
  .ghost:hover{border-color:var(--sub);background:var(--soft)}
  .ghost:active{transform:translateY(1px)}
  kbd{font:11px/1 ui-monospace,Consolas,monospace;color:var(--sub);background:var(--soft);
    border:1px solid var(--line);border-radius:6px;padding:3px 5px;margin-left:1px}
  .ghost:hover kbd{color:var(--fg)}

  .result{margin:16px 2px 0;padding:13px 16px;border-radius:15px;border:1px solid var(--line);
    background:var(--card);box-shadow:var(--shadow)}
  .result[hidden]{display:none}
  .out-label{display:block;color:var(--accent);font-size:11px;font-weight:600;letter-spacing:.07em;
    margin-bottom:7px}
  .result code{display:block;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;
    line-height:1.75;color:var(--fg);word-break:break-all}

  .chips{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:22px}
  .chip{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;color:var(--sub);
    padding:5px 11px;border-radius:999px;border:1px solid var(--line);background:var(--card)}
  .chip::before{content:"";width:5px;height:5px;border-radius:50%;
    background:linear-gradient(140deg,var(--accent),var(--accent-2));flex:none}

  .adv{margin-top:30px}
  .adv summary{list-style:none;cursor:pointer;color:var(--sub);font-size:12px;text-align:center;
    width:max-content;margin:0 auto;padding:6px 14px;border-radius:999px;border:1px solid transparent;
    transition:color .18s,border-color .18s,background-color .18s}
  .adv summary:hover{color:var(--fg);border-color:var(--line);background:var(--card)}
  .adv summary::-webkit-details-marker{display:none}
  .adv[open] summary{margin-bottom:14px}
  .adv .bar{padding:2px 10px 2px 14px;box-shadow:none;border:1px solid var(--line);margin-bottom:9px;
    border-radius:13px;background:var(--card)}
  .adv .bar:focus-within{border-color:transparent;box-shadow:var(--ring)}
  .adv .bar input{font-size:13px;padding:10px 2px}

  /* margin:auto 0 0 —— 上边距吃掉剩余空间把页脚压到底；padding-top 保证与上方内容至少留 34px */
  .foot{margin:auto 0 0;padding-top:34px;text-align:center;color:var(--sub);font-size:11.5px}
  .foot a{display:inline-flex;align-items:center;gap:6px;color:var(--sub);text-decoration:none;
    transition:color .18s}
  .foot a:hover{color:var(--fg)}
  .foot .sep{margin:0 10px;opacity:.45}

  .toast{position:fixed;left:50%;bottom:38px;transform:translate(-50%,18px) scale(.97);opacity:0;
    background:linear-gradient(180deg,var(--solid-a),var(--solid-b));color:var(--solid-fg);
    font-size:13px;padding:10px 18px;border-radius:12px;
    box-shadow:0 14px 30px -10px rgba(16,24,40,.45);
    transition:opacity .24s,transform .28s cubic-bezier(.22,.86,.28,1);pointer-events:none}
  .toast.on{opacity:1;transform:translate(-50%,0) scale(1)}

  @media (max-width:560px){
    main{padding:66px 16px 36px}
    .mark{width:50px;height:50px;border-radius:15px;margin-bottom:22px}
    h1{font-size:35px}
    .sub{margin-bottom:38px;font-size:14px}
    .bar{flex-wrap:wrap;padding:12px}
    /* 输入框独占首行（图标 34 + 间距 11），按钮落到第二行平分：
       basis 给足 → 首行只剩 15px，按钮必然换行；即使取整差 1px，
       输入框也会收缩而不是把图标挤下去 */
    .bar input{flex:1 1 calc(100% - 60px)}
    .bar button{flex:1 1 auto;min-width:0}
    .result{padding:12px 14px}
  }
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 8H5"></path><path d="m8.5 4.6 -3.4 3.4 3.4 3.4"></path>
      <path d="M4 16h15"></path><path d="m15.5 12.6 3.4 3.4 -3.4 3.4"></path>
    </svg>
  </div>

  <h1>CF Relay</h1>
  <p class="sub">把下载直链拼在本站域名后，经 Cloudflare 边缘中转，链接更稳定。</p>

  <div class="bar" id="bar">
    <span class="ico">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M4 21h16"></path>
      </svg>
    </span>
    <input id="src" placeholder="粘贴下载直链，中转链接生成在下方…" autocomplete="off" spellcheck="false" autofocus>
    <button class="solid" id="open">打开 ↗</button>
    <button class="ghost" id="copy">复制 <kbd id="kc">Ctrl C</kbd></button>
  </div>

  <div class="result" id="out" hidden>
    <span class="out-label" id="glabel">中转链接：</span>
    <code id="eg"></code>
  </div>

  <div class="chips">
    <span class="chip">断点续传</span>
    <span class="chip">自动跳转</span>
    <span class="chip">SSRF 防护</span>
    <span class="chip">JSON API</span>
  </div>

  <details class="adv">
    <summary>高级选项</summary>
    <div class="bar"><input id="name" placeholder="文件名，如 setup.exe（留空按源站推断）" autocomplete="off"></div>
    <div class="bar"><input id="token" placeholder="访问令牌，仅配置了 TOKEN 时需要" autocomplete="off"></div>
  </details>

  <p class="foot">
    <a id="ghlink" href="https://github.com/lgpay/cf-relay" target="_blank" rel="noopener" title="GitHub 项目地址">
      <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
      GitHub
    </a>
    <span class="sep">·</span>
    <a id="apilink" href="/api">JSON API</a>
    <span id="localnote" hidden><span class="sep">·</span>本地预览模式</span>
  </p>
</main>
<div class="toast" id="toast">已复制</div>

<script>
(function(){
  var IS_FILE = location.protocol === 'file:';
  var RELAY = (IS_FILE ? 'https://cf-relay.demo.workers.dev' : location.origin).replace(/\/+$/, '');
  // Worker 自己占用的参数名：路径拼接形态下它们会被剥掉，不能透传给源站
  var RESERVED = ['url', 'u', 'q', 'token', 'name', 'mode'];
  var LABEL = '\u4e2d\u8f6c\u94fe\u63a5\uff1a';

  var $ = function(id){ return document.getElementById(id); };
  var src = $('src'), nameI = $('name'), tokenI = $('token');
  var bar = $('bar'), outEl = $('out'), toastEl = $('toast');
  var tmr = null, debounce = null, outCache = '';

  $('kc').textContent = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? '\u2318C' : 'Ctrl C';
  $('localnote').hidden = !IS_FILE;
  $('apilink').setAttribute('href', RELAY + '/api');
  clearOut();

  function toast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(tmr);
    tmr = setTimeout(function(){ toastEl.classList.remove('on'); }, 1400);
  }

  function flash(){
    bar.classList.remove('flash');
    void bar.offsetWidth;
    bar.classList.add('flash');
  }

  // 路径拼接形态必须先有协议头，否则 Worker 认不出来
  function normalize(v){
    v = v.trim();
    if (/^https?:\/\//i.test(v)) return v;
    if (/^https?:\/*/i.test(v)){
      return v.replace(/^https?:\/*/i, function(m){ return m.replace(/\/*$/, '://'); });
    }
    return 'https://' + v.replace(/^\/+/, '');
  }

  // 贴进来的是中转链接（新形态 / 旧的 ?url= 形态）→ 还原成原始直链，框内永远显示原始地址
  function unwrap(s){
    var v = s.trim();
    if (v.indexOf(RELAY + '/') === 0){
      var rest = v.slice(RELAY.length + 1);
      var qi = rest.indexOf('?');
      var path = qi === -1 ? rest : rest.slice(0, qi);
      // 注意：旧的 ?url= 形态同样以「本站域名/」开头，但此时 path 为空，
      // 必须放过去交给下面的旧形态分支处理，不能在这里直接返回
      if (/^https?:\/\//i.test(path)){
        var keep = [];
        (qi === -1 ? '' : rest.slice(qi + 1)).split('&').forEach(function(kv){
          if (!kv) return;
          if (RESERVED.indexOf(kv.split('=')[0].toLowerCase()) === -1) keep.push(kv);
        });
        return path + (keep.length ? '?' + keep.join('&') : '');
      }
    }
    try {
      var u = new URL(v);
      if (u.origin === RELAY){
        var t = u.searchParams.get('url') || u.searchParams.get('u') || u.searchParams.get('q');
        if (t) return t;
      }
    } catch (e) {}
    return v;
  }

  // 目标链接自带的 query 里命中保留字时，路径拼接形态会把这些参数吃掉 → 回退 ?url= 形态
  function needsQueryForm(raw){
    var qi = raw.indexOf('?');
    if (qi === -1) return false;
    var q = raw.slice(qi + 1).split('#')[0];
    var hit = false;
    q.split('&').forEach(function(kv){
      if (kv && RESERVED.indexOf(kv.split('=')[0].toLowerCase()) > -1) hit = true;
    });
    return hit;
  }

  function build(raw){
    var extra = [];
    var n = nameI.value.trim(), t = tokenI.value.trim();
    if (n) extra.push('name=' + encodeURIComponent(n));
    if (t) extra.push('token=' + encodeURIComponent(t));
    var tail = extra.length ? (needsQueryForm(raw) ? '&' : '?') + extra.join('&') : '';

    if (needsQueryForm(raw)){
      return { url: RELAY + '/?url=' + encodeURIComponent(raw) + tail, form: 'query' };
    }
    return { url: RELAY + '/' + raw + tail, form: 'path' };
  }

  // 无输入时不显示任何结果行（不再展示示例链接）
  function clearOut(){
    outEl.hidden = true;
    $('glabel').textContent = LABEL;
    $('eg').textContent = '';
  }

  function setOut(r){
    outEl.hidden = false;
    $('glabel').textContent = r.form === 'query'
      ? '\u4e2d\u8f6c\u94fe\u63a5\uff08\u5df2\u56de\u9000 ?url= \u5f62\u6001\uff09\uff1a'
      : LABEL;
    $('eg').textContent = r.url;
  }

  // 唯一入口：读框内的原始直链 → 生成中转链接（框内内容不变）
  function refresh(animate){
    var v = src.value.trim();
    if (!v){
      outCache = '';
      src.removeAttribute('title');
      clearOut();
      return '';
    }

    var raw = unwrap(v);
    if (raw !== v) src.value = raw;          // 贴进来的是中转链接 → 还原为原始直链
    raw = normalize(raw);
    if (raw !== src.value) src.value = raw;  // 补协议头，同样保持"显示原始地址"

    var r = build(raw);
    outCache = r.url;
    src.setAttribute('title', '\u4e2d\u8f6c\u94fe\u63a5\uff1a' + r.url);
    setOut(r);
    if (animate) flash();
    return r.url;
  }

  src.addEventListener('input', function(){
    clearTimeout(debounce);
    debounce = setTimeout(function(){ refresh(true); }, 220);
  });
  src.addEventListener('paste', function(){
    clearTimeout(debounce);
    setTimeout(function(){ refresh(true); }, 0);
  });
  src.addEventListener('keydown', function(e){
    if (e.key === 'Enter'){ e.preventDefault(); clearTimeout(debounce); refresh(true); }
  });
  src.addEventListener('blur', function(){
    clearTimeout(debounce);
    refresh(false);
  });

  // 高级选项变化 → 直接用框内的原始直链重算
  nameI.addEventListener('input', function(){ refresh(false); });
  tokenI.addEventListener('input', function(){ refresh(false); });

  function finalUrl(){
    if (!src.value.trim()) return '';
    return outCache || refresh(false);
  }

  function copyText(text){
    if (navigator.clipboard && navigator.clipboard.writeText){
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function(resolve, reject){
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('execCommand failed'));
      } catch (e) { reject(e); }
    });
  }

  $('open').addEventListener('click', function(){
    var v = finalUrl();
    if (!v){ toast('请先粘贴直链'); src.focus(); return; }
    window.open(v, '_blank', 'noopener');
  });

  $('copy').addEventListener('click', function(){
    var v = finalUrl();
    if (!v){ toast('请先粘贴直链'); src.focus(); return; }
    copyText(v).then(function(){
      toast('已复制');
      var btn = $('copy'), old = btn.innerHTML;
      btn.textContent = '已复制';
      setTimeout(function(){ btn.innerHTML = old; }, 1200);
    }).catch(function(){ toast('复制失败，请手动复制'); });
  });

  document.addEventListener('keydown', function(e){
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); $('open').click(); }
  });
})();
</script>
</body>
</html>`;
}
