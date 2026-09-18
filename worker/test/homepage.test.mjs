/**
 * 首页交互测试 —— 把 preview/index.html 里那段脚本原样抽出来，在最小 DOM 桩上执行。
 *
 *   node test/homepage.test.mjs
 *
 * 不复制一份逻辑来测（那样只能证明副本是对的），而是断言真正会被 inline 进
 * Worker 的那段代码：输入框必须保持原始地址、默认产出路径拼接形态、保留参数时回退。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(HERE, '..', '..', 'preview', 'index.html');
const ORIGIN = 'https://cf-relay.box.workers.dev';

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

/* ------------------------------- 最小 DOM 桩 ------------------------------- */

function makeEl(id) {
  const listeners = {};
  return {
    id, value: '', textContent: '', innerHTML: '', hidden: false, offsetWidth: 0,
    attrs: {},
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); },
      remove(c) { this.set.delete(c); },
      contains(c) { return this.set.has(c); },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    focus() { focusTarget = id; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    fire(t, ev) { (listeners[t] || []).forEach((fn) => fn(ev || {})); },
  };
}

let focusTarget = '';
let opened = '';
let copied = '';
const els = {};
const docListeners = {};

const document = {
  getElementById: (id) => els[id] || (els[id] = makeEl(id)),
  createElement: (tag) => makeEl(tag),
  body: { appendChild() {}, removeChild() {} },
  addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
};

const location = { protocol: 'https:', origin: ORIGIN };
const navigator = { platform: 'Win32', clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } };
const window = { open: (u) => { opened = u; } };

/* ------------------------------ 抽取并执行 ------------------------------ */

const html = fs.readFileSync(HTML, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
check('页面里能抽到 <script>', Boolean(m));

const srcTag = html.slice(html.indexOf('id="src"'), html.indexOf('id="src"') + 400);
check('输入框说明改为"框内保持原样"', srcTag.includes('框内保持原样'), srcTag.slice(0, 160));
check('脚本里已无"就地把框内换成中转链接"的写法', !m[1].includes('src.value = out'));

new Function('document', 'location', 'navigator', 'window', 'setTimeout', 'clearTimeout', m[1])(
  document, location, navigator, window, setTimeout, clearTimeout,
);

const $ = (id) => els[id];
const input = $('src');
const out = () => $('eg').textContent;
const label = () => $('glabel').textContent;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const enter = () => input.fire('keydown', { key: 'Enter', preventDefault() {} });
const type = async (v) => { input.value = v; input.fire('input'); await wait(300); };

/* --------------------------------- 用例 --------------------------------- */

check('初始状态显示示例', label().includes('示例') && out() === `${ORIGIN}/https://example.com/file.zip`, out());

// 1. 核心诉求：输入框内容不变，中转链接是"域名后面直接接原始直链"
input.value = 'https://get.com/get.zip';
input.fire('input');
await wait(300);
check('输入框保持原始地址不变', input.value === 'https://get.com/get.zip', input.value);
check('输出为域名后直接拼接的形态',
  out() === `${ORIGIN}/https://get.com/get.zip`, out());
check('标签切到"中转链接："', label().includes('中转链接'), label());

// 2. 打开 / 复制 用的是中转链接，不是原始地址
$('open').fire('click');
check('「打开」产出的就是中转链接', opened === `${ORIGIN}/https://get.com/get.zip`, opened);
$('copy').fire('click');
await wait(10);
check('「复制」产出的就是中转链接', copied === `${ORIGIN}/https://get.com/get.zip`, copied);

// 3. 高级选项：文件名 / 令牌追加为 query，不改路径
$('name').value = 'setup.exe';
$('name').fire('input');
check('文件名追加为 ?name=', out() === `${ORIGIN}/https://get.com/get.zip?name=setup.exe`, out());
$('token').value = 'tk123';
$('token').fire('input');
check('令牌继续追加为 &token=',
  out() === `${ORIGIN}/https://get.com/get.zip?name=setup.exe&token=tk123`, out());

// 4. 目标自带保留参数 → 自动回退 ?url= 形态（否则参数会被 Worker 吃掉）
$('name').value = ''; $('name').fire('input');
$('token').value = ''; $('token').fire('input');
await type('https://cdn.example.com/f.zip?token=abc&v=2');
check('目标带保留参数时回退 ?url= 形态',
  out() === `${ORIGIN}/?url=${encodeURIComponent('https://cdn.example.com/f.zip?token=abc&v=2')}`, out());
check('回退时给出可见提示', label().includes('回退'), label());

await type('https://cdn.example.com/f.zip?v=2');
check('普通参数不触发回退', out() === `${ORIGIN}/https://cdn.example.com/f.zip?v=2`, out());

// 5. 贴进来就是中转链接 → 还原成原始地址，框内永远显示原始地址
input.value = `${ORIGIN}/https://a.com/f.zip`;
input.fire('paste');
await wait(20);
check('粘贴新形态中转链接 → 框内还原为原始直链', input.value === 'https://a.com/f.zip', input.value);

input.value = `${ORIGIN}/?url=${encodeURIComponent('https://a.com/f.zip')}`;
input.fire('paste');
await wait(20);
check('粘贴旧的 ?url= 形态同样能还原', input.value === 'https://a.com/f.zip', input.value);

input.value = `${ORIGIN}/https://a.com/f.zip?name=x.zip&token=t&v=1`;
input.fire('paste');
await wait(20);
check('还原时剥掉我们自己的 name/token，保留源站参数',
  input.value === 'https://a.com/f.zip?v=1', input.value);

// 6. 不带协议头 → 自动补 https，且仍显示为"原始地址"的规范形式
await type('get.com/get.zip');
check('自动补协议头后仍是路径拼接形态', out() === `${ORIGIN}/https://get.com/get.zip`, out());
check('框内同步为补全后的原始地址', input.value === 'https://get.com/get.zip', input.value);

// 7. 清空 → 回到示例
input.value = '';
input.fire('input');
await wait(300);
check('清空后回落到示例', label().includes('示例') && out() === `${ORIGIN}/https://example.com/file.zip`, out());
check('清空后「打开」会提示先粘贴', (() => { opened = ''; $('open').fire('click'); return opened === ''; })());

// 8. Ctrl+Enter 打开
input.value = 'https://get.com/get.zip';
enter();
check('Ctrl+Enter 可用（回车即刷新）', out() === `${ORIGIN}/https://get.com/get.zip`, out());

/* --------------------------------- 收尾 --------------------------------- */

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('failed cases:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
