/**
 * CF Relay 接口测试 —— 不联网，直接 import Worker 模块调 fetch()。
 *
 *   node test/api.test.mjs
 *
 * 上游请求用轻量假响应顶替（只实现代码真正用到的 status / ok / url / headers.get / body），
 * 避免 undici 对 content-length 的自动改写干扰断言。
 */
import worker from '../src/index.js';

const ORIGIN = 'https://relay.test';
const SRC = 'https://example.com/a.zip';

let pass = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`}`);
  }
}

function call(path, init, env) {
  return worker.fetch(new Request(ORIGIN + path, init), env || {}, {});
}

async function body(res) {
  return JSON.parse(await res.text());
}

/* ------------------------------ 上游替身 ------------------------------ */

const realFetch = globalThis.fetch;

function fakeRes({ status = 200, headers = {}, url = '', body = null } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status, ok: status >= 200 && status < 300, url, body,
    headers: { get: (k) => (h.has(String(k).toLowerCase()) ? h.get(String(k).toLowerCase()) : null) },
  };
}

function stubUpstream(map) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : input.url;
    const method = (init && init.method) || 'GET';
    calls.push({ url: u, method, headers: init && init.headers });
    const key = `${method} ${u}`;
    const hit = map[key];
    if (!hit) throw new Error(`unexpected upstream call: ${key}`);
    return typeof hit === 'function' ? hit() : hit;
  };
  return calls;
}

/* --------------------------------- 用例 --------------------------------- */

// 1. 索引与健康检查（公开）
{
  const r = await call('/api');
  const j = await body(r);
  check('GET /api 返回 200 JSON', r.status === 200 && r.headers.get('content-type').includes('json'));
  check('索引含 6 个接口', Array.isArray(j.endpoints) && j.endpoints.length === 6, j.endpoints && j.endpoints.length);
  check('索引含三种链接形态示例', Boolean(j.link_forms && j.link_forms.query && j.link_forms.path_join));
  check('索引 self-describing：不配 TOKEN 时 auth.required=false', j.auth.required === false);
  check('响应带 x-relay-version', Boolean(r.headers.get('x-relay-version')), r.headers.get('x-relay-version'));

  const h = await body(await call('/api/health'));
  check('GET /api/health ok', h.ok === true && h.service === 'cf-relay' && h.token_required === false);
}

// 2. 生成中转链接（GET，纯计算，不打上游）
{
  const r = await call(`/api/link?url=${encodeURIComponent(SRC)}`);
  const j = await body(r);
  const it = j.items[0];
  check('GET /api/link 单条', j.ok === true && j.count === 1 && it.allowed === true);
  check('relay_url 落在 /dl/ 且带编码后的 url',
    it.relay_url.startsWith(`${ORIGIN}/dl/a.zip?url=`) && it.relay_url.includes(encodeURIComponent(SRC)), it.relay_url);
  check('relay_url_short 为路径拼接形态', it.relay_url_short === `${ORIGIN}/${SRC}`, it.relay_url_short);
  check('默认不把令牌写进链接', !it.relay_url.includes('token='));

  const withName = await body(await call(`/api/link?url=${encodeURIComponent(SRC)}&name=my%20file.bin`));
  check('name 参数进 /dl/ 且被 encode', withName.items[0].relay_url.startsWith(`${ORIGIN}/dl/my%20file.bin?`),
    withName.items[0].relay_url);
  check('filename 已清理非法字符', withName.items[0].filename === 'my file.bin');
}

// 3. 令牌：三种携带方式
{
  const env = { TOKEN: 's3cr3t' };
  const health = await body(await call('/api/health', null, env));
  check('配了 TOKEN 后 /api/health 仍公开且提示 token_required', health.ok === true && health.token_required === true);

  const noToken = await call(`/api/link?url=${encodeURIComponent(SRC)}`, null, env);
  const noTokenBody = await body(noToken);
  check('无令牌 → 401 UNAUTHORIZED', noToken.status === 401 && noTokenBody.code === 'UNAUTHORIZED');

  check('?token= 放行', (await call(`/api/link?url=${encodeURIComponent(SRC)}&token=s3cr3t`, null, env)).status === 200);
  check('Authorization: Bearer 放行',
    (await call(`/api/link?url=${encodeURIComponent(SRC)}`, { headers: { authorization: 'Bearer s3cr3t' } }, env)).status === 200);
  check('X-API-Key 放行',
    (await call(`/api/link?url=${encodeURIComponent(SRC)}`, { headers: { 'x-api-key': 's3cr3t' } }, env)).status === 200);

  const embed = await body(await call(
    `/api/link?url=${encodeURIComponent(SRC)}&token=s3cr3t&embed_token=1`, null, env));
  check('embed_token=1 时链接内嵌令牌', embed.items[0].relay_url.includes('token=s3cr3t'));
}

// 4. POST 批量 + 参数校验
{
  const r = await call('/api/link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urls: ['https://a.com/1.zip', 'https://b.com/2.bin'], name: 'x.tar' }),
  });
  const j = await body(r);
  check('POST 批量 2 条', r.status === 200 && j.count === 2 && j.items.length === 2);
  check('body 的 name 生效', j.items.every((i) => i.filename === 'x.tar' && i.relay_url.includes('/dl/x.tar?')));

  const dup = await body(await call('/api/link', {
    method: 'POST', body: JSON.stringify({ urls: ['https://a.com/1.zip', 'https://a.com/1.zip'] }),
  }));
  check('重复 url 去重', dup.count === 1);

  const many = await call('/api/link', {
    method: 'POST', body: JSON.stringify({ urls: Array.from({ length: 51 }, (_, i) => `https://a.com/${i}.zip`) }),
  });
  check('超过 50 条 → 413 TOO_MANY_URLS', many.status === 413 && (await body(many)).code === 'TOO_MANY_URLS');

  const badJson = await call('/api/link', { method: 'POST', body: '{oops' });
  check('非法 JSON → 400 BAD_JSON', badJson.status === 400 && (await body(badJson)).code === 'BAD_JSON');

  const noTarget = await call('/api/link');
  check('缺 url → 400 NO_TARGET', noTarget.status === 400 && (await body(noTarget)).code === 'NO_TARGET');

  const badUrl = await body(await call('/api/link?url=not%20a%20url%20at%20all'));
  check('非法链接 → ok=false 且带 reason', badUrl.items[0].ok === false && /invalid url/.test(badUrl.items[0].reason),
    badUrl.items[0].reason);
}

// 5. 策略：内网拦截 / 白名单 / ALLOW_PRIVATE
{
  const priv = await body(await call(`/api/link?url=${encodeURIComponent('http://127.0.0.1:8080/x')}`));
  check('内网地址 allowed=false', priv.items[0].allowed === false && /private|loopback/.test(priv.items[0].reason),
    priv.items[0].reason);
  check('被拦时仍返回 relay_url（只报数据，不下结论）', priv.items[0].relay_url.length > 0);

  const meta = await body(await call('/api/check?url=' + encodeURIComponent('http://169.254.169.254/latest/meta-data/')));
  check('云元数据地址 check 拦下（200 而非 403）', meta.items[0].allowed === false && meta.items[0].host === '169.254.169.254');

  const env = { ALLOW_HOSTS: 'github.com,*.githubusercontent.com' };
  const okHost = await body(await call('/api/check?url=' + encodeURIComponent('https://github.com/x/y.zip'), null, env));
  const subHost = await body(await call('/api/check?url=' + encodeURIComponent('https://objects.githubusercontent.com/a'), null, env));
  const badHost = await body(await call('/api/check?url=' + encodeURIComponent('https://evil.com/a.zip'), null, env));
  check('白名单命中 github.com', okHost.items[0].allowed === true);
  check('白名单通配 *.githubusercontent.com', subHost.items[0].allowed === true);
  check('白名单外域名 allowed=false', badHost.items[0].allowed === false && /not in allow list/.test(badHost.items[0].reason));

  const open = await body(await call('/api/check?url=' + encodeURIComponent('http://127.0.0.1/x'), null, { ALLOW_PRIVATE: '1' }));
  check('ALLOW_PRIVATE=1 放行内网', open.items[0].allowed === true);

  const cfgRes = await call('/api/config?token=t', null, { TOKEN: 't', ALLOW_HOSTS: 'a.com,b.com', MAX_BYTES: '1024' });
  const cfg = await body(cfgRes);
  check('config 需要令牌（无令牌时 401）',
    (await call('/api/config', null, { TOKEN: 't' })).status === 401);
  check('config 回显策略且不泄露密钥',
    cfgRes.status === 200 && cfg.allow_hosts.length === 2 && cfg.max_bytes === 1024
      && cfg.token_required === true && !JSON.stringify(cfg).includes('"t"'));
}

// 6. /api/info 探测（HEAD 成功）
{
  stubUpstream({
    [`HEAD ${SRC}`]: fakeRes({
      status: 200,
      url: SRC,
      headers: {
        'content-length': '1234',
        'content-type': 'application/zip',
        'accept-ranges': 'bytes',
        'content-disposition': 'attachment; filename="a.zip"',
      },
    }),
  });
  const j = await body(await call(`/api/info?url=${encodeURIComponent(SRC)}`));
  const it = j.items[0];
  check('/api/info 拿到大小与类型',
    it.info.content_length === 1234 && it.info.content_type === 'application/zip', it.info);
  check('/api/info 人类可读大小', it.info.size_human === '1.21KB', it.info.size_human);
  check('/api/info supports_range=true', it.info.supports_range === true && it.info.head_supported === true);
  check('/api/info 文件名取自 Content-Disposition', it.info.filename === 'a.zip' && it.filename === 'a.zip');
  globalThis.fetch = realFetch;
}

// 7. /api/info 探测（HEAD 被拒 → Range 兜底）
{
  const calls = stubUpstream({
    [`HEAD ${SRC}`]: () => { throw new Error('HEAD not allowed'); },
    [`GET ${SRC}`]: fakeRes({
      status: 206,
      headers: { 'content-range': 'bytes 0-0/987654', 'content-length': '1', 'accept-ranges': 'bytes' },
    }),
  });
  const j = await body(await call(`/api/info?url=${encodeURIComponent(SRC)}`));
  const info = j.items[0].info;
  check('HEAD 失败时降级 Range 探到总大小', info.content_length === 987654 && info.supports_range === true, info);
  check('Range 兜底会带 Range: bytes=0-0 头', calls.some((c) => c.method === 'GET' && c.headers.get('range') === 'bytes=0-0'));
  check('如实标记 head_supported=false', info.head_supported === false);
  check('size_source 标为 content-range', info.size_source === 'content-range', info.size_source);
  globalThis.fetch = realFetch;
}

// 8. 被拦的 host 不探测 / 不返回上游信息
{
  let touched = false;
  globalThis.fetch = async () => { touched = true; throw new Error('should not be called'); };
  const j = await body(await call(`/api/info?url=${encodeURIComponent('http://127.0.0.1/x')}`));
  check('内网地址不触发上游请求', touched === false && j.items[0].allowed === false && j.items[0].info === undefined);
  globalThis.fetch = realFetch;
}

// 9. API 与链接形态互不干扰
{
  const st = await call('/api/does-not-exist');
  const stBody = await body(st);
  check('未知接口 404 + NOT_FOUND', st.status === 404 && stBody.code === 'NOT_FOUND');

  const opt = await call('/api/link', { method: 'OPTIONS' });
  check('OPTIONS → 204 且 methods 含 POST', opt.status === 204 && opt.headers.get('access-control-allow-methods').includes('POST'));

  const put = await call('/api/config', { method: 'PUT' });
  check('不支持的方法 405', put.status === 405 && (await body(put)).code === 'METHOD_NOT_ALLOWED');

  stubUpstream({
    [`GET ${SRC}`]: fakeRes({ status: 200, headers: { 'content-length': '5', 'content-type': 'application/zip' }, body: 'hello' }),
    [`HEAD ${SRC}`]: fakeRes({ status: 200, headers: { 'content-length': '5' } }),
  });
  const relay = await call(`/?url=${encodeURIComponent(SRC)}`);
  check('原有链接形态不受影响（?url= 仍然中转）',
    relay.status === 200 && relay.headers.get('x-relay-target') === SRC && (await relay.text()) === 'hello');

  const joined = await call('/https://example.com/a.zip');
  check('路径拼接形态仍可用', joined.status === 200 && joined.headers.get('x-relay-filename') === 'a.zip');

  const legacyInfo = await body(await call(`/?url=${encodeURIComponent(SRC)}&mode=info`));
  check('旧 ?mode=info 仍返回裸 info 对象（含 content_length）', legacyInfo.content_length === 5 && legacyInfo.url === SRC);

  const home = await call('/');
  const html = await home.text();
  check('首页仍是 HTML 且带 API 入口', home.status === 200 && html.includes('<h1>CF Relay</h1>') && html.includes('/api'));
  globalThis.fetch = realFetch;
}

/* --------------------------------- 收尾 --------------------------------- */

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('failed cases:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
