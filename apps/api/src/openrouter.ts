import { OPENROUTER_API_URL } from "./config.js";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  reasoning_details?: unknown;
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
  const webSearchInstruction =
    `When you use the OpenRouter web search tool, anchor retrieval time to ${isoUtc} (ISO 8601, UTC). ` +
    `Unix epoch seconds: ${unixSeconds}. Do not assume the end user's local timezone; use this UTC anchor only. ` +
    `Prefer sources that are current as of this instant or clearly published recently; ` +
    `treat undated, undiscoverable-publish-date, or obviously stale pages as weaker evidence when the user needs up-to-date facts. ` +
    `Ground claims in the search results you obtain; do not invent URLs.\n\n` +
    `IMPORTANT: If you use web-retrieved information, every cited item must include both a source name and the exact source URL.\n` +
    `Use Markdown links with human-readable source names as the anchor text.\n` +
    `Example: [New York Times](https://nytimes.com/some-page).`;
  return { isoUtc, unixSeconds, webSearchInstruction };
}

export type WebSearchTemporalContext = ReturnType<typeof getWebSearchTemporalContext>;

export type QueryOptions = {
  timeoutMs?: number;
  useWebSearch?: boolean;
  /** `openrouter:web_search` 的 `max_results`（默认 5） */
  webMaxResults?: number;
  /** 与聊天提示词共用同一时间锚，与注入的 system 补充说明一致 */
  webSearchTemporalContext?: WebSearchTemporalContext;
  /** 由前端传入的用户 API Key */
  apiKey?: string;
  /** 外部取消信号，例如客户端中止会话流时同步中断上游请求 */
  signal?: AbortSignal;
};

function abortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function createRequestSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** `:online` 变体与显式联网二选一即可；去掉后缀避免与 `openrouter:web_search` 重复触发。 */
function stripOnlineSuffix(model: string): string {
  return model.endsWith(":online") ? model.slice(0, -":online".length) : model;
}

/** OpenRouter：仅 OpenAI / Anthropic / Perplexity / xAI 适合 `native`/`auto`；其余强制 Exa，避免部分模型（如 Google）原生检索异常。 */
function webSearchToolsPayload(
  model: string,
  maxResults: number,
): Array<Record<string, unknown>> {
  const max = Math.min(25, Math.max(1, maxResults));
  const m = stripOnlineSuffix(model).toLowerCase();
  const nativePrefix =
    m.startsWith("openai/") ||
    m.startsWith("anthropic/") ||
    m.startsWith("perplexity/") ||
    m.startsWith("x-ai/");
  const parameters: Record<string, unknown> = { max_results: max };
  if (!nativePrefix) {
    parameters.engine = "exa";
  }
  return [{ type: "openrouter:web_search", parameters }];
}

/** 服务端工具无 `search_prompt`，将时区与引用规则写入 system（与首条 system 合并）。 */
function withWebSearchSystemInstruction(
  messages: ChatMessage[],
  temporal?: WebSearchTemporalContext,
): ChatMessage[] {
  const t = temporal ?? getWebSearchTemporalContext();
  const block = t.webSearchInstruction;
  const first = messages[0];
  if (first?.role === "system") {
    return [
      { role: "system", content: `${first.content}\n\n${block}` },
      ...messages.slice(1),
    ];
  }
  return [{ role: "system", content: block }, ...messages];
}

function chatRequestBody(
  model: string,
  messages: ChatMessage[],
  tools: Array<Record<string, unknown>> | undefined,
  stream: boolean,
): Record<string, unknown> {
  return {
    model,
    messages,
    stream,
    ...(tools && tools.length > 0 ? { tools } : {}),
  };
}

function resolveApiKey(override?: string): string {
  const key = override?.trim();
  if (!key) {
    throw new Error("OpenRouter API key required via X-OpenRouter-Key header");
  }
  return key;
}

async function doFetch(
  model: string,
  messages: ChatMessage[],
  tools: Array<Record<string, unknown>> | undefined,
  signal: AbortSignal,
  apiKey?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${resolveApiKey(apiKey)}`,
  };

  return fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(chatRequestBody(model, messages, tools, false)),
    signal,
  });
}

async function doFetchStream(
  model: string,
  messages: ChatMessage[],
  tools: Array<Record<string, unknown>> | undefined,
  signal: AbortSignal,
  apiKey?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${resolveApiKey(apiKey)}`,
  };

  return fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(chatRequestBody(model, messages, tools, true)),
    signal,
  });
}

/** 解析 OpenAI/OpenRouter 式 SSE 流，将正文增量交给 onDelta */
async function consumeChatCompletionStream(
  res: Response,
  onDelta: (chunk: string) => void,
): Promise<{ ok: boolean; reasoning_details?: unknown[] }> {
  if (!res.ok) {
    const text = await res.text();
    console.error("OpenRouter stream HTTP error:", res.status, text);
    return { ok: false };
  }
  const reader = res.body?.getReader();
  if (!reader) return { ok: false };

  const decoder = new TextDecoder();
  let buffer = "";
  const reasoningDetails: unknown[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trimEnd();
      buffer = buffer.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (!trimmed.startsWith("data: ")) continue;
      const raw = trimmed.slice(6).trim();
      if (raw === "[DONE]") continue;
      try {
        const j = JSON.parse(raw) as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning_details?: unknown;
            };
          }>;
          error?: { message?: string };
        };
        if (j.error?.message) {
          console.error("OpenRouter stream chunk error:", j.error.message);
          continue;
        }
        const delta = j.choices?.[0]?.delta;
        const piece = delta?.content;
        if (typeof piece === "string" && piece.length > 0) onDelta(piece);
        if (Array.isArray(delta?.reasoning_details)) {
          reasoningDetails.push(...delta.reasoning_details);
        }
      } catch {
        /* 忽略单行解析失败 */
      }
    }
  }
  return reasoningDetails.length > 0
    ? { ok: true, reasoning_details: reasoningDetails }
    : { ok: true };
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
    apiKey,
    signal,
  } = options;

  const effectiveModel =
    useWebSearch ? stripOnlineSuffix(model) : model;

  const payloadMessages = useWebSearch
    ? withWebSearchSystemInstruction(messages, webSearchTemporalContext)
    : messages;

  const webTools = useWebSearch
    ? webSearchToolsPayload(effectiveModel, webMaxResults)
    : undefined;

  const request = createRequestSignal(timeoutMs, signal);

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
    throwIfAborted(signal);
    if (useWebSearch) {
      let withWebSearchTool: {
        content: string;
        reasoning_details?: unknown;
        citations?: UrlCitationItem[];
      } | null = null;
      try {
        const resWith = await doFetch(
          effectiveModel,
          payloadMessages,
          webTools,
          request.signal,
          apiKey,
        );
        withWebSearchTool = await parseSuccess(resWith);
      } catch (e) {
        console.warn(
          `[OpenRouter] Web search request threw for ${effectiveModel}:`,
          e,
        );
      }
      if (withWebSearchTool) {
        return {
          content: withWebSearchTool.content,
          reasoning_details: withWebSearchTool.reasoning_details,
          citations: withWebSearchTool.citations,
        };
      }

      console.warn(
        `[OpenRouter] Web search request failed for ${effectiveModel}; retrying without web search tool.`,
      );
      try {
        const resNo = await doFetch(
          effectiveModel,
          messages,
          undefined,
          request.signal,
          apiKey,
        );
        const fallback = await parseSuccess(resNo);
        if (fallback)
          return {
            ...fallback,
            webSearchSkipped: true,
          };
      } catch (e) {
        console.error(
          `[OpenRouter] Fallback request without web search failed for ${effectiveModel}:`,
          e,
        );
      }
      return null;
    }

    const res = await doFetch(
      effectiveModel,
      messages,
      undefined,
      request.signal,
      apiKey,
    );
    return parseSuccess(res);
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") throw e;
    console.error(`Error querying model ${model}:`, e);
    return null;
  } finally {
    request.cleanup();
  }
}

export type QueryStreamOptions = QueryOptions & {
  onDelta: (chunk: string) => void;
};

/**
 * 流式调用模型（OpenRouter `stream: true`），通过 onDelta 推送正文增量。
 * 联网失败时会与非流式逻辑一致：重试无 `openrouter:web_search` 或整段回退到 queryModel。
 */
export async function queryModelStream(
  model: string,
  messages: ChatMessage[],
  options: QueryStreamOptions,
): Promise<{
  content: string;
  reasoning_details?: unknown;
  webSearchSkipped?: boolean;
  citations?: UrlCitationItem[];
} | null> {
  const {
    onDelta,
    timeoutMs = 120_000,
    useWebSearch = false,
    webMaxResults = 5,
    webSearchTemporalContext,
    apiKey,
    signal,
  } = options;

  const restQuery: QueryOptions = {
    timeoutMs,
    useWebSearch,
    webMaxResults,
    webSearchTemporalContext,
    apiKey,
    signal,
  };

  const effectiveModel = useWebSearch ? stripOnlineSuffix(model) : model;
  const payloadMessages = useWebSearch
    ? withWebSearchSystemInstruction(messages, webSearchTemporalContext)
    : messages;
  const webTools = useWebSearch
    ? webSearchToolsPayload(effectiveModel, webMaxResults)
    : undefined;

  const request = createRequestSignal(timeoutMs, signal);

  const runStream = async (
    toSend: ChatMessage[],
    tools: Array<Record<string, unknown>> | undefined,
  ): Promise<{ content: string; reasoning_details?: unknown } | null> => {
    let accumulated = "";
    const res = await doFetchStream(
      effectiveModel,
      toSend,
      tools,
      request.signal,
      apiKey,
    );
    const streamed = await consumeChatCompletionStream(res, (ch) => {
      accumulated += ch;
      onDelta(ch);
    });
    if (!streamed.ok) return null;
    // Some reasoning-capable models can finish a valid stream without any
    // user-visible `delta.content`. Treat that as a soft failure so we can
    // retry with the non-streaming path and recover the final answer.
    if (accumulated.trim().length === 0) return null;
    return {
      content: accumulated,
      ...(streamed.reasoning_details
        ? { reasoning_details: streamed.reasoning_details }
        : {}),
    };
  };

  try {
    throwIfAborted(signal);
    if (useWebSearch) {
      try {
        const acc = await runStream(payloadMessages, webTools);
        if (acc !== null) return acc;
      } catch (e) {
        console.warn(
          `[OpenRouter] Web search stream threw for ${effectiveModel}:`,
          e,
        );
      }
      console.warn(
        `[OpenRouter] Web search stream failed for ${effectiveModel}; retrying without web search tool.`,
      );
      try {
        const acc = await runStream(messages, undefined);
        if (acc !== null) return { ...acc, webSearchSkipped: true };
      } catch (e) {
        console.error(
          `[OpenRouter] Stream without web search failed for ${effectiveModel}:`,
          e,
        );
      }
      const fb = await queryModel(model, messages, restQuery);
      if (fb?.content) {
        onDelta(fb.content);
        return fb;
      }
      return null;
    }

    try {
      const acc = await runStream(messages, undefined);
      if (acc !== null) return acc;
    } catch (e) {
      console.error(`[OpenRouter] Stream failed for ${effectiveModel}:`, e);
    }
    const fb = await queryModel(model, messages, restQuery);
    if (fb?.content) {
      onDelta(fb.content);
      return fb;
    }
    return null;
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") throw e;
    console.error(`Error streaming model ${model}:`, e);
    return null;
  } finally {
    request.cleanup();
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
