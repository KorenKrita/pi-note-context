/**
 * Entry-id trailers (DESIGN.md §4.3): append `[history entry=<id>]` to
 * model-visible user/toolResult messages that already have a persisted
 * journal id. Messages are matched to journal entries by (role, timestamp,
 * toolCallId) — the fields Pi preserves verbatim from journal to context.
 *
 * Assistant messages are left untouched (signed reasoning blocks must not be
 * rewritten). Structured non-text blocks are preserved; the trailer is a
 * separate text block.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const TRAILER_RE = /^\[history entry=([A-Za-z0-9_-]+)\]$/;

export function trailerFor(id: string): string {
  return `[history entry=${id}]`;
}

interface Key {
  role: string;
  timestamp: number;
  toolCallId?: string;
}

function keyOf(m: { role: string; timestamp?: number; toolCallId?: string }): string {
  return `${m.role}|${m.timestamp ?? ""}|${m.toolCallId ?? ""}`;
}

export function buildIdIndex(branch: readonly SessionEntry[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const e of branch) {
    if (e.type !== "message") continue;
    const m = e.message as Key;
    if (m.role !== "user" && m.role !== "toolResult") continue;
    idx.set(keyOf(m), e.id);
  }
  return idx;
}

const TRAILER_TAIL_RE = /\n\[history entry=([A-Za-z0-9_-]+)\]$/;

function lastTextIndex(content: readonly { type: string; text?: string }[]): number {
  for (let i = content.length - 1; i >= 0; i--) if (content[i]!.type === "text") return i;
  return -1;
}

function hasTrailer(content: readonly { type: string; text?: string }[]): boolean {
  const i = lastTextIndex(content);
  return i >= 0 && TRAILER_TAIL_RE.test(content[i]!.text ?? "");
}

/**
 * Returns a new array; untouched messages are the same object references (cache-friendly).
 * The trailer is appended to the *last text block* rather than added as a new block, so
 * extensions that classify tool results by block shape (e.g. SoL-Pi ObservationPack's
 * "every block is text") see the same shape, and a later projection that replaces the
 * content wholesale (a placeholder) can be re-tagged by running this again after it.
 */
export function addTrailers(messages: readonly AgentMessage[], idIndex: ReadonlyMap<string, string>): AgentMessage[] {
  return messages.map((m) => {
    if (m.role !== "user" && m.role !== "toolResult") return m;
    const id = idIndex.get(keyOf(m as Key));
    if (!id) return m;
    if (typeof m.content === "string") {
      return { ...m, content: [{ type: "text", text: `${m.content}\n${trailerFor(id)}` }] } as AgentMessage;
    }
    if (hasTrailer(m.content)) return m;
    const i = lastTextIndex(m.content);
    if (i < 0) return { ...m, content: [...m.content, { type: "text", text: trailerFor(id) }] } as AgentMessage;
    const content = m.content.slice();
    const block = content[i] as { type: "text"; text: string };
    content[i] = { ...block, text: `${block.text}\n${trailerFor(id)}` };
    return { ...m, content } as AgentMessage;
  });
}
