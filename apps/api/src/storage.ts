import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./config.js";

export type AggregateRanking = {
  model: string;
  average_rank: number;
  rankings_count: number;
};

export type WebFetchSource = {
  url: string;
  title?: string;
  snippet?: string;
};

export type WebFetchResult = {
  model: string;
  content: string;
  webSearchSkipped?: boolean;
  /** ISO 8601 UTC，检索发起时刻；前端可用 dayjs 转本机时区展示 */
  retrievedAt?: string;
  retrievedAtUnixSeconds?: number;
  /** OpenRouter 返回的结构化 URL 引用，供 UI 与 Stage1 核对 */
  sources?: WebFetchSource[];
};

export type Stage1Item = {
  model: string;
  response: string;
  webSearchSkipped?: boolean;
};
export type Stage2Item = {
  model: string;
  ranking: string;
  parsed_ranking: string[];
};
export type Stage3Result = { model: string; response: string };

export type UserMessage = { role: "user"; content: string };

export type AssistantMessage = {
  role: "assistant";
  schemaVersion?: number;
  assistantMessageId: string;
  webFetch?: WebFetchResult;
  stage1: Stage1Item[];
  stage2: Stage2Item[];
  stage3: Stage3Result;
  /** After Stage1 partial rerun, later stages may be outdated */
  stale?: { stage2: boolean; stage3: boolean };
  /** Persisted for reload (label map + aggregate table) */
  metadata?: {
    label_to_model: Record<string, string>;
    aggregate_rankings: AggregateRanking[];
  };
};

export type Message = UserMessage | AssistantMessage;

export type Conversation = {
  id: string;
  created_at: string;
  title: string;
  messages: Message[];
};

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function conversationPath(id: string): string {
  return path.join(DATA_DIR, `${id}.json`);
}

function migrateConversationInPlace(c: Conversation): boolean {
  let dirty = false;
  for (const m of c.messages) {
    if (m.role !== "assistant") continue;
    const a = m as AssistantMessage;
    if (!a.assistantMessageId) {
      a.assistantMessageId = randomUUID();
      dirty = true;
    }
    if (!a.stale) {
      a.stale = { stage2: false, stage3: false };
      dirty = true;
    }
    if (a.schemaVersion == null) {
      a.schemaVersion = 1;
      dirty = true;
    }
  }
  return dirty;
}

export async function createConversation(id: string): Promise<Conversation> {
  await ensureDataDir();
  const conversation: Conversation = {
    id,
    created_at: new Date().toISOString(),
    title: "New Conversation",
    messages: [],
  };
  await fs.writeFile(
    conversationPath(id),
    JSON.stringify(conversation, null, 2),
    "utf8",
  );
  return conversation;
}

export async function getConversation(id: string): Promise<Conversation | null> {
  try {
    const raw = await fs.readFile(conversationPath(id), "utf8");
    const c = JSON.parse(raw) as Conversation;
    if (migrateConversationInPlace(c)) {
      await saveConversation(c);
    }
    return c;
  } catch {
    return null;
  }
}

export async function saveConversation(c: Conversation): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(
    conversationPath(c.id),
    JSON.stringify(c, null, 2),
    "utf8",
  );
}

export type ConversationMetadata = {
  id: string;
  created_at: string;
  title: string;
  message_count: number;
};

export async function listConversations(): Promise<ConversationMetadata[]> {
  await ensureDataDir();
  const names = await fs.readdir(DATA_DIR);
  const out: ConversationMetadata[] = [];

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(DATA_DIR, name), "utf8");
      const data = JSON.parse(raw) as Conversation;
      out.push({
        id: data.id,
        created_at: data.created_at,
        title: data.title ?? "New Conversation",
        message_count: data.messages?.length ?? 0,
      });
    } catch {
      /* skip */
    }
  }

  out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return out;
}

export async function addUserMessage(
  conversationId: string,
  content: string,
): Promise<void> {
  const c = await getConversation(conversationId);
  if (!c) throw new Error(`Conversation ${conversationId} not found`);
  c.messages.push({ role: "user", content });
  await saveConversation(c);
}

export async function addAssistantMessage(
  conversationId: string,
  stage1: Stage1Item[],
  stage2: Stage2Item[],
  stage3: Stage3Result,
  metadata?: AssistantMessage["metadata"],
  webFetch?: WebFetchResult,
): Promise<void> {
  const c = await getConversation(conversationId);
  if (!c) throw new Error(`Conversation ${conversationId} not found`);
  const msg: AssistantMessage = {
    role: "assistant",
    schemaVersion: 1,
    assistantMessageId: randomUUID(),
    ...(webFetch ? { webFetch } : {}),
    stage1,
    stage2,
    stage3,
    stale: { stage2: false, stage3: false },
    ...(metadata ? { metadata } : {}),
  };
  c.messages.push(msg);
  await saveConversation(c);
}

export async function updateConversationTitle(
  conversationId: string,
  title: string,
): Promise<void> {
  const c = await getConversation(conversationId);
  if (!c) throw new Error(`Conversation ${conversationId} not found`);
  c.title = title;
  await saveConversation(c);
}

export async function deleteConversation(id: string): Promise<boolean> {
  try {
    await fs.unlink(conversationPath(id));
    return true;
  } catch {
    return false;
  }
}

export function isAssistantMessage(m: Message): m is AssistantMessage {
  return m.role === "assistant";
}

export function findPreviousUserQuery(messages: Message[], assistantIndex: number): string {
  for (let i = assistantIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return m.content;
  }
  return "";
}
