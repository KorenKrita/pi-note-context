/**
 * History index: allowlisted, read-only view of the current branch's journal,
 * including entries that left the model context after a rollover.
 *
 * Allowlist (DESIGN.md §3.3): user, assistant (text + tool-call args),
 * toolResult, compaction summaries, branch summaries, this plugin's own
 * notebook and rollover entries. Excluded: bashExecution with
 * excludeFromContext, other extensions' custom entries and custom messages,
 * provider-opaque state, and calls/results of the `history` tool itself.
 */

import type { SessionEntry, SessionProjection } from "@earendil-works/pi-coding-agent";
import { isNotebookRecord, NOTEBOOK_ENTRY_TYPE, renderNotebook } from "./notebook.ts";

export const ROLLOVER_DETAILS_KIND = "note-context/rollover";
export const HISTORY_TOOL_NAME = "history";

export type HistoryRole = "user" | "assistant" | "tool" | "compaction" | "branch_summary" | "notebook" | "bash";

export interface HistoryItem {
  id: string;
  role: HistoryRole;
  /** 1-based window number the entry belongs to (windows are split by this plugin's rollover compactions). */
  window: number;
  timestamp: string;
  /** Full searchable text. */
  text: string;
  /** Short label: tool name, first line, etc. */
  label: string;
}

/** Builds the allowlisted index for a branch (root → leaf). */
export function indexBranch(branch: readonly SessionEntry[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  let window = 1;
  for (const e of branch) {
    const item = toItem(e, window);
    if (item) items.push(item);
    if (e.type === "compaction" && isRolloverDetails(e.details)) window++;
  }
  return items;
}

export function currentWindow(branch: readonly SessionEntry[]): number {
  let w = 1;
  for (const e of branch) if (e.type === "compaction" && isRolloverDetails(e.details)) w++;
  return w;
}

export function isRolloverDetails(details: unknown): details is { kind: typeof ROLLOVER_DETAILS_KIND } {
  return !!details && typeof details === "object" && (details as Record<string, unknown>)["kind"] === ROLLOVER_DETAILS_KIND;
}

function toItem(e: SessionEntry, window: number): HistoryItem | null {
  switch (e.type) {
    case "message": {
      const m = e.message;
      switch (m.role) {
        case "user": {
          const text = contentText(m.content);
          return { id: e.id, role: "user", window, timestamp: e.timestamp, text, label: firstLine(text) };
        }
        case "assistant": {
          const parts: string[] = [];
          for (const c of m.content) {
            if (c.type === "text") parts.push(c.text);
            // Indexing history queries makes each page add hits ahead of the next offset.
            else if (c.type === "toolCall" && c.name !== HISTORY_TOOL_NAME) parts.push(`${c.name}(${fullJson(c.arguments)})`);
            // thinking blocks intentionally excluded
          }
          const text = parts.join("\n");
          return { id: e.id, role: "assistant", window, timestamp: e.timestamp, text, label: firstLine(text) };
        }
        case "toolResult": {
          if (m.toolName === HISTORY_TOOL_NAME) return null;
          const text = contentText(m.content);
          return { id: e.id, role: "tool", window, timestamp: e.timestamp, text, label: `${m.toolName} result` };
        }
        case "bashExecution": {
          if (m.excludeFromContext) return null;
          const text = `$ ${m.command}\n${m.output}`;
          return { id: e.id, role: "bash", window, timestamp: e.timestamp, text, label: `$ ${firstLine(m.command)}` };
        }
        default:
          // custom / branchSummary / compactionSummary as *messages* are not journal-primary; skip.
          return null;
      }
    }
    case "compaction":
      return { id: e.id, role: "compaction", window, timestamp: e.timestamp, text: e.summary, label: isRolloverDetails(e.details) ? "rollover" : "compaction summary" };
    case "branch_summary":
      return { id: e.id, role: "branch_summary", window, timestamp: e.timestamp, text: e.summary, label: "branch summary" };
    case "custom": {
      if (e.customType !== NOTEBOOK_ENTRY_TYPE || !isNotebookRecord(e.data)) return null;
      const text = renderNotebook(e.data.sections);
      return { id: e.id, role: "notebook", window, timestamp: e.timestamp, text, label: `notebook rev ${e.data.revision}` };
    }
    default:
      return null;
  }
}

/** IDs whose full indexed text appears in Pi's canonical session projection (not a visibility guarantee).
 * Plain notebook records and omitted/replaced context-edit targets are not assumed visible.
 * Request-local transformations by other extensions are outside this projection.
 */
export function activeHistoryIds(projection: SessionProjection): Set<string> {
  const ids = new Set<string>();
  for (const { sourceEntry, messages } of projection.entries) {
    const item = toItem(sourceEntry, 1);
    if (!item || messages.length === 0) continue;
    if (sourceEntry.type === "message") {
      const visible = messages.map((message) => toItem({ ...sourceEntry, message }, 1)?.text ?? "").join("\n");
      if (visible.includes(item.text)) ids.add(item.id);
    } else if (sourceEntry.type === "compaction" || sourceEntry.type === "branch_summary") {
      ids.add(item.id);
    }
  }
  return ids;
}

function contentText(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n");
}

/**
 * A cut index that does not fall inside a UTF-16 surrogate pair: moved back one
 * unit when it would split one. A lone surrogate in text sent to a provider
 * breaks strict JSON consumers, and the rollover summary is persisted.
 */
export function cutAt(s: string, i: number): number {
  const c = s.charCodeAt(i - 1);
  return i > 0 && i < s.length && c >= 0xd800 && c <= 0xdbff ? i - 1 : i;
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > 120 ? `${line.slice(0, cutAt(line, 117))}…` : line;
}

function fullJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "[unserializable]";
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** A literal phrase, or an array of literal phrases matched with OR; case-insensitive. */
  query: string | string[];
  /** Direction within each priority group. Default oldest for backward compatibility. */
  from?: "oldest" | "newest";
  /** Internal projection-derived exclusion set; used only for explicit includeActive:false. */
  activeIds?: ReadonlySet<string>;
  window?: number;
  limit?: number;
  /** Number of matching entries to skip (pagination). */
  offset?: number;
  snippetChars?: number;
}

export interface SearchHit {
  id: string;
  role: HistoryRole;
  window: number;
  label: string;
  snippet: string;
  /** Number of additional matches in the same item beyond the first shown. */
  moreMatches: number;
}

export interface SearchResult {
  hits: SearchHit[];
  scanned: number;
  skippedActive: number;
  truncated: boolean;
}

export function search(items: readonly HistoryItem[], opts: SearchOptions): SearchResult {
  const limit = opts.limit ?? 20;
  const snip = opts.snippetChars ?? 240;
  const queries = typeof opts.query === "string" ? [opts.query] : opts.query;
  if (queries.length === 0 || queries.some((q) => q.length === 0)) throw new Error("history: query must be a non-empty string or an array of non-empty strings.");
  // Escape every alternative: OR is array syntax, never a regex or whitespace operator.
  // Unicode case-insensitive matching keeps offsets in the original text (lowercasing can change its length).
  const pattern = new RegExp(queries.map((q) => q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu");
  const groups: [HistoryItem[], HistoryItem[]] = [[], []];
  let scanned = 0;
  let skippedActive = 0;
  for (const it of items) {
    if (opts.window !== undefined && it.window !== opts.window) continue;
    scanned++;
    pattern.lastIndex = 0;
    if (!pattern.test(it.text)) continue;
    if (opts.activeIds?.has(it.id)) {
      skippedActive++;
      continue;
    }
    const secondary = it.role === "notebook" || it.role === "compaction" || it.role === "branch_summary";
    groups[secondary ? 1 : 0].push(it);
  }
  if (opts.from === "newest") for (const group of groups) group.reverse();
  const ranked = groups.flat();
  const offset = Math.max(0, opts.offset ?? 0);
  const hits = ranked.slice(offset, offset + limit).map((it): SearchHit => {
    pattern.lastIndex = 0;
    const first = pattern.exec(it.text)!;
    let more = 0;
    while (pattern.exec(it.text)) more++;
    return { id: it.id, role: it.role, window: it.window, label: it.label, snippet: snippetAround(it.text, first.index, first[0].length, snip), moreMatches: more };
  });
  return { hits, scanned, skippedActive, truncated: offset + hits.length < ranked.length };
}

function snippetAround(text: string, idx: number, len: number, width: number): string {
  const half = Math.max(0, Math.floor((width - len) / 2));
  const start = cutAt(text, Math.max(0, idx - half));
  const end = cutAt(text, Math.min(text.length, idx + len + half));
  const core = text.slice(start, end).replace(/\s+/g, " ");
  return `${start > 0 ? "…" : ""}${core}${end < text.length ? "…" : ""}`;
}

export interface ReadResult {
  target: HistoryItem;
  before: HistoryItem[];
  after: HistoryItem[];
}

export function read(items: readonly HistoryItem[], id: string, context = 1): ReadResult | null {
  const i = items.findIndex((it) => it.id === id);
  if (i < 0) return null;
  return {
    target: items[i]!,
    before: items.slice(Math.max(0, i - context), i),
    after: items.slice(i + 1, i + 1 + context),
  };
}

export interface ReadPage {
  /** Zero-based character offset into the target text. */
  offset: number;
  maxChars: number;
}

export interface ListOptions {
  window?: number;
  limit?: number;
  /** Offset from the start of the (filtered) list. */
  offset?: number;
}

export function list(items: readonly HistoryItem[], opts: ListOptions = {}): { items: HistoryItem[]; total: number; offset: number } {
  const filtered = opts.window === undefined ? items.slice() : items.filter((it) => it.window === opts.window);
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = opts.limit ?? 50;
  return { items: filtered.slice(offset, offset + limit), total: filtered.length, offset };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderSearch(r: SearchResult, opts: SearchOptions): string {
  const off = opts.offset ?? 0;
  const head = `history search ${JSON.stringify(opts.query)}${opts.window !== undefined ? ` window #${opts.window}` : ""}: ${r.hits.length} hit${r.hits.length === 1 ? "" : "s"}${off ? ` (from #${off + 1})` : ""} in ${r.scanned} entries (original content first; ${opts.from ?? "oldest"} first within each group)${r.truncated ? ` — more hits: repeat with offset: ${off + r.hits.length}` : ""}${r.skippedActive ? `\nSkipped ${r.skippedActive} matching entries present in Pi's canonical session projection (includeActive: false). Request-local extensions may hide their originals; includeActive: true searches them too.` : ""}`;
  if (r.hits.length === 0) return head;
  const lines = r.hits.map((h) => `- [history entry=${h.id}] w${h.window} ${h.role} · ${h.label}\n  ${h.snippet}${h.moreMatches ? ` (+${h.moreMatches} more)` : ""}`);
  return `${head}\n${lines.join("\n")}`;
}

export function renderRead(r: ReadResult, page: ReadPage): string {
  const parts: string[] = [];
  const t = r.target.text;
  const start = cutAt(t, Math.min(Math.max(0, page.offset), t.length));
  const end = cutAt(t, Math.min(t.length, start + page.maxChars));
  const neighbourBudget = Math.floor(page.maxChars / 4);
  if (start === 0) for (const b of r.before) parts.push(`--- before: [history entry=${b.id}] ${b.role} · ${b.label}\n${clip(b.text, neighbourBudget)}`);
  const range = t.length > page.maxChars ? ` · chars ${start}–${end} of ${t.length}` : "";
  parts.push(`=== [history entry=${r.target.id}] window #${r.target.window} ${r.target.role} · ${r.target.label} · ${r.target.timestamp}${range}\n${t.slice(start, end)}`);
  if (end < t.length) parts.push(`…[${t.length - end} more chars — continue with history({ id: "${r.target.id}", offset: ${end} })]`);
  if (end >= t.length) for (const a of r.after) parts.push(`--- after: [history entry=${a.id}] ${a.role} · ${a.label}\n${clip(a.text, neighbourBudget)}`);
  return parts.join("\n\n");
}

export function renderList(r: { items: HistoryItem[]; total: number; offset: number }, window?: number): string {
  const head = `history list${window !== undefined ? ` window #${window}` : ""}: showing ${r.offset + 1}–${r.offset + r.items.length} of ${r.total}`;
  const lines = r.items.map((it) => `- [history entry=${it.id}] w${it.window} ${it.role} · ${it.label}`);
  return [head, ...lines].join("\n");
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = cutAt(s, max);
  return `${s.slice(0, cut)}\n…[${s.length - cut} more chars; read this entry by id]`;
}
