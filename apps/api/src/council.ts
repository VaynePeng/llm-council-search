import {
  CHAIRMAN_MODEL,
  COUNCIL_MODELS,
  TITLE_MODEL,
} from "./config.js";
import {
  queryModel,
  queryModelsParallel,
  type ChatMessage,
  type QueryOptions,
} from "./openrouter.js";
import type { Stage1Item, Stage2Item, Stage3Result } from "./storage.js";

export type CouncilRunOptions = {
  chairmanModel?: string;
  useWebSearch?: boolean;
  /** Weight of each judge model's vote in Stage2 aggregate (default 1) */
  judgeWeights?: Record<string, number>;
};

function queryOpts(useWebSearch?: boolean): QueryOptions {
  return { useWebSearch: Boolean(useWebSearch) };
}

export async function stage1CollectResponses(
  userQuery: string,
  useWebSearch?: boolean,
): Promise<Stage1Item[]> {
  const messages: ChatMessage[] = [{ role: "user", content: userQuery }];
  const responses = await queryModelsParallel(
    COUNCIL_MODELS,
    messages,
    queryOpts(useWebSearch),
  );

  const stage1: Stage1Item[] = [];
  for (const [model, response] of responses) {
    if (response != null) {
      stage1.push({ model, response: response.content ?? "" });
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
]> {
  const { chairmanModel, useWebSearch, judgeWeights } = options;

  const stage1Results = await stage1CollectResponses(userQuery, useWebSearch);
  if (stage1Results.length === 0) {
    return [
      [],
      [],
      {
        model: "error",
        response: "All models failed to respond. Please try again.",
      },
      { label_to_model: {}, aggregate_rankings: [] },
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
  ];
}
