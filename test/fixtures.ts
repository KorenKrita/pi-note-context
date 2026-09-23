import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ToolCall } from "@earendil-works/pi-ai";
import { ROLLOVER_DETAILS_KIND } from "../src/history.ts";
import { NOTEBOOK_ENTRY_TYPE } from "../src/notebook.ts";

let clock = 1_700_000_000_000;
const ts = () => new Date((clock += 1000)).toISOString();
const base = (id: string) => ({ id, parentId: null, timestamp: ts() });

export const user = (id: string, text: string): SessionEntry => ({
  ...base(id),
  type: "message",
  message: { role: "user", content: [{ type: "text", text }], timestamp: clock },
});

export const assistant = (id: string, text: string, calls: { id: string; name: string; args: Record<string, unknown> }[] = []): SessionEntry => ({
  ...base(id),
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "text", text }, ...calls.map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: c.args as ToolCall["arguments"] }))],
    api: "openai-responses",
    provider: "p",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: calls.length ? "toolUse" : "stop",
    timestamp: clock,
  },
});

export const toolResult = (id: string, toolCallId: string, toolName: string, text: string): SessionEntry => ({
  ...base(id),
  type: "message",
  message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: clock },
});

export const notebookEntry = (id: string, revision: number, sections: Record<string, string>, reviewedThrough: string | null): SessionEntry => ({
  ...base(id),
  type: "custom",
  customType: NOTEBOOK_ENTRY_TYPE,
  data: { version: 1, revision, sections, reviewedThrough },
});

export const rolloverEntry = (id: string, firstKeptEntryId: string, window: number): SessionEntry => ({
  ...base(id),
  type: "compaction",
  summary: `Context window #${window} started`,
  firstKeptEntryId,
  tokensBefore: 1,
  details: { kind: ROLLOVER_DETAILS_KIND, version: 1, window },
});

/** A tool round: assistant call + big result, ~`kb` KB of text. */
export function round(n: number, kb: number): SessionEntry[] {
  return [assistant(`a${n}`, `step ${n}`, [{ id: `c${n}`, name: "read", args: { path: `f${n}.ts` } }]), toolResult(`t${n}`, `c${n}`, "read", "x".repeat(kb * 1024))];
}
