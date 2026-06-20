#!/usr/bin/env python3
"""Unified promotion registry — the single source of truth for every touchpoint
across all channels (github / twitter / reddit), with dedup-on-write.

Storage: _promo/registry.jsonl  (one JSON record per line, append/rewrite under a file lock)

Record schema (fields filled progressively through the pipeline):
    channel       github | twitter | reddit
    target_url    canonical URL of the thing we replied UNDER (issue/tweet/thread)
    key           dedup key  "<channel>:<id-or-normalized-url>"   (unique)
    repo_or_sub   "owner/repo" | "r/sub" | "@handle"
    target_type   feature-request | question | launch | discussion | bug | unknown
    lang          en | zh | ja | unknown
    audience      int proxy (views / score / reactions) at discovery time
    title         short target title/summary
    draft         the drafted reply text (used by guard.py variation check)
    drafted_at    ISO8601 | null
    posted_at     ISO8601 | null
    post_url      URL of OUR comment/reply | null
    status        drafted | approved | posted | skipped | failed | hidden | removed
    outcome       free-form dict (filled by measure.py / revisits)

Why code, not an LLM: dedup and "have we touched this" must be deterministic for
unattended operation. The LLM drafts and judges relevance; this file remembers.

CLI (callable from a SKILL or the orchestrator):
    registry.py migrate                              one-time import of legacy flat files
    registry.py seen   <channel> <url>               exit 0 if seen, 1 if new; prints 1/0
    registry.py add    --channel C --url U --status S [--repo R --type T --lang L
                       --audience N --title ... --draft-file F --post-url P --drafted-at ISO]
    registry.py update --url U [--status S --post-url P --posted-at ISO ...]
    registry.py mark-posted --url U --post-url P [--channel C]
    registry.py pending [--channel C]                JSON array of drafted/approved, not posted
    registry.py touchpoints [--channel C]            JSON array of posted records (for measure.py)
    registry.py stats                                counts per channel/status
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REGISTRY = HERE / "registry.jsonl"
LOCKFILE = HERE / ".registry.lock"

LEGACY = {
    "github": HERE.parent / "promote" / "replied_issues.txt",
    "twitter": HERE.parent / "snipe" / "sniped_posts.txt",
    "reddit": HERE.parent / "reddit-snipe" / "sniped_threads.txt",
}

VALID_CHANNELS = {"github", "twitter", "reddit"}
VALID_STATUS = {"drafted", "approved", "posted", "skipped", "failed", "hidden", "removed"}


# ── locking ──────────────────────────────────────────────────────────────

@contextlib.contextmanager
def _lock():
    LOCKFILE.touch(exist_ok=True)
    fh = open(LOCKFILE, "r+")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fh, fcntl.LOCK_UN)
        fh.close()


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── URL normalization + dedup keys ───────────────────────────────────────

def _strip(url: str) -> str:
    url = (url or "").strip()
    url = url.split("#")[0].split("?")[0]
    return url.rstrip("/")


def normalize_url(channel: str, url: str) -> str:
    u = _strip(url)
    if channel == "twitter":
        u = u.replace("twitter.com", "x.com")
    if channel == "reddit":
        u = re.sub(r"https?://(www\.|old\.|new\.)?reddit\.com", "https://www.reddit.com", u)
    return u


def key_for(channel: str, url: str) -> str:
    u = normalize_url(channel, url)
    if channel == "twitter":
        m = re.search(r"/status/(\d+)", u)
        if m:
            return f"twitter:status:{m.group(1)}"
    if channel == "reddit":
        m = re.search(r"/comments/([a-z0-9]+)", u)
        if m:
            return f"reddit:comments:{m.group(1)}"
    if channel == "github":
        m = re.search(r"github\.com/([^/]+)/([^/]+)/(issues|pull)/(\d+)", u)
        if m:
            return f"github:{m.group(1).lower()}/{m.group(2).lower()}#{m.group(4)}"
    return f"{channel}:{u.lower()}"


def repo_or_sub(channel: str, url: str) -> str:
    u = normalize_url(channel, url)
    if channel == "github":
        m = re.search(r"github\.com/([^/]+)/([^/]+)", u)
        return f"{m.group(1)}/{m.group(2)}" if m else ""
    if channel == "twitter":
        m = re.search(r"x\.com/([^/]+)/status", u)
        return f"@{m.group(1)}" if m else ""
    if channel == "reddit":
        m = re.search(r"/r/([^/]+)", u)
        return f"r/{m.group(1)}" if m else ""
    return ""


# ── load / save ──────────────────────────────────────────────────────────

def load() -> list[dict]:
    if not REGISTRY.exists():
        return []
    out = []
    for line in REGISTRY.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def _save(records: list[dict]) -> None:
    tmp = REGISTRY.with_suffix(".jsonl.tmp")
    with open(tmp, "w") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    os.replace(tmp, REGISTRY)


def _index(records: list[dict]) -> dict[str, dict]:
    return {r["key"]: r for r in records if "key" in r}


# ── core operations (dedup-on-write) ─────────────────────────────────────

def seen(channel: str, url: str) -> bool:
    k = key_for(channel, url)
    return any(r.get("key") == k for r in load())


def add(channel: str, url: str, *, status: str = "drafted", **fields) -> tuple[bool, str]:
    """Add a record iff its key is new. Returns (added, reason)."""
    if channel not in VALID_CHANNELS:
        return False, f"bad channel {channel!r}"
    if status not in VALID_STATUS:
        return False, f"bad status {status!r}"
    k = key_for(channel, url)
    with _lock():
        records = load()
        idx = _index(records)
        if k in idx:
            return False, "duplicate"  # <- this is what kills the clawdbot-feishu/406 dup
        rec = {
            "channel": channel,
            "target_url": normalize_url(channel, url),
            "key": k,
            "repo_or_sub": fields.get("repo_or_sub") or repo_or_sub(channel, url),
            "target_type": fields.get("target_type", "unknown"),
            "lang": fields.get("lang", "unknown"),
            "audience": fields.get("audience"),
            "title": fields.get("title", ""),
            "draft": fields.get("draft", ""),
            "drafted_at": fields.get("drafted_at") or (now_iso() if status == "drafted" else None),
            "posted_at": fields.get("posted_at"),
            "post_url": fields.get("post_url"),
            "status": status,
            "outcome": fields.get("outcome", {}),
        }
        records.append(rec)
        _save(records)
        return True, "added"


def update(channel: str, url: str, **fields) -> bool:
    k = key_for(channel, url)
    with _lock():
        records = load()
        idx = _index(records)
        if k not in idx:
            return False
        idx[k].update({kk: vv for kk, vv in fields.items() if vv is not None})
        _save(records)
        return True


def mark_posted(channel: str, url: str, post_url: str, when: str | None = None) -> bool:
    return update(channel, url, status="posted", post_url=post_url, posted_at=when or now_iso())


def pending(channel: str | None = None) -> list[dict]:
    return [r for r in load()
            if r.get("status") in ("drafted", "approved")
            and (channel is None or r.get("channel") == channel)]


def touchpoints(channel: str | None = None) -> list[dict]:
    return [r for r in load()
            if r.get("status") == "posted"
            and (channel is None or r.get("channel") == channel)]


def stats() -> dict:
    out: dict = {"total": 0, "by_channel": {}, "by_status": {}}
    for r in load():
        out["total"] += 1
        ch, st = r.get("channel", "?"), r.get("status", "?")
        out["by_channel"][ch] = out["by_channel"].get(ch, 0) + 1
        out["by_status"][st] = out["by_status"].get(st, 0) + 1
    return out


# ── migration of legacy flat files ───────────────────────────────────────

def _migrate_github(path: Path) -> int:
    n = 0
    run_date = None
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("#"):
            m = re.search(r"run (\d{4}-\d{2}-\d{2}T[\d:]+Z)", line)
            if m:
                run_date = m.group(1)
            continue
        if "github.com" in line:
            added, _ = add("github", line, status="posted", posted_at=run_date)
            n += 1 if added else 0
    return n


def _migrate_twitter(path: Path) -> int:
    n = 0
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "/status/" in line:
            added, _ = add("twitter", line, status="posted")
            n += 1 if added else 0
    return n


def _migrate_reddit(path: Path) -> int:
    n = 0
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        url = parts[0]
        ts = parts[1] if len(parts) > 1 else None
        form = parts[2] if len(parts) > 2 else ""
        if "reddit.com" not in url and "redd.it" not in url:
            continue
        status = "skipped" if form == "skipped" else "posted"
        added, _ = add("reddit", url, status=status,
                       posted_at=(ts if status == "posted" else None),
                       drafted_at=ts, outcome={"form": form} if form else {})
        n += 1 if added else 0
    return n


def migrate() -> dict:
    report = {}
    migrators = {"github": _migrate_github, "twitter": _migrate_twitter, "reddit": _migrate_reddit}
    for ch, path in LEGACY.items():
        report[ch] = migrators[ch](path) if path.exists() else "no legacy file"
    return report


# ── CLI ──────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description="pikiloom promotion registry")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("migrate")
    sub.add_parser("stats")

    s = sub.add_parser("seen"); s.add_argument("channel"); s.add_argument("url")

    a = sub.add_parser("add")
    a.add_argument("--channel", required=True); a.add_argument("--url", required=True)
    a.add_argument("--status", default="drafted")
    a.add_argument("--repo"); a.add_argument("--type"); a.add_argument("--lang")
    a.add_argument("--audience", type=int); a.add_argument("--title", default="")
    a.add_argument("--draft-file"); a.add_argument("--post-url"); a.add_argument("--drafted-at")

    u = sub.add_parser("update")
    u.add_argument("--channel", required=True); u.add_argument("--url", required=True)
    u.add_argument("--status"); u.add_argument("--post-url"); u.add_argument("--posted-at")

    m = sub.add_parser("mark-posted")
    m.add_argument("--channel", required=True); m.add_argument("--url", required=True)
    m.add_argument("--post-url", required=True); m.add_argument("--posted-at")

    pe = sub.add_parser("pending"); pe.add_argument("--channel")
    tp = sub.add_parser("touchpoints"); tp.add_argument("--channel")

    args = p.parse_args()

    if args.cmd == "migrate":
        print(json.dumps(migrate(), indent=2)); return 0
    if args.cmd == "stats":
        print(json.dumps(stats(), indent=2, ensure_ascii=False)); return 0
    if args.cmd == "seen":
        hit = seen(args.channel, args.url); print("1" if hit else "0"); return 0 if hit else 1
    if args.cmd == "add":
        draft = Path(args.draft_file).read_text() if args.draft_file else ""
        added, reason = add(args.channel, args.url, status=args.status, repo_or_sub=args.repo,
                            target_type=args.type or "unknown", lang=args.lang or "unknown",
                            audience=args.audience, title=args.title, draft=draft,
                            post_url=args.post_url, drafted_at=args.drafted_at)
        print(json.dumps({"added": added, "reason": reason})); return 0 if added else 2
    if args.cmd == "update":
        ok = update(args.channel, args.url, status=args.status,
                    post_url=args.post_url, posted_at=args.posted_at)
        print(json.dumps({"updated": ok})); return 0 if ok else 2
    if args.cmd == "mark-posted":
        ok = mark_posted(args.channel, args.url, args.post_url, args.posted_at)
        print(json.dumps({"marked": ok})); return 0 if ok else 2
    if args.cmd == "pending":
        print(json.dumps(pending(args.channel), ensure_ascii=False, indent=2)); return 0
    if args.cmd == "touchpoints":
        print(json.dumps(touchpoints(args.channel), ensure_ascii=False, indent=2)); return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
