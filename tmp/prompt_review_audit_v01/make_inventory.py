# Audit-only inventory generator (read-only; writes JSON artifacts under tmp/prompt_review_audit_v01)
import json
from pathlib import Path

ROOT = Path(r"G:\QQ-AI-ChatBot")
OUT = ROOT / "tmp" / "prompt_review_audit_v01"
OUT.mkdir(parents=True, exist_ok=True)

rules = []
def rule(rid, source, section, layer, semantics, status, dup=None, conflict=None, dep=None, owner="WuxinBot runtime"):
    rules.append({
        "rule_id": rid,
        "source_file": source,
        "source_section": section,
        "runtime_layer": layer,
        "short_semantics": semantics,
        "owner": owner,
        "status": status,
        "duplicates": dup or [],
        "conflicts": conflict or [],
        "observed_dependency": dep or "",
    })

# persona / prompt / tool / review / deterministic
rule("R001", "server/bot/persona.ts", "PIPPI_CORE", "system", "pippi 身份与世界观，不称 AI/模型/助手", ["PERSONA","MUST_KEEP"])
rule("R002", "server/bot/persona.ts", "PIPPI_CORE", "system", "Auto 世界观，只自然出现", ["PERSONA"])
rule("R003", "server/bot/persona.ts", "PIPPI_CORE", "system", "语气、关系、边界、语言风格约束", ["PERSONA","MUST_KEEP"])
rule("R004", "server/bot/persona.ts", "PIPPI_FACT_BOUNDARIES", "system", "不编数字/经历/关系；观察与推断分开", ["SAFETY","MUST_KEEP"], dep="analyzer validator/reviewer")
rule("R005", "server/bot/persona.ts", "PIPPI_FACT_BOUNDARIES", "system", "Recent/PP+/Mod/缺失数据解释边界", ["SAFETY","MUST_KEEP"], dep="analyzer reviewer")
rule("R006", "server/bot/persona.ts", "SCENE_*", "system", "casual/analysis/command/serious 场景规则", ["PRODUCT_BEHAVIOR"])
rule("R007", "server/bot/persona.ts", "PIPPI_CORE 推图/工具段", "system", "recommend/pp_calc/beatmap/leaderboard 必须调用工具且禁止编数字", ["TOOL_ROUTING","MUST_KEEP"], dup=["R040","R041","R042","R043","R044","R045","R046"])
rule("R008", "server/bot/prompt.ts", "visualCapabilityNotice", "system+user", "视觉能力诚实声明；无图不提视觉", ["SAFETY","PRODUCT_BEHAVIOR"], dup=["R009"])
rule("R009", "server/bot/prompt.ts", "facts 与 factualCtx", "system+user", "同一视觉说明被注入 system 与 user 两个位置", ["DUPLICATE","PARTIAL_DUPLICATE"], dup=["R008"])
rule("R010", "server/bot/prompt.ts", "facts", "user", "当前群/owner/发言者身份/owner 优先", ["PRODUCT_BEHAVIOR"], dup=["R011"])
rule("R011", "server/bot/prompt.ts", "factualCtx", "system", "当前群/owner/发言者身份在 system 再注入一次", ["PARTIAL_DUPLICATE"], dup=["R010"])
rule("R012", "server/bot/prompt.ts", "facts + factualCtx", "system+user", "模型/供应商信息，被直接问到时用", ["PRODUCT_BEHAVIOR"], conflict=["R001"])
rule("R013", "server/bot/prompt.ts", "facts", "user", "禁说系统/后台/写死/配置等实现细节", ["SAFETY","PERSONA"], dup=["R014"])
rule("R014", "server/bot/reply.ts", "rewriteNormalReply", "rewrite", "改写时禁实现细节/提示词话题", ["SAFETY","LEGACY_REVIEW"], dup=["R013"])
rule("R015", "server/bot/prompt.ts", "memoryPromptBlock / relBlocks", "system", "长期记忆、群画像、关系、技能块注入 system", ["PRODUCT_BEHAVIOR"], dup=["R016"])
rule("R016", "server/bot/prompt.ts", "facts", "user", "同样的记忆/群画像/关系块同时注入 user facts", ["DUPLICATE","PARTIAL_DUPLICATE"], dup=["R015"])
rule("R017", "server/bot/prompt.ts", "selfNegationBan / anchor", "user", "进入回复阶段禁自我否定；@ 锚点", ["SAFETY","PRODUCT_BEHAVIOR"])
rule("R018", "server/bot/prompt.ts", "facts", "user", "发言者绑定 osu 身份必须写死", ["TOOL_ROUTING","MUST_KEEP"], dep="resolveInternalPlayerTarget")
rule("R019", "server/bot/prompt.ts", "formatHistoryForModel", "history", "历史带 [HH:MM] 时间戳与 QQ/昵称", ["PRODUCT_BEHAVIOR"])
rule("R020", "server/bot/prompt.ts", "taskComplexityScore/responseOptionsFor", "code", "复杂分/模型自动选择；owner 强制 pro", ["TOOL_ROUTING","PRODUCT_BEHAVIOR"])
rule("R021", "server/bot/gate.ts", "decideReply", "code", "确定性回复门：暂停/黑名单/静默/冷却/频率/提及/连续对话", ["PRODUCT_BEHAVIOR","MUST_KEEP"])
rule("R022", "server/bot/gate.ts", "llmReplyGate", "gate LLM", "natural/light 模式用 LLM 给接话价值打分（346 tokens 均值）", ["PRODUCT_BEHAVIOR","LEGACY_REVIEW"], dup=["R021"])
rule("R023", "server/bot/gate.ts", "llmContentFilter", "gate LLM", "用户设置内容过滤（仅昵称/风格，聊天正文不走）", ["SAFETY","MUST_KEEP"])
rule("R024", "server/bot.ts", "tool availability note", "system", "一次追加约 1401 字工具调用规则", ["TOOL_ROUTING","MUST_KEEP"], dup=["R007","R025","R026"])
rule("R025", "server/bots/agentCapabilities.ts", "buildQueryOsuDescription", "tool schema", "query_osu 描述 1259 字（由 capabilityCatalog 派生）", ["TOOL_ROUTING","SINGLE_SOURCE_DERIVED"], dup=["R007","R024"])
rule("R026", "server/bots/capabilityCatalog.ts", "CAPABILITY_CATALOG", "code", "能力枚举/描述/参数适用性单源", ["TOOL_ROUTING","SINGLE_SOURCE","MUST_KEEP"])
rule("R027", "server/bot.ts", "required-tool deterministic route", "code", "显式 osu 查询先执行工具再让 LLM 写 lead", ["TOOL_ROUTING","MUST_KEEP"])
rule("R028", "server/bot.ts", "bp_type deterministic route", "code", "BP 类型/占比强制 bp_type，禁 LLM 猜测", ["TOOL_ROUTING","MUST_KEEP"], dup=["R024","R025"])
rule("R029", "server/bot.ts", "recommend hard guard", "code", "recommend 请求未调工具且回复像推荐时强制重跑", ["TOOL_ROUTING","MUST_KEEP"], dup=["R007","R024"])
rule("R030", "server/bot.ts", "named bot degrade", "code", "点名 bot 不支持时明确降级提示", ["TOOL_ROUTING"])
rule("R031", "server/bot.ts", "search interception", "code", "显式联网搜索先调真实搜索；无源如实拒绝", ["TOOL_ROUTING","SAFETY"])
rule("R032", "server/bots/executor.ts", "runToolLoop", "tool loop", "max 4 iterations / 8 calls per turn；结果防注入与直接交付", ["SAFETY","TOOL_ROUTING","MUST_KEEP"])
rule("R033", "server/bot/reply.ts", "sanitizeReply/isWeirdReply", "postprocess", "去前缀、去工具标记；触发 rewriteNormalReply", ["SAFETY","LEGACY_REVIEW"], conflict=["R034"])
rule("R034", "server/bot/reply.ts", "isWeirdReply >180 chars", "postprocess", "普通回复超过 180 字会被判 weird 并重写", ["LEGACY_REVIEW","LOW_VALUE"], conflict=["R033"])
rule("R035", "server/bot/reply.ts", "rewriteNormalReply", "rewrite LLM", "第二 LLM 改写（370 字 system，180 max tokens）", ["LEGACY_REVIEW","QUALITY_REVIEW"])
rule("R036", "server/bot/commands/index.ts", "getAllCommandHelpEntries", "code", "命令 descriptor 单源入口（86 条）", ["TOOL_ROUTING","SINGLE_SOURCE","MUST_KEEP"])
rule("R037", "server/bot/commands/index.ts", "buildCapabilitySummaryDocs", "KB", "按观众生成能力摘要文档（3 audience × 5 family）", ["TOOL_ROUTING","SINGLE_SOURCE"])
rule("R038", "server/bot/kbRoute.ts/kbPrompt.ts", "KB route/quota", "KB", "KB 检索配额 1500 字，三类 fence，能力/领域/社区分路由", ["TOOL_ROUTING","MUST_KEEP"])
rule("R039", "server/bot/kbQuoteGuard.ts", "KB quote guard", "KB", "长复述社区窗口告警（review aid）", ["SAFETY","LEGACY_REVIEW"])
rule("R040", "server/bot/persona.ts", "推荐段", "system", "recommend 规则影子副本", ["TOOL_ROUTING","SHADOW_COPY"], dup=["R007"])
rule("R041", "server/bot.ts", "tool note", "system", "recommend 规则影子副本", ["TOOL_ROUTING","SHADOW_COPY"], dup=["R040"])
rule("R042", "server/bots/capabilityCatalog.ts", "recommend descriptor", "tool schema", "recommend 能力描述", ["TOOL_ROUTING","SINGLE_SOURCE"], dup=["R040","R041"])
rule("R043", "server/bots/agentCapabilities.ts", "query_osu description", "tool schema", "recommend 在工具描述再次展开", ["TOOL_ROUTING","SHADOW_COPY"], dup=["R042"])
rule("R044", "server/bot/persona.ts", "PP计算段", "system", "pp_calc/假设成绩工具规则影子副本", ["TOOL_ROUTING","SHADOW_COPY"], dup=["R045","R046"])
rule("R045", "server/bot.ts", "tool note", "system", "pp_calc 工具规则影子副本", ["TOOL_ROUTING","SHADOW_COPY"], dup=["R044"])
rule("R046", "server/bots/capabilityCatalog.ts", "pp_calc descriptor", "tool schema", "pp_calc 描述", ["TOOL_ROUTING","SINGLE_SOURCE"], dup=["R044","R045"])
rule("R047", "server/osu/commands.ts", "ENABLE_RUNTIME_LLM_FACT_REVIEW", "code", "analyze 报告总启 LLM 独立事实审查（每份报告 1 次，可重试 2）", ["SAFETY","MANDATORY_SAFETY_CONTROL"])
rule("R048", "server/osu/analyzer.ts", "buildAnalysisReviewerPrompt", "review LLM", "reviewer 无 persona，只查可证明基本事实，八段各一判决", ["SAFETY","MANDATORY_SAFETY_CONTROL"])
rule("R049", "server/osu/commands.ts", "hard reject fallback", "postprocess", "reviewer hard REJECT -> 确定性事实降级，不做 LLM 重写", ["SAFETY","MUST_KEEP"])
rule("R050", "server/osu/commands.ts", "section/conclusion generation", "generation LLM", "区块/结论最多 3 次 + repair + 机械验证 + fallback", ["PRODUCT_BEHAVIOR","MUST_KEEP"])
rule("R051", "server/osu/analyzer.ts", "validateAnalysis*", "code", "机械硬门（数字/Mod/术语/身份/结构）", ["SAFETY","MUST_KEEP"])
rule("R052", "server/bot/persona.ts", "detectScene command", "code", "/w 判定为 command scene；实际 /w 在 bot.ts 提前路由，普通 buildPrompt 不再看到 /w", ["LEGACY_COMPAT","DEAD_OR_UNREACHABLE"], dep="processIncoming")
rule("R053", "server/bot/prompt.ts", "ignoreSystemFacts", "system+user", "关闭 system facts 时 user facts 被省略，但 system factualCtx 仍注入部分事实", ["LEGACY_COMPAT","PARTIAL_DUPLICATE"], conflict=["R010","R011"])
rule("R054", "server/bot/kbPrompt.ts", "community style fence", "KB", "社区表达参考不得逐句引用/声称真实成员", ["SAFETY","MUST_KEEP"])
rule("R055", "server/osu/analyzer.ts", "reviewer system quality rules", "review LLM", "reviewer 明文禁止 quality 类 REJECT；解析器默认未写 kind 为 hard，quality 分支当前无实际产出", ["LEGACY_REVIEW","DEAD_OR_UNREACHABLE"])

# keep ASCII status tags only? no, tags above in Chinese okay; json write utf8.
(OUT / "rule_inventory.json").write_text(json.dumps({
    "schema_version": "prompt_review_rule_inventory_v1",
    "generated_by": "WUXINBOT_PROMPT_REVIEW_AUDIT_V01 (read-only)",
    "rule_count": len(rules),
    "rules": rules,
}, ensure_ascii=False, indent=2), encoding="utf-8")

duplication = {
    "semantic_groups": [
        {
            "semantic": "osu 数据必须调 query_osu、禁止编数字/猜 bp_type/recommend",
            "code": ["server/bot.ts deterministic required-tool/bp_type/recommend guard"],
            "system": ["server/bot/persona.ts 推图/pp_calc 段", "server/bot.ts tool availability note"],
            "persona": ["server/bot/persona.ts PIPPI_CORE 推图段"],
            "descriptor": ["server/bot/commands/*.meta.ts"],
            "tool_schema": ["server/bots/agentCapabilities.ts buildQueryOsuDescription", "server/bots/capabilityCatalog.ts"],
            "KB": ["server/bot/commands/index.ts buildCapabilitySummaryDocs", "KB build 自动命令文档"],
            "review": ["server/osu/analyzer.ts buildAnalysisReviewerPrompt verified_facts gate"],
        },
        {
            "semantic": "推荐必须 recommend + BID 交付 + 失败不编图",
            "code": ["server/bot.ts recommend hard guard"],
            "system": ["server/bot.ts tool note", "server/bot/persona.ts 推图段"],
            "persona": ["server/bot/persona.ts 推图段"],
            "descriptor": [],
            "tool_schema": ["server/bots/capabilityCatalog.ts recommend", "server/bots/agentCapabilities.ts"],
            "KB": ["capability summary docs"],
            "review": [],
        },
        {
            "semantic": "bp_type 必须确定性路由",
            "code": ["server/bot.ts detectBpTypeAnalysisIntent"],
            "system": ["server/bot.ts tool note"],
            "persona": [],
            "descriptor": ["server/bot/commands quick.meta / osu.meta (若出现)"],
            "tool_schema": ["server/bots/capabilityCatalog.ts bp_type"],
            "KB": ["capability summary docs"],
            "review": [],
        },
        {
            "semantic": "owner 权限",
            "code": ["server/bot/owner/router.ts", "server/bot/commands/types.ts canViewCommand"],
            "system": ["server/bot/prompt.ts facts owner 优先"],
            "persona": [],
            "descriptor": ["server/bot/commands/owner.meta.ts"],
            "tool_schema": ["buildCapabilitySummaryDocs owner audience"],
            "KB": ["owner audience summaries"],
            "review": [],
        },
        {
            "semantic": "视觉能力诚实说明",
            "code": ["server/bot/prompt.ts visualCapabilityNotice", "server/bot/reply.ts visualLimitationReply"],
            "system": ["server/bot/prompt.ts factualCtx"],
            "persona": [],
            "descriptor": [],
            "tool_schema": [],
            "KB": [],
            "review": [],
        },
        {
            "semantic": "身份/不自称 AI/不自我否定",
            "code": ["server/bot/prompt.ts anchorText + selfNegationBan"],
            "system": ["server/bot/persona.ts PIPPI_CORE"],
            "persona": ["server/bot/persona.ts PIPPI_CORE"],
            "descriptor": [],
            "tool_schema": [],
            "KB": [],
            "review": ["server/bot/reply.ts rewriteNormalReply identity clause"],
        },
    ],
    "notes": "matrix records locations where same semantic appears; duplication between code enforcement and prompt guidance is not automatically removable because code=SECURITY_ENFORCEMENT and prompt=MODEL_GUIDANCE serve different purposes.",
}
(OUT / "duplication_matrix.json").write_text(json.dumps(duplication, ensure_ascii=False, indent=2), encoding="utf-8")

contradictions = {
    "items": [
        {
            "id": "C01", "rule_a": "R001 persona: 不自称 AI/语言模型", "rule_b": "R012 runtime facts: 被问模型时必须用模型/供应商信息回答",
            "runtime_precedence": "system factualCtx 后注入且 taskRules 显式要求；实测通常按模型信息回答",
            "observed_failure": "无记录；可能表现为人格标签与事实声明冲突",
            "severity": "P1_INSTABILITY_RISK",
        },
        {
            "id": "C02", "rule_a": "R006 casual scene: 自然简短，不展开成长篇", "rule_b": "R024 tool note: 涉及 osu 数据必须调用工具并逐字引用数字",
            "runtime_precedence": "tool note 后追加在 system 尾部，tool routing 优先",
            "observed_failure": "无记录",
            "severity": "P2_REDUNDANCY",
        },
        {
            "id": "C03", "rule_a": "R052 detectScene 会把 /w 判为 command 并构造 command system", "rule_b": "bot.ts 在 buildPrompt 之前路由 /w 到 handleOwnerCommand",
            "runtime_precedence": "bot.ts 先行；command system prompt 对 /w 实际不可达",
            "observed_failure": "无；属于死路径/历史遗留",
            "severity": "P3_STYLE_ONLY",
        },
        {
            "id": "C04", "rule_a": "R008 visualCapabilityNotice 注入 user facts", "rule_b": "R009 同一函数又注入 system factualCtx",
            "runtime_precedence": "同一事件同文本双份注入",
            "observed_failure": "无；token 冗余",
            "severity": "P2_REDUNDANCY",
        },
        {
            "id": "C05", "rule_a": "R015 system relBlocks 含 memory/group/relationship/skill", "rule_b": "R016 user facts 再含 memory/group/relationship",
            "runtime_precedence": "两部分都发送",
            "observed_failure": "无；token 冗余",
            "severity": "P2_REDUNDANCY",
        },
        {
            "id": "C06", "rule_a": "R053 ignoreSystemFacts=true 省略 user facts", "rule_b": "R011 system factualCtx 仍注入群名/owner/发言者/视觉/搜索/长文",
            "runtime_precedence": "system factualCtx 保留，facts 关闭不完整",
            "observed_failure": "无",
            "severity": "P2_REDUNDANCY",
        },
        {
            "id": "C07", "rule_a": "R034 isWeirdReply 把 >180 字普通回复当 weird", "rule_b": "R006 casual scene 与正常长回复允许存在",
            "runtime_precedence": "longForm=false 时 180 字以上即可能 rewrite",
            "observed_failure": "未记录；false-positive rewrite 风险",
            "severity": "P1_INSTABILITY_RISK",
        },
        {
            "id": "C08", "rule_a": "R048 reviewer 只允许 kind=hard", "rule_b": "R055 parser/fallback 支持 quality 分类",
            "runtime_precedence": "quality REJECT 无实际生产路径",
            "observed_failure": "63 份分析中 quality_only=0",
            "severity": "P3_STYLE_ONLY",
        },
    ]
}
(OUT / "contradiction_audit.json").write_text(json.dumps(contradictions, ensure_ascii=False, indent=2), encoding="utf-8")

single_source = {
    "commands": {
        "current_source_of_truth": "server/bot/commands/*.meta.ts + index.ts CommandDescriptor",
        "shadow_copies": ["server/bot/persona.ts 推图/工具段手写命令语义", "server/bot.ts tool availability note 手写命令与 selector 语义", "KB build 自动命令文档", "server/bot/commands/index.ts capability summaries"],
        "drift_risk": "MEDIUM（tool note 与 persona 手写语义未从 descriptor 生成）",
        "recommended_source_of_truth": "CommandDescriptor -> generated prompt/KB/summary（本轮不修改）",
    },
    "capabilities": {
        "current_source_of_truth": "server/bots/capabilityCatalog.ts",
        "shadow_copies": ["server/bot.ts tool note", "server/bot/persona.ts 推图/pp_calc 段", "server/bots/agentCapabilities.ts 长描述（派生，但生成后仍与 tool note 并置）"],
        "drift_risk": "MEDIUM",
        "recommended_source_of_truth": "capabilityCatalog -> tool schema + conditional taskRules",
    },
    "tool_routing": {
        "current_source_of_truth": "server/bot.ts deterministic routes + server/bots/executor.ts runToolLoop",
        "shadow_copies": ["tool note 的 routing 指令", "query_osu 描述"],
        "drift_risk": "HIGH（代码已多次修正路由，而 prompt 文案需手动同步）",
        "recommended_source_of_truth": "code routing + generated short schema-only tool guidance",
    },
    "persona": {
        "current_source_of_truth": "server/bot/persona.ts buildPippiPrompt",
        "shadow_copies": ["server/osu/analyzer.ts compact analysis persona（有意分离）", "server/bot/reply.ts rewrite mini-persona（有意分离）", "legacy fixture tools/fixtures/kb-legacy-prompts.json"],
        "drift_risk": "LOW（分析/rewrite persona 是显式独立角色）",
        "recommended_source_of_truth": "保留分层 persona，不做本轮合并",
    },
    "safety_review": {
        "current_source_of_truth": "deterministic gates + analyzer mechanical validator + independent LLM fact reviewer",
        "shadow_copies": ["persona fact boundaries", "tool note 防编造规则", "rewrite guard 安全文案", "reviewer prompt"],
        "drift_risk": "LOW for hard facts; MEDIUM for prose repetition",
        "recommended_source_of_truth": "code gates stay authoritative; prompt keeps short model-guidance only",
    },
}
(OUT / "single_source_audit.json").write_text(json.dumps(single_source, ensure_ascii=False, indent=2), encoding="utf-8")

call_graph = {
    "entry": "server/bot.ts processIncomingInner",
    "paths": {
        "normal_group_natural_light": {
            "calls": [
                {"step": 0, "caller": "gate.ts decideReply", "llm": "optional", "model": "db.settings.model", "role": "user-only scoring prompt ~346 prompt tokens mean", "trigger": "group.mode natural/light after deterministic checks"},
                {"step": 1, "caller": "bot.ts callLLM or runToolLoop", "llm": "required", "model": "overrideModel or db.settings.model", "messages": "buildPrompt system + history + user (+tool note)", "tools": "query_osu + get_player_skill when internal bots enabled", "loop": "runToolLoop max 4 iterations"},
                {"step": 2, "caller": "bot.ts isWeirdReply -> rewriteNormalReply", "llm": "conditional", "model": "db.settings.model", "messages": "rewrite system 370 chars + original reply", "trigger": "!longForm && isWeirdReply"},
                {"step": 3, "caller": "bot.ts level-up async", "llm": "conditional rare", "model": "db.settings.model", "messages": "level-up prompt"},
            ],
            "call_count_range": "1 (gate, if mode) + 1-4 (main/tool loop) + 0-1 (rewrite) + 0-1 (level-up)",
        },
        "slash_wuxin_command": {
            "calls": [{"step": 0, "caller": "bot.ts handleOwnerCommand", "llm": "no LLM for routing itself", "note": "/w osu analyze -> analyzer pipeline; other /w deterministic or owner handlers"}],
            "call_count_range": "0 LLM (except analyze pipeline)",
        },
        "osu_analyze": {
            "calls": [
                {"caller": "commands.ts generateAnalysisSectionComments", "llm": "1-3 generation + up to N repair calls", "model": "OSU_ANALYSIS_MODEL deepseek-v4-flash"},
                {"caller": "commands.ts generateConclusion", "llm": "1-3 generation + up to repair", "model": "OSU_ANALYSIS_MODEL"},
                {"caller": "commands.ts reviewFullReport", "llm": "1-2 review calls per report", "model": "OSU_REVIEW_MODEL deepseek-v4-flash"},
                {"caller": "commands.ts applyReviewerHardFallbacks", "llm": "none (deterministic fallback)"},
            ],
            "call_count_range": "4-11 LLM calls typical",
        },
        "memory_group_profile_relationship": {
            "calls": [
                {"caller": "memory.ts maybeUpdateMemoryProfile", "llm": "conditional background"},
                {"caller": "groupProfile.ts", "llm": "conditional background"},
                {"caller": "relationshipProfile.ts", "llm": "conditional background"},
            ],
            "call_count_range": "0-3 background LLM calls per triggering turn",
        },
    },
    "all_llm_call_sites": [
        "server/bot/gate.ts llmReplyGate", "server/bot/gate.ts llmContentFilter",
        "server/bot.ts main callLLM", "server/bots/executor.ts runToolLoop planner/lead/retry",
        "server/bot/reply.ts rewriteNormalReply", "server/bot.ts level-up completeChat",
        "server/osu/commands.ts section/conclusion/repair/review",
        "server/bot/memory.ts profile LLM", "server/bot/groupProfile.ts profile LLM", "server/bot/relationshipProfile.ts profile LLM",
        "server/bot/owner/system.ts summary LLM",
    ],
}
(OUT / "runtime_call_graph.json").write_text(json.dumps(call_graph, ensure_ascii=False, indent=2), encoding="utf-8")

review_metrics = json.loads((OUT / "db_metrics.json").read_text(encoding="utf-8"))
review_metrics["review_decision_graph"] = {
    "trigger": "ENABLE_RUNTIME_LLM_FACT_REVIEW=true AND finalValidation assembled a non-fallback report",
    "model": "OSU_REVIEW_MODEL=deepseek-v4-flash (same model family as generator)",
    "input": "system reviewer rules + knowledgeContext + verified_facts + full assembled report + perspective line",
    "output": "8 verdicts JSON (profile/top/top5/mods/pplus/recent/classification/conclusion)",
    "decision": "hard REJECT -> deterministic fallback for that component; PASS -> verbatim; invalid/unavailable -> log only",
    "rewrite": "NO LLM rewrite; max 2 reviewer attempts only",
    "review_sees_history": False, "review_sees_tools": False, "review_sees_full_report": True,
    "safety_vs_quality": "reviewer prompt restricts to hard facts; quality branch exists in parser but no production quality REJECT observed",
}
(OUT / "review_metrics.json").write_text(json.dumps(review_metrics, ensure_ascii=False, indent=2), encoding="utf-8")

# golden manifest from real DB collections (redacted) + synthetic categories
import os
db = json.loads((Path(os.environ["APPDATA"]) / "Wuxin" / "db.json").read_text(encoding="utf-8"))
import hashlib
def red(s): return "REDACTED_" + hashlib.sha1(str(s).encode()).hexdigest()[:10]
def msg(criteria):
    for m in db.get("messages", [])[::-1]:
        if criteria(m): return m
    return None
def cmd(criteria):
    for c in db.get("commandLogs", [])[::-1]:
        if criteria(c): return c
    return None
def tool(criteria):
    for t in db.get("toolCallLogs", [])[::-1]:
        if criteria(t): return t
    return None
golden = []
def add(case_id, category, source, expected, sensitive):
    golden.append({"case_id": case_id, "source": source, "category": category, "expected_invariant": expected, "sensitive_data_redacted": sensitive})
m = msg(lambda m: m.get("role")=="user" and not m.get("content","").startswith("/") and len(m.get("content",""))<40)
if m: add("normal_chat_real", "normal_chat", {"kind":"db.messages","id":red(m.get("id"))}, "reply is pippi persona, no tool call, no self-negation", True)
m = msg(lambda m: m.get("role")=="user" and ("PP" in m.get("content","") or "bp" in m.get("content","").lower()))
if m: add("osu_lookup_real", "osu_lookup", {"kind":"db.messages","id":red(m.get("id"))}, "osu data question must route to query_osu or deterministic quick command, no invented numbers", True)
t = tool(lambda t: t.get("capability")=="recent" and t.get("ok")==False)
if t: add("tool_failure_real", "tool_failure", {"kind":"db.toolCallLogs","id":red(t.get("id")),"capability":t.get("capability")}, "failure must be surfaced honestly; no fabricated data", True)
t = tool(lambda t: t.get("capability")=="bp_type" and t.get("ok")==True)
if t: add("natural_language_tool_call_real", "natural_language_tool_call", {"kind":"db.toolCallLogs","id":red(t.get("id")),"capability":t.get("capability")}, "natural-language data request executes query_osu before reply; reply uses returned facts", True)
c = cmd(lambda c: c.get("command")=="/w" or c.get("command")=="osu" or (c.get("rawText") or "").startswith("/w"))
if c: add("slash_command_real", "slash_command", {"kind":"db.commandLogs","id":red(c.get("id")),"command":c.get("command"),"status":c.get("status")}, "slash command is deterministic; no normal-chat prompt path", True)
c = cmd(lambda c: str(c.get("userId"))==str(db["settings"].get("ownerQq")))
if c: add("owner_command_real", "owner_command", {"kind":"db.commandLogs","id":red(c.get("id")),"command":c.get("command"),"status":c.get("status")}, "owner command permission enforced by deterministic role gate", True)
a = db.get("osuAnalyses") or []
if a: add("osu_analysis_review_real", "osu_analysis_with_review", {"kind":"db.osuAnalyses","createdAt":a[-1].get("createdAt"),"review": a[-1].get("reviewLog") is not None}, "full analysis passes mechanical gates then independent fact review; hard REJECT downgrades deterministically", True)
add("kb_hit_synthetic", "KB_hit", {"kind":"synthetic","source":"tmp/prompt_review_audit_v01/reconstruct_prompts.mjs"}, "KB injection respects 1500-char quota and source fences", True)
add("kb_miss_synthetic", "KB_miss", {"kind":"synthetic","source":"tmp/prompt_review_audit_v01/reconstruct_prompts.mjs"}, "KB disabled/route none -> no KB block; byte-identical legacy prompt", True)
add("multi_turn_synthetic", "multi_turn", {"kind":"synthetic","source":"reconstruction history"}, "history is timestamped and bounded; assistant/user roles preserved", True)
add("ambiguous_request_synthetic", "ambiguous_request", {"kind":"synthetic","source":"code path: quick-router vs natural chat"}, "ambiguous 查/搜 must not eat osu data intent or named-bot requests", True)
add("review_false_positive_synthetic", "normal_content_that_review_may_false_positive", {"kind":"synthetic","source":"server/bot/reply.ts isWeirdReply"}, "normal long reply >180 chars may trigger rewrite guard; expected invariant is no semantic change", True)
add("sensitive_boundary_synthetic", "genuinely_sensitive_boundary", {"kind":"synthetic","source":"reconstruction case F_serious"}, "serious scene must be handled seriously; safety controls stay", True)
add("persona_heavy_chat_synthetic", "persona-heavy_chat", {"kind":"synthetic","source":"reconstruction case A/G"}, "persona stays pippi without tool misuse or fabricated data", True)
(OUT / "golden_manifest.json").write_text(json.dumps({
    "schema_version": "prompt_review_golden_manifest_v1",
    "purpose": "candidate golden behavior corpus for future A/B slimdown; no expected prose rewritten",
    "case_count": len(golden),
    "category_coverage": sorted(set(g["category"] for g in golden)),
    "cases": golden,
}, ensure_ascii=False, indent=2), encoding="utf-8")

print("ARTIFACTS WRITTEN", sorted(p.name for p in OUT.iterdir()))
