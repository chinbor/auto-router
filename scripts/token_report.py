"""统计 Claude Code 会话记录里的 token 用量（只用标准库）。

读取 ~/.claude/projects/*/*.jsonl（含子代理记录），按每次 API 调用的 usage 汇总：
  - 每个会话：总量、调用次数、用户发言数、平均每次调用的输入、最大上下文
  - 返回内容最大的工具调用 Top N（Read / 网页 / 图片 / Bash ...）
  - 更公平的对比指标（不受会话长短影响，取各会话中位数）：
      第一轮输入：主会话第一次调用的输入，反映系统提示、规则、工具清单等固定开销
      同轮次输入：主会话第 10 / 30 / 60 次调用时的输入，只统计调用次数够多的会话

用法：
  python token_report.py --days 7
  python token_report.py --days 7 --save baseline.json      # 存一份数字，供以后对比
  python token_report.py --days 1 --compare baseline.json   # 和基线对比
  python token_report.py --session <会话 id 前缀>             # 只看一个会话
  python token_report.py --days 7 --until 2026-10-20T13:19  # 统计截止到某个时刻的窗口（重算旧基线用）
  python token_report.py --days 4 --first-turn-breakdown     # 另外列出第一轮输入由哪些部分组成
  python token_report.py --days 4 --context-composition 5    # 上下文最大的 5 个会话，峰值时上下文由什么组成
"""
import argparse
import base64
import collections
import datetime as dt
import glob
import json
import os
import statistics
import struct
import sys

# Claude Code 的会话记录；设了 CLAUDE_CONFIG_DIR 时在它下面，也可以用 --projects 指定
PROJECTS = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "projects")
CTX_AT = (10, 30, 60)  # 同轮次对比取主会话第几次调用


def parse_ts(s):
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def image_dims(b64):
    """从 base64 图片头部读出宽高（PNG / JPEG / GIF / WEBP），失败返回 None。"""
    try:
        head = base64.b64decode(b64[:200000] + "=" * (-len(b64[:200000]) % 4))
    except Exception:
        return None
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", head[16:24])
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return struct.unpack("<HH", head[6:10])
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        if head[12:16] == b"VP8X":
            w = int.from_bytes(head[24:27], "little") + 1
            h = int.from_bytes(head[27:30], "little") + 1
            return w, h
        return None
    if head[:2] == b"\xff\xd8":
        i = 2
        while i < len(head) - 9:
            if head[i] != 0xFF:
                i += 1
                continue
            marker = head[i + 1]
            if marker in (0xC0, 0xC1, 0xC2):
                h, w = struct.unpack(">HH", head[i + 5:i + 9])
                return w, h
            seg = struct.unpack(">H", head[i + 2:i + 4])[0]
            i += 2 + seg
    return None


def image_tokens(dims):
    """粗估一张图的 token：长边缩到 1568 后按 宽×高/750。"""
    if not dims:
        return 1600
    w, h = dims
    s = min(1.0, 1568 / max(w, h, 1))
    return int(w * s * h * s / 750)


def result_size(content):
    """工具返回内容 -> (字符数, 估算 token, 图片数)。文本按 3 字符≈1 token 粗估。"""
    chars, toks, imgs = 0, 0, 0
    if isinstance(content, str):
        return len(content), len(content) // 3, 0
    if isinstance(content, list):
        for c in content:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "text":
                n = len(c.get("text", ""))
                chars += n
                toks += n // 3
            elif c.get("type") == "image":
                data = (c.get("source") or {}).get("data", "")
                imgs += 1
                toks += image_tokens(image_dims(data))
    return chars, toks, imgs


def describe_input(name, inp):
    if not isinstance(inp, dict):
        return ""
    for k in ("file_path", "url", "urls", "command", "pattern", "query", "objective", "search_queries",
              "path", "prompt", "id"):
        if inp.get(k):
            v = str(inp[k]).replace("\n", " ")
            extra = ""
            if k == "file_path" and (inp.get("offset") or inp.get("limit")):
                extra = " [分段]"
            if inp.get("full_content"):
                extra = " [整页]"
            return (v[:70] + ("…" if len(v) > 70 else "")) + extra
    return ""


def session_files(since, session):
    cutoff = since.timestamp()
    out = []
    for f in glob.glob(os.path.join(PROJECTS, "**", "*.jsonl"), recursive=True):
        if os.path.getmtime(f) < cutoff:
            continue
        rel = os.path.relpath(f, PROJECTS).replace("\\", "/").split("/")
        # 主会话: <proj>/<sid>.jsonl ；子代理: <proj>/<sid>/subagents/<agent>.jsonl
        sid = rel[1][:-6] if len(rel) == 2 else rel[1]
        if session and not sid.startswith(session):
            continue
        out.append((f, rel[0], sid, len(rel) > 2))
    return out


def collect(days, session, until=None):
    until = until or dt.datetime.now(dt.timezone.utc)
    since = until - dt.timedelta(days=days)
    sessions = {}
    tools = []
    for f, proj, sid, is_sub in session_files(since, session):
        s = sessions.setdefault(sid, {
            "project": proj, "title": "", "calls": 0, "prompts": 0, "input": 0,
            "cache_read": 0, "cache_write": 0, "output": 0, "max_ctx": 0,
            "sub_calls": 0, "first": None, "last": None,
            "main_in": 0, "main_out": 0, "sub_in": 0, "sub_out": 0, "agents": set(),
            "main_seq": [], "started_in_window": None})
        seen = {}  # 消息 id -> 已计入的输出 token；同一条消息会分多行写入，输出数以最大的那行为准
        uses = {}
        try:
            fh = open(f, encoding="utf-8")
        except OSError:
            continue
        with fh:
            for ln in fh:
                try:
                    d = json.loads(ln)
                except Exception:
                    continue
                t = d.get("type")
                if t == "custom-title" and not is_sub:
                    s["title"] = d.get("customTitle", "")
                    continue
                ts = parse_ts(d.get("timestamp", "")) if d.get("timestamp") else None
                if ts is None or ts > until:
                    continue
                if ts < since:
                    # 会话开头在窗口之前：第一轮 / 同轮次指标对它不成立
                    if t == "assistant" and not is_sub:
                        s["started_in_window"] = False
                    continue
                msg = d.get("message") or {}
                if t == "assistant":
                    for c in msg.get("content") or []:
                        if isinstance(c, dict) and c.get("type") == "tool_use":
                            uses[c.get("id")] = (c.get("name"), c.get("input"))
                    key = msg.get("id") or d.get("requestId")
                    u = msg.get("usage")
                    if not u:
                        continue
                    i, r, w, o = (u.get("input_tokens", 0) or 0, u.get("cache_read_input_tokens", 0) or 0,
                                  u.get("cache_creation_input_tokens", 0) or 0, u.get("output_tokens", 0) or 0)
                    if key in seen:
                        extra = o - seen[key]
                        if extra > 0:
                            seen[key] = o
                            s["output"] += extra
                            s["sub_out" if is_sub else "main_out"] += extra
                        continue
                    seen[key] = o
                    s["calls"] += 1
                    if is_sub:
                        s["sub_calls"] += 1
                        s["sub_in"] += i + r + w
                        s["sub_out"] += o
                        s["agents"].add(os.path.basename(f)[:-6])
                    else:
                        s["main_in"] += i + r + w
                        s["main_out"] += o
                        s["main_seq"].append(i + r + w)
                        if s["started_in_window"] is None:
                            s["started_in_window"] = True
                    s["input"] += i
                    s["cache_read"] += r
                    s["cache_write"] += w
                    s["output"] += o
                    if not is_sub:
                        s["max_ctx"] = max(s["max_ctx"], i + r + w)
                    s["first"] = min(s["first"] or ts, ts)
                    s["last"] = max(s["last"] or ts, ts)
                elif t == "user":
                    content = msg.get("content")
                    if isinstance(content, str) and not is_sub and not d.get("isMeta"):
                        s["prompts"] += 1
                    elif isinstance(content, list):
                        has_tr = False
                        for c in content:
                            if isinstance(c, dict) and c.get("type") == "tool_result":
                                has_tr = True
                                chars, toks, imgs = result_size(c.get("content"))
                                name, inp = uses.get(c.get("tool_use_id"), ("?", None))
                                tools.append({"session": sid, "tool": name, "target": describe_input(name, inp),
                                              "chars": chars, "tokens": toks, "images": imgs, "sub": is_sub})
                        if not has_tr and not is_sub and not d.get("isMeta"):
                            s["prompts"] += 1
    sessions = {k: v for k, v in sessions.items() if v["calls"]}
    return sessions, tools


ATTACH_LABELS = {
    "skill_listing": "首条消息：技能清单", "mcp_instructions_delta": "首条消息：MCP 服务说明",
    "deferred_tools_delta": "首条消息：延迟工具名单", "agent_listing_delta": "首条消息：子代理清单",
    "instructions": "首条消息：CLAUDE.md / 记忆", "environment": "首条消息：环境信息",
}


def est_tokens(text):
    """粗估文本 token：ASCII 约 3.5 字符 1 token，中文等约 1 字 1 token。只用来算占比。"""
    ascii_n = sum(1 for ch in text if ord(ch) < 128)
    return int(ascii_n / 3.5 + (len(text) - ascii_n))


def first_turn_parts(path):
    """读一个主会话到第一次有 usage 的调用为止，拆出第一轮输入的组成。
    依赖记录里的 api-request-shape（系统提示和工具定义）和 attachment（首条消息里的附件）；
    没有 shape 或会话开头就是压缩摘要的返回 None。"""
    shape, parts, actual = None, collections.Counter(), 0
    tool_sizes = {}
    try:
        fh = open(path, encoding="utf-8")
    except OSError:
        return None
    with fh:
        for ln in fh:
            try:
                d = json.loads(ln)
            except Exception:
                continue
            t = d.get("type")
            if t == "system" and d.get("subtype") == "compact_boundary":
                return None
            if t == "api-request-shape" and shape is None:
                shape = d.get("shape") or {}
            elif t == "attachment":
                a = d.get("attachment") or {}
                r = d.get("rendered")
                if r:
                    text = r if isinstance(r, str) else json.dumps(r, ensure_ascii=False)
                    parts[ATTACH_LABELS.get(a.get("type"), "首条消息：其他附件")] += est_tokens(text)
            elif t == "user" and not d.get("isMeta"):
                c = (d.get("message") or {}).get("content")
                if isinstance(c, str):
                    parts["首条消息：用户发言"] += est_tokens(c)
                elif isinstance(c, list):
                    parts["首条消息：用户发言"] += sum(est_tokens(x.get("text", "")) for x in c
                                                  if isinstance(x, dict) and x.get("type") == "text")
            elif t == "assistant":
                u = (d.get("message") or {}).get("usage")
                if u:
                    actual = (u.get("input_tokens", 0) or 0) + (u.get("cache_read_input_tokens", 0) or 0) \
                        + (u.get("cache_creation_input_tokens", 0) or 0)
                    break
    if not shape or not actual:
        return None
    parts["系统提示词"] = sum(est_tokens(b.get("text", "")) for b in shape.get("system") or [] if isinstance(b, dict))
    for tool in shape.get("tools") or []:
        name = tool.get("name", "?")
        n = est_tokens(json.dumps(tool, ensure_ascii=False))
        tool_sizes[name] = n
        group = f"工具定义：MCP {name.split('__')[1][:12]}" if name.startswith("mcp__") else "工具定义：内置"
        parts[group] += n
    return actual, parts, tool_sizes


def first_turn_breakdown(days, session, until=None):
    until = until or dt.datetime.now(dt.timezone.utc)
    since = until - dt.timedelta(days=days)
    rows = [r for f, _, _, is_sub in session_files(since, session) if not is_sub for r in [first_turn_parts(f)] if r]
    if not rows:
        print("\n-- 第一轮开销拆分：窗口内没有带 api-request-shape 的会话记录 --")
        return
    n = len(rows)
    actual = sum(r[0] for r in rows) / n
    cats = collections.Counter()
    tools = collections.Counter()
    tool_seen = collections.Counter()
    for _, parts, ts in rows:
        cats.update(parts)
        tools.update(ts)
        tool_seen.update(ts.keys())
    est = sum(cats.values()) / n
    print(f"\n-- 第一轮开销拆分（{n} 个会话，实际第一轮输入平均 {fmt(int(actual))}，按字符估算合计 {fmt(int(est))}）--")
    print("  各项先按字符粗估，再等比换算到实际输入，只用来看占比。")
    scale = actual / max(est, 1)
    for k, v in sorted(cats.items(), key=lambda kv: -kv[1]):
        avg = v / n
        print(f"  {k:<28}{fmt(int(avg * scale)):>7}  {avg * scale / actual * 100:5.1f}%")
    print("  最大的工具定义（估算，未换算）：" + "，".join(
        f"{k} {fmt(v // tool_seen[k])}" for k, v in sorted(tools.items(), key=lambda kv: -kv[1] / tool_seen[kv[0]])[:10]))


def context_at_peak(path):
    """按时间顺序重建一个主会话的上下文，返回上下文最大那次调用时各类内容的估算 token。
    遇到压缩（compact_boundary）就清空重来。系统提示和工具定义不在记录里，
    用每段第一次调用的实际输入减去已知内容估出“固定开销”。
    思考：记录里看不到完整思考文本时，用输出 token 减去可见内容反推。"""
    comp = collections.Counter()
    fixed = None
    peak, peak_comp, calls = 0, None, 0
    msg = {"id": None, "out": 0, "visible": 0}

    def close_msg():
        if msg["id"] is not None:
            comp["Claude：思考（按输出反推）"] += max(0, msg["out"] - msg["visible"])
        msg.update(id=None, out=0, visible=0)

    try:
        fh = open(path, encoding="utf-8")
    except OSError:
        return None
    with fh:
        for ln in fh:
            try:
                d = json.loads(ln)
            except Exception:
                continue
            t = d.get("type")
            m = d.get("message") or {}
            if t == "system" and d.get("subtype") == "compact_boundary":
                close_msg()
                comp, fixed = collections.Counter(), None
                continue
            if t == "attachment":
                r = d.get("rendered")
                if r:
                    comp["系统附件 / 提醒"] += est_tokens(r if isinstance(r, str) else json.dumps(r, ensure_ascii=False))
                continue
            if t == "user":
                c = m.get("content")
                label = "压缩摘要" if d.get("isCompactSummary") else ("系统附件 / 提醒" if d.get("isMeta") else "你的消息：文字")
                if isinstance(c, str):
                    comp[label] += est_tokens(c)
                    continue
                for x in c or []:
                    if not isinstance(x, dict):
                        continue
                    if x.get("type") == "text":
                        comp[label] += est_tokens(x.get("text", ""))
                    elif x.get("type") == "image":
                        comp["你的消息：图片"] += image_tokens(image_dims((x.get("source") or {}).get("data", "")))
                    elif x.get("type") == "tool_result":
                        rc = x.get("content")
                        name = tool_names.get(x.get("tool_use_id"), "?")
                        if isinstance(rc, str):
                            comp[f"工具返回：{name}"] += est_tokens(rc)
                        else:
                            for y in rc or []:
                                if isinstance(y, dict) and y.get("type") == "text":
                                    comp[f"工具返回：{name}"] += est_tokens(y.get("text", ""))
                                elif isinstance(y, dict) and y.get("type") == "image":
                                    comp["工具返回：图片"] += image_tokens(image_dims((y.get("source") or {}).get("data", "")))
                continue
            if t != "assistant":
                continue
            key = m.get("id") or d.get("requestId")
            u = m.get("usage") or {}
            if key != msg["id"]:
                close_msg()
                msg["id"] = key
                ctx = (u.get("input_tokens", 0) or 0) + (u.get("cache_read_input_tokens", 0) or 0) \
                    + (u.get("cache_creation_input_tokens", 0) or 0)
                if ctx:
                    calls += 1
                    if fixed is None:
                        fixed = max(0, ctx - sum(comp.values()))
                    if ctx > peak:
                        peak, peak_comp = ctx, collections.Counter(comp, **{"固定开销（系统提示 + 工具定义）": fixed})
            msg["out"] = max(msg["out"], u.get("output_tokens", 0) or 0)
            for x in m.get("content") or []:
                if not isinstance(x, dict):
                    continue
                if x.get("type") == "text":
                    n = est_tokens(x.get("text", ""))
                    comp["Claude：回复文字"] += n
                elif x.get("type") == "thinking":
                    n = est_tokens(x.get("thinking", ""))
                    comp["Claude：思考（按输出反推）"] += n
                elif x.get("type") == "tool_use":
                    tool_names[x.get("id")] = x.get("name")
                    n = est_tokens(json.dumps(x.get("input"), ensure_ascii=False))
                    comp[f"Claude：调用参数 {x.get('name')}"] += n
                else:
                    n = 0
                msg["visible"] += n
    return (peak, peak_comp, calls) if peak_comp else None


tool_names = {}


def context_composition(sessions, days, session, until=None, top=3):
    """对上下文最大的几个主会话，打印峰值时上下文的组成。"""
    until = until or dt.datetime.now(dt.timezone.utc)
    since = until - dt.timedelta(days=days)
    files = {sid: f for f, _, sid, is_sub in session_files(since, session) if not is_sub}
    picked = sorted((sid for sid in sessions if sid in files), key=lambda s: -sessions[s]["max_ctx"])[:top]
    for sid in picked:
        r = context_at_peak(files[sid])
        if not r:
            continue
        peak, comp, calls = r
        est = sum(comp.values())
        print(f"\n-- 上下文组成：{sid[:8]} {(sessions[sid]['title'] or '-')[:20]}，峰值 {fmt(peak)}，"
              f"估算合计 {fmt(est)}（{est / peak * 100:.0f}%），共 {calls} 次调用 --")
        groups = collections.Counter()
        for k, v in comp.items():
            if k.startswith("Claude：调用参数"):
                k = "Claude：调用参数"
            elif k.startswith("工具返回：") and k != "工具返回：图片":
                k = "工具返回：文字"
            groups[k] += v
        for k, v in sorted(groups.items(), key=lambda kv: -kv[1]):
            if v >= peak * 0.005:
                print(f"  {k:<26}{fmt(v):>7}  {v / peak * 100:5.1f}%")
        detail = [(k, v) for k, v in comp.items() if (k.startswith("工具返回：") and k != "工具返回：图片")
                  or k.startswith("Claude：调用参数")]
        print("  其中最大的：" + "，".join(f"{k.split('：')[1]} {fmt(v)}" for k, v in sorted(detail, key=lambda kv: -kv[1])[:8]))


def fmt(n):
    if n >= 1_000_000:
        return f"{n / 1e6:.1f}M"
    if n >= 1000:
        return f"{n / 1e3:.0f}k"
    return str(n)


def summarize(sessions, tools):
    tot = collections.Counter()
    for s in sessions.values():
        for k in ("calls", "prompts", "input", "cache_read", "cache_write", "output"):
            tot[k] += s[k]
    inp = tot["input"] + tot["cache_read"] + tot["cache_write"]
    by_tool = collections.Counter()
    for t in tools:
        by_tool[t["tool"]] += t["tokens"]
    full = [s["main_seq"] for s in sessions.values() if s["started_in_window"] and s["main_seq"]]
    ctx_at = {}
    for n in CTX_AT:
        vals = [seq[n - 1] for seq in full if len(seq) >= n]
        ctx_at[str(n)] = {"median": int(statistics.median(vals)) if vals else 0, "sessions": len(vals)}
    return {
        "first_turn_input": int(statistics.median(seq[0] for seq in full)) if full else 0,
        "first_turn_sessions": len(full),
        "ctx_at_call": ctx_at,
        "sessions": len(sessions), "calls": tot["calls"], "prompts": tot["prompts"],
        "input_total": inp, "output_total": tot["output"],
        "cache_read": tot["cache_read"], "cache_write": tot["cache_write"], "uncached_input": tot["input"],
        "avg_input_per_call": inp // max(tot["calls"], 1),
        "avg_input_per_prompt": inp // max(tot["prompts"], 1),
        "max_ctx": max((s["max_ctx"] for s in sessions.values()), default=0),
        "tool_result_tokens": dict(by_tool.most_common()),
    }


def main():
    ap = argparse.ArgumentParser(description="Claude Code token 用量报告")
    ap.add_argument("--days", type=float, default=7)
    ap.add_argument("--session", help="只看 id 以此开头的会话")
    ap.add_argument("--top", type=int, default=20, help="最耗 token 的工具调用条数")
    ap.add_argument("--max-sessions", type=int, default=15)
    ap.add_argument("--save", help="把汇总数字存成 JSON")
    ap.add_argument("--compare", help="和之前 --save 的 JSON 对比")
    ap.add_argument("--split", action="store_true", help="每个会话分开列出主会话和子代理的输入 / 输出")
    ap.add_argument("--projects", help="会话记录目录，默认 $CLAUDE_CONFIG_DIR/projects 或 ~/.claude/projects")
    ap.add_argument("--until", help="窗口截止时刻（本地时间，如 2026-10-20T13:19），默认现在")
    ap.add_argument("--first-turn-breakdown", action="store_true",
                    help="拆分第一轮输入：系统提示、各组工具定义、技能清单、MCP 说明、CLAUDE.md 等各占多少")
    ap.add_argument("--context-composition", type=int, nargs="?", const=3, metavar="N",
                    help="列出上下文最大的 N 个会话（默认 3）在峰值时，上下文由哪些内容组成")
    a = ap.parse_args()
    if a.projects:
        global PROJECTS
        PROJECTS = a.projects

    until = dt.datetime.fromisoformat(a.until).astimezone(dt.timezone.utc) if a.until else None
    sessions, tools = collect(a.days, a.session, until)
    summ = summarize(sessions, tools)

    end = f"截至 {a.until} 的" if a.until else "最近 "
    print(f"== {end}{a.days:g} 天：{summ['sessions']} 个会话，{summ['calls']} 次调用，{summ['prompts']} 条用户发言 ==")
    print(f"输入合计 {fmt(summ['input_total'])}（缓存读 {fmt(summ['cache_read'])} / 缓存写 {fmt(summ['cache_write'])}"
          f" / 未缓存 {fmt(summ['uncached_input'])}），输出 {fmt(summ['output_total'])}")
    print(f"平均每次调用输入 {fmt(summ['avg_input_per_call'])}，平均每条发言输入 {fmt(summ['avg_input_per_prompt'])}，"
          f"最大上下文 {fmt(summ['max_ctx'])}")
    print(f"第一轮输入（中位数，{summ['first_turn_sessions']} 个会话）{fmt(summ['first_turn_input'])}；同轮次输入（中位数）："
          + "，".join(f"第 {n} 次 {fmt(v['median'])}（{v['sessions']} 个会话）" for n, v in summ["ctx_at_call"].items()))

    print("\n-- 会话（按总量）--")
    print(f"{'会话':<10}{'总量':>8}{'调用':>6}{'发言':>6}{'均输入':>8}{'最大上下文':>10}  标题 / 项目")
    rows = sorted(sessions.items(), key=lambda kv: -(kv[1]["input"] + kv[1]["cache_read"] + kv[1]["cache_write"] + kv[1]["output"]))
    for sid, s in rows[:a.max_sessions]:
        total = s["input"] + s["cache_read"] + s["cache_write"] + s["output"]
        avg = (s["input"] + s["cache_read"] + s["cache_write"]) // max(s["calls"], 1)
        sub = f"(子代理{s['sub_calls']})" if s["sub_calls"] else ""
        print(f"{sid[:8]:<10}{fmt(total):>8}{s['calls']:>6}{s['prompts']:>6}{fmt(avg):>8}{fmt(s['max_ctx']):>10}  "
              f"{(s['title'] or '-')[:24]} / {s['project'][-28:]} {sub}")
    if len(rows) > a.max_sessions:
        print(f"…其余 {len(rows) - a.max_sessions} 个会话省略")

    if a.split:
        print("\n-- 主会话 / 子代理拆分（输入含缓存读写）--")
        print(f"{'会话':<10}{'主输入':>9}{'主输出':>8}{'主调用':>7}{'子输入':>9}{'子输出':>8}{'子调用':>7}{'子代理数':>8}{'总量':>9}")
        for sid, s in rows[:a.max_sessions]:
            tot = s["main_in"] + s["main_out"] + s["sub_in"] + s["sub_out"]
            print(f"{sid[:8]:<10}{s['main_in']:>9}{s['main_out']:>8}{s['calls'] - s['sub_calls']:>7}{s['sub_in']:>9}"
                  f"{s['sub_out']:>8}{s['sub_calls']:>7}{len(s['agents']):>8}{tot:>9}")

    print(f"\n-- 工具返回内容按工具汇总（估算 token，图片按尺寸估）--")
    print("  " + "，".join(f"{k} {fmt(v)}" for k, v in list(summ["tool_result_tokens"].items())[:12]))

    print(f"\n-- 返回内容最大的工具调用 Top {a.top} --")
    for t in sorted(tools, key=lambda t: -t["tokens"])[:a.top]:
        img = f" {t['images']}图" if t["images"] else ""
        sub = " 子代理" if t["sub"] else ""
        print(f"{fmt(t['tokens']):>6}  {t['tool'] or '?':<14} {t['session'][:8]}{sub}{img}  {t['target']}")

    if a.first_turn_breakdown:
        first_turn_breakdown(a.days, a.session, until)
    if a.context_composition:
        context_composition(sessions, a.days, a.session, until, a.context_composition)

    if a.save:
        summ["generated"] = dt.datetime.now().isoformat(timespec="seconds")
        summ["days"] = a.days
        with open(a.save, "w", encoding="utf-8") as fh:
            json.dump(summ, fh, ensure_ascii=False, indent=1)
        print(f"\n已保存到 {a.save}")

    if a.compare:
        with open(a.compare, encoding="utf-8") as fh:
            base = json.load(fh)
        print(f"\n-- 对比基线（{base.get('generated', '?')}，{base.get('days', '?')} 天）--")
        for k, label in (("avg_input_per_call", "平均每次调用输入"), ("avg_input_per_prompt", "平均每条发言输入"),
                         ("max_ctx", "最大上下文")):
            b, n = base.get(k, 0), summ[k]
            pct = f"{(n - b) / b * 100:+.0f}%" if b else "-"
            print(f"  {label}: {fmt(b)} -> {fmt(n)} ({pct})")
        if "first_turn_input" not in base:
            print("  （基线里没有第一轮 / 同轮次指标，用 --until 按基线时间窗口重算后补进去）")
            return
        rows = [("第一轮输入", base["first_turn_input"], summ["first_turn_input"],
                 base["first_turn_sessions"], summ["first_turn_sessions"])]
        for n in CTX_AT:
            b, c = base["ctx_at_call"].get(str(n), {}), summ["ctx_at_call"][str(n)]
            rows.append((f"第 {n} 次调用时输入", b.get("median", 0), c["median"], b.get("sessions", 0), c["sessions"]))
        for label, b, n, bs, ns in rows:
            pct = f"{(n - b) / b * 100:+.0f}%" if b and n else "-"
            print(f"  {label}: {fmt(b)} -> {fmt(n)} ({pct})  [会话数 {bs} -> {ns}]")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
