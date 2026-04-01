import {
  CHAIRMAN_MODEL,
  COUNCIL_MODELS,
  TITLE_MODEL,
  WEB_FETCH_MODEL,
} from "./config.js";
import {
  getWebSearchTemporalContext,
  queryModel,
  queryModelsParallel,
  type ChatMessage,
  type QueryOptions,
  type UrlCitationItem,
} from "./openrouter.js";
import type {
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
  return `${body}\n\n---\n### 检索系统返回的站点与摘录（结构化 URL 引用）\n\n以下条目来自 API 的 \`url_citation\` 标注，可与正文交叉核对；**结论应优先采信高可信度来源**。\n\n${parts.join("\n\n")}\n`;
}

export type CouncilRunOptions = {
  chairmanModel?: string;
  useWebSearch?: boolean;
  /** Override `WEB_FETCH_MODEL` for the web research stage */
  webFetchModel?: string;
  /** Weight of each judge model's vote in Stage2 aggregate (default 1) */
  judgeWeights?: Record<string, number>;
};

function queryOpts(useWebSearch?: boolean): QueryOptions {
  return { useWebSearch: Boolean(useWebSearch) };
}

export async function stageWebFetch(
  userQuery: string,
  modelOverride?: string,
): Promise<WebFetchResult> {
  const model = modelOverride?.trim() || WEB_FETCH_MODEL;
  const t = getWebSearchTemporalContext();
  const system = `You are a web research assistant with access to a web search tool. Your job is to retrieve fresh, checkable facts—not to guess.

Temporal anchor: the search is executed at **${t.isoUtc}** (ISO 8601, UTC), Unix **${t.unixSeconds}** s. Do not assume the end user's local timezone. Interpret "recent", "latest", "currently" relative to this UTC instant; prefer sources with visible, plausible publication or update times; flag content that appears years out of date for time-sensitive topics.

Rules:
- Use the search tool; do not invent URLs, quotes, or publication dates.
- Every important claim should be traceable to a real page/domain you saw in search results or API citations.
- **Source triage (anti–fake news):** You must explicitly judge each major source: tier (e.g. A=official/registry/vendor docs/academic; B=major wire or national newspaper; C=niche blog/forum; D=unknown or sensational). Assign a **weight 0.0–1.0** and one-line rationale. Down-rank or flag clickbait, single-anonymous-source rumors, and coordinated low-quality domains.
- **Synthesis:** Build the core answer primarily from the **highest-weight** sources; if only low-tier sources support a claim, label it「低可信度」「待核实」/ "low confidence" / "unverified".
- If results conflict, say so and say which side has stronger sourcing.
- Match the user's language: if the question is in Chinese, write in Simplified Chinese; otherwise mirror the question's language.
- Use Markdown. Use real markdown links [site or title](full_url) in 参考来源 where you have URLs.`;

  const userPrompt = `## 检索基准时间（本次请求发起时刻，仅 UTC，不推断用户本地时区）
- **ISO 8601（UTC）**：${t.isoUtc}
- **Unix 时间戳（秒）**：${t.unixSeconds}

在此 UTC 时刻下检索与作答：涉及时效、版本、政策、安全公告、股价等议题时，**优先**采纳可核对日期且与上述时刻接近的资料；对明显过时、无日期或仅历史档案价值的页面降低权重并在文中说明。如需面向读者表述当地时间，仅可在文中根据来源页面自行说明，勿臆测用户时区。

---

Question:
${userQuery}

Produce this structure (adapt heading language to the user's language, e.g. 简体中文 for Chinese questions):

## 检索摘要
1–3 sentences: what you looked for and what you found (or that little relevant material exists). Mention if results skew old relative to the retrieval time above.

## 来源可信度与权重
Table or bullet list: for **each significant domain/URL** you rely on, give: 域名/URL、类型（官方/媒体/社区等）、权重 0.0–1.0、一句话理由。对可疑或易造谣场景（健康恐慌、政治爆料、无署名爆料）单独标注「谨慎采纳」。

## 核心结论
Direct answer, **explicitly grounded in the highest-weight sources** first. If the best available evidence is weak, say so up front.

## 要点与事实
Bullet list: concrete facts **only** with implied source strength (e.g. tag [高可信]/[中]/[低] or link). No fabricated numbers or dates.

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
  });

  if (!response) {
    return { model, content: "(Web fetch failed)" };
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
): Promise<Stage1Item[]> {
  let userContent = userQuery;
  if (webContext) {
    const clock =
      webRetrievalMeta != null
        ? `Retrieval instant (UTC only; do not assume end-user local timezone): **${webRetrievalMeta.isoUtc}** · Unix **${webRetrievalMeta.unixSeconds}** s\n\n`
        : "";
    userContent = `The following web search results have been gathered for context. They may include a section of structured URL citations with snippets.

Trust policy: Prefer claims backed by official or first-party documentation, regulated bodies, and established news organizations. Treat single low-tier or sensational sources as weak evidence—do not present them as certain fact. If the context includes a "来源可信度与权重" section from the web stage, respect that ranking when you answer.

${clock}---

${webContext}

---

Based on the above web context (and its source weighting when present) plus your own knowledge where appropriate, answer the following question:

${userQuery}`;
  }

  const messages: ChatMessage[] = [{ role: "user", content: userContent }];
  const opts = webContext ? {} : queryOpts(useWebSearch);
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
    queryOpts(useWebSearch),
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

export async function stage3SynthesizeFinal(
  userQuery: string,
  stage1Results: Stage1Item[],
  stage2Results: Stage2Item[],
  chairmanModel?: string,
  useWebSearch?: boolean,
  judgeWeights?: Record<string, number>,
  labelToModel?: Record<string, string>,
): Promise<Stage3Result> {
  const chair = chairmanModel?.trim() || CHAIRMAN_MODEL;

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

  const chairmanPrompt = `You are the Chairman of a multi-model deliberation: several AI models responded to the user's question and ranked each other's responses.

Original Question: ${userQuery}

STAGE 1 - Individual Responses:
${stage1Text}

STAGE 2 - Peer Rankings:
${stage2Text}
${aggregateSection}

Your task as Chairman is to synthesize all of this information into a single, comprehensive, accurate answer to the user's original question. Consider:
- The individual responses and their insights
- The peer rankings and what they reveal about response quality
- Any patterns of agreement or disagreement
- The aggregate ranking summary when present (it reflects peer evaluation${judgeWeights && Object.keys(judgeWeights).length ? ", weighted by configured judge importance" : ""})

Provide a clear, well-reasoned final answer that represents the council's collective wisdom:`;

  const messages: ChatMessage[] = [{ role: "user", content: chairmanPrompt }];
  const response = await queryModel(chair, messages, queryOpts(useWebSearch));

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

export async function generateConversationTitle(userQuery: string): Promise<string> {
  const titlePrompt = `Generate a very short title (3-5 words maximum) that summarizes the following question.
The title should be concise and descriptive. Do not use quotes or punctuation in the title.

Question: ${userQuery}

Title:`;

  const messages: ChatMessage[] = [{ role: "user", content: titlePrompt }];
  const response = await queryModel(TITLE_MODEL, messages, { timeoutMs: 30_000 });

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
  const { chairmanModel, useWebSearch, judgeWeights, webFetchModel } = options;

  let webFetchResult: WebFetchResult | undefined;
  let webContext: string | undefined;
  if (useWebSearch) {
    webFetchResult = await stageWebFetch(userQuery, webFetchModel);
    if (!webFetchResult.webSearchSkipped) {
      webContext = webFetchResult.content;
    }
  }

  const stage1Results = await stage1CollectResponses(
    userQuery,
    useWebSearch,
    webContext,
    webFetchResult?.retrievedAt != null
      ? {
          isoUtc: webFetchResult.retrievedAt,
          unixSeconds: webFetchResult.retrievedAtUnixSeconds ?? 0,
        }
      : undefined,
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
    userQuery,
    stage1Results,
    useWebSearch,
  );
  const aggregateRankings = calculateAggregateRankings(
    stage2Results,
    labelToModel,
    judgeWeights,
  );
  const stage3Result = await stage3SynthesizeFinal(
    userQuery,
    stage1Results,
    stage2Results,
    chairmanModel,
    useWebSearch,
    judgeWeights,
    labelToModel,
  );

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
