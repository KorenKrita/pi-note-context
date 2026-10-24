/**
 * Jev (TypeSafe System One classifier) judgements. Jev answers typed questions about
 * JSON state with probabilities; it never writes text, so it only classifies and
 * ranks — extraction stays mechanical (rollover.ts). Every call fails open: a missing
 * model, a timeout, or an error returns null and the caller keeps its mechanical rule.
 * Jev rejects requests above about 32K input tokens, so state is trimmed to a char budget.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** What a user message mainly does. `notification` is mechanical (subagent results), never asked of Jev. */
export type UserKind = "decide" | "ack" | "inform" | "ask" | "vent";

export interface JevOptions {
  enabled: boolean;
  timeoutMs: number;
  /** Probability at or above which new user messages count as a decision the notebook lacks. */
  unrecordedThreshold: number;
  /** TypeSafe classifier model id. */
  model: string;
  /** Endpoint override; set, the request bypasses Pi's `typesafe` provider (whose baseUrl would win). */
  baseUrl?: string;
  /** API key, or `$NAME` to read the environment variable NAME. */
  apiKey?: string;
}

export const DEFAULT_JEV: JevOptions = { enabled: true, timeoutMs: 5000, unrecordedThreshold: 0.8, model: "jev-latest" };

export function resolveApiKey(value: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!value) return undefined;
  return value.startsWith("$") ? env[value.slice(1)] || undefined : value;
}

type ClassifyFn = (model: unknown, context: { state: Record<string, unknown>; questions: Record<string, Question> }, options?: { signal?: AbortSignal; apiKey?: string }) => Promise<{ stopReason: string; answers?: Record<string, Answer | undefined> }>;

/** CJK text runs close to one token per char; 24K chars keeps a request well under Jev's ~32K-token limit. */
export const JEV_STATE_MAX_CHARS = 24_000;
/** The notebook's own default cap is 16 KiB; clipping it shorter would hide recorded decisions. */
const NOTEBOOK_MAX_CHARS = 16_384;
const MESSAGE_MAX_CHARS = 1_200;

const KIND_CRITERIA: Record<UserKind, string> = {
  decide: "Makes a decision, states a preference, or gives a requirement or correction",
  ack: "Short approval or acknowledgement of something proposed earlier, such as 'ok' or 'do it'",
  inform: "Gives information, context, or feedback without a clear decision",
  ask: "Asks a question",
  vent: "Expresses frustration or complains",
};

type Question =
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };
type Answer = { type: "bool"; probability: number } | { type: "choice"; choice: string; probabilities: Record<string, number> };

/** Pi ≥ 1.x classifier API; declared structurally because the pinned 0.87 types predate it. */
interface ClassifierRegistry {
  findOfType?: (type: "classifier", provider: string, id: string) => unknown;
  classify?: ClassifyFn;
  /** The provider's own classify takes the model's baseUrl and options.apiKey as given (registry.classify re-applies the provider's). */
  getProvider?: (id: string) => { classify?: ClassifyFn } | undefined;
}

async function ask(ctx: ExtensionContext, opts: JevOptions, state: Record<string, unknown>, questions: Record<string, Question>) {
  if (!opts.enabled) return null;
  const registry = ctx.modelRegistry as unknown as ClassifierRegistry;
  if (!registry.findOfType || !registry.classify) return null;
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A local deadline: a provider that ignores the abort must not hold the caller or win late.
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => (ac.abort(), resolve(null)), opts.timeoutMs);
  });
  const call = (async () => {
    const apiKey = resolveApiKey(opts.apiKey);
    const template = registry.findOfType?.("classifier", "typesafe", opts.model) as Record<string, unknown> | undefined;
    if (opts.baseUrl) {
      const provider = registry.getProvider?.("typesafe");
      if (!provider?.classify) return null;
      const model = {
        ...(template ?? { type: "classifier", api: "typesafe-system-one", provider: "typesafe", name: opts.model, contextWindow: 32_000, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
        id: opts.model,
        baseUrl: opts.baseUrl,
      };
      const r = await provider.classify(model, { state, questions }, { apiKey, signal: ac.signal });
      return r.stopReason === "stop" ? (r.answers ?? null) : null;
    }
    if (!template) return null;
    const r = await registry.classify!(template, { state, questions }, { signal: ac.signal, ...(apiKey ? { apiKey } : {}) });
    return r.stopReason === "stop" ? (r.answers ?? null) : null;
  })().catch(() => null);
  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function clipForJev(text: string, max = MESSAGE_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function classifyUserMessage(ctx: ExtensionContext, opts: JevOptions, text: string): Promise<UserKind | null> {
  const answers = await ask(ctx, opts, { user_message: clipForJev(text, 4_000) }, {
    kind: { type: "choice", instructions: "What is `user_message`, written by a user to their coding assistant, mainly doing?", criteria: KIND_CRITERIA },
  });
  const a = answers?.["kind"];
  return a?.type === "choice" && a.choice in KIND_CRITERIA ? (a.choice as UserKind) : null;
}

/**
 * Probability that `messages` (newest last) carry a decision the notebook does not record, or null.
 * Messages are clipped and the oldest dropped until notebook + messages fit the state budget.
 */
export async function unrecordedDecisionProbability(ctx: ExtensionContext, opts: JevOptions, notebookText: string, messages: readonly string[]): Promise<number | null> {
  const notebook = clipForJev(notebookText, NOTEBOOK_MAX_CHARS);
  let budget = JEV_STATE_MAX_CHARS - notebook.length;
  const kept: string[] = [];
  for (let i = messages.length - 1; i >= 0 && budget > 0; i--) {
    const m = clipForJev(messages[i]!);
    if (m.length > budget) break;
    kept.unshift(m);
    budget -= m.length;
  }
  if (kept.length === 0) return null;
  const answers = await ask(ctx, opts, { notebook, new_user_messages: kept }, {
    unrecorded: {
      type: "bool",
      instructions: "Does any message in `new_user_messages` state a decision, preference, or requirement that `notebook` does not already record? A message prefixed with `(assistant proposed: …)` approves that proposal, so it adopts the decisions in it. Ignore questions, bare acknowledgements, and complaints.",
      criteria: { true: "At least one decision is missing from the notebook", false: "Every decision is already recorded, or there is none" },
    },
  });
  const a = answers?.["unrecorded"];
  return a?.type === "bool" ? a.probability : null;
}
