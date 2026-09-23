import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ToolCall } from "@earendil-works/pi-ai";
import { currentWindow, indexBranch, list, read, renderRead, ROLLOVER_DETAILS_KIND, search } from "../src/history.ts";
import { NOTEBOOK_ENTRY_TYPE } from "../src/notebook.ts";

const ts = "2026-09-10T00:00:00.000Z";
const base = (id: string) => ({ id, parentId: null, timestamp: ts });

const user = (id: string, text: string): SessionEntry => ({ ...base(id), type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } });
const assistant = (id: string, text: string, call?: { name: string; args: unknown }): SessionEntry => ({
  ...base(id),
  type: "message",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "SECRET-THOUGHT" },
      { type: "text", text },
      ...(call ? [{ type: "toolCall" as const, id: "c1", name: call.name, arguments: call.args as ToolCall["arguments"] }] : []),
    ],
    api: "openai-responses",
    provider: "p",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  },
});
const toolResult = (id: string, toolName: string, text: string): SessionEntry => ({
  ...base(id),
  type: "message",
  message: { role: "toolResult", toolCallId: "c1", toolName, content: [{ type: "text", text }], isError: false, timestamp: 0 },
});
const bash = (id: string, command: string, output: string, exclude = false): SessionEntry => ({
  ...base(id),
  type: "message",
  message: { role: "bashExecution", command, output, exitCode: 0, cancelled: false, truncated: false, timestamp: 0, excludeFromContext: exclude },
});
const rollover = (id: string): SessionEntry => ({ ...base(id), type: "compaction", summary: "Context window #2 started", firstKeptEntryId: "x", tokensBefore: 1, details: { kind: ROLLOVER_DETAILS_KIND } });
const plainCompaction = (id: string): SessionEntry => ({ ...base(id), type: "compaction", summary: "LLM summary", firstKeptEntryId: "x", tokensBefore: 1 });
const custom = (id: string, customType: string, data: unknown): SessionEntry => ({ ...base(id), type: "custom", customType, data });

describe("indexBranch allowlist", () => {
  test("includes user/assistant/tool/bash/compaction/notebook and excludes the rest", () => {
    const branch: SessionEntry[] = [
      user("u1", "fix the parser"),
      assistant("a1", "reading", { name: "read", args: { path: "src/p.ts" } }),
      toolResult("t1", "read", "file contents"),
      bash("b1", "ls", "a b c"),
      bash("b2", "cat secret", "TOPSECRET", true),
      custom("n1", NOTEBOOK_ENTRY_TYPE, { version: 1, revision: 1, sections: { Task: "parser" }, reviewedThrough: null }),
      custom("o1", "other-ext/state", { token: "PRIVATE" }),
      toolResult("h1", "history", "history results should not be indexed"),
      plainCompaction("c1"),
    ];
    const items = indexBranch(branch);
    const ids = items.map((i) => i.id);
    expect(ids).toEqual(["u1", "a1", "t1", "b1", "n1", "c1"]);
    const all = items.map((i) => i.text).join("\n");
    expect(all).not.toContain("SECRET-THOUGHT");
    expect(all).not.toContain("TOPSECRET");
    expect(all).not.toContain("PRIVATE");
    expect(all).toContain('read({"path":"src/p.ts"})');
  });

  test("window numbers advance only at this plugin's rollover compactions", () => {
    const branch: SessionEntry[] = [user("u1", "a"), plainCompaction("c1"), user("u2", "b"), rollover("r1"), user("u3", "c")];
    const items = indexBranch(branch);
    expect(items.map((i) => [i.id, i.window])).toEqual([["u1", 1], ["c1", 1], ["u2", 1], ["r1", 1], ["u3", 2]]);
    expect(currentWindow(branch)).toBe(2);
  });
});

describe("queries", () => {
  const branch: SessionEntry[] = [
    user("u1", "please fix parseComment nesting"),
    toolResult("t1", "read", "function parseComment() { /* depth counter missing */ }"),
    rollover("r1"),
    user("u2", "now add tests for parseComment"),
  ];
  const items = indexBranch(branch);

  test("search is literal, chronological, window-filterable, and reports extra matches", () => {
    const all = search(items, { query: "parseComment" });
    expect(all.hits.map((h) => h.id)).toEqual(["u1", "t1", "u2"]);
    const w1 = search(items, { query: "parseComment", window: 1 });
    expect(w1.hits.map((h) => h.id)).toEqual(["u1", "t1"]);
    expect(w1.scanned).toBe(3); // u1, t1, r1
    const limited = search(items, { query: "parseComment", limit: 1 });
    expect(limited.truncated).toBe(true);
  });

  test("read returns neighbours so a tool result arrives with its context", () => {
    const r = read(items, "t1", 1);
    expect(r?.before.map((i) => i.id)).toEqual(["u1"]);
    expect(r?.after.map((i) => i.id)).toEqual(["r1"]);
    expect(read(items, "nope")).toBeNull();
  });

  test("long tool-call arguments are fully indexed and long entries page by character offset", () => {
    const longArg = `${"a".repeat(1000)}UNIQUE_TAIL`;
    const b: SessionEntry[] = [
      { ...base("a9"), type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c9", name: "write", arguments: { path: "f", content: longArg } }], api: "x", provider: "p", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 0 } },
      toolResult("t9", "write", "y".repeat(16_000)),
    ];
    const its = indexBranch(b);
    expect(search(its, { query: "UNIQUE_TAIL" }).hits.map((h) => h.id)).toEqual(["a9"]);
    const r = read(its, "t9", 0)!;
    const page1 = renderRead(r, { offset: 0, maxChars: 12_000 });
    const page2 = renderRead(r, { offset: 12_000, maxChars: 12_000 });
    expect(page1).toContain("chars 0–12000 of 16000");
    expect(page1).toContain('offset: 12000');
    expect(page2).toContain("chars 12000–16000 of 16000");
    expect(page2).not.toContain("more chars");
    // search pagination
    const many: SessionEntry[] = Array.from({ length: 5 }, (_, i) => user(`m${i}`, "needle"));
    const p2 = search(indexBranch(many), { query: "needle", limit: 2, offset: 2 });
    expect(p2.hits.map((h) => h.id)).toEqual(["m2", "m3"]);
    expect(p2.truncated).toBe(true);
  });

  test("list paginates and filters by window", () => {
    const p = list(items, { limit: 2 });
    expect(p.items.map((i) => i.id)).toEqual(["u1", "t1"]);
    expect(p.total).toBe(4);
    const w2 = list(items, { window: 2 });
    expect(w2.items.map((i) => i.id)).toEqual(["u2"]);
  });
});
