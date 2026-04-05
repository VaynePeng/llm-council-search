"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTheme } from "next-themes";
import ReactMarkdown from "react-markdown";
import {
  Check,
  Download,
  Loader2,
  Menu,
  Moon,
  RefreshCw,
  Settings2,
  Sun,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  createConversation,
  createLocalConversation,
  deleteConversation,
  deleteLocalConversation,
  fetchConfig,
  getConversation,
  getLocalConversation,
  getStoredApiKey,
  listConversations,
  listLocalConversations,
  rerunStage1,
  rerunStage1Model,
  rerunStage1ModelStateless,
  rerunStage1Stateless,
  rerunStage2,
  rerunStage2Stateless,
  rerunStage3,
  rerunStage3Stateless,
  saveLocalConversation,
  sendMessageStatelessStream,
  sendMessageStream,
  setStoredApiKey,
  updateLocalConversationTitle,
  type ApiConfig,
  type Conversation,
  type ConversationMeta,
  type WebSearchMode,
} from "@/lib/api";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import dayjs from "dayjs";

const WEIGHTS_STORAGE = "llm-council-search-judge-weights";
const PREFS_STORAGE = "llm-council-search-ui-prefs";
const MIN_STAGE2_MODELS = 2;

type StoredUiPrefs = {
  councilModels?: string[];
  webSearchMode?: WebSearchMode;
  chairmanSelect?: string;
  chairmanCustom?: string;
  followupSelect?: string;
  followupCustom?: string;
  webFetchSelect?: string;
  webFetchCustom?: string;
  storageMode?: "server" | "local";
  filterUntrustedSources?: boolean;
  continueUseWebSearch?: boolean;
};

function loadUiPrefs(): StoredUiPrefs {
  if (typeof window === "undefined") return {};
  try {
    const s = localStorage.getItem(PREFS_STORAGE);
    if (!s) return {};
    return JSON.parse(s) as StoredUiPrefs;
  } catch {
    return {};
  }
}

function modelShortName(model: string): string {
  const p = model.split("/").pop();
  return p && p.length > 0 ? p : model;
}

function formatContextLimit(limit?: number): string | null {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return null;
  if (limit >= 1_000_000) return `${(limit / 1_000_000).toFixed(limit % 1_000_000 === 0 ? 0 : 1)}M`;
  if (limit >= 1_000) return `${Math.round(limit / 1_000)}k`;
  return String(limit);
}

function modelTitleWithContext(
  model: string,
  contextLimits?: Record<string, number>,
): string {
  const formatted = formatContextLimit(contextLimits?.[model]);
  return formatted ? `${model} · 上下文 ${formatted}` : model;
}

type ModelSelectSection = {
  key: string;
  label: string;
  items: Array<{
    key: string;
    value: string;
    label: string;
    disabled?: boolean;
  }>;
};

function buildModelSelectSections(
  baseSections: Array<{ key: string; label: string; models: string[] }>,
  featuredProviders: NonNullable<ApiConfig["featured_model_groups"]>,
  contextLimits?: Record<string, number>,
): ModelSelectSection[] {
  const seen = new Set<string>();
  const sections: ModelSelectSection[] = [];

  for (const section of baseSections) {
    const models = section.models.filter((model, index, list) => {
      if (!model || list.indexOf(model) !== index || seen.has(model)) return false;
      seen.add(model);
      return true;
    });
    if (!models.length) continue;
    sections.push({
      key: section.key,
      label: section.label,
      items: models.map((model) => ({
        key: `${section.key}-${model}`,
        value: model,
        label: modelTitleWithContext(model, contextLimits),
      })),
    });
  }

  for (const provider of featuredProviders) {
    const latest = provider.latest.filter((model) => {
      if (seen.has(model)) return false;
      seen.add(model);
      return true;
    });
    const free = provider.free.filter((model) => {
      if (seen.has(model)) return false;
      seen.add(model);
      return true;
    });

    sections.push({
      key: provider.key,
      label: provider.label,
      items: [
        ...latest.map((model, index) => ({
          key: `${provider.key}-latest-${model}`,
          value: model,
          label: `最新 ${index + 1} · ${modelTitleWithContext(model, contextLimits)}`,
        })),
        ...(free.length
          ? free.map((model, index) => ({
              key: `${provider.key}-free-${model}`,
              value: model,
              label: `免费 ${index + 1} · ${modelTitleWithContext(model, contextLimits)}`,
            }))
          : [
              {
                key: `${provider.key}-free-empty`,
                value: `__${provider.key}-free-empty__`,
                label: "免费 · 暂无",
                disabled: true,
              },
            ]),
      ],
    });
  }

  return sections;
}

function buildWebFetchModelSections(
  webSearchModels: string[],
  webFetchModel: string | undefined,
  featuredProviders: NonNullable<ApiConfig["featured_model_groups"]>,
  contextLimits?: Record<string, number>,
): ModelSelectSection[] {
  const recommended = [...new Set([...webSearchModels, webFetchModel ?? ""])].filter(Boolean);
  const sections = buildModelSelectSections(
    [
      {
        key: "web-fetch-recommended",
        label: "推荐联网模型",
        models: recommended,
      },
    ],
    featuredProviders,
    contextLimits,
  );

  return sections.map((section) => ({
    ...section,
    items: section.items.map((item, index) => {
      const isDefault = item.value === webFetchModel && Boolean(webFetchModel);
      const prefix = [
        "推荐",
        isDefault ? "默认" : null,
        section.key === "web-fetch-recommended" ? `${index + 1}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        ...item,
        label: section.key === "web-fetch-recommended"
          ? `${prefix} · ${item.label}`
          : item.label,
      };
    }),
  }));
}

function renderModelSelectSections(sections: ModelSelectSection[]) {
  return sections.map((section, index) => (
    <Fragment key={section.key}>
      <SelectGroup>
        <SelectLabel>{section.label}</SelectLabel>
        {section.items.map((item) => (
          <SelectItem key={item.key} value={item.value} disabled={item.disabled}>
            {item.label}
          </SelectItem>
        ))}
      </SelectGroup>
      {index < sections.length - 1 ? <SelectSeparator /> : null}
    </Fragment>
  ));
}

function formatCredibilityLabel(credibility?: "high" | "medium" | "low"): string | undefined {
  if (!credibility) return undefined;
  if (credibility === "high") return "高可信";
  if (credibility === "medium") return "中可信";
  return "低可信";
}

function credibilityBadgeVariant(
  credibility?: "high" | "medium" | "low",
): "secondary" | "outline" | "warning" {
  if (credibility === "high") return "secondary";
  if (credibility === "low") return "warning";
  return "outline";
}

function formatCredibilityScore(score?: number): string | undefined {
  if (score == null || !Number.isFinite(score)) return undefined;
  return `${(score * 10).toFixed(1)}/10`;
}

function summarizeCredibility(sources: WebFetchSource[]): string {
  const counts = { high: 0, medium: 0, low: 0 };
  sources.forEach((source) => {
    if (source.credibility === "high") counts.high += 1;
    else if (source.credibility === "low") counts.low += 1;
    else counts.medium += 1;
  });

  const parts: string[] = [];
  if (counts.high) parts.push(`高可信 ${counts.high}`);
  if (counts.medium) parts.push(`中可信 ${counts.medium}`);
  if (counts.low) parts.push(`低可信 ${counts.low}`);
  return parts.length ? parts.join(" · ") : `共 ${sources.length} 条来源`;
}

function sourceHostnameLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function compareWebFetchSources(a: WebFetchSource, b: WebFetchSource): number {
  const scoreDelta = (b.credibilityScore ?? -1) - (a.credibilityScore ?? -1);
  if (scoreDelta !== 0) return scoreDelta;

  const bWeight = normalizeReferenceWeight(b.referenceWeight ?? b.referenceWeightRaw) ?? -1;
  const aWeight = normalizeReferenceWeight(a.referenceWeight ?? a.referenceWeightRaw) ?? -1;
  const weightDelta = bWeight - aWeight;
  if (weightDelta !== 0) return weightDelta;

  const hostDelta = sourceHostnameLabel(a.url).localeCompare(sourceHostnameLabel(b.url));
  if (hostDelta !== 0) return hostDelta;

  return (a.title ?? a.url).localeCompare(b.title ?? b.url);
}

function formatSourceLine(source: WebFetchSource): string {
  const title = source.title?.trim();
  const bits = [
    title ? `[${title}](${source.url})` : source.url,
    source.sourceType,
    source.referenceWeight != null ? `参考权重 ${formatReferenceWeight(source.referenceWeight)}` : undefined,
    source.credibility ? `可信度 ${formatCredibilityLabel(source.credibility)}` : undefined,
    source.credibilityScore != null ? `分数 ${formatCredibilityScore(source.credibilityScore)}` : undefined,
    source.credibilityReason,
  ].filter(Boolean);
  return `- ${bits.join(" | ")}`;
}

function sanitizeMarkdownBlock(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/^[ \t]*<a id="[^"]+"><\/a>[ \t]*\n?/gim, "")
    .replace(/^([ \t]*[-*+]?\s*\d*\.?\s*)\*\*\*\*\s+[—-]\s+(https?:\/\/\S+)\s*$/gim, "$1$2")
    .trim();
}

function toMarkdownHeadingAnchor(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function exportConversationMarkdown(conversation: Conversation): string {
  const messages = conversation.messages as unknown as (UserMsg | AssistantMsg)[];
  const toc: string[] = [];
  const parts = [`# ${conversation.title}`, "", `- 会话 ID: ${conversation.id}`, `- 创建时间: ${conversation.created_at}`, ""];

  messages.forEach((message, index) => {
    const turn = Math.floor(index / 2) + 1;
    if (message.role === "user") {
      const heading = `用户 ${turn}`;
      toc.push(`- [${heading}](#${toMarkdownHeadingAnchor(heading)})`);
      parts.push(`## ${heading}`, "", sanitizeMarkdownBlock(message.content), "");
      return;
    }

    const responseMode = message.responseMode === "followup" ? "继续对话" : "Council";
    const assistantHeading = `助手 ${turn} (${responseMode})`;
    toc.push(`- [${assistantHeading}](#${toMarkdownHeadingAnchor(assistantHeading)})`);
    parts.push(`## ${assistantHeading}`, "");

    if (message.webFetch) {
      const heading = `助手 ${turn} Web 抓取`;
      toc.push(`- [${heading}](#${toMarkdownHeadingAnchor(heading)})`);
      parts.push(`### ${heading}`, "");
      parts.push(`- 模型: ${message.webFetch.model}`);
      if (message.webFetch.webSearchReason) parts.push(`- 原因: ${message.webFetch.webSearchReason}`);
      if (message.webFetch.retrievedAt) parts.push(`- 检索时间: ${message.webFetch.retrievedAt}`);
      parts.push("", sanitizeMarkdownBlock(message.webFetch.content), "");
      if (message.webFetch.sources?.length) {
        parts.push("#### 结构化来源", "");
        parts.push(...message.webFetch.sources.map(formatSourceLine), "");
      }
    }

    if (message.responseMode === "followup") {
      if (message.stage3) {
        const heading = `助手 ${turn} 继续对话`;
        toc.push(`- [${heading}](#${toMarkdownHeadingAnchor(heading)})`);
        parts.push(`### ${heading}`, "", `- 模型: ${message.stage3.model}`, "", sanitizeMarkdownBlock(message.stage3.response), "");
      }
      return;
    }

    if (message.stage1?.length) {
      const heading = `助手 ${turn} Stage 1`;
      toc.push(`- [${heading}](#${toMarkdownHeadingAnchor(heading)})`);
      parts.push(`### ${heading}`, "");
      message.stage1.forEach((item, i) => {
        parts.push(`#### ${i + 1}. ${item.model}`, "", sanitizeMarkdownBlock(item.response), "");
      });
    }

    if (message.stage2?.length) {
      const heading = `助手 ${turn} Stage 2`;
      toc.push(`- [${heading}](#${toMarkdownHeadingAnchor(heading)})`);
      parts.push(`### ${heading}`, "");
      message.stage2.forEach((item, i) => {
        parts.push(`#### ${i + 1}. ${item.model}`, "", sanitizeMarkdownBlock(item.ranking), "");
      });
    }

    if (message.stage3) {
      const heading = `助手 ${turn} Stage 3`;
      toc.push(`- [${heading}](#${toMarkdownHeadingAnchor(heading)})`);
      parts.push(`### ${heading}`, "", `- 模型: ${message.stage3.model}`, "", sanitizeMarkdownBlock(message.stage3.response), "");
    }
  });

  if (toc.length) {
    parts.splice(4, 0, "## 目录", "", ...toc, "");
  }

  return `${parts.join("\n").trim()}\n`;
}

const markdownComponents: Record<string, React.ComponentType<React.AnchorHTMLAttributes<HTMLAnchorElement>>> = {
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

type WebFetchSource = {
  url: string;
  title?: string;
  snippet?: string;
  sourceType?: string;
  credibility?: "high" | "medium" | "low";
  credibilityScore?: number;
  referenceWeight?: number;
  referenceWeightRaw?: number;
  credibilityReason?: string;
  filteredOut?: boolean;
};

type WebFetchResult = {
  model: string;
  content: string;
  webSearchMode?: WebSearchMode;
  webSearchAction?: "skip" | "search" | "reuse";
  webSearchReason?: string;
  webSearchVerified?: boolean;
  webSearchWarning?: string;
  reusedFromPrevious?: boolean;
  webSearchSkipped?: boolean;
  retrievedAt?: string;
  retrievedAtUnixSeconds?: number;
  sources?: WebFetchSource[];
};

type Stage1Item = {
  model: string;
  response: string;
  failed?: boolean;
  error?: string;
  webSearchSkipped?: boolean;
};
type Stage2Item = {
  model: string;
  ranking: string;
  parsed_ranking: string[];
};
type Stage3 = { model: string; response: string; reasoning_details?: unknown };

type AssistantMsg = {
  role: "assistant";
  assistantMessageId?: string;
  responseMode?: "council" | "followup";
  pending?: boolean;
  webFetch?: WebFetchResult | null;
  stage1: Stage1Item[] | null;
  stage2: Stage2Item[] | null;
  stage3: Stage3 | null;
  metadata: {
    label_to_model?: Record<string, string>;
    aggregate_rankings?: Array<{
      model: string;
      average_rank: number;
      rankings_count: number;
    }>;
  } | null;
  loading: {
    webFetch: boolean;
    stage1: boolean;
    stage2: boolean;
    stage3: boolean;
  };
  stale?: { stage2: boolean; stage3: boolean };
};

function normalizeReferenceWeight(weight?: number): number | undefined {
  if (weight == null || !Number.isFinite(weight)) return undefined;
  const normalized = weight > 10 ? weight / 10 : weight;
  return Math.round(normalized * 10) / 10;
}

function formatReferenceWeight(weight?: number): string {
  const normalized = normalizeReferenceWeight(weight);
  if (normalized == null) return "?/10";
  return `${Number.isInteger(normalized) ? normalized.toFixed(0) : normalized.toFixed(1)}/10`;
}

const DEFAULT_ASSISTANT_LOADING: AssistantMsg["loading"] = {
  webFetch: false,
  stage1: false,
  stage2: false,
  stage3: false,
};

/** 仅当距离底部 ≤ 此值才视为「贴在底部」— 过大时用户略往上滚仍会被判成贴底并遭强拽 */
const SCROLL_STICK_BOTTOM_EPS_PX = 4;

function scrollGapFromBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function isStuckToBottom(el: HTMLElement) {
  return scrollGapFromBottom(el) <= SCROLL_STICK_BOTTOM_EPS_PX;
}

/**
 * Stage3 等内层滚动区：`followBottom` 表示「新内容出来要跟到底」。
 * - 仅在距底 ≤ EPS 时置为 true；离开底部或向上滚轮则 false，避免略往上滚仍被拽回。
 * - 跟随为 true 时，内容增高导致 gap 暂时变大也会滚到底（不能再用「当前 gap≤EPS」挡掉）。
 */
function usePinnedBottomAutoscroll(
  containerRef: React.RefObject<HTMLElement | null>,
  trigger: unknown,
) {
  const followBottomRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onScroll = () => {
      if (isStuckToBottom(el)) followBottomRef.current = true;
      else followBottomRef.current = false;
    };

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) followBottomRef.current = false;
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    onScroll();

    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, [containerRef]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !followBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [containerRef, trigger]);
}

function streamingAssistantShell({
  pending = false,
  responseMode = "council",
  assistantMessageId = crypto.randomUUID(),
  stage3Model,
  stage3Loading = false,
}: {
  pending?: boolean;
  responseMode?: AssistantMsg["responseMode"];
  assistantMessageId?: string;
  stage3Model?: string;
  stage3Loading?: boolean;
} = {}): AssistantMsg {
  return {
    role: "assistant",
    assistantMessageId,
    responseMode,
    pending,
    webFetch: null,
    stage1: null,
    stage2: null,
    stage3:
      responseMode === "followup"
        ? { model: stage3Model || "…", response: "" }
        : null,
    metadata: null,
    loading: {
      ...DEFAULT_ASSISTANT_LOADING,
      stage3: stage3Loading,
    },
  };
}

type UserMsg = { role: "user"; content: string };

function loadStoredWeights(): Record<string, number> | null {
  if (typeof window === "undefined") return null;
  try {
    const s = localStorage.getItem(WEIGHTS_STORAGE);
    if (!s) return null;
    return JSON.parse(s) as Record<string, number>;
  } catch {
    return null;
  }
}

function buildJudgeWeights(
  models: string[],
  stored: Record<string, number> | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of models) {
    const v = stored?.[id];
    out[id] =
      v != null && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 1;
  }
  return out;
}

function normalizeCouncilModels(
  models: string[] | undefined,
  fallback: string[],
): string[] {
  const raw = (models ?? []).map((model) => model.trim());
  const cleaned = [...new Set(raw.filter(Boolean))];
  if (raw.length >= MIN_STAGE2_MODELS) return raw;
  return cleaned.length >= MIN_STAGE2_MODELS ? cleaned : fallback;
}

export default function CouncilApp() {
  const { setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(null);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [input, setInput] = useState("");
  const [councilModels, setCouncilModels] = useState<string[]>([]);
  const [editingCouncilModelIndex, setEditingCouncilModelIndex] = useState<number | null>(null);
  const [editingCouncilModelCustom, setEditingCouncilModelCustom] = useState("");
  const [councilModelsError, setCouncilModelsError] = useState<string | null>(null);
  const [loadingByConversation, setLoadingByConversation] = useState<
    Record<string, boolean>
  >({});
  const [chairmanSelect, setChairmanSelect] = useState<string>("");
  const [chairmanCustom, setChairmanCustom] = useState("");
  const [followupSelect, setFollowupSelect] = useState<string>("");
  const [followupCustom, setFollowupCustom] = useState("");
  const [webFetchSelect, setWebFetchSelect] = useState<string>("");
  const [webFetchCustom, setWebFetchCustom] = useState("");
  const [webSearchMode, setWebSearchMode] = useState<WebSearchMode>("auto");
  const [continueUseWebSearch, setContinueUseWebSearch] = useState(false);
  const [filterUntrustedSources, setFilterUntrustedSources] = useState(true);
  const [storageMode, setStorageMode] = useState<"server" | "local">("server");
  const [judgeWeights, setJudgeWeights] = useState<Record<string, number>>({});
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openrouterKey, setOpenrouterKey] = useState("");
  const [actionErrorByConversation, setActionErrorByConversation] = useState<
    Record<string, string | null>
  >({});
  const [hasRetryByConversation, setHasRetryByConversation] = useState<
    Record<string, boolean>
  >({});
  const [rerunBusy, setRerunBusy] = useState<string | null>(null);
  /** 主席 Stage3 因估算上下文不足被跳过时的引导弹窗 */
  const [chairmanContextPrompt, setChairmanContextPrompt] = useState<{
    convId: string;
    messageIndex: number;
    chairman_model: string;
    estimated_input_tokens: number;
    context_limit: number;
    max_input_tokens: number;
    suggested_models: string[];
  } | null>(null);
  const [chairmanPromptPick, setChairmanPromptPick] = useState("");
  const [chairmanDialogWorking, setChairmanDialogWorking] = useState(false);

  /** 发送失败后重试（流式中失败 reverted=false；fetch 失败 reverted=true） */
  const failedSendRef = useRef<
    Record<string, { content: string; reverted: boolean }>
  >({});
  /** 重跑失败后重试 */
  const rerunRetryRef = useRef<Record<string, () => Promise<void>>>({});

  /** 避免异步 load 完成后把已切走的会话写回当前界面 */
  const currentIdRef = useRef<string | null>(null);
  /** 流式进行中且助手消息尚未落库时，按会话缓存完整 messages，切回该会话时与 GET 合并 */
  const streamDraftRef = useRef<
    Record<string, Conversation["messages"] | undefined>
  >({});
  /** 每条流式请求内至多刷新一次列表（同步侧栏 message_count） */
  const streamSidebarRefreshRef = useRef(false);
  /** 当前流式请求的中断控制器 */
  const streamAbortRef = useRef<Record<string, AbortController | undefined>>({});

  useEffect(() => {
    currentIdRef.current = currentId;
  }, [currentId]);

  const currentLoading = currentId ? (loadingByConversation[currentId] ?? false) : false;
  const actionError = currentId ? (actionErrorByConversation[currentId] ?? null) : null;
  const hasRetry = currentId ? (hasRetryByConversation[currentId] ?? false) : false;

  const setConversationLoading = useCallback((convId: string, loading: boolean) => {
    setLoadingByConversation((prev) => {
      if (loading) {
        if (prev[convId]) return prev;
        return { ...prev, [convId]: true };
      }
      if (!(convId in prev)) return prev;
      const next = { ...prev };
      delete next[convId];
      return next;
    });
  }, []);

  const resetErrorState = useCallback((convId?: string | null) => {
    const targetId = convId ?? currentIdRef.current;
    if (!targetId) return;

    setActionErrorByConversation((prev) => {
      if (!(targetId in prev)) return prev;
      const next = { ...prev };
      delete next[targetId];
      return next;
    });
    setHasRetryByConversation((prev) => {
      if (!(targetId in prev)) return prev;
      const next = { ...prev };
      delete next[targetId];
      return next;
    });
    delete failedSendRef.current[targetId];
    delete rerunRetryRef.current[targetId];
  }, []);

  useEffect(() => {
    setMounted(true);
    setOpenrouterKey(getStoredApiKey());
  }, []);

  const chairmanEffective = useMemo(() => {
    if (chairmanSelect === "__custom__") return chairmanCustom.trim();
    if (chairmanSelect) return chairmanSelect;
    return "";
  }, [chairmanSelect, chairmanCustom]);

  const webFetchEffective = useMemo(() => {
    if (webFetchSelect === "__custom__") return webFetchCustom.trim();
    if (webFetchSelect) return webFetchSelect;
    return "";
  }, [webFetchSelect, webFetchCustom]);

  const followupEffective = useMemo(() => {
    if (followupSelect === "__custom__") return followupCustom.trim();
    if (followupSelect) return followupSelect;
    return "";
  }, [followupCustom, followupSelect]);

  const effectiveCouncilModels = useMemo(
    () => normalizeCouncilModels(councilModels, apiConfig?.council_models ?? []),
    [apiConfig?.council_models, councilModels],
  );
  const validCouncilModels = useMemo(() => {
    const cleaned = effectiveCouncilModels.map((model) => model.trim());
    if (cleaned.length < MIN_STAGE2_MODELS) return null;
    if (cleaned.some((model) => !model)) return null;
    if (new Set(cleaned).size !== cleaned.length) return null;
    return cleaned;
  }, [effectiveCouncilModels]);

  const webFetchModelSections = useMemo(
    () =>
      buildWebFetchModelSections(
        apiConfig?.web_search_models ?? [],
        apiConfig?.web_fetch_model,
        apiConfig?.featured_model_groups ?? [],
        apiConfig?.chairman_context_limits,
      ),
    [
      apiConfig?.chairman_context_limits,
      apiConfig?.featured_model_groups,
      apiConfig?.web_fetch_model,
      apiConfig?.web_search_models,
    ],
  );

  const chairmanModelSections = useMemo(
    () =>
      buildModelSelectSections([
        {
          key: "chairman-defaults",
          label: "当前 Council 配置",
          models: [
            ...(apiConfig?.council_models ?? []),
            ...effectiveCouncilModels,
            apiConfig?.chairman_model ?? "",
          ],
        },
      ], apiConfig?.featured_model_groups ?? [], apiConfig?.chairman_context_limits),
    [
      apiConfig?.chairman_model,
      apiConfig?.chairman_context_limits,
      apiConfig?.council_models,
      effectiveCouncilModels,
      apiConfig?.featured_model_groups,
    ],
  );

  const followupModelSections = useMemo(
    () =>
      buildModelSelectSections([
        {
          key: "followup-defaults",
          label: "当前继续对话配置",
          models: [
            apiConfig?.followup_model ?? "",
            "qwen/qwen3.6-plus:free",
            ...effectiveCouncilModels,
          ],
        },
      ], apiConfig?.featured_model_groups ?? [], apiConfig?.chairman_context_limits),
    [
      apiConfig?.chairman_context_limits,
      effectiveCouncilModels,
      apiConfig?.featured_model_groups,
      apiConfig?.followup_model,
    ],
  );

  const buildStage2ModelSectionsFor = useCallback(
    (currentModel?: string) =>
      buildModelSelectSections([
        {
          key: "stage2-current",
          label: "当前模型",
          models: currentModel ? [currentModel] : [],
        },
        {
          key: "stage2-defaults",
          label: "可选模型",
          models: [
            ...(apiConfig?.council_models ?? []),
            apiConfig?.chairman_model ?? "",
            apiConfig?.followup_model ?? "",
          ].filter((model) => {
            if (!model) return false;
            if (model === currentModel) return true;
            return !effectiveCouncilModels.filter(Boolean).includes(model);
          }),
        },
      ], apiConfig?.featured_model_groups ?? [], apiConfig?.chairman_context_limits),
    [
      apiConfig?.chairman_model,
      apiConfig?.chairman_context_limits,
      apiConfig?.council_models,
      apiConfig?.featured_model_groups,
      apiConfig?.followup_model,
      effectiveCouncilModels,
    ],
  );

  const chairmanPromptSections = useMemo(
    () =>
      buildModelSelectSections([
        {
          key: "chairman-suggested",
          label: "推荐的 5 个最大上下文模型",
          models: chairmanContextPrompt?.suggested_models ?? [],
        },
      ], apiConfig?.featured_model_groups ?? [], apiConfig?.chairman_context_limits),
    [apiConfig?.chairman_context_limits, apiConfig?.featured_model_groups, chairmanContextPrompt?.suggested_models],
  );

  const loadConversations = useCallback(async () => {
    try {
      const list = storageMode === "local" ? listLocalConversations() : await listConversations();
      setConversations(list);
    } catch (e) {
      console.error(e);
    }
  }, [storageMode]);

  const loadConversation = useCallback(async (id: string) => {
    try {
      const c = storageMode === "local" ? getLocalConversation(id) : await getConversation(id);
      if (!c) return;
      if (currentIdRef.current !== id) return;
      const draft = streamDraftRef.current[id];
      if (draft) {
        setConversation({ ...c, messages: draft });
      } else {
        setConversation(c);
      }
    } catch (e) {
      console.error(e);
    }
  }, [storageMode]);

  const stopStreamingPreview = useCallback((convId: string) => {
    const stopTailAssistant = (
      messages: Conversation["messages"],
    ): Conversation["messages"] => {
      const next = [...messages];
      const last = next[next.length - 1] as { role?: string } | undefined;
      if (last?.role === "assistant") {
        next[next.length - 1] = {
          ...(last as AssistantMsg),
          loading: { ...DEFAULT_ASSISTANT_LOADING },
        } as unknown as Conversation["messages"][number];
      }
      return next;
    };

    const draft = streamDraftRef.current[convId];
    if (draft) {
      const next = stopTailAssistant(draft);
      delete streamDraftRef.current[convId];
      setConversation((prev) =>
        prev?.id === convId ? { ...prev, messages: next } : prev,
      );
    } else {
      setConversation((prev) =>
        prev?.id === convId
          ? { ...prev, messages: stopTailAssistant(prev.messages) }
          : prev,
      );
    }

    setConversationLoading(convId, false);
    resetErrorState(convId);
  }, [resetErrorState, setConversationLoading]);

  const isAbortError = useCallback((err: unknown) => {
    return (
      (err as { name?: string })?.name === "AbortError" ||
      (err instanceof Error && err.message === "The operation was aborted.")
    );
  }, []);

  const armRerunRetry = useCallback(
    (key: string, fn: () => Promise<void>) => {
      const convId = currentIdRef.current;
      if (!convId) return;
      const attempt = async () => {
        resetErrorState(convId);
        setRerunBusy(key);
        try {
          await fn();
          if (currentIdRef.current === convId) await loadConversation(convId);
          delete rerunRetryRef.current[convId];
          setHasRetryByConversation((prev) => {
            if (!(convId in prev)) return prev;
            const next = { ...prev };
            delete next[convId];
            return next;
          });
        } catch (e) {
          setActionErrorByConversation((prev) => ({
            ...prev,
            [convId]: e instanceof Error ? e.message : String(e),
          }));
          rerunRetryRef.current[convId] = attempt;
          setHasRetryByConversation((prev) => ({ ...prev, [convId]: true }));
        } finally {
          setRerunBusy(null);
        }
      };
      rerunRetryRef.current[convId] = attempt;
      setHasRetryByConversation((prev) => ({ ...prev, [convId]: true }));
    },
    [loadConversation, resetErrorState],
  );

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await fetchConfig();
        const prefs = loadUiPrefs();
        setApiConfig(cfg);
        const stored = loadStoredWeights();
        const initialCouncilModels = normalizeCouncilModels(
          prefs.councilModels,
          cfg.council_models,
        );
        setCouncilModels(initialCouncilModels);
        setJudgeWeights(buildJudgeWeights(initialCouncilModels.filter(Boolean), stored));
        setWebSearchMode(prefs.webSearchMode ?? "auto");
        setChairmanSelect(
          prefs.chairmanSelect ?? cfg.chairman_model,
        );
        setChairmanCustom(prefs.chairmanCustom ?? "");
        setFollowupSelect(
          prefs.followupSelect ?? cfg.followup_model ?? "qwen/qwen3.6-plus:free",
        );
        setFollowupCustom(prefs.followupCustom ?? "");
        const wfDefault = cfg.web_fetch_model?.trim() ?? "";
        const wsModels = cfg.web_search_models ?? [];
        const savedWf = prefs.webFetchSelect;
        setWebFetchSelect(
          savedWf ?? (wfDefault || wsModels[0] || ""),
        );
        setWebFetchCustom(prefs.webFetchCustom ?? "");
        setStorageMode(prefs.storageMode ?? "server");
        setFilterUntrustedSources(prefs.filterUntrustedSources ?? true);
        setContinueUseWebSearch(prefs.continueUseWebSearch ?? false);
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !apiConfig) return;
    try {
      localStorage.setItem(
        PREFS_STORAGE,
        JSON.stringify({
          councilModels: effectiveCouncilModels,
          webSearchMode,
          chairmanSelect,
          chairmanCustom,
          followupSelect,
          followupCustom,
          webFetchSelect,
          webFetchCustom,
          storageMode,
          filterUntrustedSources,
          continueUseWebSearch,
        } satisfies StoredUiPrefs),
      );
    } catch {
      /* ignore */
    }
  }, [
    apiConfig,
    effectiveCouncilModels,
    webSearchMode,
    chairmanSelect,
    chairmanCustom,
    followupSelect,
    followupCustom,
    webFetchSelect,
    webFetchCustom,
    storageMode,
    filterUntrustedSources,
    continueUseWebSearch,
  ]);

  useEffect(() => {
    if (!apiConfig || !validCouncilModels?.length) return;
    setJudgeWeights((prev) => {
      const next = buildJudgeWeights(validCouncilModels, prev);
      persistWeights(next);
      return next;
    });
  }, [apiConfig, validCouncilModels]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (currentId) void loadConversation(currentId);
  }, [currentId, loadConversation]);

  const persistWeights = (w: Record<string, number>) => {
    try {
      localStorage.setItem(WEIGHTS_STORAGE, JSON.stringify(w));
    } catch {
      /* ignore */
    }
  };

  const handleNew = async () => {
    try {
      const c = storageMode === "local" ? createLocalConversation() : await createConversation();
      await loadConversations();
      setCurrentId(c.id);
      setMobileNavOpen(false);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (storageMode === "local") deleteLocalConversation(id);
      else await deleteConversation(id);
      await loadConversations();
      if (currentId === id) {
        setCurrentId(null);
        setConversation(null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleExportMarkdown = useCallback(() => {
    if (!conversation || typeof window === "undefined") return;
    const markdown = exportConversationMarkdown(conversation);
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeTitle = (conversation.title || "conversation")
      .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    a.href = url;
    a.download = `${safeTitle || "conversation"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [conversation]);

  const sendOpts = useCallback(
    (isFollowup: boolean) => ({
      chairman_model: chairmanEffective || undefined,
      followup_model: followupEffective || undefined,
      web_fetch_model: webFetchEffective || undefined,
      council_models: validCouncilModels ?? undefined,
      use_web_search: webSearchMode !== "off",
      use_web_search_mode: webSearchMode,
      continue_use_web_search: isFollowup ? continueUseWebSearch : undefined,
      filter_untrusted_sources: filterUntrustedSources,
      judge_weights: judgeWeights,
    }),
    [
      chairmanEffective,
      continueUseWebSearch,
      validCouncilModels,
      filterUntrustedSources,
      followupEffective,
      webFetchEffective,
      webSearchMode,
      judgeWeights,
    ],
  );

  const runStreamForContent = useCallback(
    async (convId: string, content: string) => {
      streamSidebarRefreshRef.current = false;
      const controller = new AbortController();
      streamAbortRef.current[convId] = controller;

      const applyPatchToAssistantTail = (
        messages: Conversation["messages"],
        fn: (m: AssistantMsg) => AssistantMsg,
      ): Conversation["messages"] | null => {
        const msgs = [...messages];
        const last = msgs[msgs.length - 1] as { role?: string } | undefined;
        if (!last || last.role !== "assistant") return null;
        msgs[msgs.length - 1] = fn(last as AssistantMsg) as unknown as
          Conversation["messages"][number];
        return msgs;
      };

      const patchLastAssistant = (fn: (m: AssistantMsg) => AssistantMsg) => {
        const draft = streamDraftRef.current[convId];
        if (draft) {
          const next = applyPatchToAssistantTail(draft, fn);
          if (next) streamDraftRef.current[convId] = next;
        }
        setConversation((prev) => {
          if (!prev || prev.id !== convId) return prev;
          const next = applyPatchToAssistantTail(prev.messages, fn);
          if (!next) return prev;
          return { ...prev, messages: next };
        });
      };

      const patchLastAssistantActive = (fn: (m: AssistantMsg) => AssistantMsg) =>
        patchLastAssistant((m) => fn({ ...m, pending: false }));

      const maybeRefreshSidebar = () => {
        if (streamSidebarRefreshRef.current) return;
        streamSidebarRefreshRef.current = true;
        void loadConversations();
      };

      try {
        const localHistoryMessages = storageMode === "local"
          ? (getLocalConversation(convId)?.messages ?? [])
          : null;
        const isFollowup = (localHistoryMessages ?? conversation?.messages ?? []).some(
          (message) => (message as { role?: string }).role === "assistant",
        );

        // Collected data for localStorage persistence in local mode
        const localCollected: {
          webFetch?: WebFetchResult;
          stage1?: Stage1Item[];
          stage2?: Stage2Item[];
          stage3?: Stage3;
          metadata?: AssistantMsg["metadata"];
          title?: string;
          responseMode?: "council" | "followup";
          chairmanContextMsgIndex?: number;
          chairmanContextStage3?: Stage3;
        } = {};

        const streamFn = storageMode === "local"
          ? (handler: (type: string, ev: Record<string, unknown>) => void, opts: ReturnType<typeof sendOpts>, signal: AbortSignal) =>
              sendMessageStatelessStream(content, localHistoryMessages ?? [], handler, opts, signal)
          : (handler: (type: string, ev: Record<string, unknown>) => void, opts: ReturnType<typeof sendOpts>, signal: AbortSignal) =>
              sendMessageStream(convId, content, handler, opts, signal);

        await streamFn((type, ev) => {
          switch (type) {
          case "web_fetch_start":
            maybeRefreshSidebar();
            patchLastAssistantActive((m) => ({
              ...m,
              responseMode: isFollowup ? "followup" : "council",
              webFetch:
                m.webFetch ??
                ({ model: webFetchEffective || apiConfig?.web_fetch_model || "联网检索", content: "" } as WebFetchResult),
              loading: { ...m.loading, webFetch: true },
            }));
            break;
          case "web_fetch_complete":
            if (storageMode === "local") localCollected.webFetch = ev.data as WebFetchResult;
            patchLastAssistantActive((m) => ({
              ...m,
              webFetch: ev.data as WebFetchResult,
              loading: { ...m.loading, webFetch: false },
            }));
            break;
          case "stage1_start":
            maybeRefreshSidebar();
            patchLastAssistantActive((m) => ({
              ...m,
              responseMode: "council",
              loading: { ...m.loading, stage1: true },
            }));
            break;
          case "stage1_complete":
            if (storageMode === "local") localCollected.stage1 = ev.data as Stage1Item[];
            patchLastAssistantActive((m) => ({
              ...m,
              stage1: ev.data as Stage1Item[],
              loading: { ...m.loading, stage1: false },
              stale: { stage2: false, stage3: false },
            }));
            break;
          case "stage2_start":
            patchLastAssistantActive((m) => ({
              ...m,
              loading: { ...m.loading, stage2: true },
            }));
            break;
          case "stage2_complete":
            if (storageMode === "local") {
              localCollected.stage2 = ev.data as Stage2Item[];
              localCollected.metadata = (ev.metadata as AssistantMsg["metadata"]) ?? null;
            }
            patchLastAssistantActive((m) => ({
              ...m,
              stage2: ev.data as Stage2Item[],
              metadata: (ev.metadata as AssistantMsg["metadata"]) ?? null,
              loading: { ...m.loading, stage2: false },
            }));
            break;
          case "chairman_context_prompt": {
            const d = ev.data as {
              message_index: number;
              chairman_model: string;
              estimated_input_tokens: number;
              context_limit: number;
              max_input_tokens: number;
              suggested_models: string[];
              stage3: Stage3;
            };
            if (storageMode === "local") {
              localCollected.chairmanContextMsgIndex = d.message_index;
              localCollected.chairmanContextStage3 = d.stage3;
            }
            patchLastAssistantActive((m) => ({
              ...m,
              stage3: d.stage3,
              loading: { ...m.loading, stage3: false },
            }));
            setChairmanContextPrompt({
              convId,
              messageIndex: d.message_index,
              chairman_model: d.chairman_model,
              estimated_input_tokens: d.estimated_input_tokens,
              context_limit: d.context_limit,
              max_input_tokens: d.max_input_tokens,
              suggested_models: d.suggested_models,
            });
            setChairmanPromptPick(
              d.suggested_models[0] ?? d.chairman_model,
            );
            break;
          }
          case "followup_start": {
            const sm = (ev as { data?: { model?: string } }).data?.model ?? "";
            if (storageMode === "local") localCollected.responseMode = "followup";
            patchLastAssistantActive((m) => ({
              ...m,
              responseMode: "followup",
              loading: { ...m.loading, stage3: true },
              stage3: { model: sm || "…", response: "" },
            }));
            break;
          }
          case "followup_delta": {
            const delta = String(
              (ev as { data?: { delta?: string } }).data?.delta ?? "",
            );
            if (!delta) break;
            patchLastAssistantActive((m) => ({
              ...m,
              responseMode: "followup",
              stage3: m.stage3
                ? { ...m.stage3, response: m.stage3.response + delta }
                : { model: "", response: delta },
            }));
            break;
          }
          case "followup_complete":
            if (storageMode === "local") {
              localCollected.stage3 = ev.data as Stage3;
              localCollected.responseMode = "followup";
            }
            patchLastAssistantActive((m) => ({
              ...m,
              responseMode: "followup",
              stage3: ev.data as Stage3,
              loading: { ...m.loading, stage3: false },
            }));
            break;
          case "stage3_start": {
            const sm = (ev as { data?: { model?: string } }).data?.model ?? "";
            patchLastAssistantActive((m) => ({
              ...m,
              responseMode: "council",
              loading: { ...m.loading, stage3: true },
              stage3: { model: sm || "…", response: "" },
            }));
            break;
          }
          case "stage3_delta": {
            const delta = String(
              (ev as { data?: { delta?: string } }).data?.delta ?? "",
            );
            if (!delta) break;
            patchLastAssistantActive((m) => ({
              ...m,
              stage3: m.stage3
                ? { ...m.stage3, response: m.stage3.response + delta }
                : { model: "", response: delta },
            }));
            break;
          }
          case "stage3_complete":
            if (storageMode === "local") localCollected.stage3 = ev.data as Stage3;
            patchLastAssistantActive((m) => ({
              ...m,
              stage3: ev.data as Stage3,
              loading: { ...m.loading, stage3: false },
            }));
            break;
          case "title_complete": {
            const t = (ev as { data?: { title?: string } }).data?.title;
            if (storageMode === "local" && t) {
              localCollected.title = t;
              updateLocalConversationTitle(convId, t);
            }
            void loadConversations();
            if (t && currentIdRef.current === convId) {
              setConversation((prev) =>
                prev?.id === convId ? { ...prev, title: t } : prev,
              );
            }
            break;
          }
          case "complete": {
            if (storageMode === "local") {
              // Persist the completed conversation to localStorage
              const existingConv = getLocalConversation(convId);
              if (existingConv) {
                const userMsg = { role: "user" as const, content };
                const assistantMsg = {
                  role: "assistant" as const,
                  schemaVersion: 2,
                  assistantMessageId: crypto.randomUUID(),
                  responseMode:
                    localCollected.responseMode ??
                    (isFollowup ? "followup" : "council"),
                  ...(localCollected.webFetch ? { webFetch: localCollected.webFetch } : {}),
                  stage1: localCollected.stage1 ?? [],
                  stage2: localCollected.stage2 ?? [],
                  stage3: localCollected.stage3 ?? { model: "unknown", response: "" },
                  stale: { stage2: false, stage3: false },
                  ...(localCollected.metadata ? { metadata: localCollected.metadata } : {}),
                };
                const updatedConv = {
                  ...existingConv,
                  ...(localCollected.title ? { title: localCollected.title } : {}),
                  messages: [
                    ...(existingConv.messages as unknown[]),
                    userMsg,
                    assistantMsg,
                  ] as Conversation["messages"],
                };
                saveLocalConversation(updatedConv);
              }
            }
            delete streamDraftRef.current[convId];
            void loadConversations();
            if (currentIdRef.current === convId) {
              void loadConversation(convId);
            }
            setConversationLoading(convId, false);
            resetErrorState(convId);
            break;
          }
          case "error":
            delete streamDraftRef.current[convId];
            setActionErrorByConversation((prev) => ({
              ...prev,
              [convId]: String(ev.message ?? "流式错误"),
            }));
            setConversationLoading(convId, false);
            setHasRetryByConversation((prev) => ({ ...prev, [convId]: true }));
            break;
            default:
              break;
          }
        }, sendOpts(isFollowup), controller.signal);
      } finally {
        if (streamAbortRef.current[convId] === controller) {
          delete streamAbortRef.current[convId];
        }
      }
    },
    [
      apiConfig?.web_fetch_model,
      loadConversations,
      loadConversation,
      resetErrorState,
      sendOpts,
      setConversationLoading,
      storageMode,
      webFetchEffective,
      conversation?.messages,
    ],
  );

  // ─── Mode-aware rerun helpers ────────────────────────────────────────────────
  // In local mode, we load the conversation from localStorage, build the params,
  // call the stateless endpoint, persist the result, and return it in the same
  // shape as the server rerun functions so CouncilAssistantCard stays unchanged.

  const localRerunStage1 = useCallback(
    async (conversationId: string, msgIndex: number, opts?: { use_web_search?: boolean; use_web_search_mode?: WebSearchMode; council_models?: string[] }) => {
      const conv = getLocalConversation(conversationId);
      if (!conv) throw new Error("Conversation not found");
      const msgs = conv.messages as unknown as Array<{ role: string; content?: string }>;
      const msg = msgs[msgIndex] as unknown as { role: string; webFetch?: unknown; stage1: unknown[]; stage2: unknown[]; stage3: unknown; stale?: unknown; metadata?: unknown };
      let userQuery = "";
      for (let i = msgIndex - 1; i >= 0; i--) {
        if (msgs[i].role === "user") { userQuery = msgs[i].content ?? ""; break; }
      }
      if (!userQuery) throw new Error("No preceding user message");
      const history = msgs.slice(0, Math.max(0, msgIndex - 1));
      const result = await rerunStage1Stateless({ user_query: userQuery, history_messages: history, web_fetch: msg.webFetch as never, council_models: opts?.council_models, use_web_search: opts?.use_web_search, use_web_search_mode: opts?.use_web_search_mode });
      const updatedMsgs = [...(conv.messages as unknown[])];
      updatedMsgs[msgIndex] = { ...(updatedMsgs[msgIndex] as object), stage1: result.stage1, stale: result.stale, metadata: undefined };
      saveLocalConversation({ ...conv, messages: updatedMsgs as Conversation["messages"] });
      return result;
    },
    [],
  );

  const localRerunStage1Model = useCallback(
    async (conversationId: string, msgIndex: number, model: string, opts?: { use_web_search?: boolean; use_web_search_mode?: WebSearchMode; council_models?: string[] }) => {
      const conv = getLocalConversation(conversationId);
      if (!conv) throw new Error("Conversation not found");
      const msgs = conv.messages as unknown as Array<{ role: string; content?: string }>;
      const msg = msgs[msgIndex] as unknown as { stage1: Array<{ model: string; response: string }> };
      let userQuery = "";
      for (let i = msgIndex - 1; i >= 0; i--) {
        if (msgs[i].role === "user") { userQuery = msgs[i].content ?? ""; break; }
      }
      if (!userQuery) throw new Error("No preceding user message");
      const history = msgs.slice(0, Math.max(0, msgIndex - 1));
      const result = await rerunStage1ModelStateless({ user_query: userQuery, history_messages: history, model, stage1: msg.stage1 ?? [], council_models: opts?.council_models, use_web_search: opts?.use_web_search, use_web_search_mode: opts?.use_web_search_mode });
      const updatedMsgs = [...(conv.messages as unknown[])];
      updatedMsgs[msgIndex] = { ...(updatedMsgs[msgIndex] as object), stage1: result.stage1, stale: result.stale, metadata: undefined };
      saveLocalConversation({ ...conv, messages: updatedMsgs as Conversation["messages"] });
      return result;
    },
    [],
  );

  const localRerunStage2 = useCallback(
    async (conversationId: string, msgIndex: number, opts?: { use_web_search?: boolean; use_web_search_mode?: WebSearchMode; council_models?: string[]; judge_weights?: Record<string, number> }) => {
      const conv = getLocalConversation(conversationId);
      if (!conv) throw new Error("Conversation not found");
      const msgs = conv.messages as unknown as Array<{ role: string; content?: string }>;
      const msg = msgs[msgIndex] as unknown as { stage1: Array<{ model: string; response: string }> };
      let userQuery = "";
      for (let i = msgIndex - 1; i >= 0; i--) {
        if (msgs[i].role === "user") { userQuery = msgs[i].content ?? ""; break; }
      }
      if (!userQuery) throw new Error("No preceding user message");
      const history = msgs.slice(0, Math.max(0, msgIndex - 1));
      const result = await rerunStage2Stateless({ user_query: userQuery, history_messages: history, stage1: msg.stage1 ?? [], council_models: opts?.council_models, use_web_search: opts?.use_web_search, use_web_search_mode: opts?.use_web_search_mode, judge_weights: opts?.judge_weights });
      const updatedMsgs = [...(conv.messages as unknown[])];
      updatedMsgs[msgIndex] = { ...(updatedMsgs[msgIndex] as object), stage2: result.stage2, stale: result.stale, metadata: result.metadata };
      saveLocalConversation({ ...conv, messages: updatedMsgs as Conversation["messages"] });
      return result;
    },
    [],
  );

  const localRerunStage3 = useCallback(
    async (conversationId: string, msgIndex: number, opts?: { use_web_search?: boolean; use_web_search_mode?: WebSearchMode; chairman_model?: string; council_models?: string[]; judge_weights?: Record<string, number>; skip_chairman_context_check?: boolean }) => {
      const conv = getLocalConversation(conversationId);
      if (!conv) throw new Error("Conversation not found");
      const msgs = conv.messages as unknown as Array<{ role: string; content?: string }>;
      const msg = msgs[msgIndex] as unknown as { stage1: Array<{ model: string; response: string }>; stage2: Array<{ model: string; ranking: string; parsed_ranking: string[] }>; webFetch?: unknown };
      let userQuery = "";
      for (let i = msgIndex - 1; i >= 0; i--) {
        if (msgs[i].role === "user") { userQuery = msgs[i].content ?? ""; break; }
      }
      if (!userQuery) throw new Error("No preceding user message");
      const history = msgs.slice(0, Math.max(0, msgIndex - 1));
      const result = await rerunStage3Stateless({ user_query: userQuery, history_messages: history, stage1: msg.stage1 ?? [], stage2: msg.stage2 ?? [], web_fetch: msg.webFetch as never, chairman_model: opts?.chairman_model, council_models: opts?.council_models, judge_weights: opts?.judge_weights, use_web_search: opts?.use_web_search, use_web_search_mode: opts?.use_web_search_mode, skip_chairman_context_check: opts?.skip_chairman_context_check });
      const updatedMsgs = [...(conv.messages as unknown[])];
      updatedMsgs[msgIndex] = { ...(updatedMsgs[msgIndex] as object), stage3: result.stage3, stale: result.stale };
      saveLocalConversation({ ...conv, messages: updatedMsgs as Conversation["messages"] });
      return result;
    },
    [],
  );

  const rerunStage1Fn = useCallback(
    (conversationId: string, msgIndex: number, opts?: Parameters<typeof rerunStage1>[2]) =>
      storageMode === "local" ? localRerunStage1(conversationId, msgIndex, opts) : rerunStage1(conversationId, msgIndex, opts),
    [storageMode, localRerunStage1],
  );

  const rerunStage1ModelFn = useCallback(
    (conversationId: string, msgIndex: number, model: string, opts?: Parameters<typeof rerunStage1Model>[3]) =>
      storageMode === "local" ? localRerunStage1Model(conversationId, msgIndex, model, opts) : rerunStage1Model(conversationId, msgIndex, model, opts),
    [storageMode, localRerunStage1Model],
  );

  const rerunStage2Fn = useCallback(
    (conversationId: string, msgIndex: number, opts?: Parameters<typeof rerunStage2>[2]) =>
      storageMode === "local" ? localRerunStage2(conversationId, msgIndex, opts) : rerunStage2(conversationId, msgIndex, opts),
    [storageMode, localRerunStage2],
  );

  const rerunStage3Fn = useCallback(
    (conversationId: string, msgIndex: number, opts?: Parameters<typeof rerunStage3>[2]) =>
      storageMode === "local" ? localRerunStage3(conversationId, msgIndex, opts) : rerunStage3(conversationId, msgIndex, opts),
    [storageMode, localRerunStage3],
  );

  const handleStop = useCallback(() => {
    if (!currentLoading || !currentId) return;
    streamAbortRef.current[currentId]?.abort();
    delete streamAbortRef.current[currentId];
    stopStreamingPreview(currentId);
  }, [currentId, currentLoading, stopStreamingPreview]);

  const runChairmanRetryWithPick = useCallback(async () => {
    const p = chairmanContextPrompt;
    if (!p || !chairmanPromptPick.trim() || chairmanDialogWorking) return;
    const o = sendOpts(false);
    setChairmanDialogWorking(true);
    resetErrorState(p.convId);
    try {
      await rerunStage3Fn(p.convId, p.messageIndex, {
        use_web_search: o.use_web_search,
        use_web_search_mode: o.use_web_search_mode,
        chairman_model: chairmanPromptPick.trim(),
        council_models: o.council_models,
        judge_weights: o.judge_weights,
      });
      const pick = chairmanPromptPick.trim();
      if (effectiveCouncilModels.includes(pick)) {
        setChairmanSelect(pick);
      } else {
        setChairmanSelect("__custom__");
        setChairmanCustom(pick);
      }
      setChairmanContextPrompt(null);
      if (currentIdRef.current === p.convId) {
        await loadConversation(p.convId);
      }
    } catch (e) {
      setActionErrorByConversation((prev) => ({
        ...prev,
        [p.convId]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setChairmanDialogWorking(false);
    }
  }, [
    chairmanContextPrompt,
    chairmanPromptPick,
    chairmanDialogWorking,
    sendOpts,
    effectiveCouncilModels,
    loadConversation,
    resetErrorState,
    rerunStage3Fn,
  ]);

  const runChairmanForceCurrent = useCallback(async () => {
    const p = chairmanContextPrompt;
    if (!p || chairmanDialogWorking) return;
    const o = sendOpts(false);
    setChairmanDialogWorking(true);
    resetErrorState(p.convId);
    try {
      await rerunStage3Fn(p.convId, p.messageIndex, {
        use_web_search: o.use_web_search,
        use_web_search_mode: o.use_web_search_mode,
        chairman_model: p.chairman_model,
        council_models: o.council_models,
        judge_weights: o.judge_weights,
        skip_chairman_context_check: true,
      });
      setChairmanContextPrompt(null);
      if (currentIdRef.current === p.convId) {
        await loadConversation(p.convId);
      }
    } catch (e) {
      setActionErrorByConversation((prev) => ({
        ...prev,
        [p.convId]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setChairmanDialogWorking(false);
    }
  }, [chairmanContextPrompt, chairmanDialogWorking, sendOpts, loadConversation, resetErrorState, rerunStage3Fn]);

  const handleRetrySend = useCallback(async () => {
    if (!currentId || currentLoading) return;
    const f = failedSendRef.current[currentId];
    if (!f) return;
    resetErrorState(currentId);
    setConversationLoading(currentId, true);
    failedSendRef.current[currentId] = {
      content: f.content,
      reverted: false,
    };

    const isFollowupRetry = Boolean(
      (conversation?.messages as Array<{ role?: string }> | undefined)?.some(
        (message) => message.role === "assistant",
      ),
    );
    const assistantShell = isFollowupRetry
      ? streamingAssistantShell({
          responseMode: "followup",
          stage3Model: followupEffective || apiConfig?.followup_model || "…",
        })
      : streamingAssistantShell({ pending: true });

    setConversation((prev) => {
      if (!prev) return prev;
      const msgs = [...prev.messages];
      if (!f.reverted) {
        const last = msgs[msgs.length - 1] as { role?: string } | undefined;
        if (last?.role === "assistant") msgs.pop();
      } else {
        msgs.push({ role: "user", content: f.content } as unknown as Conversation["messages"][number]);
      }
      msgs.push(assistantShell as unknown as Conversation["messages"][number]);
      streamDraftRef.current[currentId] = msgs;
      return { ...prev, messages: msgs };
    });

    try {
      await runStreamForContent(currentId, f.content);
    } catch (e) {
      if (isAbortError(e)) return;
      console.error(e);
      delete streamDraftRef.current[currentId];
      setConversation((prev) =>
        prev ? { ...prev, messages: prev.messages.slice(0, -2) } : prev,
      );
      setConversationLoading(currentId, false);
      failedSendRef.current[currentId] = {
        content: f.content,
        reverted: true,
      };
      setActionErrorByConversation((prev) => ({ ...prev, [currentId]: "发送失败" }));
      setHasRetryByConversation((prev) => ({ ...prev, [currentId]: true }));
    }
  }, [
    apiConfig?.followup_model,
    conversation?.messages,
    currentId,
    currentLoading,
    followupEffective,
    isAbortError,
    runStreamForContent,
    resetErrorState,
    setConversationLoading,
  ]);

  const handleSend = async () => {
    if (!currentId || !input.trim() || currentLoading) return;
    const content = input.trim();
    setInput("");
    setConversationLoading(currentId, true);
    resetErrorState(currentId);

    failedSendRef.current[currentId] = {
      content,
      reverted: false,
    };

    const userMessage: UserMsg = { role: "user", content };
    const isFollowupSend = messages.some((message) => message.role === "assistant");
    const assistantShell = isFollowupSend
      ? streamingAssistantShell({
          responseMode: "followup",
          stage3Model: followupEffective || apiConfig?.followup_model || "…",
        })
      : streamingAssistantShell({ pending: true });

    setConversation((prev) => {
      if (!prev) return prev;
      const messages = [
        ...prev.messages,
        userMessage as unknown as Conversation["messages"][number],
        assistantShell as unknown as Conversation["messages"][number],
      ];
      streamDraftRef.current[currentId] = messages;
      return { ...prev, messages };
    });

    try {
      await runStreamForContent(currentId, content);
    } catch (e) {
      if (isAbortError(e)) return;
      console.error(e);
      delete streamDraftRef.current[currentId];
      setConversation((prev) =>
        prev ? { ...prev, messages: prev.messages.slice(0, -2) } : prev,
      );
      setConversationLoading(currentId, false);
      failedSendRef.current[currentId] = {
        content,
        reverted: true,
      };
      setActionErrorByConversation((prev) => ({ ...prev, [currentId]: "发送失败" }));
      setHasRetryByConversation((prev) => ({ ...prev, [currentId]: true }));
    }
  };

  const messages = (conversation?.messages ?? []) as unknown as (
    | UserMsg
    | AssistantMsg
  )[];
  const hasAssistantHistory = messages.some((message) => message.role === "assistant");

  const SidebarBody = (
    <>
      <div className="border-b border-border p-4">
        <h1 className="text-lg font-semibold tracking-tight">Vela 助手</h1>
        <Button className="mt-3 w-full" onClick={() => void handleNew()}>
          新对话
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {conversations.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">暂无会话</p>
        ) : (
          <ul className="space-y-1">
            {conversations.map((c) => (
              <li key={c.id}>
                <div
                  className={cn(
                    "group flex items-start gap-2 rounded-lg px-2 py-2 text-left text-sm",
                    c.id === currentId ? "bg-muted" : "hover:bg-muted/60",
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => {
                      setCurrentId(c.id);
                      setMobileNavOpen(false);
                    }}
                  >
                    <div className="truncate font-medium">{c.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.message_count} 条消息
                    </div>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-status-idle-foreground hover:bg-status-error/15 hover:text-status-error-foreground"
                    title="删除"
                    onClick={(e) => void handleDelete(c.id, e)}
                  >
                    <X className="size-4" strokeWidth={2.25} aria-hidden />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <aside className="hidden w-72 shrink-0 flex-col border-r border-border bg-card md:flex">
        {SidebarBody}
      </aside>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="flex w-[min(100%,20rem)] flex-col p-0">
          {SidebarBody}
        </SheetContent>
      </Sheet>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 md:px-6">
          <Button
            variant="outline"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileNavOpen(true)}
            aria-label="打开会话列表"
          >
            <Menu className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-muted-foreground">
              {conversation?.title ?? "请选择或新建对话"}
            </h2>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!conversation}
            onClick={handleExportMarkdown}
          >
            <Download className="mr-2 h-4 w-4" />
            导出 Markdown
          </Button>
          {actionError ? (
            <div className="flex max-w-full flex-wrap items-center gap-2">
              <Badge variant="destructive" className="max-w-[min(12rem,40vw)] truncate">
                {actionError}
              </Badge>
              {hasRetry ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    if (
                      currentId && failedSendRef.current[currentId]
                    ) {
                      void handleRetrySend();
                    } else if (currentId && rerunRetryRef.current[currentId]) {
                      void rerunRetryRef.current[currentId]();
                    }
                  }}
                >
                  重试
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0 text-muted-foreground"
                onClick={() => resetErrorState(currentId)}
              >
                清除
              </Button>
            </div>
          ) : null}
          <Button
            variant="outline"
            size="icon"
            aria-label="切换浅色/深色"
            onClick={() =>
              setTheme(resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            {mounted ? (
              resolvedTheme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )
            ) : (
              <Sun className="h-4 w-4 opacity-0" />
            )}
          </Button>
          <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" aria-label="高级设置">
                <Settings2 className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent className="flex max-h-dvh flex-col overflow-y-auto">
              <SheetHeader>
                <SheetTitle>高级设置</SheetTitle>
              </SheetHeader>
              <div className="mt-4 space-y-6">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="storage-mode">对话存储位置</Label>
                    <Switch
                      id="storage-mode"
                      checked={storageMode === "local"}
                      onCheckedChange={(checked) => {
                        setStorageMode(checked ? "local" : "server");
                        setCurrentId(null);
                        setConversation(null);
                      }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {storageMode === "local"
                      ? "本地模式：对话存储在浏览器 localStorage，仅当前浏览器可见，服务器不保存任何内容。"
                      : "服务器模式：对话存储在服务器文件中，重启浏览器后仍可恢复。"}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="apiKey">OpenRouter API Key</Label>
                  <Input
                    id="apiKey"
                    type="password"
                    placeholder="sk-or-v1-..."
                    value={openrouterKey}
                    onChange={(e) => {
                      setOpenrouterKey(e.target.value);
                      setStoredApiKey(e.target.value);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    密钥仅保存在浏览器本地，不会上传至第三方。
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="web-mode">联网策略</Label>
                  <Select
                    value={webSearchMode}
                    onValueChange={(v) => setWebSearchMode(v as WebSearchMode)}
                  >
                    <SelectTrigger id="web-mode" className="w-full">
                      <SelectValue placeholder="选择联网策略" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">关闭</SelectItem>
                      <SelectItem value="auto">自动判断</SelectItem>
                      <SelectItem value="on">强制联网</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-xs text-muted-foreground">
                  `自动判断` 会结合当前问题和前文决定本轮是否联网、是否复用上一轮检索结果；`强制联网` 每轮都会重新联网检索。
                  若模型不支持联网，服务端会尝试去掉插件重试；本页选项会保存在本机浏览器。
                </p>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="filter-untrusted">过滤不可信来源</Label>
                    <Switch
                      id="filter-untrusted"
                      checked={filterUntrustedSources}
                      onCheckedChange={setFilterUntrustedSources}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    开启后，联网阶段会下调并过滤论坛评论、社区帖子等低可信来源，并把可信度排序结果一并传给模型。
                  </p>
                </div>
                {webSearchMode !== "off" ? (
                  <div className="space-y-2">
                    <Label>Web 抓取模型（仅联网阶段）</Label>
                    <Select
                      value={webFetchSelect || undefined}
                      onValueChange={setWebFetchSelect}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="选择模型" />
                      </SelectTrigger>
                      <SelectContent>
                        {renderModelSelectSections(webFetchModelSections)}
                        {webFetchModelSections.length ? <SelectSeparator /> : null}
                        <SelectItem value="__custom__">自定义模型 ID…</SelectItem>
                      </SelectContent>
                    </Select>
                    {webFetchSelect === "__custom__" ? (
                      <Input
                        placeholder="openrouter/model-id"
                        value={webFetchCustom}
                        onChange={(e) => setWebFetchCustom(e.target.value)}
                      />
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      仅用于联网检索阶段，与主席模型独立。推荐项会固定排在最上面，来自服务端当前配置的
                      <span className="font-mono"> WEB_SEARCH_MODELS </span>
                      与默认
                      <span className="font-mono"> WEB_FETCH_MODEL </span>
                      （当前包含 OpenAI / Anthropic / Perplexity / xAI 的原生搜索模型，以及走 Exa 兜底的 Gemini）。带{" "}
                      <span className="font-mono">:online</span> 或 Exa 兜底的模型，见{" "}
                      <a
                        href="https://openrouter.ai/docs/guides/features/server-tools/web-search"
                        className="underline underline-offset-2"
                        target="_blank"
                        rel="noreferrer"
                      >
                        OpenRouter Web Search
                      </a>
                      ）。自定义留空时由服务端{" "}
                      <span className="font-mono">WEB_FETCH_MODEL</span> 决定。
                    </p>
                  </div>
                ) : null}
                <div className="space-y-2">
                  <Label>最终决策模型（主席）</Label>
                  <Select
                    value={chairmanSelect || undefined}
                    onValueChange={setChairmanSelect}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="选择模型" />
                    </SelectTrigger>
                    <SelectContent>
                      {renderModelSelectSections(chairmanModelSections)}
                      {chairmanModelSections.length ? <SelectSeparator /> : null}
                      <SelectItem value="__custom__">自定义模型 ID…</SelectItem>
                    </SelectContent>
                  </Select>
                  {chairmanSelect === "__custom__" ? (
                    <Input
                      placeholder="openrouter/model-id"
                      value={chairmanCustom}
                      onChange={(e) => setChairmanCustom(e.target.value)}
                    />
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label>继续对话模型</Label>
                  <Select
                    value={followupSelect || undefined}
                    onValueChange={setFollowupSelect}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="选择模型" />
                    </SelectTrigger>
                    <SelectContent>
                      {renderModelSelectSections(followupModelSections)}
                      {followupModelSections.length ? <SelectSeparator /> : null}
                      <SelectItem value="__custom__">自定义模型 ID…</SelectItem>
                    </SelectContent>
                  </Select>
                  {followupSelect === "__custom__" ? (
                    <Input
                      placeholder="openrouter/model-id"
                      value={followupCustom}
                      onChange={(e) => setFollowupCustom(e.target.value)}
                    />
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    多轮继续对话默认使用 `qwen/qwen3.6-plus:free`，不再走多评委投票。
                  </p>
                </div>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label>Stage2 评委模型</Label>
                    <p className="text-xs text-muted-foreground">
                      这里的列表会直接决定 Stage1 和 Stage2 实际调用哪些模型，最少保留 2 个。
                    </p>
                  </div>
                  <div className="space-y-2">
                    {effectiveCouncilModels.map((model, index) => (
                      <div
                        key={`${model}-${index}`}
                        className="space-y-3 rounded-lg border border-border bg-muted/20 p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <Badge variant="secondary">评委 {index + 1}</Badge>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={effectiveCouncilModels.length <= MIN_STAGE2_MODELS}
                            onClick={() => {
                              if (effectiveCouncilModels.length <= MIN_STAGE2_MODELS) {
                                setCouncilModelsError(`至少保留 ${MIN_STAGE2_MODELS} 个模型`);
                                return;
                              }
                              setCouncilModels((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
                              setEditingCouncilModelIndex((prev) => {
                                if (prev == null) return prev;
                                if (prev === index) return null;
                                return prev > index ? prev - 1 : prev;
                              });
                              setCouncilModelsError(null);
                            }}
                          >
                            删除
                          </Button>
                        </div>
                        <div className="space-y-2">
                          <Select
                            value={
                              editingCouncilModelIndex === index
                                ? "__custom__"
                                : model || undefined
                            }
                            onValueChange={(value) => {
                              if (value === "__custom__") {
                                setEditingCouncilModelIndex(index);
                                setEditingCouncilModelCustom(model);
                                setCouncilModelsError(null);
                                return;
                              }
                              setCouncilModels((prev) =>
                                prev.map((item, itemIndex) =>
                                  itemIndex === index ? value : item,
                                ),
                              );
                              setEditingCouncilModelIndex((prev) =>
                                prev === index ? null : prev,
                              );
                              setCouncilModelsError(null);
                            }}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="选择模型" />
                            </SelectTrigger>
                            <SelectContent>
                              {renderModelSelectSections(buildStage2ModelSectionsFor(model))}
                              <SelectSeparator />
                              <SelectItem value="__custom__">自定义模型 ID…</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {editingCouncilModelIndex === index ? (
                          <div className="flex items-center gap-2">
                            <Input
                              placeholder="openrouter/model-id"
                              value={editingCouncilModelCustom}
                              onChange={(e) => setEditingCouncilModelCustom(e.target.value)}
                            />
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => {
                                const nextModel = editingCouncilModelCustom.trim();
                                if (!nextModel) {
                                  setCouncilModelsError("请输入模型 ID");
                                  return;
                                }
                                if (
                                  effectiveCouncilModels.some(
                                    (item, itemIndex) =>
                                      itemIndex !== index && item === nextModel,
                                  )
                                ) {
                                  setCouncilModelsError("该模型已存在");
                                  return;
                                }
                                setCouncilModels((prev) =>
                                  prev.map((item, itemIndex) =>
                                    itemIndex === index ? nextModel : item,
                                  ),
                                );
                                setEditingCouncilModelIndex(null);
                                setEditingCouncilModelCustom("");
                                setCouncilModelsError(null);
                              }}
                            >
                              保存
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setEditingCouncilModelIndex(null);
                                setEditingCouncilModelCustom("");
                                setCouncilModelsError(null);
                              }}
                            >
                              取消
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
                    <Label>新增评委模型</Label>
                    <p className="text-xs text-muted-foreground">
                      点击后会新增一条空白评委，再在该行选择模型或切换到自定义。
                    </p>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => {
                          setCouncilModels((prev) => [...prev, ""]);
                          setEditingCouncilModelIndex(null);
                          setEditingCouncilModelCustom("");
                          setCouncilModelsError(null);
                        }}
                      >
                        新增
                      </Button>
                    </div>
                  </div>
                  {councilModelsError ? (
                    <p className="text-xs text-destructive">{councilModelsError}</p>
                  ) : null}
                </div>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <Label>评委权重（Stage2 聚合）</Label>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const models = effectiveCouncilModels;
                        const reset = buildJudgeWeights(models, null);
                        setJudgeWeights(reset);
                        persistWeights(reset);
                      }}
                    >
                      重置为 1
                    </Button>
                  </div>
                  {effectiveCouncilModels.map((m) => (
                    <div key={m} className="space-y-2">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span className="truncate font-mono">{m}</span>
                        <span>{(judgeWeights[m] ?? 1).toFixed(2)}</span>
                      </div>
                      <Slider
                        value={[judgeWeights[m] ?? 1]}
                        min={0.25}
                        max={4}
                        step={0.05}
                        onValueChange={([v]) => {
                          setJudgeWeights((prev) => {
                            const next = { ...prev, [m]: v };
                            persistWeights(next);
                            return next;
                          });
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6">
          {!currentId ? (
            <p className="text-muted-foreground">点击「新对话」开始。</p>
          ) : (
            <div className="mx-auto max-w-3xl space-y-6">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div
                    key={`user-${i}`}
                    className="rounded-lg border border-border bg-muted/50 px-4 py-3"
                  >
                    <div className="text-xs font-medium text-muted-foreground">
                      你
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{m.content}</p>
                  </div>
                ) : (
                  <CouncilAssistantCard
                    key={m.assistantMessageId ?? `assistant-${i}`}
                    m={m}
                    msgIndex={i}
                    conversationId={currentId}
                    busyKey={rerunBusy}
                    setBusyKey={setRerunBusy}
                    onReload={() => void loadConversation(currentId!)}
                    sendOpts={sendOpts}
                    setActionError={(msg) =>
                      setActionErrorByConversation((prev) => ({
                        ...prev,
                        [currentId]: msg,
                      }))
                    }
                    resetErrorState={() => resetErrorState(currentId)}
                    armRerunRetry={armRerunRetry}
                    rerunStage1Fn={rerunStage1Fn}
                    rerunStage1ModelFn={rerunStage1ModelFn}
                    rerunStage2Fn={rerunStage2Fn}
                    rerunStage3Fn={rerunStage3Fn}
                  />
                ),
              )}
            </div>
          )}
        </div>

        <footer className="border-t border-border p-4">
          <div className="mx-auto max-w-3xl">
            {hasAssistantHistory ? (
              <div className="mb-3 flex items-center justify-end gap-2 text-xs text-muted-foreground mr-[75px]">
                <Label htmlFor="continue-web-search">继续对话联网搜索</Label>
                <Switch
                  id="continue-web-search"
                  checked={continueUseWebSearch}
                  onCheckedChange={setContinueUseWebSearch}
                />
              </div>
            ) : null}
            <div className="flex gap-2">
              <Textarea
                rows={4}
                className="flex-1"
                placeholder="输入问题… Enter 换行，Command+Enter 发送"
                value={input}
                disabled={!currentId}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.metaKey) {
                    e.preventDefault();
                    if (!currentLoading) void handleSend();
                  }
                }}
              />
            {currentLoading ? (
              <Button
                type="button"
                variant="destructive"
                onClick={handleStop}
                className="self-end"
              >
                停止
              </Button>
            ) : (
              <Button
                disabled={!currentId}
                onClick={() => void handleSend()}
                className="self-end"
              >
                发送
              </Button>
            )}
            </div>
          </div>
        </footer>
      </main>

      {chairmanContextPrompt ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="chairman-context-title"
        >
          <div className="max-h-[min(90dvh,32rem)] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-lg">
            <h3
              id="chairman-context-title"
              className="text-base font-semibold text-foreground"
            >
              主席模型上下文可能不足
            </h3>
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
              当前主席{" "}
              <span className="font-mono text-xs text-foreground">
                {chairmanContextPrompt.chairman_model}
              </span>{" "}
              的合成输入估算约{" "}
              <strong className="text-foreground">
                {chairmanContextPrompt.estimated_input_tokens}
              </strong>{" "}
              tokens，在预留回答空间后可用输入上限约{" "}
              <strong className="text-foreground">
                {chairmanContextPrompt.max_input_tokens}
              </strong>{" "}
              tokens（模型总上下文 {chairmanContextPrompt.context_limit}）。
              Stage 3 已暂缓执行；下拉框里会优先列出上下文最大的 5 个主席模型，请改用后重试，或强制使用当前模型（可能被截断或报错）。
            </p>
            <div className="mt-4 space-y-2">
              <Label htmlFor="chairman-pick">改用主席模型</Label>
              <Select
                value={chairmanPromptPick || undefined}
                onValueChange={setChairmanPromptPick}
              >
                <SelectTrigger id="chairman-pick" className="w-full">
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {renderModelSelectSections(chairmanPromptSections)}
                </SelectContent>
              </Select>
            </div>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="ghost"
                disabled={chairmanDialogWorking}
                onClick={() => setChairmanContextPrompt(null)}
              >
                稍后处理
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={chairmanDialogWorking}
                onClick={() => void runChairmanForceCurrent()}
              >
                仍用当前主席强制尝试
              </Button>
              <Button
                type="button"
                disabled={
                  chairmanDialogWorking || !chairmanPromptPick.trim()
                }
                onClick={() => void runChairmanRetryWithPick()}
              >
                {chairmanDialogWorking ? (
                  <>
                    <Loader2
                      className="mr-2 size-4 animate-spin"
                      aria-hidden
                    />
                    重跑中…
                  </>
                ) : (
                  "用所选模型重跑 Stage 3"
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StepperRow({
  webFetchDone,
  showWebFetch,
  followup,
  stage1Done,
  stage2Done,
  stage3Done,
  loading,
}: {
  webFetchDone: boolean;
  showWebFetch: boolean;
  followup?: boolean;
  stage1Done: boolean;
  stage2Done: boolean;
  stage3Done: boolean;
  loading: AssistantMsg["loading"];
}) {
  const steps = [
    ...(showWebFetch
      ? [{ n: 0, label: "W", done: webFetchDone, active: loading.webFetch }]
      : []),
    ...(followup
      ? []
      : [
          { n: 1, label: "1", done: stage1Done, active: loading.stage1 },
          { n: 2, label: "2", done: stage2Done, active: loading.stage2 },
        ]),
    { n: 3, label: "3", done: stage3Done, active: loading.stage3 },
  ];
  return (
    <div className="mb-3 flex items-center gap-2">
      {steps.map((s, idx) => (
        <div key={s.n} className="flex flex-1 items-center gap-2">
          <div
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors",
              s.done
                ? "border-status-success-border bg-status-success text-status-success-foreground"
                : s.active
                  ? "border-status-running-border bg-status-running text-status-running-foreground shadow-sm ring-2 ring-status-running/30"
                  : "border-status-idle-border bg-status-idle text-status-idle-foreground",
            )}
          >
            {s.done ? (
              <Check
                className="size-4 text-status-success-foreground"
                strokeWidth={2.75}
                aria-hidden
              />
            ) : s.active ? (
              <Loader2
                className="size-4 animate-spin text-status-running-foreground"
                aria-hidden
              />
            ) : (
              <span className="tabular-nums text-status-idle-foreground">
                {s.label}
              </span>
            )}
          </div>
          {idx < steps.length - 1 ? (
            <div
              className={cn(
                "h-0.5 flex-1 rounded-full",
                s.done ? "bg-status-success" : "bg-status-track",
              )}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CouncilAssistantCard({
  m,
  msgIndex,
  conversationId,
  busyKey,
  setBusyKey,
  onReload,
  sendOpts,
  setActionError,
  resetErrorState,
  armRerunRetry,
  rerunStage1Fn,
  rerunStage1ModelFn,
  rerunStage2Fn,
  rerunStage3Fn,
}: {
  m: AssistantMsg;
  msgIndex: number;
  conversationId: string;
  busyKey: string | null;
  setBusyKey: (k: string | null) => void;
  onReload: () => void;
  sendOpts: (isFollowup: boolean) => {
    chairman_model?: string;
    followup_model?: string;
    web_fetch_model?: string;
    council_models?: string[];
    use_web_search?: boolean;
    use_web_search_mode?: WebSearchMode;
    continue_use_web_search?: boolean;
    filter_untrusted_sources?: boolean;
    judge_weights?: Record<string, number>;
  };
  setActionError: (s: string | null) => void;
  resetErrorState: () => void;
  armRerunRetry: (key: string, fn: () => Promise<void>) => void;
  rerunStage1Fn: typeof rerunStage1;
  rerunStage1ModelFn: typeof rerunStage1Model;
  rerunStage2Fn: typeof rerunStage2;
  rerunStage3Fn: typeof rerunStage3;
}) {
  const loading = {
    ...DEFAULT_ASSISTANT_LOADING,
    ...(m.loading ?? {}),
  };
  const pending = Boolean(
    m.pending &&
    !m.webFetch &&
    !m.stage1?.length &&
    !m.stage2?.length &&
    !m.stage3,
  );
  const webFetchDone = Boolean(m.webFetch?.content?.trim());
  const s1done = Boolean(m.stage1?.length);
  const s2done = Boolean(m.stage2?.length);
  const s3done = Boolean(
    m.stage3 && m.stage3.response && !loading.stage3,
  );

  const stale2 = m.stale?.stage2;
  const stale3 = m.stale?.stage3;

  const webSearchSkippedModels = (m.stage1 ?? [])
    .filter((it) => it.webSearchSkipped)
    .map((it) => it.model);

  const busyStage1Model =
    busyKey?.startsWith("s1-") === true ? busyKey.slice(3) : null;
  const busyStage1All = busyKey === "s1-all";
  const busyStage2 = busyKey === "s2";
  const busyStage3 = busyKey === "s3";

  const isFollowup = m.responseMode === "followup";

  const effectiveLoading = {
    webFetch: loading.webFetch,
    stage1: loading.stage1 || busyStage1All,
    stage2: loading.stage2 || busyStage2,
    stage3:
      (loading.stage3 || busyStage2 || busyStage3) &&
      !(isFollowup && loading.webFetch),
  };

  const showWebFetch = Boolean(m.webFetch) || effectiveLoading.webFetch;

  const stepperStage2Done = !isFollowup && s2done && !busyStage2;
  const stepperStage3Done = s3done && !busyStage2 && !busyStage3;

  const run = async (key: string, fn: () => Promise<void>) => {
    resetErrorState();
    setBusyKey(key);
    try {
      await fn();
      onReload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      armRerunRetry(key, fn);
    } finally {
      setBusyKey(null);
    }
  };

  const opts = sendOpts(false);
  const stage3ScrollRef = useRef<HTMLDivElement>(null);
  const [stageTab, setStageTab] = useState<"web" | "1" | "2" | "3">(
    showWebFetch ? "web" : isFollowup ? "3" : "1",
  );

  useEffect(() => {
    if (pending) return;
    if (effectiveLoading.webFetch) {
      setStageTab("web");
      return;
    }
    if (!showWebFetch && stageTab === "web") {
      setStageTab("1");
      return;
    }
    if (stageTab === "1" && showWebFetch && !webFetchDone) {
      setStageTab("web");
      return;
    }
    if (!isFollowup && stageTab === "3" && !s2done) {
      setStageTab(s1done ? "2" : "1");
      return;
    }
    if (!isFollowup && stageTab === "2" && !s1done) {
      setStageTab("1");
    }
  }, [effectiveLoading.webFetch, isFollowup, pending, showWebFetch, stageTab, s1done, s2done, webFetchDone]);

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex shrink-0 flex-wrap items-center gap-2 mb-1">
        <span className="text-xs font-medium text-muted-foreground">
          Vela 助手
        </span>
        {stale2 ? (
          <Badge variant="warning">Stage2/3 可能已过期</Badge>
        ) : null}
        {!stale2 && stale3 ? (
          <Badge variant="warning">Stage3 可能已过期</Badge>
        ) : null}
      </div>
      {(m.webFetch?.webSearchSkipped || webSearchSkippedModels.length > 0) ? (
        <div className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          {m.webFetch?.webSearchSkipped ? (
            <p>Web 抓取模型 ({modelShortName(m.webFetch.model)}) 不支持联网插件，已跳过联网搜索。</p>
          ) : null}
          {webSearchSkippedModels.length > 0 ? (
            <p>以下模型不支持联网插件，已回退到无联网模式：{webSearchSkippedModels.map(modelShortName).join("、")}</p>
          ) : null}
        </div>
      ) : null}
      {m.webFetch?.webSearchReason ? (
        <div className="mb-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
          {m.webFetch.webSearchReason}
        </div>
      ) : null}
      <div className="shrink-0">
        <StepperRow
          webFetchDone={webFetchDone}
          showWebFetch={showWebFetch}
          followup={isFollowup}
          stage1Done={s1done}
          stage2Done={stepperStage2Done}
          stage3Done={stepperStage3Done}
          loading={effectiveLoading}
        />
      </div>
      {pending ? (
        <div
          className="mt-3 flex h-[min(58dvh,32rem)] min-h-[220px] flex-col gap-3 rounded-lg border border-status-running-border/40 bg-status-running/15 p-4"
          style={{ animation: "council-fade-in 0.3s ease-out both" }}
          aria-live="polite"
          aria-busy
        >
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Loader2
              className="size-4 animate-spin text-status-running-foreground"
              strokeWidth={2}
              aria-hidden
            />
            <span>正在分析问题并判断是否需要联网检索…</span>
          </div>
          <div className="text-xs text-muted-foreground">
            已开始处理，本条回答会在收到阶段事件后立即切换到对应视图。
          </div>
          <Skeleton className="h-9 w-full rounded-lg bg-status-running/35" />
          <Skeleton className="h-24 w-full rounded-lg bg-status-running/35" />
          <Skeleton className="h-24 w-full rounded-lg bg-status-running/35" />
        </div>
      ) : (
      <Tabs
        value={stageTab}
        onValueChange={(value) => setStageTab(value as "web" | "1" | "2" | "3")}
        className="flex h-[min(58dvh,32rem)] min-h-[220px] flex-col overflow-hidden pt-1"
      >
        <TabsList className="inline-flex h-auto min-h-10 w-full shrink-0 flex-wrap justify-start gap-1 overflow-x-auto rounded-lg bg-muted p-1">
          {showWebFetch ? <TabsTrigger value="web">Web 抓取</TabsTrigger> : null}
          {isFollowup ? (
            <TabsTrigger value="3" disabled={showWebFetch && !webFetchDone}>继续对话</TabsTrigger>
          ) : (
            <>
              <TabsTrigger value="1" disabled={showWebFetch && !webFetchDone}>Stage 1</TabsTrigger>
              <TabsTrigger value="2" disabled={!s1done}>Stage 2</TabsTrigger>
              <TabsTrigger value="3" disabled={!s2done}>Stage 3</TabsTrigger>
            </>
          )}
        </TabsList>
        {showWebFetch ? (
          <TabsContent
            value="web"
            className="mt-2 min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
          >
            <WebFetchView data={m.webFetch ?? null} loading={effectiveLoading.webFetch} />
          </TabsContent>
        ) : null}
        {!isFollowup ? (
          <TabsContent
            value="1"
            className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
          >
          <div className="flex shrink-0 flex-wrap gap-2 border-b border-border pb-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="[&_svg]:size-3.5"
              disabled={busyKey !== null}
              onClick={() =>
                void run("s1-all", async () => {
                  await rerunStage1Fn(conversationId, msgIndex, {
                    council_models: opts.council_models,
                    use_web_search: opts.use_web_search,
                    use_web_search_mode: opts.use_web_search_mode,
                  });
                })
              }
            >
              <RefreshCw
                className={cn(
                  busyStage1All
                    ? "animate-spin text-status-running-foreground"
                    : busyKey !== null
                      ? "text-muted-foreground"
                      : "text-status-running-foreground",
                )}
                aria-hidden
              />
              重跑整阶段 Stage1
            </Button>
            {(m.stage1 ?? []).map((it) => (
              <Button
                key={it.model}
                type="button"
                variant="outline"
                size="sm"
                className="[&_svg]:size-3.5"
                disabled={busyKey !== null}
                onClick={() =>
                  void run(`s1-${it.model}`, async () => {
                    await rerunStage1ModelFn(
                      conversationId,
                      msgIndex,
                      it.model,
                      {
                        council_models: opts.council_models,
                        use_web_search: opts.use_web_search,
                        use_web_search_mode: opts.use_web_search_mode,
                      },
                    );
                  })
                }
              >
                <RefreshCw
                  className={cn(
                    busyKey === `s1-${it.model}`
                      ? "animate-spin text-status-running-foreground"
                      : busyKey !== null
                        ? "text-muted-foreground"
                        : "text-status-running-foreground",
                  )}
                  aria-hidden
                />
                重跑 {modelShortName(it.model)}
              </Button>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden pt-2">
            <Stage1View
              items={m.stage1}
              loading={loading.stage1}
              busyModel={busyStage1Model}
            />
          </div>
          </TabsContent>
        ) : null}
        {!isFollowup ? (
          <TabsContent
            value="2"
            className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
          >
          <div className="flex shrink-0 flex-wrap gap-2 border-b border-border pb-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="[&_svg]:size-3.5"
              disabled={busyKey !== null || !s1done}
              onClick={() =>
                void run("s2", async () => {
                  await rerunStage2Fn(conversationId, msgIndex, {
                    council_models: opts.council_models,
                    use_web_search: opts.use_web_search,
                    use_web_search_mode: opts.use_web_search_mode,
                    judge_weights: opts.judge_weights,
                  });
                })
              }
            >
              <RefreshCw
                className={cn(
                  busyKey === "s2"
                    ? "animate-spin text-status-running-foreground"
                    : busyKey !== null || !s1done
                      ? "text-muted-foreground"
                      : "text-status-running-foreground",
                )}
                aria-hidden
              />
              重跑整阶段 Stage2
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden pt-2">
            <Stage2View
              items={m.stage2}
              loading={effectiveLoading.stage2}
              meta={m.metadata}
            />
          </div>
          </TabsContent>
        ) : null}
        <TabsContent
          value="3"
          className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
        >
          {!isFollowup ? (
            <div className="flex shrink-0 flex-wrap gap-2 border-b border-border pb-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="[&_svg]:size-3.5"
                disabled={busyKey !== null || !s2done}
                onClick={() =>
                  void run("s3", async () => {
                    await rerunStage3Fn(conversationId, msgIndex, {
                      use_web_search: opts.use_web_search,
                      use_web_search_mode: opts.use_web_search_mode,
                      chairman_model: opts.chairman_model,
                      council_models: opts.council_models,
                      judge_weights: opts.judge_weights,
                    });
                  })
                }
              >
                <RefreshCw
                  className={cn(
                    busyKey === "s3"
                      ? "animate-spin text-status-running-foreground"
                      : busyKey !== null || !s2done
                        ? "text-muted-foreground"
                        : "text-status-running-foreground",
                  )}
                  aria-hidden
                />
                重跑 Stage3
              </Button>
            </div>
          ) : (
            <div className="flex shrink-0 items-center border-b border-border pb-2 text-xs text-muted-foreground">
              单模型继续对话结果
            </div>
          )}
          <div
            ref={stage3ScrollRef}
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-2 pr-1"
          >
            <Stage3View
              scrollContainerRef={stage3ScrollRef}
              data={m.stage3}
              loading={effectiveLoading.stage3}
            />
          </div>
        </TabsContent>
      </Tabs>
      )}
    </div>
  );
}

function WebFetchView({
  data,
  loading,
}: {
  data: WebFetchResult | null;
  loading: boolean;
}) {
  const rankedSources = useMemo(
    () => [...(data?.sources ?? [])].sort(compareWebFetchSources),
    [data?.sources],
  );
  const topSources = rankedSources.slice(0, 3);
  const hasStructuredSources = rankedSources.length > 0;
  const showUnrankedWarning =
    !loading &&
    !data?.webSearchSkipped &&
    !hasStructuredSources &&
    Boolean(data?.content?.trim());
  const warningText =
    data?.webSearchWarning ??
    "OpenRouter 这次没有返回结构化 url_citation，前端拿不到精确 URL，所以不能做来源排序。下面正文里的“来源清单 / 参考来源”只是模型文本输出，不等于已验证来源。";

  if (loading)
    return (
      <div
        className="flex flex-1 flex-col space-y-3 rounded-lg border border-status-running-border/40 bg-status-running/15 p-3"
        style={{ animation: "council-fade-in 0.3s ease-out both" }}
      >
        <p className="text-sm text-foreground">
          正在通过 OpenRouter 网页插件检索公开网页，请稍候…
        </p>
        {data?.model ? (
          <div className="font-mono text-xs text-muted-foreground">{data.model}</div>
        ) : null}
        <Skeleton className="h-4 w-2/3 bg-status-running/35" />
        <Skeleton className="h-24 w-full bg-status-running/35" />
      </div>
    );
  if (!data)
    return (
      <p className="text-sm text-status-idle-foreground">暂无数据</p>
    );
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3 dark:border-blue-800 dark:bg-blue-950/30">
      <div className="flex items-center gap-2">
        <div className="font-mono text-xs text-muted-foreground">{data.model}</div>
        {data.webSearchSkipped ? (
          <Badge variant="warning" className="text-[10px]">联网已跳过</Badge>
        ) : null}
        {data.webSearchAction === "reuse" ? (
          <Badge variant="secondary" className="text-[10px]">复用上轮检索</Badge>
        ) : null}
        {data.webSearchAction === "search" && data.webSearchMode === "auto" ? (
          <Badge variant="secondary" className="text-[10px]">自动联网</Badge>
        ) : null}
      </div>
      {data.webSearchReason ? (
        <p className="mt-1 text-xs text-muted-foreground">{data.webSearchReason}</p>
      ) : null}
      {data.retrievedAt ? (
        <p className="mt-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/85">检索时刻（本机时区）</span>
          {": "}
          <time
            dateTime={data.retrievedAt}
            title={
              data.retrievedAtUnixSeconds != null
                ? `UTC ${data.retrievedAt} · Unix ${data.retrievedAtUnixSeconds} s`
                : `UTC ${data.retrievedAt}`
            }
          >
            {dayjs(data.retrievedAt).isValid()
              ? dayjs(data.retrievedAt).format("YYYY-MM-DD HH:mm:ss")
              : data.retrievedAt}
          </time>
          <span className="ml-2 font-mono text-[10px] opacity-70" title="ISO 8601 UTC">
            {data.retrievedAt}
          </span>
        </p>
      ) : null}
      {showUnrankedWarning ? (
        <div className="mt-2 rounded-md border border-red-200 bg-red-50/80 p-2 text-xs text-red-950 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-100">
          <div className="font-medium">这次 Web Search 返回不可直接采信，也无法排序</div>
          <p className="mt-1 leading-snug opacity-90">
            {warningText}
          </p>
        </div>
      ) : null}
      {data.sources && data.sources.length > 0 ? (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/80 p-2 text-xs text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="font-medium">
            来源可信度已展示给用户
            <span className="ml-2 text-[11px] font-normal opacity-80">
              {summarizeCredibility(rankedSources)}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-snug opacity-85">
            下方每条抓取来源都会直接显示可信等级、分数和说明，不再只在后台保留。
          </p>
        </div>
      ) : null}
      {rankedSources.length > 0 ? (
        <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50/70 p-2 dark:border-emerald-900/70 dark:bg-emerald-950/20">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-emerald-900 dark:text-emerald-100">
              Web Search 排序
            </span>
            <Badge variant="secondary" className="text-[10px]">
              先按可信分数
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              再按参考权重
            </Badge>
            <span className="text-[11px] text-emerald-900/80 dark:text-emerald-100/80">
              最高优先来源会排在最前面，供后续阶段直接参考。
            </span>
          </div>
          <div className="mt-2 grid gap-2 md:grid-cols-3">
            {topSources.map((source, index) => (
              <a
                key={`${source.url}-top-${index}`}
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-emerald-200/80 bg-background/80 p-2 transition-colors hover:bg-background dark:border-emerald-900/60"
              >
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-emerald-600 px-1.5 py-0.5 font-semibold text-white">
                    #{index + 1}
                  </span>
                  <span className="truncate">{sourceHostnameLabel(source.url)}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-xs font-medium text-foreground">
                  {source.title?.trim() || source.url}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {source.credibility ? (
                    <Badge variant={credibilityBadgeVariant(source.credibility)} className="text-[10px]">
                      {formatCredibilityLabel(source.credibility)}
                    </Badge>
                  ) : null}
                  {source.credibilityScore != null ? (
                    <Badge variant="outline" className="text-[10px]">
                      {formatCredibilityScore(source.credibilityScore)}
                    </Badge>
                  ) : null}
                </div>
              </a>
            ))}
          </div>
        </div>
      ) : null}
      {rankedSources.length > 0 ? (
        <div className="mt-2 rounded-md border border-border bg-muted/40 p-2">
          <div className="text-xs font-medium text-muted-foreground">
            API 结构化来源排序（url_citation，{rankedSources.length} 条）
          </div>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            当前前端会在 Web 检索阶段直接展示排序结果，不再只是显示原始抓取文本。
          </p>
          <ul className="mt-1.5 list-none space-y-2 pl-0 text-xs">
            {rankedSources.map((s, i) => (
              <li key={`${s.url}-${i}`} className="wrap-break-word">
                <span className="tabular-nums font-medium text-foreground">#{i + 1}</span>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-2 font-medium text-primary underline underline-offset-2"
                >
                  {s.title?.trim() || s.url}
                </a>
                <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                  {sourceHostnameLabel(s.url)}
                </span>
                {s.sourceType ? (
                  <Badge variant="outline" className="ml-1 text-[10px]">
                    {s.sourceType}
                  </Badge>
                ) : null}
                {s.credibility ? (
                  <Badge variant={credibilityBadgeVariant(s.credibility)} className="ml-1 text-[10px]">
                    {formatCredibilityLabel(s.credibility)}
                  </Badge>
                ) : null}
                {s.credibilityScore != null ? (
                  <Badge variant="outline" className="ml-1 text-[10px]">
                    分数 {formatCredibilityScore(s.credibilityScore)}
                  </Badge>
                ) : null}
                {s.referenceWeight != null ? (
                  <Badge variant="secondary" className="ml-1 text-[10px]">
                    权重 {formatReferenceWeight(s.referenceWeight)}
                  </Badge>
                ) : null}
                {s.snippet ? (
                  <p className="mt-0.5 pl-0 text-[11px] leading-snug text-muted-foreground">
                    {s.snippet.length > 280 ? `${s.snippet.slice(0, 280)}…` : s.snippet}
                  </p>
                ) : null}
                {s.credibilityReason ? (
                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                    {s.credibilityReason}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!hasStructuredSources && !loading && !data.webSearchSkipped ? (
        <div className="mt-2 rounded-md border border-dashed border-border bg-muted/25 p-2 text-[11px] leading-snug text-muted-foreground">
          本轮未收到可排序的结构化来源。要展示真正的 Web 排序，联网模型必须返回带精确 URL 的
          <span className="mx-1 font-mono">url_citation</span>
          数据，而不是只在正文里写几个站点名字。
        </div>
      ) : null}
      <div className="mt-2 max-w-none text-sm leading-relaxed text-foreground [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2">
        <ReactMarkdown components={markdownComponents}>{data.content}</ReactMarkdown>
      </div>
    </div>
  );
}

function Stage1View({
  items,
  loading,
  busyModel,
}: {
  items: Stage1Item[] | null;
  loading: boolean;
  busyModel?: string | null;
}) {
  if (loading)
    return (
      <div
        className="flex flex-1 flex-col space-y-3 rounded-lg border border-status-running-border/40 bg-status-running/15 p-3"
        style={{ animation: "council-fade-in 0.3s ease-out both" }}
      >
        <Skeleton className="h-4 w-2/3 bg-status-running/35" />
        <Skeleton className="h-24 w-full bg-status-running/35" />
      </div>
    );
  if (!items?.length)
    return (
      <p className="text-sm text-status-idle-foreground">暂无数据</p>
    );
  return (
    <Tabs
      defaultValue="s1-0"
      className="flex h-full min-h-0 flex-1 flex-col gap-0"
    >
      <TabsList className="inline-flex h-auto w-full shrink-0 flex-nowrap justify-start gap-1 overflow-x-auto rounded-md bg-muted/60 p-1">
        {items.map((it, idx) => (
          <TabsTrigger
            key={it.model}
            value={`s1-${idx}`}
            className={cn(
              "max-w-36 shrink-0 truncate text-xs transition-opacity duration-300",
              it.failed && "text-status-error-foreground",
              busyModel === it.model && "opacity-70",
            )}
            title={it.model}
          >
            {modelShortName(it.model)}
            {it.failed ? " · 失败" : ""}
          </TabsTrigger>
        ))}
      </TabsList>
      {items.map((it, idx) => {
        const isBusy = busyModel != null && busyModel === it.model;
        return (
          <TabsContent
            key={it.model}
            value={`s1-${idx}`}
            className="mt-2 min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-mono text-xs text-muted-foreground">{it.model}</div>
              {it.failed ? <Badge variant="destructive" className="text-[10px]">请求失败</Badge> : null}
              {it.webSearchSkipped ? (
                <Badge variant="warning" className="text-[10px]">已回退为无联网</Badge>
              ) : null}
            </div>
            <div
              className={cn(
                "relative mt-2 min-h-16 overflow-hidden rounded-md",
                it.failed && "border border-status-error-border bg-status-error/35 p-3",
                isBusy && "ring-2 ring-status-running/40 ring-offset-2 ring-offset-background",
              )}
            >
              {it.failed ? (
                <div
                  className={cn(
                    "text-sm leading-relaxed text-status-error-foreground transition-[filter,opacity] duration-300 ease-out",
                    isBusy && "pointer-events-none blur-[6px] opacity-60 select-none",
                  )}
                >
                  <p className="font-medium">该模型本轮返回失败。</p>
                  <p className="mt-1 text-xs opacity-90">
                    {it.error ?? "This model failed to respond. Please retry this model."}
                  </p>
                  <p className="mt-2 text-xs opacity-80">
                    可直接点击上方“重跑 {modelShortName(it.model)}”再次请求这个模型。
                  </p>
                </div>
              ) : (
                <div
                  className={cn(
                    "max-w-none text-sm leading-relaxed text-foreground transition-[filter,opacity] duration-300 ease-out [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2",
                    isBusy && "pointer-events-none blur-[6px] opacity-60 select-none",
                  )}
                >
                  <ReactMarkdown components={markdownComponents}>{it.response}</ReactMarkdown>
                </div>
              )}
              {isBusy ? (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/35 backdrop-blur-[2px]"
                  style={{ animation: "council-overlay-in 0.3s ease-out both" }}
                  aria-live="polite"
                  aria-busy
                >
                  <Loader2
                    className="size-9 animate-spin text-status-running-foreground drop-shadow-sm"
                    strokeWidth={2}
                    aria-hidden
                  />
                  <span className="text-xs font-medium text-status-running-foreground">
                    正在重新生成…
                  </span>
                </div>
              ) : null}
            </div>
          </TabsContent>
        );
      })}
    </Tabs>
  );
}

function Stage2View({
  items,
  loading,
  meta,
}: {
  items: Stage2Item[] | null;
  loading: boolean;
  meta: AssistantMsg["metadata"];
}) {
  if (loading)
    return (
      <div
        className="flex flex-1 flex-col space-y-3 rounded-lg border border-status-running-border/40 bg-status-running/15 p-3"
        style={{ animation: "council-fade-in 0.3s ease-out both" }}
      >
        <Skeleton className="h-4 w-1/2 bg-status-running/35" />
        <Skeleton className="h-32 w-full bg-status-running/35" />
      </div>
    );
  if (!items?.length)
    return (
      <p className="text-sm text-status-idle-foreground">暂无数据</p>
    );

  const showAgg = Boolean(meta?.aggregate_rankings?.length);
  const defaultTab = showAgg ? "s2-agg" : "s2-0";

  return (
    <Tabs
      defaultValue={defaultTab}
      className="flex h-full min-h-0 flex-1 flex-col gap-0"
    >
      <TabsList className="inline-flex h-auto w-full shrink-0 flex-nowrap justify-start gap-1 overflow-x-auto rounded-md bg-muted/60 p-1">
        {showAgg ? (
          <TabsTrigger value="s2-agg" className="shrink-0 text-xs">
            聚合排名
          </TabsTrigger>
        ) : null}
        {items.map((it, idx) => (
          <TabsTrigger
            key={it.model}
            value={`s2-${idx}`}
            className="max-w-36 shrink-0 truncate text-xs"
            title={it.model}
          >
            {modelShortName(it.model)}
          </TabsTrigger>
        ))}
      </TabsList>
      {showAgg ? (
        <TabsContent
          value="s2-agg"
          className="mt-2 min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
        >
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs">
            <div className="font-medium">聚合排名（含评委权重）</div>
            <ul className="mt-2 space-y-1">
              {(meta?.aggregate_rankings ?? []).map((r) => (
                <li key={r.model}>
                  {r.model} — 平均名次 {r.average_rank}（{r.rankings_count}{" "}
                  位评委）
                </li>
              ))}
            </ul>
          </div>
        </TabsContent>
      ) : null}
      {items.map((it, idx) => (
        <TabsContent
          key={it.model}
          value={`s2-${idx}`}
          className="mt-2 min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
        >
          <div className="font-mono text-xs text-muted-foreground">{it.model}</div>
          <pre className="mt-2 min-h-24 whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-xs leading-relaxed">
            {it.ranking}
          </pre>
          <div className="mt-2 text-xs text-muted-foreground">
            解析: {it.parsed_ranking.join(" → ")}
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}

function Stage3View({
  scrollContainerRef,
  data,
  loading,
}: {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  data: Stage3 | null;
  loading: boolean;
}) {
  const fullText = data?.response ?? "";
  const idxRef = useRef(0);
  const hasSeenStreamRef = useRef(false);
  const [displayed, setDisplayed] = useState("");

  const streaming = Boolean(loading && data);
  const waitingStage3 = Boolean(loading && !data);
  const typing =
    streaming || (Boolean(data) && displayed.length < fullText.length);

  useEffect(() => {
    if (!data) return;

    if (loading) hasSeenStreamRef.current = true;

    let cancelled = false;
    const run = () => {
      if (cancelled) return;

      if (!hasSeenStreamRef.current && !loading && fullText.length > 0) {
        idxRef.current = fullText.length;
        setDisplayed(fullText);
        return;
      }

      const tgt = fullText;
      const ld = loading;

      if (ld && tgt.length === 0) {
        idxRef.current = 0;
        setDisplayed("");
        return;
      }

      let i = idxRef.current;
      if (i < tgt.length) {
        const backlog = tgt.length - i;
        const step = Math.min(
          48,
          Math.max(1, Math.ceil(backlog / (backlog > 200 ? 28 : 20))),
        );
        i = Math.min(tgt.length, i + step);
        idxRef.current = i;
        setDisplayed(tgt.slice(0, i));
      }

      if (!cancelled && idxRef.current < tgt.length) {
        requestAnimationFrame(run);
      }
    };

    const id = requestAnimationFrame(run);
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [data, fullText, loading]);

  usePinnedBottomAutoscroll(
    scrollContainerRef,
    `${displayed.length}|${loading}|${fullText.length}`,
  );

  if (waitingStage3)
    return (
      <div
        className="rounded-lg border border-status-running-border/40 bg-status-running/15 p-3"
        style={{ animation: "council-fade-in 0.3s ease-out both" }}
      >
        <Skeleton className="h-40 w-full rounded-lg bg-status-running/35" />
      </div>
    );
  if (!data)
    return <p className="text-sm text-status-idle-foreground">暂无数据</p>;

  const borderClass = streaming
    ? "border-status-running-border/50 bg-status-running/12"
    : "border-status-success-border bg-status-success/25";

  return (
    <div className={cn("rounded-lg border p-3", borderClass)}>
      <div className="font-mono text-xs text-muted-foreground">{data.model}</div>
      <div className="relative mt-2 max-w-none text-sm leading-relaxed text-foreground transition-opacity duration-200 ease-out [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2">
        {displayed ? (
          <ReactMarkdown components={markdownComponents}>{displayed}</ReactMarkdown>
        ) : streaming ? (
          <span className="text-muted-foreground">正在生成…</span>
        ) : null}
        {typing ? (
          <span
            className="council-stream-cursor ml-px inline-block h-[1em] w-2 translate-y-0.5 rounded-sm bg-foreground/75 align-[-0.15em] shadow-sm"
            aria-hidden
          />
        ) : null}
      </div>
    </div>
  );
}
