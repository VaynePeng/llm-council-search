const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";

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

export type ApiConfig = {
  council_models: string[];
  chairman_model: string;
  title_model: string;
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
    headers: { "Content-Type": "application/json" },
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
  use_web_search?: boolean;
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        chairman_model: options?.chairman_model,
        use_web_search: options?.use_web_search,
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
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/conversations/${conversationId}/message/stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        chairman_model: options?.chairman_model,
        use_web_search: options?.use_web_search,
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
  chairman_model?: string;
  judge_weights?: Record<string, number>;
};

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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        use_web_search: opts?.use_web_search,
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        use_web_search: opts?.use_web_search,
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

export async function rerunStage3(
  conversationId: string,
  msgIndex: number,
  opts?: RerunOpts,
) {
  const res = await fetch(
    `${API_BASE}/api/conversations/${conversationId}/messages/${msgIndex}/rerun-stage3`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        use_web_search: opts?.use_web_search,
        chairman_model: opts?.chairman_model,
        judge_weights: opts?.judge_weights,
      }),
    },
  );
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(j.detail ?? "Rerun stage3 failed");
  }
  return res.json() as Promise<{
    stage3: { model: string; response: string };
    stale: { stage2: boolean; stage3: boolean };
  }>;
}
