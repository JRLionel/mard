#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MARD 色卡数据审计 —— 对应技术方案「附录 A」。

用途：校验 code.md（MARD 221）的数据质量，输出可用于回归对比的指标。
改了色卡数据后重跑，对比附录 A 的数字即可发现回归。

用法：
    python3 palette-audit.py                        # 默认读 ./code.md
    python3 palette-audit.py path/to/code.md
    python3 palette-audit.py code.md --top 20
"""

import argparse
import math
import re
from collections import defaultdict


def srgb_to_linear(c: int) -> float:
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgb_to_oklab(rgb):
    """sRGB(0-255) -> OKLab。Björn Ottosson, 2020。"""
    r, g, b = (srgb_to_linear(v) for v in rgb)
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = (math.copysign(abs(v) ** (1 / 3), v) for v in (l, m, s))
    return (
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    )


def d_ok(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def parse(path):
    """code.md 的表头写的是「名称 / 色号 / RGB」，但内容是「色号 / HEX / RGB」——以内容为准。"""
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line.startswith("|"):
                continue
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) < 3:
                continue
            code, hexv = cells[0], cells[1]
            if not re.fullmatch(r"[A-Z]\d+", code):
                continue
            m = re.fullmatch(r"#([0-9A-Fa-f]{6})", hexv)
            if not m:
                continue
            h = m.group(1)
            rgb = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
            rows.append({"code": code, "hex": "#" + h.upper(), "rgb": rgb,
                         "ok": rgb_to_oklab(rgb)})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?", default="code.md")
    ap.add_argument("--top", type=int, default=20, help="输出最接近的 N 对色")
    args = ap.parse_args()

    rows = parse(args.path)
    n = len(rows)

    print("=" * 62)
    print("1. 规模与完整性")
    print("=" * 62)
    print(f"条目数: {n}")
    groups = defaultdict(int)
    for r in rows:
        groups[r["code"][0]] += 1
    print("分组:", " ".join(f"{k}{v}" for k, v in sorted(groups.items())))

    byhex = defaultdict(list)
    for r in rows:
        byhex[r["hex"]].append(r["code"])
    dups = {k: v for k, v in byhex.items() if len(v) > 1}
    print(f"完全重复的 HEX: {len(dups)} 组", end="")
    print("（无）" if not dups else "")
    for k, v in dups.items():
        print(f"   {k}: {', '.join(v)}")

    Ls = [r["ok"][0] for r in rows]
    Cs = [math.hypot(r["ok"][1], r["ok"][2]) for r in rows]
    print(f"明度 L 范围: {min(Ls):.3f} ~ {max(Ls):.3f}")
    print(f"彩度 C 上限: {max(Cs):.3f}")
    print(f"低彩度(C<0.03): {sum(1 for c in Cs if c < 0.03)} 色")
    print(f"深色(L<0.35): {sum(1 for l in Ls if l < 0.35)} 色")

    D = [[0.0] * n for _ in range(n)]
    pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            d = d_ok(rows[i]["ok"], rows[j]["ok"])
            D[i][j] = D[j][i] = d
            pairs.append((d, i, j))
    pairs.sort()

    print()
    print("=" * 62)
    print(f"2. 最接近的 {args.top} 对（ΔEOk）")
    print("=" * 62)
    for d, i, j in pairs[: args.top]:
        tag = ("几乎无法区分" if d < 0.010 else
               "极难区分" if d < 0.020 else
               "仅并排可辨" if d < 0.030 else "")
        print(f"  {d:.4f}  {rows[i]['code']:<5}{rows[j]['code']:<5}"
              f"{rows[i]['hex']:<9}{rows[j]['hex']:<9}{tag}")

    print()
    print("=" * 62)
    print("3. 近色抑制后的可用色数（贪心独立集，优先保留最独特的色）")
    print("=" * 62)
    for thr in (0.005, 0.010, 0.015, 0.020, 0.025, 0.030, 0.040):
        deg = [sum(1 for j in range(n) if j != i and D[i][j] < thr) for i in range(n)]
        order = sorted(range(n), key=lambda i: deg[i])
        alive = [True] * n
        kept = 0
        for i in order:
            if not alive[i]:
                continue
            kept += 1
            for j in range(n):
                if j != i and D[i][j] < thr:
                    alive[j] = False
        print(f"  阈值 {thr:.3f} → 保留 {kept:3d} 色（合并掉 {n - kept}）")

    print()
    print("=" * 62)
    print("4. 暗部覆盖（L < 0.35）")
    print("=" * 62)
    dark = sorted([r for r in rows if r["ok"][0] < 0.35], key=lambda r: r["ok"][0])
    for r in dark:
        print(f"  {r['code']:<5} L={r['ok'][0]:.3f}  {r['hex']}")
    if len(dark) >= 2:
        print(f"  → 最大相邻断层: {dark[1]['ok'][0] - dark[0]['ok'][0]:.3f}"
              f"（{dark[0]['code']} → {dark[1]['code']}）")


if __name__ == "__main__":
    main()
