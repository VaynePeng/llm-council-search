/** Serialize mutations per conversation id (JSON file writes). */
const tails = new Map<string, Promise<unknown>>();

export function withConversationLock<T>(
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = tails.get(conversationId) ?? Promise.resolve();
  const run = prev.then(() => fn());
  tails.set(
    conversationId,
    run.then(() => undefined).catch(() => undefined),
  );
  return run;
}
