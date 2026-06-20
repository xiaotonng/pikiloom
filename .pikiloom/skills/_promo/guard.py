#!/usr/bin/env python3
"""Deterministic pre-post guardrails for the autonomous promotion engine.

The orchestrator calls `guard.py check` immediately before posting each draft.
Every rule here is enforced in CODE, not by the LLM's judgment — so even in
fully-unattended `auto` posture the math (caps, cadence, variation, kill-switch)
holds. If guard denies, the orchestrator skips that target and records why.

Rules (all configured in config.json):
  1. kill_switch            -> deny everything (fastest safe stop)
  2. channel disabled       -> deny
  3. backoff                -> deny channel if a recent post was hidden/removed
  4. duplicate              -> deny if registry has already touched this target
  5. per-repo/sub/author    -> github: lifetime cap; reddit/twitter: per-day cap
  6. channel daily cap      -> deny if already posted N today
  7. cadence min-gap        -> deny if last post on channel was < min_gap ago
  8. content variation      -> deny if draft too similar to a prior POSTED draft

CLI:
    guard.py check --channel C --url U [--draft-file F]   JSON {allow,reasons,warnings}; exit 3 if denied
    guard.py caps                                          current usage vs caps (for the report)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import registry  # noqa: E402

CONFIG = HERE / "config.json"


def cfg() -> dict:
    return json.loads(CONFIG.read_text())


def _parse_ts(ts: str | None):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def _now():
    return datetime.now(timezone.utc)


def _today_utc():
    return _now().date()


def _posted_date(r: dict):
    """Real posted date, or None for unknown/unparseable (historical migrations).
    None must NOT count toward 'today' — only toward lifetime caps."""
    d = _parse_ts(r.get("posted_at"))
    return d.date() if d else None


# ── content variation (token-shingle Jaccard) ───────────────────────────

def _shingles(text: str, k: int) -> set:
    toks = re.findall(r"[a-z0-9]+", (text or "").lower())
    # drop the load-bearing identifiers so they don't inflate similarity by themselves
    stop = {"pikiloom", "npx", "github", "com", "https", "claude", "code", "codex", "gemini"}
    toks = [t for t in toks if t not in stop]
    if len(toks) < k:
        return {" ".join(toks)} if toks else set()
    return {" ".join(toks[i:i + k]) for i in range(len(toks) - k + 1)}


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def max_similarity(channel: str, draft: str, k: int) -> float:
    target = _shingles(draft, k)
    if not target:
        return 0.0
    best = 0.0
    for r in registry.touchpoints(channel):
        prior = r.get("draft") or ""
        if prior:
            best = max(best, _jaccard(target, _shingles(prior, k)))
    return best


# ── main check ───────────────────────────────────────────────────────────

def check(channel: str, url: str, draft: str = "") -> dict:
    c = cfg()
    reasons: list[str] = []   # any reason => deny
    warnings: list[str] = []
    ch = c["channels"].get(channel, {})

    # 1. kill switch
    if c.get("kill_switch"):
        reasons.append("kill_switch is ON")

    # 1b. per-URL veto (batch-posture circuit breaker) — deterministic, enforced here
    abort = HERE / "abort.txt"
    if abort.exists():
        target_norm = registry.normalize_url(channel, url)
        for ln in abort.read_text().splitlines():
            ln = ln.strip()
            if ln and not ln.startswith("#") and registry.normalize_url(channel, ln) == target_norm:
                reasons.append("vetoed in abort.txt")
                break

    # 2. channel enabled
    if not ch.get("enabled", False):
        reasons.append(f"channel {channel} disabled")

    posted = registry.touchpoints(channel)

    # 3. backoff on hidden/removed
    bo = c.get("backoff", {})
    if bo.get("on_hidden_or_removed"):
        cd = timedelta(hours=bo.get("channel_cooldown_hours", 48))
        for r in registry.load():
            if r.get("channel") != channel:
                continue
            if r.get("status") in ("hidden", "removed"):
                t = _parse_ts(r.get("posted_at")) or _parse_ts(r.get("drafted_at"))
                if t and _now() - t < cd:
                    reasons.append(f"backoff: a {r['status']} post on {channel} within "
                                   f"{bo.get('channel_cooldown_hours')}h")
                    break

    # 4. duplicate
    if registry.seen(channel, url):
        reasons.append("duplicate: already in registry")

    rs = registry.repo_or_sub(channel, url)

    # 5. per-repo / per-sub / per-author
    same = [r for r in posted if r.get("repo_or_sub") == rs]
    if channel == "github":
        cap = ch.get("per_repo_lifetime_cap", 2)
        if len(same) >= cap:
            reasons.append(f"per-repo lifetime cap: {rs} already has {len(same)} posts (cap {cap})")
        if rs in ch.get("deny_repos", []):
            reasons.append(f"deny_repos: {rs} is upstream-body / off-strategy")
    else:
        per = ch.get("per_sub_daily_cap" if channel == "reddit" else "per_author_daily_cap", 1)
        today = [r for r in same if _posted_date(r) == _today_utc()]
        if len(today) >= per:
            reasons.append(f"per-{('sub' if channel=='reddit' else 'author')} daily cap: "
                           f"{rs} has {len(today)} today (cap {per})")

    # 6. channel daily cap
    dcap = ch.get("daily_cap", 999)
    today_posts = [r for r in posted if _posted_date(r) == _today_utc()]
    if len(today_posts) >= dcap:
        reasons.append(f"channel daily cap: {len(today_posts)}/{dcap} on {channel} today")

    # 7. cadence min-gap
    gap = ch.get("min_gap_minutes", 0)
    if gap:
        last = max((_parse_ts(r.get("posted_at")) for r in posted if _parse_ts(r.get("posted_at"))),
                   default=None)
        if last and _now() - last < timedelta(minutes=gap):
            wait = gap - int((_now() - last).total_seconds() // 60)
            reasons.append(f"cadence: last {channel} post {int((_now()-last).total_seconds()//60)}m "
                           f"ago, min gap {gap}m (wait ~{wait}m)")

    # 8. content variation
    if draft:
        cv = c.get("content_variation", {})
        thresh = 1.0 - cv.get("min_distinct_ratio", 0.45)
        sim = max_similarity(channel, draft, cv.get("shingle_size", 3))
        if sim > thresh:
            reasons.append(f"too similar to a prior posted draft (sim {sim:.2f} > {thresh:.2f}) "
                           f"— rewrite to avoid boilerplate flag")
        elif sim > thresh * 0.8:
            warnings.append(f"borderline similarity {sim:.2f} (limit {thresh:.2f})")

    return {"allow": not reasons, "channel": channel, "target": url,
            "posture": c.get("posture"), "reasons": reasons, "warnings": warnings}


def caps() -> dict:
    c = cfg()
    out = {"posture": c.get("posture"), "kill_switch": c.get("kill_switch"), "channels": {}}
    for channel, ch in c["channels"].items():
        posted = registry.touchpoints(channel)
        today = [r for r in posted if _posted_date(r) == _today_utc()]
        out["channels"][channel] = {
            "enabled": ch.get("enabled"),
            "posted_today": len(today),
            "daily_cap": ch.get("daily_cap"),
            "total_posted": len(posted),
        }
    return out


def main() -> int:
    p = argparse.ArgumentParser(description="promotion guardrails")
    sub = p.add_subparsers(dest="cmd", required=True)
    ck = sub.add_parser("check")
    ck.add_argument("--channel", required=True)
    ck.add_argument("--url", required=True)
    ck.add_argument("--draft-file")
    sub.add_parser("caps")
    args = p.parse_args()

    if args.cmd == "caps":
        print(json.dumps(caps(), indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "check":
        draft = Path(args.draft_file).read_text() if args.draft_file else ""
        res = check(args.channel, args.url, draft)
        print(json.dumps(res, indent=2, ensure_ascii=False))
        return 0 if res["allow"] else 3
    return 1


if __name__ == "__main__":
    sys.exit(main())
