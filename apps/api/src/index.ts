import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  ALLOWED_ORIGINS,
  API_PORT,
  CHAIRMAN_MODEL,
  CHAIRMAN_OUTPUT_RESERVE_TOKENS,
  COUNCIL_MODELS,
  FOLLOWUP_MODEL,
  TITLE_MODEL,
  WEB_FETCH_MODEL,
  WEB_SEARCH_MODELS,
  chairmanContextLimitsForApi,
  resolveChairmanContextLimit,
} from "./config.js";
import {
  buildStage1UserPrompt,
  calculateAggregateRankings,
  composeEffectiveUserQuery,
  decideWebSearchPlan,
  describeWebFetchScope,
  gateChairmanStage3,
  generateConversationTitle,
  hasVerifiedWebFetchSources,
  labelToModelFromStage1,
  parseWebSearchMode,
  runFullCouncil,
  stage1CollectResponses,
  stage2CollectRankings,
  stage3SynthesizeFinal,
  stage3SynthesizeFinalStream,
  stageWebFetch,
  successfulStage1Items,
  synthesizeFollowUpAnswer,
  synthesizeFollowUpAnswerStream,
} from "./council.js";
import { withConversationLock } from "./lock.js";
import { queryModel } from "./openrouter.js";
import { getOpenRouterModelCatalog } from "./openrouter-models.js";
import {
  logError,
  logInfo,
  logWarn,
  summarizeError,
  summarizeText,
  withLogContext,
} from "./logging.js";
import {
  addAssistantMessage,
  addUserMessage,
  createConversation,
  deleteConversation,
  findPreviousUserQuery,
  getConversation,
  isAssistantMessage,
  listConversations,
  messagesBeforeIndex,
  saveConversation,
  updateConversationTitle,
  type Stage3Result,
} from "./storage.js";

type AppEnv = {
  Variables: {
    requestId: string;
    requestStartedAt: number;
  };
};

const app = new Hono<AppEnv>();
const allowedOrigins = new Set(ALLOWED_ORIGINS);

/** 正在进行的流式任务控制器（conversationId → AbortController） */
const taskControllers = new Map<string, AbortController>();

function bodySummary(body: SendBody): Record<string, unknown> {
  return {
    contentPreview: summarizeText(body.content?.trim(), 120),
    chairmanModel: parseChairman(body),
    followupModel: parseFollowupModel(body),
    webFetchModel: parseWebFetchModel(body),
    councilModels: body.council_models,
    useWebSearch: body.use_web_search,
    webSearchMode: body.use_web_search_mode,
    continueUseWebSearch: body.continue_use_web_search,
    filterUntrustedSources: body.filter_untrusted_sources,
    hasJudgeWeights: Boolean(parseJudgeWeights(body)),
  };
}

function webFetchSummary(webFetch: Awaited<ReturnType<typeof stageWebFetch>> | undefined): Record<string, unknown> {
  return {
    hasWebFetch: Boolean(webFetch),
    webFetchModel: webFetch?.model,
    webFetchSourceCount: webFetch?.sources?.length ?? 0,
    webSearchAction: webFetch?.webSearchAction,
    webSearchSkipped: webFetch?.webSearchSkipped ?? false,
    webSearchVerified: webFetch?.webSearchVerified ?? false,
  };
}

function stage3Summary(stage3: Stage3Result): Record<string, unknown> {
  return {
    stage3Model: stage3.model,
    stage3ResponsePreview: summarizeText(stage3.response, 160),
  };
}

function logValidationFailure(
  event: string,
  detail: string,
  data?: Record<string, unknown>,
): void {
  logWarn(event, {
    detail,
    ...(data ?? {}),
  });
}

function logConversationMissing(id: string): void {
  logValidationFailure("conversation.lookup.miss", "Conversation not found", {
    conversationId: id,
  });
}

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "";
      return allowedOrigins.has(origin) ? origin : "";
    },
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["*"],
    credentials: true,
  }),
);

app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const requestStartedAt = Date.now();
  const url = new URL(c.req.url);
  c.set("requestId", requestId);
  c.set("requestStartedAt", requestStartedAt);

  return withLogContext(
    {
      requestId,
      route: `${c.req.method} ${url.pathname}`,
    },
    async () => {
      logInfo("request.start", {
        method: c.req.method,
        path: url.pathname,
        userAgent: c.req.header("user-agent"),
      });
      try {
        await next();
      } catch (error) {
        logError("request.unhandled_error", {
          durationMs: Date.now() - requestStartedAt,
          error: summarizeError(error),
        });
        throw error;
      } finally {
        logInfo("request.finish", {
          status: c.res.status,
          durationMs: Date.now() - requestStartedAt,
        });
      }
    },
  );
});

app.get("/", (c) =>
  c.json({ status: "ok", service: "Vela 助手 API (Hono)" }),
);

app.get("/api/config", async (c) => {
  logInfo("config.requested");
  let featured_model_groups: Awaited<ReturnType<typeof getOpenRouterModelCatalog>>["featuredModelGroups"] = [];
  let available_model_ids: string[] = [];
  try {
    const catalog = await getOpenRouterModelCatalog();
    featured_model_groups = catalog.featuredModelGroups;
    available_model_ids = catalog.availableModelIds;
  } catch (err) {
    logWarn("config.catalog_load_failed", {
      error: summarizeError(err),
    });
  }

  logInfo("config.responding", {
    councilModelCount: COUNCIL_MODELS.length,
    webSearchModelCount: WEB_SEARCH_MODELS.length,
    availableModelCount: available_model_ids.length,
    featuredGroupCount: featured_model_groups.length,
  });
  return c.json({
    council_models: COUNCIL_MODELS,
    web_search_models: WEB_SEARCH_MODELS,
    chairman_model: CHAIRMAN_MODEL,
    followup_model: FOLLOWUP_MODEL,
    title_model: TITLE_MODEL,
    web_fetch_model: WEB_FETCH_MODEL,
    chairman_context_limits: chairmanContextLimitsForApi(),
    chairman_output_reserve_tokens: CHAIRMAN_OUTPUT_RESERVE_TOKENS,
    available_model_ids,
    featured_model_groups,
  });
});

app.get("/api/conversations", async (c) => {
  const list = await listConversations();
  logInfo("conversations.list.done", {
    count: list.length,
  });
  return c.json(list);
});

app.post("/api/conversations", async (c) => {
  const id = crypto.randomUUID();
  const conv = await createConversation(id);
  logInfo("conversations.create.done", {
    conversationId: id,
    messageCount: conv.messages.length,
  });
  return c.json(conv);
});

app.get("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const conv = await getConversation(id);
  if (!conv) {
    logConversationMissing(id);
    return c.json({ detail: "Conversation not found" }, 404);
  }
  logInfo("conversations.get.done", {
    conversationId: id,
    messageCount: conv.messages.length,
    title: summarizeText(conv.title, 80),
  });
  return c.json(conv);
});

app.delete("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const ok = await deleteConversation(id);
  if (!ok) {
    logConversationMissing(id);
    return c.json({ detail: "Conversation not found" }, 404);
  }
  logInfo("conversations.delete.done", {
    conversationId: id,
  });
  return c.body(null, 204);
});

function extractApiKey(c: { req: { header: (k: string) => string | undefined } }): string | undefined {
  return c.req.header("x-openrouter-key")?.trim() || undefined;
}

const MISSING_API_KEY_DETAIL =
  "OpenRouter API key required via X-OpenRouter-Key header";

const STAGE1_FAILURE_MESSAGE =
  "All Stage 1 model requests failed. Check your OpenRouter API key, account credits, model availability, or server logs for the upstream error.";

function topChairmanModelsByContext(models: string[], limit = 5): string[] {
  return [...new Set(models.filter(Boolean))]
    .sort((a, b) => resolveChairmanContextLimit(b) - resolveChairmanContextLimit(a))
    .slice(0, limit);
}

type SendBody = {
  content?: string;
  chairman_model?: string;
  followup_model?: string;
  /** 与 `chairman_model` 同义（见项目重构 §5.4） */
  final_model?: string;
  council_models?: string[];
  use_web_search?: boolean;
  use_web_search_mode?: "off" | "auto" | "on";
  continue_use_web_search?: boolean;
  filter_untrusted_sources?: boolean;
  /** 覆盖服务端 `WEB_FETCH_MODEL`，用于联网检索阶段 */
  web_fetch_model?: string;
  judge_weights?: Record<string, number>;
  /** 与 `judge_weights` 同义（见项目重构 §5.3 文档中的 weights 表述） */
  weights?: Record<string, number>;
};

function parseChairman(
  body: Pick<SendBody, "chairman_model" | "final_model">,
): string | undefined {
  const a = body.chairman_model?.trim();
  const b = body.final_model?.trim();
  const v = a || b;
  return v || undefined;
}

function parseJudgeWeights(body: {
  judge_weights?: Record<string, number>;
  weights?: Record<string, number>;
}): Record<string, number> | undefined {
  const j = body.judge_weights ?? body.weights;
  if (!j || typeof j !== "object") return undefined;
  return j;
}

function parseWebFetchModel(body: { web_fetch_model?: string }): string | undefined {
  const v = body.web_fetch_model?.trim();
  return v || undefined;
}

function parseFollowupModel(body: { followup_model?: string }): string | undefined {
  const v = body.followup_model?.trim();
  return v || undefined;
}

function parseCouncilModels(body: {
  council_models?: string[];
}): { models?: string[]; error?: string } {
  if (body.council_models == null) return {};
  if (!Array.isArray(body.council_models)) {
    return { error: "council_models must be an array" };
  }
  const models = [...new Set(body.council_models.map((v) => String(v ?? "").trim()).filter(Boolean))];
  if (models.length < 2) {
    return { error: "council_models must contain at least 2 models" };
  }
  return { models };
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: string })?.name === "AbortError";
}

app.post("/api/conversations/:id/message", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as SendBody;
  const content = body.content?.trim();
  if (!content) {
    logValidationFailure("message.create.invalid_body", "content required", {
      conversationId: id,
    });
    return c.json({ detail: "content required" }, 400);
  }
  const councilModels = parseCouncilModels(body);
  if (councilModels.error) {
    logValidationFailure("message.create.invalid_body", councilModels.error, {
      conversationId: id,
      ...bodySummary(body),
    });
    return c.json({ detail: councilModels.error }, 400);
  }
  const apiKey = extractApiKey(c);
  if (!apiKey) {
    logValidationFailure("message.create.missing_api_key", MISSING_API_KEY_DETAIL, {
      conversationId: id,
    });
    return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);
  }

  logInfo("message.create.received", {
    conversationId: id,
    ...bodySummary(body),
  });

  const conv = await getConversation(id);
  if (!conv) {
    logConversationMissing(id);
    return c.json({ detail: "Conversation not found" }, 404);
  }

  const shouldGenerateTitle =
    conv.messages.length === 0 ||
    !conv.title?.trim() ||
    conv.title.trim() === "New Conversation";
  const isFollowup = conv.messages.some((message) => message.role === "assistant");
  const judgeWeights = parseJudgeWeights(body);
  const webSearchMode = parseWebSearchMode(
    body.use_web_search_mode,
    body.use_web_search,
  );
  const filterUntrustedSources = Boolean(body.filter_untrusted_sources);

  logInfo("message.create.context_loaded", {
    conversationId: id,
    existingMessageCount: conv.messages.length,
    shouldGenerateTitle,
    isFollowup,
    webSearchMode,
    filterUntrustedSources,
  });

  await withConversationLock(id, async () => {
    await addUserMessage(id, content);
  });
  logInfo("message.create.user_saved", {
    conversationId: id,
    contentPreview: summarizeText(content, 120),
  });

  if (shouldGenerateTitle) {
    const title = await generateConversationTitle(
      content,
      apiKey,
      c.req.raw.signal,
    );
    await withConversationLock(id, async () => {
      await updateConversationTitle(id, title);
    });
    logInfo("message.create.title_saved", {
      conversationId: id,
      title: summarizeText(title, 80),
    });
  }

  if (isFollowup) {
    const continueUseWebSearch = Boolean(body.continue_use_web_search);
    const effectiveQuery = composeEffectiveUserQuery(content, conv.messages);
    logInfo("message.create.followup.start", {
      conversationId: id,
      continueUseWebSearch,
      effectiveQueryPreview: summarizeText(effectiveQuery, 120),
    });
    const webFetch = continueUseWebSearch
      ? await stageWebFetch(
          effectiveQuery,
          parseWebFetchModel(body),
          apiKey,
          c.req.raw.signal,
          {
            requestedMode: "on",
            action: "search",
            reason: "继续对话已开启联网搜索。",
          },
          filterUntrustedSources,
        )
      : undefined;
    if (webFetch) {
      logInfo("message.create.followup.web_fetch_done", {
        conversationId: id,
        ...webFetchSummary(webFetch),
      });
    }
    const stage3 = await synthesizeFollowUpAnswer(
      content,
      conv.messages,
      parseFollowupModel(body),
      apiKey,
      c.req.raw.signal,
      webFetch?.content,
    );
    logInfo("message.create.followup.answer_done", {
      conversationId: id,
      ...stage3Summary(stage3),
    });

    await withConversationLock(id, async () => {
      await addAssistantMessage(
        id,
        [],
        [],
        stage3,
        { label_to_model: {}, aggregate_rankings: [] },
        webFetch,
        "followup",
      );
    });
    logInfo("message.create.followup.saved", {
      conversationId: id,
    });

    return c.json({
      webFetch,
      stage1: [],
      stage2: [],
      stage3,
      metadata: { label_to_model: {}, aggregate_rankings: [] },
      responseMode: "followup",
    });
  }

  const webSearchPlan = await decideWebSearchPlan(
    content,
    conv.messages,
    webSearchMode,
    apiKey,
    c.req.raw.signal,
  );
  logInfo("message.create.council.plan_done", {
    conversationId: id,
    requestedMode: webSearchMode,
    action: webSearchPlan.action,
    reason: webSearchPlan.reason,
  });
  const [s1, s2, s3, meta, webFetch] = await runFullCouncil(content, {
    chairmanModel: parseChairman(body),
    webSearchMode,
    councilModels: councilModels.models,
    webFetchModel: parseWebFetchModel(body),
    judgeWeights,
    apiKey,
    signal: c.req.raw.signal,
    historyMessages: conv.messages,
    webSearchPlan,
    filterUntrustedSources,
  });
  logInfo("message.create.council.completed", {
    conversationId: id,
    stage1Count: s1.length,
    stage2Count: s2.length,
    ...stage3Summary(s3),
    ...webFetchSummary(webFetch),
  });

  await withConversationLock(id, async () => {
    await addAssistantMessage(
      id,
      s1,
      s2,
      s3,
      {
        label_to_model: meta.label_to_model,
        aggregate_rankings: meta.aggregate_rankings,
      },
      webFetch,
      "council",
    );
  });
  logInfo("message.create.council.saved", {
    conversationId: id,
  });

  return c.json({
    webFetch,
    stage1: s1,
    stage2: s2,
    stage3: s3,
    metadata: meta,
    responseMode: "council",
  });
});

function sseLine(obj: unknown): Uint8Array {
  const s = `data: ${JSON.stringify(obj)}\n\n`;
  return new TextEncoder().encode(s);
}

function sseComment(text: string): Uint8Array {
  return new TextEncoder().encode(`: ${text}\n\n`);
}

function ssePadding(size = 2048): Uint8Array {
  return new TextEncoder().encode(`: ${" ".repeat(size)}\n\n`);
}

const SSE_HEARTBEAT_MS = 10_000;

app.post("/api/conversations/:id/message/stream", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as SendBody;
  const content = body.content?.trim();
  if (!content) {
    logValidationFailure("message.stream.invalid_body", "content required", {
      conversationId: id,
    });
    return c.json({ detail: "content required" }, 400);
  }
  const councilModels = parseCouncilModels(body);
  if (councilModels.error) {
    logValidationFailure("message.stream.invalid_body", councilModels.error, {
      conversationId: id,
      ...bodySummary(body),
    });
    return c.json({ detail: councilModels.error }, 400);
  }
  const apiKey = extractApiKey(c);
  if (!apiKey) {
    logValidationFailure("message.stream.missing_api_key", MISSING_API_KEY_DETAIL, {
      conversationId: id,
    });
    return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);
  }

  logInfo("message.stream.received", {
    conversationId: id,
    ...bodySummary(body),
  });

  const conv = await getConversation(id);
  if (!conv) {
    logConversationMissing(id);
    return c.json({ detail: "Conversation not found" }, 404);
  }

  const shouldGenerateTitle =
    conv.messages.length === 0 ||
    !conv.title?.trim() ||
    conv.title.trim() === "New Conversation";
  const isFollowup = conv.messages.some((message) => message.role === "assistant");
  const chairmanModel = parseChairman(body);
  const followupModel = parseFollowupModel(body);
  const webFetchModel = parseWebFetchModel(body);
  const judgeWeights = parseJudgeWeights(body);
  const webSearchMode = parseWebSearchMode(
    body.use_web_search_mode,
    body.use_web_search,
  );
  const continueUseWebSearch = Boolean(body.continue_use_web_search);
  const filterUntrustedSources = Boolean(body.filter_untrusted_sources);
  const effectiveCouncilModels = councilModels.models ?? COUNCIL_MODELS;

  logInfo("message.stream.context_loaded", {
    conversationId: id,
    existingMessageCount: conv.messages.length,
    shouldGenerateTitle,
    isFollowup,
    webSearchMode,
    continueUseWebSearch,
    filterUntrustedSources,
    councilModelCount: effectiveCouncilModels.length,
  });

  // 任务级 AbortController：不随 HTTP 请求断开而终止，仅在显式取消时终止
  const taskController = new AbortController();
  taskControllers.set(id, taskController);
  const taskSignal = taskController.signal;
  logInfo("message.stream.task_registered", {
    conversationId: id,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const requestSignal = c.req.raw.signal;
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      // 客户端断连（刷新/导航）时关闭 SSE 流，但不中止后台任务
      const onRequestAbort = () => {
        logWarn("message.stream.client_disconnected", {
          conversationId: id,
        });
        try { controller.close(); } catch { /* already closed */ }
      };
      requestSignal.addEventListener("abort", onRequestAbort, { once: true });

      // push 安全包装：客户端已断连时静默忽略
      const push = (obj: unknown) => {
        if (requestSignal.aborted) return;
        try { controller.enqueue(sseLine(obj)); } catch { /* stream closed */ }
      };

      try {
        controller.enqueue(ssePadding());
        controller.enqueue(sseComment("stream-open"));
        push({ type: "stream_open", data: { conversationId: id } });
        heartbeat = setInterval(() => {
          if (requestSignal.aborted) return;
          try {
            controller.enqueue(sseComment("keepalive"));
          } catch {
            /* stream closed */
          }
        }, SSE_HEARTBEAT_MS);
      } catch {
        /* stream closed before first flush */
      }

      // 仅在显式取消（Stop 按钮调用 cancel 接口）时中止
      const ensureNotAborted = () => {
        if (taskSignal.aborted) {
          const err = new Error("Aborted");
          err.name = "AbortError";
          throw err;
        }
      };

      try {
        ensureNotAborted();

        await withConversationLock(id, async () => {
          await addUserMessage(id, content);
        });
        logInfo("message.stream.user_saved", {
          conversationId: id,
          contentPreview: summarizeText(content, 120),
        });

        const titlePromise = shouldGenerateTitle
          ? generateConversationTitle(content, apiKey, taskSignal)
          : null;

        void (async () => {
          if (!titlePromise) return;
          try {
            const title = await titlePromise;
            ensureNotAborted();
            await withConversationLock(id, async () => {
              await updateConversationTitle(id, title);
            });
            logInfo("message.stream.title_saved", {
              conversationId: id,
              title: summarizeText(title, 80),
            });
            try {
              push({ type: "title_complete", data: { title } });
            } catch {
              /* 流可能已因错误提前关闭 */
            }
          } catch (err) {
            logWarn("message.stream.title_failed", {
              conversationId: id,
              error: summarizeError(err),
            });
          }
        })();

        const effectiveQuery = composeEffectiveUserQuery(content, conv.messages);
        logInfo("message.stream.query_composed", {
          conversationId: id,
          effectiveQueryPreview: summarizeText(effectiveQuery, 120),
        });
        let webFetchResult: Awaited<ReturnType<typeof stageWebFetch>> | undefined;
        let webContext: string | undefined;

        if (isFollowup) {
          logInfo("message.stream.followup.start", {
            conversationId: id,
            continueUseWebSearch,
          });
          if (continueUseWebSearch) {
            push({ type: "web_fetch_start", data: { model: webFetchModel?.trim() || WEB_FETCH_MODEL } });
            const scopePreview = await describeWebFetchScope(
              effectiveQuery,
              apiKey,
              taskSignal,
            );
            if (scopePreview) {
              push({ type: "web_fetch_scope", data: scopePreview });
            }
            webFetchResult = await stageWebFetch(
              effectiveQuery,
              webFetchModel,
              apiKey,
              taskSignal,
              {
                requestedMode: "on",
                action: "search",
                reason: "继续对话已开启联网搜索。",
              },
              filterUntrustedSources,
              scopePreview,
            );
            push({ type: "web_fetch_complete", data: webFetchResult });
            logInfo("message.stream.followup.web_fetch_done", {
              conversationId: id,
              ...webFetchSummary(webFetchResult),
            });
            if (!webFetchResult.webSearchSkipped && hasVerifiedWebFetchSources(webFetchResult)) {
              webContext = webFetchResult.content;
            }
          }

          push({ type: "followup_start", data: { model: followupModel?.trim() || FOLLOWUP_MODEL } });
          const followupResult = await synthesizeFollowUpAnswerStream(
            content,
            conv.messages,
            followupModel,
            (delta) => push({ type: "followup_delta", data: { delta } }),
            apiKey,
            taskSignal,
            webContext,
          );
          push({ type: "followup_complete", data: followupResult });
          logInfo("message.stream.followup.answer_done", {
            conversationId: id,
            ...stage3Summary(followupResult),
          });

          ensureNotAborted();
          await withConversationLock(id, async () => {
            await addAssistantMessage(
              id,
              [],
              [],
              followupResult,
              { label_to_model: {}, aggregate_rankings: [] },
              webFetchResult,
              "followup",
            );
          });
          logInfo("message.stream.followup.saved", {
            conversationId: id,
          });
          push({
            type: "complete",
            data: {
              responseMode: "followup",
              webFetch: webFetchResult,
              stage1: [],
              stage2: [],
              stage3: followupResult,
              metadata: { label_to_model: {}, aggregate_rankings: [] },
            },
          });
          return;
        }

        // 在流内决策，避免阻塞 HTTP 握手导致前端卡在初始骨架屏
        const webSearchPlan = await decideWebSearchPlan(
          content,
          conv.messages,
          webSearchMode,
          apiKey,
          taskSignal,
        );
        logInfo("message.stream.council.plan_done", {
          conversationId: id,
          requestedMode: webSearchMode,
          action: webSearchPlan.action,
          reason: webSearchPlan.reason,
        });

        if (webSearchPlan.action === "reuse" && webSearchPlan.previousWebFetch) {
          webFetchResult = {
            ...webSearchPlan.previousWebFetch,
            webSearchMode,
            webSearchAction: "reuse",
            webSearchReason: webSearchPlan.reason,
            reusedFromPrevious: true,
          };
          push({ type: "web_fetch_complete", data: webFetchResult });
          logInfo("message.stream.council.web_fetch_reused", {
            conversationId: id,
            ...webFetchSummary(webFetchResult),
          });
          if (!webFetchResult.webSearchSkipped && hasVerifiedWebFetchSources(webFetchResult)) {
            webContext = webFetchResult.content;
          }
        } else if (webSearchPlan.action === "search") {
          push({ type: "web_fetch_start", data: { model: webFetchModel?.trim() || WEB_FETCH_MODEL } });
          const scopePreview = await describeWebFetchScope(
            effectiveQuery,
            apiKey,
            taskSignal,
          );
          if (scopePreview) {
            push({ type: "web_fetch_scope", data: scopePreview });
          }
          webFetchResult = await stageWebFetch(
            effectiveQuery,
            webFetchModel,
            apiKey,
            taskSignal,
            webSearchPlan,
            filterUntrustedSources,
            scopePreview,
          );
          push({ type: "web_fetch_complete", data: webFetchResult });
          logInfo("message.stream.council.web_fetch_done", {
            conversationId: id,
            ...webFetchSummary(webFetchResult),
          });
          if (!webFetchResult.webSearchSkipped && hasVerifiedWebFetchSources(webFetchResult)) {
            webContext = webFetchResult.content;
          }
        }

        push({ type: "stage1_start" });
        const stage1Results = await stage1CollectResponses(
          effectiveQuery,
          webContext,
          webFetchResult?.retrievedAt != null && webContext
            ? {
                isoUtc: webFetchResult.retrievedAt,
                unixSeconds: webFetchResult.retrievedAtUnixSeconds ?? 0,
              }
            : undefined,
          apiKey,
          taskSignal,
          effectiveCouncilModels,
        );
        push({ type: "stage1_complete", data: stage1Results });
        logInfo("message.stream.council.stage1_done", {
          conversationId: id,
          stage1Count: stage1Results.length,
          stage1SuccessCount: successfulStage1Items(stage1Results).length,
        });

        if (successfulStage1Items(stage1Results).length === 0) {
          const stage3Result: Stage3Result = {
            model: "error",
            response: STAGE1_FAILURE_MESSAGE,
          };

          ensureNotAborted();
          await withConversationLock(id, async () => {
            await addAssistantMessage(
              id,
              stage1Results,
              [],
              stage3Result,
              {
                label_to_model: {},
                aggregate_rankings: [],
              },
              webFetchResult,
              "council",
            );
          });
          logWarn("message.stream.council.stage1_all_failed", {
            conversationId: id,
          });

          push({ type: "stage3_complete", data: stage3Result });
          push({ type: "complete" });
          return;
        }

        push({ type: "stage2_start" });
        const [stage2Results, labelToModel] = await stage2CollectRankings(
          effectiveQuery,
          stage1Results,
          apiKey,
          taskSignal,
          effectiveCouncilModels,
        );
        const aggregateRankings = calculateAggregateRankings(
          stage2Results,
          labelToModel,
          judgeWeights,
        );
        logInfo("message.stream.council.stage2_done", {
          conversationId: id,
          stage2Count: stage2Results.length,
          aggregateRankingCount: aggregateRankings.length,
        });
        push({
          type: "stage2_complete",
          data: stage2Results,
          metadata: {
            label_to_model: labelToModel,
            aggregate_rankings: aggregateRankings,
          },
        });

        const chairModel = chairmanModel?.trim() || CHAIRMAN_MODEL;
        const gate = gateChairmanStage3(
          effectiveQuery,
          stage1Results,
          stage2Results,
          chairmanModel,
          judgeWeights,
          labelToModel,
          webFetchResult?.sources,
        );

        let stage3Result: Stage3Result;

        if (!gate.proceed) {
          stage3Result = gate.stage3;
          const candidates = [
            ...effectiveCouncilModels,
            CHAIRMAN_MODEL,
            gate.analysis.chairman_model,
          ];
          const suggested = topChairmanModelsByContext(candidates, 5);

          ensureNotAborted();
          await withConversationLock(id, async () => {
            await addAssistantMessage(
              id,
              stage1Results,
              stage2Results,
              stage3Result,
              {
                label_to_model: labelToModel,
                aggregate_rankings: aggregateRankings,
              },
              webFetchResult,
              "council",
            );
          });
          logWarn("message.stream.council.stage3_blocked", {
            conversationId: id,
            chairmanModel: gate.analysis.chairman_model,
            estimatedInputTokens: gate.analysis.estimated_input_tokens,
            contextLimit: gate.analysis.context_limit,
          });

          const convAfter = await getConversation(id);
          const msgIndex = convAfter ? convAfter.messages.length - 1 : -1;
          push({
            type: "chairman_context_prompt",
            data: {
              message_index: msgIndex,
              chairman_model: gate.analysis.chairman_model,
              estimated_input_tokens: gate.analysis.estimated_input_tokens,
              context_limit: gate.analysis.context_limit,
              max_input_tokens: gate.analysis.max_input_tokens,
              suggested_models: suggested,
              stage3: stage3Result,
            },
          });
        } else {
          push({ type: "stage3_start", data: { model: chairModel } });
          stage3Result = await stage3SynthesizeFinalStream(
            effectiveQuery,
            stage1Results,
            stage2Results,
            chairmanModel,
            judgeWeights,
            labelToModel,
            (delta) => push({ type: "stage3_delta", data: { delta } }),
            apiKey,
            taskSignal,
            webFetchResult?.sources,
          );
          push({ type: "stage3_complete", data: stage3Result });
          logInfo("message.stream.council.stage3_done", {
            conversationId: id,
            ...stage3Summary(stage3Result),
          });

          ensureNotAborted();
          await withConversationLock(id, async () => {
            await addAssistantMessage(
              id,
              stage1Results,
              stage2Results,
              stage3Result,
              {
                label_to_model: labelToModel,
                aggregate_rankings: aggregateRankings,
              },
              webFetchResult,
            );
          });
          logInfo("message.stream.council.saved", {
            conversationId: id,
          });
        }
        push({ type: "complete" });
      } catch (e) {
        if (isAbortError(e)) {
          logWarn("message.stream.aborted", {
            conversationId: id,
          });
          return;
        }
        logError("message.stream.failed", {
          conversationId: id,
          error: summarizeError(e),
        });
        push({
          type: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        requestSignal.removeEventListener("abort", onRequestAbort);
        taskControllers.delete(id);
        logInfo("message.stream.task_finished", {
          conversationId: id,
        });
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// 显式取消正在进行的流式任务（Stop 按钮调用）
app.delete("/api/conversations/:id/stream", (c) => {
  const id = c.req.param("id");
  const ctrl = taskControllers.get(id);
  if (ctrl) {
    ctrl.abort();
    taskControllers.delete(id);
    logInfo("message.stream.cancelled", {
      conversationId: id,
    });
    return c.json({ cancelled: true });
  }
  logInfo("message.stream.cancel_noop", {
    conversationId: id,
  });
  return c.json({ cancelled: false });
});

type RerunBody = {
  model?: string;
  council_models?: string[];
  use_web_search?: boolean;
  use_web_search_mode?: "off" | "auto" | "on";
  chairman_model?: string;
  final_model?: string;
  judge_weights?: Record<string, number>;
  weights?: Record<string, number>;
  /** 为 true 时跳过主席上下文检查并强制调用 Stage3（可能遭 API 截断或报错） */
  skip_chairman_context_check?: boolean;
};

function parseMsgIndex(c: { req: { param: (k: string) => string } }): number {
  const n = parseInt(c.req.param("msgIndex"), 10);
  return Number.isFinite(n) ? n : -1;
}

app.post(
  "/api/conversations/:id/messages/:msgIndex/rerun-stage1-model",
  async (c) => {
    const id = c.req.param("id");
    const msgIndex = parseMsgIndex(c);
    if (msgIndex < 0) {
      logValidationFailure("message.rerun_stage1_model.invalid_body", "invalid msgIndex", {
        conversationId: id,
      });
      return c.json({ detail: "invalid msgIndex" }, 400);
    }
    const apiKey = extractApiKey(c);
    if (!apiKey) {
      logValidationFailure("message.rerun_stage1_model.missing_api_key", MISSING_API_KEY_DETAIL, {
        conversationId: id,
        msgIndex,
      });
      return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);
    }

    const body = (await c.req.json().catch(() => ({}))) as RerunBody;
    const councilModels = parseCouncilModels(body);
    if (councilModels.error) {
      logValidationFailure("message.rerun_stage1_model.invalid_body", councilModels.error, {
        conversationId: id,
        msgIndex,
      });
      return c.json({ detail: councilModels.error }, 400);
    }
    const model = body.model?.trim();
    if (!model) {
      logValidationFailure("message.rerun_stage1_model.invalid_body", "model required", {
        conversationId: id,
        msgIndex,
      });
      return c.json({ detail: "model required" }, 400);
    }
    logInfo("message.rerun_stage1_model.received", {
      conversationId: id,
      msgIndex,
      model,
    });

    const result = await withConversationLock(id, async () => {
      const conv = await getConversation(id);
      if (!conv) return { error: "Conversation not found" as const };
      if (msgIndex >= conv.messages.length)
        return { error: "invalid msgIndex" as const };
      const msg = conv.messages[msgIndex];
      if (!isAssistantMessage(msg))
        return { error: "message is not assistant" as const };

      const userQuery = findPreviousUserQuery(conv.messages, msgIndex);
      if (!userQuery) return { error: "no preceding user message" as const };
      const history = messagesBeforeIndex(conv.messages, msgIndex - 1);
      const effectiveQuery = composeEffectiveUserQuery(userQuery, history);
      const rerunMode = parseWebSearchMode(
        body.use_web_search_mode,
        body.use_web_search,
      );
      const rerunPlan = await decideWebSearchPlan(
        userQuery,
        history,
        rerunMode,
        apiKey,
        c.req.raw.signal,
      );

      let webContext: string | undefined;
      let webRetrievalMeta:
        | {
            isoUtc: string;
            unixSeconds: number;
          }
        | undefined;
      if (
        rerunPlan.action === "reuse" &&
        rerunPlan.previousWebFetch &&
        !rerunPlan.previousWebFetch.webSearchSkipped &&
        hasVerifiedWebFetchSources(rerunPlan.previousWebFetch)
      ) {
        webContext = rerunPlan.previousWebFetch.content;
        if (rerunPlan.previousWebFetch.retrievedAt) {
          webRetrievalMeta = {
            isoUtc: rerunPlan.previousWebFetch.retrievedAt,
            unixSeconds: rerunPlan.previousWebFetch.retrievedAtUnixSeconds ?? 0,
          };
        }
      } else if (
        rerunMode !== "off" &&
        msg.webFetch &&
        !msg.webFetch.webSearchSkipped &&
        hasVerifiedWebFetchSources(msg.webFetch)
      ) {
        webContext = msg.webFetch.content;
        if (msg.webFetch.retrievedAt) {
          webRetrievalMeta = {
            isoUtc: msg.webFetch.retrievedAt,
            unixSeconds: msg.webFetch.retrievedAtUnixSeconds ?? 0,
          };
        }
      }

      const res = await queryModel(
        model,
        [{
          role: "user",
          content: buildStage1UserPrompt(
            effectiveQuery,
            webContext,
            webRetrievalMeta,
          ),
        }],
        { apiKey },
      );

      const stage1 = [...msg.stage1];
      const ix = stage1.findIndex((s) => s.model === model);
      if (ix === -1) return { error: "model not in stage1" as const };

      stage1[ix] = {
        model,
        response: res?.content ?? "(request failed)",
        failed: res == null,
        ...(res == null
          ? { error: "This model failed to respond. Please retry this model." }
          : {}),
        webSearchSkipped: res?.webSearchSkipped,
      };
      msg.stage1 = stage1;
      msg.stale = { stage2: true, stage3: true };
      msg.metadata = undefined;
      await saveConversation(conv);

      return {
        ok: true as const,
        stage1,
        stale: msg.stale,
        webSearchSkipped: res?.webSearchSkipped,
      };
    });

    if (result.error === "Conversation not found")
      return c.json({ detail: "Conversation not found" }, 404);
    if (result.error === "invalid msgIndex")
      return c.json({ detail: "invalid msgIndex" }, 400);
    if (result.error === "message is not assistant")
      return c.json({ detail: "message is not assistant" }, 400);
    if (result.error === "no preceding user message")
      return c.json({ detail: "no preceding user message" }, 400);
    if (result.error === "model not in stage1")
      return c.json({ detail: "model not in stage1" }, 400);

    logInfo("message.rerun_stage1_model.completed", {
      conversationId: id,
      msgIndex,
      model,
      webSearchSkipped: result.webSearchSkipped ?? false,
    });
    return c.json(result);
  },
);

app.post(
  "/api/conversations/:id/messages/:msgIndex/rerun-stage1",
  async (c) => {
    const id = c.req.param("id");
    const msgIndex = parseMsgIndex(c);
    if (msgIndex < 0) {
      logValidationFailure("message.rerun_stage1.invalid_body", "invalid msgIndex", {
        conversationId: id,
      });
      return c.json({ detail: "invalid msgIndex" }, 400);
    }
    const apiKey = extractApiKey(c);
    if (!apiKey) {
      logValidationFailure("message.rerun_stage1.missing_api_key", MISSING_API_KEY_DETAIL, {
        conversationId: id,
        msgIndex,
      });
      return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);
    }

    const body = (await c.req.json().catch(() => ({}))) as RerunBody;
    const councilModels = parseCouncilModels(body);
    if (councilModels.error) {
      logValidationFailure("message.rerun_stage1.invalid_body", councilModels.error, {
        conversationId: id,
        msgIndex,
      });
      return c.json({ detail: councilModels.error }, 400);
    }
    logInfo("message.rerun_stage1.received", {
      conversationId: id,
      msgIndex,
      councilModels: councilModels.models,
    });

    const result = await withConversationLock(id, async () => {
      const conv = await getConversation(id);
      if (!conv) return { error: "Conversation not found" as const };
      if (msgIndex >= conv.messages.length)
        return { error: "invalid msgIndex" as const };
      const msg = conv.messages[msgIndex];
      if (!isAssistantMessage(msg))
        return { error: "message is not assistant" as const };

      const userQuery = findPreviousUserQuery(conv.messages, msgIndex);
      if (!userQuery) return { error: "no preceding user message" as const };
      const history = messagesBeforeIndex(conv.messages, msgIndex - 1);
      const effectiveQuery = composeEffectiveUserQuery(userQuery, history);
      const rerunMode = parseWebSearchMode(
        body.use_web_search_mode,
        body.use_web_search,
      );
      const rerunPlan = await decideWebSearchPlan(
        userQuery,
        history,
        rerunMode,
        apiKey,
        c.req.raw.signal,
      );

      let webContext: string | undefined;
      if (
        rerunPlan.action === "reuse" &&
        rerunPlan.previousWebFetch &&
        !rerunPlan.previousWebFetch.webSearchSkipped &&
        hasVerifiedWebFetchSources(rerunPlan.previousWebFetch)
      ) {
        webContext = rerunPlan.previousWebFetch.content;
      } else if (
        rerunMode !== "off" &&
        msg.webFetch &&
        !msg.webFetch.webSearchSkipped &&
        hasVerifiedWebFetchSources(msg.webFetch)
      ) {
        webContext = msg.webFetch.content;
      }

      const stage1 = await stage1CollectResponses(
        effectiveQuery,
        webContext,
        msg.webFetch?.retrievedAt != null
          ? {
              isoUtc: msg.webFetch.retrievedAt,
              unixSeconds: msg.webFetch.retrievedAtUnixSeconds ?? 0,
            }
          : undefined,
        apiKey,
        c.req.raw.signal,
        councilModels.models ?? COUNCIL_MODELS,
      );
      if (successfulStage1Items(stage1).length === 0) {
        return { error: "all stage1 models failed" as const };
      }

      msg.stage1 = stage1;
      msg.stale = { stage2: true, stage3: true };
      msg.metadata = undefined;
      await saveConversation(conv);

      return { ok: true as const, stage1, stale: msg.stale };
    });

    if (result.error === "Conversation not found")
      return c.json({ detail: "Conversation not found" }, 404);
    if (result.error === "invalid msgIndex")
      return c.json({ detail: "invalid msgIndex" }, 400);
    if (result.error === "message is not assistant")
      return c.json({ detail: "message is not assistant" }, 400);
    if (result.error === "no preceding user message")
      return c.json({ detail: "no preceding user message" }, 400);
    if (result.error === "all stage1 models failed")
      return c.json({ detail: STAGE1_FAILURE_MESSAGE }, 502);

    logInfo("message.rerun_stage1.completed", {
      conversationId: id,
      msgIndex,
      stage1Count: result.stage1.length,
      stage1SuccessCount: successfulStage1Items(result.stage1).length,
    });
    return c.json(result);
  },
);

app.post("/api/conversations/:id/messages/:msgIndex/rerun-stage2", async (c) => {
  const id = c.req.param("id");
  const msgIndex = parseMsgIndex(c);
  if (msgIndex < 0) {
    logValidationFailure("message.rerun_stage2.invalid_body", "invalid msgIndex", {
      conversationId: id,
    });
    return c.json({ detail: "invalid msgIndex" }, 400);
  }
  const apiKey = extractApiKey(c);
  if (!apiKey) {
    logValidationFailure("message.rerun_stage2.missing_api_key", MISSING_API_KEY_DETAIL, {
      conversationId: id,
      msgIndex,
    });
    return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);
  }

  const body = (await c.req.json().catch(() => ({}))) as RerunBody;
  const councilModels = parseCouncilModels(body);
  if (councilModels.error) {
    logValidationFailure("message.rerun_stage2.invalid_body", councilModels.error, {
      conversationId: id,
      msgIndex,
    });
    return c.json({ detail: councilModels.error }, 400);
  }
  const judgeWeights = parseJudgeWeights(body);
  logInfo("message.rerun_stage2.received", {
    conversationId: id,
    msgIndex,
    councilModels: councilModels.models,
    hasJudgeWeights: Boolean(judgeWeights),
  });

  const result = await withConversationLock(id, async () => {
    const conv = await getConversation(id);
    if (!conv) return { error: "Conversation not found" as const };
    if (msgIndex >= conv.messages.length)
      return { error: "invalid msgIndex" as const };
    const msg = conv.messages[msgIndex];
    if (!isAssistantMessage(msg))
      return { error: "message is not assistant" as const };

    const userQuery = findPreviousUserQuery(conv.messages, msgIndex);
    if (!userQuery) return { error: "no preceding user message" as const };
    if (!msg.stage1.length) return { error: "empty stage1" as const };
    const history = messagesBeforeIndex(conv.messages, msgIndex - 1);
    const effectiveQuery = composeEffectiveUserQuery(userQuery, history);
    const rerunMode = parseWebSearchMode(
      body.use_web_search_mode,
      body.use_web_search,
    );

    const [stage2, labelToModel] = await stage2CollectRankings(
      effectiveQuery,
      msg.stage1,
      apiKey,
      undefined,
      councilModels.models ?? COUNCIL_MODELS,
    );
    const aggregate_rankings = calculateAggregateRankings(
      stage2,
      labelToModel,
      judgeWeights,
    );

    msg.stage2 = stage2;
    msg.stale = {
      stage2: false,
      stage3: true,
    };
    msg.metadata = {
      label_to_model: labelToModel,
      aggregate_rankings,
    };
    await saveConversation(conv);

    return {
      ok: true as const,
      stage2,
      metadata: { label_to_model: labelToModel, aggregate_rankings },
      stale: msg.stale,
    };
  });

  if (result.error === "Conversation not found")
    return c.json({ detail: "Conversation not found" }, 404);
  if (result.error === "invalid msgIndex")
    return c.json({ detail: "invalid msgIndex" }, 400);
  if (result.error === "message is not assistant")
    return c.json({ detail: "message is not assistant" }, 400);
  if (result.error === "no preceding user message")
    return c.json({ detail: "no preceding user message" }, 400);
  if (result.error === "empty stage1")
    return c.json({ detail: "empty stage1" }, 400);

  logInfo("message.rerun_stage2.completed", {
    conversationId: id,
    msgIndex,
    stage2Count: result.stage2.length,
    aggregateRankingCount: result.metadata.aggregate_rankings.length,
  });
  return c.json(result);
});

app.post("/api/conversations/:id/messages/:msgIndex/rerun-stage3", async (c) => {
  const id = c.req.param("id");
  const msgIndex = parseMsgIndex(c);
  if (msgIndex < 0) {
    logValidationFailure("message.rerun_stage3.invalid_body", "invalid msgIndex", {
      conversationId: id,
    });
    return c.json({ detail: "invalid msgIndex" }, 400);
  }
  const apiKey = extractApiKey(c);
  if (!apiKey) {
    logValidationFailure("message.rerun_stage3.missing_api_key", MISSING_API_KEY_DETAIL, {
      conversationId: id,
      msgIndex,
    });
    return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);
  }

  const body = (await c.req.json().catch(() => ({}))) as RerunBody;
  const councilModels = parseCouncilModels(body);
  if (councilModels.error) {
    logValidationFailure("message.rerun_stage3.invalid_body", councilModels.error, {
      conversationId: id,
      msgIndex,
    });
    return c.json({ detail: councilModels.error }, 400);
  }
  const judgeWeights = parseJudgeWeights(body);
  logInfo("message.rerun_stage3.received", {
    conversationId: id,
    msgIndex,
    chairmanModel: parseChairman(body),
    hasJudgeWeights: Boolean(judgeWeights),
  });

  const result = await withConversationLock(id, async () => {
    const conv = await getConversation(id);
    if (!conv) return { error: "Conversation not found" as const };
    if (msgIndex >= conv.messages.length)
      return { error: "invalid msgIndex" as const };
    const msg = conv.messages[msgIndex];
    if (!isAssistantMessage(msg))
      return { error: "message is not assistant" as const };

    const userQuery = findPreviousUserQuery(conv.messages, msgIndex);
    if (!userQuery) return { error: "no preceding user message" as const };
    const history = messagesBeforeIndex(conv.messages, msgIndex - 1);
    const effectiveQuery = composeEffectiveUserQuery(userQuery, history);
    const rerunMode = parseWebSearchMode(
      body.use_web_search_mode,
      body.use_web_search,
    );

    const labelToModel = labelToModelFromStage1(msg.stage1);
    const skipCtx = Boolean(body.skip_chairman_context_check);
    const gate = skipCtx
      ? ({ proceed: true as const })
      : gateChairmanStage3(
          effectiveQuery,
          msg.stage1,
          msg.stage2,
          parseChairman(body),
          judgeWeights,
          labelToModel,
          msg.webFetch?.sources,
        );

    if (!gate.proceed) {
      const candidates = [
        ...(councilModels.models ?? COUNCIL_MODELS),
        CHAIRMAN_MODEL,
        gate.analysis.chairman_model,
      ];
      const suggested = topChairmanModelsByContext(candidates, 5);
      return {
        blocked: true as const,
        chairman_context: gate.analysis,
        suggested_models: suggested,
      };
    }

    const stage3 = await stage3SynthesizeFinal(
      effectiveQuery,
      msg.stage1,
      msg.stage2,
      parseChairman(body),
      judgeWeights,
      labelToModel,
      apiKey,
      undefined,
      msg.webFetch?.sources,
    );

    msg.stage3 = stage3;
    msg.stale = {
      stage2: msg.stale?.stage2 ?? false,
      stage3: false,
    };
    await saveConversation(conv);

    return { ok: true as const, stage3, stale: msg.stale };
  });

  if (result.error === "Conversation not found")
    return c.json({ detail: "Conversation not found" }, 404);
  if (result.error === "invalid msgIndex")
    return c.json({ detail: "invalid msgIndex" }, 400);
  if (result.error === "message is not assistant")
    return c.json({ detail: "message is not assistant" }, 400);
  if (result.error === "no preceding user message")
    return c.json({ detail: "no preceding user message" }, 400);

  if ("blocked" in result && result.blocked) {
    logWarn("message.rerun_stage3.blocked", {
      conversationId: id,
      msgIndex,
      chairmanModel: result.chairman_context.chairman_model,
      estimatedInputTokens: result.chairman_context.estimated_input_tokens,
    });
    return c.json(
      {
        detail: "chairman_context_exceeded",
        chairman_context: result.chairman_context,
        suggested_models: result.suggested_models,
      },
      409,
    );
  }

  logInfo("message.rerun_stage3.completed", {
    conversationId: id,
    msgIndex,
    ...stage3Summary(result.stage3),
  });
  return c.json(result);
});

// ─── Stateless endpoints (no file storage) ───────────────────────────────────
// Used by the frontend in "localStorage mode", where the client manages
// conversation persistence. These endpoints accept full conversation history
// in the request body and return results without reading/writing any files.

type StatelessSendBody = {
  content?: string;
  messages?: unknown[];
  chairman_model?: string;
  followup_model?: string;
  final_model?: string;
  council_models?: string[];
  use_web_search?: boolean;
  use_web_search_mode?: "off" | "auto" | "on";
  continue_use_web_search?: boolean;
  filter_untrusted_sources?: boolean;
  web_fetch_model?: string;
  judge_weights?: Record<string, number>;
  weights?: Record<string, number>;
};

app.post("/api/message/stateless/stream", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as StatelessSendBody;
  const content = body.content?.trim();
  if (!content) {
    logValidationFailure("message.stateless_stream.invalid_body", "content required");
    return c.json({ detail: "content required" }, 400);
  }
  const councilModels = parseCouncilModels(body);
  if (councilModels.error) {
    logValidationFailure("message.stateless_stream.invalid_body", councilModels.error, {
      ...bodySummary(body),
    });
    return c.json({ detail: councilModels.error }, 400);
  }
  const apiKey = extractApiKey(c);
  if (!apiKey) {
    logValidationFailure("message.stateless_stream.missing_api_key", MISSING_API_KEY_DETAIL);
    return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);
  }

  const historyMessages = (body.messages ?? []) as import("./storage.js").Message[];
  const isFirstMessage = historyMessages.filter((m) => m.role === "user").length === 0;
  const isFollowup = historyMessages.some((m) => m.role === "assistant");
  const chairmanModel = parseChairman(body);
  const followupModel = parseFollowupModel(body);
  const webFetchModel = parseWebFetchModel(body);
  const judgeWeights = parseJudgeWeights(body);
  const webSearchMode = parseWebSearchMode(body.use_web_search_mode, body.use_web_search);
  const continueUseWebSearch = Boolean(body.continue_use_web_search);
  const filterUntrustedSources = Boolean(body.filter_untrusted_sources);
  const effectiveCouncilModels = councilModels.models ?? COUNCIL_MODELS;

  logInfo("message.stateless_stream.received", {
    ...bodySummary(body),
    historyCount: historyMessages.length,
    isFirstMessage,
    isFollowup,
    councilModelCount: effectiveCouncilModels.length,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (obj: unknown) => controller.enqueue(sseLine(obj));
      const requestSignal = c.req.raw.signal;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        controller.enqueue(ssePadding());
        controller.enqueue(sseComment("stream-open"));
        push({ type: "stream_open", data: { mode: "stateless" } });
        heartbeat = setInterval(() => {
          if (requestSignal.aborted) return;
          try {
            controller.enqueue(sseComment("keepalive"));
          } catch {
            /* stream closed */
          }
        }, SSE_HEARTBEAT_MS);
      } catch {
        /* stream closed before first flush */
      }
      const ensureNotAborted = () => {
        if (requestSignal.aborted) {
          const err = new Error("Aborted");
          err.name = "AbortError";
          throw err;
        }
      };

      try {
        ensureNotAborted();

        if (isFirstMessage) {
          void (async () => {
            try {
              const title = await generateConversationTitle(content, apiKey, requestSignal);
              ensureNotAborted();
              push({ type: "title_complete", data: { title } });
            } catch (err) {
              logWarn("message.stateless_stream.title_failed", {
                error: summarizeError(err),
              });
            }
          })();
        }

        const effectiveQuery = composeEffectiveUserQuery(content, historyMessages);
        let webFetchResult: Awaited<ReturnType<typeof stageWebFetch>> | undefined;
        let webContext: string | undefined;

        if (isFollowup) {
          if (continueUseWebSearch) {
            push({ type: "web_fetch_start", data: { model: webFetchModel?.trim() || WEB_FETCH_MODEL } });
            const scopePreview = await describeWebFetchScope(
              effectiveQuery,
              apiKey,
              requestSignal,
            );
            if (scopePreview) {
              push({ type: "web_fetch_scope", data: scopePreview });
            }
            webFetchResult = await stageWebFetch(
              effectiveQuery,
              webFetchModel,
              apiKey,
              requestSignal,
              {
                requestedMode: "on",
                action: "search",
                reason: "继续对话已开启联网搜索。",
              },
              filterUntrustedSources,
              scopePreview,
            );
            push({ type: "web_fetch_complete", data: webFetchResult });
            if (!webFetchResult.webSearchSkipped && hasVerifiedWebFetchSources(webFetchResult)) webContext = webFetchResult.content;
          }

          push({ type: "followup_start", data: { model: followupModel?.trim() || FOLLOWUP_MODEL } });
          const followupResult = await synthesizeFollowUpAnswerStream(
            content,
            historyMessages,
            followupModel,
            (delta) => push({ type: "followup_delta", data: { delta } }),
            apiKey,
            requestSignal,
            webContext,
          );
          push({ type: "followup_complete", data: followupResult });
          push({
            type: "complete",
            data: {
              responseMode: "followup",
              webFetch: webFetchResult,
              stage1: [],
              stage2: [],
              stage3: followupResult,
              metadata: { label_to_model: {}, aggregate_rankings: [] },
            },
          });
          return;
        }

        const webSearchPlan = await decideWebSearchPlan(
          content,
          historyMessages,
          webSearchMode,
          apiKey,
          requestSignal,
        );

        if (webSearchPlan.action === "reuse" && webSearchPlan.previousWebFetch) {
          webFetchResult = {
            ...webSearchPlan.previousWebFetch,
            webSearchMode,
            webSearchAction: "reuse",
            webSearchReason: webSearchPlan.reason,
            reusedFromPrevious: true,
          };
          push({ type: "web_fetch_complete", data: webFetchResult });
          if (!webFetchResult.webSearchSkipped && hasVerifiedWebFetchSources(webFetchResult)) webContext = webFetchResult.content;
        } else if (webSearchPlan.action === "search") {
          push({ type: "web_fetch_start", data: { model: webFetchModel?.trim() || WEB_FETCH_MODEL } });
          const scopePreview = await describeWebFetchScope(
            effectiveQuery,
            apiKey,
            requestSignal,
          );
          if (scopePreview) {
            push({ type: "web_fetch_scope", data: scopePreview });
          }
          webFetchResult = await stageWebFetch(
            effectiveQuery,
            webFetchModel,
            apiKey,
            requestSignal,
            webSearchPlan,
            filterUntrustedSources,
            scopePreview,
          );
          push({ type: "web_fetch_complete", data: webFetchResult });
          if (!webFetchResult.webSearchSkipped && hasVerifiedWebFetchSources(webFetchResult)) webContext = webFetchResult.content;
        }

        push({ type: "stage1_start" });
        const stage1Results = await stage1CollectResponses(
          effectiveQuery,
          webContext,
          webFetchResult?.retrievedAt != null && webContext
            ? { isoUtc: webFetchResult.retrievedAt, unixSeconds: webFetchResult.retrievedAtUnixSeconds ?? 0 }
            : undefined,
          apiKey,
          requestSignal,
          effectiveCouncilModels,
        );
        push({ type: "stage1_complete", data: stage1Results });

        if (successfulStage1Items(stage1Results).length === 0) {
          const stage3Result: Stage3Result = { model: "error", response: STAGE1_FAILURE_MESSAGE };
          push({ type: "stage3_complete", data: stage3Result });
          push({ type: "complete", data: { webFetch: webFetchResult, stage1: stage1Results, stage2: [], stage3: stage3Result, metadata: { label_to_model: {}, aggregate_rankings: [] } } });
          return;
        }

        push({ type: "stage2_start" });
        const [stage2Results, labelToModel] = await stage2CollectRankings(
          effectiveQuery,
          stage1Results,
          apiKey,
          requestSignal,
          effectiveCouncilModels,
        );
        const aggregateRankings = calculateAggregateRankings(stage2Results, labelToModel, judgeWeights);
        push({ type: "stage2_complete", data: stage2Results, metadata: { label_to_model: labelToModel, aggregate_rankings: aggregateRankings } });

        const chairModel = chairmanModel?.trim() || CHAIRMAN_MODEL;
        const gate = gateChairmanStage3(
          effectiveQuery, stage1Results, stage2Results, chairmanModel, judgeWeights, labelToModel, webFetchResult?.sources,
        );

        let stage3Result: Stage3Result;

        if (!gate.proceed) {
          stage3Result = gate.stage3;
          const candidates = [...effectiveCouncilModels, CHAIRMAN_MODEL, gate.analysis.chairman_model];
          const suggested = topChairmanModelsByContext(candidates, 5);
          ensureNotAborted();
          push({
            type: "chairman_context_prompt",
            data: {
              message_index: historyMessages.length + 1,
              chairman_model: gate.analysis.chairman_model,
              estimated_input_tokens: gate.analysis.estimated_input_tokens,
              context_limit: gate.analysis.context_limit,
              max_input_tokens: gate.analysis.max_input_tokens,
              suggested_models: suggested,
              stage3: stage3Result,
            },
          });
          push({ type: "complete", data: { webFetch: webFetchResult, stage1: stage1Results, stage2: stage2Results, stage3: stage3Result, metadata: { label_to_model: labelToModel, aggregate_rankings: aggregateRankings } } });
        } else {
          push({ type: "stage3_start", data: { model: chairModel } });
          stage3Result = await stage3SynthesizeFinalStream(
            effectiveQuery, stage1Results, stage2Results, chairmanModel,
            judgeWeights, labelToModel,
            (delta) => push({ type: "stage3_delta", data: { delta } }),
            apiKey, requestSignal, webFetchResult?.sources,
          );
          push({ type: "stage3_complete", data: stage3Result });
          ensureNotAborted();
          push({ type: "complete", data: { webFetch: webFetchResult, stage1: stage1Results, stage2: stage2Results, stage3: stage3Result, metadata: { label_to_model: labelToModel, aggregate_rankings: aggregateRankings } } });
        }
      } catch (e) {
        if (isAbortError(e)) return;
        push({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

type StatelessRerunStage1Body = {
  user_query?: string;
  history_messages?: unknown[];
  web_fetch?: import("./storage.js").WebFetchResult;
  council_models?: string[];
  use_web_search?: boolean;
  use_web_search_mode?: "off" | "auto" | "on";
};

app.post("/api/message/stateless/rerun-stage1", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as StatelessRerunStage1Body;
  const userQuery = body.user_query?.trim();
  if (!userQuery) return c.json({ detail: "user_query required" }, 400);
  const councilModels = parseCouncilModels(body);
  if (councilModels.error) return c.json({ detail: councilModels.error }, 400);
  const apiKey = extractApiKey(c);
  if (!apiKey) return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);

  const historyMessages = (body.history_messages ?? []) as import("./storage.js").Message[];
  const effectiveQuery = composeEffectiveUserQuery(userQuery, historyMessages);
  const rerunMode = parseWebSearchMode(body.use_web_search_mode, body.use_web_search);
  const rerunPlan = await decideWebSearchPlan(userQuery, historyMessages, rerunMode, apiKey, c.req.raw.signal);

  let webContext: string | undefined;
  if (rerunPlan.action === "reuse" && rerunPlan.previousWebFetch && !rerunPlan.previousWebFetch.webSearchSkipped && hasVerifiedWebFetchSources(rerunPlan.previousWebFetch)) {
    webContext = rerunPlan.previousWebFetch.content;
  } else if (rerunMode !== "off" && body.web_fetch && !body.web_fetch.webSearchSkipped && hasVerifiedWebFetchSources(body.web_fetch)) {
    webContext = body.web_fetch.content;
  }

  const stage1 = await stage1CollectResponses(
    effectiveQuery, webContext,
    body.web_fetch?.retrievedAt != null
      ? { isoUtc: body.web_fetch.retrievedAt, unixSeconds: body.web_fetch.retrievedAtUnixSeconds ?? 0 }
      : undefined,
    apiKey, c.req.raw.signal, councilModels.models ?? COUNCIL_MODELS,
  );

  return c.json({ stage1, stale: { stage2: true, stage3: true } });
});

type StatelessRerunStage1ModelBody = StatelessRerunStage1Body & {
  model?: string;
  stage1?: import("./storage.js").Stage1Item[];
};

app.post("/api/message/stateless/rerun-stage1-model", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as StatelessRerunStage1ModelBody;
  const userQuery = body.user_query?.trim();
  const model = body.model?.trim();
  if (!userQuery) return c.json({ detail: "user_query required" }, 400);
  if (!model) return c.json({ detail: "model required" }, 400);
  const apiKey = extractApiKey(c);
  if (!apiKey) return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);

  const historyMessages = (body.history_messages ?? []) as import("./storage.js").Message[];
  const effectiveQuery = composeEffectiveUserQuery(userQuery, historyMessages);
  const rerunMode = parseWebSearchMode(body.use_web_search_mode, body.use_web_search);
  const rerunPlan = await decideWebSearchPlan(userQuery, historyMessages, rerunMode, apiKey, c.req.raw.signal);

  let webContext: string | undefined;
  let webRetrievalMeta:
    | {
        isoUtc: string;
        unixSeconds: number;
      }
    | undefined;
  if (
    rerunPlan.action === "reuse" &&
    rerunPlan.previousWebFetch &&
    !rerunPlan.previousWebFetch.webSearchSkipped &&
    hasVerifiedWebFetchSources(rerunPlan.previousWebFetch)
  ) {
    webContext = rerunPlan.previousWebFetch.content;
    if (rerunPlan.previousWebFetch.retrievedAt) {
      webRetrievalMeta = {
        isoUtc: rerunPlan.previousWebFetch.retrievedAt,
        unixSeconds: rerunPlan.previousWebFetch.retrievedAtUnixSeconds ?? 0,
      };
    }
  } else if (
    rerunMode !== "off" &&
    body.web_fetch &&
    !body.web_fetch.webSearchSkipped &&
    hasVerifiedWebFetchSources(body.web_fetch)
  ) {
    webContext = body.web_fetch.content;
    if (body.web_fetch.retrievedAt) {
      webRetrievalMeta = {
        isoUtc: body.web_fetch.retrievedAt,
        unixSeconds: body.web_fetch.retrievedAtUnixSeconds ?? 0,
      };
    }
  }

  const res = await queryModel(
    model,
    [{
      role: "user",
      content: buildStage1UserPrompt(effectiveQuery, webContext, webRetrievalMeta),
    }],
    { apiKey },
  );

  const currentStage1 = body.stage1 ?? [];
  const ix = currentStage1.findIndex((s) => s.model === model);
  if (ix === -1) return c.json({ detail: "model not in stage1" }, 400);

  const stage1 = [...currentStage1];
  stage1[ix] = {
    model,
    response: res?.content ?? "(request failed)",
    failed: res == null,
    ...(res == null
      ? { error: "This model failed to respond. Please retry this model." }
      : {}),
    webSearchSkipped: res?.webSearchSkipped,
  };

  return c.json({ stage1, stale: { stage2: true, stage3: true }, webSearchSkipped: res?.webSearchSkipped });
});

type StatelessRerunStage2Body = {
  user_query?: string;
  history_messages?: unknown[];
  stage1?: import("./storage.js").Stage1Item[];
  council_models?: string[];
  use_web_search?: boolean;
  use_web_search_mode?: "off" | "auto" | "on";
  judge_weights?: Record<string, number>;
  weights?: Record<string, number>;
};

app.post("/api/message/stateless/rerun-stage2", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as StatelessRerunStage2Body;
  const userQuery = body.user_query?.trim();
  if (!userQuery) return c.json({ detail: "user_query required" }, 400);
  const stage1 = body.stage1;
  if (!stage1?.length) return c.json({ detail: "stage1 required" }, 400);
  const councilModels = parseCouncilModels(body);
  if (councilModels.error) return c.json({ detail: councilModels.error }, 400);
  const apiKey = extractApiKey(c);
  if (!apiKey) return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);

  const historyMessages = (body.history_messages ?? []) as import("./storage.js").Message[];
  const effectiveQuery = composeEffectiveUserQuery(userQuery, historyMessages);
  const judgeWeights = parseJudgeWeights(body);

  const [stage2, labelToModel] = await stage2CollectRankings(
    effectiveQuery,
    stage1,
    apiKey,
    undefined,
    councilModels.models ?? COUNCIL_MODELS,
  );
  const aggregate_rankings = calculateAggregateRankings(stage2, labelToModel, judgeWeights);

  return c.json({
    stage2,
    metadata: { label_to_model: labelToModel, aggregate_rankings },
    stale: { stage2: false, stage3: true },
  });
});

type StatelessRerunStage3Body = {
  user_query?: string;
  history_messages?: unknown[];
  stage1?: import("./storage.js").Stage1Item[];
  stage2?: import("./storage.js").Stage2Item[];
  web_fetch?: import("./storage.js").WebFetchResult;
  chairman_model?: string;
  final_model?: string;
  council_models?: string[];
  judge_weights?: Record<string, number>;
  weights?: Record<string, number>;
  use_web_search?: boolean;
  use_web_search_mode?: "off" | "auto" | "on";
  skip_chairman_context_check?: boolean;
};

app.post("/api/message/stateless/rerun-stage3", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as StatelessRerunStage3Body;
  const userQuery = body.user_query?.trim();
  if (!userQuery) return c.json({ detail: "user_query required" }, 400);
  const stage1 = body.stage1;
  const stage2 = body.stage2;
  if (!stage1?.length) return c.json({ detail: "stage1 required" }, 400);
  if (!stage2?.length) return c.json({ detail: "stage2 required" }, 400);
  const councilModels = parseCouncilModels(body);
  if (councilModels.error) return c.json({ detail: councilModels.error }, 400);
  const apiKey = extractApiKey(c);
  if (!apiKey) return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);

  const historyMessages = (body.history_messages ?? []) as import("./storage.js").Message[];
  const effectiveQuery = composeEffectiveUserQuery(userQuery, historyMessages);
  const chairmanModel = parseChairman(body);
  const judgeWeights = parseJudgeWeights(body);
  const labelToModel = labelToModelFromStage1(stage1);
  const skipCtx = Boolean(body.skip_chairman_context_check);

  const gate = skipCtx
    ? ({ proceed: true as const })
    : gateChairmanStage3(effectiveQuery, stage1, stage2, chairmanModel, judgeWeights, labelToModel, body.web_fetch?.sources);

  if (!gate.proceed) {
    const candidates = [...(councilModels.models ?? COUNCIL_MODELS), CHAIRMAN_MODEL, gate.analysis.chairman_model];
    const suggested = topChairmanModelsByContext(candidates, 5);
    return c.json(
      { detail: "chairman_context_exceeded", chairman_context: gate.analysis, suggested_models: suggested },
      409,
    );
  }

  const stage3 = await stage3SynthesizeFinal(
    effectiveQuery, stage1, stage2, chairmanModel, judgeWeights, labelToModel,
    apiKey, undefined, body.web_fetch?.sources,
  );

  return c.json({ stage3, stale: { stage2: false, stage3: false } });
});

logInfo("server.listen", {
  host: "0.0.0.0",
  port: API_PORT,
});
serve({ fetch: app.fetch, port: API_PORT });
