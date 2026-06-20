---
name: snipe
description: Twitter/X 截流。在 coding/AI agent 工具的高流量推广帖下，自动发现→起草→自我批判→护栏→（按 posture）发布 pikiloom 回复，并记录+度量。内容话术统一来自 _promo/pitch.md；可由 _promo/orchestrate.md 无人值守驱动。
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent, WebFetch, mcp__pikiloom-browser__browser_navigate, mcp__pikiloom-browser__browser_take_screenshot, mcp__pikiloom-browser__browser_snapshot, mcp__pikiloom-browser__browser_press_key, mcp__pikiloom-browser__browser_click, mcp__pikiloom-browser__browser_evaluate, mcp__pikiloom-browser__browser_type, mcp__pikiloom-browser__browser_run_code_unsafe, mcp__pikiloom-browser__browser_wait_for, mcp__pikiloom-browser__browser_tabs
argument-hint: "[keywords] or blank for default sweep"
---

# Snipe: Twitter/X 热帖截流

在 coding agent / AI 开发工具领域的高流量推广帖下回复 pikiloom，截取流量拿 star。

**本 skill 只负责 Twitter 渠道的「发现 + 抽取 + 发布」机制。** 所有产品话术、差异点、诚实边界、
语气/语言规则、回复骨架与反模式，统一来自 **[`../_promo/pitch.md`](../_promo/pitch.md)** —— 不在本文件
重复，也不要在本文件改话术（改话术只改 pitch.md）。去重 / 护栏 / 度量 / 发布姿态由共享核心负责：

| 关注点 | 位置 |
|---|---|
| 产品话术 SSOT | `_promo/pitch.md`（§9 表里 twitter 列是本渠道的机制差异） |
| 去重记录（写时强制） | `_promo/registry.py`（channel = `twitter`） |
| 发布护栏（频次/集中度/变体/熔断） | `_promo/guard.py` |
| 飞书推送 | `_promo/push_feishu.py` |
| 无人值守编排 + posture | `_promo/orchestrate.md` |
| 旋钮（caps / posture / kill switch） | `_promo/config.json` → `channels.twitter` |

> 运行根目录：`cd /Users/admin/Desktop/project/pikiloom`。脚本前缀：`.pikiloom/skills/_promo/`。

## Twitter 渠道的两个铁律（来自实测 + 平台研究）

1. **链接绝不放主回复正文。** X 对带外链的帖/回复显著降权。主回复 = 一句差异化 + `npx pikiloom@latest`
   （平台内原生文本，不触发降权）；**GitHub 链接放到对自己回复的自回复（self-reply）里**。
2. **绝不复制同一段文案 / 同一条外链刷多帖** —— 这是 X 明文的封号信号。每条独立起草（`guard.py` 的
   变体检查会拦截过相似的草稿）。

---

## 工作流（手动单次运行；无人值守见 `_promo/orchestrate.md`）

### Step 1: 预检
```bash
cd /Users/admin/Desktop/project/pikiloom
python3 .pikiloom/skills/_promo/guard.py caps      # 看 twitter 今日剩余配额；为 0 则今天不跑
```

### Step 2: 搜索高流量推广帖（浏览器）

**传入关键词参数** → 直接搜该词。**否则**用场景关键词动态发现（搜 3–5 组即可，不要死记产品名）：

```
coding agent tool / AI coding assistant / claude code tool / remote coding agent
AI agent dashboard / vibe coding 工具 / coding agent mobile / AI dev tool launch
claude code api cost / claude max subscription   (billing 段 = 最高转化，命中用 pitch 角度 0)
```

对每个关键词：
1. `browser_navigate` → `https://x.com/search?q={keyword}&src=typed_query&f=top`
2. `browser_wait_for` 确认推文加载
3. 读取 [`scripts/extract_tweets.js`](./scripts/extract_tweets.js)，用 `browser_evaluate` 注入执行，得到 JSON
4. 结果不够就按 End 滚动一次再抽
5. 合并所有关键词结果，按 `text[:80]+url` 去重。无效关键词直接跳过。

### Step 3: 筛选候选

**硬门槛（全部满足）：** `views > 5000`；最近 48h 内；与 pikiloom 有功能交集；正在推广具体产品/工具
（有 `has_product_signal`）；不在 registry：
```bash
python3 .pikiloom/skills/_promo/registry.py seen twitter "<tweet_url>" && echo SKIP   # 已记录则跳过
```
**排除：** 自己(@sthnavy)的帖；纯新闻/讨论/提问；已是 pikiloom 用户；政治/争议。

**优先级：** ① 功能高度重叠的产品推广帖（截流最佳）② 同赛道不同切入点 ③ 泛 AI 工具帖。选 Top 3–5。

### Step 4: 起草（子 agent，话术来自 pitch.md）

委托子 agent 起草，内容契约 = [`../_promo/pitch.md`](../_promo/pitch.md)：orienter(§1) + 挑一个最锋利的
差异点(§2，billing 命中优先) + 诚实边界(§3) + 语言跟随原帖(§6)。**Twitter 形态（pitch §9）：**

```
{一句差异化，直击原帖产品短板或 pikiloom 独特优势 —— 必须 ground 在原帖具体内容上}
npx pikiloom@latest
```
（**正文到此为止，不含链接**。1–2 句最佳，绝不超 3 句。）

**自回复（second tweet）内容：**
```
Open-source, runs local: https://github.com/xiaotonng/pikiloom
```

每条起草后立即记录（存草稿文本供变体检查）：
```bash
python3 .pikiloom/skills/_promo/registry.py add --channel twitter --url "<tweet_url>" \
  --status drafted --type launch --lang <en|zh> --audience <views> --title "<摘要>" \
  --draft-file /tmp/snipe_draft_<id>.txt
```

### Step 5: 自我批判（替代人工 review）

对每条草稿按 pitch.md §10 反模式自检（营销腔 / 贬低原帖 / 堆功能 / 超长 / 未 ground 原帖 / 越诚实边界）。
FAIL → 让子 agent 修一次；再 FAIL → `registry.py update --channel twitter --url <u> --status skipped` 丢弃。

### Step 6: 护栏 + 按 posture 发布

```bash
python3 .pikiloom/skills/_promo/guard.py check --channel twitter --url "<tweet_url>" \
  --draft-file /tmp/snipe_draft_<id>.txt        # exit 3 = deny；deny 则 update --status skipped 跳过
POSTURE=$(python3 -c "import json;print(json.load(open('.pikiloom/skills/_promo/config.json'))['posture'])")
```

- **shadow**：不发，推预览卡片即可。
- **batch**：`update --status approved` + 推 veto 卡片（见 orchestrate.md Phase 4）。
- **auto**：直接发（浏览器，见下）。

**浏览器发推机制（main reply + self-reply）：**
1. `browser_navigate` 到 tweet_url。
2. 点回复框，`browser_type` 主回复正文（差异化 + `npx pikiloom@latest`，**无链接**），提交。
3. 提交后定位到刚发出的自己的回复，点它的「回复」，`browser_type` 自回复（GitHub 链接行），提交。
   X 会对链接自动生成卡片。
4. **发送前后各截图核对**：发前确认正文不含 `github.com`；发后读 DOM 确认主回复无外链、自回复有链接，
   且文案只出现一次（防重复粘贴）。异常则不再操作，记 `failed` 让人工介入。
5. 成功后记录：
```bash
python3 .pikiloom/skills/_promo/registry.py mark-posted --channel twitter \
  --url "<tweet_url>" --post-url "<我们主回复的 url>"
```

### Step 7: 报告 + 度量

把候选 + 草稿整理为 `/tmp/snipe_report.md`（每条含：作者/链接/views/likes/推广产品/交集/差异点/草稿），推飞书：
```bash
python3 .pikiloom/skills/_promo/push_feishu.py --report-file /tmp/snipe_report.md --title "🎯 Snipe 候选"
python3 .pikiloom/skills/_promo/measure.py report      # t.co referrer / star 关联，附在卡片后
```
输出 `OK:` 成功 / `SKIP:` 缺飞书凭证 / `ERROR:` 失败（兜底把报告贴进对话）。

## 注意事项

- **质量 > 数量**：每次 3–5 条候选即可；`guard.py` 会按 `config.json` 的 daily_cap / per_author / 变体兜底。
- **不要固定搜某个产品名** —— 用场景关键词动态发现，这个领域每天有新工具。
- **kill_switch / abort.txt 随时生效**；账号尽量用 Premium（链接容忍度 + 触达约 10×）。
- 历史案例规律：原帖与 pikiloom 功能越接近，回复转化越高。
