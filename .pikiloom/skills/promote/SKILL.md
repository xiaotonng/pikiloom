---
name: promote
description: GitHub 截流。在同领域项目（local coding agent ↔ IM / mobile / remote console）的 feature-request issue 下，自动发现→起草→自我批判→护栏→（按 posture）发布 pikiloom 回复，并记录+度量。话术统一来自 _promo/pitch.md；可由 _promo/orchestrate.md 无人值守驱动。
version: 6.0.0
---

# GitHub Promotion Workflow

This skill targets the open issues of **same-space projects** (local coding agent ↔ IM / mobile /
remote console) — where users have already self-identified as needing this category of tool. We share
pikiloom as another option; we never position against the host project.

**This file holds GitHub-specific mechanics only** (which repos, which issues, how to post). All product
copy, differentiators, honesty bounds, tone, language, skeleton, and anti-patterns come from
**[`../_promo/pitch.md`](../_promo/pitch.md)** — do not duplicate or edit copy here. Dedup / guardrails /
posting-posture / measurement come from the shared core:

| 关注点 | 位置 |
|---|---|
| 产品话术 SSOT | `_promo/pitch.md`（§9 表 github 列 = 本渠道机制差异） |
| 去重（写时强制） | `_promo/registry.py`（channel = `github`） |
| 护栏（每仓上限/日配额/变体/熔断/deny_repos） | `_promo/guard.py` |
| 飞书推送 / 度量 | `_promo/push_feishu.py` / `_promo/measure.py` |
| 无人值守编排 + posture | `_promo/orchestrate.md` |
| 旋钮 | `_promo/config.json` → `channels.github` |

> 运行根目录：`cd /Users/admin/Desktop/project/pikiloom`。脚本前缀：`.pikiloom/skills/_promo/`。

## GitHub 渠道的铁律

1. **只打 feature-request / 用户提问 issue，绝不打 bug 报告。** "能加 X 吗" 是开放问题，分享别的工具已有
   X 是正当同行信息；bug 报告是宿主实现的封闭范围，进去推等于批评。`guard.py` 不知道 issue 类型 —— 这一条
   靠筛选阶段把关。
2. **每仓终身 ≤ 2 条**（`config.json` `per_repo_lifetime_cap`）。历史上 `chenhg5/cc-connect` 13 条、
   `RichardAtCT/claude-code-telegram` 10 条 —— 这种集中度正是 AUP §4「coordinated inauthentic activity」
   要抓的轮廓。`guard.py` 会按 registry 里的历史强制拦截超限的仓。
3. **不打上游本体仓**（`anthropics/claude-code` 等，见 `deny_repos`）—— 不是同类桥接，曝光最高、有官方
   triage、风险最大。历史误打了 14 条，停止。`guard.py` 直接 deny。
4. **每条独立起草 + 必带披露行**（"I'm building / 我在做 pikiloom"）。披露既是诚实也是护身符；boilerplate
   翻译版仍是 boilerplate，`guard.py` 变体检查会拦。

---

## Step 1: 预检
```bash
cd /Users/admin/Desktop/project/pikiloom
python3 .pikiloom/skills/_promo/guard.py caps      # github 今日剩余配额；为 0 则今天不跑
```

## Step 2: 主路径 — 同领域项目 issue

walk 下列同类项目的 issue tracker（pikiloom 原生支持 Telegram/Feishu/WeChat/Slack/Discord/DingTalk/WeCom，
所有 IM-bridge 仓都是同渠道同类）。bucket 内并行，按时间排序，忽略 >90 天且无活动的。

### Bucket A — IM-channel peers（原生，契合度最高）
```bash
# Telegram
for r in chenhg5/cc-connect RichardAtCT/claude-code-telegram a5c-ai/claude-code-telegram-bot \
         seedprod/claude-code-telegram cutevisor/return-by-death JohannOosthuizen/Gemini-CLI-Telegram-Bot \
         ada720725-star/claude-code-telegram gohyperdev/hdcd-telegram; do
  gh issue list --repo "$r" --state open --limit 40; done
# Feishu
for r in laborany/laborany MidnightV1/Claude-Code-Feishu whobot-ai/claude-code-feishu-channel \
         m1heng/clawdbot-feishu CherryLover/claude-code-feishu AwadYoo/claude-code-feishu-channel \
         czm15053/claude-code-feishu-channel AkaiZheng/ClaudeCode-Feishu-Channel; do
  gh issue list --repo "$r" --state open --limit 30; done
# WeChat
for r in Johnixr/claude-code-wechat-channel Wechat-ggGitHub/wechat-claude-code m1heng/claude-plugin-weixin; do
  gh issue list --repo "$r" --state open --limit 30; done
```

### Bucket B — 更多 IM-channel peers（Discord / Slack / DingTalk / WeCom，均原生）
```bash
for r in zebbern/claude-code-discord timoconnellaus/claude-code-discord-bot ebibibi/claude-code-discord-bridge \
         BrunoJurkovic/claude-code-discord-status jubalm/claude-code-discord \
         mpociot/claude-code-slack-bot jeremylongshore/claude-code-slack-channel 41fred/claude-code-slack \
         AnandChowdhary/claude-code-slack-bot sfyyy/claude-code-dingtalk-mcp; do
  gh issue list --repo "$r" --state open --limit 30; done
```

### Bucket C — Mobile / remote / dashboard
```bash
for r in 9cat/claude-code-app ahmed3elshaer/everything-claude-code-mobile aiya000/claude-code-mobile-ssh \
         qingpingwang/remote-claude-code BMeyn/claude_code_mobile; do
  gh issue list --repo "$r" --state open --limit 30; done
```

**定期刷新仓列表**（这个领域更新很快）：
```bash
for kw in "claude code telegram" "claude code feishu" "claude code wechat" "claude code discord" \
          "claude code slack" "claude code dingtalk" "claude code wecom" "claude code 企业微信" \
          "claude code mobile" "claude code swarm" "codex telegram" "codex feishu" "gemini cli telegram"; do
  gh search repos "$kw" --limit 15 --json fullName,stargazersCount,description,pushedAt \
    --jq 'sort_by(-.stargazersCount) | .[] | "\(.stargazersCount)★ \(.fullName) — \(.description // "")"'
done
```
>10★ 且 90 天内有 push 而不在上面的，按类别补进 A/B/C。

## Step 3: 次路径 — 关键词搜索（主路径不足 5 条候选时才跑）

```bash
# billing 段 = 最高转化（付 API credits、想用 Max 订阅跑自动化的人）；GitHub issue 搜索是 term-AND，
# 长 phrase 返回 ~0，用下面这些校准过能出 open issue 的词：
for q in "claude code billing" "claude code credits" "claude max api" "use claude subscription" \
         "claude code subscription" "claude code mobile" "claude code telegram" "claude code 飞书" \
         "claude code 微信" "agent web dashboard" "run multiple coding agents"; do
  gh search issues "$q" --state open --limit 30 --json url,title,repository \
    | jq -r '[.[] | select(.repository.name | test("trending|news|weekly|github-daily|awesome|digest|bulletin|pikiloom|pikiclaw"; "i") | not)
        | select(.repository.nameWithOwner | test("xiaotonng/") | not)]
        | .[] | "\(.url) | \(.title) | \(.repository.nameWithOwner)"'; done
```
> **billing 段命中时，回复用 pitch §2 角度 0 开场**（守住 §3 诚实边界）。
> **丢弃 issue-mirror / digest bot**（republish 别人 issue，OP 不在那）：小仓上的 4–5 位 issue 号、
> 或标题像 `[upstream PR N] …` / `Weekly Tech Report` / `AI CLI 日报`。起草前先 `gh issue view` 确认。

## Step 4: 去重 + 筛选

对每个候选 URL 先去重，再 `gh issue view <url>` 读全文再判断：
```bash
python3 .pikiloom/skills/_promo/registry.py seen github "<issue_url>" && echo SKIP   # 已记录则跳过
```
**全部满足才选：** ① 是 feature-request / 用户提问（**不是**宿主实现相关的 bug）② pikiloom **今天就有**这个能力
（不要硬拗，读者会查）③ 线程还活着（近期活动，未 closed/wontfix/locked）④ 作者是用户而非 maintainer 在做路线规划。
**任一命中即跳过：** bug 报告 / maintainer 已承诺修或有在飞 PR / 社区公告 / pikiloom 并无该能力 / 争议政治帖。

pikiloom 真正能解的痛点见 **pitch.md §2**（角度 0 billing 是头牌差异点；其余按 OP 痛点挑 1–2 个）。选 **3–6** 条最强候选。

## Step 5: 起草（子 agent，话术来自 pitch.md）

委托子 agent 起草，**唯一内容契约 = [`../_promo/pitch.md`](../_promo/pitch.md)**：peer-position+orienter(§1) →
out-of-box 主张(§8 step2，回答"装好是不是开箱即有") → 一句实现证据(§4) → `npx pikiloom@latest` →
`https://github.com/xiaotonng/pikiloom`。语言跟随 **issue 正文**(§6)，≤5 句，挑 1–2 个对得上的差异点(§2)。

每条起草后记录：
```bash
python3 .pikiloom/skills/_promo/registry.py add --channel github --url "<issue_url>" \
  --status drafted --repo "<owner/repo>" --type <feature-request|question> --lang <en|zh|ja> \
  --title "<issue 标题>" --draft-file /tmp/promo_draft_<id>.txt
```

## Step 6: 自我批判（替代人工 review gate）

对每条草稿按 pitch.md §10 自检（营销腔 / 对比宿主 / >2 差异点 / 超 5 句 / 没 ground issue 痛点 / 缺披露 /
越诚实边界 / boilerplate）。FAIL → 子 agent 修一次；再 FAIL → `update --status skipped` 丢弃。不做第三次。

## Step 7: 护栏 + 按 posture 发布

```bash
python3 .pikiloom/skills/_promo/guard.py check --channel github --url "<issue_url>" \
  --draft-file /tmp/promo_draft_<id>.txt        # exit 3 = deny（每仓上限/deny_repos/日配额/变体）；deny 则跳过
POSTURE=$(python3 -c "import json;print(json.load(open('.pikiloom/skills/_promo/config.json'))['posture'])")
```
- **shadow**：不发，推预览卡片。
- **batch**：`update --status approved` + 推 veto 卡片，veto 窗口后由后续 run 发（见 orchestrate.md Phase 4）。
- **auto**：直接发：
```bash
gh issue comment "<issue_url>" --body-file /tmp/promo_draft_<id>.txt
python3 .pikiloom/skills/_promo/registry.py mark-posted --channel github \
  --url "<issue_url>" --post-url "<我们评论的 url>"      # 失败则 update --status failed
```
> GitHub `gh` 发帖是三渠道里最可靠、最可逆的，建议 `auto` 从 github 先开。

## Step 8: 报告 + 度量 + 回访

```bash
python3 .pikiloom/skills/_promo/registry.py stats
python3 .pikiloom/skills/_promo/push_feishu.py --report-file /tmp/promo_report.md --title "🚀 GitHub Promote"
python3 .pikiloom/skills/_promo/measure.py report
```
**回访**：≥24h 的评论若被 hide/lock，`registry.py update --channel github --url <u> --status hidden` —— 会触发
`guard.py` 熔断，暂停该渠道。报告含：搜索/候选/已发/跳过/失败计数 + 下轮建议（如"Feishu 簇有 4 条新 open issue，7 天后再来"）。
