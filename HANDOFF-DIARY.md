# QQ AI ChatBot Handoff

This document is a handoff note for another assistant/model taking over the project.
The project is a local Windows QQ group-chat AI bot named Wuxin, controlled by a Chinese GUI and connected to QQ through NapCat OneBot. Data lives in %APPDATA%\Wuxin, not in the project directory.

## Current Status

Project directory:

```text
G:\QQ-AI-ChatBot
```

Runtime data directory:

```text
Default: %APPDATA%\Wuxin
DB:      %APPDATA%\Wuxin\db.json
Override with DATA_DIR=<custom data directory>
```

NapCat directory currently used:

```text
G:\My pack\NapCat.Shell.Windows.OneKey\NapCat.Shell
```

Main local URLs:

```text
GUI:        http://127.0.0.1:5173
Backend:    http://127.0.0.1:8787
OneBot HTTP http://127.0.0.1:3000
OneBot WS   ws://127.0.0.1:3001
NapCat WebUI is usually on http://127.0.0.1:6099/webui
```

Current important runtime settings from the live runtime DB:

```text
Bot QQ/selfQq: 3312171148
Owner QQ:      570341031
Bot name:      Wuxin
Model:         deepseek-v4-flash
Temperature:   0.4
Max tokens:    300
Context limit: 30 messages
```

Configured group:

```text
Group ID:      837338630
Group name:    花开之夜
Mode:          light
Max per hour:  20
Cooldown:      30 seconds
```

Configured member policy:

```text
User ID:       2382411740
Policy:        admin
Note:          氨基酸
allowCommands: true
```

Usage at the time this file was written:

```text
Total tokens:      117692
Prompt tokens:     108900
Completion tokens: 8792
Requests:          72
Replies:           81
Errors:            0
```

## How To Run

Start the control panel:

```text
G:\QQ-AI-ChatBot\启动控制台.bat
```

Open the GUI:

```text
G:\QQ-AI-ChatBot\打开控制台.bat
```

Stop the control panel:

```text
G:\QQ-AI-ChatBot\停止控制台.bat
```

Important: earlier versions left many duplicate Node processes. If the GUI cannot open but backend still responds, kill only `node.exe` processes whose command line contains `G:\QQ-AI-ChatBot`, then restart. Do not kill NapCat or other bots.

## Architecture

```text
NapCat QQ account
  -> OneBot WebSocket events
  -> server/onebot.ts
  -> server/bot.ts decision engine
  -> configured LLM provider when needed
  -> OneBot HTTP send message
  -> QQ group

React GUI
  -> Vite dev server on 5173
  -> Express backend on 8787
  -> live DB resolved by server/store.ts
     default %APPDATA%\Wuxin\db.json, or DATA_DIR\db.json
```

Key files:

```text
server/store.ts        JSON database, defaults, secret masking, DATA_DIR resolution.
server/onebot.ts       OneBot WebSocket receive and HTTP send adapter.
server/index.ts        Express API used by the GUI.
server/bot.ts          Core pipeline: processIncoming, decideReply, command handlers.
server/bot/cleaning.ts Message normalization, CQ parsing, card placeholders.
server/bot/llm.ts      Provider-neutral LLM calls, timeout, retry, usage merging.
server/bot/deepseek.ts Compatibility re-export for older imports.
server/bot/reply.ts    Output sanitization, segmentation, rewrite guard, forward text. Live runtime path.
server/bot/prompt.ts   System prompt builder, complexity scoring, auto-model, pricing. Live runtime path.
server/bot/memory.ts   Long-term memory sample/profile collection and profile updates. Live runtime path.
server/bot/commands.ts Command role helpers, permission checks, command logging.
src/App.jsx            Main React GUI (9 pages).
src/styles.css         GUI styles.
data/                  Legacy/template-only location. Do not treat project data/ as the live DB.
```

## Data Model

The live runtime DB (default `%APPDATA%\Wuxin\db.json`, or `DATA_DIR\db.json`) contains:

```text
settings:
  apiKey, model, prompt, baseline prompt, ownerQq, selfQq, OneBot URLs, etc.
  enableWebSearch (default true), webSearchMode (fast|balanced|deep, default balanced)
  commandRoles and commandPermissions for configurable command access.
  memoryEnabled, memoryMinMessages, memoryUpdateEvery, memoryMaxChars for long-term memory.

groups:
  enabled groups, mode, maxPerHour, cooldownSec.

users:
  per-group member policies: normal, whitelist, priority, muted, blocked, admin.

memories:
  global per-QQ long-term memory profiles, keyed by userId rather than groupId.

messages:
  local conversation context. This can be cleared safely.

decisions:
  why the bot replied or stayed silent.

adminActions:
  GUI and command actions.

usage:
  total aggregate tokens/replies/errors.

usageEvents:
  per-request token events used for today's token report.
```

Do not put API keys into docs. `publicDb()` masks secrets before sending state to the GUI.

## Reply Modes

Group `mode` values:

```text
silent   Do not reply.
mention  Reply only when @/name mentioned.
light    Selective replies to questions, low activity.
natural  Occasional casual participation.
```

Current group mode is `light`.

Rate and cooldown:

```text
maxPerHour  limits ordinary users.
cooldownSec limits ordinary users.
Owner/admin @ mentions bypass maxPerHour and cooldown.
```

## User Policies

Policies:

```text
normal     ordinary user
whitelist  easier to respond
priority   higher attention
muted      usually no reply
blocked    no reply and not in context
admin      command-capable administrator
owner      global owner from settings.ownerQq
```

Each user entry can also carry a `customPrompt` field — an optional short prompt that gets injected into the system prompt when the bot is speaking to that member, under `【对当前发言者的特别要求】`. This lets the bot adopt a different tone or attitude per member without changing the global personality prompt.

Each user entry can also carry `commandRoleId`. This is separate from chat policy:

```text
policy         controls how likely the bot is to chat with that member.
commandRoleId controls which /w commands that member may use.
```

Custom command roles are assigned from the GUI only. Group-chat commands intentionally keep only the built-in admin workflow (`/w op` and `/w deop`) so the QQ-side command surface stays simple.

Owner is not stored as a normal member policy. It is derived globally from `settings.ownerQq`.

## Long-Term Memory

The GUI has a `记忆` page. Memory v1 is intentionally conservative:

```text
1. Memories are keyed by QQ number (`userId`) globally, not by group.
2. The same member's memory is used across all groups and private chat.
3. Owner is never automatically profiled. Owner behavior should follow current owner messages and backend prompts, not inferred long-term memory.
4. Admins, priority users, whitelist/trusted users, muted users, and normal users have different memory importance levels.
5. Higher-importance users reach memory update thresholds faster.
6. Samples are typed as text / card / media / command / bot-output.
7. Only real text samples are used for automatic profiles. Commands, pure media, share cards, JSON/XML/forward cards, and very long machine-looking output are excluded with a reason.
8. The bot stores compact samples and periodically asks the configured LLM provider to summarize only usable text into profile fields.
9. Profile fields can be edited, disabled, or deleted from the GUI.
```

Message cleaning now happens before context/memory:

```text
CQ:json / CQ:xml / CQ:forward -> [分享卡片：标题 / 简介] when extractable, otherwise [分享卡片].
CQ:image / face / mface / record / video / file -> short media placeholders.
Raw card JSON/XML should not be inserted into model context or memory samples.
```

Memory fields:

```text
summary       overall impression
traits        personality/tendencies
speechStyle   how the user tends to speak
behavior      interaction habits
preferences   preferences and avoidances
manualNotes   owner-written notes
groupsSeen    group IDs where this QQ has appeared
```

Memory is injected into the system prompt only for the current speaker and capped by `memoryMaxChars`. It should be used naturally; the bot is instructed not to expose or recite the memory.

Owner private chat context is special: private messages from owner carry much more history than group chat, but are still bounded by `settings.ownerPrivateContextCharBudget` (default 24000 chars). If older private messages are omitted due to the budget, a soft notice is injected so the bot does not claim unlimited history. Group chats use `contextLimit` (message count).

## Command Permission System

The GUI has a `权限` page. It allows the owner to:

```text
1. Rename command user groups.
2. Add/remove custom command user groups.
3. Set each command category's minimum required group.
```

Built-in groups:

```text
guest    普通群员, level 0, locked.
trusted  信任成员, level 20, removable/editable.
admin    管理员, level 60, locked.
owner    所有者, level 100, locked.
```

Owner always bypasses command permission checks. This prevents the owner from locking themselves out by misconfiguring the GUI.

Default command permissions:

```text
help, ping, summarize 5-99        guest
summarize 100+, usage, status     admin
rate, cooldown, mode              admin
model show/list, model set        admin
search                            admin
pause, resume                     admin
profile                           admin
prompt show/add/set/reset         admin
prompt savebase                   owner
note                              owner
member policy commands            owner
```

`/w op` sets the target to the built-in `admin` command role. `/w deop` clears that admin command role. Other custom roles should be managed through the GUI only.

## Command System

Commands are intentionally namespaced with `/wuxin` or `/w` to avoid collision with other bots.
Bare `/help` is ignored.
All `/w` and `/wuxin` messages are routed through the command handler even if the sender lacks permission. This prevents denied commands from falling through into normal AI chat.

Owner-only member commands:

```text
/w op @user or /w op QQ        set admin
/w deop @user                 remove admin
/w ban @user                  blocked
/w unban @user                normal
/w trust @user                whitelist
/w focus @user                priority
/w quiet @user                muted
/w normal @user               normal
/w note @user text            set member note
/w note show @user            show member note
/w note clear @user           clear member note
```

Prompt commands:

```text
/w prompt show                show full current prompt as merged forward
/w prompt add text            append to current prompt
/w prompt set text            replace current prompt
/w prompt reset               reset to baselinePersonalityPrompt
/w prompt savebase            owner only; save current prompt as reset baseline
```

Admins can use:

```text
/w prompt show/add/set/reset
```

Admins cannot use:

```text
/w prompt savebase
member management commands
```

Runtime group commands for owner/admin:

```text
/w rate 20                    set max replies per hour
/w cooldown 30                set cooldown seconds
/w mode silent|mention|light|natural
/w status                     show current group runtime settings
```

Model and diagnostics commands for owner/admin:

```text
/w model show                 show current model
/w model list                 show common model names
/w model deepseek-v4-flash    switch model
/w search on|off              enable/disable web search
/w search status              show web search status
/w search fast|balanced|deep  set search mode (also enables search)
/w usage                      show today's token usage + cost (CNY, per official pricing)
/w pause                      pause bot globally
/w resume                     resume bot globally
/w ping                       fixed reply: pong，我在。
```

Profile/memory commands for admin/owner:

```text
/w profile @user              manually update user profile (bypasses auto threshold)
/w profile show @user         view current profile as merged-forward card
/w profile samples @user      show the actual message samples used as profile evidence
/w profile clear @user        clear all profile fields for a user
```

Group commands available to all members:

```text
/w summarize 30               summarize last 30 messages (default 50, range 5-500)
/w summarize 100              summarizing 100+ messages requires admin/owner
```

The exact required role for each command can be changed from the GUI `权限` page. The lists above are defaults.

Long outputs such as help and prompt show are sent as OneBot merged-forward cards.

## Important Bot Behavior

Media handling:

```text
Pure images/stickers/videos/files are ignored by default.
If the user explicitly asks the bot to inspect an image/sticker, it replies that it can only read text.
The model must not pretend to see image content.
```

Identity/model handling:

```text
The system prompt injected at runtime always includes the current model name and instructions
to use it when asked. The model answers identity/model questions naturally — no hardcoded
regex or bottom-layer interception. This keeps the codebase simpler and lets the AI handle
nuanced variations of the question.
```

Context understanding:

```text
Each history message now carries a [HH:MM] timestamp so the model can distinguish
recent vs stale messages. The system prompt includes 【群聊上下文理解规则】rules that
tell the model to:
- Avoid mixing messages from different people or widely separated times.
- Distinguish "群友聊天" from "群友对我说话" — join topics naturally but don't
  confuse group banter with direct conversation.
- Not combine A's words with B's intent.
```

Style guard:

```text
The bot previously became too theatrical and servile.
server/bot.ts has isWeirdReply() and rewriteNormalReply() to sanitize replies with:
- no boss/master/group-owner language
- no begging for money
- no bracket acting
- no defensive "别骂我/我改" style
- no "承让承让" or similar theatrical filler
```

Reply segmentation:

```text
Long natural replies are split into 1-3 QQ messages with a short delay.
This only affects normal replies, not merged-forward command output.
```

Runtime prompt injection:

The saved `personalityPrompt` is not the full prompt. `buildPrompt()` injects runtime facts every call:

```text
owner QQ
current speaker identity and policy
current model name
command priority rules
visual/media limitation rules
```

This runtime injection is not written back into the saved `personalityPrompt`, so it will not grow the persisted prompt in the live DB.

If `ignoreSystemFacts` is enabled (via `/w sysfacts on` or the GUI Model page), all runtime facts above are suppressed. The LLM only receives the `personalityPrompt` as its system message, plus normal conversation messages. This is an advanced/debug mode; it may make model identity and command priority less reliable, but gives the personality prompt complete control over tone and behavior.

Per-member custom prompts (user.customPrompt) are also injected at runtime when present for the current speaker, under `【对当前发言者的特别要求】`. This allows per-member attitude tuning without modifying the global personalityPrompt.

## Web Search

When `enableWebSearch` is on and the selected provider is `deepseek`, the LLM layer (`completeChat()` / `callLLM()`) adds `enable_search: true` and `search_mode` as top-level DeepSeek request parameters. The model decides autonomously whether a message needs a web search — no forced searching. DeepSeek's backend runs the search internally; the response already incorporates any search results. OpenAI-compatible providers must not receive these DeepSeek-only fields. This means:

- Works with all chat models (DeepSeek Chat, V4 Flash, V4 Pro).
- When the bot is @mentioned (someone directly asks it a question), it sends a brief "正在进行思考…" indicator before the API call. Casual group-chat insertions (not @mentioned) stay quiet with no indicator.
- If the search-informed reply is long (>150 chars or multi-paragraph), it is sent as a merged-forward card instead of plain messages to avoid flooding the chat.
- No second API call is needed for tool results.
- The `rewriteNormalReply` function never uses web search.
- Deterministic visual-limitation replies bypass the AI call (the bot genuinely cannot see images). Identity/model questions are handled naturally by the LLM using runtime-injected facts — no hardcoded interception.
- If the API rejects `enable_search` (400), the request retries without it.

Search can be toggled from GUI (Model page) or via `/w search on|off|status|fast|balanced|deep` (admin/owner only).

## Auto Model Switching

When `enableAutoModel` is on (default true), `taskComplexityScore()` scores each incoming message and `autoModelForTask()` picks the appropriate model and search depth:

```text
Score < 35  (simple):  use configured model, fast search
Score 35-60 (medium):  V4 Flash, balanced search, max_tokens >= 800
Score >= 60 (complex): V4 Pro, deep search, max_tokens >= 1200 (¥expensive!)
```

Complexity factors: explicit search request, long-form writing, deep reasoning/analysis, code/technical, math, creative writing, message length, owner priority.

**Owner always gets the best**: When the current speaker is the system owner, auto-model is bypassed entirely. Under the DeepSeek provider, owner receives DeepSeek V4 Pro + deep search + max_tokens >= 1200, regardless of complexity score. Under non-DeepSeek providers, owner receives a larger output budget and high-priority handling but is not forced to a DeepSeek model name or DeepSeek-only search parameters.

When the model is upgraded for a task, the thinking indicator shows the model name, e.g. "正在进行思考…（DeepSeek V4 Pro）".

Auto-model can be toggled from GUI (Model page). The configured model in settings remains the default for simple tasks.

## Group Chat Summary (`/w summarize`)

The summarize command collects the last N messages from the current group and asks the configured LLM provider to produce a concise summary (2-5 bullet points). The result is sent as a merged-forward card to avoid flooding the chat. Behavior:

- N defaults to 50, range 5-500.
- N >= 100 requires admin or owner permissions; N < 100 is open to all members.
- Messages are formatted as `[HH:MM] 昵称：内容` and sent with a summary prompt.
- The summary uses a separate API call (temperature 0.3, max_tokens 500) that counts toward usage.
- Non-group (private) messages are ignored — summarize is group-only.

## NapCat Notes

Current local OneBot config was added to:

```text
G:\My pack\NapCat.Shell.Windows.OneKey\NapCat.Shell\config\onebot11_3312171148.json
```

It includes:

```text
HTTP server:      127.0.0.1:3000
WebSocket server: 127.0.0.1:3001
Token:            empty
```

A backup was created:

```text
onebot11_3312171148.json.bak-20260520-185827
```

Custom start script:

```text
G:\My pack\NapCat.Shell.Windows.OneKey\NapCat.Shell\start-3312171148-local-onebot.bat
```

The GUI QQ连接 page now has an "自动检测" button that scans common local ports (3000, 3001, 4000, 5700, 5701, 8080) and auto-fills detected OneBot HTTP/WS URLs. The new-user flow is: download NapCat → scan QR to log in QQ alt → click "自动检测" → "保存并连接QQ".

There is also another bot/NapCat setup in use. Avoid killing non-QQ-AI-ChatBot processes. Multiple bots can coexist if their ports and OneBot connections do not collide.

## Known Issues / Next Improvements

Recommended next improvements:

```text
Completed 2026-05-22 evening:

1. ✅ One-click backup/restore — `server/backup.ts` + API + GUI + auto-prune
2. ✅ Health/status page — `server/health.ts` + Overview health cards
3. ✅ Memory confidence — `profileMeta` with confidence/evidence/updatedAt
4. ✅ High-risk profile downgrade — `riskLevel` on samples + auto-filter

## New Design: Social Memory Layer / 社交记忆层

Status: IMPLEMENTED (Phase 1: signals + auto-trust + relationship manual update).

### Implemented modules

**`server/bot/signals.ts`** — Shared interaction signal extractor (pure rules, no LLM)
- `extractSignals(event, db)` — per-message: realText/command/media check, @targets, prompt injection, adversarial testing
- `computeInteractionDiversity(messages, userId)` — distinct conversation partners
- `countRecentNegativeSignals(samples, days)` — high-risk/low-confidence sample count
- `findRecentInteractionPairs(messages, groupId)` — pair-based interaction detection

**`server/bot/trust.ts`** — Auto trust scoring (rules-based, no LLM)
- `processTrustSignal(event, db)` — per-message: real text +1, prompt injection -15, adversarial -10, @others +2
- `evaluateTrustScores(groupId)` — batch evaluate all users: activeDays×5 + realText/5 + interactionDiversity×6 - negativeSignals×10
- Tiers: normal (0-49) → candidate (50-69) → trusted (70+). Requirements: activeDays≥3, realText≥30, diversity≥3, zero negative signals
- `trustInteractionBonus(userId)` — trusted: +25 weight, 300s window, 0.6× memory threshold
- Auto-demote: score<45 or 14d inactive. Never scores owner/admin/blocked/muted

**`server/bot/relationshipProfile.ts`** — Pair relationship profiles
- Per-pair (groupId + userA + userB pairKey)
- Fields: interactionStyle/commonTopics/tone/botStrategy/boundaries ONLY
- HARD CONSTRAINT: sensitive real-world relationship terms (情侣/夫妻/父子 etc.) stripped from output via post-processing
- LLM prompt explicitly prohibits relationship conclusions
- Injection via `relationshipPromptBlock()` — only for current group + current speaker's pairs

### Wiring
- `processIncoming` calls `processTrustSignal` on every group message
- `decideReply` applies trust weight bonus + extended conversation window
- `buildPrompt` injects relationship context for current speaker's pairs
- Commands: `/w relation show|update|clear @A @B` (admin)

Status: DESIGN ONLY. Combines two features that share a common signal extraction layer.

### 1. Interaction Signal Extractor / 共享互动信号抽取器

```text
Phase 1 — no LLM calls, pure rule-based extraction from messages.

Per-message signals:
- who @ed whom
- who replied to whom (via consecutive messages, @targets, reply patterns)
- whether the message is real text vs media/command/bot output
- whether it shows prompt injection / adversarial testing
- whether it's part of a continuous conversation chain
- interaction diversity: how many different group members does this user talk to

Storage: lightweight metadata on messages or a separate signals table.
Not persisted to personal memory profiles.
```

### 2. Auto Trust / 自动信任成员

```text
Scoring formula:
  trustScore = activeDays × 10 + realTextCount / 5 + interactionDiversity × 8
             - negativeSignals × 15 - rejectedCommands × 10

Tiers:
  normal    (score 0-49)  — standard treatment
  candidate (score 50-69) — not yet trusted, on watchlist
  trusted   (score 70+)   — auto-promoted, interaction perks only

Upgrade threshold: score >= 70, activeDays >= 3, realText >= 30,
  interaction with >= 3 different members, no severe negative signals in 7 days.

Downgrade: score < 45 (auto-demote), 14 days inactive (decay), muted/blocked (freeze).

Perks (interaction only, never management):
- reply weight +30% in decideReply
- continuous conversation window 5 min (vs 2 min for normal)
- memory threshold 3/3 (vs 5/5 for normal)
- can use: /w ping, /w why, /w my, /w profile samples me
- prompt injection labels as "熟悉群友" — more natural interaction, no backend label exposure

CRITICAL: Auto-trust NEVER grants management permissions.
It only affects how likely the bot is to reply, remember, and engage.
```

### 3. Relationship Profile / 群友关系画像

```text
Per-pair (groupId + userA + userB), observing long-term interaction patterns.

Records ONLY:
- interaction style: 互相接话 / 熟人调侃 / 认真讨论 / 偶尔争执
- common topics
- tone: 轻松 / 嘴贫 / 认真 / 容易误会
- bot strategy: when these two are talking, how should Wuxin join/abstain
- boundaries: 不要起哄 / 不要站队 / 不要放大冲突

CRITICAL — PROHIBITED from writing:
- 情侣/夫妻/父子/兄弟/姐妹 等任何现实亲密关系
- CP、暧昧、取向
- "A 喜欢/讨厌 B"等主观动机判断
- 心理状态、健康状态推断
- UNLESS: the relationship label is explicitly and repeatedly self-stated
  by the members themselves (e.g. A frequently @B with a specific kinship term,
  AND their interaction pattern consistently matches that relationship).
  Even then, use only the stated term, never infer unstated ones.

Relationship profiles help:
- distinguish friendly banter from real conflict
- decide whether to join a conversation
- prevent Wuxin from misreading jokes as arguments

V1: manual update only (owner/admin triggers via command/GUI)
V2: auto-update when enough pair signals accumulate
```

### 4. Cross-feature Integration

```text
Trust score uses relationship signals:
- interacts with >= 3 different members → +score
- only interacts with bot → low/no score
- pair profiles show normal discussion → +score
- pair profiles show repeated conflict → -score

Relationship profiles use trust data:
- pairs where both are trusted → higher confidence
- pairs involving low-trust users → flagged as potentially unstable
```

### 5. Implementation Order

```text
1. Signal extractor (no LLM, pure rules)
2. Auto trust scoring (rules-based, no LLM)
3. Relationship profile manual update (LLM, owner-only trigger)
4. Relationship profile auto-update (optional, can wait)
```

### 6. Safety Boundaries

```text
- Trust NEVER grants management permissions
- Relationship profiles NEVER infer real-world intimacy/kinship
- All sensitive relationship terms require explicit, repeated self-statement
  before even being considered for recording
- Trust score is interaction-only; commandRoleId/allowCommands still controlled
  by owner via GUI
```

Deferred / lower priority:

- Budget controller is not important right now because DeepSeek V4 Flash is cheap.
  The main resource risk is context/profile pollution, not token cost.
- Prompt version history is useful but lower priority than DB backup and health.
- GUI buttons for model/rate/cooldown/status are nice-to-have because QQ commands
  already cover these operations.
- Multimodal vision can wait until a chosen provider supports it cleanly.
```

Known caveats:

```text
1. JSON store is simple and fine for local use, but concurrent writes are not robust.
2. Today's token usage is accurate only for requests after usageEvents was added.
3. Vision is not wired in for the current LLM layer; image/sticker content is intentionally ignored.
4. Merged-forward support depends on NapCat/OneBot endpoint compatibility.
5. Some old Chinese commands are still supported for compatibility, but /w or /wuxin is preferred.
6. Web search currently uses DeepSeek's `enable_search` top-level parameter only when provider is `deepseek`. OpenAI-compatible providers must not receive this DeepSeek-only field.
7. Summarize and rewrite-normal-reply each make separate API calls; both are tracked in usageEvents.
8. Usage costs are still mainly calculated with the DeepSeek price table. If another provider is used, token counts remain useful but cost estimates need provider-specific pricing.
```

## Completed 2026-05-23: Context-Aware Memory / 语境感知画像

Status: IMPLEMENTED. See changelog `## 2026-05-23 — 语境感知画像` for full details.

Summary: Memory samples now carry context snapshots (nearby messages, @targets, speaker identity). The profile update LLM sees full conversation blocks instead of isolated sentences, and must judge subject/addressee/observationType before writing to profile. Legacy context-free profiles are automatically downweighted. `/w profile samples` shows layered output (with-context / legacy / low-confidence / high-risk).

Original design doc condensed: Memory samples carry context snapshots (nearby messages, @targets). Profile update LLM sees full conversation blocks and judges subject/addressee/observationType before writing. Legacy context-free profiles auto-downweighted. `/w profile samples` shows layered output. Full changelog at `## 2026-05-23 — 语境感知画像`.

## Completed 2026-05-23: Group Chat Profile / 群聊画像

Status: IMPLEMENTED.

`server/bot/groupProfile.ts` — per-group atmosphere, separate from personal profiles. Injected via `buildPrompt()`. Commands: `/w group profile show|update|clear|on|off`. API: `GET/POST/PATCH/DELETE /api/group-profiles/:groupId`. GUI: expandable profile panel per group card with full fields view + manual edit (textareas + save) + LLM update + clear + enable/disable toggle.

## Archived: Relationship Profile → 已并入 Social Memory Layer (line 547)

Backend implemented in `server/bot/relationshipProfile.ts`. See Social Memory Layer (line 547) for the merged spec.

## Completed 2026-05-22: Codex Hardening Review

Status: ALL FIXES APPLIED (commit `ca43dc5`).

Five hardening issues resolved:
1. Backup path traversal safety (`safeBackupName` with basename/.json/containment checks)
2. High-risk memory downgrade independent from banter (`looksLikeSensitiveClaim`, third-party claims → high-risk)
3. Health state correctness (error timestamps, `ws.on('error')` hook, `setBotPaused` sync, frontend 5s poll)
4. Pre-restore backup pruning (max 5, GUI delete button)
5. Memory decay display marker (14-day stale label in `memoryPromptBlock`)

Original review body removed from active docs.

## Completed 2026-05-22: Groups Page Recognition + Profile Guardrails

Backup before changes:

```text
G:\QQ-AI-ChatBot-backups\20260522-131329-groups-memory-guard
```

Changed files:

```text
src/App.jsx
src/styles.css
server/bot/memory.ts
HANDOFF.md
```

GUI Groups page:

```text
Problem: after many active groups are configured, the Groups page still showed
mostly raw group IDs and did not have the same auto-recognition help as the
Members page.

Implemented:
- group display name now prefers a meaningful manual group name/remark.
- if no useful manual name exists, the list derives a readable fallback from
  recent active member nicknames, e.g. "A、B 等人的群"; final fallback is "群 <ID>".
- each group card shows group ID, enabled/silent/mention/light/natural tags,
  rate/cooldown settings, configured member count, memory member count, recent
  active nicknames, and the latest activity snippet.
- added search by group name, group ID, recent active member nickname, or latest
  message text.
- added sorting by recent activity, enabled-first, or name.
- add/edit form label changed to "群名称 / 备注"; when recent members exist and
  the remark is empty, a button can fill a generated remark from recent active
  members.

This is display/edit UX only. It does not change bot reply policy.
```

Long-term profile guardrails:

```text
Problem: profile memory was too eager to treat one-off jokes, bot teasing,
short insults, or hypothetical questions as stable personality evidence.

Implemented in server/bot/memory.ts:
- classifyMemorySample() now excludes likely unstable banter from profile
  samples: short bot insults, "逗你/开玩笑/骗你的/别当真", test/钓鱼/反串/整活,
  and short negative/judgmental remarks.
- short one-off questions or hypotheticals such as "女装被发现了怎么办" and
  "有没有想要的" are kept as audit samples but not used for profile generation
  unless the user expresses a stable habit/preference ("我经常...", "我喜欢...").
- profile update prompt now explicitly says: record only stable/repeated
  self-related habits/preferences/interaction patterns; do not infer identity,
  orientation, or personality from one question/card/joke; avoid insulting or
  pathology-style labels.
- applyProfileUpdate() now normalizes fields before writing. Empty "暂无/未知"
  style values preserve existing profile text, and obvious negative labels
  such as 弱智/脑残/恶心/阴暗/嘴臭/攻击性强 are either softened to neutral wording
  or rejected in favor of the previous value.

Manual notes and explicit profile rules still override via the existing GUI and
`/w profile rule` flow.
```

Validation:

```text
npm run build      ✅ passed
npm run structure  ✅ passed, duplicateImports: []
npm run sanity     ✅ passed

Spot checks:
- "你这个bot是傻逼吧" -> text sample, not used for profile
- "逗你玩的别当真" -> text sample, not used for profile
- "女装被发现了怎么办" -> text sample, not used for profile
- "有没有想要的" -> text sample, not used for profile
- "我喜欢打osu，也经常做谱面" -> real text, used for profile
- "/w ping" -> command, not used for profile
```

## Completed 2026-05-22: Members Page Usability

Problem:

```text
The GUI Members page does not scale when many members are configured. The right
side "已设置成员" list often shows only QQ numbers as the title, so the owner
cannot quickly tell who is who. The edit form can also use a QQ number as the
备注昵称, which makes the list even harder to scan.
```

Goals:

```text
1. Make each configured member recognizable at a glance.
2. Avoid relying on QQ number alone as the primary display name.
3. Help the owner find users by nickname, QQ number, group, policy, command role,
   note/custom prompt, memory state, and recent activity.
4. Do not change runtime chat behavior while improving this GUI.
```

Suggested design:

```text
Member card title priority:
1. Manual nickname / remark (`user.nickname`) if meaningful and not equal to the
   QQ number.
2. Latest known QQ display name captured from recent messages.
3. Long-term memory nickname if available.
4. QQ number as fallback only.

Member card subtitle:
- QQ number
- group name + group ID, not just group ID
- policy label (管理员/重点关注/白名单/少回应/黑名单/普通)
- command role name + level
- attention level
- optional note/custom prompt marker

Add search/filter controls above the member list:
- text search: nickname / QQ / note
- group filter: all groups or one group
- policy filter
- command role filter
- sort by: recently active, policy priority, command level, QQ number

Add visual badges:
- 管理员
- 重点关注
- 黑名单
- 允许指令
- 有备注
- 有单独提示词
- 有长期记忆

Add a compact "recent signal" line if data exists:
- last seen group/time
- last message snippet, sanitized and shortened
- memory summary first short phrase
```

Implementation notes for DS/GPT:

```text
1. Prefer deriving display data from existing DB fields first.
2. If no central user display-name cache exists, add a small helper that looks up
   the latest message/memory nickname by QQ number. Keep it read-only for the
   first UI pass.
3. Do not change bot reply policy, permissions, memory generation, or command
   behavior while doing this UI cleanup.
4. Avoid card nesting. Keep the right panel scannable: dense rows, clear title,
   badges, and actions aligned.
5. For large lists, consider sticky filters and a scrollable list area.
6. Preserve existing edit/delete behavior.
```

Validation after implementation:

```text
1. Create or use several configured users where nickname is blank, QQ-only, and
   manually named.
2. Confirm the list title prefers human-readable names when available.
3. Confirm search by QQ and nickname works.
4. Confirm filters do not mutate data.
5. Run `npm run build`.
6. If backend helpers are touched, also run `npm run sanity`.
```

## Quick Sanity Checklist

After making changes:

```text
npm run build
```

Then restart only this project:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*G:\QQ-AI-ChatBot*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Process -FilePath npm -ArgumentList 'run','dev' -WorkingDirectory 'G:\QQ-AI-ChatBot' -WindowStyle Hidden
```

Check:

```text
http://127.0.0.1:5173
http://127.0.0.1:8787/api/state
```

In QQ:

```text
/w ping
/w status
/w model show
/w usage
/w search status
/w summarize 30
@Wuxin 自我介绍一下
```

## Changelog

> **2026-05-22 — HANDOFF Consistency Cleanup COMPLETED.** All four conflicts resolved; directive body archived to git history. No remaining action items.

### 2026-05-21 — Runtime Data Directory Separation (completed)

The old plan to use `G:\QQ-AI-ChatBot-Data` / `QQ_AI_DATA_DIR` is obsolete. DS
implemented the simpler current scheme:

```text
Default live data directory: %APPDATA%\Wuxin
Default live DB:             %APPDATA%\Wuxin\db.json
Override environment var:    DATA_DIR
```

Important current behavior:

```text
1. Project directory `G:\QQ-AI-ChatBot` should be treated as source code.
2. Personal runtime data should live outside the project in `%APPDATA%\Wuxin`
   unless DATA_DIR is explicitly set.
3. `server/store.ts` currently resolves `dataDir` inline. There is no separate
   `server/paths.ts` abstraction yet.
4. Do not tell future maintainers to edit project `data/db.json` as the live DB.
5. Old changelog entries may mention project `data/db.json`; treat those as
   historical notes from before the migration.
6. `.gitignore` now blocks `data/` and `.env`. Project-local data files should
   not be uploaded or shared.
```

Follow-up improvements, if someone continues this area:

```text
1. Show the resolved data directory in the GUI and diagnostics export.
2. Consider extracting path resolution from `server/store.ts` into `server/paths.ts`
   later, but do not do that together with unrelated bot behavior changes.
3. Add backup/export/import controls for the live DB under `%APPDATA%\Wuxin` or
   DATA_DIR, not for project `data/db.json`.
4. Keep any old project `data/db.json` as legacy/template material only; do not
   delete private data automatically.
```

### 2026-05-21 (late)
- **Codex 复查记录（已校准）**: DeepSeek 已把 `server/bot/prompt.ts`、`server/bot/reply.ts`、`server/bot/memory.ts` 接入真实运行路径，`npm run structure` 显示三者 `importedByMain: true` 且 `duplicateImports: []`。`server/bot/memory.ts` 和 `server/bot/reply.ts` 的运行路径已经走 `completeChat()`；此前“memory.ts 仍直接 new OpenAI”的说法已过时。`server/bot/commandHandlers.ts` 仍未接入主流程，且其中还有直接 API 调用，未来接入前必须先改成统一 LLM 层。
- **LLM 接口抽象**: 本轮前备份到 `G:\QQ-AI-ChatBot-backups\20260521-183709-llm-provider-abstraction`。新增 `server/bot/llm.ts`，统一提供 `callLLM()` / `completeChat()` / provider 配置；`server/bot/deepseek.ts` 只保留兼容导出。`server/bot.ts` 已移除直接 `new OpenAI()`、`chat.completions`、`callDeepSeek()` 路径，主聊天、画像整理、回复改写、群聊总结都走统一 LLM 层。当前默认 provider 仍是 `deepseek`，但 GUI 已可切到 `openai-compatible`，API 地址和模型名可自定义。
- **非 DeepSeek provider 防护**: `enable_search/search_mode` 只在 DeepSeek provider 下附加；OpenAI 兼容接口不会收到 DeepSeek 专属参数。自动模型升级只在 DeepSeek 下切换 `deepseek-v4-flash/pro`；其它 provider 保持用户设置的模型，只按复杂度放宽输出预算。系统提示词会注入当前接口供应商和原始模型名，避免自我介绍时靠旧提示词猜模型。
- **结构检查修正**: `server/bot.ts` 已清掉导入名与本地函数重名的问题，`npm run structure` 当前 `duplicateImports: []`。结构脚本的固定风险改为按实际重复情况显示。
- **命令权限 helper 去重**: 本轮前先备份 `server/bot.ts` 和 `server/bot/commands.ts` 到 `G:\QQ-AI-ChatBot-backups\20260521-183235-command-helper-cleanup`。已删除 `server/bot.ts` 中重复的 `commandRoles/commandRoleLevel/commandRoleName/userCommandRoleId/hasCommandPermission/commandDeniedReply/parseCommandMeta/writeCommandLog` 本地实现，统一使用 `server/bot/commands.ts`。`npm run structure` 的 duplicateImports 从 28 个降到 20 个。验证：`npm run structure`、`npm run sanity`、`npm run build`、`server/bot.ts` 导入均通过，sanity 未留下临时群/日志。
- **基础夯实第一阶段**: 已在 `G:\QQ-AI-ChatBot-backups\20260521-181247-foundation-baseline` 建立整理前备份，包含 `server/`、`src/`、`data/db.json`、`HANDOFF.md`、`package.json`、`package-lock.json`、`vite.config.js`，不含 `node_modules/dist/.git`。备份清单见备份目录内 `BACKUP-MANIFEST.json`。
- **最小 sanity 测试**: 新增 `npm run sanity`，脚本为 `tools/sanity.mjs`。它直接调用真实 `processIncoming()` 路径并临时写入当前 resolved DB，最后自动还原。覆盖 owner `/w ping`、`/w status`、纯 `@` 静默、纯图片静默、明确看图请求的视觉限制说明、非 owner 拒绝 `/w group add` 且日志为 `denied`、owner 成功 `/w group add`、已有群改名、无效 `/w rate 2200` 记录为 `invalid`。当前验证：`npm run sanity`、`npm run build`、`server/bot.ts` 导入均通过。
- **结构报告工具**: 新增 `npm run structure`，脚本为 `tools/structure-report.mjs`。它输出真实入口、`server/bot.ts` 与 `server/bot/*.ts` 的重复函数名、子模块是否被主流程导入。当前报告确认 `commandHandlers.ts` 未接入主流程，后续不要只改它。
- **Owner 指令添加活跃群聊**: 新增 `/w group add [群名]` / `/wuxin group add [群名]`。只能由 owner 在目标群内使用，会把当前群加入 `groups` 并启用，默认 `mode: mention`、`maxPerHour: 20`、`cooldownSec: 30`；已存在的群会重新启用并更新群名。非 owner 会被拒绝。权限页显示 `groupAdd`，但运行时仍硬性 owner-only。
- **记忆页编辑体验小修**: 长期记忆画像字段从单行输入框改为可拉伸多行文本框，`整体印象/性格/说话风格/互动习惯/偏好/人工备注` 可以完整查看和编辑；清理 App.jsx 底部重复 `createRoot` 渲染。
- **接手复查与日志细化**: 恢复后复查 DS 期间改动，确认前端构建和 `server/bot.ts` 导入通过。修复 GUI 残留英文：`Group ID/Edit/None/msg/Error/Request failed` 等恢复为中文。指令日志新增 `invalid` 状态，用法错误、范围错误、未知子指令、消息太少等不再显示为 `ok`。
- **维护注意**: 当前代码仍是 Phase A 半拆分状态：`server/bot.ts` 保留核心流水线和 `runOwnerCommand()`，但 `cleaning/llm/reply/prompt/memory/commands` 已接入真实运行路径；`server/bot/commandHandlers.ts` 目前没有接入主流程。后续修改后端逻辑时，必须先确认实际运行路径，避免只改备用/未接入文件。旁路说明见 `server/bot/README.md`，结构风险可用 `npm run structure` 查看。
- **搜索检测增强**: `asksForExplicitSearch()` 现在覆盖更广的搜索意图，包括"最新版""什么时候出""最近新闻"等隐含搜索请求。
- **代码拆分 (Phase A)**: `server/bot.ts` 从 2101 行拆分为多个子模块：`bot/cleaning.ts` (消息清洗)、`bot/llm.ts` (LLM 接口)、`bot/reply.ts` (回复输出)、`bot/prompt.ts` (提示词构建)、`bot/memory.ts` (长期记忆)、`bot/commands.ts` (权限角色)。当前真实运行路径包含 `cleaning/llm/reply/prompt/memory/commands`；`commandHandlers.ts` 仍未接入，改行为前以 `npm run structure` 为准。
- **自动模型/搜索深度切换**: 新增 `enableAutoModel` 设置（默认开启）。`taskComplexityScore()` 评估任务复杂度，`autoModelForTask()` 自动选择模型和搜索深度。简单任务用 Flash+fast，复杂任务自动升级到 Pro+deep。GUI Model 页有开关。@ 提及时显示当前使用的模型名。
- **搜索检测增强**: `asksForExplicitSearch()` 扩大覆盖范围，包含"最新版""什么时候出""最近新闻"等隐含搜索意图。
- **三角洲小群触发修正**: 复盘 `865512115` 日志后收紧回复触发。纯 `@`、纯媒体、纯卡片占位不再触发模型，也不进入上下文；图片/表情包默认静默，只有明确要求“看图/识图”时才解释视觉限制。连续对话窗口从“高权限用户随便一句都接”改为“必须像追问或接上一句”，避免机器人抢话。
- **并发与超时防护**: 新增按群/私聊维度的回复生成锁，同一群已有回复在生成时会跳过新的自动接话，防止短时间双回复。DeepSeek 调用增加 45 秒超时，避免日志里出现 shouldReply=true 但后续没有回复和用量记录的悬挂状态。
- **后台信息泄露收紧**: 改写器现在会把 `owner`、源代码、内部推理逻辑、训练细节、参数规模等后台味道说法视为异常回复并重写。Prompt 也要求群聊里不要直接说 `owner`，问源代码/本地文件时只说明需要后台操作者自己决定是否分享。
- **指令日志增强**: 新增 `commandLogs`，所有 `/w`/`/wuxin` 指令都会记录操作者、群、角色、指令、子指令、执行状态、耗时、失败原因。`/wuxin summarize` 等 API 失败现在会在日志页和诊断导出里保留错误原因。日志页新增“指令与错误”栏；清空上下文时会同步清理指令日志。
- **Memory card weighting fix**: Share-card/video samples are now kept as `type: card` and excluded from direct profile samples. During automatic profile updates, recent card/video titles are passed to the memory summarizer only as low-weight background. The summarizer is instructed to use them only when they match the user's real text repeatedly, and never infer personality/identity/orientation from a single forwarded title.
- **Nested card-title cleanup**: QQ mini-app titles such as `[QQ小程序]...` are flattened inside `[分享卡片：...]` placeholders so inner brackets do not leak tail text into memory. Existing dirty samples like `平凡的JK尝试交往]` were reclassified as cards, while real nearby text such as `有没有想要的` was restored as `text`.
- **Message cleaning layer**: `server/bot.ts` now normalizes `CQ:json`, `CQ:xml`, and `CQ:forward` into compact share-card placeholders before messages enter context or memory. Extractable card titles/descriptions become `[分享卡片：标题 / 简介]`; malformed or partial cards fall back to `[分享卡片]`.
- **Typed long-term memory samples**: Memory samples now carry `type`, `usedForProfile`, and `reason`. Automatic profiling only uses `type: text`; commands, pure media, share cards, and long machine-looking outputs are kept as audit samples but excluded from profile generation. The Memory GUI shows recent samples and why each sample did or did not enter the profile.
- **Dirty memory cleanup**: Existing DB messages/samples were cleaned once. 27 old context messages were normalized, 46 memory samples were typed, and partial/truncated CQ card samples were retagged so they no longer feed profiles.
- **Continuous conversation window tweak**: When the bot has just replied, owner/admin/priority/trusted users can continue the exchange briefly without another `@`. This is bounded by the recent bot-reply window.
- **Owner private context soft cap**: Owner private chat still receives much more history than normal groups, but it is now capped by `settings.ownerPrivateContextCharBudget` (default 24000 chars) and injects a soft warning when older private messages were omitted.
- **Empty reply defense**: The LLM layer retries once if the model returns empty content. If search was enabled, the retry removes search parameters first; token usage from both attempts is merged.
- **AI answer-shape autonomy**: Code now gives the model a wider output ceiling and injects a bottom-level prompt asking it to decide short/medium/long response density from the actual conversation. Hard code remains for hygiene and guardrails, not for conversational style.

### 2026-05-21 (late) — 重构事故报告

**错误链：**

1. **Phase C 拆分 App.jsx 时**，使用 PowerShell `Get-Content` 不加 `-Encoding UTF8` 读取了 UTF-8 编码的 App.jsx。Windows PowerShell 5.1 默认使用系统 ANSI 编码（中文 Windows 为 GBK），将 UTF-8 字节错误解释为 GBK，产生乱码字符串。
2. 后续 `WriteAllLines` 将乱码字符串写回文件，**原始 UTF-8 字节永久丢失**。180+ 处中文字符串全部损坏为不可逆乱码。
3. 乱码字符包含 U+E000-U+F8FF（Private Use Area）范围内的字节，这些字节在 JSX 解析时被误认为标签分隔符、正则表达式边界等，导致 **162 处 JSX 语法错误**。
4. `fix-all-remaining.mjs` 脚本按行号替换时，未能同步更新 `MemoryText` 组件引用——原文件中该组件名也被乱码污染，修复后变成未定义的 `MemoryText`，React 渲染时抛出 ReferenceError，导致**记忆页白屏崩溃**。

**修复过程：**

1. 逐行修复 JSX 语法错误——替换所有乱码 `<h2>`/`<p>`/`<button>` 标签中的 `?/>` 为 `</>`，修复被乱码吞掉的闭合引号。
2. 将所有 JSX 属性中的乱码 label 替换为英文占位符（`"QQ群号"` → `"Group ID"`），确保 JSX 解析正常。
3. 修复 `commandStatusLabels`、`roleOptions` 等处乱码模板字符串导致的花括号不匹配。
4. 将未定义的 `MemoryText` 替换为标准 `Text` 组件。
5. 每次修复后运行 `npm run build`，根据 esbuild 错误逐一定位下一处语法错误。

**结果：**
- `npm run build` ✅ 通过（2.3s）
- 后端启动 ✅ 正常
- 前端 GUI ✅ 所有页面不再白屏
- **GUI 中文全部恢复**：`restore-chinese.mjs` 脚本通过 205 组精确映射，将所有英文占位符替换回正确中文文本，涵盖 9 个标签页的全部 UI 字符串。构建通过，零乱码残留。
- 清理 `MemoryText` 未定义组件导致的记忆页白屏崩溃。
- **残留英文**：`modeLabels` 和 `policyLabels` 的中文本就完好无损。仅 Password 组件和 `api()` 中的 `'Request failed'` 保留英文（无对应中文占位需求）。
- **后续修复**：Connect 页面错误行 `'鏃?'` 乱码修复为 `'无'`，状态和事件行的 `'Connected'/'Disconnected'/'None'` 恢复为 `'已连接'/'未连接'/'暂无'`（commit `9be96a3`）。

**根因教训：**
- Windows 上操作 UTF-8 文件必须显式指定编码，`Get-Content`/`WriteAllLines` 默认行为因系统语言而异
- 重构前必须有 Git 备份或文件副本
- 禁止直接用 PowerShell 文本处理管线操作含中文的文件；应使用 Node.js 的 `readFileSync`/`writeFileSync` 并显式指定 `'utf8'`

### 2026-05-20
- **三角洲小群互动修正**: 新增 120 秒连续对话窗口。机器人刚回复后，如果用户明显在接上一句（如“什么鬼”“有头没尾”“幻觉严重”“继续/补上/重写/上网搜”），即使当前群是 mention 模式也会回复。Owner/admin/priority 在窗口内的追问也可继续接话。
- **长文与搜索模式修正**: 检测作文/长文/续写/继续等任务时临时提高 max tokens，并优先用合并转发，避免半句话截断；长文不再被短回复改写器压成 1-2 句。显式要求搜索时强制进入搜索模式，并在 prompt 中要求不确定就承认，不编地图机制、数据、日期、价格、版本。
- **系统暴露收紧**: Prompt 和改写器新增约束，群聊回复里避免说“系统/后台/写死/配置/规则里写着”等实现细节，权限冲突用更自然的话表达。
- **GUI 编辑防覆盖**: 修复控制台每 5 秒自动刷新会覆盖未保存草稿的问题。`权限` 页、`记忆` 设置和画像编辑现在使用 dirty 状态，用户正在编辑时不会被后台轮询刷新打回旧值，保存后再同步。
- **长期记忆 v1**: 新增 GUI `记忆` 页。按 QQ 号全局记录群友画像，跨群/私聊复用。Owner 不自动画像；管理员、重点关注、白名单等按重要性分层，自动画像阈值不同。画像可手动编辑/停用/删除。
- **Owner 私聊全上下文**: Owner 私聊不受普通 `contextLimit` 限制，尽量带入全部私聊上下文；群聊仍按 `contextLimit` 控制。
- **可配置指令权限**: 新增 GUI `权限` 页，支持自定义用户组名称/等级，并为每类 `/w` 指令设置最低用户组。Owner 永远绕过权限检查。`/w op`/`/w deop` 保留为内置管理员组操作，自定义组只从后台 GUI 分配。
- **联网搜索**: 新增 `enable_search` 顶层参数方式启用，支持所有 Chat/V4 模型。`/w search on|off|status|fast|balanced|deep` 指令（admin/owner）。GUI Model 页开关。
- **群聊总结**: `/w summarize [N]` 指令，合并转发输出。默认 50 条，100+ 需 admin/owner。所有群成员可用。
- **成员定制提示词**: 用户可设 `customPrompt`，该成员发言时注入到系统 prompt。
- **搜索指示器**: @ 提及时显示"正在进行思考…"，自然插话不提示。
- **长回复合并转发**: 超 150 字或多段话自动用合并转发发送。
- **用量修复**: `rewriteNormalReply` 和 summarize 的 token 现在正确计入 usageEvents。`/w usage` 增加分模型费用计算（基于 DeepSeek 官方定价）。
- **代码清理**: 移除 `asksIdentityOrModel`、`asksForWebSearch`、`identityReply` 等硬编码正则，身份/模型问题交给 AI 自行判断。
- **Bug 修复**: 循环依赖导致后端崩溃（已移除 OCR 的 onebot.ts 导入）；`buildPrompt()` 模板字符串语法断裂。

## 2026-05-21 晚间 — Wuxin 重命名 + 多项功能迭代

- **项目重命名 Diaz→Wuxin**: 所有代码、文档、prompt 中的 Diaz 替换为 Wuxin。指令前缀 `/diaz` `/d` → `/wuxin` `/w`。变量 `isDiazCommand` → `isWuxinCommand`。数据库中的 botNames 和 prompt 同步更新。

- **数据目录分离**: 用户数据从项目内 `data/db.json` 迁移到 `%APPDATA%\Wuxin\db.json`，支持 `DATA_DIR` 环境变量自定义。首次运行自动创建。项目目录现在是纯代码，可安全分享/上传 GitHub。

- **Git 安全加固**: `.gitignore` 新增 `data/` 和 `.env` 屏蔽。已跟踪的 3 个 data 文件通过 `git rm --cached` 移除。`.env.example` 补全 `LLM_PROVIDER`、`LLM_API_KEY`、`LLM_API_BASE_URL`、`DATA_DIR`。

- **BOM 防护**: `readDb()` 增加 UTF-8 BOM 剥离逻辑，防止 PowerShell 写入文件时引入的 BOM 导致 `JSON.parse` 崩溃。sanity 测试脚本同步加固。

- **群聊上下文理解强化**: 每条历史消息增加 `[HH:MM]` 时间戳。系统 prompt 新增【群聊上下文理解规则】，防止 bot 把不同人/不同时间的消息混在一起，但仍允许自然参与话题。

- **Owner 自动升级**: Owner 提问时自动切换 DeepSeek V4 Pro + deep 搜索 + 1200 tokens，不再按复杂度评分判断。

- **手动画像更新 `/w profile`**: 新增 `/w profile @某人` 指令（admin/owner），立即手动触发用户画像更新，无视自动阈值。

- **长期记忆修复**: 画像更新 `maxTokens` 520→800，减少 JSON 截断。JSON 解析增加修复逻辑（去尾逗号、补缺失括号）。自动触发默认阈值 8→5。

- **暂停/恢复指令**: 新增 `/w pause` 和 `/w resume` 指令（admin/owner），可在 QQ 群内直接暂停/恢复机器人全局回复。

- **OneBot 自动检测**: QQ连接页新增"自动检测"按钮，扫描本地常见 NapCat 端口（3000/3001/4000/5700 等），检测到自动填入 HTTP + WebSocket 地址。新手引导简化。

- **Temperature 降低**: 默认 temperature 0.6→0.4，减少胡言乱语概率。Prompt 中删除奇怪的"test 时回复已接收"规则，新增"被指出错误时直接承认"约束。

- **画像字段类型安全修复**: LLM 返回的画像 JSON 中 `traits` 等字段可能为嵌套对象而非字符串，`String()` 直接转为 `[object Object]` 字面量。新增 `flattenProfileValue()` 安全转换函数，对象值取其所有 value 用分号拼接。`applyProfileUpdate()` 统一应用画像更新。LLM prompt 明确要求字段值为字符串。

---

## 2026-05-22 — 底层提示词重构 + 画像系统修复 + 新指令

- **底层系统 prompt 精简重构**: `buildPrompt()` 的系统注入从 ~50 行缩减到 ~20 行。所有人格/语气/行为约束移出底层代码，完全交由 `personalityPrompt` 控制。底层只保留硬事实（owner QQ、模型名、发言者身份）和硬限制（看不到图片、上下文规则）。人格 prompt 放 system 消息顶部，底层信息放 user 消息底部，用---分隔线标注"以上必须遵守/以下仅供参考"。

- **纯人设模式 `/w sysfacts`**: 新增 `ignoreSystemFacts` 设置。开启后所有底层系统信息（owner、模型名、上下文规则等）完全不注入请求，LLM 只看到人设 prompt。GUI 模型页有开关，QQ 端 `/w sysfacts on|off|status`（admin 权限）。默认关闭（底层信息正常注入）。

- **基线人设重写**: `baselinePersonalityPrompt` 重新组织为四个区块（说话风格/对 owner/图片与多媒体/安全与后台），将底层砍掉的行为约束合并进去，结构清晰。`/w prompt reset` 恢复到新版基线。

- **画像分类过滤强化**: `classifyMemorySample` 新增三类过滤：① 其他 bot 的 CQ markdown/json/xml 消息标记为 bot-output 不入画像；② 有意义字符 <5 的过短消息（「对」「你好」「微甜」等）不入画像；③ 所有以 `/` 开头的消息统一归类为 command。运行时清洗了 81 条脏样本（14 bot + 67 过短）。

- **画像 JSON 解析增强**: `updateMemoryProfile` 的 system prompt 新增明确 JSON schema（summary/traits/speechStyle/behavior/preferences五个字段），要求 LLM 按格式输出。JSON 修复逻辑覆盖截断、尾逗号、未闭合字符串、缺失括号等常见 LLM 输出缺陷。

- **画像子命令扩展**: `/w profile show @某人`（查看画像）、`/w profile samples @某人`（显示画像依据的发言样本）、`/w profile rule @某人 规则`（设置画像描述约束，如"禁止负面词汇"）、`/w profile clear @某人`（清除画像）。

- **画像约束 `profilingRule`**: MemoryEntry 新增 `profilingRule` 字段。`/w profile rule @某人 规则` 可设置硬性约束（如"禁止使用负面词汇描述"），在 LLM 生成画像时作为【硬性约束】注入 prompt。不设约束则正常生成。

- **`/w help` 分组重构**: 指令帮助从一大坨平铺改为 6 个分组（成员管理/备注与画像/人设/群聊设置/模型与搜索/系统），每组带标题，格式简洁。

- **`/w my` 指令**: 显示当前用户的身份组/等级、可用指令列表（按分组）、无权限指令。合并转发输出。所有用户可用。

- **成员页面可用性优化**: 显示名优先备注昵称→最新发言群名片→记忆昵称→QQ号。新增搜索/筛选/排序（按昵称QQ备注搜、按群/策略筛、按活跃/策略/注意力排）。彩色标签直观标记管理员/黑名单/重点关注/指令/备注/定制提示词/记忆。卡片底部显示最近活跃群组和记忆摘要片段。

- **群聊页识别强化**: 群名优先备注→自动用活跃成员群名片生成（如「A、B 等人的群」）。搜索/排序/模式标签。卡片显示最近活跃成员、最后发言片段。表单加「用最近活跃成员生成备注」按钮。

- **画像护栏强化**: `looksLikeUnstableBanter()` 过滤玩梗/测试/骂人/钓鱼发言。`looksLikeOneOffQuestion()` 过滤一次性提问。`normalizeProfileValue()` 将 LLM 返回的侮辱性标签（弱智/恶心/嘴臭等）自动软化为中性措辞或丢弃。已有画像脏数据运行清洗。

---

## 2026-05-22 晚间 — 基础设施 + 可观测性 + 画像质量

- **一键备份/恢复系统**: 新增 `server/backup.ts`，提供创建/列出/恢复/删除/自动轮转。API：`GET/POST /api/backups`、`POST /api/backups/:name/restore`、`DELETE /api/backups/:name`。GUI 总览页底部备份面板（手动+自动）。每 8 小时自动备份一份，最多保留 10 份。恢复前 JSON 校验 + 自动 pre-restore 安全备份。

- **健康状态页**: 新增 `server/health.ts`（内存状态，不入 DB）。接入点：`onebot.ts`（WS连接/事件/发送失败）、`llm.ts`（LLM成功/失败/延迟）、`bot.ts`（全局暂停/决策错误）。API：`GET /api/health`。GUI 总览页顶部健康卡片：整体状态（正常/警告/错误）、QQ连接状态、LLM 平均延迟、LLM 近期错误数。

- **记忆置信度与证据追踪**: `MemoryEntry` 新增 `profileMeta` 字段，每个画像维度（性格/说话/互动/偏好）记录置信度(0-1)、证据数量、更新时间。LLM 画像 prompt 要求返回 `confidence` 对象。`countEvidenceByField()` 自动统计每条有效样本对各个维度的支撑。GUI 画像编辑区显示彩色置信度条（≥70%绿 / ≥40%黄 / <40%红），hover 显示依据数量和更新时间。

- **高风险画像自动降级**: `classifyMemorySample` 新增 `riskLevel` 返回：`normal`（正常进入画像）/ `low-confidence`（低置信，保留但不写画像）/ `high-risk`（高风险，仅审计）。高风险触发条件：身份/取向/心理状态推断、强负面人格标签、反串/钓鱼/测试。GUI 样本列表显示「高风险已降级」「低置信」标签。

- **Codex 审查硬化**: 修复 5 个问题——备份路径遍历安全（`safeBackupName` 校验）、高风险独立于 banter 检测（`looksLikeSensitiveClaim` 覆盖「我有抑郁症」「我是同性恋」等自述+第三人称声明）、健康状态 time/error/pause 同步修复、pre-restore 备份轮转（最多5份）、记忆衰减显示标记（超14天标注「可能已过时」）。

---

## 2026-05-23 — 语境感知画像（Context-Aware Memory）

- **样本上下文快照**: `MemorySample` 新增 `context` 字段，每条样本存入最近 7 条对话消息 + @ 目标 + 是否 @bot + 发言者信息。`captureContext()` 在 `recordMemoryObservation` 时自动获取，不额外调 LLM。

- **上下文感知画像更新**: `updateMemoryProfile()` 不再传孤立的句子，改为传带完整对话上下文的样本块（发言者/内容/上下文对话/@了谁/是否@bot/风险等级/分类理由）。LLM prompt 要求先判断每条样本的 subject（关于谁）、addressee（对谁说）、observationType（什么类型），再决定是否写入画像——只写 self+稳定证据的，对别人的评价/玩笑/一次性提问/第三方声明/敏感推断一律不写。

- **旧画像自动降权**: 代码检测画像是否由旧系统生成（无 context 快照、无 profileMeta）。旧画像在 LLM prompt 中标注「缺乏上下文分析，判断可能不准确」。新旧冲突时优先信任带上下文的新观察。新数据积累后自动覆盖旧画像。

- **`/w profile samples` 分层展示**: 输出分四档——带上下文的画像依据（附对话摘要）、旧版无上下文样本（标注权重已降低）、低置信观察（附降级原因）、高风险已降级（仅审计）。GUI 记忆页同步：新样本绿色语境提示，旧样本米黄色「旧版样本，无上下文记录」。

---

## 2026-05-23 下午 — 群聊画像（Group Chat Profile）

- **群聊画像系统**: 新增 `server/bot/groupProfile.ts`，独立于个人画像。描述群聊整体氛围（atmosphere/topics/humorStyle/pace/boundaries/botStrategy），按 groupId 存储，与个人 userId 画像完全隔离。数据存 `db.groupProfiles[]`。

- **LLM 驱动生成**: `collectGroupProfileSamples()` 取最近 150 条清洗后的群消息。`updateGroupProfile()` 调用 LLM 分析群氛围，prompt 禁止推断成员身份/取向/心理状态，输出重点放在「机器人在该群如何更自然地说话」。

- **Prompt 注入**: `groupProfilePromptBlock()` 在 `buildPrompt()` 中注入 【当前群聊氛围】块，仅对当前 groupId 生效，私聊和其他群不注入。

- **QQ 指令**: `/w group profile show`（查看）/ `update`（生成）/ `clear`（清除）/ `on|off`（开关注入）。admin/owner 权限。更新时合并转发显示结果。

- **API**: `GET /api/group-profiles/:groupId`、`POST .../update`、`PATCH .../`、`DELETE .../`。

- **GUI 完整面板**: 群聊页每张群卡片可展开画像面板（点击 ▸/▾），默认显示六字段只读视图 + 更新/清除/启停按钮。点「手动编辑」后六字段转为 textareas，可直接修改并保存。编辑/LLM生成/清除三种更新路径互不干扰。

- **V2 自动更新**: 新增 `incrementGroupProfilePending()` 和 `maybeAutoUpdateGroupProfile()`。每条群消息自动累积 `pendingMessageCount`，达到阈值（默认 80 条）自动触发 LLM 群画像更新。触发前先重置计数器防重复。GUI 群聊页顶部可开关自动更新 + 调整阈值。设置项 `groupProfileAutoUpdate`（默认 true）/ `groupProfileThreshold`（默认 80）。

- **GPT 审查修复**: PATCH 补全 topics/humorStyle/pace 字段；新增独立权限键 `groupProfileShow` / `groupProfileEdit`（默认 admin）替换 search 借用；群画像 LLM 调用计入 usageEvents + db.usage；自动更新只对真实文本（≥3 字符、非指令/媒体）计数；更新时保留已有 enabled 状态。

- **UX 优化**: `api()` 函数透传后端实际错误信息（不再只显示"请求失败"）。Express 加 JSON error handler，不再返回 HTML 错误页。记忆页、日志页新增搜索（昵称/QQ/关键词），所有卡片页均可过滤。

- **一键场景预设 `/w preset`**: 六种预设模式——`class`（上课/会议，完全静默）、`away`（出门/忙，极少回复）、`sleep`（睡觉，全局暂停）、`active`（活跃聊天，自然参与+自动画像）、`silent`（安静挂机，轻度参与）、`debug`（调试，高频@回复）。每条预设自动改：回复模式、每小时上限、冷却、@模式、自动画像、全局暂停。返回变更对比（旧值→新值）。admin 权限。

- **诊断 `/w why`**: 显示所在群最近一条消息的回复决策——谁说了什么、回了还是没回、原因（冷却/上限/@/图片/muted 等）、时间。所有用户可用。

- **画像定向重算 `/w profile retry @某人 方向`**: 按指定方向重新生成画像。例如 `/w profile retry @某人 重点关注技术和游戏方面，忽略临时玩笑`。将方向作为临时 `profilingRule` 注入 LLM，重算后恢复原约束。admin 权限。

---

## 2026-05-29 — 回复排队系统 + V2 修复 + CLAUDE.md

### 回复排队系统 (commit d65cfae)

- **问题**: bot 正在生成回复时（尤其是多模态图片处理耗时），新的 @bot 消息被直接丢弃（`activeReplyGroups` Set 机制）。
- **方案**: FIFO 队列替代丢弃。`replyQueues` Map 存储每群的锁状态和排队消息。上限 10 条/群。
- **关键实现**:
  - `drainReplyQueue(key)` 在 `finally` 块中调用，处理完当前回复后自动处理队列中下一条。
  - drain 调用 `processIncoming(event, sm, decision, true)` — 第 4 参数 `isFromDrain=true` 跳过锁检查，避免死循环（drain 的 processIncoming 发现 lock=true 会把消息重新入队）。
  - 指令 (`/w`) 在锁检查前处理（line 311-317），不受队列阻塞。
  - 队列状态通过 `/api/health` 的 `replyQueues` 字段暴露。
- **测试**: `tools/queue-verify.mjs` — 内置 mock LLM 服务器（Node `http` 模块，1500ms 延迟），5 项测试：基本排队、队列排空、队列上限、指令绕过、队列统计。4 次运行全过。
- **备份**: `G:\QQ-AI-ChatBot-backup-pre-queue-20260529-163915`

### V2 聚类 hasSpecial 修复 (commit ec3a57b)

- **问题**: `clusterSamplesByTopic` 中的 `hasSpecial` 正则只有 `cs2|osu|owc|deepseek|v4|api|gpt|bot`，与 `SPECIAL_TERMS`（含 `react|vite|onebot|napcat|qq|npm|node|jsx|css`）不一致。技术术语在 tokenization 时被提取为 special terms，但聚类时不会触发 special match。
- **修复**: 新增 `SPECIAL_TERMS_NG`（非 global 版同一正则），`hasSpecial` 改用 `SPECIAL_TERMS_NG.test(t)`。避免 `SPECIAL_TERMS`（带 `g` flag）的 `.lastIndex` 副作用。
- **测试**: `tools/v2-verify.mjs` — 5 项验证：单场景→短期、跨天→长期、混合话题、跨群 bonus、特殊术语聚类。

### CLAUDE.md (commit aa02cad)

- 项目文档，涵盖架构、模块清单、关键约束、环境变量、验证清单、常用任务（添加指令/修改画像/修改 LLM/修改 GUI）。

### 其他

- 备份清理：删除 4 个旧备份，只保留 `QQ-AI-ChatBot-backup-multimodal-20260529-144532`。
- 画像空跑修复 + 多模态图片链路 + 画像容错 (commit a21c0cf): 11 files, +842/-118。详见 CHANGELOG.md Unreleased 段。
- HANDOFF.md 更新：清理旧备份引用、去重已完成表格、更新时间线。
- CHANGELOG.md 更新：新增回复排队系统条目。
