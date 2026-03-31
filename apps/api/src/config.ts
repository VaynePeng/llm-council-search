import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Monorepo 根目录：`apps/api/src` 或 `apps/api/dist` 下需向上三级（src→api→apps→仓库根） */
const repoRoot = path.resolve(__dirname, "..", "..", "..");
loadEnv({ path: path.join(repoRoot, ".env") });
loadEnv({ path: path.join(repoRoot, "apps", "api", ".env"), override: true });

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
export const OPENROUTER_API_URL =
  process.env.OPENROUTER_API_URL ?? "https://openrouter.ai/api/v1/chat/completions";

export const COUNCIL_MODELS: string[] = [
  "openai/gpt-5.1",
  "google/gemini-3-pro-preview",
  "anthropic/claude-sonnet-4.5",
  "x-ai/grok-4",
];

export const CHAIRMAN_MODEL =
  process.env.CHAIRMAN_MODEL ?? "google/gemini-3-pro-preview";

export const TITLE_MODEL = process.env.TITLE_MODEL ?? "google/gemini-2.5-flash";

export const DATA_DIR = path.resolve(
  process.env.DATA_DIR ?? path.join(__dirname, "..", "data", "conversations"),
);

export const API_PORT = Number(process.env.PORT ?? "8001");
