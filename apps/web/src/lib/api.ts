const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";

const API_KEY_STORAGE = "llm-council-search-openrouter-key";

export function getStoredApiKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(API_KEY_STORAGE) ?? "";
}

export function setStoredApiKey(key: string): void {
  if (typeof window === "undefined") return;
  if (key.trim()) {
    localStorage.setItem(API_KEY_STORAGE, key.trim());
  } else {
    localStorage.removeItem(API_KEY_STORAGE);
  }
}

function authHeaders(): Record<string, string> {
  const key = getStoredApiKey();
  return key ? { "X-OpenRouter-Key": key } : {};
}

export type ConversationMeta = {
  id: string;
  created_at: string;
  title: string;
  message_count: number;
};

export type Conversation = {
  id: string;
  created_at: string;
  title: string;
  messages: unknown[];
};

export type WebSearchMode = "off" | "auto" | "on";

export type ApiConfig = {
  council_models: string[];
  /** 推荐用于 OpenRouter 联网（`openrouter:web_search`）的模型 ID */
  web_search_models?: string[];
  chairman_model: string;
  title_model: string;
  web_fetch_model?: string;
  /** 已知模型的大致上下文上限（tokens），用于主席阶段预估 */
  chairman_context_limits?: Record<string, number>;
  chairman_output_reserve_tokens?: number;
};

export async function fetchConfig(): Promise<ApiConfig> {
  const res = await fetch(`${API_BASE}/api/config`);
  if (!res.ok) throw new Error("Failed to load config");
  return res.json();
}

export async function listConversations(): Promise<ConversationMeta[]> {
  const res = await fetch(`${API_BASE}/api/conversations`);
  if (!res.ok) throw new Error("Failed to list conversations");
  return res.json();
}

export async function createConversation(): Promise<Conversation> {
  const res = await fetch(`${API_BASE}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error("Failed to create conversation");
  return res.json();
}

export async function getConversation(id: string): Promise<Conversation> {
  const res = await fetch(`${API_BASE}/api/conversations/${id}`);
  if (!res.ok) throw new Error("Failed to get conversation");
  return res.json();
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/conversations/${id}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) throw new Error("Failed to delete");
}

export type SendOptions = {
  chairman_model?: string;
  web_fetch_model?: string;
  use_web_search?: boolean;
  use_web_search_mode?: WebSearchMode;
  judge_weights?: Record<string, number>;
};

export async function sendMessage(
  conversationId: string,
  content: string,
  options?: SendOptions,
) {
  const res = await fetch(
    `${API_BASE}/api/conversations/${conversationId}/message`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        content,
        chairman_model: options?.chairman_model,
        web_fetch_model: options?.web_fetch_model,
        use_web_search: options?.use_web_search,
        use_web_search_mode: options?.use_web_search_mode,
        judge_weights: options?.judge_weights,
      }),
    },
  );
  if (!res.ok) throw new Error("Failed to send message");
  return res.json();
}

export async function sendMessageStream(
  conversationId: string,
  content: string,
  onEvent: (type: string, event: Record<string, unknown>) => void,
  options?: SendOptions,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/conversations/${conversationId}/message/stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      signal,
      body: JSON.stringify({
        content,
        chairman_model: options?.chairman_model,
        web_fetch_model: options?.web_fetch_model,
        use_web_search: options?.use_web_search,
        use_web_search_mode: options?.use_web_search_mode,
        judge_weights: options?.judge_weights,
      }),
    },
  );

  if (!res.ok) throw new Error("Failed to send message");
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6)) as Record<string, unknown> & {
            type: string;
          };
          onEvent(event.type, event);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export type RerunOpts = {
  use_web_search?: boolean;
  use_web_search_mode?: WebSearchMode;
  chairman_model?: string;
  judge_weights?: Record<string, number>;
  /** 跳过主席上下文检查并强制调用 Stage3 */
  skip_chairman_context_check?: boolean;
};

export async function rerunStage1(
  conversationId: string,
  msgIndex: number,
  opts?: RerunOpts,
) {
  const res = await fetch(
    `${API_BASE}/api/conversations/${conversationId}/messages/${msgIndex}/rerun-stage1`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        use_web_search: opts?.use_web_search,
        use_web_search_mode: opts?.use_web_search_mode,
      }),
    },
  );
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(j.detail ?? "Rerun stage1 failed");
  }
  return res.json() as Promise<{
    stage1: Array<{ model: string; response: string; webSearchSkipped?: boolean }>;
    stale: { stage2: boolean; stage3: boolean };
  }>;
}

export async function rerunStage1Model(
  conversationId: string,
  msgIndex: number,
  model: string,
  opts?: RerunOpts,
) {
  const res = await fetch(
    `${API_BASE}/api/conversations/${conversationId}/messages/${msgIndex}/rerun-stage1-model`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        model,
        use_web_search: opts?.use_web_search,
        use_web_search_mode: opts?.use_web_search_mode,
      }),
    },
  );
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(j.detail ?? "Rerun stage1 failed");
  }
  return res.json() as Promise<{
    stage1: Array<{ model: string; response: string }>;
    stale: { stage2: boolean; stage3: boolean };
    webSearchSkipped?: boolean;
  }>;
}

export async function rerunStage2(
  conversationId: string,
  msgIndex: number,
  opts?: RerunOpts,
) {
  const res = await fetch(
    `${API_BASE}/api/conversations/${conversationId}/messages/${msgIndex}/rerun-stage2`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        use_web_search: opts?.use_web_search,
        use_web_search_mode: opts?.use_web_search_mode,
        judge_weights: opts?.judge_weights,
      }),
    },
  );
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(j.detail ?? "Rerun stage2 failed");
  }
  return res.json() as Promise<{
    stage2: Array<{
      model: string;
      ranking: string;
      parsed_ranking: string[];
    }>;
    metadata: {
      label_to_model: Record<string, string>;
      aggregate_rankings: Array<{
        model: string;
        average_rank: number;
        rankings_count: number;
      }>;
    };
    stale: { stage2: boolean; stage3: boolean };
  }>;
}

// ─── localStorage conversation management ─────────────────────────────────────

const LOCAL_CONVERSATIONS_KEY = "llm-council-search-local-conversations";

export type StoredMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      schemaVersion?: number;
      assistantMessageId: string;
      webFetch?: unknown;
      stage1: unknown[];
      stage2: unknown[];
      stage3: unknown;
      stale?: { stage2: boolean; stage3: boolean };
      metadata?: unknown;
    };

export type StoredConversation = {
  id: string;
  created_at: string;
  title: string;
  messages: StoredMessage[];
};

function readLocalConversations(): StoredConversation[] {
  if (typeof window === "undefined") return [];
  try {
    const s = localStorage.getItem(LOCAL_CONVERSATIONS_KEY);
    if (!s) return [];
    return JSON.parse(s) as StoredConversation[];
  } catch {
    return [];
  }
}

function writeLocalConversations(convs: StoredConversation[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(LOCAL_CONVERSATIONS_KEY, JSON.stringify(convs));
}

export function listLocalConversations(): ConversationMeta[] {
  return readLocalConversations()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((c) => ({
      id: c.id,
      created_at: c.created_at,
      title: c.title ?? "New Conversation",
      message_count: c.messages?.length ?? 0,
    }));
}

export function getLocalConversation(id: string): Conversation | null {
  const conv = readLocalConversations().find((c) => c.id === id);
  return conv ? (conv as unknown as Conversation) : null;
}

export function createLocalConversation(): Conversation {
  const conv: StoredConversation = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    title: "New Conversation",
    messages: [],
  };
  const all = readLocalConversations();
  writeLocalConversations([...all, conv]);
  return conv as unknown as Conversation;
}

export function saveLocalConversation(conv: Conversation): void {
  const all = readLocalConversations();
  const idx = all.findIndex((c) => c.id === conv.id);
  const stored = conv as unknown as StoredConversation;
  if (idx === -1) writeLocalConversations([...all, stored]);
  else {
    const next = [...all];
    next[idx] = stored;
    writeLocalConversations(next);
  }
}

export function deleteLocalConversation(id: string): void {
  writeLocalConversations(readLocalConversations().filter((c) => c.id !== id));
}

export function updateLocalConversationTitle(id: string, title: string): void {
  const all = readLocalConversations();
  const idx = all.findIndex((c) => c.id === id);
  if (idx === -1) return;
  const next = [...all];
  next[idx] = { ...next[idx], title };
  writeLocalConversations(next);
}

// ─── Stateless stream (localStorage mode) ─────────────────────────────────────

export async function sendMessageStatelessStream(
  content: string,
  messages: unknown[],
  onEvent: (type: string, event: Record<string, unknown>) => void,
  options?: SendOptions,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/message/stateless/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    signal,
    body: JSON.stringify({
      content,
      messages,
      chairman_model: options?.chairman_model,
      web_fetch_model: options?.web_fetch_model,
      use_web_search: options?.use_web_search,
      use_web_search_mode: options?.use_web_search_mode,
      judge_weights: options?.judge_weights,
    }),
  });

  if (!res.ok) throw new Error("Failed to send message");
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6)) as Record<string, unknown> & { type: string };
          onEvent(event.type, event);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

// ─── Stateless rerun operations (localStorage mode) ───────────────────────────

type StatelessRerunBase = {
  user_query: string;
  history_messages: unknown[];
};

export async function rerunStage1Stateless(
  params: StatelessRerunBase & {
    web_fetch?: unknown;
    use_web_search?: boolean;
    use_web_search_mode?: WebSearchMode;
  },
) {
  const res = await fetch(`${API_BASE}/api/message/stateless/rerun-stage1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(j.detail ?? "Rerun stage1 failed");
  }
  return res.json() as Promise<{
    stage1: Array<{ model: string; response: string; webSearchSkipped?: boolean }>;
    stale: { stage2: boolean; stage3: boolean };
  }>;
}

export async function rerunStage1ModelStateless(
  params: StatelessRerunBase & {
    model: string;
    stage1: Array<{ model: string; response: string }>;
    use_web_search?: boolean;
    use_web_search_mode?: WebSearchMode;
  },
) {
  const res = await fetch(`${API_BASE}/api/message/stateless/rerun-stage1-model`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(j.detail ?? "Rerun stage1 model failed");
  }
  return res.json() as Promise<{
    stage1: Array<{ model: string; response: string }>;
    stale: { stage2: boolean; stage3: boolean };
    webSearchSkipped?: boolean;
  }>;
}

export async function rerunStage2Stateless(
  params: StatelessRerunBase & {
    stage1: Array<{ model: string; response: string }>;
    use_web_search?: boolean;
    use_web_search_mode?: WebSearchMode;
    judge_weights?: Record<string, number>;
  },
) {
  const res = await fetch(`${API_BASE}/api/message/stateless/rerun-stage2`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(j.detail ?? "Rerun stage2 failed");
  }
  return res.json() as Promise<{
    stage2: Array<{ model: string; ranking: string; parsed_ranking: string[] }>;
    metadata: { label_to_model: Record<string, string>; aggregate_rankings: Array<{ model: string; average_rank: number; rankings_count: number }> };
    stale: { stage2: boolean; stage3: boolean };
  }>;
}

export async function rerunStage3Stateless(
  params: StatelessRerunBase & {
    stage1: Array<{ model: string; response: string }>;
    stage2: Array<{ model: string; ranking: string; parsed_ranking: string[] }>;
    web_fetch?: unknown;
    chairman_model?: string;
    judge_weights?: Record<string, number>;
    use_web_search?: boolean;
    use_web_search_mode?: WebSearchMode;
    skip_chairman_context_check?: boolean;
  },
) {
  const res = await fetch(`${API_BASE}/api/message/stateless/rerun-stage3`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as {
      detail?: string;
      chairman_context?: {
        chairman_model: string;
        estimated_input_tokens: number;
        context_limit: number;
        max_input_tokens: number;
      };
      suggested_models?: string[];
    };
    if (res.status === 409 && j.detail === "chairman_context_exceeded") {
      const hint =
        j.chairman_context && j.suggested_models?.length
          ? ` 建议改用：${j.suggested_models.slice(0, 5).join("、")}`
          : "";
      throw new Error(
        `主席模型上下文可能不足（估算输入约 ${j.chairman_context?.estimated_input_tokens ?? "?"} tokens，可用上限约 ${j.chairman_context?.max_input_tokens ?? "?"}）。请在设置中更换主席模型后重试，或使用弹窗中的「强制尝试」。${hint}`,
      );
    }
    throw new Error(j.detail ?? "Rerun stage3 failed");
  }
  return res.json() as Promise<{
    stage3: { model: string; response: string };
    stale: { stage2: boolean; stage3: boolean };
  }>;
}

export async function rerunStage3(
  conversationId: string,
  msgIndex: number,
  opts?: RerunOpts,
) {
  const res = await fetch(
    `${API_BASE}/api/conversations/${conversationId}/messages/${msgIndex}/rerun-stage3`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        use_web_search: opts?.use_web_search,
        use_web_search_mode: opts?.use_web_search_mode,
        chairman_model: opts?.chairman_model,
        judge_weights: opts?.judge_weights,
        skip_chairman_context_check: opts?.skip_chairman_context_check,
      }),
    },
  );
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as {
      detail?: string;
      chairman_context?: {
        chairman_model: string;
        estimated_input_tokens: number;
        context_limit: number;
        max_input_tokens: number;
      };
      suggested_models?: string[];
    };
    if (res.status === 409 && j.detail === "chairman_context_exceeded") {
      const hint =
        j.chairman_context && j.suggested_models?.length
          ? ` 建议改用：${j.suggested_models.slice(0, 5).join("、")}`
          : "";
      throw new Error(
        `主席模型上下文可能不足（估算输入约 ${j.chairman_context?.estimated_input_tokens ?? "?"} tokens，可用上限约 ${j.chairman_context?.max_input_tokens ?? "?"}）。请在设置中更换主席模型后重试，或使用弹窗中的「强制尝试」。${hint}`,
      );
    }
    throw new Error(j.detail ?? "Rerun stage3 failed");
  }
  return res.json() as Promise<{
    stage3: { model: string; response: string };
    stale: { stage2: boolean; stage3: boolean };
  }>;
}
