---
name: reddit-snipe
description: Reddit 截流。在 coding agent / Claude Code / AI dev tool 的高互动帖下，以 pikiloom builder 身份自动发现→起草→自我批判→护栏→（按 posture）发布英文 peer 评论，并记录+度量。English-first。话术统一来自 _promo/pitch.md；可由 _promo/orchestrate.md 无人值守驱动。
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent, WebFetch, mcp__pikiloom-browser__browser_navigate, mcp__pikiloom-browser__browser_take_screenshot, mcp__pikiloom-browser__browser_snapshot, mcp__pikiloom-browser__browser_press_key, mcp__pikiloom-browser__browser_click, mcp__pikiloom-browser__browser_evaluate, mcp__pikiloom-browser__browser_type, mcp__pikiloom-browser__browser_run_code_unsafe, mcp__pikiloom-browser__browser_wait_for, mcp__pikiloom-browser__browser_tabs
argument-hint: "[keyword] | [r/subreddit] | blank for full sweep"
---

# Reddit-snipe: Reddit 热帖截流（英文为主）

在 Reddit 同领域社区/搜索结果中找到讨论 Claude Code / coding agent / AI dev tool 的高互动帖子，
**始终以 pikiloom builder 身份**生成英文回复草稿，推送到飞书供人工审核。**绝不自动发评论**。

**身份原则**：从第一条评论开始就明确"I'm building pikiloom"。不做匿名 karma-farming，
不在 OP 面前伪装成普通用户。Reddit 反自我营销文化是对**推销话术**的反感，不是对**坦诚的 builder**
的反感 — peer-builder 语气 + 真实回应 OP 痛点，本身就是被欢迎的。

**本文件只负责 Reddit 渠道的机制**（发现 / 抽取 / sub 规则 / 浏览器发评论）。产品话术、差异点、诚实
边界、语气统一来自 **[`../_promo/pitch.md`](../_promo/pitch.md)**（不在本文件重复、不在本文件改话术）。
去重 / 护栏 / posture / 度量由共享核心负责：

| 关注点 | 位置 |
|---|---|
| 产品话术 SSOT | `_promo/pitch.md`（§9 表 reddit 列 = 本渠道机制差异，含 no-link 变体规则） |
| 去重（写时强制） | `_promo/registry.py`（channel = `reddit`） |
| 护栏（日 3 条 / 单 sub 1 条 / 变体 / 熔断） | `_promo/guard.py` |
| 飞书推送 / 度量 | `_promo/push_feishu.py` / `_promo/measure.py` |
| 无人值守编排 + posture | `_promo/orchestrate.md` |
| 旋钮 | `_promo/config.json` → `channels.reddit` |

## 战略前提（区别于 Twitter snipe）

Twitter 是 feed 截流场，Reddit 是社区贡献场。两套打法完全不同：

| 维度 | Twitter snipe | Reddit-snipe |
|------|---------------|--------------|
| 发现方式 | 关键词搜热帖 | 关键词搜 + 目标 sub 白名单巡逻 |
| 反营销文化 | 弱 | 强（针对推销话术，不针对坦诚 builder） |
| 时效性 | 强（24h 内最佳） | **弱**（推特是 feed 流，新就有效；Reddit 是线程社区，**旧热帖讨论持续**，evergreen 价值更高） |
| 时间窗口 | 24h | **默认 14d**（两周内），评论数 ≥ 5 的热帖优先；24h+ 新帖也保留 |
| 身份 | 跟随账号 persona | **始终是 pikiloom builder**，开门见山 |
| 回复语气 | 一句差异化 + 链接 | peer-builder："I'm building X — saw your thread about Y" |
| 语言 | 跟原帖 | **默认英文**（账号定位英文用户群体） |
| 是否带链接 | 总是 | 默认带（`npx` + GitHub）；少数明确禁外链的 sub 改为只口头提 |
| 内容长度 | ≤3 句 | 2-4 句，必须先回应 OP 的具体问题 |
| 风险 | 封号 | 评论被 mod / automod 删（应对：选 sub + 不重复话术） |

## 当前 Reddit 账号现状（每次运行前检查）

- 用户名：`u/Appropriate-Seat-534`（Reddit 自动生成，throwaway 模式 — 不利于信任）
- Display name：`owaowo 👾`
- About：`AI generalist shipping across big & small orgs 🎮 Coding (Trae @ ByteDance) · Search (Reddo founder) · E-com (Dewu) · Health (Theta) Currently building pikiloom 🧵 — an open agent orchestrator (run a swarm of Claude / Codex / Gemini agents from any IM or the web)`
- Social：Twitter @sthnavy / GitHub
- 已加入 sub：仅 `r/singapore`

> ⚠️ **改名后待办（手动，本 skill 无法代做）**：Reddit 个人主页 bio 此前写的是旧名 `pikiclaw 🦞`，产品已改名 `pikiloom`。运行前确认线上 bio 已改成上面这行(名字 + 去掉 claw 蟹钳 emoji)，否则评论里说 pikiloom、主页却写 pikiclaw，读者一查就穿帮。GitHub / Twitter 链接同理核对指向 `xiaotonng/pikiloom`。

**评论形态由 sub 规则决定，不由 karma 决定：**
- 默认形态：完整 builder 评论，含 `npx pikiloom@latest` + GitHub 链接
- 个别 sub 规则明确禁外链 / 禁 self-promo 链接 → 同一份草稿去掉链接行（口头提 pikiloom 名字即可）
- 极严 sub（见 `target_subreddits.md` 标 `skip` 的）→ 本次直接跳过该 sub，不评论

karma 高低不改变身份。Reddit 的反感是针对推销话术，不是针对坦诚的 builder — 只要是真实回应
OP 痛点 + 不堆功能 + 不贬低同行，第一条评论就可以是 builder 身份。

## 工作流

### Step 0: 预检 + 去重源

```bash
cd /Users/admin/Desktop/project/pikiloom
python3 .pikiloom/skills/_promo/guard.py caps      # reddit 今日剩余配额；为 0 则今天不跑
```
去重统一走共享 registry（写时强制，不再用扁平 `sniped_threads.txt`；旧文件已迁移）。每个候选 thread：
```bash
python3 .pikiloom/skills/_promo/registry.py seen reddit "<thread_url>" && echo SKIP   # 已记录则跳过
```

### Step 2: 决定本轮检索来源

**用户传入参数时：**
- `r/<subname>` → 只巡逻这一个 sub 的 `hot` + `new` 前两页
- 其他字符串 → 作为 Reddit 全站搜索关键词
- 空 → 走默认 sweep（下面）

**默认 sweep（无参数时）的两条平行通道：**

**A. 目标 sub 巡逻**（高信号低噪声）
从 `target_subreddits.md` 读取白名单，对每个 sub **同时**抓三个视图：
- `/hot/` — 当下热门
- `/new/` — 最新（捕获 < 24h 的新生帖）
- `/top/?t=week` 或 `/top/?t=month` — **关键**，evergreen 高热度帖在这里

**B. 跨 sub 关键词搜索**（覆盖白名单之外的讨论）
对每个关键词访问两个 sort 维度（短时效新 + 长时效热）：
```
https://www.reddit.com/search/?q={url-encoded-keyword}&type=link&sort=new&t=week
https://www.reddit.com/search/?q={url-encoded-keyword}&type=link&sort=top&t=month
```

> 不要再用 `t=day` 单一窗口 — Reddit 不是 feed 平台，老帖不会"过时"，只会沉到底但仍能被搜到。

**关键词池（English-first）：**
```
claude code alternative
claude code mobile
claude code dashboard
claude code telegram
remote claude code
self host claude code
codex cli alternative
gemini cli alternative
open source coding agent
multi agent coding
ai coding agent orchestrator
claude code on phone
coding agent wrapper
run multiple claude code
parallel coding agents
claude code slack
claude code discord
agent swarm
claude code api cost
claude code burning credits
claude max subscription headless
claude -p api key
claude code without api key
```

> 关键词不应固定记忆某个产品名，应捕获场景。某个关键词没结果就跳过，不要硬钻。
> **最后 5 个 billing 关键词是最高转化段**：有人抱怨 headless/`-p`/SDK 烧 API credits、想用 Max 订阅跑自动化 —— pikiloom 默认 TUI/PTY 路径正是答案，命中即用 0 号差异点开场（守住诚实边界）。

### Step 3: 抽取页面数据

对每个抓取页面（sub 列表页 / 搜索结果页）：
1. 等待页面加载（确认 `shreddit-post` 出现）。
2. 读取 `.pikiloom/skills/reddit-snipe/scripts/extract_reddit_threads.js` 内容。
3. 通过 `browser_evaluate` 注入执行，得到 JSON 字符串。
4. 解析为 thread 数组。

每条 thread 至少有：`subreddit, author, title, body_preview, url, score, comments, age_hours, post_type, external_url, has_product_signal, lang`.

### Step 4: 筛选候选

**必须满足（hard filter）：**
- 不在 `sniped_threads.txt`
- `age_hours <= 336`（14 天上限；Reddit 线程长尾，evergreen 讨论价值高于 timeliness）
- 英文为主（`lang === 'en'`，非英文跳过）
- 非自己（author 不是 `u/Appropriate-Seat-534`）
- thread 还活着：未 locked / archived（Reddit 6 个月自动 archive 后无法评论）
- 与 pikiloom 功能交集：coding agent / Claude Code / Codex / Gemini CLI / agent dashboard / IM 接入 / 多会话管理 / 远程控制 / mobile / 插件 / skill / MCP

**热度门槛（任一满足即可）：**
- 新帖（age < 24h）：`comments >= 3` 或 `score >= 5`（早进有先发优势）
- 中等期（1d ≤ age < 7d）：`comments >= 10` 或 `score >= 20`（已经积累一些讨论）
- 旧帖（7d ≤ age < 14d）：`comments >= 30` 或 `score >= 100`（必须是社区里有持续 visibility 的高热度帖）

**优先级（高 → 低）：**
1. **OP 在求解一个具体痛点**，且这个痛点 pikiloom 能直接回应（最高价值 — 真正的 peer-help。**时效不重要：旧帖只要还在被人搜到 / mod 推荐，价值不减**）
2. **高热度 evergreen 讨论帖**（数百评论的工具比较 / 经验分享）— 即使旧也持续被人 Google 索引到
3. **OP 在 launch 自家工具**，且功能交集大（可以礼貌地切入差异化）
4. **OP 在讨论/比较** Claude Code / Codex / Gemini 等工具（pikiloom 作为另一种选择补充）
5. 泛 AI dev tool 讨论（低优先级，曝光为主）

> Reddit ≠ Twitter：时效性不是核心信号，**讨论质量 + 持续 visibility** 才是。一条 7 天前 500 评论的"哪个 coding agent 最好"帖，价值远高于一条 1 小时前 0 评论的新帖。

**排除：**
- 纯 meme / 抱怨 / 政治
- 已被 mod 锁定 / 已删除
- 在 `target_subreddits.md` 中标 `skip` 的 sub（mod 极严，任何第三方工具评论都会删 — 不浪费 ammo）
- author karma 极低 / 账号一周内注册的（容易是 spam，回复 ROI 低）

选 Top 3-5 条候选。

### Step 5: 生成回复草稿（始终 builder 身份）

**默认模板（带 `npx` + 链接）：**

```
I'm building pikiloom — an open agent orchestrator that runs a swarm of Claude Code / Codex / Gemini (and any CLI/ACP agent) in parallel, driven from a web dashboard or any IM (Telegram / Feishu / Slack / Discord / …).

{一句直接回应 OP 的具体问题/痛点 — 必须 ground 在原帖具体文字上，不能泛泛}

{可选：一句 file/function 级证据，证明非营销吹水，例如 "the multi-session switching lives in agent/stream.ts"}

`npx pikiloom@latest` · https://github.com/xiaotonng/pikiloom

Happy to dig in if any of that lines up with what you're after.
```

**no-link 变体**（仅当 sub 在 `target_subreddits.md` 标 `link: no` 时使用，去掉命令 + 链接行）：

```
I'm building pikiloom — an open agent orchestrator that runs a swarm of Claude Code / Codex / Gemini in parallel from one dashboard, with optional IM bridges (Telegram / Feishu / Slack / Discord / …).

{一句直接回应 OP 的具体问题/痛点}

{可选：一句 file/function 级证据}

Curious if it lines up with what you're after — happy to share more if useful.
```

### 通用规则

- **永远英文**（除非 OP 显式用其他语言且 sub 是该语言社区）
- **peer-builder 语气**：`I'm building` 而非 `Check out`；`Curious if` 而非 `You should try`
- **不贬低任何竞品**：Claude Code / Cursor / Codex / Aider / 等都是同行；pikiloom 是补充不是替代
- **不堆功能**：每条评论最多提 2 个差异点，必须和 OP 痛点对得上
- **不复制粘贴**：每条草稿独立 draft，不能是同一段模板换个开头
- **每条草稿尾部加一行 meta**：`<!-- 适用 sub: r/X · OP 痛点: ... · 差异点: ... -->`（飞书报告里展示，发评论前删掉）

### 差异化切入角度

挑与 OP 最相关的 **1 个**差异点，全部来自 **[`../_promo/pitch.md`](../_promo/pitch.md) §2**（0–9 号）。
角度 0 = billing（OP 一提钱 / API key / `-p` / SDK credits 就用它，优先于其余；守 pitch §3 诚实边界）。
**不在本文件重复列表 —— 改差异点只改 pitch.md。** Reddit 专属：show-don't-tell，只用真实成立的点（don't fabricate）。

### Step 6: 生成报告 Markdown

写入 `/tmp/reddit_snipe_report.md`：

```markdown
# Reddit-snipe 候选 — {YYYY-MM-DD}

**扫描范围**: {sub 列表 / 关键词 / 单独参数}
**候选数**: {n}
**当前 karma**: {n}（仅作运营参考，不影响身份）

---

## 候选 1: {title 前 60 字}

- **Sub**: r/{sub}
- **作者**: u/{author}
- **链接**: {url}
- **数据**: {score} ↑ / {comments} 💬 / 发布 {age_hours}h 前
- **OP 痛点 / 主题**: {一句话总结 OP 在求什么 / 推什么}
- **与 pikiloom 交集**: {功能重叠点}
- **差异切入**: {选了哪个差异点，为什么}
- **草稿形态**: {link | no-link}（按 sub 规则）

### 推荐评论
> {draft}

---

## 候选 2: ...
...

---

## 操作指南

1. 优先回复候选 1（信号最强），依次往下
2. 发评论前手动 review：
   - 是否真的回应了 OP 的具体问题？（如果只是泛泛"我也做了一个 X"则不发）
   - sub 规则是否允许这类评论？（不确定就只点 upvote 不发）
3. 发完后将 thread URL 追加到 `.pikiloom/skills/reddit-snipe/sniped_threads.txt`：
   `<url> | <ISO timestamp> | <link|no-link|skipped>`
4. 隔天回访候选，看回复是否被 mod 删 / 被 OP 回应
```

### Step 6.5: 自我批判 + 护栏（替代人工 review）

每条草稿按 pitch.md §10 自检（营销腔 / 贬低同行 / 堆功能 / 没 ground OP / 越诚实边界 / 隐藏 builder 身份）。
FAIL → 修一次；再 FAIL → `registry.py update --channel reddit --url <u> --status skipped` 丢弃。然后护栏：
```bash
python3 .pikiloom/skills/_promo/guard.py check --channel reddit --url "<thread_url>" \
  --draft-file /tmp/reddit_draft_<id>.txt        # exit 3 = deny（日 3 / 单 sub 1 / 变体 / 熔断）；deny 则跳过
```

### Step 7: 推送到飞书

```bash
cd /Users/admin/Desktop/project/pikiloom
python3 .pikiloom/skills/_promo/push_feishu.py --report-file /tmp/reddit_snipe_report.md --title "🦞 Reddit Snipe"
python3 .pikiloom/skills/_promo/measure.py report     # reddit referrer / star 关联，附卡片后
```
输出 `OK:` 成功 / `SKIP:` 缺飞书凭证 / `ERROR:` 失败（兜底把报告贴进对话）。

### Step 8: 按 posture 发布 + 记录

`POSTURE=$(python3 -c "import json;print(json.load(open('.pikiloom/skills/_promo/config.json'))['posture'])")`
- **shadow**：不发，推预览卡片。
- **batch**：`registry.py update --channel reddit --url <u> --status approved` + 推 veto 卡片（见 orchestrate.md Phase 4）。
- **auto**：浏览器发评论（见下「浏览器发评论的操作要点」，Lexical 坑务必照做），成功后：
```bash
python3 .pikiloom/skills/_promo/registry.py mark-posted --channel reddit \
  --url "<thread_url>" --post-url "<我们评论的 url>"     # 失败则 update --status failed
```
起草时即记录（存草稿供变体检查）：`registry.py add --channel reddit --url "<thread_url>" --status drafted
--repo "r/<sub>" --type <question|discussion|launch> --lang en --audience <score> --title "<标题>"
--draft-file /tmp/reddit_draft_<id>.txt`。评估过但 sub 不允许 → `--status skipped`（仍记录，避免重复评估）。

## 反模式（必须拒绝）

- ❌ 不读 OP 帖就堆 pikiloom 功能介绍
- ❌ "Hey, you should check out pikiloom" / "Try pikiloom, it's better" 这类推销语
- ❌ 一帖回复多条评论（mod 直接 ban）
- ❌ 贬低任何竞品（Claude Code / Cursor / Aider / Cline 等都是同行）
- ❌ 在 `target_subreddits.md` 标 `skip` 的 sub 留评论 — 浪费 ammo，账号易被标记
- ❌ 用中文回复英文帖（账号定位是英文用户群体）
- ❌ 在 launch 帖下直接对比"pikiloom 比你这个好" — 永远是补充不是替代
- ❌ 把"虚构的差异点"包装成卖点（参考 memory：don't fabricate differentiation）
- ❌ 隐藏 builder 身份装普通用户（karma-farming 模式被 mod 识破后信任清零）

## 边界与安全

- **发布姿态由 `config.json` `posture` 决定**（shadow 不发 / batch 发前可 veto / auto 直发）；
  `kill_switch` 与 `abort.txt` 随时生效。三渠道里 Reddit 浏览器发评论最易翻车，**建议最后才开 auto**。
- **每天最多 3 条 / 同一 sub 24h 内最多 1 条** — 由 `guard.py` 按 `config.json` 强制（不靠人记）。
- 被 mod / automod 删评论 → `registry.py update --channel reddit --url <u> --status removed`，触发 guard 熔断暂停本渠道。
- 飞书凭证沿用项目根 `.env`（`FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_CHAT_ID`）。

## 浏览器发评论的操作要点（实跑踩坑后总结）

如果走浏览器自动化（而非 Reddit API）发评论或编辑评论，注意以下技术细节：

1. **Reddit 评论框是 Lexical editor**，普通 `execCommand('insertText')` 无效，必须用合成 `ClipboardEvent('paste')` 配合 `DataTransfer.setData('text/plain', ...)` 触发 Lexical 的 paste handler。
2. **paste 后立即回读 `innerText` 会拿到旧状态**（DOM 还没 reconcile），用 `len === 0` 来判定失败是错的 — 等 ≥500ms 再读，或干脆只看截图。**这次踩了这个坑，导致第二次重复粘贴，评论变成两份内容拼一起。**
3. **Lexical 的 paste 不会替换当前 selection**，会 append。如果是 "edit comment" 流程要替换全部内容，先 `keyboard.press('ControlOrMeta+a')` + `keyboard.press('Delete')` 清空编辑器，再 paste。
4. **collapsed composer**：有些线程评论框初始是 `<faceplate-textarea-input size="collapsed">` 状态，必须先点一次才会展开成带 contenteditable 的完整 composer。展开后再 paste。
5. **overflow menu 在 shadow DOM 内**：编辑/删除评论的 "..." 按钮在 `<shreddit-overflow-menu>` 的 `shadowRoot` 里，要 `comment.querySelector('shreddit-overflow-menu').shadowRoot.querySelector('button[aria-label="Open user actions"]')`。
6. **发送前再读一遍内容**：clicking Comment 前必须再 `evaluate` 读 `ed.innerText.length` 验证 ≈ 期望草稿长度（容差 ±5%）。如果长度异常（0 或 2x），**不要 click submit**，回报失败让人工介入。
7. **发送后用 thread DOM 验证**：截图 + `document.querySelectorAll('shreddit-comment')` 数我们的评论数和关键词出现次数（关键短语应只出现 1 次）。这是最后一道防线。

## 相关资源

- 目标 sub 白名单 + 每 sub 的 mod 严格度: `.pikiloom/skills/reddit-snipe/target_subreddits.md`
- DOM 抽取脚本: `.pikiloom/skills/reddit-snipe/scripts/extract_reddit_threads.js`
- 去重 / 记录: `_promo/registry.py`（channel=reddit；旧 `sniped_threads.txt` 已迁移，留作历史）
- 共享核心: `_promo/{pitch.md,config.json,guard.py,push_feishu.py,measure.py,orchestrate.md}`
