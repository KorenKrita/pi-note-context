/**
 * Rollover: deterministic compaction summary with the notebook snapshot and
 * pinned user messages embedded (DESIGN.md §5). Pure module: given branch +
 * cut point + notebook, produce the summary text and details.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ROLLOVER_DETAILS_KIND } from "./history.ts";
import { renderNotebook, type Notebook } from "./notebook.ts";

export type RolloverReason = "model" | "user" | "host" | "threshold" | "fallback";

export interface RolloverDetails {
  kind: typeof ROLLOVER_DETAILS_KIND;
  version: 1;
  window: number;
  reason: RolloverReason;
  notebookRevision: number;
  notebookEntryId: string | null;
  pinned: string[];
}

export interface PinOptions {
  messageMaxChars: number;
  totalMaxTokens: number;
}

export const DEFAULT_PIN: PinOptions = { messageMaxChars: 600, totalMaxTokens: 4096 };

interface Pinned {
  id: string;
  text: string;
  truncated: boolean;
}

function userText(e: SessionEntry): string | null {
  if (e.type !== "message" || e.message.role !== "user") return null;
  const c = e.message.content;
  if (typeof c === "string") return c;
  return c.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n");
}

/**
 * Active-context entries that the next compaction will drop: everything in the
 * compaction-aware context (`buildContextEntries()`) before `firstKeptEntryId`,
 * excluding the leading compaction entry itself. This includes the previous
 * compaction's retained tail, which Pi keeps in view and will drop next.
 */
export function droppedRange(context: readonly SessionEntry[], firstKeptEntryId: string): SessionEntry[] {
  const cut = context.findIndex((e) => e.id === firstKeptEntryId);
  if (cut < 0) return [];
  const start = context[0]?.type === "compaction" ? 1 : 0;
  return context.slice(start, cut);
}

/**
 * Mechanical pinning (DESIGN.md §5 step 2): first user message verbatim, later
 * ones truncated to messageMaxChars; when the total budget is exceeded, the
 * first keeps full text and the rest keep first line + id.
 */
export function pinUserMessages(dropped: readonly SessionEntry[], opts: PinOptions = DEFAULT_PIN): Pinned[] {
  const users = dropped.map((e) => ({ id: e.id, text: userText(e) })).filter((x): x is { id: string; text: string } => x.text !== null && x.text.trim().length > 0);
  if (users.length === 0) return [];
  const out: Pinned[] = [];
  const first = users[0]!;
  out.push({ id: first.id, text: first.text, truncated: false });
  for (const u of users.slice(1)) {
    const t = u.text.length > opts.messageMaxChars ? `${u.text.slice(0, opts.messageMaxChars)}…` : u.text;
    out.push({ id: u.id, text: t, truncated: t !== u.text });
  }
  const budgetChars = opts.totalMaxTokens * 3.5;
  let total = out.reduce((n, p) => n + p.text.length, 0);
  if (total > budgetChars) {
    for (let i = out.length - 1; i >= 1 && total > budgetChars; i--) {
      const p = out[i]!;
      const line = p.text.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "";
      total -= p.text.length - line.length;
      out[i] = { id: p.id, text: line, truncated: true };
    }
  }
  return out;
}

export interface SummaryInput {
  window: number; // the window being *started*
  reason: RolloverReason;
  notebook: Notebook;
  pinned: Pinned[];
}

export function renderRolloverSummary(s: SummaryInput): string {
  const lines: string[] = [];
  lines.push(`Context window #${s.window} started (previous #${s.window - 1}, rollover reason: ${s.reason}).`);
  lines.push("The raw transcript before this point remains in the session and is readable with `history`.");
  lines.push("");
  lines.push(`## Notebook (revision ${s.notebook.revision}${s.notebook.reviewedThrough ? `, reviewed through entry ${s.notebook.reviewedThrough}` : ""})`);
  lines.push(renderNotebook(s.notebook.sections));
  if (s.pinned.length > 0) {
    lines.push("");
    lines.push("## Task context preserved from earlier in this window (historical; already acted on — do not re-execute)");
    for (const p of s.pinned) {
      lines.push(`[history entry=${p.id}] user: ${p.text}${p.truncated ? " [truncated; read with history]" : ""}`);
    }
  }
  lines.push("");
  lines.push("Continue with the notebook's Next action. Retrieve detail with `history` only when a specific fact is missing.");
  return lines.join("\n");
}

export function makeDetails(window: number, reason: RolloverReason, notebook: Notebook, pinned: Pinned[]): RolloverDetails {
  return { kind: ROLLOVER_DETAILS_KIND, version: 1, window, reason, notebookRevision: notebook.revision, notebookEntryId: notebook.entryId, pinned: pinned.map((p) => p.id) };
}
