import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import {
  ALLOWED_ORIGINS,
  API_PORT,
  CHAIRMAN_MODEL,
  CHAIRMAN_OUTPUT_RESERVE_TOKENS,
  COUNCIL_MODELS,
  FOLLOWUP_MODEL,
  TITLE_MODEL,
  chairmanContextLimitsForApi,
  resolveChairmanContextLimit,
} from "./config.js";
import {
  calculateAggregateRankings,
  composeEffectiveUserQuery,
  decideWebSearchPlan,
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
  type StreamProgress,
  successfulStage1Items,
  synthesizeFollowUpAnswer,
  synthesizeFollowUpAnswerStream,
} from "./council.js";
import { withConversationLock } from "./lock.js";
import { queryModel } from "./ofox.js";
import { getFeaturedModelGroups } from "./ofox-models.js";
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

const app = new Hono();
const allowedOrigins = new Set(ALLOWED_ORIGINS);

app.use("*", logger());

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

app.get("/", (c) =>
  c.json({ status: "ok", service: "Vela 助手 API (Hono)" }),
);

app.get("/api/config", async (c) => {
  let featured_model_groups: Awaited<ReturnType<typeof getFeaturedModelGroups>> = [];
  try {
    featured_model_groups = await getFeaturedModelGroups();
  } catch (err) {
    console.error("[config] failed to load Ofox model catalog:", err);
  }

  return c.json({
    council_models: COUNCIL_MODELS,
    web_search_provider: "tavily",
    chairman_model: CHAIRMAN_MODEL,
    followup_model: FOLLOWUP_MODEL,
    title_model: TITLE_MODEL,
    chairman_context_limits: chairmanContextLimitsForApi(),
    chairman_output_reserve_tokens: CHAIRMAN_OUTPUT_RESERVE_TOKENS,
    featured_model_groups,
  });
});

app.get("/api/conversations", async (c) => {
  const list = await listConversations();
  return c.json(list);
});

app.post("/api/conversations", async (c) => {
  const id = crypto.randomUUID();
  const conv = await createConversation(id);
  return c.json(conv);
});

app.get("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const conv = await getConversation(id);
  if (!conv) return c.json({ detail: "Conversation not found" }, 404);
  return c.json(conv);
});

app.delete("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const ok = await deleteConversation(id);
  if (!ok) return c.json({ detail: "Conversation not found" }, 404);
  return c.body(null, 204);
});

function extractApiKey(c: { req: { header: (k: string) => string | undefined } }): string | undefined {
  return c.req.header("x-ofox-key")?.trim() || undefined;
}

function extractTavilyKey(c: { req: { header: (k: string) => string | undefined } }): string | undefined {
  return c.req.header("x-tavily-key")?.trim() || undefined;
}

const MISSING_API_KEY_DETAIL =
  "Ofox API key required via X-Ofox-Key header";
const MISSING_TAVILY_KEY_DETAIL =
  "Tavily API key required via X-Tavily-Key header when web search is enabled";

const STAGE1_FAILURE_MESSAGE =
  "All Stage 1 model requests failed. Check your Ofox API key, account credits, model availability, or server logs for the upstream error.";

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

/** Node.js fetch 网络失败时 e.message 只是 "fetch failed"，真正原因在 e.cause。 */
function formatStreamError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  if (cause instanceof Error && e.message === "fetch failed") {
    return `fetch failed: ${cause.message}`;
  }
  return e.message;
}

app.post("/api/conversations/:id/message", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as SendBody;
  const content = body.content?.trim();
  if (!content) return c.json({ detail: "content required" }, 400);
  const councilModels = parseCouncilModels(body);
  if (councilModels.error) return c.json({ detail: councilModels.error }, 400);
  const apiKey = extractApiKey(c);
  if (!apiKey) return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);
  const tavilyKey = extractTavilyKey(c);

  const conv = await getConversation(id);
  if (!conv) return c.json({ detail: "Conversation not found" }, 404);

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
  if (webSearchMode !== "off" && !tavilyKey) {
    return c.json({ detail: MISSING_TAVILY_KEY_DETAIL }, 400);
  }
  const filterUntrustedSources = Boolean(body.filter_untrusted_sources);

  await withConversationLock(id, async () => {
    await addUserMessage(id, content);
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
  }

  if (isFollowup) {
    const continueUseWebSearch = Boolean(body.continue_use_web_search);
    const effectiveQuery = composeEffectiveUserQuery(content, conv.messages);
    const webFetch = continueUseWebSearch
      ? await stageWebFetch(
          effectiveQuery,
          parseChairman(body),
          apiKey,
          tavilyKey,
          c.req.raw.signal,
          {
            requestedMode: "on",
            action: "search",
            reason: "继续对话已开启联网搜索。",
          },
          filterUntrustedSources,
        )
      : undefined;
    const stage3 = await synthesizeFollowUpAnswer(
      content,
      conv.messages,
      parseFollowupModel(body),
      apiKey,
      c.req.raw.signal,
      webFetch?.content,
    );

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
  const [s1, s2, s3, meta, webFetch] = await runFullCouncil(content, {
    chairmanModel: parseChairman(body),
    useWebSearch: webSearchPlan.action === "search",
    webSearchMode,
    councilModels: councilModels.models,
    judgeWeights,
    apiKey,
    tavilyApiKey: tavilyKey,
    signal: c.req.raw.signal,
    historyMessages: conv.messages,
    webSearchPlan,
    filterUntrustedSources,
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

app.post("/api/conversations/:id/message/stream", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as SendBody;
  const content = body.content?.trim();
  if (!content) return c.json({ detail: "content required" }, 400);
  const councilModels = parseCouncilModels(body);
  if (councilModels.error) return c.json({ detail: councilModels.error }, 400);
  const apiKey = extractApiKey(c);
  if (!apiKey) return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);
  const tavilyKey = extractTavilyKey(c);

  const conv = await getConversation(id);
  if (!conv) return c.json({ detail: "Conversation not found" }, 404);

  const shouldGenerateTitle =
    conv.messages.length === 0 ||
    !conv.title?.trim() ||
    conv.title.trim() === "New Conversation";
  const isFollowup = conv.messages.some((message) => message.role === "assistant");
  const chairmanModel = parseChairman(body);
  const followupModel = parseFollowupModel(body);
  const judgeWeights = parseJudgeWeights(body);
  const webSearchMode = parseWebSearchMode(
    body.use_web_search_mode,
    body.use_web_search,
  );
  const continueUseWebSearch = Boolean(body.continue_use_web_search);
  if ((webSearchMode !== "off" || continueUseWebSearch) && !tavilyKey) {
    return c.json({ detail: MISSING_TAVILY_KEY_DETAIL }, 400);
  }
  const filterUntrustedSources = Boolean(body.filter_untrusted_sources);
  const effectiveCouncilModels = councilModels.models ?? COUNCIL_MODELS;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (obj: unknown) => controller.enqueue(sseLine(obj));
      const pushProgress = (data: StreamProgress) => push({ type: "progress", data });
      const requestSignal = c.req.raw.signal;
      const ensureNotAborted = () => {
        if (requestSignal.aborted) {
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

        const titlePromise = shouldGenerateTitle
          ? generateConversationTitle(content, apiKey, requestSignal)
          : null;

        void (async () => {
          if (!titlePromise) return;
          try {
            const title = await titlePromise;
            ensureNotAborted();
            await withConversationLock(id, async () => {
              await updateConversationTitle(id, title);
            });
            try {
              push({ type: "title_complete", data: { title } });
            } catch {
              /* 流可能已因错误提前关闭 */
            }
          } catch (err) {
            console.error("generateConversationTitle:", err);
          }
        })();

        const effectiveQuery = composeEffectiveUserQuery(content, conv.messages);
        let webFetchResult: Awaited<ReturnType<typeof stageWebFetch>> | undefined;
        let webContext: string | undefined;

        if (isFollowup) {
          if (continueUseWebSearch) {
            push({ type: "web_fetch_start" });
            pushProgress({
              phase: "web_fetch",
              message: "继续对话已开启联网检索，准备抓取公开网页。",
            });
            webFetchResult = await stageWebFetch(
              effectiveQuery,
              chairmanModel,
              apiKey,
              tavilyKey,
              requestSignal,
              {
                requestedMode: "on",
                action: "search",
                reason: "继续对话已开启联网搜索。",
              },
              filterUntrustedSources,
              pushProgress,
            );
            push({ type: "web_fetch_complete", data: webFetchResult });
            if (!webFetchResult.webSearchSkipped && hasVerifiedWebFetchSources(webFetchResult)) {
              webContext = webFetchResult.content;
            }
          }

          push({ type: "followup_start", data: { model: followupModel?.trim() || FOLLOWUP_MODEL } });
          pushProgress({
            phase: "followup",
            message: `正在用 ${followupModel?.trim() || FOLLOWUP_MODEL} 生成继续对话回答。`,
            model: followupModel?.trim() || FOLLOWUP_MODEL,
          });
          const followupResult = await synthesizeFollowUpAnswerStream(
            content,
            conv.messages,
            followupModel,
            (delta) => push({ type: "followup_delta", data: { delta } }),
            apiKey,
            requestSignal,
            webContext,
          );
          push({ type: "followup_complete", data: followupResult });

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
          requestSignal,
          pushProgress,
        );

        if (webSearchPlan.action === "reuse" && webSearchPlan.previousWebFetch) {
          pushProgress({
            phase: "web_fetch",
            message: "正在复用上一轮联网检索结果。",
          });
          webFetchResult = {
            ...webSearchPlan.previousWebFetch,
            webSearchMode,
            webSearchAction: "reuse",
            webSearchReason: webSearchPlan.reason,
            reusedFromPrevious: true,
          };
          push({ type: "web_fetch_complete", data: webFetchResult });
          if (!webFetchResult.webSearchSkipped && hasVerifiedWebFetchSources(webFetchResult)) {
            webContext = webFetchResult.content;
          }
        } else if (webSearchPlan.action === "search") {
          push({ type: "web_fetch_start" });
          webFetchResult = await stageWebFetch(
            effectiveQuery,
            chairmanModel,
            apiKey,
            tavilyKey,
            requestSignal,
            webSearchPlan,
            filterUntrustedSources,
            pushProgress,
          );
          push({ type: "web_fetch_complete", data: webFetchResult });
          if (!webFetchResult.webSearchSkipped && hasVerifiedWebFetchSources(webFetchResult)) {
            webContext = webFetchResult.content;
          }
        }

        push({ type: "stage1_start" });
        pushProgress({
          phase: "stage1",
          message: `Stage 1 已启动，准备并行请求 ${effectiveCouncilModels.length} 个模型。`,
          current: 0,
          total: effectiveCouncilModels.length,
        });
        const stage1Results = await stage1CollectResponses(
          effectiveQuery,
          webSearchPlan.action === "search",
          webContext,
          webFetchResult?.retrievedAt != null && webContext
            ? {
                isoUtc: webFetchResult.retrievedAt,
                unixSeconds: webFetchResult.retrievedAtUnixSeconds ?? 0,
              }
            : undefined,
          apiKey,
          requestSignal,
          effectiveCouncilModels,
          pushProgress,
        );
        push({ type: "stage1_complete", data: stage1Results });

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

          push({ type: "stage3_complete", data: stage3Result });
          push({ type: "complete" });
          return;
        }

        push({ type: "stage2_start" });
        pushProgress({
          phase: "stage2",
          message: `Stage 2 已启动，准备并行请求 ${effectiveCouncilModels.length} 个模型评审排序。`,
          current: 0,
          total: effectiveCouncilModels.length,
        });
        const [stage2Results, labelToModel] = await stage2CollectRankings(
          effectiveQuery,
          stage1Results,
          webSearchPlan.action === "search",
          apiKey,
          requestSignal,
          effectiveCouncilModels,
          pushProgress,
        );
        const aggregateRankings = calculateAggregateRankings(
          stage2Results,
          labelToModel,
          judgeWeights,
        );
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
          pushProgress({
            phase: "stage3",
            message: "Stage 3 因主席模型上下文不足而暂缓执行，等待手动重试。",
            model: gate.analysis.chairman_model,
          });
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
          pushProgress({
            phase: "stage3",
            message: `Stage 3 已启动，正在用 ${chairModel} 综合前两阶段结果。`,
            model: chairModel,
          });
          stage3Result = await stage3SynthesizeFinalStream(
            effectiveQuery,
            stage1Results,
            stage2Results,
            chairmanModel,
            webSearchPlan.action === "search",
            judgeWeights,
            labelToModel,
            (delta) => push({ type: "stage3_delta", data: { delta } }),
            apiKey,
            requestSignal,
            webFetchResult?.sources,
          );
          push({ type: "stage3_complete", data: stage3Result });

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
        }
        push({ type: "complete" });
      } catch (e) {
        if (isAbortError(e) && requestSignal.aborted) return;
        push({
          type: "error",
          message: isAbortError(e) ? "上游请求超时或被中止。" : formatStreamError(e),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
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
    if (msgIndex < 0) return c.json({ detail: "invalid msgIndex" }, 400);
    const apiKey = extractApiKey(c);
    if (!apiKey) return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);

    const body = (await c.req.json().catch(() => ({}))) as RerunBody;
    const councilModels = parseCouncilModels(body);
    if (councilModels.error) return c.json({ detail: councilModels.error }, 400);
    const model = body.model?.trim();
    if (!model) return c.json({ detail: "model required" }, 400);

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

      const res = await queryModel(
        model,
        [{ role: "user", content: effectiveQuery }],
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

    return c.json(result);
  },
);

app.post(
  "/api/conversations/:id/messages/:msgIndex/rerun-stage1",
  async (c) => {
    const id = c.req.param("id");
    const msgIndex = parseMsgIndex(c);
    if (msgIndex < 0) return c.json({ detail: "invalid msgIndex" }, 400);
    const apiKey = extractApiKey(c);
    if (!apiKey) return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);

    const body = (await c.req.json().catch(() => ({}))) as RerunBody;
    const councilModels = parseCouncilModels(body);
    if (councilModels.error) return c.json({ detail: councilModels.error }, 400);

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
        rerunPlan.action === "search",
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

    return c.json(result);
  },
);

app.post("/api/conversations/:id/messages/:msgIndex/rerun-stage2", async (c) => {
  const id = c.req.param("id");
  const msgIndex = parseMsgIndex(c);
  if (msgIndex < 0) return c.json({ detail: "invalid msgIndex" }, 400);
  const apiKey = extractApiKey(c);
  if (!apiKey) return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);

  const body = (await c.req.json().catch(() => ({}))) as RerunBody;
  const councilModels = parseCouncilModels(body);
  if (councilModels.error) return c.json({ detail: councilModels.error }, 400);
  const judgeWeights = parseJudgeWeights(body);

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
      rerunMode === "on",
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

  return c.json(result);
});

app.post("/api/conversations/:id/messages/:msgIndex/rerun-stage3", async (c) => {
  const id = c.req.param("id");
  const msgIndex = parseMsgIndex(c);
  if (msgIndex < 0) return c.json({ detail: "invalid msgIndex" }, 400);
  const apiKey = extractApiKey(c);
  if (!apiKey) return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);

  const body = (await c.req.json().catch(() => ({}))) as RerunBody;
  const councilModels = parseCouncilModels(body);
  if (councilModels.error) return c.json({ detail: councilModels.error }, 400);
  const judgeWeights = parseJudgeWeights(body);

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
      rerunMode === "on",
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
    return c.json(
      {
        detail: "chairman_context_exceeded",
        chairman_context: result.chairman_context,
        suggested_models: result.suggested_models,
      },
      409,
    );
  }

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
  judge_weights?: Record<string, number>;
  weights?: Record<string, number>;
};

app.post("/api/message/stateless/stream", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as StatelessSendBody;
  const content = body.content?.trim();
  if (!content) return c.json({ detail: "content required" }, 400);
  const councilModels = parseCouncilModels(body);
  if (councilModels.error) return c.json({ detail: councilModels.error }, 400);
  const apiKey = extractApiKey(c);
  if (!apiKey) return c.json({ detail: MISSING_API_KEY_DETAIL }, 400);
  const tavilyKey = extractTavilyKey(c);

  const historyMessages = (body.messages ?? []) as import("./storage.js").Message[];
  const isFirstMessage = historyMessages.filter((m) => m.role === "user").length === 0;
  const isFollowup = historyMessages.some((m) => m.role === "assistant");
  const chairmanModel = parseChairman(body);
  const followupModel = parseFollowupModel(body);
  const judgeWeights = parseJudgeWeights(body);
  const webSearchMode = parseWebSearchMode(body.use_web_search_mode, body.use_web_search);
  const continueUseWebSearch = Boolean(body.continue_use_web_search);
  if ((webSearchMode !== "off" || continueUseWebSearch) && !tavilyKey) {
    return c.json({ detail: MISSING_TAVILY_KEY_DETAIL }, 400);
  }
  const filterUntrustedSources = Boolean(body.filter_untrusted_sources);
  const effectiveCouncilModels = councilModels.models ?? COUNCIL_MODELS;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (obj: unknown) => controller.enqueue(sseLine(obj));
      const pushProgress = (data: StreamProgress) => push({ type: "progress", data });
      const requestSignal = c.req.raw.signal;
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
              console.error("generateConversationTitle (stateless):", err);
            }
          })();
        }

        const effectiveQuery = composeEffectiveUserQuery(content, historyMessages);
        let webFetchResult: Awaited<ReturnType<typeof stageWebFetch>> | undefined;
        let webContext: string | undefined;

        if (isFollowup) {
          if (continueUseWebSearch) {
            push({ type: "web_fetch_start" });
            pushProgress({
              phase: "web_fetch",
              message: "继续对话已开启联网检索，准备抓取公开网页。",
            });
            webFetchResult = await stageWebFetch(
              effectiveQuery,
              chairmanModel,
              apiKey,
              tavilyKey,
              requestSignal,
              {
                requestedMode: "on",
                action: "search",
                reason: "继续对话已开启联网搜索。",
              },
              filterUntrustedSources,
              pushProgress,
            );
            push({ type: "web_fetch_complete", data: webFetchResult });
            if (!webFetchResult.webSearchSkipped && hasVerifiedWebFetchSources(webFetchResult)) webContext = webFetchResult.content;
          }

          push({ type: "followup_start", data: { model: followupModel?.trim() || FOLLOWUP_MODEL } });
          pushProgress({
            phase: "followup",
            message: `正在用 ${followupModel?.trim() || FOLLOWUP_MODEL} 生成继续对话回答。`,
            model: followupModel?.trim() || FOLLOWUP_MODEL,
          });
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
          pushProgress,
        );

        if (webSearchPlan.action === "reuse" && webSearchPlan.previousWebFetch) {
          pushProgress({
            phase: "web_fetch",
            message: "正在复用上一轮联网检索结果。",
          });
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
          push({ type: "web_fetch_start" });
          webFetchResult = await stageWebFetch(effectiveQuery, chairmanModel, apiKey, tavilyKey, requestSignal, webSearchPlan, filterUntrustedSources, pushProgress);
          push({ type: "web_fetch_complete", data: webFetchResult });
          if (!webFetchResult.webSearchSkipped && hasVerifiedWebFetchSources(webFetchResult)) webContext = webFetchResult.content;
        }

        push({ type: "stage1_start" });
        pushProgress({
          phase: "stage1",
          message: `Stage 1 已启动，准备并行请求 ${effectiveCouncilModels.length} 个模型。`,
          current: 0,
          total: effectiveCouncilModels.length,
        });
        const stage1Results = await stage1CollectResponses(
          effectiveQuery,
          webSearchPlan.action === "search",
          webContext,
          webFetchResult?.retrievedAt != null && webContext
            ? { isoUtc: webFetchResult.retrievedAt, unixSeconds: webFetchResult.retrievedAtUnixSeconds ?? 0 }
            : undefined,
          apiKey,
          requestSignal,
          effectiveCouncilModels,
          pushProgress,
        );
        push({ type: "stage1_complete", data: stage1Results });

        if (successfulStage1Items(stage1Results).length === 0) {
          const stage3Result: Stage3Result = { model: "error", response: STAGE1_FAILURE_MESSAGE };
          push({ type: "stage3_complete", data: stage3Result });
          push({ type: "complete", data: { webFetch: webFetchResult, stage1: stage1Results, stage2: [], stage3: stage3Result, metadata: { label_to_model: {}, aggregate_rankings: [] } } });
          return;
        }

        push({ type: "stage2_start" });
        pushProgress({
          phase: "stage2",
          message: `Stage 2 已启动，准备并行请求 ${effectiveCouncilModels.length} 个模型评审排序。`,
          current: 0,
          total: effectiveCouncilModels.length,
        });
        const [stage2Results, labelToModel] = await stage2CollectRankings(
          effectiveQuery,
          stage1Results,
          webSearchPlan.action === "search",
          apiKey,
          requestSignal,
          effectiveCouncilModels,
          pushProgress,
        );
        const aggregateRankings = calculateAggregateRankings(stage2Results, labelToModel, judgeWeights);
        push({ type: "stage2_complete", data: stage2Results, metadata: { label_to_model: labelToModel, aggregate_rankings: aggregateRankings } });

        const chairModel = chairmanModel?.trim() || CHAIRMAN_MODEL;
        const gate = gateChairmanStage3(
          effectiveQuery, stage1Results, stage2Results, chairmanModel, judgeWeights, labelToModel, webFetchResult?.sources,
        );

        let stage3Result: Stage3Result;

        if (!gate.proceed) {
          pushProgress({
            phase: "stage3",
            message: "Stage 3 因主席模型上下文不足而暂缓执行，等待手动重试。",
            model: gate.analysis.chairman_model,
          });
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
          pushProgress({
            phase: "stage3",
            message: `Stage 3 已启动，正在用 ${chairModel} 综合前两阶段结果。`,
            model: chairModel,
          });
          stage3Result = await stage3SynthesizeFinalStream(
            effectiveQuery, stage1Results, stage2Results, chairmanModel,
            webSearchPlan.action === "search", judgeWeights, labelToModel,
            (delta) => push({ type: "stage3_delta", data: { delta } }),
            apiKey, requestSignal, webFetchResult?.sources,
          );
          push({ type: "stage3_complete", data: stage3Result });
          ensureNotAborted();
          push({ type: "complete", data: { webFetch: webFetchResult, stage1: stage1Results, stage2: stage2Results, stage3: stage3Result, metadata: { label_to_model: labelToModel, aggregate_rankings: aggregateRankings } } });
        }
      } catch (e) {
        if (isAbortError(e) && requestSignal.aborted) return;
        push({
          type: "error",
          message: isAbortError(e) ? "上游请求超时或被中止。" : formatStreamError(e),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
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
    effectiveQuery, rerunPlan.action === "search", webContext,
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

  const res = await queryModel(model, [{ role: "user", content: effectiveQuery }], { apiKey });

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
  const rerunMode = parseWebSearchMode(body.use_web_search_mode, body.use_web_search);
  const judgeWeights = parseJudgeWeights(body);

  const [stage2, labelToModel] = await stage2CollectRankings(
    effectiveQuery,
    stage1,
    rerunMode === "on",
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
  const rerunMode = parseWebSearchMode(body.use_web_search_mode, body.use_web_search);
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
    effectiveQuery, stage1, stage2, chairmanModel, rerunMode === "on", judgeWeights, labelToModel,
    apiKey, undefined, body.web_fetch?.sources,
  );

  return c.json({ stage3, stale: { stage2: false, stage3: false } });
});

console.log(`Vela 助手 API listening on http://0.0.0.0:${API_PORT}`);
serve({ fetch: app.fetch, port: API_PORT });
