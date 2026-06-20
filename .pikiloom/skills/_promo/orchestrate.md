# Autonomous Promotion Orchestrator (`orchestrate.md`)

The unattended runbook. A scheduled agent (cron / `loop`) runs this end-to-end with **no human
in the loop** except the posture-defined circuit breaker. Discovery → filter → dedup → draft →
**self-critique** → guard → post → record → measure. The human review gate is replaced by an
**autonomous adversarial critic**; safety is enforced by deterministic `guard.py`, not by judgment.

All product copy comes from [`pitch.md`](./pitch.md). All knobs from [`config.json`](./config.json).
Run everything from the project root: `cd /Users/admin/Desktop/project/pikiloom`.
Script base: `.pikiloom/skills/_promo/` (call `python3 .pikiloom/skills/_promo/<x>.py`).

---

## Phase 0 — Preflight (always)

```bash
cd /Users/admin/Desktop/project/pikiloom
python3 .pikiloom/skills/_promo/measure.py pull        # persist today's metrics (14d window!)
KILL=$(python3 -c "import json;print(json.load(open('.pikiloom/skills/_promo/config.json'))['kill_switch'])")
POSTURE=$(python3 -c "import json;print(json.load(open('.pikiloom/skills/_promo/config.json'))['posture'])")
python3 .pikiloom/skills/_promo/guard.py caps          # see today's remaining quota per channel
```

- If `kill_switch` is `True` → **STOP**. Push one Feishu card "promotion halted (kill switch)" and exit.
- Note `POSTURE` (`shadow` | `batch` | `auto`) — it decides Phase 4.
- If a channel's `posted_today >= daily_cap` already, skip that channel's discovery entirely.

## Phase 1 — Per-channel discovery + filter (delegate to the channel SKILL)

For each **enabled** channel with remaining quota, run that channel's discovery + filter steps:

| Channel | SKILL (discovery mechanics) | Targets |
|---|---|---|
| github | [`promote/SKILL.md`](../promote/SKILL.md) §2–4 | peer-repo **feature-request / question** issues |
| twitter | [`snipe/SKILL.md`](../snipe/SKILL.md) Steps 2–3 | viral same-space promo tweets |
| reddit | [`reddit-snipe/SKILL.md`](../reddit-snipe/SKILL.md) Steps 2–4 | feature/comparison/evergreen threads |

Discovery stays in the channel SKILLs (browser/`gh`/Reddit mechanics differ). The orchestrator
only enforces the cross-channel contract below.

**Dedup is mandatory and deterministic** — for every candidate URL before drafting:

```bash
python3 .pikiloom/skills/_promo/registry.py seen <channel> "<url>" && continue   # skip if seen
```

Keep only candidates that pass the channel's hard filters (views/age/lang/type) **and** are new.
Cap candidates per channel at its remaining daily quota (no point drafting what guard will block).

## Phase 2 — Draft (sub-agent, from the SSOT)

Delegate drafting to a sub-agent. Its entire content contract is [`pitch.md`](./pitch.md):
orienter (§1), pick ONE–two differentiator angles matched to the target (§2), honesty bounds (§3),
one implementation anchor (§4), voice (§5), language (§6), close (§7), skeleton (§8),
channel delta (§9). **One independently-written draft per target** — never a shared template with
a swapped opener (that is what the variation guard and the spam classifiers catch).

Record each draft immediately (status `drafted`, stores the text for the variation check):

```bash
python3 .pikiloom/skills/_promo/registry.py add --channel <c> --url "<target_url>" \
  --status drafted --repo "<repo_or_sub>" --type <feature-request|question|launch|discussion> \
  --lang <en|zh|ja> --audience <N> --title "<short>" --draft-file /tmp/draft_<id>.txt
```

## Phase 3 — Autonomous critic (replaces the human gate)

For each draft, score it against [`pitch.md`](./pitch.md) §10 anti-patterns. The critic is a
sub-agent (or a focused self-review pass) that returns PASS or a list of violations. Rubric — fail on ANY:

1. Marketing/vendor voice ("pikiloom is/can", "check out", "you should try") instead of "I'm building".
2. Compares to / criticizes the host project (even neutrally).
3. Opens with implementation before the reader knows what pikiloom is; or leads with implementation before the out-of-box claim.
4. Out-of-box claim generic, not pinned to the target's exact pain.
5. >2 differentiators / reads as a feature list.
6. Implementation > 1 sentence (tutorial, not a peer note).
7. Over the channel length cap (§9); missing disclosure, `npx pikiloom@latest`, or the link where required.
8. Addresses maintainer/mod; forbidden close.
9. A claim outside the honesty bounds (§3) or a fabricated differentiator.

- **PASS** → Phase 4.
- **FAIL** → send back for **one** revision (`config.critic.max_revisions`). If it fails again → drop:
  `registry.py update --channel <c> --url <u> --status skipped` and move on. No third attempt.

## Phase 4 — Guard + post (posture-driven)

For every critic-passed draft, run the deterministic gate **first**:

```bash
python3 .pikiloom/skills/_promo/guard.py check --channel <c> --url "<url>" --draft-file /tmp/draft_<id>.txt
# exit 0 = allow, exit 3 = deny (reasons in JSON). On deny: registry.py update ... --status skipped; skip.
```

Then act on `POSTURE`:

### `shadow` (dry-run — default for first runs)
- Do **not** post. Leave records at `drafted`.
- Push the full batch report to Feishu (doc + card) so you can read what it *would* post:
  `python3 .pikiloom/skills/_promo/push_feishu.py --report-file /tmp/promo_report.md --title "🌑 Shadow 预览"`

### `batch` (post-unless-vetoed — recommended steady state)
- Mark guard-passed drafts `approved`: `registry.py update --channel <c> --url <u> --status approved`.
- Push ONE veto card (lists every approved target + draft):
  `push_feishu.py --report-file /tmp/promo_report.md --card-only --template orange --title "⏳ 即将自动发布 N 条 · {veto_window_hours}h 内回复 ABORT 取消"`
- **Veto mechanism (deterministic, no IM parsing):** to cancel, the user flips `kill_switch:true`
  or adds target URLs to `.pikiloom/skills/_promo/abort.txt` (one per line).
- A follow-up run scheduled `veto_window_hours` later (see [scheduling](#scheduling)) posts every
  `approved` record whose `drafted_at` is older than the window, not in `abort.txt`, and re-passing
  `guard.py check` (caps may have changed). Then notify (green card).

### `auto` (fully unattended)
- Post immediately (guard already passed). Notify with a green summary card afterward.

### Posting mechanics (per channel)
- **github:** `gh issue comment "<url>" --body-file /tmp/draft_<id>.txt`
- **twitter:** browser (`snipe/SKILL.md` posting section) — main reply = pitch + `npx pikiloom@latest`; **GitHub link in a self-reply** (link-in-reply downranks reach).
- **reddit:** browser (`reddit-snipe/SKILL.md` "浏览器发评论的操作要点") — Lexical paste gotchas apply.

On success record the outcome; on failure record it and continue (never abort the whole batch):

```bash
python3 .pikiloom/skills/_promo/registry.py mark-posted --channel <c> --url "<target>" --post-url "<our_comment_url>"
# failure: registry.py update --channel <c> --url "<target>" --status failed
```

## Phase 5 — Report + learn

```bash
python3 .pikiloom/skills/_promo/registry.py stats
python3 .pikiloom/skills/_promo/measure.py report      # -> markdown, append to the Feishu card
```

- Push the run summary (counts posted/skipped/failed per channel + the measure report) to Feishu.
- **Revisit pass** (cheap, high-value): for posts ≥24h old, check if the comment was hidden/removed/
  locked; if so `registry.py update ... --status hidden` (this trips `guard.py` backoff and pauses
  that channel for `channel_cooldown_hours`). For Twitter, also note if a reply was deboosted.

---

## Scheduling

Daily unattended driver — pick one:

- **`schedule` skill (cloud cron):** create a routine that runs this orchestrator once/day; for
  `batch`, create a second routine `veto_window_hours` later that runs **Phase 4 → post `approved`**.
- **`loop` skill (local, self-paced):** `loop` the orchestrator on a daily interval; the same run
  posts the previous run's approved batch (≥ veto window old) before drafting the new one.

Cadence guidance (under the documented platform limits): GitHub ≤5/day, Twitter ≤12/day spaced
≥15 min, Reddit ≤3/day. `guard.py` enforces these regardless — the schedule just sets the rhythm.

## The autonomy ladder (how to reach "almost no human intervention" safely)

1. **Week 1 — `shadow`**: run daily, read the Feishu previews, fix any drift in `pitch.md`. Zero risk.
2. **Week 2 — `batch`**: engine posts unless you veto. You glance at one card/day; ignore = it ships.
3. **Steady state — `auto`** on the channels you trust (start with github: `gh` posting is the most
   reliable and reversible; graduate twitter/reddit once the browser-post path proves stable).
4. `kill_switch` and `abort.txt` are always live. `guard.py` caps/variation/backoff are always on,
   so even `auto` cannot exceed the rate/repetition limits that get accounts flagged.
