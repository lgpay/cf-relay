#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cfget —— 通过 Cloudflare Worker 中转下载文件到本地

用法示例:
  # 1) 只生成中转链接，不下载
  python cfget.py "https://example.com/a.zip" --relay https://cf-relay.xxx.workers.dev --print

  # 2) 走中转下载（4 线程 + 断点续传）
  python cfget.py "https://example.com/a.zip" --relay https://cf-relay.xxx.workers.dev -o D:\\dl

  # 3) 带令牌、覆盖文件名、8 线程
  python cfget.py "https://example.com/a.zip" -r https://dl.example.com -t mytoken -n a.zip -j 8

  # 4) 探测文件信息（大小 / 是否支持断点）
  python cfget.py "https://example.com/a.zip" -r https://dl.example.com --info

  # 5) 不走中转，直连（脚本本身就是一个支持断点续传的下载器）
  python cfget.py "https://example.com/a.zip" --no-relay

中转地址也可用环境变量 CF_RELAY / CF_RELAY_TOKEN 预设。
"""

import argparse
import hashlib
import json
import math
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) cfget/1.0"
MIN_PART = 2 * 1024 * 1024      # 每个分块最小 2MB
MAX_PARTS = 256
TIMEOUT = 30
RETRY = 3


# ------------------------------------------------------------------ 基础工具

def build_relay_url(relay, url, name=None, token=None, mode=None):
    """把原始链接包装成 Worker 中转链接"""
    if not relay:
        return url
    base = relay.rstrip("/")
    qs = {"url": url}
    if token:
        qs["token"] = token
    if mode:
        qs["mode"] = mode
    query = urllib.parse.urlencode(qs)
    if name:
        return f"{base}/dl/{urllib.parse.quote(name, safe='')}?{query}"
    return f"{base}/?{query}"


def sanitize(name):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", str(name)).strip().strip(".")
    return name[:200] or "download"


def name_from_url(url):
    try:
        path = urllib.parse.urlparse(url).path
        base = urllib.parse.unquote(path.rstrip("/").split("/")[-1] if path else "")
        if base and "." in base:
            return sanitize(base)
    except Exception:
        pass
    return "download"


def name_from_cd(cd):
    if not cd:
        return ""
    m = re.search(r"filename\*\s*=\s*UTF-8''([^;]+)", cd, re.I)
    if m:
        try:
            return sanitize(urllib.parse.unquote(m.group(1).strip()))
        except Exception:
            pass
    m = re.search(r'filename\s*=\s*"([^"]+)"', cd, re.I) or re.search(r"filename\s*=\s*([^;]+)", cd, re.I)
    if m:
        n = m.group(1).strip().strip('"').strip()
        if n and n != '""':
            return sanitize(n)
    return ""


def human(n):
    if not n:
        return "0B"
    units = ["B", "KB", "MB", "GB", "TB"]
    i = int(math.floor(math.log(n, 1024))) if n > 0 else 0
    i = min(i, len(units) - 1)
    return f"{n / (1024 ** i):.2f}{units[i]}"


def http_open(url, headers=None, range_=None, method="GET"):
    h = {"User-Agent": UA, "Accept": "*/*"}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h, method=method)
    if range_:
        req.add_header("Range", f"bytes={range_[0]}-{range_[1]}")
    return urllib.request.urlopen(req, timeout=TIMEOUT)


def with_retry(fn, times=RETRY, what=""):
    last = None
    for i in range(times):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            last = e
            if i < times - 1:
                time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"{what} failed after {times} tries: {last}")


# -------------------------------------------------------------------- 探测

def probe(url, headers=None):
    """返回 (size, supports_range, filename)"""
    size, supports, fname = None, False, ""
    try:
        r = http_open(url, headers=headers, method="HEAD")
        cd = r.headers.get("Content-Disposition")
        cl = r.headers.get("Content-Length")
        ar = (r.headers.get("Accept-Ranges") or "").lower()
        size = int(cl) if cl and cl.isdigit() else None
        supports = "bytes" in ar
        fname = name_from_cd(cd)
        r.close()
    except Exception:
        pass
    if size is None:  # HEAD 不被支持时，用 1 字节 Range 试探
        try:
            r = http_open(url, headers=headers, range_=(0, 0))
            cr = r.headers.get("Content-Range")  # bytes 0-0/1234
            if cr and "/" in cr:
                total = cr.split("/")[-1]
                if total.isdigit():
                    size = int(total)
                    supports = True
            fname = fname or name_from_cd(r.headers.get("Content-Disposition"))
            r.close()
        except Exception:
            pass
    return size, supports, fname


# -------------------------------------------------------------------- 下载

class Progress:
    def __init__(self, total, done=0):
        self.total = total or 0
        self.done = done
        self.lock = threading.Lock()
        self.t0 = time.time()

    def add(self, n):
        with self.lock:
            self.done += n

    def render(self):
        with self.lock:
            done, total = self.done, self.total
        el = max(time.time() - self.t0, 0.001)
        speed = done / el
        if total:
            pct = done * 100.0 / total
            eta = (total - done) / speed if speed > 0 else 0
            bar_len = 28
            filled = int(bar_len * done / total)
            bar = "#" * filled + "-" * (bar_len - filled)
            sys.stdout.write(
                f"\r[{bar}] {pct:5.1f}%  {human(done)}/{human(total)}  "
                f"{human(speed)}/s  eta {int(eta)}s   "
            )
        else:
            sys.stdout.write(f"\r{human(done)}  {human(speed)}/s          ")
        sys.stdout.flush()


def download_part(url, headers, part, path, prog, bufsize=256 * 1024):
    """part: {"i":n,"start":a,"end":b,"done":d}  —— 支持分块级续传"""
    start = part["start"] + part["done"]
    end = part["end"]
    if start > end:
        return
    fh = open(path, "r+b")
    fh.seek(start)
    try:
        r = http_open(url, headers=headers, range_=(start, end))
        if r.status != 206:
            raise RuntimeError("range not supported by server")
        while True:
            chunk = r.read(bufsize)
            if not chunk:
                break
            fh.write(chunk)
            part["done"] += len(chunk)
            prog.add(len(chunk))
        r.close()
    finally:
        fh.close()


def download_single(url, headers, path, prog):
    """不支持 Range / 未知大小时的顺序下载，支持整体续传"""
    existing = os.path.getsize(path) if os.path.exists(path) else 0
    mode = "ab" if existing else "wb"
    hdrs = dict(headers or {})
    if existing:
        hdrs["Range"] = f"bytes={existing}-"
        prog.done = existing
    fh = open(path, mode)
    try:
        r = http_open(url, headers=hdrs)
        if existing and r.status != 206:  # 服务端不支持续传，从头来
            fh.close()
            fh = open(path, "wb")
            existing = 0
            prog.done = 0
        while True:
            chunk = r.read(256 * 1024)
            if not chunk:
                break
            fh.write(chunk)
            prog.add(len(chunk))
        r.close()
    finally:
        fh.close()


def save_state(path, meta):
    with open(path + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f)


def load_state(path):
    try:
        with open(path + ".json", "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def download(url, out_path, headers=None, threads=4, total=None, supports_range=None):
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    tmp = out_path + ".part"

    if supports_range is None or total is None:
        t, s, _ = probe(url, headers)
        total = total or t
        supports_range = s if supports_range is None else supports_range

    state = load_state(tmp)
    if state and state.get("url") == url and state.get("size") == total:
        parts = state["parts"]
        downloaded = sum(p["done"] for p in parts)
    else:
        downloaded = 0
        parts = []

    use_range = bool(supports_range and total and total > 0)
    if use_range and not parts:
        n = max(1, min(threads, MAX_PARTS, max(1, total // MIN_PART)))
        step = total // n
        parts = []
        for i in range(n):
            a = i * step
            b = (total - 1) if i == n - 1 else (a + step - 1)
            parts.append({"i": i, "start": a, "end": b, "done": 0})

    prog = Progress(total, downloaded)
    if not use_range:
        # 顺序模式：给个兜底 total（可能未知）
        prog = Progress(total or 0, os.path.getsize(tmp) if os.path.exists(tmp) else 0)

    if not os.path.exists(tmp):
        if total:
            with open(tmp, "wb") as f:
                f.truncate(total)
        else:
            open(tmp, "wb").close()

    stop = threading.Event()

    def ticker():
        while not stop.wait(0.5):
            prog.render()

    th = threading.Thread(target=ticker, daemon=True)
    th.start()

    try:
        if use_range:
            todo = [p for p in parts if p["done"] < (p["end"] - p["start"] + 1)]
            failed = []

            def work(p):
                for _ in range(RETRY):
                    try:
                        download_part(url, headers, p, tmp, prog)
                        return
                    except Exception as e:  # noqa: BLE001
                        last = e
                        time.sleep(1.5)
                failed.append((p, last))

            workers = []
            for p in todo:
                t = threading.Thread(target=work, args=(p,))
                t.start()
                workers.append(t)
                if len(workers) >= max(1, threads):
                    for t in workers:
                        t.join()
                    workers = []
            for t in workers:
                t.join()

            if failed:
                raise RuntimeError(f"part {failed[0][0]['i']} failed: {failed[0][1]}")
            save_state(tmp, {"url": url, "size": total, "parts": parts})
        else:
            for i in range(RETRY):
                try:
                    download_single(url, headers, tmp, prog)
                    break
                except Exception:
                    if i == RETRY - 1:
                        raise
                    time.sleep(2)
    finally:
        stop.set()
        th.join()
        prog.render()
        sys.stdout.write("\n")

    actual = os.path.getsize(tmp)
    if total and actual != total:
        print(f"[warn] size mismatch: got {actual}, expected {total}", file=sys.stderr)
    os.replace(tmp, out_path)
    if os.path.exists(tmp + ".json"):
        os.remove(tmp + ".json")
    return out_path


def checksum(path, algo, block=1024 * 1024):
    h = hashlib.new(algo)
    with open(path, "rb") as f:
        while True:
            b = f.read(block)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


# -------------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser(description="通过 Cloudflare Worker 中转下载文件")
    ap.add_argument("url", nargs="+", help="原始下载直链（可多个）")
    ap.add_argument("-r", "--relay", default=os.environ.get("CF_RELAY", ""), help="Worker 中转地址")
    ap.add_argument("-t", "--token", default=os.environ.get("CF_RELAY_TOKEN", ""), help="访问令牌")
    ap.add_argument("-o", "--out", default="", help="输出文件路径（已存在的目录则放入其中）")
    ap.add_argument("-d", "--dir", default="", help="输出目录，文件名自动推断")
    ap.add_argument("-n", "--name", default="", help="覆盖保存的文件名")
    ap.add_argument("-j", "--threads", type=int, default=4, help="分块线程数，默认 4")
    ap.add_argument("-H", "--header", action="append", default=[], help="追加请求头，如 -H 'Referer: https://x.com'")
    ap.add_argument("--no-relay", action="store_true", help="不走中转，直连原始链接")
    ap.add_argument("--print", dest="print_only", action="store_true", help="只打印中转链接")
    ap.add_argument("--info", action="store_true", help="只探测文件信息")
    ap.add_argument("--md5", action="store_true")
    ap.add_argument("--sha256", action="store_true")
    args = ap.parse_args()

    headers = {}
    for h in args.header:
        if ":" in h:
            k, v = h.split(":", 1)
            headers[k.strip()] = v.strip()

    token = args.token
    for raw in args.url:
        relay = "" if args.no_relay else args.relay
        link = build_relay_url(relay, raw, name=args.name or None, token=token or None)

        if args.print_only:
            print(link)
            continue

        print(f"[src]   {raw}")
        if relay:
            print(f"[relay] {link}")

        if args.info:
            info_url = build_relay_url(relay, raw, name=args.name or None, token=token or None, mode="info")
            try:
                r = http_open(info_url, headers=headers)
                print(r.read().decode("utf-8", "replace"))
            except Exception:
                size, sr, fname = probe(link, headers)
                print(json.dumps({"filename": fname or name_from_url(raw),
                                  "content_length": size, "supports_range": sr}, ensure_ascii=False, indent=2))
            continue

        size, supports, fname = probe(link, headers)
        name = args.name or fname or name_from_url(raw)
        name = sanitize(name)

        if args.dir:
            os.makedirs(args.dir, exist_ok=True)
            out_path = os.path.join(args.dir, name)
        elif args.out:
            if os.path.isdir(args.out) or args.out.endswith(("/", "\\")):
                out_path = os.path.join(args.out, name)
            else:
                out_path = args.out
        else:
            out_path = name

        print(f"[file]  {os.path.abspath(out_path)}  ({human(size) if size else 'unknown'})"
              f"  range={'yes' if supports else 'no'}  threads={args.threads}")

        try:
            final = download(link, out_path, headers=headers, threads=args.threads,
                             total=size, supports_range=supports)
        except Exception as e:  # noqa: BLE001
            print(f"[fail]  {e}", file=sys.stderr)
            continue

        print(f"[done]  {final}  {human(os.path.getsize(final))}")
        if args.md5:
            print(f"[md5]   {checksum(final, 'md5')}")
        if args.sha256:
            print(f"[sha256] {checksum(final, 'sha256')}")


if __name__ == "__main__":
    main()
