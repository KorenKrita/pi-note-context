import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { step, zoneFor, type MaintenanceState } from "../src/maintenance.ts";
import { formatTokens, renderStatusLine, turnsSince } from "../src/status.ts";
import { addTrailers, buildIdIndex } from "../src/trailers.ts";
import { assistant, notebookEntry, toolResult, user } from "./fixtures.ts";
import { EMPTY_NOTEBOOK } from "../src/notebook.ts";

describe("maintenance state machine", () => {
  const T = { contextWindow: 200_000, reserveTokens: 16_384, leadTokens: 24_000, fallbackBufferTokens: 12_000 };
  test("zones: normal → reminder → fallback; null tokens is normal", () => {
    expect(zoneFor(null, T)).toBe("normal");
    expect(zoneFor(100_000, T)).toBe("normal");
    expect(zoneFor(200_000 - 16_384 - 24_000 + 1, T)).toBe("reminder");
    expect(zoneFor(200_000 - 16_384 - 12_000 + 1, T)).toBe("fallback");
  });

  test("enter → notes_ok with newer revision → compact_now; same revision does nothing", () => {
    let n = 0;
    let s: MaintenanceState = { kind: "idle" };
    const r1 = step(s, { type: "enter", notebookRevision: 3 }, () => ++n);
    expect(r1.action).toBe("steer_request");
    s = r1.state;
    const r2 = step(s, { type: "notes_ok", revision: 3 }, () => ++n);
    expect(r2.action).toBe("none");
    const r3 = step(s, { type: "notes_ok", revision: 4 }, () => ++n);
    expect(r3.action).toBe("compact_now");
    expect(r3.state.kind).toBe("checkpointed");
    // re-entering while checkpointed does nothing
    expect(step(r3.state, { type: "enter", notebookRevision: 4 }, () => ++n).action).toBe("none");
    expect(step(r3.state, { type: "rollover_done" }, () => ++n).state.kind).toBe("idle");
  });

  test("blocked non-notes calls are bounded: the third gives up", () => {
    let n = 0;
    let s = step({ kind: "idle" }, { type: "enter", notebookRevision: 1 }, () => ++n).state;
    expect(step(s, { type: "blocked_call" }, () => ++n).action).toBe("none");
    s = step(s, { type: "blocked_call" }, () => ++n).state;
    s = step(s, { type: "blocked_call" }, () => ++n).state;
    const r = step(s, { type: "blocked_call" }, () => ++n);
    expect(r.action).toBe("give_up");
    expect(r.state.kind).toBe("idle");
  });

  test("one repair, then give up", () => {
    let n = 0;
    const s = step({ kind: "idle" }, { type: "enter", notebookRevision: 1 }, () => ++n).state;
    const r1 = step(s, { type: "notes_failed" }, () => ++n);
    expect(r1.action).toBe("steer_repair");
    const r2 = step(r1.state, { type: "notes_failed" }, () => ++n);
    expect(r2.action).toBe("give_up");
    expect(r2.state.kind).toBe("idle");
  });
});

describe("trailers", () => {
  test("adds [history entry=id] to user and toolResult only, idempotently, preserving untouched references", () => {
    const branch = [user("u1", "hello"), assistant("a1", "ok", [{ id: "c1", name: "read", args: {} }]), toolResult("t1", "c1", "read", "data")];
    const idx = buildIdIndex(branch);
    const msgs: AgentMessage[] = branch.map((e) => (e as { message: AgentMessage }).message);
    const out = addTrailers(msgs, idx);
    const u = out[0]!;
    const a = out[1]!;
    const t = out[2]!;
    expect(a).toBe(msgs[1]!); // same reference
    expect(u.role === "user" && Array.isArray(u.content) && (u.content.at(-1) as { text: string }).text).toBe("[history entry=u1]");
    expect(t.role === "toolResult" && (t.content.at(-1) as { text: string }).text).toBe("[history entry=t1]");
    const again = addTrailers(out, idx);
    expect(again[0]).toBe(out[0]!);
    expect(again[2]).toBe(out[2]!);
  });

  test("messages not yet persisted get no trailer", () => {
    const branch = [user("u1", "hello")];
    const fresh: AgentMessage = { role: "user", content: [{ type: "text", text: "new" }], timestamp: 42 };
    const out = addTrailers([fresh], buildIdIndex(branch));
    expect(out[0]).toBe(fresh);
  });
});

describe("status line", () => {
  test("renders facts only", () => {
    const branch = [user("u1", "a"), notebookEntry("n1", 2, { Task: "t" }, "a0"), assistant("a1", "x"), assistant("a2", "y")];
    const nb = { revision: 2, sections: { Task: "t" }, reviewedThrough: "a1", entryId: "n1" };
    const line = renderStatusLine({ window: 2, usage: { tokens: 142_300, contextWindow: 272_000 }, notebook: nb, turnsSinceReview: turnsSince(branch, "a1") });
    expect(line).toBe("[note-context] window #2 (prev #1) · 142K/272K · notes rev 2, reviewed 1 turn ago");
    const empty = renderStatusLine({ window: 1, usage: { tokens: null, contextWindow: 200_000 }, notebook: EMPTY_NOTEBOOK, turnsSinceReview: null, branchChanged: true });
    expect(empty).toBe("[note-context] window #1 · ?/200K · no notes yet · branch changed — verify workspace state");
  });
  test("formatTokens", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(9_500)).toBe("9.5K");
    expect(formatTokens(142_300)).toBe("142K");
    expect(formatTokens(1_000_000)).toBe("1M");
  });
});

describe("config", () => {
  test("field-by-field fallback", () => {
    const c = parseConfig({ notebookMaxBytes: 8192, leadTokens: "no", externalCompactionModels: ["a/b", 3], entryIdTrailers: false });
    expect(c.limits.maxBytes).toBe(8192);
    expect(c.limits.maxTokens).toBe(DEFAULT_CONFIG.limits.maxTokens);
    expect(c.leadTokens).toBe(DEFAULT_CONFIG.leadTokens);
    expect(c.externalCompactionModels).toEqual(["a/b"]);
    expect(c.entryIdTrailers).toBe(false);
    expect(parseConfig(null)).toBe(DEFAULT_CONFIG);
  });
});
