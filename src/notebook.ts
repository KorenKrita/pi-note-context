/**
 * Notebook model: sectioned working notes, atomic multi-section replace,
 * dual size ceiling, reconstruction from a session branch.
 *
 * Pure module: no Pi imports. Journal entry shape is defined here so the
 * reconstruction logic and the writer agree on one contract.
 */

export const NOTEBOOK_ENTRY_TYPE = "note-context/notebook";
export const NOTEBOOK_VERSION = 1;

export const CANONICAL_SECTIONS = ["Task", "State", "Decisions", "Next", "Refs"] as const;
export const MAX_SECTIONS = 8;

export interface NotebookLimits {
  maxBytes: number;
  maxTokens: number;
}

export const DEFAULT_LIMITS: NotebookLimits = { maxBytes: 16_384, maxTokens: 4_096 };

/** Persisted payload of one notebook revision (journal `custom` entry data). */
export interface NotebookRecord {
  version: typeof NOTEBOOK_VERSION;
  revision: number;
  /** Section name → text. Insertion order is display order. */
  sections: Record<string, string>;
  /** Journal id of the assistant message that issued this write or review. */
  reviewedThrough: string | null;
  /** True when this record was produced by `reviewed: true` (no content change). */
  reviewOnly?: boolean;
  /** Context tokens at the time of this write/review; the status line reads staleness as tokens added since. Absent on records written before this field existed. */
  reviewedTokens?: number | null;
}

export interface Notebook {
  revision: number;
  sections: Record<string, string>;
  reviewedThrough: string | null;
  /** Context tokens when the notebook was last written/reviewed; null when unknown. */
  reviewedTokens: number | null;
  /** Journal id of the custom entry holding this revision; null for the empty notebook. */
  entryId: string | null;
}

export const EMPTY_NOTEBOOK: Notebook = { revision: 0, sections: {}, reviewedThrough: null, reviewedTokens: null, entryId: null };

export interface SizeReport {
  bytes: number;
  tokensEstimate: number;
}

/** Conservative token estimate: ~3.5 chars/token for mixed prose+code, CJK counted at 1 token/char. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x3000 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff)) cjk++;
  }
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 3.5);
}

export function renderNotebook(sections: Record<string, string>): string {
  const parts: string[] = [];
  for (const [name, text] of Object.entries(sections)) {
    parts.push(`## ${name}\n${text.trimEnd()}`);
  }
  return parts.join("\n\n");
}

export function measure(sections: Record<string, string>): SizeReport {
  const text = renderNotebook(sections);
  return { bytes: Buffer.byteLength(text, "utf8"), tokensEstimate: estimateTokens(text) };
}

export type ApplyResult =
  | { ok: true; sections: Record<string, string>; size: SizeReport; changed: boolean; merged: string[] }
  | { ok: false; reason: "too_large" | "empty_result" | "invalid_section_name"; detail: string; size?: SizeReport };

export interface ApplyInput {
  sections: Record<string, string>;
  replaceAll?: boolean;
}

/** Starts with a letter (any script), then letters/digits/marks/space/_/-; ≤32 code points; single line so it renders as a heading. */
const SECTION_NAME = /^\p{L}[\p{L}\p{N}\p{M} _-]{0,31}$/u;

/**
 * Atomically apply a section map to the current sections.
 * - `""` deletes a section.
 * - `replaceAll` discards sections not present in the input.
 * Never mutates the input; never partially applies.
 */
export function applySections(current: Record<string, string>, input: ApplyInput, limits: NotebookLimits = DEFAULT_LIMITS): ApplyResult {
  for (const name of Object.keys(input.sections)) {
    if (!SECTION_NAME.test(name)) {
      return { ok: false, reason: "invalid_section_name", detail: `section name "${name}" must match ${SECTION_NAME}` };
    }
  }
  const next: Record<string, string> = Object.assign(Object.create(null), input.replaceAll ? {} : current);
  for (const [name, text] of Object.entries(input.sections)) {
    const trimmed = text.trim();
    // A name that is not a section may have been folded into State earlier: deleting or
    // rewriting it replaces those lines instead of leaving them behind.
    if (!Object.hasOwn(next, name)) stripFolded(next, name);
    if (trimmed.length === 0) delete next[name];
    else next[name] = trimmed;
  }
  const names = Object.keys(next);
  if (names.length === 0) {
    return { ok: false, reason: "empty_result", detail: "the write would leave the notebook empty; use a non-empty section or keep the previous revision" };
  }
  const merged = foldOverflow(next);
  const size = measure(next);
  if (size.bytes > limits.maxBytes || size.tokensEstimate > limits.maxTokens) {
    const overBytes = Math.max(0, size.bytes - limits.maxBytes);
    const overTokens = Math.max(0, size.tokensEstimate - limits.maxTokens);
    return {
      ok: false,
      reason: "too_large",
      size,
      detail: `notebook would be ${size.bytes} bytes / ~${size.tokensEstimate} tokens; limit ${limits.maxBytes} bytes / ${limits.maxTokens} tokens (over by ${overBytes} bytes / ${overTokens} tokens). Previous revision kept. Prune and add in one call.`,
    };
  }
  const ordered = orderSections(next);
  if (Object.keys(ordered).length !== Object.keys(next).length) {
    return { ok: false, reason: "invalid_section_name", detail: "a section name collided during ordering; choose a different name" };
  }
  const changed = !sameSections(current, ordered);
  return { ok: true, sections: ordered, size, changed, merged };
}

function sameSections(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!Object.hasOwn(b, k) || a[k] !== b[k]) return false;
  return true;
}

/**
 * Keep the write instead of rejecting it when it exceeds MAX_SECTIONS: custom sections past the
 * cap, in canonical-then-insertion order, become `Name: text` lines appended to State. Mutates
 * `sections`; returns the folded names.
 */
function foldOverflow(sections: Record<string, string>): string[] {
  const ordered = Object.keys(orderSections(sections));
  if (ordered.length <= MAX_SECTIONS) return [];
  const keep = Object.hasOwn(sections, "State") ? MAX_SECTIONS : MAX_SECTIONS - 1;
  const folded = ordered.slice(keep).filter((name) => !(CANONICAL_SECTIONS as readonly string[]).includes(name));
  // Every line carries the prefix, so a folded fence or `## ` line cannot open a block or a heading.
  const lines = folded.flatMap((name) => sections[name]!.split(/\r\n|\r|\n/).map((line) => `${name}: ${line}`));
  sections["State"] = [sections["State"], ...lines].filter(Boolean).join("\n");
  for (const name of folded) delete sections[name];
  return folded;
}

function stripFolded(sections: Record<string, string>, name: string): void {
  const state = sections["State"];
  if (state === undefined) return;
  const prefix = `${name}: `;
  const kept = state.split("\n").filter((line) => !line.startsWith(prefix)).join("\n").trim();
  if (kept === state) return;
  if (kept.length === 0) delete sections["State"];
  else sections["State"] = kept;
}

/** Canonical sections first in canonical order, then custom sections in insertion order. */
export function orderSections(sections: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const name of CANONICAL_SECTIONS) {
    if (Object.hasOwn(sections, name)) out[name] = sections[name]!;
  }
  for (const [name, v] of Object.entries(sections)) {
    if (!Object.hasOwn(out, name)) out[name] = v;
  }
  return out;
}

/** Minimal structural view of a journal entry, so this module stays Pi-free. */
export interface BranchEntryLike {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
}

export function isNotebookRecord(data: unknown): data is NotebookRecord {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (d["version"] !== NOTEBOOK_VERSION) return false;
  if (typeof d["revision"] !== "number") return false;
  if (!d["sections"] || typeof d["sections"] !== "object" || Array.isArray(d["sections"])) return false;
  for (const v of Object.values(d["sections"] as Record<string, unknown>)) if (typeof v !== "string") return false;
  if (d["reviewedThrough"] !== null && typeof d["reviewedThrough"] !== "string") return false;
  if (d["reviewedTokens"] !== undefined && d["reviewedTokens"] !== null && typeof d["reviewedTokens"] !== "number") return false;
  return true;
}

/**
 * Latest valid notebook on the given branch (root → leaf order).
 * Invalid records are skipped so a malformed entry cannot mask an earlier valid one.
 */
export function reconstructNotebook(branch: readonly BranchEntryLike[]): Notebook {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.type !== "custom" || e.customType !== NOTEBOOK_ENTRY_TYPE) continue;
    if (!isNotebookRecord(e.data)) continue;
    return {
      revision: e.data.revision,
      sections: orderSections(Object.assign(Object.create(null), e.data.sections)),
      reviewedThrough: e.data.reviewedThrough,
      reviewedTokens: typeof e.data.reviewedTokens === "number" ? e.data.reviewedTokens : null,
      entryId: e.id,
    };
  }
  return EMPTY_NOTEBOOK;
}

export function makeRecord(
  prev: Notebook,
  sections: Record<string, string>,
  reviewedThrough: string | null,
  reviewOnly = false,
  reviewedTokens: number | null = null,
): NotebookRecord {
  return { version: NOTEBOOK_VERSION, revision: prev.revision + 1, sections, reviewedThrough, reviewedTokens, ...(reviewOnly ? { reviewOnly: true } : {}) };
}
