import { OFOX_API_URL } from "./config.js";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  reasoning_details?: unknown;
};

/** Ofox 对 web 结果的 `url_citation` 标注（与 Chat Completions message 对齐） */
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
    `When you use the model's web search capability, anchor retrieval time to ${isoUtc} (ISO 8601, UTC). ` +
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
  /** 预留的联网搜索结果上限（默认 5） */
  webMaxResults?: number;
  /** 与聊天提示词共用同一时间锚，与注入的 system 补充说明一致 */
  webSearchTemporalContext?: WebSearchTemporalContext;
  /** 由前端传入的用户 API Key */
  apiKey?: string;
  /** 外部取消信号，例如客户端中止会话流时同步中断上游请求 */
  signal?: AbortSignal;
};

export type QueryModelsParallelProgress = {
  model: string;
  status: "start" | "complete" | "error";
  current: number;
  total: number;
};

function abortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isConnectionResetError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const cause = (e as { cause?: unknown }).cause;
  if (cause instanceof Error && (cause as { code?: string }).code === "ECONNRESET") return true;
  return (e as { code?: string }).code === "ECONNRESET";
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (isConnectionResetError(e)) {
      // 连接池里的旧连接被服务端/代理重置，重试一次
      return fetch(url, init);
    }
    throw e;
  }
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

/** `:online` 变体与显式联网二选一即可；去掉后缀避免重复触发模型侧联网能力。 */
function stripOnlineSuffix(model: string): string {
  return model.endsWith(":online") ? model.slice(0, -":online".length) : model;
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
    throw new Error("Ofox API key required via X-Ofox-Key header");
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

  return fetchWithRetry(OFOX_API_URL, {
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

  return fetchWithRetry(OFOX_API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(chatRequestBody(model, messages, tools, true)),
    signal,
  });
}

/** 解析 OpenAI 兼容 SSE 流，将正文增量交给 onDelta */
async function consumeChatCompletionStream(
  res: Response,
  onDelta: (chunk: string) => void,
): Promise<{ ok: boolean; reasoning_details?: unknown[] }> {
  if (!res.ok) {
    const text = await res.text();
    console.error("Ofox stream HTTP error:", res.status, text);
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
          console.error("Ofox stream chunk error:", j.error.message);
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

  void webMaxResults;
  const effectiveModel = useWebSearch ? stripOnlineSuffix(model) : model;
  const payloadMessages = useWebSearch
    ? withWebSearchSystemInstruction(messages, webSearchTemporalContext)
    : messages;

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
      console.error(`Ofox error ${effectiveModel}:`, res.status, text);
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
    const res = await doFetch(
      effectiveModel,
      payloadMessages,
      undefined,
      request.signal,
      apiKey,
    );
    const result = await parseSuccess(res);
    return result
      ? {
          ...result,
          ...(useWebSearch ? { webSearchSkipped: true } : {}),
        }
      : null;
  } catch (e) {
    // 只在外部信号取消时才 re-throw，内部超时产生的 AbortError 视为模型失败
    if ((e as { name?: string })?.name === "AbortError" && signal?.aborted) throw e;
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
 * 流式调用模型（Ofox `stream: true`），通过 onDelta 推送正文增量。
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

  void webMaxResults;
  const effectiveModel = useWebSearch ? stripOnlineSuffix(model) : model;
  const payloadMessages = useWebSearch
    ? withWebSearchSystemInstruction(messages, webSearchTemporalContext)
    : messages;

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
    try {
      const acc = await runStream(payloadMessages, undefined);
      if (acc !== null) {
        return useWebSearch ? { ...acc, webSearchSkipped: true } : acc;
      }
    } catch (e) {
      console.error(`[Ofox] Stream failed for ${effectiveModel}:`, e);
    }
    const fb = await queryModel(model, payloadMessages, {
      ...restQuery,
      useWebSearch: false,
      webSearchTemporalContext: undefined,
      webMaxResults: undefined,
    });
    if (fb?.content) {
      onDelta(fb.content);
      return fb;
    }
    return null;
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError" && signal?.aborted) throw e;
    console.error(`Error streaming model ${model}:`, e);
    return null;
  } finally {
    request.cleanup();
  }
}

export async function queryModelsParallel(
  models: string[],
  messages: ChatMessage[],
  options: QueryOptions & {
    onProgress?: (event: QueryModelsParallelProgress) => void;
  } = {},
): Promise<Map<string, Awaited<ReturnType<typeof queryModel>>>> {
  const { onProgress, ...queryOptions } = options;
  let completed = 0;
  const entries = await Promise.all(
    models.map(async (model) => {
      onProgress?.({
        model,
        status: "start",
        current: completed,
        total: models.length,
      });
      const r = await queryModel(model, messages, queryOptions);
      completed += 1;
      onProgress?.({
        model,
        status: r == null ? "error" : "complete",
        current: completed,
        total: models.length,
      });
      return [model, r] as const;
    }),
  );
  return new Map(entries);
}
