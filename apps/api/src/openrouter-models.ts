const OPENROUTER_MODELS_URL =
  "https://openrouter.ai/api/v1/models?output_modality=text";
const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;

type OpenRouterModel = {
  id: string;
  created?: number;
  pricing?: Record<string, string | number | undefined>;
};

type OpenRouterModelsResponse = {
  data?: OpenRouterModel[];
};

export type FeaturedModelGroup = {
  key: string;
  label: string;
  latest: string[];
  free: string[];
};

type FeaturedModelRule = {
  key: string;
  label: string;
  latestMatch: (model: OpenRouterModel) => boolean;
  freeMatch?: (model: OpenRouterModel) => boolean;
};

const FEATURED_MODEL_RULES: FeaturedModelRule[] = [
  {
    key: "claude",
    label: "Claude / Anthropic",
    latestMatch: (model) => model.id.startsWith("anthropic/claude-"),
  },
  {
    key: "openai",
    label: "OpenAI",
    latestMatch: (model) => model.id.startsWith("openai/"),
  },
  {
    key: "gemini",
    label: "Gemini / Google",
    latestMatch: (model) => model.id.startsWith("google/gemini-"),
    freeMatch: (model) => model.id.startsWith("google/"),
  },
  {
    key: "grok",
    label: "Grok / xAI",
    latestMatch: (model) => model.id.startsWith("x-ai/grok-"),
  },
  {
    key: "glm",
    label: "GLM / Z.ai",
    latestMatch: (model) => model.id.startsWith("z-ai/glm-"),
  },
  {
    key: "qwen",
    label: "千问 / Qwen",
    latestMatch: (model) => model.id.startsWith("qwen/"),
  },
  {
    key: "kimi",
    label: "Kimi / MoonshotAI",
    latestMatch: (model) => model.id.startsWith("moonshotai/kimi-"),
  },
  {
    key: "minimax",
    label: "MiniMax",
    latestMatch: (model) => model.id.startsWith("minimax/"),
  },
  {
    key: "doubao",
    label: "豆包 / ByteDance",
    latestMatch: (model) => model.id.startsWith("bytedance/"),
  },
  {
    key: "yuanbao",
    label: "腾讯元宝 / Tencent",
    latestMatch: (model) => model.id.startsWith("tencent/"),
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    latestMatch: (model) => model.id.startsWith("deepseek/"),
  },
];

let cached:
  | {
      expiresAt: number;
      groups: FeaturedModelGroup[];
    }
  | null = null;

function modelCreatedAt(model: OpenRouterModel): number {
  return typeof model.created === "number" ? model.created : 0;
}

function isFreeModel(model: OpenRouterModel): boolean {
  if (model.id.endsWith(":free")) return true;
  const prices = Object.values(model.pricing ?? {})
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  return prices.length > 0 && prices.every((value) => value === 0);
}

function topModelIds(
  models: OpenRouterModel[],
  match: (model: OpenRouterModel) => boolean,
): string[] {
  return models
    .filter(match)
    .sort((a, b) => modelCreatedAt(b) - modelCreatedAt(a) || a.id.localeCompare(b.id))
    .slice(0, 2)
    .map((model) => model.id);
}

function buildFeaturedModelGroups(models: OpenRouterModel[]): FeaturedModelGroup[] {
  return FEATURED_MODEL_RULES.map((rule) => ({
    key: rule.key,
    label: rule.label,
    latest: topModelIds(models, rule.latestMatch),
    free: topModelIds(
      models,
      (model) => isFreeModel(model) && (rule.freeMatch ?? rule.latestMatch)(model),
    ),
  }));
}

async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  const res = await fetch(OPENROUTER_MODELS_URL);
  if (!res.ok) {
    throw new Error(`OpenRouter models API failed: ${res.status}`);
  }
  const json = (await res.json()) as OpenRouterModelsResponse;
  return Array.isArray(json.data) ? json.data : [];
}

export async function getFeaturedModelGroups(): Promise<FeaturedModelGroup[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.groups;

  const groups = buildFeaturedModelGroups(await fetchOpenRouterModels());
  cached = { groups, expiresAt: now + MODEL_CACHE_TTL_MS };
  return groups;
}
