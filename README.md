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
│   ├── test/api.test.mjs# 接口测试（离线，stub 掉上游请求）
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
| 根目录 / Root directory | **`worker`**，或**留空**（仓库根也放了一份等效的 `wrangler.toml`） |
| 构建命令 / Build command | `npm install`（或留空） |
| 部署命令 / Deploy command | `npx wrangler deploy` |

> ⚠️ **Root directory 千万别指向 `preview/` 或其它不含 `wrangler.toml` 的目录。**
> 那样 Workers Builds 找不到配置会退回「自动配置」，把仓库当**静态站点**发布：
> 症状是访客无论带什么参数都只看到首页 HTML（静态站点不认 `?url=`），
> 未命中路径返回**空的 404** 而不是 `400` JSON。用下面的自检命令一眼可辨。

新版界面把构建与部署拆成两条命令，旧界面只有一个构建命令框 —— 那种情况填 `npx wrangler deploy` 即可。

4. 保存并部署。之后每次 push 到 `main` 自动发布；推分支或开 PR 会生成独立的 Preview 版本，不影响生产。

### 部署自检（两条命令，10 秒）

```bash
W=https://<你的域名>

# ① 必须返回 400 + JSON 错误体。若返回「空的 404」→ 部署成了静态站点，去改 Root directory
curl -s "$W/this-path-does-not-exist"

# ② 必须返回 JSON 探测信息（文件名 / 大小 / 是否支持 Range）
curl -s "$W/?url=https%3A%2F%2Fexample.com&mode=info"

# ③ 必须返回 {"ok":true,...}，且带 x-relay-version 头
curl -s "$W/api/health"
```

正常工作的 Worker，任何响应都会带 `x-relay-target`（中转时）或 `access-control-allow-origin: *`（所有响应）与 `cache-control: no-store`；静态站点不会有这些头。

**环境变量**：`wrangler.toml` 的 `[vars]` 会随代码一起部署；不想进仓库的（如 `TOKEN`）放到
Dashboard → Settings → Variables and Secrets 存为 **Secret**，或本地执行 `npx wrangler secret put TOKEN`。
新增/修改 Secret 后需要在 Dashboard 里手动触发一次 Re-deploy。

**关于 API token**：Workers Builds 会自动为你生成一个部署用的 API token，不需要手动配置。
构建日志在 Worker 的 Deployments 页面可查。

## 二、中转后的链接长什么样

**默认形态是路径拼接 —— 域名后面直接接原始直链**，页面上「打开 / 复制」产出的就是这种：

```
原始直链   https://get.com/get.zip
中转链接   https://<your-worker>.workers.dev/https://get.com/get.zip
```

| 形态 | 示例 | 说明 |
|---|---|---|
| **路径拼接（默认）** | `https://w.workers.dev/https://a.com/f.zip` | 最直观，手敲最快 |
| 指定文件名 | `https://w.workers.dev/https://a.com/f.zip?name=a.zip` | 覆盖源站推断出的保存名 |
| 查询参数 | `https://w.workers.dev/?url=https%3A%2F%2Fa.com%2Ff.zip` | 参数全在 `url` 里编码，绝不与源站冲突 |
| 回退形态 | 同上 | 原始链接自带 `?token=`/`?name=` 这类保留参数时自动改用这种 |
| 信息探测 | `https://w.workers.dev/https://a.com/f.zip?mode=info` | 返回 JSON：大小 / 文件名 / 是否支持 Range |

带令牌时追加 `?token=xxx` 或 `&token=xxx`，或请求头 `Authorization: Bearer xxx`（API 还支持 `X-API-Key`）。

> ⚠️ **为什么有「回退形态」**：路径拼接时域名后面的部分也是 query，Worker 无法区分
> 「这是源站自己的 `?token=abc`」还是「这是给我的访问令牌」——保留字
> `url` / `u` / `q` / `token` / `name` / `mode` 会被 Worker 吃掉。所以当原始链接自带的 query
> 命中这些名字时，页面和 `cfget.py` 都会**自动改回 `?url=` 形态**（整条原始链接被编码进
> `url` 参数，不会有任何冲突），并在页面上标注说明。
> 另外：源站的 `?token=` 只在 Worker 真的配了 `TOKEN` 时才会被当成访问令牌剥掉，没配就原样透传。

程序化调用（脚本 / 其他服务）见 [三、JSON API](#三json-api)。

直接访问 `https://w.workers.dev/` 得到操作页面：**输入框里始终是你粘进去的原始直链，中转型链接在下方实时生成**，
右侧「打开 ↗」新窗口直接下载、「复制」拿走链接——两个按钮用的都是中转链接。
转换是自动的（输入/粘贴后 220ms，回车立即）；粘贴进来的如果已经是中转链接，会自动还原成原始地址。
粘贴的地址若没带 `http(s)://` 会自动补上（路径拼接形态必须有协议头，否则 Worker 认不出目标）。
底部「高级选项」可填保存文件名与访问令牌，改动后立即重算。`Ctrl+Enter` 直接打开。
未输入时页面不显示任何示例链接；页脚只有 GitHub 项目地址与 JSON API 两个入口。

## 三、JSON API

脚本、其他服务要调用时走 `/api/*`（路径以 `/api` 开头就只走 API 分支，永远返回 JSON，不会被
`/https://...` 那种路径拼接规则误吞）。**`GET /api` 是自描述索引**，不看文档也能用：

```bash
W=https://<你的域名>

curl -s "$W/api"                                  # 接口索引 + 每个接口的 curl 示例
curl -s "$W/api/health"                           # 存活 / 版本 / 是否需令牌
curl -s "$W/api/link?url=<encoded>"               # 生成中转链接
curl -s "$W/api/info?url=<encoded>"               # 探测：大小 / 类型 / 是否支持 Range
curl -s "$W/api/check?url=<encoded>"              # 只做域名策略预检，不发上游请求
```

| 接口 | 方法 | 需令牌 | 说明 |
|---|---|---|---|
| `/api` | GET | 否 | 自描述索引：接口列表、链接形态、curl 示例、当前是否需令牌 |
| `/api/health` | GET | 否 | `{ok, version, time, token_required}` |
| `/api/config` | GET | 是 | 当前策略：域名黑白名单、大小上限、缓存 TTL、UA（只回显 `UPSTREAM_HEADERS` 的**键名**） |
| `/api/link` | GET / POST | 是 | 生成中转链接，支持批量；`info=true` 时顺带探测 |
| `/api/info` | GET / POST | 是 | 探测上游，HEAD 被拒时自动降级为 1 字节 Range |
| `/api/check` | GET / POST | 是 | 只判断域名是否放行，**不返回 403**（把结论交给调用方） |

鉴权三选一：`?token=xxx`、`Authorization: Bearer xxx`、`X-API-Key: xxx`。
`/api` 与 `/api/health` **始终公开**——客户端靠它判断"这个 Worker 要不要令牌"。

### /api/link 返回结构

```json
{
  "ok": true,
  "version": "1.1.0",
  "count": 1,
  "allowed": 1,
  "items": [
    {
      "source": "https://get.com/get.zip",
      "ok": true,
      "allowed": true,
      "reason": null,
      "filename": "get.zip",
      "link_form": "path",
      "relay_url": "https://w.workers.dev/https://get.com/get.zip",
      "relay_url_query": "https://w.workers.dev/?url=https%3A%2F%2Fget.com%2Fget.zip"
    }
  ]
}
```

`relay_url` 是**推荐直接用**的那条（默认路径拼接）；`relay_url_query` 是等价的 `?url=` 形态，
在源站保留参数、或对方系统对域名后带斜杠的路径有洁癖时用。`link_form` 取值 `path` / `query`，
告诉你 `relay_url` 用的是哪种。

批量 + 探测：

```bash
# GET：重复 url 参数
curl -s "$W/api/link?url=<a>&url=<b>&name=fix.zip"

# POST：JSON 体，可同时指定每条的 name
curl -s -X POST "$W/api/link" -H 'content-type: application/json' \
  -d '{"urls":["https://example.com/a.zip",{"url":"https://example.com/b.zip","name":"b.zip"}],"info":true}'
```

几个语义约定：

- **`allowed` / `reason` 是策略判定结果，被拦时照样返回 `relay_url`**。`/api/link` 与 `/api/check`
  只负责给数据，真正下载时才 403 —— 调用方按 `allowed` 决定用不用。
- **`info.ok` 是「上游是否 2xx」，外层 `ok` 是「接口是否成功」**，两者不要混。
- **默认不把令牌写进链接**（否则会随日志、转发、分享外泄）。需要"拿去就能打开"的链接时传
  `embed_token=1`（令牌取 `token` 参数或请求体里的 `token`）。
- 单次最多 50 条（`/api/config` 里的 `max_batch`），超出返回 413。

### 错误格式

```json
{ "ok": false, "error": true, "status": 403, "code": "FORBIDDEN",
  "message": "host not in allow list: evil.com" }
```

`code` 取值：`NO_TARGET` `BAD_JSON` `BAD_BODY` `TOO_MANY_URLS` `BODY_TOO_LARGE` `UNAUTHORIZED`
`FORBIDDEN` `NOT_FOUND` `METHOD_NOT_ALLOWED` `TOO_LARGE` `UPSTREAM_FAILED` `INTERNAL_ERROR`。

所有响应都带 `x-relay-version`，方便确认线上跑的是哪一版。

### 测试

```bash
cd worker && npm test      # 50 条断言，离线跑（stub 掉上游请求），不联网、不需要账号
```

## 四、改页面

页面只有一份源文件 `preview/index.html`，Worker 首页是它同步内联的结果：

```bash
python tools/sync-homepage.py     # 改完 preview/index.html 后跑一次
cd worker && npm run deploy
```

`preview/index.html` 本地双击即可预览（file:// 下用占位域名，页脚会提示）。

## 五、环境变量（全部可选，不配就是宽松模式）

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

## 六、本地下载

`cfget.py` 只用 Python 标准库。

```bash
# 预设中转地址，省得每次敲
set CF_RELAY=https://cf-relay.xxx.workers.dev      # PowerShell: $env:CF_RELAY="..."
set CF_RELAY_TOKEN=your-token                      # 可选

# 只生成中转链接（不下载），默认输出路径拼接形态
python cfget.py "https://example.com/a.zip" --print
#   -> https://cf-relay.xxx.workers.dev/https://example.com/a.zip

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

## 七、已知边界

- Workers 免费版每天 10 万请求、单次 CPU 10ms；**流式转发不占 CPU**，但超大文件（GB 级）建议仍走直连或 R2。
- Worker 转发时会强制 `Accept-Encoding: identity`，保证 `Content-Length` 与 Range 语义一致（代价：源站的 gzip 压缩失效，流量略增）。
- 源站若 302 到另一个域，Worker 默认自动跟随；白名单按**原始 URL** 的 host 判定。
- 源站有 IP 频控时，中转后出口 IP 是 CF 的，可能更容易被限流——这时靠 `UA` / `REFERER` / `UPSTREAM_HEADERS` 补。
- **路径拼接形态下，源站 query 里的 `url` / `u` / `q` / `token` / `name` / `mode` 会被 Worker 吃掉**
  （`token` 仅当 Worker 配了 `TOKEN` 时；其余始终）。页面与 `cfget.py` 遇到这种原始链接会自动
  改用 `?url=` 形态；自己拼链接时遇到同样情况请手动换成 `?url=` 形态。
- 路径拼接形态的域名后面**必须带协议头**（`https://` 或 `http://`），否则 Worker 认不出目标而返回
  `400`。只写 `w.workers.dev/get.com/f.zip` 是无效的；页面已自动补全。
