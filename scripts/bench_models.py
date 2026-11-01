"""opencode 免费模型实测：每个模型跑同一组固定任务，按标准答案或测试自动打分（只用标准库）。

任务（每项 0–1 分，按能拉开差距的难度设计）：
  summary  总结一段有干扰信息的中文通知：要点覆盖、不写进被否决的方案、不超过 3 句
  bugfix   修一个有两处 bug 的解析函数：先看给出的测试，再按没给出的边界测试算通过比例
  extract  从一段邮件里抽嵌套 JSON：日期换格式、金额换算、缺的字段写 null、明细逐行比对
  review   评审一段有两处隐蔽 bug 的代码（死循环、可变默认参数），按找到几处给分
  vision   看一张 3×3 色块图，答出中间和四角的颜色（只给看图模型跑，--vision-all 全跑）

用法：
  python bench_models.py [--models opencode/a,opencode/b] [--tasks summary,review] [--out 结果.json] [--jobs 3] [--timeout 300] [--vision-all]
不给 --models 时取 `opencode models opencode` 列出的全部免费模型。
结果文件里有任务输出原文，默认写到当前目录的 bench-results.json（已在 .gitignore 里），不要提交。
"""
import argparse
import concurrent.futures as cf
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import zlib

IS_WIN = os.name == "nt"
VISION_HINT = ("-vl", "vision", "vl-")


def opencode_exe():
    """Windows 上从 npm 的 opencode.cmd 外壳里读出 opencode.exe 直接起：经 cmd /c 起的话超时只杀得掉 cmd，进程会挂着"""
    if not IS_WIN:
        return ["opencode"]
    shim = shutil.which("opencode.cmd")
    if shim:
        with open(shim, encoding="utf-8", errors="replace") as f:
            m = re.findall(r'"%dp0%\\([^"%]+\.exe)"', f.read())
        exe = os.path.join(os.path.dirname(shim), m[-1]) if m else ""
        if exe and os.path.exists(exe):
            return [exe]
    return ["cmd", "/d", "/c", "opencode"]


OC = opencode_exe()


def opencode(args, stdin, timeout, cwd=None, env=None):
    """跑 opencode run，返回 (退出码, 最终文字, 错误, 秒数)。

    按 opencode 2.x 写：--standalone 起私有服务（常驻服务收不到注入的代理），没有 --dir，目录靠 cwd
    """
    cmd = OC + args
    t0 = time.time()
    try:
        r = subprocess.run(cmd, input=stdin, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=timeout, cwd=cwd, env=env)
    except subprocess.TimeoutExpired:
        return -1, "", "timeout", time.time() - t0
    text, err = parse_events(r.stdout)
    if r.returncode != 0 and not err:
        err = (r.stderr.strip().splitlines() or [f"exit {r.returncode}"])[-1][:200]
    return r.returncode, text, err, time.time() - t0


def parse_events(stdout):
    """--format json 的事件流：取最后一步的文字，没有就取全部文字；error 事件的消息"""
    steps, err = [[]], ""
    for line in stdout.splitlines():
        line = line.lstrip("\ufeff").strip()
        if not line.startswith("{"):
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "step_start":
            steps.append([])
        elif e.get("type") == "text":
            steps[-1].append(e.get("part", {}).get("text", ""))
        elif e.get("type") == "error":
            d = e.get("error", {})
            err = (d.get("data") or {}).get("message") or d.get("name") or "error"
    last = "\n".join(t for t in steps[-1] if t.strip())
    return (last or "\n".join(t for s in steps for t in s if t.strip())).strip(), err


def ro(model, prompt, a, extra=()):
    """只读代理跑一次"""
    return opencode(["run", "-m", model, "--format", "json", "--agent", a.ro_agent, "--standalone", *extra], prompt, a.timeout, env=a.env)


# ---------- 任务 ----------

SUMMARY_TEXT = (
    "各位同事：经过三轮讨论，公司决定把年会从原定的 12 月 20 日推迟到 1 月 10 日，地点仍在滨江会展中心二号厅。"
    "此前有人提议改去郊区度假村，因为预算超支约 8 万元，这个方案已经被否决。"
    "推迟的主要原因是 12 月底有两个大客户项目要交付，研发和交付团队无法脱身。"
    "报名截止时间相应顺延到 12 月 31 日，每人可以带一位家属，但家属需要自费 200 元。"
    "节目征集仍由行政部的小林负责，上周发的报名表继续有效，不用重新填写。"
)
# 每组里出现任意一个就算覆盖
SUMMARY_KEYS = [("1 月 10", "1月10", "一月十"), ("推迟", "延期", "改期"), ("交付", "项目"),
                ("12 月 31", "12月31", "截止"), ("家属", "200")]
SUMMARY_WRONG = ("度假村",)  # 被否决的方案不该当成结论写进去


def task_summary(model, a):
    prompt = f"用不超过三句中文总结下面这份通知，只写对员工有用的结论，只输出总结本身。\n\n{SUMMARY_TEXT}"
    code, text, err, secs = ro(model, prompt, a)
    hit = sum(any(k in text for k in keys) for keys in SUMMARY_KEYS) / len(SUMMARY_KEYS)
    sentences = len([x for x in re.split(r"[。！？!?\n]+", text) if x.strip()])
    wrong = any(w in text and not re.search(r"否决|不去|取消|不再", text) for w in SUMMARY_WRONG)
    score = hit * (0.5 if sentences > 3 else 1) * (0.5 if wrong else 1)
    return round(score, 2), secs, err, text


BUG_SRC = '''import re


def parse_duration(s):
    """把 "1h30m"、"45s"、"2h"、"1h 5m 10s" 这样的时长换成秒数。

    单位只有 h、m、s，可以有空格，大小写不限；空串或格式不对抛 ValueError。
    """
    total = 0
    for num, unit in re.findall(r"(\\d+)([hms])", s):
        total += int(num) * {"h": 3600, "m": 600, "s": 1}[unit]
    return total
'''
BUG_TEST = '''import unittest
from duration import parse_duration


class T(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(parse_duration("1h30m"), 5400)
        self.assertEqual(parse_duration("45s"), 45)

    def test_bad(self):
        with self.assertRaises(ValueError):
            parse_duration("abc")


if __name__ == "__main__":
    unittest.main()
'''
# 不给模型看的边界测试：(输入, 期望秒数或 ValueError)
BUG_HIDDEN = [("2h", 7200), ("1h 5m 10s", 3910), ("10M", 600), ("", ValueError), ("5x", ValueError),
              ("3m 3", ValueError), ("0s", 0), ("90m", 5400)]


def task_bugfix(model, a):
    d = tempfile.mkdtemp(prefix="bench_fix_")
    try:
        with open(os.path.join(d, "duration.py"), "w", encoding="utf-8") as f:
            f.write(BUG_SRC)
        with open(os.path.join(d, "test_duration.py"), "w", encoding="utf-8") as f:
            f.write(BUG_TEST)
        for g in (["init", "-q"], ["add", "."], ["-c", "user.email=b@b", "-c", "user.name=b", "commit", "-qm", "init"]):
            subprocess.run(["git", *g], cwd=d, capture_output=True)
        prompt = ("test_duration.py 里的测试没通过。修好 duration.py，让它完全符合函数说明（说明里提到的情况都要对，"
                  "不只是现有测试）。不要改 test_duration.py。改完运行 `python -m unittest test_duration` 检查，最后说明改了什么。")
        code, text, err, secs = opencode(["run", "-m", model, "--format", "json", "--agent", a.rw_agent, "--standalone"],
                                         prompt, a.timeout, cwd=d, env=a.env)
        with open(os.path.join(d, "test_duration.py"), encoding="utf-8") as f:
            if f.read() != BUG_TEST:
                return 0.0, secs, err or "改了测试文件", text
        if subprocess.run([sys.executable, "-m", "unittest", "test_duration"], cwd=d, capture_output=True).returncode != 0:
            return 0.0, secs, err or "给出的测试没过", text
        check = ("import json, duration\nout = []\n"
                 f"for s, want in {[(s, w if isinstance(w, int) else 'ValueError') for s, w in BUG_HIDDEN]!r}:\n"
                 "    try:\n        got = duration.parse_duration(s)\n    except ValueError:\n        got = 'ValueError'\n"
                 "    except Exception as e:\n        got = type(e).__name__\n"
                 "    out.append(got == want)\nprint(json.dumps(out))\n")
        r = subprocess.run([sys.executable, "-c", check], cwd=d, capture_output=True, text=True, timeout=30)
        try:
            passed = json.loads(r.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            return 0.0, secs, err or "边界测试跑不起来", text
        return round(0.3 + 0.7 * sum(passed) / len(passed), 2), secs, err, text
    finally:
        shutil.rmtree(d, ignore_errors=True)


EXTRACT_TEXT = (
    "Hi team, confirming PO-7731 from Brightline GmbH (contact: Jonas Weber), sent on 3 Nov 2026.\n"
    "- 12 x USB-C dock, EUR 89.90 each\n"
    "- 4 x 27\" monitor arm, EUR 45 each\n"
    "- 1 x installation service, flat EUR 150\n"
    "Ship to: Hamburg, Germany. Payment terms net 30. No discount this time."
)
EXTRACT_WANT = {
    "po": "PO-7731", "company": "Brightline GmbH", "contact": "Jonas Weber", "date": "2026-11-03",
    "currency": "EUR", "city": "Hamburg", "country": "Germany", "payment_days": 30, "discount": None,
    "total": 1408.8,
    "items": [{"name": "USB-C dock", "qty": 12, "unit_price": 89.9},
              {"name": "27\" monitor arm", "qty": 4, "unit_price": 45},
              {"name": "installation service", "qty": 1, "unit_price": 150}],
}


def _same(g, v):
    if v is None:
        return g is None
    if isinstance(v, (int, float)):
        try:
            return abs(float(g) - v) < 0.01
        except (TypeError, ValueError):
            return False
    norm = lambda x: re.sub(r"[^a-z0-9]", "", str(x).lower())
    return norm(g) == norm(v)


def task_extract(model, a):
    prompt = ("Extract one JSON object with exactly these keys: po, company, contact, date (YYYY-MM-DD), currency (ISO code), "
              "city, country, payment_days (number), discount (number, or null if none), total (number: sum of all lines), "
              "items (array of {name, qty, unit_price}). Output only the JSON.\n\n" + EXTRACT_TEXT)
    code, text, err, secs = ro(model, prompt, a)
    m = re.search(r"\{.*\}", text, re.S)
    try:
        got = json.loads(m.group(0)) if m else {}
    except ValueError:
        got = {}
    flat = [k for k in EXTRACT_WANT if k != "items"]
    ok = sum(_same(got.get(k), EXTRACT_WANT[k]) for k in flat)
    items = got.get("items") if isinstance(got.get("items"), list) else []
    for i, want in enumerate(EXTRACT_WANT["items"]):
        g = items[i] if i < len(items) and isinstance(items[i], dict) else {}
        ok += sum(_same(g.get(k), want[k]) for k in want) / len(want)
    return round(ok / (len(flat) + len(EXTRACT_WANT["items"])), 2), secs, err, text


REVIEW_SRC = '''def first_at_least(xs, target):
    """xs 已升序。返回第一个 >= target 的下标，都比它小就返回 len(xs)。"""
    lo, hi = 0, len(xs)
    while lo < hi:
        mid = (lo + hi) // 2
        if xs[mid] < target:
            lo = mid
        else:
            hi = mid
    return lo


def collect(tag, bucket=[]):
    """把 tag 加进 bucket 并返回；不传 bucket 时每次从空列表开始。"""
    bucket.append(tag)
    return bucket
'''
REVIEW_BUGS = [
    r"lo\s*=\s*mid\s*\+\s*1|死循环|无限循环|infinite loop|never terminat|loops? forever",
    r"可变默认|默认参数|mutable default|default (argument|parameter|value).{0,40}(shared|persist|mutable|list)|bucket\s*=\s*none|=\s*None",
]


def task_review(model, a):
    prompt = ("评审下面的 Python 代码，只列出真正的 bug：每个 bug 写出所在函数、会出什么问题、怎么改。简短。\n\n"
              f"```python\n{REVIEW_SRC}```")
    code, text, err, secs = ro(model, prompt, a)
    low = text.lower()
    found = sum(bool(re.search(p, low)) for p in REVIEW_BUGS)
    return round(found / len(REVIEW_BUGS), 2), secs, err, text


GRID = [["red", "blue", "yellow"], ["blue", "green", "blue"], ["black", "blue", "white"]]
RGB = {"red": b"\xff\x00\x00", "blue": b"\x00\x00\xff", "yellow": b"\xff\xff\x00", "green": b"\x00\xb0\x00",
       "black": b"\x00\x00\x00", "white": b"\xff\xff\xff"}
ZH = {"red": "红", "blue": "蓝", "yellow": "黄", "green": "绿", "black": "黑", "white": "白"}


def png(path, cell=32):
    """3×3 色块 PNG"""
    w = h = cell * 3
    rows = b"".join(b"\x00" + b"".join(RGB[GRID[y // cell][x // cell]] for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def task_vision(model, a):
    d = tempfile.mkdtemp(prefix="bench_img_")
    try:
        p = os.path.join(d, "img.png")
        png(p)
        prompt = ("The attached image is a 3x3 grid of colored squares. Answer with JSON only: "
                  '{"center": color, "top_left": color, "top_right": color, "bottom_left": color, "bottom_right": color}, '
                  "using one English color word each.")
        code, text, err, secs = ro(model, prompt, a, ["-f", p, "--"])  # -f 直接附图，不经 read 工具
        m = re.search(r"\{.*\}", text, re.S)
        try:
            got = {k: str(v).lower() for k, v in json.loads(m.group(0)).items()} if m else {}
        except (ValueError, AttributeError):
            got = {}
        want = {"center": GRID[1][1], "top_left": GRID[0][0], "top_right": GRID[0][2],
                "bottom_left": GRID[2][0], "bottom_right": GRID[2][2]}
        ok = sum(w in got.get(k, "") or ZH[w] in got.get(k, "") for k, w in want.items())
        return round(ok / len(want), 2), secs, err, text
    finally:
        shutil.rmtree(d, ignore_errors=True)


TASKS = {"summary": task_summary, "bugfix": task_bugfix, "extract": task_extract, "review": task_review, "vision": task_vision}


def run_model(model, a):
    names = [t for t in a.tasks if t != "vision" or a.vision_all or any(h in model for h in VISION_HINT)]
    out = {}
    for name in names:
        try:
            score, secs, err, text = TASKS[name](model, a)
        except Exception as ex:  # noqa: BLE001 单个任务出错不影响别的
            score, secs, err, text = 0.0, 0.0, str(ex)[:200], ""
        out[name] = {"score": score, "secs": round(secs, 1), "error": err, "output": text[:2000]}
        print(f"{model:42} {name:8} {score:4.2f} {secs:6.1f}s {err[:60]}", flush=True)
    return model, out


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--models", help="逗号分隔的模型；默认取 opencode 的全部免费模型")
    p.add_argument("--tasks", default=",".join(TASKS), help="逗号分隔的任务")
    p.add_argument("--out", default="bench-results.json")
    p.add_argument("--jobs", type=int, default=3, help="同时跑几个模型")
    p.add_argument("--timeout", type=int, default=300, help="每个任务的超时秒数")
    p.add_argument("--vision-all", action="store_true", help="看图任务也给名字里不带 vl 的模型跑")
    a = p.parse_args()
    a.tasks = [t for t in a.tasks.split(",") if t in TASKS]
    # 和 auto-router 派活时一样：不读用户全局的 opencode 配置（MCP、插件、全局 AGENTS.md）和 ~/.claude 下的技能；
    # 权限先全部 deny 再放开读和搜索，可写的再放开 edit 和 bash（不继承用户的 "ask"，否则 opencode run 会卡住）
    a.ro_agent, a.rw_agent = "bench-readonly", "bench-write"
    base = {"*": "deny", "read": {"*": "allow", "*.env": "deny", "*.env.*": "deny"}, "grep": "allow", "glob": "allow", "list": "allow"}
    agents = {
        a.ro_agent: {"mode": "primary", "description": "bench read-only", "permission": base},
        a.rw_agent: {"mode": "primary", "description": "bench write", "permission": {
            **base, "edit": "allow", "todowrite": "allow",
            "bash": {"*": "allow", **{p: "deny" for p in (
                "git commit*", "git push*", "git reset*", "git clean*", "rm -r*", "rm -fr*",
                "Remove-Item*-Recurse*", "rd /s*", "rmdir /s*", "del /s*", "Format-Volume*")}}}},
    }
    home = os.path.join(tempfile.gettempdir(), "bench-opencode-config")
    os.makedirs(home, exist_ok=True)
    a.env = {**os.environ, "XDG_CONFIG_HOME": home, "OPENCODE_DISABLE_CLAUDE_CODE": "1",
             "OPENCODE_DISABLE_AUTOUPDATE": "1",
             "OPENCODE_CONFIG_CONTENT": json.dumps({"agent": agents})}
    if a.models:
        models = [m.strip() for m in a.models.split(",") if m.strip()]
    else:
        # 顺带让隔离的配置目录先装好依赖（第一次要一会儿），免得第一个任务超时
        listed = subprocess.run(OC + ["models", "--standalone"], capture_output=True, text=True, encoding="utf-8",
                                errors="replace", env=a.env, timeout=300).stdout.split()
        models = [m for m in listed if m.startswith("opencode/")]
    results = {}
    with cf.ThreadPoolExecutor(max_workers=max(1, a.jobs)) as pool:
        for model, out in pool.map(lambda m: run_model(m, a), models):
            results[model] = out
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"at": time.strftime("%Y-%m-%d %H:%M"), "results": results}, f, ensure_ascii=False, indent=1)

    cols = a.tasks
    print("\n| 模型 | " + " | ".join(cols) + " | 平均分 | 平均耗时 |")
    print("|---|" + "---|" * (len(cols) + 2))
    for model, out in sorted(results.items(), key=lambda kv: -sum(v["score"] for v in kv[1].values()) / max(1, len(kv[1]))):
        cells = [f"{out[c]['score']:.2f}" if c in out else "–" for c in cols]
        avg = sum(v["score"] for v in out.values()) / max(1, len(out))
        secs = sum(v["secs"] for v in out.values()) / max(1, len(out))
        print(f"| {model} | " + " | ".join(cells) + f" | {avg:.2f} | {secs:.0f}s |")
    print(f"\n结果原文：{a.out}")


if __name__ == "__main__":
    main()
