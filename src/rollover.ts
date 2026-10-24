/**
 * Rollover: deterministic compaction summary with the notebook snapshot and
 * pinned user messages embedded (DESIGN.md §5). Pure module: given branch +
 * cut point + notebook, produce the summary text and details.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cutAt, isRolloverDetails, ROLLOVER_DETAILS_KIND } from "./history.ts";
import { estimateTokens, renderNotebook, type Notebook } from "./notebook.ts";
import type { UserKind } from "./jev.ts";

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
  /** Budget for the session-wide index of earlier user messages (one line each). */
  indexMaxTokens: number;
}

export const DEFAULT_PIN: PinOptions = { messageMaxChars: 600, totalMaxTokens: 4096, indexMaxTokens: 3072 };

export interface Pinned {
  id: string;
  text: string;
  truncated: boolean;
  kind?: UserKind | "notification";
}

export function userText(e: SessionEntry): string | null {
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

/** A delegated-task completion notification: `Delegated task <id> (<title>) [<status>]…`. */
const NOTIFICATION = /^Delegated task \S+ \((.+?)\) \[([a-z_]+)\]/;
const ACK_CONTEXT_CHARS = 300;
const SHORT_LINE_CHARS = 120;

function firstLine(text: string): string {
  const l = text.split("\n").find((x) => x.trim()) ?? "";
  return l.slice(0, cutAt(l, SHORT_LINE_CHARS));
}

function assistantText(e: SessionEntry): string | null {
  if (e.type !== "message" || e.message.role !== "assistant") return null;
  const t = e.message.content.map((p) => (p.type === "text" ? p.text : "")).join("\n").trim();
  return t || null;
}

/**
 * Pinning (DESIGN.md §5 step 2). The first user message stays verbatim. With Jev kinds:
 * decisions keep up to 4× messageMaxChars, approvals carry the tail of the assistant
 * text they answer, complaints shrink to their first line (questions do not: they often carry a proposal). Delegated-task
 * notifications are always one line. Unclassified messages fall back to messageMaxChars.
 * Over the total budget, messages collapse to their first line newest first (the mechanical rule): informational
 * and unclassified ones before approvals, decisions last; the first message never collapses.
 */
export function pinUserMessages(dropped: readonly SessionEntry[], opts: PinOptions = DEFAULT_PIN, kinds: ReadonlyMap<string, UserKind> = new Map()): Pinned[] {
  const out: Pinned[] = [];
  let lastAssistant: string | null = null;
  for (const e of dropped) {
    const a = assistantText(e);
    if (a) lastAssistant = a;
    const text = userText(e);
    if (text === null || !text.trim()) continue;
    const n = NOTIFICATION.exec(text.trimStart());
    if (n) {
      out.push({ id: e.id, text: `[subagent result] ${n[1]} [${n[2]}]`, truncated: true, kind: "notification" });
      continue;
    }
    const kind = kinds.get(e.id);
    if (out.every((p) => p.kind === "notification")) {
      out.push({ id: e.id, text, truncated: false, kind });
      continue;
    }
    if (kind === "vent") {
      const line = firstLine(text);
      out.push({ id: e.id, text: line, truncated: line !== text, kind });
      continue;
    }
    const max = kind === "decide" ? opts.messageMaxChars * 4 : opts.messageMaxChars;
    let t = text.length > max ? `${text.slice(0, cutAt(text, max))}…` : text;
    const truncated = t !== text;
    if (kind === "ack" && lastAssistant) {
      const tail = lastAssistant.length > ACK_CONTEXT_CHARS ? `…${lastAssistant.slice(lastAssistant.length - ACK_CONTEXT_CHARS)}` : lastAssistant;
      t += `\n  (answering assistant: ${tail.replace(/\s+/g, " ")})`;
    }
    out.push({ id: e.id, text: t, truncated, kind });
  }
  const budgetChars = opts.totalMaxTokens * 3.5;
  let total = out.reduce((n, p) => n + p.text.length, 0);
  const firstUser = out.findIndex((p) => p.kind !== "notification");
  const rank = (p: Pinned) => (p.kind === "decide" ? 2 : p.kind === "ack" ? 1 : 0);
  for (const tier of [0, 1, 2]) {
    for (let i = out.length - 1; i >= 0 && total > budgetChars; i--) {
      const p = out[i]!;
      if (i === firstUser || p.kind === "notification" || rank(p) !== tier) continue;
      const line = firstLine(p.text);
      total -= p.text.length - line.length;
      out[i] = { ...p, text: line, truncated: true };
    }
  }
  return out;
}

export interface Facts {
  files: string[];
  commits: string[];
  answers: string[];
}

const COMMIT_LINE = /^\[([^\]]+?)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gm;
const EDIT_RESULT_TOOLS = new Set(["replace", "replace_match", "insert", "edit", "write"]);
const MAX_FILES = 30;
const MAX_COMMITS = 20;
const MAX_ANSWERS = 10;

function shortPath(p: string): string {
  const home = process.env["HOME"];
  return home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function pushRecent(list: string[], item: string): void {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
  list.push(item);
}

/**
 * Facts the dropped range proves mechanically: files changed by edit tools, commits
 * in the output of bash calls that run git, and answers given through ask_user_question. A quiet
 * `git commit -q` prints nothing and is not seen.
 */
export function extractFacts(dropped: readonly SessionEntry[]): Facts {
  const files: string[] = [];
  const commits: string[] = [];
  const answers: string[] = [];
  const callPaths = new Map<string, string>();
  const gitCalls = new Set<string>();
  for (const e of dropped) {
    if (e.type !== "message") continue;
    const m = e.message;
    if (m.role === "assistant") {
      for (const p of m.content) {
        if (p.type === "toolCall" && typeof p.arguments?.["path"] === "string") callPaths.set(p.id, p.arguments["path"] as string);
        if (p.type === "toolCall" && p.name === "bash" && /\bgit\b/.test(String(p.arguments?.["command"] ?? ""))) gitCalls.add(p.id);
      }
      continue;
    }
    if (m.role !== "toolResult" || m.isError) continue;
    const details = (m.details ?? {}) as Record<string, unknown>;
    const text = m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    if (EDIT_RESULT_TOOLS.has(m.toolName)) {
      const snap = typeof details["snapshotId"] === "string" ? (details["snapshotId"] as string).split("|")[1] : undefined;
      const patch = typeof details["patch"] === "string" ? /^--- (.+)$/m.exec(details["patch"] as string)?.[1] : undefined;
      const path = snap ?? callPaths.get(m.toolCallId) ?? patch;
      if (path) pushRecent(files, shortPath(path));
    }
    if (gitCalls.has(m.toolCallId)) for (const c of text.matchAll(COMMIT_LINE)) pushRecent(commits, `${c[2]} ${c[3]} (${c[1]})`);
    if (m.toolName === "ask_user_question" && Array.isArray(details["answers"])) {
      for (const a of details["answers"] as { question?: unknown; answer?: unknown }[]) {
        if (typeof a.question === "string" && typeof a.answer === "string") answers.push(`${clip(a.question, 100)} → ${clip(a.answer, 100)}`);
      }
    }
  }
  return { files: files.slice(-MAX_FILES), commits: commits.slice(-MAX_COMMITS), answers: answers.slice(-MAX_ANSWERS) };
}

export interface IndexLine {
  id: string;
  window: number;
  text: string;
}

const INDEX_LINE_CHARS = 80;
const INDEX_SHORT_CHARS = 40;
/** Messages a host or orchestrator sends in the user role: indexed by kind only. */
const MACHINE_MESSAGES: [RegExp, string][] = [
  [/^Context handoff \(/, "[context handoff]"],
  [/^Delegated task \S+ (reached a terminal state|\(.+?\) \[[a-z_]+\])/, "[delegated task result]"],
];
/**
 * Pasted log/data lines: JSON records, structural lines and quoted scalars,
 * bracketed timestamps or levels, ISO or sub-second timestamps, indented stack
 * frames ending in a `file:line` position. Only counted as a paste when at least
 * two lines of a message match, so one prose line that happens to look like a
 * record keeps its words.
 */
const LOG_LINE = /^\s*(\{\s*("|$)|\[\{|[[\]{}]{1,2},?\s*$|"[^"\n]+"\s*:|"[^"\n]*",?\s*$|\[\d{4}-\d{2}-\d{2}|\[\d{1,2}:\d{2}:\d{2}|\[(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\]|\d{4}-\d{2}-\d{2}[T ]\d|\d{1,2}:\d{2}:\d{2}[.,]\d)|^\s+at\s.*:\d+\)?\s*$/i;
/** A fence opener at line start; a backtick opener's info string has no backticks (CommonMark). */
const FENCE_OPEN = /^\s*(?:(`{3,})[^`]*|(~{3,}).*)$/;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, cutAt(s, max))}…` : s;
}

/**
 * One index line for a user message: attachments, quotes, images, fenced code and
 * pasted log lines become a bounded set of counted tags; the first remaining line
 * of the user's own words follows, cut to maxChars. A paste-only message is left
 * with its tags alone.
 */
export function indexText(e: SessionEntry, maxChars: number = INDEX_LINE_CHARS): string | null {
  if (e.type !== "message" || e.message.role !== "user") return null;
  const c = e.message.content;
  const parts = typeof c === "string" ? [c] : c.map((p) => (p.type === "text" ? p.text : `[${p.type}]`));
  let t = parts.join("\n");
  for (const [re, tag] of MACHINE_MESSAGES) if (re.test(t.trimStart())) return tag;
  const files: string[] = [];
  let quotes = 0;
  let images = 0;
  let codeLines = -1; // -1: no fenced block seen
  t = t.replace(/<t3_context[\s\S]*?<\/t3_context>/g, "").replace(/\[Attachment saved at [^\]\n]*\]/g, "");
  t = t.replace(/\[File: ([^;\]\n]+)[^\]\n]*\]/g, (_m, name: string) => (files.push(name.trim()), ""));
  t = t.replace(/\[Assistant quote\]\([^)\s]*\)/g, () => (quotes++, ""));
  t = t.replace(/^\[image\]$/gm, () => (images++, ""));
  const rest: string[] = [];
  const all = t.split(/\r?\n/);
  for (let i = 0; i < all.length; i++) {
    const open = FENCE_OPEN.exec(all[i]!);
    if (!open) {
      if (all[i]!.trim()) rest.push(all[i]!);
      continue;
    }
    const fence = open[1] ?? open[2]!;
    const close = new RegExp(`^\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
    let j = i + 1;
    while (j < all.length && !close.test(all[j]!)) j++;
    codeLines = Math.max(codeLines, 0) + (j - i - 1);
    i = j; // past the closing fence, or the end for an unclosed block
  }
  const logLike = rest.filter((l) => LOG_LINE.test(l)).length;
  const isLog = (l: string) => logLike >= 2 && LOG_LINE.test(l);
  const count = (n: number, tag: string) => (n === 1 ? `[${tag}]` : `[${tag} ×${n}]`);
  const tags: string[] = [];
  if (files.length > 0) tags.push(`[file: ${clip(files[0]!, Math.floor(maxChars / 2))}${files.length > 1 ? ` +${files.length - 1} files` : ""}]`);
  if (images > 0) tags.push(count(images, "image"));
  if (quotes > 0) tags.push(count(quotes, "quote"));
  if (codeLines >= 0) tags.push(`[code ${codeLines} lines]`);
  if (logLike >= 2) tags.push(`[log ${logLike} lines]`);
  const head = rest.find((l) => !isLog(l))?.replace(/\s+/g, " ").trim() ?? "";
  const out = [...tags, clip(head, maxChars)].filter(Boolean).join(" ");
  return out || null;
}

/**
 * Session-wide index (DESIGN.md §5 step 3): every user message on the branch before
 * the cut that is not pinned in full, one line each with its window and id. Over
 * budget, lines shorten; still over, the oldest are dropped behind a count line.
 */
export function indexUserMessages(branch: readonly SessionEntry[], firstKeptEntryId: string | null | undefined, pinnedIds: ReadonlySet<string>, opts: PinOptions = DEFAULT_PIN): { lines: IndexLine[]; omitted: number } {
  const collect = (maxChars: number): IndexLine[] => {
    const out: IndexLine[] = [];
    let window = 1;
    for (const e of branch) {
      if (e.id === firstKeptEntryId) break;
      if (e.type === "compaction" && isRolloverDetails(e.details)) window++;
      if (pinnedIds.has(e.id)) continue;
      const text = indexText(e, maxChars);
      if (text) out.push({ id: e.id, window, text });
    }
    return out;
  };
  const costs = (ls: IndexLine[]) => ls.map((l) => estimateTokens(renderIndexLine(l)) + 1);
  let lines = collect(INDEX_LINE_CHARS);
  let cost = costs(lines);
  let total = cost.reduce((a, b) => a + b, 0);
  if (total > opts.indexMaxTokens) {
    lines = collect(INDEX_SHORT_CHARS);
    cost = costs(lines);
    total = cost.reduce((a, b) => a + b, 0);
  }
  // Drop the oldest until it fits; the newest line always stays (each line is bounded).
  let start = 0;
  while (start < lines.length - 1 && total > opts.indexMaxTokens) total -= cost[start++]!;
  return { lines: lines.slice(start), omitted: start };
}

function renderIndexLine(l: IndexLine): string {
  return `w${l.window} [history entry=${l.id}] ${l.text}`;
}

export interface SummaryInput {
  window: number; // the window being *started*
  reason: RolloverReason;
  notebook: Notebook;
  pinned: Pinned[];
  index?: { lines: IndexLine[]; omitted: number };
  facts?: Facts;
}

export function renderRolloverSummary(s: SummaryInput): string {
  const lines: string[] = [];
  lines.push(`Context window #${s.window} started (previous #${s.window - 1}, rollover reason: ${s.reason}).`);
  lines.push("The raw transcript before this point remains in the session and is readable with `history`.");
  lines.push("");
  lines.push(`## Notebook (revision ${s.notebook.revision}${s.notebook.reviewedThrough ? `, reviewed through entry ${s.notebook.reviewedThrough}` : ""})`);
  lines.push(renderNotebook(s.notebook.sections));
  if (s.index && (s.index.lines.length > 0 || s.index.omitted > 0)) {
    lines.push("");
    lines.push("## Earlier user messages in this session (index, oldest first; wN = window — a topic listed here was already worked on, read its entry before redoing it)");
    if (s.index.omitted > 0) lines.push(`(${s.index.omitted} older user messages not listed; \`history({ list: true })\` shows them)`);
    for (const l of s.index.lines) lines.push(renderIndexLine(l));
  }
  const facts = s.facts;
  if (facts && (facts.files.length > 0 || facts.commits.length > 0 || facts.answers.length > 0)) {
    lines.push("");
    lines.push("## Facts from the dropped range (mechanical; verify current state before relying on them)");
    if (facts.files.length > 0) lines.push(`Files edited: ${facts.files.join(", ")}`);
    for (const c of facts.commits) lines.push(`Commit: ${c}`);
    for (const a of facts.answers) lines.push(`User answered: ${a}`);
  }
  if (s.pinned.length > 0) {
    lines.push("");
    lines.push("## Task context preserved from earlier in this window (historical; already acted on — do not re-execute)");
    for (const p of s.pinned) {
      lines.push(`[history entry=${p.id}] user: ${p.text}${p.truncated ? " [truncated; read with history]" : ""}`);
    }
  }
  lines.push("");
  lines.push("Continue with the notebook's Next action. Before investigating, evaluating or recommending something, check `history` for an earlier result on that topic (an entry from the index above, or a query on its key term) and build on it instead of redoing the work.");
  return lines.join("\n");
}

export function makeDetails(window: number, reason: RolloverReason, notebook: Notebook, pinned: Pinned[]): RolloverDetails {
  return { kind: ROLLOVER_DETAILS_KIND, version: 1, window, reason, notebookRevision: notebook.revision, notebookEntryId: notebook.entryId, pinned: pinned.map((p) => p.id) };
}
