import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  ALLOWED_ORIGINS,
  API_PORT,
  CHAIRMAN_MODEL,
  CHAIRMAN_OUTPUT_RESERVE_TOKENS,
  COUNCIL_MODELS,
  TITLE_MODEL,
  WEB_FETCH_MODEL,
  WEB_SEARCH_MODELS,
  chairmanContextLimitsForApi,
  resolveChairmanContextLimit,
} from "./config.js";
import {
  calculateAggregateRankings,
  composeEffectiveUserQuery,
  decideWebSearchPlan,
  gateChairmanStage3,
  generateConversationTitle,
  labelToModelFromStage1,
  parseWebSearchMode,
  runFullCouncil,
  stage1CollectResponses,
  stage2CollectRankings,
  stage3SynthesizeFinal,
  stage3SynthesizeFinalStream,
  stageWebFetch,
  suggestChairmanModelsThatFit,
} from "./council.js";
import { withConversationLock } from "./lock.js";
import { queryModel } from "./openrouter.js";
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

app.get("/api/config", (c) =>
  c.json({
    council_models: COUNCIL_MODELS,
    web_search_models: WEB_SEARCH_MODELS,
    chairman_model: CHAIRMAN_MODEL,
    title_model: TITLE_MODEL,
    web_fetch_model: WEB_FETCH_MODEL,
    chairman_context_limits: chairmanContextLimitsForApi(),
    chairman_output_reserve_tokens: CHAIRMAN_OUTPUT_RESERVE_TOKENS,
  }),
);

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
  return c.req.header("x-openrouter-key")?.trim() || undefined;
}

type SendBody = {
  content?: string;
  chairman_model?: string;
  /** 与 `chairman_model` 同义（见项目重构 §5.4） */
  final_model?: string;
  use_web_search?: boolean;
  use_web_search_mode?: "off" | "auto" | "on";
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

function isAbortError(err: unknown): boolean {
  return (err as { name?: string })?.name === "AbortError";
}

app.post("/api/conversations/:id/message", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as SendBody;
  const content = body.content?.trim();
  if (!content) return c.json({ detail: "content required" }, 400);
  const apiKey = extractApiKey(c);

  const conv = await getConversation(id);
  if (!conv) return c.json({ detail: "Conversation not found" }, 404);

  const shouldGenerateTitle =
    conv.messages.length === 0 ||
    !conv.title?.trim() ||
    conv.title.trim() === "New Conversation";
  const judgeWeights = parseJudgeWeights(body);
  const webSearchMode = parseWebSearchMode(
    body.use_web_search_mode,
    body.use_web_search,
  );
  const webSearchPlan = await decideWebSearchPlan(
    content,
    conv.messages,
    webSearchMode,
    apiKey,
    c.req.raw.signal,
  );

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

  const [s1, s2, s3, meta, webFetch] = await runFullCouncil(content, {
    chairmanModel: parseChairman(body),
    useWebSearch: webSearchPlan.action === "search",
    webSearchMode,
    webFetchModel: parseWebFetchModel(body),
    judgeWeights,
    apiKey,
    signal: c.req.raw.signal,
    historyMessages: conv.messages,
    webSearchPlan,
  });

  await withConversationLock(id, async () => {
    await addAssistantMessage(id, s1, s2, s3, {
      label_to_model: meta.label_to_model,
      aggregate_rankings: meta.aggregate_rankings,
    }, webFetch);
  });

  return c.json({
    webFetch,
    stage1: s1,
    stage2: s2,
    stage3: s3,
    metadata: meta,
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
  const apiKey = extractApiKey(c);

  const conv = await getConversation(id);
  if (!conv) return c.json({ detail: "Conversation not found" }, 404);

  const shouldGenerateTitle =
    conv.messages.length === 0 ||
    !conv.title?.trim() ||
    conv.title.trim() === "New Conversation";
  const chairmanModel = parseChairman(body);
  const webFetchModel = parseWebFetchModel(body);
  const judgeWeights = parseJudgeWeights(body);
  const webSearchMode = parseWebSearchMode(
    body.use_web_search_mode,
    body.use_web_search,
  );
  const webSearchPlan = await decideWebSearchPlan(
    content,
    conv.messages,
    webSearchMode,
    apiKey,
    c.req.raw.signal,
  );

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (obj: unknown) => controller.enqueue(sseLine(obj));
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
        if (webSearchPlan.action === "reuse" && webSearchPlan.previousWebFetch) {
          webFetchResult = {
            ...webSearchPlan.previousWebFetch,
            webSearchMode,
            webSearchAction: "reuse",
            webSearchReason: webSearchPlan.reason,
            reusedFromPrevious: true,
          };
          push({ type: "web_fetch_complete", data: webFetchResult });
          if (!webFetchResult.webSearchSkipped) {
            webContext = webFetchResult.content;
          }
        } else if (webSearchPlan.action === "search") {
          push({ type: "web_fetch_start" });
          webFetchResult = await stageWebFetch(
            effectiveQuery,
            webFetchModel,
            apiKey,
            requestSignal,
            webSearchPlan,
          );
          push({ type: "web_fetch_complete", data: webFetchResult });
          if (!webFetchResult.webSearchSkipped) {
            webContext = webFetchResult.content;
          }
        }

        push({ type: "stage1_start" });
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
        );
        push({ type: "stage1_complete", data: stage1Results });

        push({ type: "stage2_start" });
        const [stage2Results, labelToModel] = await stage2CollectRankings(
          effectiveQuery,
          stage1Results,
          webSearchPlan.action === "search",
          apiKey,
          requestSignal,
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
        );

        let stage3Result: Stage3Result;

        if (!gate.proceed) {
          stage3Result = gate.stage3;
          const candidates = [
            ...COUNCIL_MODELS,
            CHAIRMAN_MODEL,
            gate.analysis.chairman_model,
          ];
          let suggested = suggestChairmanModelsThatFit(
            gate.analysis.estimated_input_tokens,
            candidates,
          );
          if (suggested.length === 0) {
            suggested = [...new Set(candidates)].sort(
              (a, b) =>
                resolveChairmanContextLimit(b) - resolveChairmanContextLimit(a),
            );
          }

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
            webSearchPlan.action === "search",
            judgeWeights,
            labelToModel,
            (delta) => push({ type: "stage3_delta", data: { delta } }),
            apiKey,
            requestSignal,
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
        if (isAbortError(e)) return;
        push({
          type: "error",
          message: e instanceof Error ? e.message : String(e),
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

    const body = (await c.req.json().catch(() => ({}))) as RerunBody;
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
        { useWebSearch: rerunPlan.action === "search", apiKey },
      );

      const stage1 = [...msg.stage1];
      const ix = stage1.findIndex((s) => s.model === model);
      if (ix === -1) return { error: "model not in stage1" as const };

      stage1[ix] = {
        model,
        response: res?.content ?? "(request failed)",
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

    const body = (await c.req.json().catch(() => ({}))) as RerunBody;

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
        !rerunPlan.previousWebFetch.webSearchSkipped
      ) {
        webContext = rerunPlan.previousWebFetch.content;
      } else if (
        rerunMode !== "off" &&
        msg.webFetch &&
        !msg.webFetch.webSearchSkipped
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
      );

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

    return c.json(result);
  },
);

app.post("/api/conversations/:id/messages/:msgIndex/rerun-stage2", async (c) => {
  const id = c.req.param("id");
  const msgIndex = parseMsgIndex(c);
  if (msgIndex < 0) return c.json({ detail: "invalid msgIndex" }, 400);
  const apiKey = extractApiKey(c);

  const body = (await c.req.json().catch(() => ({}))) as RerunBody;
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

  const body = (await c.req.json().catch(() => ({}))) as RerunBody;
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
        );

    if (!gate.proceed) {
      const candidates = [
        ...COUNCIL_MODELS,
        CHAIRMAN_MODEL,
        gate.analysis.chairman_model,
      ];
      let suggested = suggestChairmanModelsThatFit(
        gate.analysis.estimated_input_tokens,
        candidates,
      );
      if (suggested.length === 0) {
        suggested = [...new Set(candidates)].sort(
          (a, b) =>
            resolveChairmanContextLimit(b) - resolveChairmanContextLimit(a),
        );
      }
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

console.log(`Vela 助手 API listening on http://0.0.0.0:${API_PORT}`);
serve({ fetch: app.fetch, port: API_PORT });
