/**
 * Status line: one line of facts injected before every LLM call.
 * DESIGN.md §4.1. No judgement words, no thresholds.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Notebook } from "./notebook.ts";

export const STATUS_CUSTOM_TYPE = "note-context/status";

export interface UsageLike {
  tokens: number | null;
  contextWindow: number;
}

export interface StatusInput {
  window: number;
  usage: UsageLike | undefined;
  notebook: Notebook;
  /** Assistant turns on the branch since the notebook was last written/reviewed; null when never. */
  turnsSinceReview: number | null;
  /** Set for one call after /tree navigation. */
  branchChanged?: boolean;
  /** Set when compaction for the current model is owned by another extension. */
  externalCompaction?: boolean;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trimZero((n / 1000).toFixed(n < 10_000 ? 1 : 0))}K`;
  return `${trimZero((n / 1_000_000).toFixed(1))}M`;
}

function trimZero(s: string): string {
  return s.replace(/\.0$/, "");
}

export function renderStatusLine(s: StatusInput): string {
  const parts: string[] = [];
  parts.push(`window #${s.window}${s.window > 1 ? ` (prev #${s.window - 1})` : ""}`);
  if (s.usage && s.usage.contextWindow > 0) {
    parts.push(`${s.usage.tokens === null ? "?" : formatTokens(s.usage.tokens)}/${formatTokens(s.usage.contextWindow)}`);
  }
  if (s.notebook.revision === 0) {
    parts.push("no notes yet");
  } else {
    const age = s.turnsSinceReview === null ? "" : s.turnsSinceReview === 0 ? ", reviewed this turn" : `, reviewed ${s.turnsSinceReview} turn${s.turnsSinceReview === 1 ? "" : "s"} ago`;
    parts.push(`notes rev ${s.notebook.revision}${age}`);
  }
  if (s.externalCompaction) parts.push("compaction: external");
  if (s.branchChanged) parts.push("branch changed — verify workspace state");
  return `[note-context] ${parts.join(" · ")}`;
}

/**
 * Count assistant message entries on the branch strictly after `reviewedThrough`.
 * Returns null when reviewedThrough is null or not found on the branch (e.g. after /tree away from it).
 */
export function turnsSince(branch: readonly SessionEntry[], reviewedThrough: string | null): number | null {
  if (reviewedThrough === null) return null;
  const i = branch.findIndex((e) => e.id === reviewedThrough);
  if (i < 0) return null;
  let n = 0;
  for (let j = i + 1; j < branch.length; j++) {
    const e = branch[j]!;
    if (e.type === "message" && e.message.role === "assistant") n++;
  }
  return n;
}

/**
 * Index at which to insert the status message: after the last completed
 * protocol boundary. Concretely: after the last toolResult that closes the
 * trailing assistant tool batch, or at the end if the tail is not a tool batch.
 * Never between an assistant toolCall and its toolResults.
 */
export function statusInsertIndex(messages: readonly { role: string }[]): number {
  // Walk back over trailing toolResults; if we then hit an assistant with tool calls,
  // the batch is complete only if every call has a result — Pi guarantees this at
  // transformContext time, so inserting at the very end is always at a boundary.
  return messages.length;
}
