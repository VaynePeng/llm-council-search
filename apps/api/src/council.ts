import {
  CHAIRMAN_MODEL,
  COUNCIL_MODELS,
  CHAIRMAN_OUTPUT_RESERVE_TOKENS,
  TITLE_MODEL,
  WEB_FETCH_MODEL,
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
  type UrlCitationItem,
} from "./openrouter.js";
import type {
  Message,
  Stage1Item,
  Stage2Item,
  Stage3Result,
  WebFetchResult,
  WebFetchSource,
} from "./storage.js";

function appendStructuredCitations(
  body: string,
  citations: UrlCitationItem[],
): string {
  if (citations.length === 0) return body;
  const parts = citations.map((c, i) => {
    const snippet = c.content
      ? `\n   摘录：${
          c.content.length > 400
            ? `${c.content.slice(0, 400)}…`
            : c.content
        }`
      : "";
    return `${i + 1}. **${c.title ?? "(无标题)"}** — ${c.url}${snippet}`;
  });
  return `${body}\n\n---\n### 检索系统返回的站点与摘录（结构化 URL 引用）\n\n以下条目来自 API 的 \`url_citation\` 标注，可与正文交叉核对。\n\n${parts.join("\n\n")}\n`;
}

export type CouncilRunOptions = {
  chairmanModel?: string;
  useWebSearch?: boolean;
  webSearchMode?: WebSearchMode;
  /** Override `WEB_FETCH_MODEL` for the web research stage */
  webFetchModel?: string;
  /** Weight of each judge model's vote in Stage2 aggregate (default 1) */
  judgeWeights?: Record<string, number>;
  /** 由前端传入的用户 API Key */
  apiKey?: string;
  signal?: AbortSignal;
  historyMessages?: Message[];
  webSearchPlan?: WebSearchPlan;
};

export type WebSearchMode = "off" | "auto" | "on";

export type WebSearchPlan = {
  requestedMode: WebSearchMode;
  action: "skip" | "search" | "reuse";
  reason: string;
  previousWebFetch?: WebFetchResult;
};

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
    if (msg.webFetch?.content?.trim()) return msg.webFetch;
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
    return previous && !previous.webSearchSkipped ? "reuse" : "search";
  }
  return null;
}

export async function decideWebSearchPlan(
  userQuery: string,
  messages: Message[],
  requestedMode: WebSearchMode,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<WebSearchPlan> {
  if (requestedMode !== "auto") {
    return decideWebSearchPlanByRules(userQuery, messages, requestedMode);
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

  return decideWebSearchPlanByRules(userQuery, messages, requestedMode);
}

function queryOpts(useWebSearch?: boolean, apiKey?: string): QueryOptions {
  return { useWebSearch: Boolean(useWebSearch), apiKey };
}

export async function stageWebFetch(
  userQuery: string,
  modelOverride?: string,
  apiKey?: string,
  signal?: AbortSignal,
  plan?: WebSearchPlan,
): Promise<WebFetchResult> {
  const model = modelOverride?.trim() || WEB_FETCH_MODEL;
  const t = getWebSearchTemporalContext();
  const system = `You are a web retrieval worker with access to a web search tool. Your job is to decide what must be searched on the web, retrieve fresh and checkable facts for only that part, and return a neutral retrieval dossier.

Temporal anchor: the search is executed at **${t.isoUtc}** (ISO 8601, UTC), Unix **${t.unixSeconds}** s. Do not assume the end user's local timezone. Interpret "recent", "latest", "currently" relative to this UTC instant; prefer sources with visible, plausible publication or update times; flag content that appears years out of date for time-sensitive topics.

Rules:
- First analyze the user request privately and split it into:
  1. parts that require fresh external facts or source verification;
  2. parts that are analysis, explanation, comparison, summarization, drafting, or other reasoning that do not require web access.
- Search only for category (1). Do not spend search budget on category (2).
- Do not answer the user's full question. Do not provide recommendations, final conclusions, prioritization, or subjective judgments beyond minimal source description.
- Do not output your private planning or chain-of-thought. Only output the retrieval dossier.
- Use the search tool; do not invent URLs, quotes, or publication dates.
- Every important claim should be traceable to a real page/domain you saw in search results or API citations.
- Source notes must stay descriptive, not prescriptive. It is acceptable to mark a source as official documentation, regulator page, company blog, press report, forum post, archived page, or undated page. It is acceptable to note visible recency or missing dates. Do not assign weights/scores.
- If results conflict, report the conflict neutrally and cite both sides. Do not decide the winner for later models.
- Match the user's language: if the question is in Chinese, write in Simplified Chinese; otherwise mirror the question's language.
- Use Markdown. Use real markdown links [site or title](full_url) in 参考来源 where you have URLs.

${WEB_SOURCE_DISCIPLINE}`;

  const userPrompt = `## 检索基准时间（本次请求发起时刻，仅 UTC，不推断用户本地时区）
- **ISO 8601（UTC）**：${t.isoUtc}
- **Unix 时间戳（秒）**：${t.unixSeconds}

在此 UTC 时刻下检索与作答：涉及时效、版本、政策、安全公告、股价等议题时，**优先**采纳可核对日期且与上述时刻接近的资料；对明显过时、无日期或仅历史档案价值的页面降低权重并在文中说明。如需面向读者表述当地时间，仅可在文中根据来源页面自行说明，勿臆测用户时区。

---

Question:
${userQuery}

Produce this structure (adapt heading language to the user's language, e.g. 简体中文 for Chinese questions):

## 联网检索范围
- 列出你判断“需要联网”的事实点、最新信息、需要核验的外部说法。
- 列出你判断“无需联网、留给后续模型处理”的内容类型，例如分析、解释、对比、总结、建议、写作。
- 这一节只做任务拆分，不给最终答案。

## 检索摘要
1–3 sentences: what you searched for in the web-required part only, and what material you found (or that little relevant material exists). Mention if results skew old relative to the retrieval time above.

## 来源清单
For each significant source you rely on, give: 来源名称、域名/URL、来源类型（官方/媒体/社区/文档/论坛/聚合页等）、可见日期（若有）、一句客观说明。不要打分，不要排优先级，不要给采信建议。

## 检索到的事实
Bullet list: concrete externally sourced facts only. Each bullet should be traceable to one or more sources, and when you mention a sourced fact you must include both the source name and the exact URL. Keep wording factual and compact. No recommendations, no final synthesis, no answer framing.

## 冲突与缺口
- List conflicts between sources, if any.
- List important missing facts, ambiguous dates, or items that still need verification.
- Keep this descriptive only.

## 参考来源
Numbered list with **Markdown links** [title or domain](https://...) for every URL you cite. If the API gave structured citations, align with them. If no usable URLs, state that clearly.`;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: userPrompt },
  ];
  const response = await queryModel(model, messages, {
    useWebSearch: true,
    webMaxResults: 10,
    timeoutMs: 180_000,
    webSearchTemporalContext: t,
    apiKey,
    signal,
  });

  if (!response) {
    return {
      model,
      content: "(Web fetch failed)",
      webSearchMode: plan?.requestedMode,
      webSearchAction: plan?.action ?? "search",
      webSearchReason: plan?.reason,
    };
  }

  const citations = response.citations ?? [];
  const content =
    citations.length > 0
      ? appendStructuredCitations(response.content ?? "", citations)
      : (response.content ?? "");

  const sources: WebFetchSource[] | undefined =
    citations.length > 0
      ? citations.map((c) => ({
          url: c.url,
          title: c.title,
          snippet: c.content,
        }))
      : undefined;

  return {
    model,
    content,
    webSearchMode: plan?.requestedMode,
    webSearchAction: plan?.action ?? "search",
    webSearchReason: plan?.reason,
    webSearchSkipped: response.webSearchSkipped,
    retrievedAt: t.isoUtc,
    retrievedAtUnixSeconds: t.unixSeconds,
    ...(sources ? { sources } : {}),
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
  const responses = await queryModelsParallel(COUNCIL_MODELS, messages, opts);

  const stage1: Stage1Item[] = [];
  for (const [model, response] of responses) {
    if (response != null) {
      stage1.push({
        model,
        response: response.content ?? "",
        webSearchSkipped: response.webSearchSkipped,
      });
    }
  }
  return stage1;
}

export async function stage2CollectRankings(
  userQuery: string,
  stage1Results: Stage1Item[],
  useWebSearch?: boolean,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<[Stage2Item[], Record<string, string>]> {
  const labels = stage1Results.map((_, i) => String.fromCharCode(65 + i));

  const labelToModel: Record<string, string> = {};
  for (let i = 0; i < labels.length; i++) {
    labelToModel[`Response ${labels[i]}`] = stage1Results[i].model;
  }

  const responsesText = stage1Results
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
    COUNCIL_MODELS,
    messages,
    { ...queryOpts(useWebSearch, apiKey), signal },
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
      `${i + 1}. [${s.title ?? s.url}](${s.url})${s.snippet ? ` — ${clipText(s.snippet, 200)}` : ""}`,
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

/** Stage3 流式合成：通过 onDelta 推送 OpenRouter 返回的正文增量（供 SSE 转发）。 */
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
  const labels = stage1Results.map((_, i) => String.fromCharCode(65 + i));
  const m: Record<string, string> = {};
  for (let i = 0; i < stage1Results.length; i++) {
    m[`Response ${labels[i]}`] = stage1Results[i].model;
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
    judgeWeights,
    webFetchModel,
    apiKey,
    signal,
    historyMessages = [],
    webSearchPlan,
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
    if (!webFetchResult.webSearchSkipped) {
      webContext = webFetchResult.content;
    }
  } else if (plan.action === "search") {
    webFetchResult = await stageWebFetch(
      effectiveQuery,
      webFetchModel,
      apiKey,
      signal,
      plan,
    );
    if (!webFetchResult.webSearchSkipped) {
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
  );
  if (stage1Results.length === 0) {
    return [
      [],
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
