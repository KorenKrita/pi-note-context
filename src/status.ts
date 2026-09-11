/**
 * Status line: one line of facts appended to a tool result, persisted with it.
 * DESIGN.md §4.1. No judgement words, no thresholds in the text.
 *
 * Delivery is a suffix patch on the tool result (not a trailing message): a
 * trailing message that changes or disappears between requests breaks
 * implicit prefix caching on OpenAI Responses; a suffix inside an entry
 * that is already persisted replays byte-for-byte.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Notebook } from "./notebook.ts";

export interface UsageLike {
  tokens: number | null;
  /** Scale pressure is read against (min(physical, budget)). */
  contextWindow: number;
  /** Physical window when it differs from the budget scale. */
  physicalWindow?: number;
}

export interface StatusInput {
  usage: UsageLike | undefined;
  notebook: Notebook;
  /** Tokens added to the context since the notebook was last written/reviewed; null when unknown. */
  tokensSinceReview: number | null;
  /** Set for one reading after /tree navigation. */
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
  if (s.usage && s.usage.contextWindow > 0) {
    const scale = s.usage.physicalWindow && s.usage.physicalWindow !== s.usage.contextWindow ? ` budget (${formatTokens(s.usage.physicalWindow)} window)` : "";
    parts.push(`${s.usage.tokens === null ? "?" : formatTokens(s.usage.tokens)}/${formatTokens(s.usage.contextWindow)}${scale}`);
  }
  if (s.notebook.revision === 0) {
    parts.push("no notes yet");
  } else {
    const age = s.tokensSinceReview === null ? "" : `, +${formatTokens(Math.max(0, s.tokensSinceReview))} since review`;
    parts.push(`notes rev ${s.notebook.revision}${age}`);
  }
  if (s.externalCompaction) parts.push("compaction: external");
  if (s.branchChanged) parts.push("branch changed — verify workspace state");
  return `[note-context] ${parts.join(" · ")}`;
}

/** Tokens added since the notebook's review marker; null when either side is unknown. */
export function tokensSinceReview(usageTokens: number | null | undefined, notebook: Notebook): number | null {
  if (notebook.revision === 0 || notebook.reviewedTokens === null || usageTokens == null) return null;
  return usageTokens - notebook.reviewedTokens;
}

/**
 * Decides when a reading is delivered. Two independent ticks share one step size:
 *  - pressure: `floor(tokens / step)` differs from the last delivered reading (either direction);
 *  - staleness: `floor(tokensSinceReview / step)` ≥ 1 and differs from the last delivered
 *    reading for the same notebook revision (a write or review resets it).
 * The first reading after construction/reset and a forced reading always deliver.
 */
export class StatusOdometer {
  private lastPressureStep: number | null = null;
  private lastStale: { entryId: string | null; step: number } | null = null;
  private forced = false;

  force(): void {
    this.forced = true;
  }

  reset(): void {
    this.lastPressureStep = null;
    this.lastStale = null;
    this.forced = false;
  }

  shouldShow(step: number, tokens: number | null, sinceReview: number | null, notebook: Notebook): boolean {
    if (this.forced || this.lastPressureStep === null) return true;
    if (step <= 0) return false;
    if (tokens !== null && Math.floor(tokens / step) !== this.lastPressureStep) return true;
    if (sinceReview !== null) {
      const s = Math.floor(sinceReview / step);
      if (s >= 1 && (this.lastStale === null || this.lastStale.entryId !== notebook.entryId || this.lastStale.step !== s)) return true;
    }
    return false;
  }

  confirm(step: number, tokens: number | null, sinceReview: number | null, notebook: Notebook): void {
    this.forced = false;
    this.lastPressureStep = tokens !== null && step > 0 ? Math.floor(tokens / step) : (this.lastPressureStep ?? 0);
    if (sinceReview !== null && step > 0) this.lastStale = { entryId: notebook.entryId, step: Math.floor(sinceReview / step) };
  }
}

/** Append `suffix` to the last text part; undefined when the result has no text part to carry it. */
export function appendSuffixPatch<T extends { type: string }>(content: readonly T[], suffix: string): { content: T[] } | undefined {
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i]!;
    if (part.type === "text" && typeof (part as { text?: unknown }).text === "string") {
      const patched = [...content];
      patched[i] = { ...part, text: `${(part as unknown as { text: string }).text}\n\n${suffix}` };
      return { content: patched };
    }
  }
  return undefined;
}

/**
 * Count assistant message entries on the branch strictly after `sinceId`.
 * Returns null when sinceId is null or not found on the branch (e.g. after /tree away from it).
 */
export function turnsSince(branch: readonly SessionEntry[], sinceId: string | null): number | null {
  if (sinceId === null) return null;
  const i = branch.findIndex((e) => e.id === sinceId);
  if (i < 0) return null;
  let n = 0;
  for (let j = i + 1; j < branch.length; j++) {
    const e = branch[j]!;
    if (e.type === "message" && e.message.role === "assistant") n++;
  }
  return n;
}
