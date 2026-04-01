import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Monorepo 根目录：`apps/api/src` 或 `apps/api/dist` 下需向上三级（src→api→apps→仓库根） */
const repoRoot = path.resolve(__dirname, '..', '..', '..')
loadEnv({ path: path.join(repoRoot, '.env') })
loadEnv({ path: path.join(repoRoot, 'apps', 'api', '.env'), override: true })

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? ''
export const OPENROUTER_API_URL =
  process.env.OPENROUTER_API_URL ??
  'https://openrouter.ai/api/v1/chat/completions'

export const COUNCIL_MODELS: string[] = [
  'openai/gpt-5.1',
  'google/gemini-3.1-pro-preview',
  'anthropic/claude-sonnet-4.5'
]

/**
 * 适合搭配 OpenRouter `web` 插件 / `:online` 的模型（原生搜索或 Exa 等兜底）。
 * 文档亦提及可向 `openrouter:web_search` 服务端工具迁移；当前实现仍使用 `plugins: [{ id: "web" }]`。
 * @see https://openrouter.ai/docs/guides/features/plugins/web-search
 */
export const WEB_SEARCH_MODELS: string[] = [
  'openai/gpt-5.1:online',
  'openai/gpt-4.1:online',
  'anthropic/claude-sonnet-4.5',
  'perplexity/sonar-pro',
  'x-ai/grok-4',
  'google/gemini-3.1-pro-preview',
  'google/gemini-2.5-flash'
]

export const CHAIRMAN_MODEL =
  process.env.CHAIRMAN_MODEL ?? 'google/gemini-3.1-pro-preview'

export const TITLE_MODEL = process.env.TITLE_MODEL ?? 'google/gemini-2.5-flash'

/** 默认用 `:online`，与 OpenRouter web 插件等价且对 OpenAI 原生联网最稳；Gemini 无 `:online` 时需依赖 Exa（见 openrouter.ts `engine: "exa"`）。 */
export const WEB_FETCH_MODEL =
  process.env.WEB_FETCH_MODEL ?? 'openai/gpt-5.1:online'

export const DATA_DIR = path.resolve(
  process.env.DATA_DIR ?? path.join(__dirname, '..', 'data', 'conversations')
)

export const API_PORT = Number(process.env.PORT ?? '8001')
