import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { step, zoneFor, type MaintenanceState } from "../src/maintenance.ts";
import { appendSuffixPatch, formatTokens, renderStatusLine, StatusOdometer, tokensSinceReview } from "../src/status.ts";
import { addTrailers, buildIdIndex } from "../src/trailers.ts";
import { assistant, notebookEntry, toolResult, user } from "./fixtures.ts";
import { EMPTY_NOTEBOOK } from "../src/notebook.ts";

describe("maintenance state machine", () => {
  const T = { contextWindow: 200_000, fallbackWindow: 200_000, reserveTokens: 16_384, leadTokens: 24_000, fallbackBufferTokens: 12_000 };
  test("zones: normal → reminder → fallback; null tokens is normal", () => {
    expect(zoneFor(null, T)).toBe("normal");
    expect(zoneFor(100_000, T)).toBe("normal");
    expect(zoneFor(200_000 - 16_384 - 24_000 + 1, T)).toBe("reminder");
    expect(zoneFor(200_000 - 16_384 - 12_000 + 1, T)).toBe("fallback");
  });
  test("zones: a larger fallback window keeps the reminder where it was and moves only the fallback", () => {
    const split = { ...T, contextWindow: 400_000, fallbackWindow: 800_000 };
    expect(zoneFor(400_000 - 16_384 - 24_000 - 1, split)).toBe("normal");
    expect(zoneFor(400_000 - 16_384 - 24_000, split)).toBe("reminder");
    expect(zoneFor(400_000, split)).toBe("reminder");
    expect(zoneFor(800_000 - 16_384 - 12_000 - 1, split)).toBe("reminder");
    expect(zoneFor(800_000 - 16_384 - 12_000, split)).toBe("fallback");
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
  test("appends [history entry=id] to the last text block of user and toolResult only, idempotently, preserving untouched references", () => {
    const branch = [user("u1", "hello"), assistant("a1", "ok", [{ id: "c1", name: "read", args: {} }]), toolResult("t1", "c1", "read", "data")];
    const idx = buildIdIndex(branch);
    const msgs: AgentMessage[] = branch.map((e) => (e as { message: AgentMessage }).message);
    const out = addTrailers(msgs, idx);
    const u = out[0]!;
    const a = out[1]!;
    const t = out[2]!;
    expect(a).toBe(msgs[1]!); // same reference
    // block count unchanged (ObservationPack's "every block is text" classification still holds)
    expect(u.role === "user" && Array.isArray(u.content) && u.content.length).toBe(1);
    expect(u.role === "user" && Array.isArray(u.content) && (u.content[0] as { text: string }).text).toBe("hello\n[history entry=u1]");
    expect(t.role === "toolResult" && t.content.length).toBe(1);
    expect(t.role === "toolResult" && (t.content[0] as { text: string }).text).toBe("data\n[history entry=t1]");
    const again = addTrailers(out, idx);
    expect(again[0]).toBe(out[0]!);
    expect(again[2]).toBe(out[2]!);
  });

  test("a tool result replaced wholesale by another projection (placeholder) is re-tagged on the next pass", () => {
    const branch = [toolResult("t1", "c1", "read", "x".repeat(20_000))];
    const idx = buildIdIndex(branch);
    const original = (branch[0] as { message: AgentMessage }).message;
    const tagged = addTrailers([original], idx)[0]!;
    // simulate ObservationPack replacing content with a placeholder
    const placeholder = { ...tagged, content: [{ type: "text" as const, text: "[large tool result replaced] id: obs_1" }] } as AgentMessage;
    const retagged = addTrailers([placeholder], idx)[0]!;
    expect(retagged.role === "toolResult" && (retagged.content[0] as { text: string }).text).toBe("[large tool result replaced] id: obs_1\n[history entry=t1]");
  });

  test("messages not yet persisted get no trailer", () => {
    const branch = [user("u1", "hello")];
    const fresh: AgentMessage = { role: "user", content: [{ type: "text", text: "new" }], timestamp: 42 };
    const out = addTrailers([fresh], buildIdIndex(branch));
    expect(out[0]).toBe(fresh);
  });
});

describe("status line", () => {
  const nb = { revision: 2, sections: { Task: "t" }, reviewedThrough: "a1", reviewedTokens: 90_000, entryId: "n1" };
  test("renders facts only: pressure and tokens since review", () => {
    const line = renderStatusLine({ usage: { tokens: 142_300, contextWindow: 272_000 }, notebook: nb, tokensSinceReview: tokensSinceReview(142_300, nb) });
    expect(line).toBe("[note-context] 142K/272K · notes rev 2, +52K since review");
    const empty = renderStatusLine({ usage: { tokens: null, contextWindow: 200_000 }, notebook: EMPTY_NOTEBOOK, tokensSinceReview: null, branchChanged: true });
    expect(empty).toBe("[note-context] ?/200K · no notes yet · branch changed — verify workspace state");
  });
  test("names the budget scale on large windows; staleness unknown for pre-field records", () => {
    const legacy = { ...nb, reviewedTokens: null };
    const line = renderStatusLine({ usage: { tokens: 142_300, contextWindow: 400_000, physicalWindow: 1_000_000 }, notebook: legacy, tokensSinceReview: tokensSinceReview(142_300, legacy) });
    expect(line).toBe("[note-context] 142K/400K budget (1M window) · notes rev 2");
  });
  test("odometer: first reading, then only on a pressure step or a staleness step; notes write re-arms staleness", () => {
    const step = 40_000;
    const o = new StatusOdometer();
    const at = (tokens: number, book = nb) => {
      const since = tokensSinceReview(tokens, book);
      const show = o.shouldShow(step, tokens, since, book);
      if (show) o.confirm(step, tokens, since, book);
      return show;
    };
    expect(at(95_000)).toBe(true); // first reading
    expect(at(110_000)).toBe(false); // same pressure step (2), since=20K < step
    expect(at(125_000)).toBe(true); // pressure step 2 → 3
    expect(at(131_000)).toBe(true); // since=41K crosses one step
    expect(at(150_000)).toBe(false); // step 3, since-step 1 already shown for this revision
    const written = { ...nb, revision: 3, reviewedTokens: 150_000, entryId: "n2" };
    expect(at(155_000, written)).toBe(false); // fresh notes, no pressure step change
    expect(at(191_000, written)).toBe(true); // pressure step 3 → 4 (since=41K would also fire)
    expect(at(120_000, written)).toBe(true); // pressure fell a step: shown (both directions)
    o.force();
    expect(at(120_000, written)).toBe(true); // forced (branch change) shows regardless
    expect(at(120_000, written)).toBe(false);
  });
  test("appendSuffixPatch lands on the last text part; none → undefined", () => {
    const patched = appendSuffixPatch([{ type: "text", text: "out" }, { type: "image", data: "x", mimeType: "image/png" }], "[s]");
    expect(patched?.content[0]).toEqual({ type: "text", text: "out\n\n[s]" });
    expect(patched?.content[1]).toEqual({ type: "image", data: "x", mimeType: "image/png" });
    expect(appendSuffixPatch([{ type: "image", data: "x", mimeType: "image/png" }], "[s]")).toBeUndefined();
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
    // fallbackBudgetTokens follows budgetTokens unless set; both share the 32K minimum.
    expect(parseConfig({ budgetTokens: 300_000 }).fallbackBudgetTokens).toBe(300_000);
    expect(parseConfig({ budgetTokens: 400_000, fallbackBudgetTokens: 800_000 }).fallbackBudgetTokens).toBe(800_000);
    expect(parseConfig({ budgetTokens: 400_000, fallbackBudgetTokens: 1_000 }).fallbackBudgetTokens).toBe(400_000);
  });
});
