import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { maintenanceRequestText, reminderText, step, zoneFor, type MaintenanceState } from "../src/maintenance.ts";
import { appendSuffixPatch, renderStatusLine, StatusOdometer, tokensSinceReview } from "../src/status.ts";
import { addTrailers, buildIdIndex } from "../src/trailers.ts";
import { assistant, notebookEntry, toolResult, user } from "./fixtures.ts";
import { EMPTY_NOTEBOOK, type Notebook } from "../src/notebook.ts";

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
  test("appends a self-identifying [note-context: this-message-id=id] to the last text block of user and toolResult only, idempotently, preserving untouched references", () => {
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
    expect(u.role === "user" && Array.isArray(u.content) && (u.content[0] as { text: string }).text).toBe("hello\n[note-context: this-message-id=u1]");
    expect(t.role === "toolResult" && t.content.length).toBe(1);
    expect(t.role === "toolResult" && (t.content[0] as { text: string }).text).toBe("data\n[note-context: this-message-id=t1]");
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
    expect(retagged.role === "toolResult" && (retagged.content[0] as { text: string }).text).toBe("[large tool result replaced] id: obs_1\n[note-context: this-message-id=t1]");
  });

  test("messages not yet persisted get no trailer", () => {
    const branch = [user("u1", "hello")];
    const fresh: AgentMessage = { role: "user", content: [{ type: "text", text: "new" }], timestamp: 42 };
    const out = addTrailers([fresh], buildIdIndex(branch));
    expect(out[0]).toBe(fresh);
  });

  test("a message with no text block gets a standalone trailer block, idempotently; string content is converted once", () => {
    const img = { ...(user("u1", "x") as { message: AgentMessage }).message, content: [{ type: "image" as const, data: "AAAA", mimeType: "image/png" }] } as AgentMessage;
    const str = { ...(user("u2", "x") as { message: AgentMessage }).message, content: "plain" } as AgentMessage;
    const idx = buildIdIndex([{ id: "u1", parentId: null, timestamp: "", type: "message", message: img }, { id: "u2", parentId: null, timestamp: "", type: "message", message: str }] as never);
    const out = addTrailers([img, str], idx);
    const i = out[0]!;
    expect(i.role === "user" && Array.isArray(i.content) && i.content.map((b) => b.type)).toEqual(["image", "text"]);
    expect(i.role === "user" && Array.isArray(i.content) && (i.content[1] as { text: string }).text).toBe("[note-context: this-message-id=u1]");
    const s = out[1]!;
    expect(s.role === "user" && Array.isArray(s.content) && (s.content[0] as { text: string }).text).toBe("plain\n[note-context: this-message-id=u2]");
    const again = addTrailers(out, idx);
    expect(again[0]).toBe(out[0]!);
    expect(again[1]).toBe(out[1]!);
  });
});

/** Any context-size figure: 12K, 1.5M, 400000, "tokens", "budget", "window" sizes. */
const SIZE_FIGURE = /\d+(\.\d+)?\s*[KkMm]\b|\d{4,}|\btokens?\b|\bbudget\b|\d+\s*%/;

describe("status line", () => {
  const nb = { revision: 2, sections: { Task: "t" }, reviewedThrough: "a1", reviewedTokens: 90_000, entryId: "n1" };
  test("renders notes staleness only, with no context-size figures", () => {
    const fresh = renderStatusLine({ notebook: nb, stale: false });
    expect(fresh).toBe("[note-context] notes rev 2");
    const stale = renderStatusLine({ notebook: nb, stale: true, externalCompaction: true });
    expect(stale).toBe("[note-context] notes rev 2 not reviewed for a while — update them, or call notes({reviewed:true}) if they are still accurate · compaction: external");
    const empty = renderStatusLine({ notebook: EMPTY_NOTEBOOK, stale: true, branchChanged: true });
    expect(empty).toBe("[note-context] no notes yet — write them once there is working state worth keeping · branch changed — verify workspace state");
    for (const line of [fresh, stale, empty]) expect(line).not.toMatch(SIZE_FIGURE);
  });
  test("tokensSinceReview: whole context with no notes; unknown for pre-field records", () => {
    expect(tokensSinceReview(142_300, nb)).toBe(52_300);
    expect(tokensSinceReview(142_300, EMPTY_NOTEBOOK)).toBe(142_300);
    expect(tokensSinceReview(142_300, { ...nb, reviewedTokens: null })).toBeNull();
    expect(tokensSinceReview(null, nb)).toBeNull();
  });

  test("tokensSinceReview: notes from an earlier window count from this window's base", () => {
    expect(tokensSinceReview(65_000, { ...nb, reviewedTokens: 365_000 }, 25_000)).toBe(40_000);
    expect(tokensSinceReview(65_000, { ...nb, reviewedTokens: null }, 25_000)).toBeNull();
  });
  test("after a rollover the staleness nudge returns once the new window grows by a step", () => {
    const o = new StatusOdometer();
    const old = { ...nb, reviewedTokens: 365_000 };
    const shown: number[] = [];
    o.reset();
    for (const t of [null, 25_000, 45_000, 64_000, 66_000, 80_000, 106_000]) {
      const r = o.reading(step, tokensSinceReview(t, old, o.windowBase(t)), old, false);
      if (r) { o.confirm(r, old); if (t !== null) shown.push(t); }
    }
    expect(shown).toEqual([66_000, 106_000]);
  });
  test("usage falling back and rising again does not repeat a delivered step", () => {
    const { at } = meter();
    expect(at(131_000)).toContain("not reviewed");
    expect(at(171_000)).toContain("not reviewed");
    expect(at(165_000)).toBeUndefined();
    expect(at(171_000)).toBeUndefined();
    expect(at(41_000, EMPTY_NOTEBOOK)).toContain("no notes yet");
    expect(at(81_000, EMPTY_NOTEBOOK)).toContain("no notes yet");
    expect(at(79_000, EMPTY_NOTEBOOK)).toBeUndefined();
    expect(at(81_000, EMPTY_NOTEBOOK)).toBeUndefined();
  });

  const step = 40_000;
  const meter = () => {
    const o = new StatusOdometer();
    return {
      o,
      at(tokens: number | null, book: Notebook = nb, external = false) {
        const r = o.reading(step, tokensSinceReview(tokens, book), book, external);
        if (r) o.confirm(r, book);
        return r && renderStatusLine({ notebook: book, stale: r.stale, branchChanged: r.branchChanged, externalCompaction: r.externalCompaction });
      },
    };
  };
  test("usage crossing a step alone does not show it; staleness does", () => {
    const { at } = meter();
    expect(at(95_000)).toBeUndefined(); // notes reviewed at 90K: fresh, whatever the overall usage
    expect(at(121_000)).toBeUndefined(); // usage step 2 → 3, since = 31K: still fresh
    expect(at(129_000)).toBeUndefined();
    const line = at(131_000); // since = 41K crosses one staleness step
    expect(line).toContain("not reviewed for a while");
    expect(line).not.toMatch(SIZE_FIGURE);
    expect(at(165_000)).toBeUndefined(); // usage step 4, same staleness step
    expect(at(171_000)).toContain("not reviewed for a while"); // since = 81K: second step
    const written = { ...nb, revision: 3, reviewedTokens: 171_000, entryId: "n2" };
    expect(at(175_000, written)).toBeUndefined(); // a write re-arms; fresh notes stay quiet
    expect(at(205_000, written)).toBeUndefined(); // usage step 5, since 34K
    expect(at(120_000, written)).toBeUndefined(); // usage fell a step: not a trigger any more
    expect(at(212_000, written)).toContain("notes rev 3 not reviewed");
  });
  test("no notes yet: quiet until the first step of context, then once per further step", () => {
    const { at } = meter();
    expect(at(15_000, EMPTY_NOTEBOOK)).toBeUndefined(); // a short task is not nudged
    expect(at(39_000, EMPTY_NOTEBOOK)).toBeUndefined();
    expect(at(41_000, EMPTY_NOTEBOOK)).toContain("no notes yet");
    expect(at(60_000, EMPTY_NOTEBOOK)).toBeUndefined();
    expect(at(81_000, EMPTY_NOTEBOOK)).toContain("no notes yet");
    expect(at(null, EMPTY_NOTEBOOK)).toBeUndefined(); // usage unknown: no nudge
    expect(meter().at(null, EMPTY_NOTEBOOK)).toBeUndefined();
  });
  test("one-shot facts: branch change and external compaction (once per window)", () => {
    const { o, at } = meter();
    expect(at(95_000, nb, true)).toBe("[note-context] notes rev 2 · compaction: external");
    expect(at(96_000, nb, true)).toBeUndefined();
    o.force();
    expect(at(97_000, nb, true)).toBe("[note-context] notes rev 2 · branch changed — verify workspace state");
    expect(at(97_000, nb, true)).toBeUndefined();
    o.reset(); // new window
    expect(at(97_000, nb, true)).toBe("[note-context] notes rev 2 · compaction: external");
  });
  test("pre-field notebook records (unknown reviewedTokens) never go stale on tokens", () => {
    const { at } = meter();
    const legacy = { ...nb, reviewedTokens: null };
    expect(at(95_000, legacy)).toBeUndefined();
    expect(at(395_000, legacy)).toBeUndefined();
  });
  test("reminder and maintenance request carry no token counts", () => {
    const withBook = reminderText("## Task\nt");
    expect(withBook.split("\n\n")[0]).toBe("[note-context] A context-window rollover is due. Update notes against what will leave the window (current notebook below), or call notes({reviewed:true}) if they are already sufficient. Then call new_context.");
    expect(withBook.split("\n\n")[0]).not.toMatch(SIZE_FIGURE);
    expect(reminderText(null)).not.toMatch(SIZE_FIGURE);
    expect(maintenanceRequestText(3)).not.toMatch(SIZE_FIGURE);
    expect(maintenanceRequestText(3)).not.toContain("exhausted");
  });
  test("appendSuffixPatch lands on the last text part; none → undefined", () => {
    const patched = appendSuffixPatch([{ type: "text", text: "out" }, { type: "image", data: "x", mimeType: "image/png" }], "[s]");
    expect(patched?.content[0]).toEqual({ type: "text", text: "out\n\n[s]" });
    expect(patched?.content[1]).toEqual({ type: "image", data: "x", mimeType: "image/png" });
    expect(appendSuffixPatch([{ type: "image", data: "x", mimeType: "image/png" }], "[s]")).toBeUndefined();
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
    expect(parseConfig({ statusStepTokens: 100_000 }).noNotesStepTokens).toBe(100_000);
    expect(parseConfig({ statusStepTokens: 100_000, noNotesStepTokens: 200_000 }).noNotesStepTokens).toBe(200_000);
    expect(parseConfig({ budgetTokens: 400_000, fallbackBudgetTokens: 1_000 }).fallbackBudgetTokens).toBe(400_000);
    expect(DEFAULT_CONFIG.pin.indexMaxTokens).toBe(3072);
    expect(parseConfig({ sessionIndexMaxTokens: 1_000 }).pin.indexMaxTokens).toBe(1_000);
    expect(parseConfig({ sessionIndexMaxTokens: 10 }).pin.indexMaxTokens).toBe(DEFAULT_CONFIG.pin.indexMaxTokens);
  });
});
