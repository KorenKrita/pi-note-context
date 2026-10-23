/**
 * Status line: one line appended to a tool result, persisted with it.
 * DESIGN.md §4.1. It is a notes-staleness nudge, not a context gauge: the host owns
 * rollover timing, so the text carries no token, budget or window figures (per-result
 * budget countdowns make current models anxious about context and make some of them
 * misread genuine mid-turn user messages as injected text).
 *
 * Delivery is a suffix patch on the tool result (not a trailing message): a
 * trailing message that changes or disappears between requests breaks
 * implicit prefix caching on OpenAI Responses; a suffix inside an entry
 * that is already persisted replays byte-for-byte.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Notebook } from "./notebook.ts";

export interface StatusInput {
  notebook: Notebook;
  /** Notes are stale: none yet, or not written/reviewed for at least one staleness step. */
  stale: boolean;
  /** Set for one reading after /tree navigation. */
  branchChanged?: boolean;
  /** Set (once per window) when compaction for the current model is owned by another extension. */
  externalCompaction?: boolean;
}

export function renderStatusLine(s: StatusInput): string {
  const parts: string[] = [];
  if (s.notebook.revision === 0) parts.push("no notes yet — write them once there is working state worth keeping");
  else if (s.stale) parts.push(`notes rev ${s.notebook.revision} not reviewed for a while — update them, or call notes({reviewed:true}) if they are still accurate`);
  else parts.push(`notes rev ${s.notebook.revision}`);
  if (s.externalCompaction) parts.push("compaction: external");
  if (s.branchChanged) parts.push("branch changed — verify workspace state");
  return `[note-context] ${parts.join(" · ")}`;
}

/**
 * Tokens added since the notebook's review marker; null when unknown. With no notebook yet
 * everything in the window is unreviewed, so it is the whole context.
 */
export function tokensSinceReview(usageTokens: number | null | undefined, notebook: Notebook): number | null {
  if (usageTokens == null) return null;
  if (notebook.revision === 0) return usageTokens;
  if (notebook.reviewedTokens === null) return null;
  return usageTokens - notebook.reviewedTokens;
}

/** Notes are stale when there are none, or when at least one step of tokens was added since the last write/review. */
export function isStale(step: number, sinceReview: number | null, notebook: Notebook): boolean {
  if (notebook.revision === 0) return true;
  return step > 0 && sinceReview !== null && sinceReview >= step;
}

export interface StatusReading {
  stale: boolean;
  branchChanged: boolean;
  externalCompaction: boolean;
  /** Staleness step this reading delivers, recorded on confirm. */
  staleStep: number | null;
}

/**
 * Decides when a reading is delivered. Overall context usage is not a trigger; only:
 *  - staleness: `floor(tokensSinceReview / step)` reaches a value not yet delivered for the
 *    current notebook record (≥ 1 with notes; ≥ 0 with no notes, so "no notes yet" shows
 *    once and then once per further step). A notes write or review is a new record and re-arms it;
 *  - one-shot facts: the reading after /tree navigation (`force`), and `compaction: external`
 *    once per window.
 * A notebook record with unknown `reviewedTokens` (written by an older version) never goes stale here.
 */
export class StatusOdometer {
  private lastStale: { entryId: string | null; step: number } | null = null;
  private externalShown = false;
  private forced = false;

  force(): void {
    this.forced = true;
  }

  /** New window or session: re-arm every tick. */
  reset(): void {
    this.lastStale = null;
    this.externalShown = false;
    this.forced = false;
  }

  /** The reading to deliver now, or undefined when nothing is due. */
  reading(step: number, sinceReview: number | null, notebook: Notebook, externalCompaction: boolean): StatusReading | undefined {
    const stale = isStale(step, sinceReview, notebook);
    let staleStep: number | null = null;
    let staleDue = false;
    if (step > 0 && sinceReview !== null) {
      const s = Math.max(0, Math.floor(sinceReview / step));
      const min = notebook.revision === 0 ? 0 : 1;
      if (s >= min) {
        staleStep = s;
        staleDue = this.lastStale === null || this.lastStale.entryId !== notebook.entryId || this.lastStale.step !== s;
      }
    } else if (notebook.revision === 0 && (this.lastStale === null || this.lastStale.entryId !== notebook.entryId)) {
      // No notes and usage unknown: still nudge once.
      staleStep = 0;
      staleDue = true;
    }
    const externalDue = externalCompaction && !this.externalShown;
    if (!this.forced && !staleDue && !externalDue) return undefined;
    return { stale, branchChanged: this.forced, externalCompaction: externalDue, staleStep: staleDue ? staleStep : null };
  }

  confirm(reading: StatusReading, notebook: Notebook): void {
    if (reading.branchChanged) this.forced = false;
    if (reading.externalCompaction) this.externalShown = true;
    if (reading.staleStep !== null) this.lastStale = { entryId: notebook.entryId, step: reading.staleStep };
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
