# pikiloom Promotion — Shared Source of Truth (`pitch.md`)

> **This is the single source of truth for *what pikiloom is and how we talk about it*.**
> `snipe` (Twitter/X), `reddit-snipe` (Reddit), and `promote` (GitHub) all read product copy
> **from here**. Channel SKILLs hold *channel mechanics only* (search, extract, post, rate-limit) —
> they must never carry their own product one-liner, differentiator list, or honesty bounds.
> **Edit a product claim in exactly one place: this file.** If a claim drifts between channels,
> that is a bug in the channel skill, not a content choice.

---

## 0. Canonical identifiers (NEVER drift)

| Field | Value |
|---|---|
| Name | **pikiloom** — never `pikiclaw` (renamed; the npm `pikiclaw` package is only a forwarding shim, do not advertise it) |
| Install | `npx pikiloom@latest` |
| Repo | `https://github.com/xiaotonng/pikiloom` |
| npm | `pikiloom` |
| Twitter | `@sthnavy` |
| Reddit | `u/Appropriate-Seat-534` (display `owaowo 👾`) |

**One-liner (canonical):** an open **agent orchestrator** — runs a *swarm* of Claude Code / Codex /
Gemini / Hermes (or any CLI/ACP agent) in parallel, driven from a web dashboard or any IM
(Telegram / Feishu / WeChat / Slack / Discord / DingTalk / WeCom). Runs entirely on your machine;
routes any model (frontier / Chinese domestic / local Ollama·mlx-lm / OpenRouter / any
OpenAI-compatible). Self-bootstrapped — pikiloom is built with pikiloom.

---

## 1. Orienter (one compact line — assume the reader has never heard of pikiloom)

The orienter is **always one line**, never a feature paragraph. Vary the surface form per draft so it
never reads as a copy-paste signature, but **always** include the two load-bearing identifiers:
`Claude Code / Codex / Gemini` **and** `IM (Telegram / Feishu / Slack / Discord / …) + dashboard`.
Pick the **2–3 channels that match the host** (a Discord-bot repo → lead with Discord); do not list all seven.

- **zh:** “我自己也在做一个类似的东西 `pikiloom`——一个 agent orchestrator，把 Claude Code / Codex / Gemini 接到 飞书 / Telegram / Slack / Discord 等 + 本地 dashboard，可并行跑多个 agent。”
- **en:** “I'm building a similar thing (`pikiloom`) — an agent orchestrator that runs Claude Code / Codex / Gemini across Telegram / Slack / Discord (and more) plus a localhost dashboard, several agents in parallel.”

---

## 2. Differentiator angles — pick the ONE (max two) matched to the target's pain. NEVER enumerate.

> Ordered by sharpness. **Angle 0 (cost/billing) outranks all others** — lead with it the moment the
> target mentions API cost, API keys, `-p`/headless, SDK credits, or "burning credits". It is the
> highest-conversion message we have.

**0. Cost / Billing (the headline differentiator).**
pikiloom's **default** Claude driver runs the *real interactive Claude Code TUI* under a PTY, so turns
count against your existing **Claude Pro/Max subscription** — the same billing path as using Claude
Code yourself, **no extra API spend**. Most IM/automation wrappers shell out to `claude -p` / the Agent
SDK, which bills the **separate metered API credit pool** on top of your subscription. That is the gap
pikiloom closes.

1. **Single agent / single session** → "Dashboard runs N agents in N panes in parallel — Claude in one, Codex in another, Gemini in a third, each its own workspace; switch via tabs."
2. **Rough UX / complex setup** → "Single `npx pikiloom@latest` start, no config files, dashboard auto-opens."
3. **Closed / no plugins** → "Open skill/MCP plugin model — drop in community skills, they work in every session and every agent."
4. **Closed-source SaaS** → "Fully OSS, runs entirely local; your conversations and code never leave the machine."
5. **CLI-only** → "Web dashboard for full session control in the browser — streaming tool-use, thinking traces, plan progress."
6. **Desk-bound only** → "Drive the same session from any IM — Telegram / Feishu / WeChat / Slack / Discord / DingTalk / WeCom — take over from your phone."
7. **Team wants to share** → "Group mode: drop it into a Slack / Discord / Feishu group and the whole team steers the same agent swarm."
8. **Locked to one agent / model** → "Agent-agnostic (Claude Code / Codex / Gemini / Hermes / any ACP agent) and model-agnostic (frontier + local Ollama/mlx-lm + OpenRouter + any OpenAI-compatible), per-agent selection, switch mid-session."
9. **Single-platform automation** → "macOS desktop automation (Peekaboo) + Playwright browser control with a managed login profile, built in."

---

## 3. Honesty bounds (HARD — these claims get tested in public; never cross)

- **Billing claim is Claude-specific** (Pro/Max only). Codex / Gemini bill on their own terms — never imply otherwise.
- Say **"no *extra* API bill"**, never "free" or "unlimited" — subscription usage limits still apply.
- It is **not a hack / loophole** — it is the exact path interactive Claude Code already uses.
- **Never assert a named competitor "overcharges."** The neutral true frame is: "most `-p`/SDK-based wrappers bill API credits."
- **Never fabricate a differentiator.** Use only UX/execution points that are true today; show, don't tell.
- Only claim a capability pikiloom **actually ships today**. Readers will check. If unsure, drop the claim.

---

## 4. Credibility anchors (file/function-level — for the ONE implementation-evidence sentence)

Use exactly one, matched to the angle. This proves "they built it", not "let me teach you how it works".

| Angle | Anchor |
|---|---|
| 0 billing | tails the JSONL transcript at `~/.claude/projects/<id>.jsonl`, runs the same usage/tool parser as print mode; falls back to `-p` only if PTY allocation fails |
| 1 multi-session | `agent/stream.ts` is the CLI spawn framework; `agent/driver.ts` keeps each agent pluggable; each dashboard pane = one session + workspace |
| 3 skills/MCP | `agent/mcp/bridge.ts` injects session-scoped MCP tools per stream; `agent/mcp/extensions.ts` merges global + workspace config |
| 6 IM channels | each channel under `channels/*/` is physically isolated; one `runStream()` in `bot/bot.ts` drives them all |
| 9 browser/desktop | `browser-supervisor.ts` is the process-singleton for a managed Chrome profile (login persists); Peekaboo MCP for macOS Accessibility |
| watchdog/resume | restart coordination + process-tree kill in `core/process-control.ts`; PID-liveness gate at `doStream()` |

---

## 5. Voice & tone (HARD constraints — the critic rejects any draft that violates these)

- **Voice = humble peer-builder sharing implementation notes.** Frame: "I hit the same thing; here's how I handled it, in case any of it is useful." The reader decides whether to look further.
- **Disclosure is mandatory and is also our shield:** every draft says "I'm building pikiloom" (or 我在做 `pikiloom`). Undisclosed promotion is what gets flagged; disclosed peer-sharing is what platforms tolerate.
- **Never address the maintainer/mod** (no "供作者参考", "@maintainer", "thanks for considering"). The reply is for the issue author / thread OP / lurkers.
- **Never critique the host project.** No "switch from X", "X doesn't support", "while waiting for X to fix", "X 还没做" — even neutral-sounding versions telegraph competitive intent. pikiloom is *another option*, never a *replacement*.
- **Never boast** ("我做了一遍" / "mine is better"). Prefer matter-of-fact: "我自己卡过同样的问题，后来这样处理".
- **Lead with implementation specifics over feature names.** That signals real building, not marketing.
- **Mention at most 1–2 differentiators**, both matched to the exact pain. Never a feature list.

---

## 6. Language rule (HARD)

- **`promote` / `snipe`:** reply in the **language of the target's own text** (issue body / tweet), NOT the repo's or platform's default. Chinese issue in an English repo → Chinese reply. Japanese → 日本語. Else English.
- **`reddit-snipe`:** **English-first** (account is positioned for an English audience); only switch if the OP clearly writes another language *and* the sub is that language's community.
- Code identifiers, file paths, and CLI commands stay in their native form regardless of language.

---

## 7. Humble closes (use one; vary across drafts)

- **zh:** “希望对你有帮助。” / “权当一个参考。” / “如果思路不对就忽略。” / “在你的场景下不一定合适，给个参考。” / “一个参考思路。”
- **en:** “Sharing in case the shape is useful.” / “One reference shape — ignore if it doesn't fit.” / “In case any of that helps.” / “Happy to dig in if it lines up with what you're after.”
- **ja:** “ご参考まで。” / “もしご参考になれば。”
- **Never:** “供作者参考” / “供大佬参考” / “@author what do you think” / “looking forward to your thoughts”.

---

## 8. Reply skeleton (the shape every draft follows)

1. **Peer-position + one-line orienter** (§1). Assume the reader arrived from a notification and has never heard of pikiloom. Fold "I hit the same thing" and the orienter into the *same* opener — never an ad-header paragraph.
2. **Out-of-box claim — the headline.** Answer the reader's real question — *"if I install this, do I get this without setup?"* — FIRST, pinned to the issue's exact pain. Not "pikiloom has lots of features" but "this exact capability is there the moment you run `npx pikiloom@latest`, no config edits / env vars / patches." This is the load-bearing sentence.
3. **One sentence of implementation evidence** (§4) — the credibility anchor. Exactly one sentence; not a tutorial.
4. Trial line: `npx pikiloom@latest`
5. Project link: `https://github.com/xiaotonng/pikiloom` *(channel-specific placement — see §9)*
6. *Optional* humble close (§7) on its own line, when the thread is heated or the author did deep root-cause work themselves.

---

## 9. Channel deltas (mechanics that differ; content above stays identical)

| | `snipe` (Twitter/X) | `reddit-snipe` (Reddit) | `promote` (GitHub) |
|---|---|---|---|
| Target type | viral promo tweets of same-space tools | feature-request / "what do you use" / evergreen comparison threads | **feature-request / user-question** issues only (never bug reports) |
| Link placement | **NEVER in the main reply** — main reply = pitch + `npx pikiloom@latest` (native, no penalty); **GitHub link goes in a self-reply** (X downranks link-bearing posts) | inline `npx … · github…` line, unless the sub bans links → no-link variant | inline at the end of the comment |
| Length | 1–2 sentences (≤3) | 2–4 sentences | ≤5 sentences |
| Disclosure | "building pikiloom" framing | "I'm building pikiloom" from the first line | "I'm building / 我在做 pikiloom" |
| Hard "do not" | identical text/link across replies (documented X spam flag) | one comment per thread; never on `skip`-flagged subs | one comment per repo lifetime; never on upstream-body repos (`anthropics/claude-code`) |

---

## 10. Anti-patterns — the critic rejects the draft if ANY apply

- Reads like marketing copy / vendor voice ("pikiloom is X", "pikiloom can do X", "check out", "you should try").
- Compares pikiloom to the host project, or implies the host is lacking.
- Opens with implementation detail before the reader knows what pikiloom is.
- Leads with implementation **before** the out-of-box claim.
- Out-of-box claim is generic instead of pinned to the issue's specific capability.
- Lists more than 2 differentiators / reads as a feature enumeration.
- Orienter expanded into a feature paragraph, or placed as a separate ad-header before the peer-position.
- Implementation paragraph exceeds one sentence (tutorial, not a peer note).
- Exceeds the channel length cap (§9).
- Missing the disclosure line, the `npx pikiloom@latest`, or the repo link (where the channel requires it).
- Addresses the maintainer/mod, or uses a forbidden close (§7).
- Recognizably the same paragraph as another draft in the batch (boilerplate → "coordinated inauthentic activity" signal). Each draft must be independently written for its target.
