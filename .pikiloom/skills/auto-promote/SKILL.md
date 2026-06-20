---
name: auto-promote
description: 无人值守推广总入口。按 _promo/orchestrate.md 跨所有启用渠道（GitHub / Twitter / Reddit）跑一轮：发现→去重→起草→自我批判→护栏→按 posture 发布→记录→度量。供每日 cron（schedule / loop）调用，也可手动运行。传 "post-approved" 只执行 batch 待发队列。
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent, WebFetch, mcp__pikiloom-browser__browser_navigate, mcp__pikiloom-browser__browser_take_screenshot, mcp__pikiloom-browser__browser_snapshot, mcp__pikiloom-browser__browser_press_key, mcp__pikiloom-browser__browser_click, mcp__pikiloom-browser__browser_evaluate, mcp__pikiloom-browser__browser_type, mcp__pikiloom-browser__browser_run_code_unsafe, mcp__pikiloom-browser__browser_wait_for, mcp__pikiloom-browser__browser_tabs
argument-hint: "blank for a full run | post-approved | channel:github|twitter|reddit | shadow"
---

# Auto-Promote — 无人值守推广总入口

跨三渠道跑一轮完整推广，**严格执行 [`../_promo/orchestrate.md`](../_promo/orchestrate.md)**。
这是给每日 cron 调用的单一入口；也可手动跑。所有话术来自 `_promo/pitch.md`，去重/护栏/度量来自共享核心。

> 运行根目录：`cd /Users/admin/Desktop/project/pikiloom`。

## 参数

- **（空）** → 完整一轮：Phase 0→5，所有 `enabled` 且有剩余配额的渠道。
- **`post-approved`** → 只执行 orchestrate.md Phase 4 的「发 batch 待发队列」：发 `registry.py pending` 里
  `status=approved`、`drafted_at` 早于 `veto_window_hours`、不在 `abort.txt`、且重新 `guard.py check` 通过的记录。
  （`batch` posture 下，由 veto 窗口之后的第二个 cron 调用。）
- **`channel:<github|twitter|reddit>`** → 只跑该渠道。
- **`shadow`** → 本轮强制 shadow（不发，只预览），无视 config 的 posture。

## 执行

1. **读 orchestrate.md 并逐 Phase 执行。** 不要在这里重述流程 —— orchestrate.md 是唯一权威 runbook。
2. **Phase 0 预检**：先 `measure.py pull`；读 `config.json` 的 `kill_switch` / `posture`；`guard.py caps`
   看各渠道剩余配额。`kill_switch=true` → 推一张「已停（kill switch）」卡片并结束。
3. **每个渠道的发现/抽取/发布机制**委托给对应渠道 SKILL（`promote` / `snipe` / `reddit-snipe`），
   本入口只负责按 orchestrate.md 的跨渠道契约串起来（去重 → 起草 → 批判 → 护栏 → posture 发布 → 记录）。
4. **起草与批判**用子 agent（话术契约 = `pitch.md`）。**发布前必过 `guard.py check`**（exit 3 = 跳过）。
5. **收尾**：`registry.py stats` + `measure.py report`，把本轮 posted/skipped/failed 计数 + 度量推飞书。

## 安全契约（硬性）

- 发布的唯一开关是 `config.json.posture`；**绝不**在本 skill 里硬编码绕过 posture / 护栏 / 去重。
- 一切发布前都经过 `guard.py`（频次、每仓/每 sub 上限、变体、熔断、kill_switch、abort.txt）。
- 失败（发帖报错 / 校验异常）记 `status=failed` 并继续下一条，绝不中断整轮。
- GitHub 用 `gh issue comment` 最稳，建议 `auto` 从 github 渠道先开；Twitter/Reddit 走浏览器，稳定后再开。

## 调度（每日）

- `schedule` 技能：建一个每日 routine 跑 `/auto-promote`；`batch` posture 再加一个 `veto_window_hours`
  之后的 routine 跑 `/auto-promote post-approved`。
- `loop` 技能：按天 `loop` `/auto-promote`（每轮先发上一轮的 approved 队列，再起草新一轮）。
