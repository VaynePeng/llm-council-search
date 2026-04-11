import {
  CHAIRMAN_MODEL,
  COUNCIL_MODELS,
  CHAIRMAN_OUTPUT_RESERVE_TOKENS,
  FOLLOWUP_MODEL,
  TITLE_MODEL,
  WEB_SEARCH_ROUTER_MODEL,
  resolveChairmanContextLimit,
} from "./config.js";
import {
  getWebSearchTemporalContext,
  queryModel,
  queryModelStream,
  queryModelsParallel,
  type ChatMessage,
  type QueryOptions,
  type QueryModelsParallelProgress,
  type UrlCitationItem,
} from "./ofox.js";
import { tavilySearch } from "./tavily.js";
import type {
  Message,
  Stage1Item,
  Stage2Item,
  Stage3Result,
  WebFetchResult,
  WebFetchSource,
  WebSearchTask,
} from "./storage.js";

function appendStructuredCitations(
  body: string,
  citations: UrlCitationItem[],
): string {
  if (citations.length === 0) return body;
  const parts = citations.map((c, i) => {
    const title = c.title?.trim();
    const snippet = c.content
      ? `\n   摘录：${
          c.content.length > 400
            ? `${c.content.slice(0, 400)}…`
            : c.content
        }`
      : "";
    const head = title ? `**${title}**` : c.url;
    const linkSuffix = title ? ` — ${c.url}` : "";
    return `${i + 1}. ${head}${linkSuffix}${snippet}`;
  });
  return `${body}\n\n---\n### 检索系统返回的站点与摘录（结构化 URL 引用）\n\n以下条目来自 API 的 \`url_citation\` 标注，可与正文交叉核对。\n\n${parts.join("\n\n")}\n`;
}

export function hasVerifiedWebFetchSources(
  webFetch?: Pick<WebFetchResult, "sources" | "webSearchVerified">,
): boolean {
  if (!webFetch) return false;
  if (webFetch.webSearchVerified === false) return false;
  return Boolean(webFetch.sources?.length);
}

export type CouncilRunOptions = {
  chairmanModel?: string;
  useWebSearch?: boolean;
  webSearchMode?: WebSearchMode;
  /** Override Stage1/Stage2 judge models */
  councilModels?: string[];
  /** Weight of each judge model's vote in Stage2 aggregate (default 1) */
  judgeWeights?: Record<string, number>;
  /** 由前端传入的用户 API Key */
  apiKey?: string;
  /** 由前端传入的用户 Tavily Key */
  tavilyApiKey?: string;
  signal?: AbortSignal;
  historyMessages?: Message[];
  webSearchPlan?: WebSearchPlan;
  filterUntrustedSources?: boolean;
};

export type WebSearchMode = "off" | "auto" | "on";

export type WebSearchPlan = {
  requestedMode: WebSearchMode;
  action: "skip" | "search" | "reuse";
  reason: string;
  previousWebFetch?: WebFetchResult;
};

export type StreamProgress = {
  phase: "web_plan" | "web_fetch" | "stage1" | "stage2" | "stage3" | "followup";
  message: string;
  current?: number;
  total?: number;
  model?: string;
  query?: string;
  searchTasks?: WebSearchTask[];
  analysisOnly?: string[];
};

type ProgressCallback = (event: StreamProgress) => void;

type WebSearchPlanAction = WebSearchPlan["action"];

const MAX_CONTEXT_ROUNDS = 6;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_USER_CONTEXT_CHARS = 700;
const MAX_ASSISTANT_CONTEXT_CHARS = 1_400;
const WEB_SOURCE_DISCIPLINE = `Source discipline:
- If you use any information obtained from web retrieval, you MUST label it with both:
  1. a source name (article title, page title, site name, organization name, or domain name when nothing better is available);
  2. a directly reachable source URL to the exact page.
- Source name and source URL are both required. Do not cite web-retrieved material with only one of them.
- If you cannot provide both the source name and the exact source URL, do not present that web-retrieved material as a sourced claim.
- Prefer Markdown links whose anchor text is the source name, for example [OpenAI API docs](https://...).`;

function clipText(text: string, maxChars: number): string {
  const s = text.trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1))}…`;
}

function normalizeForIntent(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function sourceHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function classifySourceType(url: string, title?: string): {
  sourceType: string;
  credibility: "high" | "medium" | "low";
  credibilityScore: number;
  referenceWeight: number;
  referenceWeightRaw: number;
  credibilityReason: string;
} {
  const host = sourceHostname(url);
  const text = `${host} ${title ?? ""}`.toLowerCase();

  if (
    /(^|\.)gov(\.|$)|(^|\.)edu(\.|$)|(^|\.)mil(\.|$)/.test(host) ||
    /docs|developer|documentation|manual|reference|api/.test(text)
  ) {
    return {
      sourceType: "官方/文档",
      credibility: "high",
      credibilityScore: 0.95,
      referenceWeight: 9.5,
      referenceWeightRaw: 95,
      credibilityReason: "官方站点、政府/教育机构或正式文档，通常可直接作为一手来源。",
    };
  }

  if (/(wikipedia|wiktionary)\.org$/.test(host)) {
    return {
      sourceType: "百科",
      credibility: "medium",
      credibilityScore: 0.62,
      referenceWeight: 6.2,
      referenceWeightRaw: 62,
      credibilityReason: "可作线索，但通常不是最终采信的一手来源。",
    };
  }

  if (
    /(reddit\.com|x\.com|twitter\.com|weibo\.com|quora\.com|zhihu\.com|news\.ycombinator\.com|stack(over|exchange)\.com|v2ex\.com|lobste\.rs|discuss|forum|community|bbs)/.test(
      text,
    )
  ) {
    return {
      sourceType: "论坛/社区",
      credibility: "low",
      credibilityScore: 0.2,
      referenceWeight: 2,
      referenceWeightRaw: 20,
      credibilityReason: "社区讨论或评论内容缺少稳定审校流程，适合补充线索，不宜直接采信。",
    };
  }

  if (
    /(reuters\.com|apnews\.com|bloomberg\.com|ft\.com|wsj\.com|nytimes\.com|theverge\.com|techcrunch\.com|bbc\.)/.test(
      host,
    )
  ) {
    return {
      sourceType: "媒体",
      credibility: "high",
      credibilityScore: 0.82,
      referenceWeight: 8.2,
      referenceWeightRaw: 82,
      credibilityReason: "成熟媒体有编辑流程，但仍属二手来源，应优先与一手来源交叉核对。",
    };
  }

  if (/(blog|medium\.com|substack\.com|ghost\.io)/.test(text)) {
    return {
      sourceType: "博客",
      credibility: "medium",
      credibilityScore: 0.48,
      referenceWeight: 4.8,
      referenceWeightRaw: 48,
      credibilityReason: "博客通常缺少正式审校，应结合一手来源核验。",
    };
  }

  return {
    sourceType: "网页",
    credibility: "medium",
    credibilityScore: 0.6,
    referenceWeight: 6,
    referenceWeightRaw: 60,
    credibilityReason: "普通网页来源可信度中等，需要结合具体内容与出处判断。",
  };
}

function normalizeReferenceWeight(weight?: number): number | undefined {
  if (weight == null || !Number.isFinite(weight)) return undefined;
  const normalized = weight > 10 ? weight / 10 : weight;
  return Math.round(normalized * 10) / 10;
}

function formatReferenceWeight(weight?: number): string {
  const normalized = normalizeReferenceWeight(weight);
  if (normalized == null) return "?/10";
  return `${Number.isInteger(normalized) ? normalized.toFixed(0) : normalized.toFixed(1)}/10`;
}

function enrichAndSortSources(
  sources: WebFetchSource[],
  filterUntrustedSources = false,
): WebFetchSource[] {
  const enriched = sources.map((source) => {
    const meta = classifySourceType(source.url, source.title);
    const filteredOut =
      filterUntrustedSources &&
      (meta.credibility === "low" || meta.sourceType === "论坛/社区");
    return {
      ...source,
      ...meta,
      referenceWeight: normalizeReferenceWeight(
        source.referenceWeight ?? meta.referenceWeight,
      ),
      filteredOut,
    } satisfies WebFetchSource;
  });

  enriched.sort(
    (a, b) => (b.credibilityScore ?? 0) - (a.credibilityScore ?? 0),
  );

  return filterUntrustedSources
    ? enriched.filter((source) => !source.filteredOut)
    : enriched;
}

function formatCredibilityForPrompt(sources: WebFetchSource[]): string {
  if (sources.length === 0) return "";
  const lines = sources.map((source, index) => {
    return `${index + 1}. ${source.title ?? source.url} | ${source.sourceType ?? "网页"} | 参考权重 ${formatReferenceWeight(source.referenceWeight)} | 可信度 ${source.credibility ?? "medium"} | ${source.url} | ${source.credibilityReason ?? ""}`;
  });
  return [
    "### 结构化来源可信度（供后续模型判断优先级）",
    "",
    "以下可信度是服务端基于来源类型的启发式排序，采用 0-10 分制，目的是帮助你优先参考官方/一手来源，避免论坛评论等低可信材料：",
    "",
    ...lines,
    "",
  ].join("\n");
}

function extractConversationRounds(messages: Message[]) {
  const rounds: Array<{ user: string; assistant?: string }> = [];
  let pendingUser: string | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      pendingUser = msg.content;
      continue;
    }
    if (!pendingUser) continue;
    rounds.push({
      user: pendingUser,
      assistant: msg.stage3?.response,
    });
    pendingUser = null;
  }

  if (pendingUser) rounds.push({ user: pendingUser });
  return rounds;
}

function recentConversationMessages(messages: Message[]): Message[] {
  const picked = messages.slice(-(MAX_CONTEXT_ROUNDS * 2));
  return picked.filter((msg) => {
    if (msg.role === "user") return Boolean(msg.content?.trim());
    return Boolean(msg.stage3?.response?.trim());
  });
}

export function buildConversationContext(messages: Message[]): string | undefined {
  const rounds = extractConversationRounds(messages);
  if (rounds.length === 0) return undefined;

  const picked = rounds.slice(-MAX_CONTEXT_ROUNDS);
  const lines = picked.flatMap((round, idx) => {
    const out = [
      `[Round ${idx + 1}]`,
      `User: ${clipText(round.user, MAX_USER_CONTEXT_CHARS)}`,
    ];
    if (round.assistant?.trim()) {
      out.push(
        `Assistant: ${clipText(round.assistant, MAX_ASSISTANT_CONTEXT_CHARS)}`,
      );
    }
    return out.concat("");
  });
  const text = lines.join("\n").trim();
  if (!text) return undefined;
  return clipText(text, MAX_CONTEXT_CHARS);
}

export function composeEffectiveUserQuery(
  userQuery: string,
  messages: Message[],
): string {
  const context = buildConversationContext(messages);
  if (!context) return userQuery;
  return [
    "以下是同一会话中与当前提问相关的历史上下文，仅在相关时参考：",
    "",
    context,
    "",
    "当前用户问题：",
    userQuery,
  ].join("\n");
}

function latestWebFetch(messages: Message[]): WebFetchResult | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.webFetch?.content?.trim() && hasVerifiedWebFetchSources(msg.webFetch)) return msg.webFetch;
  }
  return undefined;
}

function isContextualFollowUp(text: string): boolean {
  const t = normalizeForIntent(text);
  if (t.length <= 32) return true;
  return /^(那|那么|这个|这个问题|它|他|她|其|继续|还有|然后|再|why|how|what about|and )/.test(t);
}

function needsFreshSearch(text: string): boolean {
  const t = normalizeForIntent(text);
  return /(今天|今日|目前|现在|当前|最近|最新|刚刚|截至|官网|公告|新闻|股价|价格|汇率|版本|发布|更新|政策|比赛|结果|as of|today|now|current|latest|recent|news|price|stock|release|update|policy|result)/.test(
    t,
  );
}

function asksToSearch(text: string): boolean {
  const t = normalizeForIntent(text);
  return /(查一下|查查|搜一下|搜索|检索|联网|核实|验证|来源|文档|官网|reference|source|citation|search|look up|verify)/.test(
    t,
  );
}

function isLocalOnlyFollowUp(text: string): boolean {
  const t = normalizeForIntent(text);
  return /^(为什么|怎么|如何|展开|详细|具体|总结|概括|翻译|润色|改写|对比|比较|解释|举例|什么意思|原因|依据|再详细说说|explain|summarize|translate|rewrite|compare|why|how)/.test(
    t,
  );
}

export function parseWebSearchMode(
  mode?: string,
  fallbackBoolean?: boolean,
): WebSearchMode {
  const v = mode?.trim().toLowerCase();
  if (v === "off" || v === "auto" || v === "on") return v;
  return fallbackBoolean ? "on" : "off";
}

function decideWebSearchPlanByRules(
  userQuery: string,
  messages: Message[],
  requestedMode: WebSearchMode,
): WebSearchPlan {
  if (requestedMode === "off") {
    return {
      requestedMode,
      action: "skip",
      reason: "已关闭联网搜索。",
    };
  }

  if (requestedMode === "on") {
    return {
      requestedMode,
      action: "search",
      reason: "已强制开启联网搜索。",
    };
  }

  const previous = latestWebFetch(messages);
  const contextual = isContextualFollowUp(userQuery);
  const fresh = needsFreshSearch(userQuery);
  const explicitSearch = asksToSearch(userQuery);
  const localOnly = isLocalOnlyFollowUp(userQuery);

  if (fresh || explicitSearch) {
    return {
      requestedMode,
      action: "search",
      reason: fresh
        ? "检测到时效性或外部事实核验需求，自动联网。"
        : "检测到明确检索/核实意图，自动联网。",
    };
  }

  if (contextual && previous && !previous.webSearchSkipped) {
    return {
      requestedMode,
      action: "reuse",
      reason: "当前问题是基于前文的追问，复用上一轮检索结果。",
      previousWebFetch: previous,
    };
  }

  if (localOnly || contextual) {
    return {
      requestedMode,
      action: "skip",
      reason: "当前问题可直接基于会话上下文回答，无需联网。",
    };
  }

  return {
    requestedMode,
    action: "skip",
    reason: "未检测到明显的实时信息或外部核验需求。",
  };
}

function parseFirstJsonObject(text: string): Record<string, unknown> | null {
  const direct = text.trim();
  try {
    return JSON.parse(direct) as Record<string, unknown>;
  } catch {
    /* ignore */
  }

  const match = direct.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function latestWebFetchSummary(webFetch?: WebFetchResult): string {
  if (!webFetch) return "无";
  const summary = clipText(webFetch.content, 900);
  return [
    `模型: ${webFetch.model}`,
    `检索时刻: ${webFetch.retrievedAt ?? "未知"}`,
    `是否跳过联网: ${webFetch.webSearchSkipped ? "是" : "否"}`,
    `摘要: ${summary}`,
  ].join("\n");
}

function normalizePlannedAction(
  raw: unknown,
  previous?: WebFetchResult,
): WebSearchPlanAction | null {
  if (typeof raw !== "string") return null;
  const action = raw.trim().toLowerCase();
  if (action === "skip" || action === "search") return action;
  if (action === "reuse") {
    return previous && !previous.webSearchSkipped && hasVerifiedWebFetchSources(previous) ? "reuse" : "search";
  }
  return null;
}

export async function decideWebSearchPlan(
  userQuery: string,
  messages: Message[],
  requestedMode: WebSearchMode,
  apiKey?: string,
  signal?: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<WebSearchPlan> {
  if (requestedMode !== "auto") {
    const plan = decideWebSearchPlanByRules(userQuery, messages, requestedMode);
    onProgress?.({
      phase: "web_plan",
      message:
        plan.action === "search"
          ? "已根据设置直接执行联网检索。"
          : plan.action === "reuse"
            ? "已根据设置直接复用上轮联网检索。"
            : "已根据设置关闭联网检索。",
    });
    return plan;
  }

  const previous = latestWebFetch(messages);
  const conversationContext = buildConversationContext(messages) ?? "(无历史上下文)";
  const routerPrompt = [
    "你是一个联网检索路由器。你的任务只是在 `skip`、`search`、`reuse` 三者中做决策。",
    "",
    "规则：",
    "- `skip`: 当前问题可直接基于已有对话回答，不需要联网。",
    "- `search`: 当前问题需要新的联网搜索，例如最新信息、价格、政策、版本、新闻、公告、事实核验。",
    "- `reuse`: 当前问题是基于前文追问，可以直接复用上一轮检索结果，不必重新搜索。",
    "- 如果没有可复用的上一轮检索结果，不允许输出 `reuse`。",
    "- 你必须优先考虑多轮语义，而不是只看当前一句话。",
    "- 只输出 JSON，不要输出 markdown，不要解释。",
    "",
    "输出格式：",
    '{"action":"skip|search|reuse","reason":"一句简短中文原因"}',
    "",
    "当前用户问题：",
    userQuery,
    "",
    "会话历史上下文：",
    conversationContext,
    "",
    "最近一轮可复用检索结果：",
    latestWebFetchSummary(previous),
  ].join("\n");

  try {
    onProgress?.({
      phase: "web_plan",
      message: "主席模型正在判断本轮是否需要联网，以及是否复用上轮检索。",
    });
    const response = await queryModel(
      WEB_SEARCH_ROUTER_MODEL,
      [{ role: "user", content: routerPrompt }],
      {
        timeoutMs: 12_000,
        apiKey,
        signal,
      },
    );
    const parsed = parseFirstJsonObject(response?.content ?? "");
    const action = normalizePlannedAction(parsed?.action, previous);
    const reason =
      typeof parsed?.reason === "string" ? parsed.reason.trim() : "";

    if (action && reason) {
      onProgress?.({
        phase: "web_plan",
        message:
          action === "search"
            ? "已决定执行新的联网检索。"
            : action === "reuse"
              ? "已决定复用上一轮联网检索结果。"
              : "已决定跳过联网检索。",
      });
      return {
        requestedMode,
        action,
        reason,
        ...(action === "reuse" && previous ? { previousWebFetch: previous } : {}),
      };
    }
  } catch (err) {
    // 只有外部 signal 主动取消时才向上抛；本地超时触发的 AbortError 应 fallback 到规则
    if ((err as { name?: string })?.name === "AbortError" && signal?.aborted) throw err;
    console.warn("[web-search-router] model decision failed, fallback to rules:", err);
  }

  const fallback = decideWebSearchPlanByRules(userQuery, messages, requestedMode);
  onProgress?.({
    phase: "web_plan",
    message:
      fallback.action === "search"
        ? "联网决策模型不可用，已按规则回退为重新检索。"
        : fallback.action === "reuse"
          ? "联网决策模型不可用，已按规则回退为复用上轮结果。"
          : "联网决策模型不可用，已按规则回退为跳过联网。",
  });
  return fallback;
}

function queryOpts(useWebSearch?: boolean, apiKey?: string): QueryOptions {
  void useWebSearch;
  return { apiKey };
}

function normalizeSearchTasks(raw: unknown): WebSearchTask[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const rec = item as { query?: unknown; why?: unknown };
      const query = typeof rec.query === "string" ? rec.query.trim() : "";
      const why = typeof rec.why === "string" ? rec.why.trim() : "";
      if (!query) return null;
      return { query, why: why || "用于核验问题中的外部事实。" };
    })
    .filter((item): item is WebSearchTask => Boolean(item))
    .slice(0, 5);
}

type TavilyCollectedSource = WebFetchSource & {
  query: string;
  publishedDate?: string;
};

function dedupeTavilySources(
  sources: TavilyCollectedSource[],
  filterUntrustedSources: boolean,
): WebFetchSource[] {
  const seen = new Set<string>();
  const unique = sources.filter((source) => {
    const key = source.url.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return enrichAndSortSources(unique, filterUntrustedSources);
}

export async function stageWebFetch(
  userQuery: string,
  chairmanModelOverride?: string,
  apiKey?: string,
  tavilyApiKey?: string,
  signal?: AbortSignal,
  plan?: WebSearchPlan,
  filterUntrustedSources = false,
  onProgress?: ProgressCallback,
): Promise<WebFetchResult> {
  const model = chairmanModelOverride?.trim() || CHAIRMAN_MODEL;
  const t = getWebSearchTemporalContext();
  const planningPrompt = [
    "你负责规划联网检索，但不能亲自搜索。",
    `当前检索时间锚点（UTC）：${t.isoUtc}；Unix ${t.unixSeconds}。`,
    "请先分析用户问题，把真正需要外部检索核验的部分拆成少量搜索任务。",
    "不要回答原问题，不要给结论，不要输出 markdown。",
    "只输出 JSON，格式如下：",
    '{"search_tasks":[{"query":"搜索词","why":"为什么查"}],"analysis_only":["无需联网的分析项"]}',
    "要求：",
    "- search_tasks 最多 5 个，尽量覆盖必须核验的事实点。",
    "- 对于时效性问题，把时间锚点写进 query。",
    "- 如果问题几乎都不需要联网，允许 search_tasks 为空。",
    "",
    "用户问题：",
    userQuery,
  ].join("\n");

  onProgress?.({
    phase: "web_fetch",
    message: "主席模型正在拆解需要联网核验的事实点。",
    model,
  });
  const planningResponse = await queryModel(
    model,
    [{ role: "user", content: planningPrompt }],
    { timeoutMs: 45_000, apiKey, signal },
  );

  const planningJson = parseFirstJsonObject(planningResponse?.content ?? "");
  const searchTasks = normalizeSearchTasks(planningJson?.search_tasks);
  const analysisOnly = Array.isArray(planningJson?.analysis_only)
    ? planningJson.analysis_only
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
        .slice(0, 8)
    : [];

  onProgress?.({
    phase: "web_fetch",
    message:
      searchTasks.length > 0
        ? `websearch 已产出 ${searchTasks.length} 个需要搜索的指标。`
        : "websearch 未产出可执行搜索指标。",
    model,
    searchTasks,
    analysisOnly,
  });

  if (searchTasks.length === 0) {
    onProgress?.({
      phase: "web_fetch",
      message: "主席模型判断本轮没有必须交给 Tavily 的检索任务。",
      model,
    });
    return {
      model,
      content: [
        "## 联网检索范围",
        "- 主席模型判断当前问题没有明确必须联网核验的事实点，或现有问题主要是分析/解释任务。",
        ...(analysisOnly.length
          ? analysisOnly.map((item) => `- 留给后续模型处理：${item}`)
          : ["- 留给后续模型处理：分析、解释、比较、总结与结论生成。"]),
        "",
        "## 检索摘要",
        "本轮未实际调用 Tavily，因为主席模型未生成有效搜索任务。",
        "",
        "## 参考来源",
        "无",
      ].join("\n"),
      webSearchMode: plan?.requestedMode,
      webSearchAction: plan?.action ?? "search",
      webSearchReason: plan?.reason,
      webSearchVerified: false,
      webSearchWarning: "主席模型未生成可执行的 Tavily 搜索任务，本轮没有结构化联网来源。",
      retrievedAt: t.isoUtc,
      retrievedAtUnixSeconds: t.unixSeconds,
      searchTasks,
      analysisOnly,
    };
  }

  onProgress?.({
    phase: "web_fetch",
    message: `已生成 ${searchTasks.length} 个 Tavily 检索任务，开始抓取公开网页。`,
    current: 0,
    total: searchTasks.length,
    model,
  });

  let finishedSearches = 0;
  const tavilyRuns = await Promise.all(
    searchTasks.map(async (task) => {
      onProgress?.({
        phase: "web_fetch",
        message: `Tavily 检索：${task.query}`,
        current: finishedSearches,
        total: searchTasks.length,
        query: task.query,
      });
      let results: Awaited<ReturnType<typeof tavilySearch>> = [];
      try {
        results = await tavilySearch(task.query, {
          apiKey: tavilyApiKey ?? "",
          maxResults: 5,
          signal,
        });
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") throw e;
        console.error(`Tavily search failed for query "${task.query}":`, e);
      }
      finishedSearches += 1;
      onProgress?.({
        phase: "web_fetch",
        message: `Tavily 已完成 ${finishedSearches}/${searchTasks.length} 个检索任务。`,
        current: finishedSearches,
        total: searchTasks.length,
        query: task.query,
      });
      return { task, results };
    }),
  );

  const flattenedSources = tavilyRuns.flatMap(({ task, results }) =>
    results.map((item) => ({
      url: item.url,
      title: item.title,
      snippet: item.content,
      query: task.query,
      publishedDate: item.published_date,
      referenceWeight: item.score != null ? Math.round(item.score * 10) / 10 : undefined,
    })),
  );
  const sources = dedupeTavilySources(flattenedSources, filterUntrustedSources);
  const credibilityBlock = sources.length ? formatCredibilityForPrompt(sources) : "";

  const rawResultsBlock = tavilyRuns
    .map(({ task, results }, index) => {
      const lines = results.length
        ? results.map((item, itemIndex) =>
            [
              `${itemIndex + 1}. 标题: ${item.title ?? item.url}`,
              `   URL: ${item.url}`,
              `   可见日期: ${item.published_date ?? "未标明"}`,
              `   摘要: ${clipText(item.content ?? "", 500) || "无"}`,
            ].join("\n"),
          )
        : ["(无结果)"];
      return [
        `### 搜索任务 ${index + 1}`,
        `- 查询: ${task.query}`,
        `- 目的: ${task.why}`,
        ...lines,
      ].join("\n");
    })
    .join("\n\n");

  const synthesisPrompt = [
    "你是主席模型。你已经完成了“问题分析”，现在只基于 Tavily 返回的结果整理一份中立的联网检索 dossier。",
    "注意：真正的搜索已经由 Tavily 完成，你不能声称自己又搜索到了别的页面，也不能捏造来源。",
    `检索时间锚点（UTC）：${t.isoUtc}；Unix ${t.unixSeconds}。`,
    "输出要求：",
    "- 不回答用户的最终问题。",
    "- 只整理需要联网的部分、来源、已检索到的事实、冲突与缺口。",
    "- 每个外部事实都要带来源名称和精确 URL。",
    `- ${filterUntrustedSources ? "低可信论坛/社区来源已由调用方过滤，必要时只说明被过滤。" : "若使用社区/论坛来源，必须明确标成低可信。"} `,
    "- 使用简体中文，使用 Markdown。",
    "",
    "输出结构：",
    "## 联网检索范围",
    "## 检索摘要",
    "## 来源清单",
    "## 检索到的事实",
    "## 冲突与缺口",
    "## 参考来源",
    "",
    "无需联网、留给后续模型处理的项目：",
    ...(analysisOnly.length ? analysisOnly.map((item) => `- ${item}`) : ["- 分析、解释、总结、比较与最终结论。"]),
    "",
    "Tavily 搜索任务与结果：",
    rawResultsBlock,
    "",
    WEB_SOURCE_DISCIPLINE,
  ].join("\n");

  onProgress?.({
    phase: "web_fetch",
    message: "主席模型正在整理 Tavily 返回结果，生成联网 dossier。",
    model,
  });
  let synthesisResponse: Awaited<ReturnType<typeof queryModel>> | null = null;
  let synthesisFallbackWarning: string | undefined;
  try {
    synthesisResponse = await queryModel(
      model,
      [{ role: "user", content: synthesisPrompt }],
      { timeoutMs: 90_000, apiKey, signal },
    );
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError" && signal?.aborted) {
      throw err;
    }
    synthesisFallbackWarning = "主席模型整理 Tavily 结果失败，已回退为原始检索摘要。";
    onProgress?.({
      phase: "web_fetch",
      message: "主席模型整理检索结果失败，已回退为原始检索摘要。",
      model,
    });
  }

  const fallbackContent = [
    "## 联网检索范围",
    ...(analysisOnly.length
      ? analysisOnly.map((item) => `- 留给后续模型处理：${item}`)
      : ["- 留给后续模型处理：分析、解释、比较、总结与结论生成。"]),
    "",
    "## 检索摘要",
    "主席模型未成功整理 dossier，以下保留 Tavily 原始检索摘要。",
    "",
    rawResultsBlock,
    "",
    "## 来源清单",
    ...(sources.length
      ? sources.map((source, index) => `${index + 1}. [${source.title?.trim() || source.url}](${source.url})`)
      : ["无"]),
    "",
    "## 冲突与缺口",
    "- 需要由后续模型基于以上结果继续归纳、交叉核验与作答。",
    "",
    "## 参考来源",
    ...(sources.length
      ? sources.map((source) => `- [${source.title?.trim() || source.url}](${source.url})`)
      : ["无"]),
  ].join("\n");

  const content = synthesisResponse?.content?.trim() || fallbackContent;
  const verified = Boolean(sources.length);
  const warning = synthesisFallbackWarning
    ?? (verified
      ? undefined
      : "Tavily 本次未返回可排序的结构化来源，本轮仅保留检索摘要，不向后续阶段传递联网证据。");

  return {
    model,
    content: `${content}${credibilityBlock ? `\n\n---\n${credibilityBlock}` : ""}`,
    webSearchMode: plan?.requestedMode,
    webSearchAction: plan?.action ?? "search",
    webSearchReason: plan?.reason,
    webSearchVerified: verified,
    ...(warning ? { webSearchWarning: warning } : {}),
    webSearchSkipped: false,
    retrievedAt: t.isoUtc,
    retrievedAtUnixSeconds: t.unixSeconds,
    searchTasks,
    analysisOnly,
    ...(sources.length ? { sources } : {}),
  };
}

export type WebRetrievalMeta = { isoUtc: string; unixSeconds: number };

export async function stage1CollectResponses(
  userQuery: string,
  useWebSearch?: boolean,
  webContext?: string,
  webRetrievalMeta?: WebRetrievalMeta,
  apiKey?: string,
  signal?: AbortSignal,
  councilModels: string[] = COUNCIL_MODELS,
  onProgress?: ProgressCallback,
): Promise<Stage1Item[]> {
  let userContent = userQuery;
  if (webContext) {
    const clock =
      webRetrievalMeta != null
        ? `Retrieval instant (UTC only; do not assume end-user local timezone): **${webRetrievalMeta.isoUtc}** · Unix **${webRetrievalMeta.unixSeconds}** s\n\n`
        : "";
    userContent = `The following web search results have been gathered for context. They may include structured URL citations with snippets.

Important: this web stage was instructed to retrieve only the parts that truly needed web access and to leave analysis, explanation, comparison, and final judgment to you. Treat it as raw retrieval material, not as a final answer or authority.

Trust policy: Prefer claims backed by official or first-party documentation, regulated bodies, and established news organizations. Use the web material as evidence, but make your own judgment instead of inheriting conclusions from the retrieval stage.

Citation rule:
- **Inline citation (MANDATORY)**: Every time you state a fact from the web retrieval context, annotate it inline with a clickable Markdown link right after the claim. Use the format: "事实描述（[信息来源���来源名称](https://exact-url)）". For example: "目前中国人口约14亿（[信息来源：国家统计局](https://www.stats.gov.cn/...)）".
- You MUST provide both the source name and the exact source URL together. A bare URL without a source name, or a source name without the exact URL, is not acceptable.
- Do not use vague attributions such as "according to media reports", "消息来源", "Reuters", "Bloomberg", "official sources", "some article", or only a site/domain name without the specific page URL.
- If the web context mentions a source but you cannot point to the exact URL, do not present it as a sourced third-party citation. Either omit the citation or explicitly say the exact source link is unavailable.
- Use the exact article/page title when possible; otherwise use a short descriptive label.

${clock}---

${webContext}

---

Based on the above web context plus your own knowledge where appropriate, answer the following question:

${userQuery}`;
  } else {
    userContent = `Answer the following question.

Citation rule:
- **Inline citation (MANDATORY)**: Every time you state a fact from an external source, annotate it inline with a clickable Markdown link right after the claim. Use the format: "事实描述（[信息来��：来源名称](https://exact-url)）". For example: "目前中国人口约14亿（[信息来源：国家统计局](https://www.stats.gov.cn/...)）".
- You MUST provide both the source name and the exact source URL together. A bare URL without a source name, or a source name without the exact URL, is not acceptable.
- Do not use vague attributions such as "according to media reports", "消息来源", "Reuters", "Bloomberg", "official sources", "some article", or only a site/domain name without the specific page URL.
- If you do not have the exact URL, do not present it as a sourced third-party citation. Either answer without that citation or explicitly say you cannot verify the exact source link.
- Use the exact article/page title when possible; otherwise use a short descriptive label.

Question:
${userQuery}`;
  }

  const messages: ChatMessage[] = [{ role: "user", content: userContent }];
  const opts = webContext ? { apiKey, signal } : { ...queryOpts(useWebSearch, apiKey), signal };
  const responses = await queryModelsParallel(councilModels, messages, {
    ...opts,
    onProgress: (event: QueryModelsParallelProgress) => {
      onProgress?.({
        phase: "stage1",
        message:
          event.status === "start"
            ? `Stage 1：正在请求 ${event.model}`
            : event.status === "complete"
              ? `Stage 1：已收到 ${event.model}（${event.current}/${event.total}）`
              : `Stage 1：${event.model} 请求失败（${event.current}/${event.total}）`,
        current: event.current,
        total: event.total,
        model: event.model,
      });
    },
  });

  const stage1: Stage1Item[] = [];
  for (const [model, response] of responses) {
    if (response != null) {
      stage1.push({
        model,
        response: response.content ?? "",
        webSearchSkipped: response.webSearchSkipped,
      });
      continue;
    }

    stage1.push({
      model,
      response: "(request failed)",
      failed: true,
      error: "This model failed to respond. Please retry this model.",
    });
  }
  return stage1;
}

export function successfulStage1Items(stage1Results: Stage1Item[]): Stage1Item[] {
  return stage1Results.filter((item) => !item.failed);
}

export async function stage2CollectRankings(
  userQuery: string,
  stage1Results: Stage1Item[],
  useWebSearch?: boolean,
  apiKey?: string,
  signal?: AbortSignal,
  councilModels: string[] = COUNCIL_MODELS,
  onProgress?: ProgressCallback,
): Promise<[Stage2Item[], Record<string, string>]> {
  const successfulStage1 = successfulStage1Items(stage1Results);
  const labels = successfulStage1.map((_, i) => String.fromCharCode(65 + i));

  const labelToModel: Record<string, string> = {};
  for (let i = 0; i < labels.length; i++) {
    labelToModel[`Response ${labels[i]}`] = successfulStage1[i].model;
  }

  const responsesText = successfulStage1
    .map(
      (r, i) =>
        `Response ${labels[i]}:\n${r.response}`,
    )
    .join("\n\n");

  const rankingPrompt = `You are evaluating different responses to the following question:

Question: ${userQuery}

Here are the responses from different models (anonymized):

${responsesText}

Important: Each anonymized response is plain text produced in Stage 1. Evaluate only what is written in the text; do not assume live web facts or citations beyond what appears there.

Your task:
1. First, evaluate each response individually. For each response, explain what it does well and what it does poorly.
2. Then, at the very end of your response, provide a final ranking.

IMPORTANT: Your final ranking MUST be formatted EXACTLY as follows:
- Start with the line "FINAL RANKING:" (all caps, with colon)
- Then list the responses from best to worst as a numbered list
- Each line should be: number, period, space, then ONLY the response label (e.g., "1. Response A")
- Do not add any other text or explanations in the ranking section

Example of the correct format for your ENTIRE response:

Response A provides good detail on X but misses Y...
Response B is accurate but lacks depth on Z...
Response C offers the most comprehensive answer...

FINAL RANKING:
1. Response C
2. Response A
3. Response B

Now provide your evaluation and ranking:`;

  const messages: ChatMessage[] = [{ role: "user", content: rankingPrompt }];
  const responses = await queryModelsParallel(
    councilModels,
    messages,
    {
      ...queryOpts(useWebSearch, apiKey),
      signal,
      onProgress: (event: QueryModelsParallelProgress) => {
        onProgress?.({
          phase: "stage2",
          message:
            event.status === "start"
              ? `Stage 2：正在请求 ${event.model} 进行评审排序`
              : event.status === "complete"
                ? `Stage 2：已收到 ${event.model} 的排序（${event.current}/${event.total}）`
                : `Stage 2：${event.model} 评审失败（${event.current}/${event.total}）`,
          current: event.current,
          total: event.total,
          model: event.model,
        });
      },
    },
  );

  const stage2: Stage2Item[] = [];
  for (const [model, response] of responses) {
    if (response != null) {
      const fullText = response.content ?? "";
      stage2.push({
        model,
        ranking: fullText,
        parsed_ranking: parseRankingFromText(fullText),
      });
    }
  }

  return [stage2, labelToModel];
}

function judgeWeight(
  judgeModel: string,
  judgeWeights?: Record<string, number>,
): number {
  const raw = judgeWeights?.[judgeModel];
  const n = raw == null ? 1 : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

export function formatAggregateRankingSummary(
  aggregate: AggregateRanking[],
  judgeWeights?: Record<string, number>,
): string {
  if (!aggregate.length) return "(No aggregate ranking could be computed.)";
  const weighted =
    judgeWeights &&
    Object.values(judgeWeights).some((v) => v != null && Number(v) !== 1);
  const header = weighted
    ? "Weighted aggregate (lower average rank is better; judge weights applied):"
    : "Aggregate ranking (lower average rank is better):";
  const lines = aggregate.map(
    (r, i) =>
      `${i + 1}. ${r.model} — avg rank ${r.average_rank} (${r.rankings_count} judge(s))`,
  );
  return `${header}\n${lines.join("\n")}`;
}

function buildChairmanUserContent(
  userQuery: string,
  stage1Results: Stage1Item[],
  stage2Results: Stage2Item[],
  judgeWeights?: Record<string, number>,
  labelToModel?: Record<string, string>,
  webFetchSources?: WebFetchSource[],
): string {
  const stage1Text = stage1Results
    .map((r) => `Model: ${r.model}\nResponse: ${r.response}`)
    .join("\n\n");

  const stage2Text = stage2Results
    .map((r) => `Model: ${r.model}\nRanking: ${r.ranking}`)
    .join("\n\n");

  let aggregateSection = "";
  if (labelToModel && stage2Results.length) {
    const agg = calculateAggregateRankings(
      stage2Results,
      labelToModel,
      judgeWeights,
    );
    aggregateSection = `\n\nAGGREGATE RANKING SUMMARY:\n${formatAggregateRankingSummary(agg, judgeWeights)}`;
  }

  let webSourcesSection = "";
  if (webFetchSources?.length) {
    const sourceLines = webFetchSources.map((s, i) =>
      `${i + 1}. [${s.title?.trim() || s.url}](${s.url})${s.snippet ? ` — ${clipText(s.snippet, 200)}` : ""}`,
    );
    webSourcesSection = `\n\nWEB RETRIEVAL SOURCES (from the web search stage — use these URLs when citing):\n${sourceLines.join("\n")}`;
  }

  return `You are the Chairman of a multi-model deliberation: several AI models responded to the user's question and ranked each other's responses.

Original Question: ${userQuery}

STAGE 1 - Individual Responses:
${stage1Text}

STAGE 2 - Peer Rankings:
${stage2Text}
${aggregateSection}
${webSourcesSection}

Your task as Chairman is to synthesize all of this information into a single, comprehensive, accurate answer to the user's original question. Consider:
- The individual responses and their insights
- The peer rankings and what they reveal about response quality
- Any patterns of agreement or disagreement
- The aggregate ranking summary when present (it reflects peer evaluation${judgeWeights && Object.keys(judgeWeights).length ? ", weighted by configured judge importance" : ""})

Citation rule:
- **Inline citation (MANDATORY)**: Every time you state a fact that came from web retrieval or a third-party source, you MUST annotate it inline in the prose with a clickable Markdown link right after the claim. Use the format: "事实描述（[信息来源：来源名称](https://exact-url)）". For example: "目前中国人口约14亿（[信息来源：国家统计局](https://www.stats.gov.cn/...)）".
- If your final answer uses any information that originated from web retrieval, you MUST present both the source name and the exact source URL together. A bare URL without a source name, or a source name without the exact URL, is not acceptable.
- Do not write vague source labels such as "媒体报道", "有消息称", "Reuters", "Bloomberg", "官方消息", or only a homepage/domain unless you are specifically citing that exact homepage page.
- If Stage 1 responses mention a source but do not provide a concrete URL, treat that citation as unsupported and do not repeat it as a sourced claim unless you can provide the exact link yourself.
- If no exact URL is available, either omit the third-party citation or explicitly state that the exact source link is unavailable.
- Use the exact article/page title when possible; otherwise use a short descriptive label.
- If WEB RETRIEVAL SOURCES are provided above, prefer those exact URLs for citations.
- **MANDATORY**: You MUST end your answer with a "## 参考来源" section listing ALL sources you cited in the body, formatted as clickable Markdown links. Example: \`- [信息来源：BBC News](https://www.bbc.com/...)\`. Every source mentioned inline in the body must also appear in this final list.

Provide a clear, well-reasoned final answer that represents the council's collective wisdom:`;
}

/** 混合中英文的粗略 token 估算（偏保守，减少「该拦未拦」） */
export function estimateTextTokens(text: string): number {
  let latin = 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x4e00 && c <= 0x9fff) cjk++;
    else if (c >= 0x3040 && c <= 0x30ff) cjk++;
    else if (c >= 0xac00 && c <= 0xd7a3) cjk++;
    else latin++;
  }
  return Math.ceil(latin / 4 + cjk / 1.6);
}

export type ChairmanContextAnalysis = {
  chairman_model: string;
  estimated_input_tokens: number;
  context_limit: number;
  max_input_tokens: number;
  exceeds: boolean;
};

export function analyzeChairmanContext(
  userQuery: string,
  stage1Results: Stage1Item[],
  stage2Results: Stage2Item[],
  chairmanModel: string | undefined,
  judgeWeights?: Record<string, number>,
  labelToModel?: Record<string, string>,
  webFetchSources?: WebFetchSource[],
): ChairmanContextAnalysis {
  const chair = chairmanModel?.trim() || CHAIRMAN_MODEL;
  const prompt = buildChairmanUserContent(
    userQuery,
    stage1Results,
    stage2Results,
    judgeWeights,
    labelToModel,
    webFetchSources,
  );
  const estimated =
    estimateTextTokens(prompt) +
    128; /* system/tool 等小额开销 */
  const context_limit = resolveChairmanContextLimit(chair);
  const max_input_tokens = Math.max(
    4096,
    context_limit - CHAIRMAN_OUTPUT_RESERVE_TOKENS,
  );
  return {
    chairman_model: chair,
    estimated_input_tokens: estimated,
    context_limit,
    max_input_tokens,
    exceeds: estimated > max_input_tokens,
  };
}

/** 按上下文从大到小，返回估算输入能放得下的候选主席模型 */
export function suggestChairmanModelsThatFit(
  estimatedInputTokens: number,
  candidates: string[],
): string[] {
  const uniq = [...new Set(candidates.map((m) => m.trim()).filter(Boolean))];
  const maxIn = (model: string) =>
    Math.max(
      4096,
      resolveChairmanContextLimit(model) - CHAIRMAN_OUTPUT_RESERVE_TOKENS,
    );
  const fits = uniq.filter((m) => maxIn(m) >= estimatedInputTokens);
  fits.sort((a, b) => resolveChairmanContextLimit(b) - resolveChairmanContextLimit(a));
  return fits;
}

function chairmanBlockedResponseMarkdown(a: ChairmanContextAnalysis): string {
  return [
    "当前**主席模型**的最终合成（Stage 3）**未执行**：",
    "",
    `- 估算合成输入约 **${a.estimated_input_tokens}** tokens`,
    `- 模型总上下文 **${a.context_limit}** tokens，扣除回答预留后可用输入约 **${a.max_input_tokens}** tokens`,
    "",
    "请在侧栏设置中更换**上下文更大**的主席模型，并在本回答的 **Stage 3** 面板点击「重跑 Stage 3」；若界面已弹出提示，可在提示中选择模型并一键重试，或使用「仍用当前主席强制尝试」（可能遭 API 截断或报错）。",
  ].join("\n");
}

export type ChairmanStage3Gate =
  | { proceed: true }
  | {
      proceed: false;
      analysis: ChairmanContextAnalysis;
      stage3: Stage3Result;
    };

export function gateChairmanStage3(
  userQuery: string,
  stage1Results: Stage1Item[],
  stage2Results: Stage2Item[],
  chairmanModel: string | undefined,
  judgeWeights?: Record<string, number>,
  labelToModel?: Record<string, string>,
  webFetchSources?: WebFetchSource[],
): ChairmanStage3Gate {
  const analysis = analyzeChairmanContext(
    userQuery,
    stage1Results,
    stage2Results,
    chairmanModel,
    judgeWeights,
    labelToModel,
    webFetchSources,
  );
  if (!analysis.exceeds) return { proceed: true };
  return {
    proceed: false,
    analysis,
    stage3: {
      model: analysis.chairman_model,
      response: chairmanBlockedResponseMarkdown(analysis),
    },
  };
}

export async function stage3SynthesizeFinal(
  userQuery: string,
  stage1Results: Stage1Item[],
  stage2Results: Stage2Item[],
  chairmanModel?: string,
  useWebSearch?: boolean,
  judgeWeights?: Record<string, number>,
  labelToModel?: Record<string, string>,
  apiKey?: string,
  signal?: AbortSignal,
  webFetchSources?: WebFetchSource[],
): Promise<Stage3Result> {
  const chair = chairmanModel?.trim() || CHAIRMAN_MODEL;

  const chairmanPrompt = buildChairmanUserContent(
    userQuery,
    stage1Results,
    stage2Results,
    judgeWeights,
    labelToModel,
    webFetchSources,
  );

  const messages: ChatMessage[] = [{ role: "user", content: chairmanPrompt }];
  const response = await queryModel(chair, messages, {
    ...queryOpts(useWebSearch, apiKey),
    signal,
  });

  if (response == null) {
    return {
      model: chair,
      response: "Error: Unable to generate final synthesis.",
    };
  }

  return {
    model: chair,
    response: response.content ?? "",
  };
}

/** Stage3 流式合成：通过 onDelta 推送 Ofox 返回的正文增量（供 SSE 转发）。 */
export async function stage3SynthesizeFinalStream(
  userQuery: string,
  stage1Results: Stage1Item[],
  stage2Results: Stage2Item[],
  chairmanModel: string | undefined,
  useWebSearch: boolean | undefined,
  judgeWeights: Record<string, number> | undefined,
  labelToModel: Record<string, string> | undefined,
  onDelta: (chunk: string) => void,
  apiKey?: string,
  signal?: AbortSignal,
  webFetchSources?: WebFetchSource[],
): Promise<Stage3Result> {
  const chair = chairmanModel?.trim() || CHAIRMAN_MODEL;

  const chairmanPrompt = buildChairmanUserContent(
    userQuery,
    stage1Results,
    stage2Results,
    judgeWeights,
    labelToModel,
    webFetchSources,
  );

  const messages: ChatMessage[] = [{ role: "user", content: chairmanPrompt }];
  const response = await queryModelStream(chair, messages, {
    ...queryOpts(useWebSearch, apiKey),
    onDelta,
    signal,
  });

  if (response == null) {
    return {
      model: chair,
      response: "Error: Unable to generate final synthesis.",
    };
  }

  return {
    model: chair,
    response: response.content ?? "",
  };
}

function buildFollowUpMessages(
  userQuery: string,
  historyMessages: Message[],
  webContext?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你正在继续同一段多轮对话。",
        "请结合已有上下文直接回答当前追问，不要把历史消息重新改写成摘要。",
        "若历史中存在 assistant 消息里的 reasoning 上下文，请保留其连续性，不要丢弃此前推理状态。",
        webContext
          ? "如果你使用本轮联网检索材料，必须在正文中用 Markdown 链接给出来源名称和精确 URL，并在末尾列出 `## 参考来源`。"
          : "本轮未执行联网检索。若无必要，不要臆造外部来源。",
      ].join("\n"),
    },
  ];

  for (const msg of recentConversationMessages(historyMessages)) {
    if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content });
      continue;
    }
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: msg.stage3.response,
    };
    if (msg.stage3.reasoning_details !== undefined) {
      assistantMessage.reasoning_details = msg.stage3.reasoning_details;
    }
    messages.push(assistantMessage);
  }

  if (webContext) {
    messages.push({
      role: "system",
      content: [
        "补充联网检索材料：",
        "以下内容是本轮追问专门执行的网页抓取结果，不是第一次搜索阶段的投票/主席流程。",
        webContext,
      ].join("\n\n"),
    });
  }

  messages.push({ role: "user", content: userQuery });
  return messages;
}

export async function synthesizeFollowUpAnswer(
  userQuery: string,
  historyMessages: Message[],
  followupModel: string | undefined,
  apiKey?: string,
  signal?: AbortSignal,
  webContext?: string,
): Promise<Stage3Result> {
  const model = followupModel?.trim() || FOLLOWUP_MODEL;
  const response = await queryModel(
    model,
    buildFollowUpMessages(userQuery, historyMessages, webContext),
    { apiKey, signal },
  );

  return {
    model,
    response: response?.content ?? "Error: Unable to generate follow-up answer.",
    reasoning_details: response?.reasoning_details,
  };
}

export async function synthesizeFollowUpAnswerStream(
  userQuery: string,
  historyMessages: Message[],
  followupModel: string | undefined,
  onDelta: (chunk: string) => void,
  apiKey?: string,
  signal?: AbortSignal,
  webContext?: string,
): Promise<Stage3Result> {
  const model = followupModel?.trim() || FOLLOWUP_MODEL;
  const response = await queryModelStream(
    model,
    buildFollowUpMessages(userQuery, historyMessages, webContext),
    { apiKey, signal, onDelta },
  );

  return {
    model,
    response: response?.content ?? "Error: Unable to generate follow-up answer.",
    reasoning_details: response?.reasoning_details,
  };
}

export function parseRankingFromText(rankingText: string): string[] {
  if (rankingText.includes("FINAL RANKING:")) {
    const parts = rankingText.split("FINAL RANKING:");
    if (parts.length >= 2) {
      const rankingSection = parts[1] ?? "";
      const numbered = [...rankingSection.matchAll(/\d+\.\s*Response [A-Z]/g)];
      if (numbered.length > 0) {
        return numbered
          .map((m) => m[0].match(/Response [A-Z]/)?.[0])
          .filter((x): x is string => Boolean(x));
      }
      const matches = rankingSection.match(/Response [A-Z]/g);
      if (matches?.length) return matches;
    }
  }
  return rankingText.match(/Response [A-Z]/g) ?? [];
}

export type AggregateRanking = {
  model: string;
  average_rank: number;
  rankings_count: number;
};

export function calculateAggregateRankings(
  stage2Results: Stage2Item[],
  labelToModel: Record<string, string>,
  judgeWeights?: Record<string, number>,
): AggregateRanking[] {
  const acc = new Map<
    string,
    { wSum: number; wDenom: number; judgeTouches: number }
  >();

  for (const row of stage2Results) {
    const w = judgeWeight(row.model, judgeWeights);
    const parsed = parseRankingFromText(row.ranking);
    parsed.forEach((label, idx) => {
      const modelName = labelToModel[label];
      if (!modelName) return;
      const pos = idx + 1;
      const cur = acc.get(modelName) ?? { wSum: 0, wDenom: 0, judgeTouches: 0 };
      cur.wSum += w * pos;
      cur.wDenom += w;
      cur.judgeTouches += 1;
      acc.set(modelName, cur);
    });
  }

  const aggregate: AggregateRanking[] = [];
  for (const [model, { wSum, wDenom, judgeTouches }] of acc) {
    if (wDenom <= 0) continue;
    aggregate.push({
      model,
      average_rank: Math.round((wSum / wDenom) * 100) / 100,
      rankings_count: judgeTouches,
    });
  }

  aggregate.sort((a, b) => a.average_rank - b.average_rank);
  return aggregate;
}

export async function generateConversationTitle(
  userQuery: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<string> {
  const titlePrompt = `Generate a very short title (3-5 words maximum) that summarizes the following question.
The title should be concise and descriptive. Do not use quotes or punctuation in the title.

Question: ${userQuery}

Title:`;

  const messages: ChatMessage[] = [{ role: "user", content: titlePrompt }];
  const response = await queryModel(TITLE_MODEL, messages, {
    timeoutMs: 30_000,
    apiKey,
    signal,
  });

  if (response == null) return "New Conversation";

  let title = (response.content ?? "New Conversation").trim();
  title = title.replace(/^["']|["']$/g, "");
  if (title.length > 50) title = `${title.slice(0, 47)}...`;
  return title || "New Conversation";
}

/** Rebuild anonymized label → model map from current Stage1 order */
export function labelToModelFromStage1(
  stage1Results: Stage1Item[],
): Record<string, string> {
  const successfulStage1 = successfulStage1Items(stage1Results);
  const labels = successfulStage1.map((_, i) => String.fromCharCode(65 + i));
  const m: Record<string, string> = {};
  for (let i = 0; i < successfulStage1.length; i++) {
    m[`Response ${labels[i]}`] = successfulStage1[i].model;
  }
  return m;
}

export async function runFullCouncil(
  userQuery: string,
  options: CouncilRunOptions = {},
): Promise<[
  Stage1Item[],
  Stage2Item[],
  Stage3Result,
  { label_to_model: Record<string, string>; aggregate_rankings: AggregateRanking[] },
  WebFetchResult | undefined,
]> {
  const {
    chairmanModel,
    useWebSearch,
    webSearchMode,
    councilModels = COUNCIL_MODELS,
    judgeWeights,
    apiKey,
    tavilyApiKey,
    signal,
    historyMessages = [],
    webSearchPlan,
    filterUntrustedSources = false,
  } = options;

  const effectiveQuery = composeEffectiveUserQuery(userQuery, historyMessages);
  const plan =
    webSearchPlan ??
    (await decideWebSearchPlan(
      userQuery,
      historyMessages,
      webSearchMode ?? (useWebSearch ? "on" : "off"),
      apiKey,
      signal,
    ));

  let webFetchResult: WebFetchResult | undefined;
  let webContext: string | undefined;
  if (plan.action === "reuse" && plan.previousWebFetch) {
    webFetchResult = {
      ...plan.previousWebFetch,
      webSearchMode: plan.requestedMode,
      webSearchAction: "reuse",
      webSearchReason: plan.reason,
      reusedFromPrevious: true,
    };
    if (!webFetchResult.webSearchSkipped && hasVerifiedWebFetchSources(webFetchResult)) {
      webContext = webFetchResult.content;
    }
  } else if (plan.action === "search") {
    webFetchResult = await stageWebFetch(
      effectiveQuery,
      chairmanModel,
      apiKey,
      tavilyApiKey,
      signal,
      plan,
      filterUntrustedSources,
    );
    if (!webFetchResult.webSearchSkipped && hasVerifiedWebFetchSources(webFetchResult)) {
      webContext = webFetchResult.content;
    }
  }

  const stage1Results = await stage1CollectResponses(
    effectiveQuery,
    plan.action === "search",
    webContext,
    webFetchResult?.retrievedAt != null
      ? {
          isoUtc: webFetchResult.retrievedAt,
          unixSeconds: webFetchResult.retrievedAtUnixSeconds ?? 0,
        }
      : undefined,
    apiKey,
    signal,
    councilModels,
  );
  if (successfulStage1Items(stage1Results).length === 0) {
    return [
      stage1Results,
      [],
      {
        model: "error",
        response: "All models failed to respond. Please try again.",
      },
      { label_to_model: {}, aggregate_rankings: [] },
      webFetchResult,
    ];
  }

  const [stage2Results, labelToModel] = await stage2CollectRankings(
    effectiveQuery,
    stage1Results,
    plan.action === "search",
    apiKey,
    signal,
    councilModels,
  );
  const aggregateRankings = calculateAggregateRankings(
    stage2Results,
    labelToModel,
    judgeWeights,
  );
  const gate = gateChairmanStage3(
    effectiveQuery,
    stage1Results,
    stage2Results,
    chairmanModel,
    judgeWeights,
    labelToModel,
    webFetchResult?.sources,
  );
  const stage3Result = gate.proceed
    ? await stage3SynthesizeFinal(
        effectiveQuery,
        stage1Results,
        stage2Results,
        chairmanModel,
        plan.action === "search",
        judgeWeights,
        labelToModel,
        apiKey,
        signal,
        webFetchResult?.sources,
      )
    : gate.stage3;

  return [
    stage1Results,
    stage2Results,
    stage3Result,
    {
      label_to_model: labelToModel,
      aggregate_rankings: aggregateRankings,
    },
    webFetchResult,
  ];
}
