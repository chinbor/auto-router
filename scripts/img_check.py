"""检查用的看图小工具：默认看小图，要看细节再按原图像素裁局部（只用标准库 + ffmpeg / ffprobe）。

生成的文件都放在原图（或视频、目录）旁边的 _preview/ 里，原图不改不删。auto-router 的省额度拦截对 _preview/ 里的图直接放行。

用法：
  python img_check.py preview <图片或目录> [...] [--size 768]
      长边缩到 768px，一次可以给多张图或整个目录。原图本来就不大时直接打印原图路径。
  python img_check.py sheet <视频或目录> [--count 12] [--every 秒] [--cols N] [--width 1536]
      联系表：视频按时间均匀取帧（或每隔几秒取一帧），目录按文件名顺序，拼成一张并标上时间或序号。
  python img_check.py crop <图片或预览图> --box x,y,w,h [--from-preview] [--max 1024]
      按原图像素裁出局部。给的是 _preview/ 里的预览图时，坐标按预览图量，自动换算回原图；
      给的是原图时，坐标按原图算，加 --from-preview 则按 768 预览图的坐标换算。
"""
import argparse
import os
import subprocess
import sys
import tempfile

IMG_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
PREVIEW_DIR = "_preview"
MAX_SHEET_FRAMES = 48
FONT = "C\\:/Windows/Fonts/arial.ttf" if os.name == "nt" else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def run(args):
    r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip().splitlines()[-1] if (r.stderr or r.stdout).strip() else "ffmpeg 失败")
    return r.stdout


def probe(path):
    """返回 (宽, 高, 时长秒)；图片的时长为 0。"""
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
               "-of", "default=noprint_wrappers=1", path])
    info = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    dur = info.get("duration", "0")
    return int(info["width"]), int(info["height"]), float(dur) if dur not in ("", "N/A") else 0.0


def out_dir(path):
    d = os.path.join(path if os.path.isdir(path) else os.path.dirname(os.path.abspath(path)), PREVIEW_DIR)
    os.makedirs(d, exist_ok=True)
    return d


def list_images(d):
    return [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.lower().endswith(IMG_EXT)]


def fit(w, h, edge):
    """长边缩到 edge（不放大），返回偶数宽高。"""
    s = min(1.0, edge / max(w, h))
    return max(2, int(w * s) // 2 * 2), max(2, int(h * s) // 2 * 2)


def preview(paths, size):
    for p in paths:
        for img in (list_images(p) if os.path.isdir(p) else [p]):
            try:
                w, h, _ = probe(img)
            except Exception as e:
                print(f"[跳过] {img}：{e}")
                continue
            if max(w, h) <= size:
                print(f"{img}（{w}×{h}，本来就不大，直接看原图）")
                continue
            pw, ph = fit(w, h, size)
            out = os.path.join(out_dir(img), os.path.basename(img) + ".jpg")
            run(["ffmpeg", "-v", "error", "-y", "-i", img, "-vf", f"scale={pw}:{ph}", "-q:v", "3", out])
            print(f"{out}（原图 {w}×{h} → {pw}×{ph}）")


def label_filter(text):
    return (f"drawtext=fontfile='{FONT}':text='{text}':x=6:y=6:fontsize=22:fontcolor=white"
            ":box=1:boxcolor=black@0.6:boxborderw=4")


def sheet(src, count, every, cols, width):
    if os.path.isdir(src):
        imgs = list_images(src)
        if not imgs:
            sys.exit(f"{src} 里没有图片")
        w, h, _ = probe(imgs[0])
        chunks = [imgs[i:i + count] for i in range(0, len(imgs), count)]
        jobs = [[(img, None, f"#{i * count + j + 1}") for j, img in enumerate(c)] for i, c in enumerate(chunks)]
        names = [f"sheet-{i + 1}.jpg" if len(jobs) > 1 else "sheet.jpg" for i in range(len(jobs))]
    else:
        w, h, dur = probe(src)
        if dur <= 0:
            sys.exit(f"读不到 {src} 的时长")
        times = [k * every for k in range(int(dur // every) + 1)] if every else [dur * (k + 0.5) / count for k in range(count)]
        times = [t for t in times if t < dur][:MAX_SHEET_FRAMES]
        jobs = [[(src, t, f"{t:.1f}s") for t in times]]
        names = [os.path.splitext(os.path.basename(src))[0] + ".sheet.jpg"]
    cols = cols or (4 if w >= h else 6)
    cw = width // cols // 2 * 2
    ch = int(cw * h / w) // 2 * 2
    cell = f"scale={cw}:{ch}:force_original_aspect_ratio=decrease,pad={cw}:{ch}:(ow-iw)/2:(oh-ih)/2:color=black"
    for frames, name in zip(jobs, names):
        with tempfile.TemporaryDirectory() as tmp:
            for i, (path, t, text) in enumerate(frames):
                seek = ["-ss", f"{t:.3f}"] if t is not None else []
                out = os.path.join(tmp, f"{i:03d}.png")
                try:
                    run(["ffmpeg", "-v", "error", "-y", *seek, "-i", path, "-frames:v", "1",
                         "-vf", cell + "," + label_filter(text), out])
                except RuntimeError:  # 字体不可用时不加标注
                    run(["ffmpeg", "-v", "error", "-y", *seek, "-i", path, "-frames:v", "1", "-vf", cell, out])
            rows = -(-len(frames) // cols)
            dest = os.path.join(out_dir(src), name)
            run(["ffmpeg", "-v", "error", "-y", "-i", os.path.join(tmp, "%03d.png"), "-frames:v", "1",
                 "-vf", f"tile={cols}x{rows}:color=black", "-q:v", "3", dest])
        print(f"{dest}（{len(frames)} 格，{cols}×{rows}，每格 {cw}×{ch}）")
        if os.path.isdir(src):
            print("  " + "，".join(f"{text}={os.path.basename(path)}" for path, _, text in frames))


def crop(path, box, from_preview, preview_size, max_edge):
    x, y, w, h = (float(v) for v in box.split(","))
    parent = os.path.dirname(os.path.abspath(path))
    src = path
    if os.path.basename(parent) == PREVIEW_DIR and path.lower().endswith(".jpg"):
        cand = os.path.join(os.path.dirname(parent), os.path.basename(path)[:-4])
        if os.path.isfile(cand):  # 给的是预览图：坐标按预览图量
            pw, ph, _ = probe(path)
            src, from_preview = cand, True
    ow, oh, _ = probe(src)
    if from_preview:
        pw, ph = fit(ow, oh, preview_size) if src == path else (pw, ph)
        sx, sy = ow / pw, oh / ph
        x, y, w, h = x * sx, y * sy, w * sx, h * sy
    x, y = max(0, min(round(x), ow - 2)), max(0, min(round(y), oh - 2))
    w, h = max(2, min(round(w), ow - x)), max(2, min(round(h), oh - y))
    vf = f"crop={w}:{h}:{x}:{y}"
    if max(w, h) > max_edge:
        vf += ",scale={}:{}".format(*fit(w, h, max_edge))
    dest = os.path.join(out_dir(src), f"{os.path.basename(src)}.crop-{x}_{y}_{w}_{h}.jpg")
    run(["ffmpeg", "-v", "error", "-y", "-i", src, "-vf", vf, "-q:v", "2", dest])
    note = "原图像素" if max(w, h) <= max_edge else f"长边缩到 {max_edge}"
    print(f"{dest}（原图 {ow}×{oh} 中的 x={x} y={y} w={w} h={h}，{note}）")


def main():
    ap = argparse.ArgumentParser(description="检查用的看图小工具：预览、联系表、裁局部")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("preview", help="长边缩到 768px 的预览图，可给多张图或目录")
    p.add_argument("paths", nargs="+")
    p.add_argument("--size", type=int, default=768)
    p = sub.add_parser("sheet", help="视频或图片目录拼成带时间 / 序号的联系表")
    p.add_argument("src")
    p.add_argument("--count", type=int, default=12, help="视频取几帧；目录每张联系表放几张")
    p.add_argument("--every", type=float, help="视频每隔几秒取一帧（最多 48 帧），给了就不看 --count")
    p.add_argument("--cols", type=int, help="列数，默认横图 4、竖图 6")
    p.add_argument("--width", type=int, default=1536, help="联系表总宽")
    p = sub.add_parser("crop", help="按原图像素裁局部，看小字、脸部等细节")
    p.add_argument("path")
    p.add_argument("--box", required=True, help="x,y,w,h")
    p.add_argument("--from-preview", action="store_true", help="坐标是在 768 预览图上量的")
    p.add_argument("--preview-size", type=int, default=768)
    p.add_argument("--max", type=int, default=1024, help="裁出来的图长边超过这个值才缩小")
    a = ap.parse_args()
    for p in (a.paths if a.cmd == "preview" else [a.src if a.cmd == "sheet" else a.path]):
        if not os.path.exists(p):
            sys.exit(f"找不到：{p}")
    try:
        if a.cmd == "preview":
            preview(a.paths, a.size)
        elif a.cmd == "sheet":
            sheet(a.src, a.count, a.every, a.cols, a.width)
        else:
            crop(a.path, a.box, a.from_preview, a.preview_size, a.max)
    except FileNotFoundError:
        sys.exit("找不到 ffmpeg / ffprobe，请先安装并加入 PATH")
    except (RuntimeError, KeyError, ValueError) as e:
        sys.exit(f"失败：{e}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
