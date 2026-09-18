/** Small dependency-free helpers shared across AgentGhost. */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

/**
 * Normalize however a framework passes arguments to a tool into a single
 * object. Most frameworks call `execute(input, options)`; some spread args.
 */
export function extractArgs(raw: readonly unknown[]): Record<string, unknown> {
  if (raw.length === 0) return {};
  const first = raw[0];
  if (isPlainObject(first)) return first;
  if (raw.length === 1) return { value: first };
  return { args: raw } as unknown as Record<string, unknown>;
}

/**
 * Find an AbortSignal among a tool call's arguments. The Vercel AI SDK and
 * OpenAI agents pass `{ abortSignal }` as a trailing options object, so AgentGhost
 * can cancel an in-flight judge call when the agent run is aborted.
 */
export function extractSignal(args: readonly unknown[]): AbortSignal | undefined {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const candidate = args[index];
    if (typeof candidate !== "object" || candidate === null) continue;
    const signal = (candidate as { abortSignal?: unknown }).abortSignal;
    if (
      signal !== null &&
      typeof signal === "object" &&
      typeof (signal as AbortSignal).aborted === "boolean"
    ) {
      return signal as AbortSignal;
    }
  }
  return undefined;
}

/** JSON.stringify that tolerates circular references and BigInt. */export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    });
  } catch {
    return "[Unserializable]";
  }
}

/** Truncate a string to a character budget, appending an ellipsis marker. */
export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

/** Resolve a possibly-lazy, possibly-async value. */
export async function resolve<T>(value: T | (() => T | Promise<T>)): Promise<T> {
  return typeof value === "function"
    ? await (value as () => T | Promise<T>)()
    : value;
}

export function now(): number {
  return Date.now();
}

export function getEnv(key: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return proc?.env?.[key];
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
