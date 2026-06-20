#!/usr/bin/env python3
"""Attribution pipeline — closes the loop on whether touchpoints move the needle.

What is genuinely measurable (per research):
  - npm downloads: package + date only, no referrer; npx counts; <50/day = noise.
  - GitHub Traffic API: 14-DAY window only (so we persist daily), exposes views,
    clones, and top-10 referrers INCLUDING t.co (Twitter) / reddit.com / github.com.
    Needs push access to the repo -> we call it via `gh api` (uses your gh auth).
  - Stars: no source field; only starred_at timestamps -> time-correlation.

What is NOT attributable: which install/star came from which post. Best case is
correlation: did stars/clones/npm rise within 48h of a touchpoint, and did that
channel's referrer climb. `correlate` reports exactly that, never false precision.

Daily cron: `measure.py pull` (persist snapshots). Analysis: `measure.py correlate`
/ `measure.py report` (markdown for the Feishu card).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    requests = None

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import registry  # noqa: E402

CONFIG = json.loads((HERE / "config.json").read_text())
REPO = CONFIG["measure"]["github_repo"]
NPM_PKG = CONFIG["measure"]["npm_pkg"]
WINDOW_H = CONFIG["measure"].get("correlate_window_hours", 48)
METRICS = HERE / "metrics"
METRICS.mkdir(exist_ok=True)


def _now():
    return datetime.now(timezone.utc)


def _today():
    return _now().strftime("%Y-%m-%d")


def _parse(ts):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None


def _merge_by(path: Path, key: str, rows: list[dict]):
    """Idempotent persist: rows merged into existing file keyed by `key` field."""
    existing = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if line.strip():
                try:
                    r = json.loads(line)
                    existing[r[key]] = r
                except (json.JSONDecodeError, KeyError):
                    pass
    for r in rows:
        existing[r[key]] = r
    with open(path, "w") as f:
        for k in sorted(existing):
            f.write(json.dumps(existing[k], ensure_ascii=False) + "\n")
    return len(rows)


def _load(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        if line.strip():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def _gh(endpoint: str, paginate=False, accept=None):
    cmd = ["gh", "api"]
    if paginate:
        cmd.append("--paginate")
    if accept:
        cmd += ["-H", f"Accept: {accept}"]
    cmd.append(endpoint)
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return None, f"gh error: {e}"
    if out.returncode != 0:
        return None, f"gh api {endpoint} failed: {out.stderr.strip()[:200]}"
    try:
        return json.loads(out.stdout), None
    except json.JSONDecodeError:
        # --paginate concatenates arrays as "][" -> stitch
        try:
            return json.loads(out.stdout.replace("][", ",")), None
        except json.JSONDecodeError:
            return None, "json parse error"


# ── pulls ────────────────────────────────────────────────────────────────

def pull_github() -> dict:
    res = {}
    for kind in ("views", "clones"):
        data, err = _gh(f"repos/{REPO}/traffic/{kind}")
        if err:
            res[kind] = err
            continue
        rows = [{"date": d["timestamp"][:10], "count": d["count"], "uniques": d["uniques"]}
                for d in data.get(kind, [])]
        res[kind] = _merge_by(METRICS / f"{kind}.jsonl", "date", rows)
    data, err = _gh(f"repos/{REPO}/traffic/popular/referrers")
    if err:
        res["referrers"] = err
    else:
        today = _today()
        rows = [{"key": f"{today}:{d['referrer']}", "date": today, "referrer": d["referrer"],
                 "count": d["count"], "uniques": d["uniques"]} for d in data]
        res["referrers"] = _merge_by(METRICS / "referrers.jsonl", "key", rows)
    return res


def pull_stars() -> dict:
    data, err = _gh(f"repos/{REPO}/stargazers", paginate=True,
                    accept="application/vnd.github.star+json")
    if err:
        return {"stars": err}
    per_day = defaultdict(int)
    for s in data:
        ts = s.get("starred_at")
        if ts:
            per_day[ts[:10]] += 1
    rows = [{"date": d, "stars": n} for d, n in per_day.items()]
    n = _merge_by(METRICS / "stars.jsonl", "date", rows)
    return {"stars": n, "total": len(data)}


def pull_npm() -> dict:
    if requests is None:
        return {"npm": "requests not available"}
    try:
        r = requests.get(f"https://api.npmjs.org/downloads/range/last-month/{NPM_PKG}", timeout=15)
        r.raise_for_status()
        rows = [{"date": d["day"], "downloads": d["downloads"]} for d in r.json().get("downloads", [])]
        return {"npm": _merge_by(METRICS / "npm.jsonl", "date", rows)}
    except Exception as e:
        return {"npm": f"error: {e}"}


def pull() -> dict:
    return {**pull_github(), **pull_stars(), **pull_npm()}


# ── correlation ────────────────────────────────────────────────────────────

def _series(path: Path, field: str) -> dict:
    return {r["date"]: r.get(field, 0) for r in _load(path)}


def _sum_window(series: dict, start: datetime, hours: int) -> int:
    end = start + timedelta(hours=hours)
    total = 0
    for d, v in series.items():
        dt = _parse(d + "T00:00:00Z")
        if dt and start.date() <= dt.date() <= end.date():
            total += v
    return total


def _baseline(series: dict, before: datetime, days: int = 7) -> float:
    vals = []
    for d, v in series.items():
        dt = _parse(d + "T00:00:00Z")
        if dt and before - timedelta(days=days) <= dt < before:
            vals.append(v)
    return sum(vals) / len(vals) if vals else 0.0


def correlate() -> list[dict]:
    stars = _series(METRICS / "stars.jsonl", "stars")
    clones = _series(METRICS / "clones.jsonl", "uniques")
    npm = _series(METRICS / "npm.jsonl", "downloads")
    out = []
    for tp in registry.touchpoints():
        when = _parse(tp.get("posted_at"))
        if not when:
            continue
        daily = WINDOW_H / 24.0
        s = _sum_window(stars, when, WINDOW_H)
        c = _sum_window(clones, when, WINDOW_H)
        n = _sum_window(npm, when, WINDOW_H)
        signals = sum([
            s >= 1,
            c > _baseline(clones, when) * daily * 1.2,
            n > _baseline(npm, when) * daily * 1.2,
        ])
        out.append({
            "channel": tp["channel"], "repo_or_sub": tp.get("repo_or_sub"),
            "post_url": tp.get("post_url") or tp.get("target_url"),
            "posted_at": tp["posted_at"],
            "stars_48h": s, "clone_uniques_48h": c, "npm_48h": n,
            "signal": signals, "moved": signals >= 2,
        })
    out.sort(key=lambda r: (r["moved"], r["signal"], r["stars_48h"]), reverse=True)
    return out


def report_md() -> str:
    npm = _series(METRICS / "npm.jsonl", "downloads")
    stars = _series(METRICS / "stars.jsonl", "stars")
    refs = _load(METRICS / "referrers.jsonl")
    latest_ref_day = max((r["date"] for r in refs), default=None)
    top_refs = sorted([r for r in refs if r["date"] == latest_ref_day],
                      key=lambda r: -r["count"])[:6] if latest_ref_day else []
    last7_npm = sum(v for d, v in npm.items() if _parse(d + "T00:00:00Z")
                    and _parse(d + "T00:00:00Z") >= _now() - timedelta(days=7))
    last7_stars = sum(v for d, v in stars.items() if _parse(d + "T00:00:00Z")
                      and _parse(d + "T00:00:00Z") >= _now() - timedelta(days=7))
    lines = [f"# 📈 推广度量 — {_today()}", "",
             f"- npm 近 7 天下载: **{last7_npm}**（<50/天为噪声）",
             f"- GitHub stars 近 7 天: **+{last7_stars}**", ""]
    if top_refs:
        lines.append("**Top referrers（近 14 天，GitHub Traffic）:**")
        for r in top_refs:
            lines.append(f"- {r['referrer']}: {r['count']} views / {r['uniques']} uniques")
        lines.append("")
    corr = [c for c in correlate() if c["moved"]]
    if corr:
        lines.append("**疑似有效触点（48h 内多指标同动）:**")
        for c in corr[:8]:
            lines.append(f"- [{c['channel']}] {c['repo_or_sub']} · +{c['stars_48h']}★ "
                         f"/ {c['clone_uniques_48h']} clones / {c['npm_48h']} npm · {c['post_url']}")
    else:
        lines.append("_暂无可关联的有效触点（需要更多带 posted_at 的记录 + 几天度量积累）_")
    return "\n".join(lines)


def main() -> int:
    p = argparse.ArgumentParser(description="promotion attribution")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("pull")
    sub.add_parser("correlate")
    sub.add_parser("report")
    args = p.parse_args()
    if args.cmd == "pull":
        print(json.dumps(pull(), indent=2, ensure_ascii=False)); return 0
    if args.cmd == "correlate":
        print(json.dumps(correlate(), indent=2, ensure_ascii=False)); return 0
    if args.cmd == "report":
        print(report_md()); return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
