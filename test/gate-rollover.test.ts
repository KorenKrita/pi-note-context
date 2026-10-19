import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { evaluateGate, projectCut } from "../src/gate.ts";
import { indexBranch } from "../src/history.ts";
import { reconstructNotebook } from "../src/notebook.ts";
import { DEFAULT_PIN, droppedRange, indexText, indexUserMessages, pinUserMessages, renderRolloverSummary } from "../src/rollover.ts";
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
    const pinned = pinUserMessages(dropped, { messageMaxChars: 20, totalMaxTokens: 4096, indexMaxTokens: 3072 });
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
    const pinned = pinUserMessages(dropped, { messageMaxChars: 5000, totalMaxTokens: 30, indexMaxTokens: 3072 });
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

describe("session index of earlier user messages", () => {
  const T3_FILE = `[File: session-20261016-074605.jsonl; ref=file_afc5] 这个饼干什么的内容 正文完全消失了

<t3_context version="1">
<context kind="file" id="file_afc5">
name: session-20261016-074605.jsonl
sizeBytes: 95942
</context>
</t3_context>

[Attachment saved at /Users/x/.t3/userdata/attachments/abc-jsonl.jsonl]`;

  test("attachment wrappers collapse to a file tag; the user's words follow", () => {
    expect(indexText(user("u", T3_FILE))).toBe("[file: session-20261016-074605.jsonl] 这个饼干什么的内容 正文完全消失了");
  });

  test("a log paste with the question on its last line yields the question", () => {
    const log = `{"app":"0.6.7","ev":"session_start","t":255293}\n{"ev":"capture","t":276158,"rms":0}\n{"ev":"session_end","t":281563}\n悬浮窗一直显示准备中`;
    expect(indexText(user("u", log))).toBe("[log 3 lines] 悬浮窗一直显示准备中");
  });

  test("quotes, fenced code and images become tags; long text is cut", () => {
    expect(indexText(user("u", "[Assistant quote](t3-citation://v1/aaa/bbb%3Accc) 改这个"))).toBe("[quote] 改这个");
    expect(indexText(user("u", "why does this fail?\n```\nline1\nline2\n```"))).toBe("[code 2 lines] why does this fail?");
    const img: SessionEntry = { ...user("u", ""), message: { role: "user", content: [{ type: "image", data: "xx", mimeType: "image/png" }, { type: "text", text: "这个界面" }], timestamp: 1 } } as SessionEntry;
    expect(indexText(img)).toBe("[image] 这个界面");
    expect(indexText(user("u", "x".repeat(200)))).toBe(`${"x".repeat(80)}…`);
  });

  test("host-sent messages are indexed by kind; paste-only keeps its tags; non-user entries are skipped", () => {
    expect(indexText(user("u", "Context handoff (full_thread_summary):\nProvider context handoff. Thread: 6829…"))).toBe("[context handoff]");
    expect(indexText(user("u", "Delegated task node:abc reached a terminal state. Use task_status…"))).toBe("[delegated task result]");
    expect(indexText(user("u", '{"ev":"a"}\n{"ev":"b"}'))).toBe("[log 2 lines]");
    expect(indexText(assistant("a", "hi"))).toBeNull();
    expect(indexText(user("u", "   "))).toBeNull();
  });

  test("indexes earlier windows up to the cut, excluding pinned messages, with window numbers", () => {
    const branch: SessionEntry[] = [
      user("u1", "测一下 sensevoice"), ...round(1, 1),
      rolloverEntry("r1", "a1", 2),
      user("u2", "看看 fork"), ...round(2, 1),
      rolloverEntry("r2", "a2", 3),
      user("u3", "pinned correction"), user("u4", "recent, kept"),
    ];
    const { lines, omitted } = indexUserMessages(branch, "u4", new Set(["u3"]));
    expect(omitted).toBe(0);
    expect(lines).toEqual([
      { id: "u1", window: 1, text: "测一下 sensevoice" },
      { id: "u2", window: 2, text: "看看 fork" },
    ]);
  });

  test("over budget, lines shorten first, then the oldest drop behind a count", () => {
    const branch = Array.from({ length: 40 }, (_, i) => user(`u${i}`, `${i} ${"这是一条很长的用户消息".repeat(10)}`));
    const roomy = indexUserMessages(branch, undefined, new Set(), { ...DEFAULT_PIN, indexMaxTokens: 40 * 70 });
    expect(roomy.omitted).toBe(0);
    expect(roomy.lines[0]!.text.length).toBeLessThanOrEqual(41); // shortened to 40 + "…"
    const tight = indexUserMessages(branch, undefined, new Set(), { ...DEFAULT_PIN, indexMaxTokens: 600 });
    expect(tight.omitted).toBeGreaterThan(0);
    expect(tight.lines.at(-1)!.id).toBe("u39"); // newest kept
    expect(tight.lines.length + tight.omitted).toBe(40);
  });

  test("review regressions: prose that looks like a record keeps its words; real log formats are recognized", () => {
    const Q = "Why is microphone capture failing?";
    expect(indexText(user("u", "[1] 先修这个 bug\n[2] 再看 fork"))).toBe("[1] 先修这个 bug");
    expect(indexText(user("u", "12:00:00 开始的日志里报错了吗"))).toBe("12:00:00 开始的日志里报错了吗");
    expect(indexText(user("u", "{顺便} 看看这个"))).toBe("{顺便} 看看这个");
    expect(indexText(user("u", "at least(I think) it works"))).toBe("at least(I think) it works");
    expect(indexText(user("u", `[INFO] capture started\n[ERROR] device unavailable\n${Q}`))).toBe(`[log 2 lines] ${Q}`);
    expect(indexText(user("u", `    at capture (/app/audio.ts:10:2)\n    at main (/app/main.ts:20:3)\n${Q}`))).toBe(`[log 2 lines] ${Q}`);
    expect(indexText(user("u", `{\n  "event": "capture",\n  "status": "failed"\n}\n${Q}`))).toBe(`[log 4 lines] ${Q}`);
  });

  test("review regressions: fences are parsed by delimiter; inline triple backticks stay text", () => {
    expect(indexText(user("u", "use ```npm ci``` here then rebuild"))).toBe("use ```npm ci``` here then rebuild");
    expect(indexText(user("u", "why?\n```\na\nb"))).toBe("[code 2 lines] why?");
    expect(indexText(user("u", "~~~ts\nconst a = 1;\n~~~\nwhat does this do?"))).toBe("[code 1 lines] what does this do?");
    expect(indexText(user("u", "````md\n```\ninner\n```\n````\nrender this?"))).toBe("[code 3 lines] render this?");
  });

  test("review regressions: tag-heavy messages stay bounded and never empty the index", () => {
    const files = Array.from({ length: 50 }, (_, i) => `[File: ${i}-${"a".repeat(235)}.txt; ref=file_${i}]`).join("\n");
    const heavy = indexText(user("u", `${files}\n[image]\n[image]\nWhy is microphone capture failing?`))!;
    expect(heavy.length).toBeLessThan(200);
    expect(heavy).toContain("+49 files]");
    expect(heavy).toContain("[image ×2]");
    expect(heavy).toContain("Why is microphone capture failing?");
    const branch = [user("old", "ordinary question"), user("latest", `${files}\nWhy is microphone capture failing?`)];
    expect(indexUserMessages(branch, undefined, new Set()).lines.map((l) => l.id)).toEqual(["old", "latest"]); // reviewer case: was { lines: [], omitted: 2 }
    const tiny = indexUserMessages([user("a", "x".repeat(300)), user("b", "这是一条很长的中文问题".repeat(30))], undefined, new Set(), { ...DEFAULT_PIN, indexMaxTokens: 10 });
    expect(tiny.lines.map((l) => l.id)).toEqual(["b"]); // over any budget, the newest line still stays
    expect(tiny.omitted).toBe(1);
  });

  test("follow-up regressions: JSON arrays and empty records, mixed-in indented prose, CRLF fences, surrogate-safe cuts", () => {
    const Q = "Why is microphone capture failing?";
    expect(indexText(user("u", `${JSON.stringify([{ event: "capture", status: "failed" }], null, 2)}\n${Q}`))).toBe(`[log 6 lines] ${Q}`);
    expect(indexText(user("u", `${JSON.stringify({ events: ["capture", "failed"] }, null, 2)}\n${Q}`))).toBe(`[log 6 lines] ${Q}`);
    expect(indexText(user("u", `{}\n{"event":"capture"}\n{"event":"failed"}\n${Q}`))).toBe(`[log 3 lines] ${Q}`);
    expect(indexText(user("u", "    at least(I think) capture should work\n[INFO] capture started\n[ERROR] device unavailable"))).toBe("[log 2 lines] at least(I think) capture should work");
    expect(indexText(user("u", "    at Object.<anonymous> (/app/a.js:1:2)\n    at com.x.Y.run(Y.java:12)\nwhy?"))).toBe("[log 2 lines] why?");
    expect(indexText(user("u", "~~~ts\r\nconst a = 1;\r\n~~~\r\nQuestion?"))).toBe("[code 1 lines] Question?");
    expect(indexText(user("u", "```\r\nx\r\n```\r\nQuestion?"))).toBe("[code 1 lines] Question?");
    for (const pad of [79, 39]) {
      const line = indexText(user("u", `${"x".repeat(pad)}😀 tail`), pad + 1)!;
      expect(() => encodeURIComponent(line)).not.toThrow(); // throws URIError on a lone surrogate
      expect(line).toBe(`${"x".repeat(pad)}…`);
    }
  });

  test("budget trimming is linear in the number of messages", () => {
    const branch = Array.from({ length: 10_000 }, (_, i) => user(`u${i}`, "x".repeat(80)));
    const t0 = performance.now();
    const r = indexUserMessages(branch, undefined, new Set());
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(r.lines.at(-1)!.id).toBe("u9999");
    expect(r.lines.length + r.omitted).toBe(10_000);
  });

  test("summary renders the index before pinned context and points at history before redoing work", () => {
    const branch = longWindow({ reviewedAfterDrop: true });
    const summary = renderRolloverSummary({
      window: 5, reason: "host", notebook: reconstructNotebook(branch), pinned: [],
      index: { lines: [{ id: "u9", window: 2, text: "测一下 sensevoice" }], omitted: 3 },
    });
    expect(summary).toContain("## Earlier user messages in this session");
    expect(summary).toContain("(3 older user messages not listed;");
    expect(summary).toContain("w2 [history entry=u9] 测一下 sensevoice");
    expect(summary).toContain("check `history` for an earlier result");
    expect(renderRolloverSummary({ window: 2, reason: "model", notebook: reconstructNotebook(branch), pinned: [], index: { lines: [], omitted: 0 } })).not.toContain("Earlier user messages");
  });
});
