import { AsyncLocalStorage } from "node:async_hooks";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type LogContext = {
  requestId?: string;
  route?: string;
  conversationId?: string;
};

const logContextStorage = new AsyncLocalStorage<LogContext>();

function getConsoleMethod(level: LogLevel): "log" | "warn" | "error" {
  switch (level) {
    case "WARN":
      return "warn";
    case "ERROR":
      return "error";
    default:
      return "log";
  }
}

export function getLogContext(): LogContext {
  return logContextStorage.getStore() ?? {};
}

export function withLogContext<T>(
  nextContext: LogContext,
  fn: () => T,
): T {
  const current = getLogContext();
  return logContextStorage.run({ ...current, ...nextContext }, fn);
}

export function summarizeText(text: string | undefined, maxChars = 160): string | undefined {
  if (!text) return text;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: summarizeText(error.stack, 500),
    };
  }
  return { message: String(error) };
}

function emit(level: LogLevel, event: string, data?: Record<string, unknown>): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...getLogContext(),
    ...(data ?? {}),
  };
  console[getConsoleMethod(level)](JSON.stringify(payload));
}

export function logDebug(event: string, data?: Record<string, unknown>): void {
  emit("DEBUG", event, data);
}

export function logInfo(event: string, data?: Record<string, unknown>): void {
  emit("INFO", event, data);
}

export function logWarn(event: string, data?: Record<string, unknown>): void {
  emit("WARN", event, data);
}

export function logError(event: string, data?: Record<string, unknown>): void {
  emit("ERROR", event, data);
}

export async function logStep<T>(
  event: string,
  data: Record<string, unknown> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  logInfo(`${event}.start`, data);
  try {
    const result = await fn();
    logInfo(`${event}.done`, {
      ...(data ?? {}),
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    logError(`${event}.error`, {
      ...(data ?? {}),
      durationMs: Date.now() - startedAt,
      error: summarizeError(error),
    });
    throw error;
  }
}
