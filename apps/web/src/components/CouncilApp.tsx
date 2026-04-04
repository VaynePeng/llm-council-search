"use client";

import {
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
  SelectItem,
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  createConversation,
  deleteConversation,
  fetchConfig,
  getConversation,
  getStoredApiKey,
  listConversations,
  rerunStage1,
  rerunStage1Model,
  rerunStage2,
  rerunStage3,
  sendMessageStream,
  setStoredApiKey,
  type ApiConfig,
  type Conversation,
  type ConversationMeta,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import dayjs from "dayjs";

const WEIGHTS_STORAGE = "llm-council-search-judge-weights";
const PREFS_STORAGE = "llm-council-search-ui-prefs";

type StoredUiPrefs = {
  useWebSearch?: boolean;
  chairmanSelect?: string;
  chairmanCustom?: string;
  webFetchSelect?: string;
  webFetchCustom?: string;
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

type WebFetchSource = {
  url: string;
  title?: string;
  snippet?: string;
};

type WebFetchResult = {
  model: string;
  content: string;
  webSearchSkipped?: boolean;
  retrievedAt?: string;
  retrievedAtUnixSeconds?: number;
  sources?: WebFetchSource[];
};

type Stage1Item = {
  model: string;
  response: string;
  webSearchSkipped?: boolean;
};
type Stage2Item = {
  model: string;
  ranking: string;
  parsed_ranking: string[];
};
type Stage3 = { model: string; response: string };

type AssistantMsg = {
  role: "assistant";
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

function streamingAssistantShell(
  useWebSearch: boolean,
  webFetchModelId?: string,
): AssistantMsg {
  const modelLabel =
    webFetchModelId?.trim() || "联网检索";
  return {
    role: "assistant",
    webFetch: useWebSearch ? { model: modelLabel, content: "" } : null,
    stage1: null,
    stage2: null,
    stage3: null,
    metadata: null,
    loading: {
      webFetch: useWebSearch,
      stage1: false,
      stage2: false,
      stage3: false,
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

export default function CouncilApp() {
  const { setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(null);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [chairmanSelect, setChairmanSelect] = useState<string>("");
  const [chairmanCustom, setChairmanCustom] = useState("");
  const [webFetchSelect, setWebFetchSelect] = useState<string>("");
  const [webFetchCustom, setWebFetchCustom] = useState("");
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [judgeWeights, setJudgeWeights] = useState<Record<string, number>>({});
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openrouterKey, setOpenrouterKey] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [hasRetry, setHasRetry] = useState(false);
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
  const failedSendRef = useRef<{
    conversationId: string;
    content: string;
    reverted: boolean;
  } | null>(null);
  /** 重跑失败后重试 */
  const rerunRetryRef = useRef<(() => Promise<void>) | null>(null);

  /** 避免异步 load 完成后把已切走的会话写回当前界面 */
  const currentIdRef = useRef<string | null>(null);
  /** 流式进行中且助手消息尚未落库时，按会话缓存完整 messages，切回该会话时与 GET 合并 */
  const streamDraftRef = useRef<{
    convId: string;
    messages: Conversation["messages"];
  } | null>(null);
  /** 每条流式请求内至多刷新一次列表（同步侧栏 message_count） */
  const streamSidebarRefreshRef = useRef(false);
  /** 当前流式请求的中断控制器 */
  const streamAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    currentIdRef.current = currentId;
  }, [currentId]);

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

  const loadConversations = useCallback(async () => {
    try {
      const list = await listConversations();
      setConversations(list);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    try {
      const c = await getConversation(id);
      if (currentIdRef.current !== id) return;
      const draft = streamDraftRef.current;
      if (draft?.convId === id) {
        setConversation({ ...c, messages: draft.messages });
      } else {
        setConversation(c);
      }
    } catch (e) {
      console.error(e);
    }
  }, []);

  const resetErrorState = useCallback(() => {
    setActionError(null);
    setHasRetry(false);
    failedSendRef.current = null;
    rerunRetryRef.current = null;
  }, []);

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

    const draft = streamDraftRef.current;
    if (draft?.convId === convId) {
      const next = stopTailAssistant(draft.messages);
      streamDraftRef.current = null;
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

    setLoading(false);
    setHasRetry(false);
    setActionError(null);
    failedSendRef.current = null;
  }, []);

  const isAbortError = useCallback((err: unknown) => {
    return (
      (err as { name?: string })?.name === "AbortError" ||
      (err instanceof Error && err.message === "The operation was aborted.")
    );
  }, []);

  const armRerunRetry = useCallback(
    (key: string, fn: () => Promise<void>) => {
      const attempt = async () => {
        setActionError(null);
        setRerunBusy(key);
        try {
          await fn();
          if (currentId) await loadConversation(currentId);
          rerunRetryRef.current = null;
          setHasRetry(false);
        } catch (e) {
          setActionError(e instanceof Error ? e.message : String(e));
          rerunRetryRef.current = attempt;
          setHasRetry(true);
        } finally {
          setRerunBusy(null);
        }
      };
      rerunRetryRef.current = attempt;
      setHasRetry(true);
    },
    [currentId, loadConversation],
  );

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await fetchConfig();
        const prefs = loadUiPrefs();
        setApiConfig(cfg);
        const stored = loadStoredWeights();
        setJudgeWeights(buildJudgeWeights(cfg.council_models, stored));
        setUseWebSearch(prefs.useWebSearch ?? false);
        setChairmanSelect(
          prefs.chairmanSelect ?? cfg.chairman_model,
        );
        setChairmanCustom(prefs.chairmanCustom ?? "");
        const wfDefault = cfg.web_fetch_model?.trim() ?? "";
        const wsModels = cfg.web_search_models ?? [];
        const savedWf = prefs.webFetchSelect;
        const savedOk =
          savedWf === "__custom__" ||
          (savedWf &&
            (wsModels.includes(savedWf) || savedWf === wfDefault));
        setWebFetchSelect(
          savedOk ? (savedWf ?? wfDefault) : wfDefault || wsModels[0] || "",
        );
        setWebFetchCustom(prefs.webFetchCustom ?? "");
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
          useWebSearch,
          chairmanSelect,
          chairmanCustom,
          webFetchSelect,
          webFetchCustom,
        } satisfies StoredUiPrefs),
      );
    } catch {
      /* ignore */
    }
  }, [
    apiConfig,
    useWebSearch,
    chairmanSelect,
    chairmanCustom,
    webFetchSelect,
    webFetchCustom,
  ]);

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
      const c = await createConversation();
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
      await deleteConversation(id);
      await loadConversations();
      if (currentId === id) {
        setCurrentId(null);
        setConversation(null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const sendOpts = useCallback(
    () => ({
      chairman_model: chairmanEffective || undefined,
      web_fetch_model: webFetchEffective || undefined,
      use_web_search: useWebSearch,
      judge_weights: judgeWeights,
    }),
    [chairmanEffective, webFetchEffective, useWebSearch, judgeWeights],
  );

  const runStreamForContent = useCallback(
    async (convId: string, content: string) => {
      streamSidebarRefreshRef.current = false;
      const controller = new AbortController();
      streamAbortRef.current = controller;

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
        const d = streamDraftRef.current;
        if (d?.convId === convId) {
          const next = applyPatchToAssistantTail(d.messages, fn);
          if (next) streamDraftRef.current = { convId, messages: next };
        }
        setConversation((prev) => {
          if (!prev || prev.id !== convId) return prev;
          const next = applyPatchToAssistantTail(prev.messages, fn);
          if (!next) return prev;
          return { ...prev, messages: next };
        });
      };

      const maybeRefreshSidebar = () => {
        if (streamSidebarRefreshRef.current) return;
        streamSidebarRefreshRef.current = true;
        void loadConversations();
      };

      try {
        await sendMessageStream(convId, content, (type, ev) => {
          switch (type) {
          case "web_fetch_start":
            maybeRefreshSidebar();
            patchLastAssistant((m) => ({
              ...m,
              loading: { ...m.loading, webFetch: true },
            }));
            break;
          case "web_fetch_complete":
            patchLastAssistant((m) => ({
              ...m,
              webFetch: ev.data as WebFetchResult,
              loading: { ...m.loading, webFetch: false },
            }));
            break;
          case "stage1_start":
            maybeRefreshSidebar();
            patchLastAssistant((m) => ({
              ...m,
              loading: { ...m.loading, stage1: true },
            }));
            break;
          case "stage1_complete":
            patchLastAssistant((m) => ({
              ...m,
              stage1: ev.data as Stage1Item[],
              loading: { ...m.loading, stage1: false },
              stale: { stage2: false, stage3: false },
            }));
            break;
          case "stage2_start":
            patchLastAssistant((m) => ({
              ...m,
              loading: { ...m.loading, stage2: true },
            }));
            break;
          case "stage2_complete":
            patchLastAssistant((m) => ({
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
            patchLastAssistant((m) => ({
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
          case "stage3_start": {
            const sm = (ev as { data?: { model?: string } }).data?.model ?? "";
            patchLastAssistant((m) => ({
              ...m,
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
            patchLastAssistant((m) => ({
              ...m,
              stage3: m.stage3
                ? { ...m.stage3, response: m.stage3.response + delta }
                : { model: "", response: delta },
            }));
            break;
          }
          case "stage3_complete":
            patchLastAssistant((m) => ({
              ...m,
              stage3: ev.data as Stage3,
              loading: { ...m.loading, stage3: false },
            }));
            break;
          case "title_complete": {
            void loadConversations();
            const t = (ev as { data?: { title?: string } }).data?.title;
            if (t && currentIdRef.current === convId) {
              setConversation((prev) =>
                prev?.id === convId ? { ...prev, title: t } : prev,
              );
            }
            break;
          }
          case "complete":
            if (streamDraftRef.current?.convId === convId) {
              streamDraftRef.current = null;
            }
            void loadConversations();
            if (currentIdRef.current === convId) {
              void loadConversation(convId);
            }
            setLoading(false);
            failedSendRef.current = null;
            setHasRetry(false);
            break;
          case "error":
            if (streamDraftRef.current?.convId === convId) {
              streamDraftRef.current = null;
            }
            setActionError(String(ev.message ?? "流式错误"));
            setLoading(false);
            setHasRetry(true);
            break;
            default:
              break;
          }
        }, sendOpts(), controller.signal);
      } finally {
        if (streamAbortRef.current === controller) {
          streamAbortRef.current = null;
        }
      }
    },
    [loadConversations, loadConversation, sendOpts],
  );

  const handleStop = useCallback(() => {
    if (!loading || !currentId) return;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    stopStreamingPreview(currentId);
  }, [currentId, loading, stopStreamingPreview]);

  const runChairmanRetryWithPick = useCallback(async () => {
    const p = chairmanContextPrompt;
    if (!p || !chairmanPromptPick.trim() || chairmanDialogWorking) return;
    const o = sendOpts();
    setChairmanDialogWorking(true);
    setActionError(null);
    try {
      await rerunStage3(p.convId, p.messageIndex, {
        use_web_search: o.use_web_search,
        chairman_model: chairmanPromptPick.trim(),
        judge_weights: o.judge_weights,
      });
      const pick = chairmanPromptPick.trim();
      if (apiConfig?.council_models.includes(pick)) {
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
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setChairmanDialogWorking(false);
    }
  }, [
    chairmanContextPrompt,
    chairmanPromptPick,
    chairmanDialogWorking,
    sendOpts,
    apiConfig?.council_models,
    loadConversation,
  ]);

  const runChairmanForceCurrent = useCallback(async () => {
    const p = chairmanContextPrompt;
    if (!p || chairmanDialogWorking) return;
    const o = sendOpts();
    setChairmanDialogWorking(true);
    setActionError(null);
    try {
      await rerunStage3(p.convId, p.messageIndex, {
        use_web_search: o.use_web_search,
        chairman_model: p.chairman_model,
        judge_weights: o.judge_weights,
        skip_chairman_context_check: true,
      });
      setChairmanContextPrompt(null);
      if (currentIdRef.current === p.convId) {
        await loadConversation(p.convId);
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setChairmanDialogWorking(false);
    }
  }, [chairmanContextPrompt, chairmanDialogWorking, sendOpts, loadConversation]);

  const handleRetrySend = useCallback(async () => {
    const f = failedSendRef.current;
    if (!f || f.conversationId !== currentId || loading) return;
    setActionError(null);
    setHasRetry(false);
    setLoading(true);
    failedSendRef.current = {
      conversationId: f.conversationId,
      content: f.content,
      reverted: false,
    };

    const o = sendOpts();
    const assistantShell = streamingAssistantShell(
      Boolean(o.use_web_search),
      o.web_fetch_model ?? apiConfig?.web_fetch_model,
    );

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
      streamDraftRef.current = { convId: f.conversationId, messages: msgs };
      return { ...prev, messages: msgs };
    });

    try {
      await runStreamForContent(f.conversationId, f.content);
    } catch (e) {
      if (isAbortError(e)) return;
      console.error(e);
      if (streamDraftRef.current?.convId === f.conversationId) {
        streamDraftRef.current = null;
      }
      setConversation((prev) =>
        prev ? { ...prev, messages: prev.messages.slice(0, -2) } : prev,
      );
      setLoading(false);
      failedSendRef.current = {
        conversationId: f.conversationId,
        content: f.content,
        reverted: true,
      };
      setActionError("发送失败");
      setHasRetry(true);
    }
  }, [currentId, isAbortError, loading, runStreamForContent, sendOpts, apiConfig?.web_fetch_model]);

  const handleSend = async () => {
    if (!currentId || !input.trim() || loading) return;
    const content = input.trim();
    setInput("");
    setLoading(true);
    resetErrorState();

    failedSendRef.current = {
      conversationId: currentId,
      content,
      reverted: false,
    };

    const userMessage: UserMsg = { role: "user", content };
    const o = sendOpts();
    const assistantShell = streamingAssistantShell(
      Boolean(o.use_web_search),
      o.web_fetch_model ?? apiConfig?.web_fetch_model,
    );

    setConversation((prev) => {
      if (!prev) return prev;
      const messages = [
        ...prev.messages,
        userMessage as unknown as Conversation["messages"][number],
        assistantShell as unknown as Conversation["messages"][number],
      ];
      streamDraftRef.current = { convId: currentId, messages };
      return { ...prev, messages };
    });

    try {
      await runStreamForContent(currentId, content);
    } catch (e) {
      if (isAbortError(e)) return;
      console.error(e);
      if (streamDraftRef.current?.convId === currentId) {
        streamDraftRef.current = null;
      }
      setConversation((prev) =>
        prev ? { ...prev, messages: prev.messages.slice(0, -2) } : prev,
      );
      setLoading(false);
      failedSendRef.current = {
        conversationId: currentId,
        content,
        reverted: true,
      };
      setActionError("发送失败");
      setHasRetry(true);
    }
  };

  const messages = (conversation?.messages ?? []) as unknown as (
    | UserMsg
    | AssistantMsg
  )[];

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
                      failedSendRef.current?.conversationId === currentId
                    ) {
                      void handleRetrySend();
                    } else if (rerunRetryRef.current) {
                      void rerunRetryRef.current();
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
                onClick={() => resetErrorState()}
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
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor="web">OpenRouter 联网（web_search 工具）</Label>
                  <Switch
                    id="web"
                    checked={useWebSearch}
                    onCheckedChange={setUseWebSearch}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  若模型不支持联网，服务端会尝试去掉插件重试；费用见 OpenRouter 文档。
                  {useWebSearch
                    ? " 联网开关与本页选项会保存在本机浏览器。"
                    : " 联网开关会保存在本机浏览器。"}
                </p>
                {useWebSearch ? (
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
                        {(apiConfig?.web_search_models ?? []).map((m) => (
                          <SelectItem key={`wf-${m}`} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                        {apiConfig?.web_fetch_model &&
                        !(apiConfig.web_search_models ?? []).includes(
                          apiConfig.web_fetch_model,
                        ) ? (
                          <SelectItem value={apiConfig.web_fetch_model}>
                            {apiConfig.web_fetch_model}（服务端默认 Web 抓取）
                          </SelectItem>
                        ) : null}
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
                      仅用于联网检索阶段，与主席模型独立。下拉为服务端配置的「适合联网」模型（OpenAI / Anthropic /
                      Perplexity / xAI 等原生搜索，以及带{" "}
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
                      {(apiConfig?.council_models ?? []).map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                      {apiConfig?.chairman_model &&
                      !apiConfig.council_models.includes(
                        apiConfig.chairman_model,
                      ) ? (
                        <SelectItem value={apiConfig.chairman_model}>
                          {apiConfig.chairman_model}（默认主席）
                        </SelectItem>
                      ) : null}
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
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <Label>评委权重（Stage2 聚合）</Label>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const models = apiConfig?.council_models ?? [];
                        const reset = buildJudgeWeights(models, null);
                        setJudgeWeights(reset);
                        persistWeights(reset);
                      }}
                    >
                      重置为 1
                    </Button>
                  </div>
                  {(apiConfig?.council_models ?? []).map((m) => (
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
                    key={i}
                    className="rounded-lg border border-border bg-muted/50 px-4 py-3"
                  >
                    <div className="text-xs font-medium text-muted-foreground">
                      你
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{m.content}</p>
                  </div>
                ) : (
                  <CouncilAssistantCard
                    key={i}
                    m={m}
                    msgIndex={i}
                    conversationId={currentId}
                    busyKey={rerunBusy}
                    setBusyKey={setRerunBusy}
                    onReload={() => void loadConversation(currentId!)}
                    sendOpts={sendOpts}
                    setActionError={setActionError}
                    resetErrorState={resetErrorState}
                    armRerunRetry={armRerunRetry}
                  />
                ),
              )}
            </div>
          )}
        </div>

        <footer className="border-t border-border p-4">
          <div className="mx-auto flex max-w-3xl gap-2">
            <Textarea
              rows={4}
              className="flex-1"
              placeholder="输入问题… Enter 发送，Shift+Enter 换行"
              value={input}
              disabled={!currentId}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!loading) void handleSend();
                }
              }}
            />
            {loading ? (
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
              Stage 3 已暂缓执行；请选择上下文更大的模型后重试，或强制使用当前模型（可能被截断或报错）。
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
                  {chairmanContextPrompt.suggested_models.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
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
  stage1Done,
  stage2Done,
  stage3Done,
  loading,
}: {
  webFetchDone: boolean;
  showWebFetch: boolean;
  stage1Done: boolean;
  stage2Done: boolean;
  stage3Done: boolean;
  loading: AssistantMsg["loading"];
}) {
  const steps = [
    ...(showWebFetch
      ? [{ n: 0, label: "W", done: webFetchDone, active: loading.webFetch }]
      : []),
    { n: 1, label: "1", done: stage1Done, active: loading.stage1 },
    { n: 2, label: "2", done: stage2Done, active: loading.stage2 },
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
}: {
  m: AssistantMsg;
  msgIndex: number;
  conversationId: string;
  busyKey: string | null;
  setBusyKey: (k: string | null) => void;
  onReload: () => void;
  sendOpts: () => {
    chairman_model?: string;
    web_fetch_model?: string;
    use_web_search?: boolean;
    judge_weights?: Record<string, number>;
  };
  setActionError: (s: string | null) => void;
  resetErrorState: () => void;
  armRerunRetry: (key: string, fn: () => Promise<void>) => void;
}) {
  const loading = {
    ...DEFAULT_ASSISTANT_LOADING,
    ...(m.loading ?? {}),
  };
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

  const effectiveLoading = {
    webFetch: loading.webFetch,
    stage1: loading.stage1 || busyStage1All,
    stage2: loading.stage2 || busyStage2,
    stage3: loading.stage3 || busyStage2 || busyStage3,
  };

  const showWebFetch = Boolean(m.webFetch) || effectiveLoading.webFetch;

  const stepperStage2Done = s2done && !busyStage2;
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

  const opts = sendOpts();
  const stage3ScrollRef = useRef<HTMLDivElement>(null);

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
      <div className="shrink-0">
        <StepperRow
          webFetchDone={webFetchDone}
          showWebFetch={showWebFetch}
          stage1Done={s1done}
          stage2Done={stepperStage2Done}
          stage3Done={stepperStage3Done}
          loading={effectiveLoading}
        />
      </div>
      <Tabs
        defaultValue={showWebFetch ? "web" : "1"}
        className="flex h-[min(58dvh,32rem)] min-h-[220px] flex-col overflow-hidden pt-1"
      >
        <TabsList className="inline-flex h-auto min-h-10 w-full shrink-0 flex-wrap justify-start gap-1 overflow-x-auto rounded-lg bg-muted p-1">
          {showWebFetch ? <TabsTrigger value="web">Web 抓取</TabsTrigger> : null}
          <TabsTrigger value="1">Stage 1</TabsTrigger>
          <TabsTrigger value="2">Stage 2</TabsTrigger>
          <TabsTrigger value="3">Stage 3</TabsTrigger>
        </TabsList>
        {showWebFetch ? (
          <TabsContent
            value="web"
            className="mt-2 min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
          >
            <WebFetchView data={m.webFetch ?? null} loading={effectiveLoading.webFetch} />
          </TabsContent>
        ) : null}
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
                  await rerunStage1(conversationId, msgIndex, {
                    use_web_search: opts.use_web_search,
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
                    await rerunStage1Model(
                      conversationId,
                      msgIndex,
                      it.model,
                      { use_web_search: opts.use_web_search },
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
                  await rerunStage2(conversationId, msgIndex, {
                    use_web_search: opts.use_web_search,
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
        <TabsContent
          value="3"
          className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
        >
          <div className="flex shrink-0 flex-wrap gap-2 border-b border-border pb-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="[&_svg]:size-3.5"
              disabled={busyKey !== null || !s2done}
              onClick={() =>
                void run("s3", async () => {
                  await rerunStage3(conversationId, msgIndex, {
                    use_web_search: opts.use_web_search,
                    chairman_model: opts.chairman_model,
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
      </div>
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
      {data.sources && data.sources.length > 0 ? (
        <div className="mt-2 rounded-md border border-border bg-muted/40 p-2">
          <div className="text-xs font-medium text-muted-foreground">
            API 结构化来源（url_citation，{data.sources.length} 条）
          </div>
          <ul className="mt-1.5 list-none space-y-2 pl-0 text-xs">
            {data.sources.map((s, i) => (
              <li key={`${s.url}-${i}`} className="wrap-break-word">
                <span className="tabular-nums text-muted-foreground">{i + 1}. </span>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-primary underline underline-offset-2"
                >
                  {s.title?.trim() || s.url}
                </a>
                <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                  {(() => {
                    try {
                      return new URL(s.url).hostname;
                    } catch {
                      return "";
                    }
                  })()}
                </span>
                {s.snippet ? (
                  <p className="mt-0.5 pl-0 text-[11px] leading-snug text-muted-foreground">
                    {s.snippet.length > 280 ? `${s.snippet.slice(0, 280)}…` : s.snippet}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-2 max-w-none text-sm leading-relaxed text-foreground [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2">
        <ReactMarkdown>{data.content}</ReactMarkdown>
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
              busyModel === it.model && "opacity-70",
            )}
            title={it.model}
          >
            {modelShortName(it.model)}
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
            <div className="font-mono text-xs text-muted-foreground">{it.model}</div>
            <div
              className={cn(
                "relative mt-2 min-h-16 overflow-hidden rounded-md",
                isBusy && "ring-2 ring-status-running/40 ring-offset-2 ring-offset-background",
              )}
            >
              <div
                className={cn(
                  "max-w-none text-sm leading-relaxed text-foreground transition-[filter,opacity] duration-300 ease-out [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2",
                  isBusy && "pointer-events-none blur-[6px] opacity-60 select-none",
                )}
              >
                <ReactMarkdown>{it.response}</ReactMarkdown>
              </div>
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
          <ReactMarkdown>{displayed}</ReactMarkdown>
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
