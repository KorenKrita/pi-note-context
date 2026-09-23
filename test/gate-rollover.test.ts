import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { evaluateGate, projectCut } from "../src/gate.ts";
import { indexBranch } from "../src/history.ts";
import { reconstructNotebook } from "../src/notebook.ts";
import { droppedRange, pinUserMessages, renderRolloverSummary } from "../src/rollover.ts";
import { assistant, notebookEntry, rolloverEntry, round, toolResult, user } from "./fixtures.ts";

const KEEP = 20_000; // Pi default keepRecentTokens

/** ~40 KB of old tool output, then a notebook write, then ~4 KB of recent work. */
function longWindow(opts: { reviewedAfterDrop: boolean }): SessionEntry[] {
  const branch: SessionEntry[] = [user("u1", "Refactor the parser to support nested comments. Keep the public API stable.")];
  for (let i = 1; i <= 10; i++) branch.push(...round(i, 20)); // 10 × 20 KB ≈ 50K tokens at chars/4
  const reviewedThrough = opts.reviewedAfterDrop ? "a10" : "a3";
  branch.push(notebookEntry("n1", 1, { Task: "nested comments, API stable", Next: "edit parseComment" }, reviewedThrough));
  branch.push(...round(11, 2));
  branch.push(user("u2", "also make sure Windows line endings work"));
  branch.push(...round(12, 2));
  return branch;
}

describe("gate", () => {
  test("refuses without a notebook", () => {
    const branch = longWindow({ reviewedAfterDrop: true }).filter((e) => e.type !== "custom");
    const v = evaluateGate({ branch, notebook: reconstructNotebook(branch), settings: { keepRecentTokens: KEEP }, minReclaimTokens: 1, pending: false, summaryTokens: 100 });
    expect(!v.ok && v.blocker).toBe("no_notebook");
  });

  test("refuses when the notebook predates material that would be dropped", () => {
    const branch = longWindow({ reviewedAfterDrop: false });
    const v = evaluateGate({ branch, notebook: reconstructNotebook(branch), settings: { keepRecentTokens: KEEP }, minReclaimTokens: 1, pending: false, summaryTokens: 100 });
    expect(!v.ok && v.blocker).toBe("stale_notebook");
  });

  test("passes when reviewed through the drop range and reclaim is large", () => {
    const branch = longWindow({ reviewedAfterDrop: true });
    const v = evaluateGate({ branch, notebook: reconstructNotebook(branch), settings: { keepRecentTokens: KEEP }, minReclaimTokens: 20_000, pending: false, summaryTokens: 500 });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.reclaimTokens).toBeGreaterThan(20_000);
    expect(v.droppedEntries).toBeGreaterThan(0);
    // the cut is at or before the review marker: nothing after the review is dropped
    const cut = projectCut(branch, KEEP);
    expect(branch.findIndex((e) => e.id === cut.firstKeptEntryId) - 1).toBeLessThanOrEqual(branch.findIndex((e) => e.id === "a10"));
  });

  test("refuses low reclaim and already-pending", () => {
    const small: SessionEntry[] = [user("u1", "hi"), ...round(1, 1), notebookEntry("n1", 1, { Task: "x" }, "a1"), ...round(2, 1)];
    const nb = reconstructNotebook(small);
    const v1 = evaluateGate({ branch: small, notebook: nb, settings: { keepRecentTokens: KEEP }, minReclaimTokens: 20_000, pending: false, summaryTokens: 100 });
    expect(!v1.ok && (v1.blocker === "nothing_to_drop" || v1.blocker === "low_reclaim")).toBe(true);
    const v2 = evaluateGate({ branch: small, notebook: nb, settings: { keepRecentTokens: KEEP }, minReclaimTokens: 1, pending: true, summaryTokens: 100 });
    expect(!v2.ok && v2.blocker).toBe("already_pending");
  });

  test("host path: refuses below the pressure floor even when reclaim is large; model path (no pressure) is unaffected", () => {
    const branch = longWindow({ reviewedAfterDrop: true });
    const nb = reconstructNotebook(branch);
    const base = { branch, notebook: nb, settings: { keepRecentTokens: KEEP }, minReclaimTokens: 20_000, pending: false, summaryTokens: 500 };
    const low = evaluateGate({ ...base, pressure: { tokens: 84_000, floorTokens: 359_616 } });
    expect(!low.ok && low.blocker).toBe("low_pressure");
    expect(!low.ok && low.message).toContain("window at 84K");
    expect(!low.ok && low.message).toContain("360K reminder threshold");
    const high = evaluateGate({ ...base, pressure: { tokens: 359_616, floorTokens: 359_616 } });
    expect(high.ok).toBe(true);
    expect(evaluateGate(base).ok).toBe(true);
  });

  test("user reason skips only the reclaim and pressure economics, while preserving estimates", () => {
    const branch = longWindow({ reviewedAfterDrop: true });
    const base = { branch, notebook: reconstructNotebook(branch), settings: { keepRecentTokens: KEEP }, minReclaimTokens: 100_000, pending: false, summaryTokens: 500 };
    const model = evaluateGate(base);
    expect(!model.ok && model.blocker).toBe("low_reclaim");
    const pressure = { tokens: 84_000, floorTokens: 359_616 };
    const host = evaluateGate({ ...base, pressure });
    expect(!host.ok && host.blocker).toBe("low_pressure");
    const verdict = evaluateGate({ ...base, pressure, reason: "user" });
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe("user");
    expect(verdict.reclaimTokens).toBe(model.reclaimTokens);
    expect(verdict.reclaimTokens).toBeLessThan(base.minReclaimTokens);
  });

  test("user reason still refuses missing/stale notes, duplicate schedules, and a window with nothing to drop", () => {
    const fresh = longWindow({ reviewedAfterDrop: true });
    const missing = fresh.filter((e) => e.type !== "custom");
    const stale = longWindow({ reviewedAfterDrop: false });
    const tiny = [user("u1", "hi"), notebookEntry("n1", 1, { Task: "x" }, "u1")];
    for (const [branch, pending, blocker] of [
      [missing, false, "no_notebook"],
      [stale, false, "stale_notebook"],
      [fresh, true, "already_pending"],
      [tiny, false, "nothing_to_drop"],
    ] as const) {
      const verdict = evaluateGate({ branch, notebook: reconstructNotebook(branch), settings: { keepRecentTokens: KEEP }, minReclaimTokens: 100_000, summaryTokens: 500, pending, reason: "user", pressure: { tokens: 1, floorTokens: 359_616 } });
      expect(!verdict.ok && verdict.blocker).toBe(blocker);
      expect(verdict.reason).toBe("user");
    }
  });

  test("context entries: droppable range starts after the leading compaction entry and includes its retained tail", () => {
    // buildContextEntries() shape: [compaction, ...retained tail, ...newer]
    const context: SessionEntry[] = [rolloverEntry("r1", "t8", 2), ...round(8, 60), ...round(9, 60), notebookEntry("n2", 2, { Task: "t" }, "a9"), ...round(10, 1)];
    const cut = projectCut(context, KEEP);
    expect(cut.start).toBe(1);
    const v = evaluateGate({ branch: context, notebook: reconstructNotebook(context), settings: { keepRecentTokens: KEEP }, minReclaimTokens: 1, pending: false, summaryTokens: 10 });
    // the ~120 KB retained tail is droppable even though it predates the current window's new work
    expect(v.ok && v.droppedEntries).toBeGreaterThan(0);
  });
});

describe("rollover summary", () => {
  test("pins first user message verbatim, later ones truncated, labelled historical", () => {
    const branch = longWindow({ reviewedAfterDrop: true });
    const cut = projectCut(branch, KEEP);
    const dropped = droppedRange(branch, cut.firstKeptEntryId!);
    const pinned = pinUserMessages(dropped, { messageMaxChars: 20, totalMaxTokens: 4096 });
    expect(pinned[0]?.id).toBe("u1");
    expect(pinned[0]?.text).toContain("Keep the public API stable");
    // u2 is inside the retained tail (recent), so it is not pinned
    expect(pinned.map((p) => p.id)).not.toContain("u2");
    const summary = renderRolloverSummary({ window: 2, reason: "model", notebook: reconstructNotebook(branch), pinned });
    expect(summary).toContain("Context window #2 started (previous #1, rollover reason: model)");
    expect(summary).toContain("## Notebook (revision 1, reviewed through entry a10)");
    expect(summary).toContain("nested comments, API stable");
    expect(summary).toContain("[history entry=u1] user: Refactor the parser");
    expect(summary).toContain("do not re-execute");
  });

  test("total pin budget collapses later messages to first line", () => {
    const dropped: SessionEntry[] = [user("u1", "first request"), user("u2", `${"long line ".repeat(100)}\nsecond line`), user("u3", "third\nmore")];
    const pinned = pinUserMessages(dropped, { messageMaxChars: 5000, totalMaxTokens: 30 });
    expect(pinned[0]?.text).toBe("first request");
    expect(pinned[1]?.truncated).toBe(true);
    expect(pinned[1]?.text.length).toBeLessThanOrEqual(120);
    expect(pinned[2]?.text).toBe("third");
  });

  test("droppedRange spans the previous compaction's retained tail and excludes the compaction entry itself", () => {
    const context: SessionEntry[] = [rolloverEntry("r1", "u0", 2), user("u0", "retained correction: skip Windows"), user("u1", "new task"), ...round(1, 1), toolResult("tk", "cx", "read", "kept")];
    const dropped = droppedRange(context, "tk");
    expect(dropped.map((e) => e.id)).toEqual(["u0", "u1", "a1", "t1"]);
    // and the retained correction is pinned, not lost
    expect(pinUserMessages(dropped).map((p) => p.id)).toEqual(["u0", "u1"]);
  });

  test("a rollover entry is visible in history as a window boundary", () => {
    const branch: SessionEntry[] = [user("u1", "a"), rolloverEntry("r1", "u1", 2), user("u2", "b")];
    const items = indexBranch(branch);
    expect(items.find((i) => i.id === "r1")?.label).toBe("rollover");
    expect(items.find((i) => i.id === "u2")?.window).toBe(2);
  });
});
