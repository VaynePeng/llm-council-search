import { TAVILY_API_URL } from "./config.js";

export type TavilySearchResult = {
  title?: string;
  url: string;
  content?: string;
  published_date?: string;
  score?: number;
};

type TavilyResponse = {
  results?: TavilySearchResult[];
  answer?: string;
  query?: string;
  response_time?: number;
};

export type TavilySearchOptions = {
  apiKey: string;
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
  timeoutMs?: number;
  signal?: AbortSignal;
};

function createTimeoutSignal(
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
      if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
    },
  };
}

export function resolveTavilyApiKey(override?: string): string {
  const key = override?.trim();
  if (!key) {
    throw new Error("Tavily API key required via X-Tavily-Key header");
  }
  return key;
}

export async function tavilySearch(
  query: string,
  options: TavilySearchOptions,
): Promise<TavilySearchResult[]> {
  const apiKey = resolveTavilyApiKey(options.apiKey);
  const request = createTimeoutSignal(options.timeoutMs ?? 30_000, options.signal);
  try {
    const res = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: options.searchDepth ?? "advanced",
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        max_results: Math.min(10, Math.max(1, options.maxResults ?? 5)),
      }),
      signal: request.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Tavily search failed: HTTP ${res.status} ${text}`);
    }

    const data = (await res.json()) as TavilyResponse;
    return (data.results ?? []).filter(
      (item): item is TavilySearchResult =>
        Boolean(item?.url && typeof item.url === "string"),
    );
  } finally {
    request.cleanup();
  }
}
