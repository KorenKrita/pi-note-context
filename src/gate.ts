/**
 * new_context gate: structural checks before a rollover is scheduled (DESIGN.md §3.2).
 * Reuses Pi's exported compaction primitives so the projection matches what
 * compaction will actually do.
 */

import { findCutPoint, estimateTokens, sessionEntryToContextMessages, type CompactionSettings, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Notebook } from "./notebook.ts";

export interface GateInput {
  /** Compaction-aware active context entries (ctx.sessionManager.buildContextEntries()): latest compaction entry, its retained tail, then newer entries. */
  branch: readonly SessionEntry[];
  notebook: Notebook;
  settings: Required<Pick<CompactionSettings, "keepRecentTokens">>;
  minReclaimTokens: number;
  pending: boolean;
  /** Estimated tokens of the template summary that will replace the dropped range. */
  summaryTokens: number;
}

export type GateVerdict =
  | { ok: true; firstKeptEntryId: string; reclaimTokens: number; droppedEntries: number }
  | { ok: false; blocker: "already_pending" | "no_notebook" | "stale_notebook" | "nothing_to_drop" | "low_reclaim"; message: string; reclaimTokens?: number };

/**
 * Index where the droppable range starts inside the active context entries.
 * `buildContextEntries()` places the latest compaction entry first, followed by
 * the entries it retained and everything newer; all of those are droppable by
 * the next compaction, so the range starts right after the compaction entry.
 * Without a compaction the whole context is droppable.
 */
export function windowStartIndex(context: readonly SessionEntry[]): number {
  return context[0]?.type === "compaction" ? 1 : 0;
}

export function projectCut(branch: readonly SessionEntry[], keepRecentTokens: number): { firstKeptEntryId: string | null; firstKeptIndex: number; start: number } {
  const start = windowStartIndex(branch);
  if (start >= branch.length) return { firstKeptEntryId: null, firstKeptIndex: start, start };
  const entries = branch as SessionEntry[];
  const cut = findCutPoint(entries, start, entries.length, keepRecentTokens);
  const first = entries[cut.firstKeptEntryIndex];
  return { firstKeptEntryId: first?.id ?? null, firstKeptIndex: cut.firstKeptEntryIndex, start };
}

export function estimateRange(branch: readonly SessionEntry[], from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) for (const m of sessionEntryToContextMessages(branch[i]!)) n += estimateTokens(m);
  return n;
}

export function evaluateGate(input: GateInput): GateVerdict {
  if (input.pending) return { ok: false, blocker: "already_pending", message: "rollover already scheduled for the end of this turn." };
  if (input.notebook.revision === 0) return { ok: false, blocker: "no_notebook", message: "no notebook on this branch — write notes first." };

  const { firstKeptEntryId, firstKeptIndex, start } = projectCut(input.branch, input.settings.keepRecentTokens);
  if (!firstKeptEntryId || firstKeptIndex <= start) {
    return { ok: false, blocker: "nothing_to_drop", message: "nothing would leave the window: the whole window fits inside the retained recent tail." };
  }

  // Freshness: the notebook's reviewedThrough must be at or after the last entry that would be dropped.
  const dropEnd = firstKeptIndex - 1;
  const reviewedIdx = input.notebook.reviewedThrough ? input.branch.findIndex((e) => e.id === input.notebook.reviewedThrough) : -1;
  if (reviewedIdx < dropEnd) {
    const unreviewed = dropEnd - Math.max(reviewedIdx, start - 1);
    return {
      ok: false,
      blocker: "stale_notebook",
      message: `notebook predates material that would be dropped (${unreviewed} entr${unreviewed === 1 ? "y" : "ies"} after the last review) — update notes or call notes({reviewed:true}) after checking them.`,
    };
  }

  const dropped = estimateRange(input.branch, start, firstKeptIndex);
  const reclaim = dropped - input.summaryTokens;
  if (reclaim < input.minReclaimTokens) {
    return {
      ok: false,
      blocker: "low_reclaim",
      reclaimTokens: reclaim,
      message: `rollover would reclaim ~${Math.max(0, Math.round(reclaim / 1000))}K tokens; below the ${Math.round(input.minReclaimTokens / 1000)}K threshold — continue working.`,
    };
  }
  return { ok: true, firstKeptEntryId, reclaimTokens: reclaim, droppedEntries: firstKeptIndex - start };
}
