# `_promo` — shared core for the autonomous promotion engine

Three channel skills (`snipe`=Twitter/X, `reddit-snipe`=Reddit, `promote`=GitHub) are thin adapters
over this shared core. The core is what makes near-zero-human-intervention safe: deterministic dedup,
guardrails, and measurement in **code**; product copy in **one** place; an LLM only for judgment
(relevance, drafting, self-critique).

```
_promo/
  pitch.md          SSOT for product copy: one-liner, differentiators, honesty bounds, voice, skeleton, anti-patterns
  config.json       all knobs: posture, per-channel caps, cadence, content-variation, kill_switch, deny_repos
  registry.py       unified JSONL touchpoint log with DEDUP-ON-WRITE (seen/add/pending/mark-posted/stats/migrate)
  guard.py          deterministic pre-post gate: caps, cadence, variation, backoff, kill_switch, abort.txt veto
  push_feishu.py    Feishu doc + card delivery (shared by all channels; --card-only for batch/auto notices)
  measure.py        GitHub Traffic + stargazers + npm -> persisted daily, correlated to touchpoints
  orchestrate.md    the unattended runbook (discover→filter→dedup→draft→critic→guard→post→record→measure)
  abort.txt         per-target veto for `batch` posture
  metrics/          persisted daily metric snapshots (Traffic API only keeps 14d, so we keep history)
  registry.jsonl    the touchpoint log (migrated from the old flat .txt files)
```

## Data flow

```
channel SKILL (discovery mechanics)
        │  candidates
        ▼
registry.py seen ──► drop dupes
        │
        ▼
draft (sub-agent, copy from pitch.md) ──► registry.py add (status=drafted, stores text)
        │
        ▼
critic (pitch.md §10 rubric, ≤1 revision)
        │ pass
        ▼
guard.py check (caps/cadence/variation/backoff/kill/abort)  ── deny ─► registry update skipped
        │ allow
        ▼
posture:  shadow → record only │ batch → approve + Feishu veto card │ auto → post now
        │
        ▼
post (gh issue comment / browser) ──► registry.py mark-posted ──► measure.py correlate
```

## Operating it (the three levers you actually touch)

| Want to… | Do this |
|---|---|
| Preview without posting | `config.json` → `"posture": "shadow"` |
| Post-unless-I-veto (recommended) | `"posture": "batch"` — one Feishu card/day, ignore = it ships |
| Fully unattended | `"posture": "auto"` |
| Stop one target | add its URL to `abort.txt` |
| Stop everything now | `"kill_switch": true` |
| Loosen/tighten volume | `config.json` → `channels.<c>.daily_cap` / `per_repo_lifetime_cap` / `min_gap_minutes` |

**Autonomy ladder (recommended ramp):** week 1 `shadow` → week 2 `batch` → steady-state `auto`,
graduating `auto` per channel starting with **github** (the `gh` post path is the most reliable and
most reversible). `guard.py` caps + variation + backoff are always on, so even `auto` cannot exceed
the rate/repetition limits that get accounts flagged.

## Scheduling (daily, unattended)

The orchestrator is LLM-driven (`orchestrate.md`), so the cron invokes the `auto-promote` skill.

- **Cloud cron — `schedule` skill:** create a routine that runs `/auto-promote` once/day. For `batch`,
  add a second routine `veto_window_hours` later that runs `/auto-promote post-approved` (posts the
  approved, non-aborted batch).
- **Local — `loop` skill:** `loop` `/auto-promote` on a daily interval; each run first posts the prior
  run's approved batch (older than the veto window), then drafts a fresh one.

## Health checks

```bash
cd /Users/admin/Desktop/project/pikiloom
python3 .pikiloom/skills/_promo/registry.py stats     # touchpoints by channel/status
python3 .pikiloom/skills/_promo/guard.py caps          # today's usage vs caps
python3 .pikiloom/skills/_promo/measure.py report      # npm/stars/referrers + effective touchpoints
```
