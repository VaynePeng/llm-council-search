const OFOX_MODELS_URL = "https://api.ofox.ai/v1/models";
const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;

type OfoxModel = {
  id: string;
  created?: number;
};

type OfoxModelsResponse = {
  data?: OfoxModel[];
};

export type FeaturedModelGroup = {
  key: string;
  label: string;
  models: string[];
};

type FeaturedModelRule = {
  key: string;
  label: string;
  match: (model: OfoxModel) => boolean;
};

const FEATURED_MODEL_RULES: FeaturedModelRule[] = [
  {
    key: "claude",
    label: "Claude / Anthropic",
    match: (model) => model.id.startsWith("anthropic/claude-"),
  },
  {
    key: "openai",
    label: "OpenAI",
    match: (model) => model.id.startsWith("openai/"),
  },
  {
    key: "glm",
    label: "GLM / Z.ai",
    match: (model) => model.id.startsWith("z-ai/glm-"),
  },
  {
    key: "qwen",
    label: "千问 / Qwen",
    match: (model) => model.id.startsWith("qwen/"),
  },
  {
    key: "kimi",
    label: "Kimi / MoonshotAI",
    match: (model) => model.id.startsWith("moonshotai/kimi-"),
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    match: (model) => model.id.startsWith("deepseek/"),
  },
];

let cached:
  | {
      expiresAt: number;
      groups: FeaturedModelGroup[];
    }
  | null = null;

function modelCreatedAt(model: OfoxModel): number {
  return typeof model.created === "number" ? model.created : 0;
}

function topModelIds(
  models: OfoxModel[],
  match: (model: OfoxModel) => boolean,
): string[] {
  return models
    .filter(match)
    .sort((a, b) => modelCreatedAt(b) - modelCreatedAt(a) || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((model) => model.id);
}

function buildFeaturedModelGroups(models: OfoxModel[]): FeaturedModelGroup[] {
  return FEATURED_MODEL_RULES.map((rule) => ({
    key: rule.key,
    label: rule.label,
    models: topModelIds(models, rule.match),
  }));
}

async function fetchOfoxModels(): Promise<OfoxModel[]> {
  const res = await fetch(OFOX_MODELS_URL);
  if (!res.ok) {
    throw new Error(`Ofox models API failed: ${res.status}`);
  }
  const json = (await res.json()) as OfoxModelsResponse;
  return Array.isArray(json.data) ? json.data : [];
}

export async function getFeaturedModelGroups(): Promise<FeaturedModelGroup[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.groups;

  const groups = buildFeaturedModelGroups(await fetchOfoxModels());
  cached = { groups, expiresAt: now + MODEL_CACHE_TTL_MS };
  return groups;
}
