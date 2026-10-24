import { describe, expect, test } from "bun:test";
import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ToolCall } from "@earendil-works/pi-ai";
import { activeHistoryIds, currentWindow, cutAt, indexBranch, list, read, renderRead, renderSearch, ROLLOVER_DETAILS_KIND, search } from "../src/history.ts";
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

  test("history call blocks are not indexed, while assistant text and sibling tools remain", () => {
    const mixed = assistant("mixed", "original conclusion", { name: "history", args: { query: "query-only-marker" } });
    if (mixed.type === "message" && mixed.message.role === "assistant") mixed.message.content.push(
      { type: "toolCall", id: "c2", name: "read", arguments: { path: "sibling-marker.ts" } },
      { type: "toolCall", id: "c3", name: "history", arguments: { id: "history-id-only-marker" } },
    );
    const before = structuredClone(mixed);
    const items = indexBranch([mixed, assistant("pure", "", { name: "history", args: { query: "query-only-marker" } }), toolResult("result", "history", "result-only-marker")]);
    expect(search(items, { query: ["query-only-marker", "history-id-only-marker", "result-only-marker"] }).hits).toEqual([]);
    expect(search(items, { query: "original conclusion" }).hits.map((h) => h.id)).toEqual(["mixed"]);
    expect(search(items, { query: "sibling-marker" }).hits.map((h) => h.id)).toEqual(["mixed"]);
    expect(read(items, "mixed", 0)?.target.text).toBe('original conclusion\nread({"path":"sibling-marker.ts"})');
    expect(list(items).items.find((i) => i.id === "mixed")?.label).toBe("original conclusion");
    expect(mixed).toEqual(before); // journal remains intact
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

describe("search recall and ranking", () => {
  test("case-insensitive OR is literal, reports repeated matches, and preserves Unicode offsets", () => {
    const items = indexBranch([user("u1", "İ prefix JeV and jev"), user("u2", "ROLLOVER [x].*"), user("u3", "not xanything")]);
    const r = search(items, { query: ["jev", "[x].*"] });
    expect(r.hits.map((h) => h.id)).toEqual(["u1", "u2"]);
    expect(r.hits[0]!.moreMatches).toBe(1);
    expect(search(items, { query: "jev", snippetChars: 3 }).hits[0]!.snippet).toBe("…JeV…");
    expect(search(items, { query: "prefix JeV" }).hits.map((h) => h.id)).toEqual(["u1"]);
    expect(search(items, { query: "jev|rollover" }).hits).toEqual([]);
    expect(search(items, { query: ["jev", "JEV"] }).hits[0]!.moreMatches).toBe(1);
    for (const query of ["", [], ["Jev", ""]]) expect(() => search(items, { query })).toThrow("non-empty");
  });

  test("originals always precede revisions/summaries; direction, filtering and paging compose", () => {
    const items = indexBranch([
      custom("n1", NOTEBOOK_ENTRY_TYPE, { version: 1, revision: 1, sections: { Task: "needle" }, reviewedThrough: null }),
      user("u1", "Needle"),
      { ...rollover("r1"), summary: "needle" } as SessionEntry,
      user("u2", "NEEDLE"),
      { ...base("b1"), type: "branch_summary", summary: "needle", fromId: "u1" },
      custom("n2", NOTEBOOK_ENTRY_TYPE, { version: 1, revision: 2, sections: { Task: "needle" }, reviewedThrough: null }),
    ]);
    expect(search(items, { query: "needle" }).hits.map((h) => h.id)).toEqual(["u1", "u2", "n1", "r1", "b1", "n2"]);
    const opts = { query: "needle", from: "newest" as const, activeIds: new Set(["u2"]), limit: 2 };
    const p1 = search(items, opts);
    const p2 = search(items, { ...opts, offset: 2 });
    const p3 = search(items, { ...opts, offset: 4 });
    expect([...p1.hits, ...p2.hits, ...p3.hits].map((h) => h.id)).toEqual(["u1", "n2", "b1", "r1", "n1"]);
    expect(p1.skippedActive).toBe(1);
    expect(p1.truncated).toBe(true);
    expect(p3.truncated).toBe(false);
    expect(renderSearch(p1, opts)).toContain("offset: 2");
    expect(renderSearch(p1, opts)).toContain("Skipped 1 matching entries present in Pi's canonical session projection");
    expect(renderSearch(p1, opts)).toContain("Request-local extensions may hide their originals");
    expect(renderSearch(p1, opts)).not.toContain("already in your active context");
    expect(search(items, { ...opts, window: 2 }).hits.map((h) => h.id)).toEqual(["n2", "b1"]);
  });

  test("Pi projection excludes retained visible originals, not notebook state or context-edited originals", () => {
    const branch: SessionEntry[] = [
      user("old", "needle dropped"),
      user("kept", "needle retained"),
      user("edited", "needle replaced"),
      user("omitted", "needle hidden"),
      custom("n1", NOTEBOOK_ENTRY_TYPE, { version: 1, revision: 1, sections: { Task: "needle" }, reviewedThrough: null }),
      { ...rollover("r1"), firstKeptEntryId: "kept", summary: "needle summary" } as SessionEntry,
      { ...base("e1"), type: "context_edit", targetId: "edited", replacement: { content: "placeholder" } },
      { ...base("e2"), type: "context_edit", targetId: "omitted", replacement: null },
      user("new", "needle current"),
    ];
    const linked = branch.map((entry, i) => ({ ...entry, parentId: i ? branch[i - 1]!.id : null }));
    const activeIds = activeHistoryIds(buildSessionProjection(linked));
    expect([...activeIds]).toEqual(["r1", "kept", "new"]);
    const items = indexBranch(linked);
    const r = search(items, { query: "needle", activeIds });
    expect(r.hits.map((h) => h.id)).toEqual(["old", "edited", "omitted", "n1"]);
    expect(r.skippedActive).toBe(3);
    expect(read(items, "kept", 0)?.target.text).toBe("needle retained");
    expect(list(items).items.map((i) => i.id)).toContain("kept");
  });
});

describe("cuts never split a surrogate pair", () => {
  const lone = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

  test("cutAt moves back only from inside a pair", () => {
    const s = "ab😀c"; // 😀 occupies indices 2–3
    expect(cutAt(s, 3)).toBe(2);
    expect(cutAt(s, 2)).toBe(2);
    expect(cutAt(s, 4)).toBe(4);
    expect(cutAt(s, 0)).toBe(0);
    expect(cutAt(s, s.length)).toBe(s.length);
  });

  test("labels, search snippets and paged reads stay well formed", () => {
    const text = `${"x".repeat(116)}😀${"y".repeat(500)}NEEDLE${"z".repeat(117)}😀${"w".repeat(600)}`;
    const items = indexBranch([user("u1", text)]);
    expect(lone(items[0]!.label)).toBe(false);
    expect(lone(search(items, { query: "NEEDLE", snippetChars: 241 }).hits[0]!.snippet)).toBe(false);
    const r = read(items, "u1", 0)!;
    let offset = 0;
    let seen = "";
    for (let guard = 0; guard < 50; guard++) {
      const page = renderRead(r, { offset, maxChars: 117 });
      expect(lone(page)).toBe(false);
      const body = page.split("\n").slice(1).join("\n");
      const next = /offset: (\d+) \}\)\]$/.exec(page);
      seen += next ? body.slice(0, body.lastIndexOf("\n\n…[")) : body;
      if (!next) break;
      offset = Number(next[1]);
    }
    expect(seen).toBe(text); // pages tile the text exactly
  });
});
