/**
 * CF Relay —— 通用 HTTP(S) 下载中转（Cloudflare Worker）
 *
 * 支持三种链接形态：
 *   1) 查询参数：  https://<worker>/?url=https%3A%2F%2Fexample.com%2Fa.zip
 *   2) 带文件名：  https://<worker>/dl/my%20file.zip?url=<encoded>
 *   3) 路径拼接：  https://<worker>/https://example.com/a.zip
 *
 * 额外接口：
 *   &mode=info   → 返回 JSON 探测信息（文件名 / 大小 / 是否支持断点续传），只发 HEAD
 *   GET /        → 简易网页，粘贴原链生成中转链接
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 无参数访问根路径 → 返回生成中转链接的小页面
    if (request.method === 'GET' && url.pathname === '/' && !hasTargetParam(url)) {
      return new Response(homePage(url.origin), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', ...corsHeaders() },
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
  const auth = request.headers.get('authorization') || '';
  return auth === `Bearer ${token}`;
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-max-age': '86400',
  };
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: true, status, message }, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
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

async function probe(target, env, reqUrl) {
  const upstream = await fetch(target, {
    method: 'HEAD',
    headers: buildUpstreamHeaders(null, env, reqUrl),
    redirect: 'follow',
  });
  const len = upstream.headers.get('content-length');
  const info = {
    url: target,
    final_url: upstream.url || target,
    status: upstream.status,
    ok: upstream.ok,
    content_length: len ? Number(len) : null,
    content_type: upstream.headers.get('content-type'),
    accept_ranges: upstream.headers.get('accept-ranges') || '',
    supports_range: (upstream.headers.get('accept-ranges') || '').toLowerCase().includes('bytes'),
    filename: guessName(target, upstream.headers.get('content-disposition'), reqUrl),
  };
  return new Response(JSON.stringify(info, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
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
