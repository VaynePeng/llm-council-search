import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Monorepo 根目录：`apps/api/src` 或 `apps/api/dist` 下需向上三级（src→api→apps→仓库根） */
const repoRoot = path.resolve(__dirname, '..', '..', '..')
loadEnv({ path: path.join(repoRoot, '.env') })
loadEnv({ path: path.join(repoRoot, 'apps', 'api', '.env'), override: true })

export const OFOX_API_URL =
  process.env.OFOX_API_URL ??
  'https://api.ofox.ai/v1/chat/completions'

export const TAVILY_API_URL =
  process.env.TAVILY_API_URL ??
  'https://api.tavily.com/search'

export const COUNCIL_MODELS: string[] = [
  'openai/gpt-5.1',
  'google/gemini-3.1-pro-preview',
  'anthropic/claude-sonnet-4.5'
]

export const CHAIRMAN_MODEL =
  process.env.CHAIRMAN_MODEL ?? 'google/gemini-3.1-pro-preview'

/**
 * 各主席模型总上下文（tokens，近似值，用于 Stage3 输入预估）。
 * 未列出的模型使用 DEFAULT_CHAIRMAN_CONTEXT_LIMIT；`:online` 等后缀会回退到去后缀 id。
 */
export const CHAIRMAN_CONTEXT_LIMITS: Record<string, number> = {
  'openai/gpt-5.1': 272_000,
  'google/gemini-3.1-pro-preview': 1_048_576,
  'anthropic/claude-sonnet-4.5': 200_000,
}

export const DEFAULT_CHAIRMAN_CONTEXT_LIMIT = 128_000

/** 为 Stage3 回答预留的 tokens，从总上下文中扣除后得到可用输入上限 */
export const CHAIRMAN_OUTPUT_RESERVE_TOKENS = 16_384

export function resolveChairmanContextLimit(modelId: string): number {
  const m = modelId.trim()
  if (CHAIRMAN_CONTEXT_LIMITS[m]) return CHAIRMAN_CONTEXT_LIMITS[m]
  const base = m.replace(/:online$/i, '')
  if (base !== m && CHAIRMAN_CONTEXT_LIMITS[base]) {
    return CHAIRMAN_CONTEXT_LIMITS[base]
  }
  return DEFAULT_CHAIRMAN_CONTEXT_LIMIT
}

export const TITLE_MODEL = process.env.TITLE_MODEL ?? 'google/gemini-2.5-flash'
export const FOLLOWUP_MODEL =
  process.env.FOLLOWUP_MODEL ?? 'qwen/qwen3.6-plus:free'

/** 用于 `auto` 联网判定的轻量路由模型；仅做 skip/search/reuse 决策。 */
export const WEB_SEARCH_ROUTER_MODEL =
  process.env.WEB_SEARCH_ROUTER_MODEL ?? 'google/gemini-2.5-flash'

export const DATA_DIR = path.resolve(
  process.env.DATA_DIR ?? path.join(__dirname, '..', 'data', 'conversations')
)

export const API_PORT = Number(process.env.PORT ?? '8001')

export const ALLOWED_ORIGINS: string[] = (
  process.env.ALLOWED_ORIGINS ??
  'http://localhost:3000,http://localhost:5173'
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

/** 供前端展示「已知上下文上限」的模型表（与 CHAIRMAN_CONTEXT_LIMITS 一致即可） */
export function chairmanContextLimitsForApi(): Record<string, number> {
  return { ...CHAIRMAN_CONTEXT_LIMITS }
}
