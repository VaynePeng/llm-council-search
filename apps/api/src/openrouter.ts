import { OPENROUTER_API_KEY, OPENROUTER_API_URL } from "./config.js";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type QueryOptions = {
  timeoutMs?: number;
  useWebSearch?: boolean;
};

function webPluginsBody(): Record<string, unknown> {
  return {
    plugins: [{ id: "web", max_results: 5 }],
  };
}

async function doFetch(
  model: string,
  messages: ChatMessage[],
  useWebSearch: boolean,
  signal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
  };

  const body: Record<string, unknown> = {
    model,
    messages,
    ...(useWebSearch ? webPluginsBody() : {}),
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
): Promise<{ content: string; reasoning_details?: unknown; webSearchSkipped?: boolean } | null> {
  const { timeoutMs = 120_000, useWebSearch = false } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const parseSuccess = async (
    res: Response,
  ): Promise<{ content: string; reasoning_details?: unknown } | null> => {
    if (!res.ok) {
      const text = await res.text();
      console.error(`OpenRouter error ${model}:`, res.status, text);
      return null;
    }
    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string; reasoning_details?: unknown };
      }>;
    };
    const message = data.choices?.[0]?.message;
    if (!message) return null;
    return {
      content: message.content ?? "",
      reasoning_details: message.reasoning_details,
    };
  };

  try {
    if (useWebSearch) {
      const resWith = await doFetch(model, messages, true, controller.signal);
      const ok = await parseSuccess(resWith);
      if (ok) return ok;
      console.warn(
        `[OpenRouter] Web search request failed for ${model}; retrying without web plugin.`,
      );
      const resNo = await doFetch(model, messages, false, controller.signal);
      const fallback = await parseSuccess(resNo);
      if (fallback) return { ...fallback, webSearchSkipped: true };
      return null;
    }

    const res = await doFetch(model, messages, false, controller.signal);
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
