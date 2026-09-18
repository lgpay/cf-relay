"""把 preview/index.html 内联进 worker/src/index.js 的 homePage()。

修改页面时的正确姿势：只改 preview/index.html，然后跑这个脚本同步，避免两份 HTML 漂移。

为什么必须用 String.raw 包裹：HTML 里内嵌 JS 含有形如 replace(/\\/+$/, '') 的正则，
放在普通模板字符串里反斜杠会被当作 "identity escape" 吃掉，正则退化成 /+/ 直接语法错误。
String.raw 会保留全部反斜杠原样输出。代价：HTML 中不能出现 ${ 和反引号（脚本会断言）。
"""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HTML = os.path.join(ROOT, "preview", "index.html")
WORKER = os.path.join(ROOT, "worker", "src", "index.js")
MARK = "/* -------------------------------- \u9996\u9875\u9875\u9762 -------------------------------- */"

html = io.open(HTML, encoding="utf-8").read().rstrip()
assert "${" not in html, "HTML \u91cc\u4e0d\u80fd\u51fa\u73b0 ${ \u5360\u4f4d"
assert "`" not in html, "HTML \u91cc\u4e0d\u80fd\u51fa\u73b0\u53cd\u5f15\u53f7"

src = io.open(WORKER, encoding="utf-8").read()
assert MARK in src, "index.js \u91cc\u627e\u4e0d\u5230\u9996\u9875\u5206\u9694\u6807\u8bb0"

head = src.split(MARK)[0].rstrip() + "\n\n"
block = (
    MARK + "\n\n"
    "// \u6ce8\u610f\uff1a\u4e0b\u65b9\u7528 String.raw \u5305\u88f9\uff0c"
    "\u907f\u514d HTML \u5185\u5d4c JS \u7684\u6b63\u5219\u88ab\u6a21\u677f\u5b57\u7b26\u4e32\u8f6c\u4e49\n"
    "function homePage() {\n  return String.raw`" + html + "`;\n}\n"
)

io.open(WORKER, "w", encoding="utf-8", newline="\n").write(head + block)
print("synced:", WORKER, len(head + block), "chars")
