# CF Relay — HTTP 下载链接中转

把任意 HTTP(S) 直链交给 Cloudflare Worker 代理，得到一条「新链接」，浏览器点开或命令行下载都能走 CF 边缘网络。

```
原始直链  ──►  https://<your-worker>.workers.dev/dl/name.zip?url=<encoded>  ──►  源站
                        ▲                                                        │
                        └─────────────── 数据流（支持 Range 断点续传）────────────┘
```

## 目录

```
cf-relay/
├── preview/
│   └── index.html       # 操作页面（本地双击即可预览；也是 Worker 首页的唯一来源）
├── tools/
│   └── sync-homepage.py # 把 preview/index.html 同步内联进 Worker 的 homePage()
├── worker/              # 云端部分
│   ├── src/index.js     # Worker 主程序（单文件，可直接粘贴到 Dashboard）
│   ├── wrangler.toml    # 部署配置 + 环境变量（默认全部注释，即宽松模式）
│   └── package.json
└── local/
    └── cfget.py         # 本地下载器（纯标准库，无依赖）
```

## 一、部署 Worker

### 方式 A：wrangler CLI（推荐，可随时改配置）

```bash
cd cf-relay/worker
npm install                 # 首次，装 wrangler
npx wrangler login          # 浏览器授权 Cloudflare 账号
npm run deploy              # 部署，结束后会输出 https://cf-relay.<子域>.workers.dev
```

本地先自测：`npm run dev`（默认 http://127.0.0.1:8787）。

### 方式 B：Dashboard 手动粘贴（不想装 node 时）

1. Cloudflare 控制台 → Workers 和 Pages → 创建 → 创建 Worker → 部署
2. 进入 Worker → 「快速编辑」→ 把 `src/index.js` 全部内容覆盖进去 → 保存并部署
3. 设置 → 变量 → 添加环境变量（见下表，可选）

### 方式 C：连上 GitHub，push 即上线（推荐长期维护）

本仓库就是按这种方式准备的：`worker/` 是一个自带 `wrangler.toml` 的完整 Workers 项目。

1. 代码推到 GitHub（仓库已初始化 git，改完直接 `git add -A && git commit -m "..." && git push`）
2. Cloudflare 控制台 → Workers 和 Pages → 创建应用程序 → **连接到 Git** → 选 GitHub → 授权
   （首次会要求安装 Cloudflare Workers GitHub App，可只授权本仓库）
3. 选中本仓库，按下表填：

| 字段 | 值 |
|---|---|
| 项目名称 | `cf-relay` |
| 生产分支 / Production branch | `main` |
| 根目录 / Root directory | `worker` |
| 构建命令 / Build command | `npm install` |
| 部署命令 / Deploy command | `npx wrangler deploy` |

新版界面把构建与部署拆成两条命令，旧界面只有一个构建命令框 —— 那种情况填 `npx wrangler deploy` 即可。

4. 保存并部署。之后每次 push 到 `main` 自动发布；推分支或开 PR 会生成独立的 Preview 版本，不影响生产。

**环境变量**：`wrangler.toml` 的 `[vars]` 会随代码一起部署；不想进仓库的（如 `TOKEN`）放到
Dashboard → Settings → Variables and Secrets 存为 **Secret**，或本地执行 `npx wrangler secret put TOKEN`。
新增/修改 Secret 后需要在 Dashboard 里手动触发一次 Re-deploy。

## 二、中转后的链接长什么样

| 形态 | 示例 | 说明 |
|---|---|---|
| 查询参数 | `https://w.workers.dev/?url=https%3A%2F%2Fa.com%2Ff.zip` | 最通用 |
| 带文件名 | `https://w.workers.dev/dl/my%20file.zip?url=<encoded>` | 强制下载并指定保存名 |
| 路径拼接 | `https://w.workers.dev/https://a.com/f.zip` | 手敲最快 |
| 信息探测 | `https://w.workers.dev/?url=<encoded>&mode=info` | 返回 JSON：大小 / 文件名 / 是否支持 Range |

带令牌时追加 `&token=xxx`，或请求头 `Authorization: Bearer xxx`。

直接访问 `https://w.workers.dev/` 得到操作页面：**单框输入原始链接，框内就地变成代理链接**，右侧「打开 ↗」新窗口直接下载、「复制」拿走链接。
转换是自动的（输入/粘贴后 220ms，回车立即），已经是本 Worker 的链接不会再被套娃包装；框内悬停可看到原始链接。
底部「参数设置」可填保存文件名与访问令牌，改动后立即按原始链接重算。`Ctrl+Enter` 直接打开。

## 三、改页面

页面只有一份源文件 `preview/index.html`，Worker 首页是它同步内联的结果：

```bash
python tools/sync-homepage.py     # 改完 preview/index.html 后跑一次
cd worker && npm run deploy
```

`preview/index.html` 本地双击即可预览（file:// 下用占位域名，页脚会提示）。

## 四、环境变量（全部可选，不配就是宽松模式）

| 变量 | 作用 | 建议 |
|---|---|---|
| `TOKEN` | 访问令牌，命中后必须带 `?token=` / Bearer | **公网部署强烈建议配**，否则会被当免费代理扫 |
| `ALLOW_HOSTS` | 域名白名单，逗号分隔，支持 `*.github.com`、`.github.com` | 同上 |
| `DENY_HOSTS` | 黑名单，优先级高于白名单 | — |
| `ALLOW_PRIVATE` | `"1"` 才放行内网 / 元数据地址 | 默认阻断，防 SSRF，一般别开 |
| `UA` | 覆盖发往源站的 User-Agent | 源站校验 UA 时用 |
| `REFERER` | 覆盖发往源站的 Referer | 防盗链源站用 |
| `UPSTREAM_HEADERS` | JSON，追加任意请求头，如 `{"Authorization":"Bearer x"}` | 私有源站 |
| `CACHE_TTL` | 边缘缓存秒数，`0` = 不缓存 | 大文件保持 0，避免占满边缘缓存 |
| `MAX_BYTES` | 单文件大小上限（字节），`0` = 不限 | 想限流时配 |

改完 `wrangler.toml` 后重新 `npm run deploy`；Dashboard 方式在「设置 → 变量」里改。

## 五、本地下载

`cfget.py` 只用 Python 标准库。

```bash
# 预设中转地址，省得每次敲
set CF_RELAY=https://cf-relay.xxx.workers.dev      # PowerShell: $env:CF_RELAY="..."
set CF_RELAY_TOKEN=your-token                      # 可选

# 只生成中转链接（不下载）
python cfget.py "https://example.com/a.zip" --print

# 下载到当前目录，4 线程 + 断点续传
python cfget.py "https://example.com/a.zip"

# 指定目录 + 文件名 + 8 线程
python cfget.py "https://example.com/a.zip" -d D:\download -n a.zip -j 8

# 先看文件信息
python cfget.py "https://example.com/a.zip" --info

# 不走中转，直连（脚本本身就是一个支持续传的下载器）
python cfget.py "https://example.com/a.zip" --no-relay

# 追加自定义头（会发给 Worker，Worker 再透传给源站）
python cfget.py "https://example.com/a.zip" -H "Referer: https://example.com" --sha256
```

参数：`-r/--relay` 中转地址 · `-t/--token` 令牌 · `-o` 输出文件路径 · `-d` 输出目录 ·
`-n` 覆盖文件名 · `-j` 线程数 · `-H` 追加请求头 · `--md5/--sha256` 校验。

断点续传：下载中生成一个 `<file>.part` 与 `<file>.part.json`（分块进度），中断后重跑同一条命令自动续传。

## 六、已知边界

- Workers 免费版每天 10 万请求、单次 CPU 10ms；**流式转发不占 CPU**，但超大文件（GB 级）建议仍走直连或 R2。
- Worker 转发时会强制 `Accept-Encoding: identity`，保证 `Content-Length` 与 Range 语义一致（代价：源站的 gzip 压缩失效，流量略增）。
- 源站若 302 到另一个域，Worker 默认自动跟随；白名单按**原始 URL** 的 host 判定。
- 源站有 IP 频控时，中转后出口 IP 是 CF 的，可能更容易被限流——这时靠 `UA` / `REFERER` / `UPSTREAM_HEADERS` 补。
