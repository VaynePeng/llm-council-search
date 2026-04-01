import { OPENROUTER_API_KEY, OPENROUTER_API_URL } from "./config.js";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

/** OpenRouter 对 web 结果的 `url_citation` 标注（与 Chat Completions message 对齐） */
export type UrlCitationItem = {
  url: string;
  title?: string;
  content?: string;
};

function parseUrlCitations(message: Record<string, unknown>): UrlCitationItem[] {
  const raw = message.annotations;
  if (!Array.isArray(raw)) return [];
  const out: UrlCitationItem[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const rec = a as {
      type?: string;
      url_citation?: { url?: string; title?: string; content?: string };
    };
    if (rec.type !== "url_citation" || !rec.url_citation?.url) continue;
    const url = String(rec.url_citation.url);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: rec.url_citation.title,
      content: rec.url_citation.content,
    });
  }
  return out;
}

/** 发起联网检索时的时刻（供 search_prompt 与 stageWebFetch 提示词一致引用） */
export function getWebSearchTemporalContext(now: Date = new Date()) {
  const isoUtc = now.toISOString();
  const unixSeconds = Math.floor(now.getTime() / 1000);
  const pluginSearchPrompt =
    `A web search was conducted at ${isoUtc} (ISO 8601, UTC). ` +
    `Unix epoch seconds: ${unixSeconds}. Do not assume the end user's local timezone; use this UTC anchor only. ` +
    `Prefer sources that are current as of this instant or clearly published recently; ` +
    `treat undated, undiscoverable-publish-date, or obviously stale pages as weaker evidence when the user needs up-to-date facts. ` +
    `Incorporate the following web search results into your response.\n\n` +
    `IMPORTANT: Cite them using markdown links named using the domain of the source.\n` +
    `Example: [nytimes.com](https://nytimes.com/some-page).`;
  return { isoUtc, unixSeconds, pluginSearchPrompt };
}

export type WebSearchTemporalContext = ReturnType<typeof getWebSearchTemporalContext>;

export type QueryOptions = {
  timeoutMs?: number;
  useWebSearch?: boolean;
  /** OpenRouter web plugin `max_results` (default 5) */
  webMaxResults?: number;
  /** 与聊天提示词共用同一时间锚，避免 search_prompt 与 user 消息不一致 */
  webSearchTemporalContext?: WebSearchTemporalContext;
};

/** `:online` 与 `plugins: [{ id: "web" }]` 等价；我们统一用插件并带 `max_results`，故去掉后缀避免重复触发联网。 */
function stripOnlineSuffix(model: string): string {
  return model.endsWith(":online") ? model.slice(0, -":online".length) : model;
}

/** OpenRouter：仅 OpenAI / Anthropic / Perplexity / xAI 走原生搜索；其余应走 Exa，否则部分模型（如 Google）会报错或无法附加检索。 */
function webPluginPayload(
  model: string,
  maxResults: number,
  temporal?: WebSearchTemporalContext,
): Array<Record<string, unknown>> {
  const max = Math.min(20, Math.max(1, maxResults));
  const m = stripOnlineSuffix(model).toLowerCase();
  const plugin: Record<string, unknown> = { id: "web", max_results: max };
  const nativePrefix =
    m.startsWith("openai/") ||
    m.startsWith("anthropic/") ||
    m.startsWith("perplexity/") ||
    m.startsWith("x-ai/");
  if (!nativePrefix) {
    plugin.engine = "exa";
  }
  const t = temporal ?? getWebSearchTemporalContext();
  plugin.search_prompt = t.pluginSearchPrompt;
  return [plugin];
}

async function doFetch(
  model: string,
  messages: ChatMessage[],
  plugins: Array<Record<string, unknown>> | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
  };

  const body: Record<string, unknown> = {
    model,
    messages,
    ...(plugins && plugins.length > 0 ? { plugins } : {}),
  };

  return fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
}

export async function queryModel(
  model: string,
  messages: ChatMessage[],
  options: QueryOptions = {},
): Promise<{
  content: string;
  reasoning_details?: unknown;
  webSearchSkipped?: boolean;
  citations?: UrlCitationItem[];
} | null> {
  const {
    timeoutMs = 120_000,
    useWebSearch = false,
    webMaxResults = 5,
    webSearchTemporalContext,
  } = options;

  const effectiveModel =
    useWebSearch ? stripOnlineSuffix(model) : model;

  const webPlugins = useWebSearch
    ? webPluginPayload(
        effectiveModel,
        webMaxResults,
        webSearchTemporalContext,
      )
    : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const parseSuccess = async (
    res: Response,
  ): Promise<{
    content: string;
    reasoning_details?: unknown;
    citations?: UrlCitationItem[];
  } | null> => {
    if (!res.ok) {
      const text = await res.text();
      console.error(`OpenRouter error ${effectiveModel}:`, res.status, text);
      return null;
    }
    const data = (await res.json()) as {
      choices?: Array<{
        message?: Record<string, unknown> & {
          content?: string;
          reasoning_details?: unknown;
        };
      }>;
    };
    const message = data.choices?.[0]?.message;
    if (!message) return null;
    const citations = parseUrlCitations(message);
    return {
      content: (message.content as string | undefined) ?? "",
      reasoning_details: message.reasoning_details,
      ...(citations.length > 0 ? { citations } : {}),
    };
  };

  try {
    if (useWebSearch) {
      let withPlugin: {
        content: string;
        reasoning_details?: unknown;
        citations?: UrlCitationItem[];
      } | null = null;
      try {
        const resWith = await doFetch(
          effectiveModel,
          messages,
          webPlugins,
          controller.signal,
        );
        withPlugin = await parseSuccess(resWith);
      } catch (e) {
        console.warn(
          `[OpenRouter] Web search request threw for ${effectiveModel}:`,
          e,
        );
      }
      if (withPlugin) {
        return {
          content: withPlugin.content,
          reasoning_details: withPlugin.reasoning_details,
          citations: withPlugin.citations,
        };
      }

      console.warn(
        `[OpenRouter] Web search request failed for ${effectiveModel}; retrying without web plugin.`,
      );
      try {
        const resNo = await doFetch(
          effectiveModel,
          messages,
          undefined,
          controller.signal,
        );
        const fallback = await parseSuccess(resNo);
        if (fallback)
          return {
            ...fallback,
            webSearchSkipped: true,
          };
      } catch (e) {
        console.error(
          `[OpenRouter] Fallback request without web failed for ${effectiveModel}:`,
          e,
        );
      }
      return null;
    }

    const res = await doFetch(effectiveModel, messages, undefined, controller.signal);
    return parseSuccess(res);
  } catch (e) {
    console.error(`Error querying model ${model}:`, e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function queryModelsParallel(
  models: string[],
  messages: ChatMessage[],
  options: QueryOptions = {},
): Promise<Map<string, Awaited<ReturnType<typeof queryModel>>>> {
  const entries = await Promise.all(
    models.map(async (model) => {
      const r = await queryModel(model, messages, options);
      return [model, r] as const;
    }),
  );
  return new Map(entries);
}
