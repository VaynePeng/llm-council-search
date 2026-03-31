"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  listConversations,
  rerunStage1Model,
  rerunStage2,
  rerunStage3,
  sendMessageStream,
  type ApiConfig,
  type Conversation,
  type ConversationMeta,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const WEIGHTS_STORAGE = "llm-council-search-judge-weights";

function modelShortName(model: string): string {
  const p = model.split("/").pop();
  return p && p.length > 0 ? p : model;
}

type Stage1Item = { model: string; response: string };
type Stage2Item = {
  model: string;
  ranking: string;
  parsed_ranking: string[];
};
type Stage3 = { model: string; response: string };

type AssistantMsg = {
  role: "assistant";
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
  loading: { stage1: boolean; stage2: boolean; stage3: boolean };
  stale?: { stage2: boolean; stage3: boolean };
};

const DEFAULT_ASSISTANT_LOADING: AssistantMsg["loading"] = {
  stage1: false,
  stage2: false,
  stage3: false,
};

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
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(null);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [chairmanSelect, setChairmanSelect] = useState<string>("");
  const [chairmanCustom, setChairmanCustom] = useState("");
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [judgeWeights, setJudgeWeights] = useState<Record<string, number>>({});
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [hasRetry, setHasRetry] = useState(false);
  const [rerunBusy, setRerunBusy] = useState<string | null>(null);

  /** 发送失败后重试（流式中失败 reverted=false；fetch 失败 reverted=true） */
  const failedSendRef = useRef<{
    conversationId: string;
    content: string;
    reverted: boolean;
  } | null>(null);
  /** 重跑失败后重试 */
  const rerunRetryRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const chairmanEffective = useMemo(() => {
    if (chairmanSelect === "__custom__") return chairmanCustom.trim();
    if (chairmanSelect) return chairmanSelect;
    return "";
  }, [chairmanSelect, chairmanCustom]);

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
      setConversation(c);
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
        setApiConfig(cfg);
        const stored = loadStoredWeights();
        setJudgeWeights(buildJudgeWeights(cfg.council_models, stored));
        if (!chairmanSelect) setChairmanSelect(cfg.chairman_model);
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

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
      use_web_search: useWebSearch,
      judge_weights: judgeWeights,
    }),
    [chairmanEffective, useWebSearch, judgeWeights],
  );

  const runStreamForContent = useCallback(
    async (convId: string, content: string) => {
      const patchLastAssistant = (fn: (m: AssistantMsg) => AssistantMsg) => {
        setConversation((prev) => {
          if (!prev) return prev;
          const msgs = [...prev.messages];
          const last = msgs[msgs.length - 1] as { role?: string } | undefined;
          if (!last || last.role !== "assistant") return prev;
          msgs[msgs.length - 1] = fn(last as AssistantMsg) as unknown as Conversation["messages"][number];
          return { ...prev, messages: msgs };
        });
      };

      await sendMessageStream(convId, content, (type, ev) => {
        switch (type) {
          case "stage1_start":
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
          case "stage3_start":
            patchLastAssistant((m) => ({
              ...m,
              loading: { ...m.loading, stage3: true },
            }));
            break;
          case "stage3_complete":
            patchLastAssistant((m) => ({
              ...m,
              stage3: ev.data as Stage3,
              loading: { ...m.loading, stage3: false },
            }));
            break;
          case "title_complete":
            void loadConversations();
            break;
          case "complete":
            void loadConversations();
            void loadConversation(convId);
            setLoading(false);
            failedSendRef.current = null;
            setHasRetry(false);
            break;
          case "error":
            setActionError(String(ev.message ?? "流式错误"));
            setLoading(false);
            setHasRetry(true);
            break;
          default:
            break;
        }
      }, sendOpts());
    },
    [loadConversations, loadConversation, sendOpts],
  );

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

    const assistantShell: AssistantMsg = {
      role: "assistant",
      stage1: null,
      stage2: null,
      stage3: null,
      metadata: null,
      loading: { stage1: false, stage2: false, stage3: false },
    };

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
      return { ...prev, messages: msgs };
    });

    try {
      await runStreamForContent(f.conversationId, f.content);
    } catch (e) {
      console.error(e);
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
  }, [currentId, loading, runStreamForContent]);

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
    setConversation((prev) =>
      prev
        ? {
            ...prev,
            messages: [...prev.messages, userMessage] as Conversation["messages"],
          }
        : prev,
    );

    const assistantShell: AssistantMsg = {
      role: "assistant",
      stage1: null,
      stage2: null,
      stage3: null,
      metadata: null,
      loading: { stage1: false, stage2: false, stage3: false },
    };

    setConversation((prev) =>
      prev
        ? {
            ...prev,
            messages: [
              ...prev.messages,
              assistantShell as unknown as Conversation["messages"][number],
            ],
          }
        : prev,
    );

    try {
      await runStreamForContent(currentId, content);
    } catch (e) {
      console.error(e);
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
        <h1 className="text-lg font-semibold tracking-tight">Ai 理事会</h1>
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
    <div className="flex h-[100dvh] overflow-hidden bg-background">
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
            <SheetContent className="flex max-h-[100dvh] flex-col overflow-y-auto">
              <SheetHeader>
                <SheetTitle>高级设置</SheetTitle>
              </SheetHeader>
              <div className="mt-4 space-y-6">
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor="web">OpenRouter 联网（web 插件）</Label>
                  <Switch
                    id="web"
                    checked={useWebSearch}
                    onCheckedChange={setUseWebSearch}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  若模型不支持联网，服务端会尝试去掉插件重试；费用见 OpenRouter 文档。
                </p>
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
              disabled={!currentId || loading}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
            />
            <Button
              disabled={!currentId || loading}
              onClick={() => void handleSend()}
              className="self-end"
            >
              发送
            </Button>
          </div>
        </footer>
      </main>
    </div>
  );
}

function StepperRow({
  stage1Done,
  stage2Done,
  stage3Done,
  loading,
}: {
  stage1Done: boolean;
  stage2Done: boolean;
  stage3Done: boolean;
  loading: AssistantMsg["loading"];
}) {
  const steps = [
    { n: 1, done: stage1Done, active: loading.stage1 },
    { n: 2, done: stage2Done, active: loading.stage2 },
    { n: 3, done: stage3Done, active: loading.stage3 },
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
                {s.n}
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
  const s1done = Boolean(m.stage1?.length);
  const s2done = Boolean(m.stage2?.length);
  const s3done = Boolean(m.stage3 && m.stage3.response);

  const stale2 = m.stale?.stage2;
  const stale3 = m.stale?.stage3;

  const busyStage1Model =
    busyKey?.startsWith("s1-") === true ? busyKey.slice(3) : null;
  const busyStage2 = busyKey === "s2";
  const busyStage3 = busyKey === "s3";

  const effectiveLoading = {
    stage1: loading.stage1,
    stage2: loading.stage2 || busyStage2,
    stage3: loading.stage3 || busyStage2 || busyStage3,
  };

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

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex shrink-0 flex-wrap items-center gap-2 mb-1">
        <span className="text-xs font-medium text-muted-foreground">
          Ai 理事会
        </span>
        {stale2 ? (
          <Badge variant="warning">Stage2/3 可能已过期</Badge>
        ) : null}
        {!stale2 && stale3 ? (
          <Badge variant="warning">Stage3 可能已过期</Badge>
        ) : null}
      </div>
      <div className="shrink-0">
        <StepperRow
          stage1Done={s1done}
          stage2Done={stepperStage2Done}
          stage3Done={stepperStage3Done}
          loading={effectiveLoading}
        />
      </div>
      <Tabs
        defaultValue="1"
        className="flex h-[min(58dvh,32rem)] min-h-[220px] flex-col overflow-hidden pt-1"
      >
        <TabsList className="inline-flex h-auto min-h-10 w-full shrink-0 flex-wrap justify-start gap-1 overflow-x-auto rounded-lg bg-muted p-1">
          <TabsTrigger value="1">Stage 1</TabsTrigger>
          <TabsTrigger value="2">Stage 2</TabsTrigger>
          <TabsTrigger value="3">Stage 3</TabsTrigger>
        </TabsList>
        <TabsContent
          value="1"
          className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
        >
          <div className="flex shrink-0 flex-wrap gap-2 border-b border-border pb-2">
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
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-2 pr-1">
            <Stage3View data={m.stage3} loading={effectiveLoading.stage3} />
          </div>
        </TabsContent>
      </Tabs>
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
              "max-w-[9rem] shrink-0 truncate text-xs transition-opacity duration-300",
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
                "relative mt-2 min-h-[4rem] overflow-hidden rounded-md",
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
            className="max-w-[9rem] shrink-0 truncate text-xs"
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
          <pre className="mt-2 min-h-[6rem] whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-xs leading-relaxed">
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
  data,
  loading,
}: {
  data: Stage3 | null;
  loading: boolean;
}) {
  if (loading)
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
  return (
    <div className="rounded-lg border border-status-success-border bg-status-success/25 p-3">
      <div className="font-mono text-xs text-muted-foreground">{data.model}</div>
      <div className="mt-2 max-w-none text-sm leading-relaxed text-foreground [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2">
        <ReactMarkdown>{data.response}</ReactMarkdown>
      </div>
    </div>
  );
}
