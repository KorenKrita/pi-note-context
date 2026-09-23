/**
 * Extension-hook timing for the host-initiated rollover (DESIGN.md §15):
 * notes write → gate passes → pending → more work lands → agent_settled.
 * The pending rollover must be re-checked against the current cut before
 * ctx.compact() runs; a stale one is cancelled and recorded, never handed to
 * Pi's LLM summary. Isolated config + ledger under a temp PI_CODING_AGENT_DIR.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { flushLedger } from "../src/ledger.ts";
import { ROLLOVER_DETAILS_KIND } from "../src/history.ts";
import { notebookEntry, round, user } from "./fixtures.ts";

// One OS temp root per run; each harness gets its own agent dir under it so config and ledger
// are isolated per test. Left in place after the run (OS temp cleanup owns it).
const tmpRoot = mkdtempSync(join(tmpdir(), "note-context-settled-"));
let agentDirs = 0;
const savedEnv = { dir: process.env["PI_CODING_AGENT_DIR"], ledger: process.env["NOTE_CONTEXT_LEDGER_DISABLED"] };
delete process.env["NOTE_CONTEXT_LEDGER_DISABLED"];
const { default: noteContext } = await import("../src/index.ts");

afterAll(() => {
  if (savedEnv.dir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = savedEnv.dir;
  if (savedEnv.ledger === undefined) delete process.env["NOTE_CONTEXT_LEDGER_DISABLED"];
  else process.env["NOTE_CONTEXT_LEDGER_DISABLED"] = savedEnv.ledger;
});

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;
type Tool = { name: string; execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<{ content: { type: string; text: string }[] }> };

function harness(config: Record<string, unknown> = {}) {
  const agentDir = join(tmpRoot, `agent-${++agentDirs}`);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "pi-note-context.json"), JSON.stringify(config));
  process.env["PI_CODING_AGENT_DIR"] = agentDir; // read by loadConfig() at registration and by the ledger per row

  const branch: SessionEntry[] = [user("u1", "Refactor the parser to support nested comments.")];
  for (let i = 1; i <= 10; i++) branch.push(...round(i, 20)); // ~50K tokens of old tool output
  branch.push(notebookEntry("n0", 1, { Task: "parser" }, "a10"));
  branch.push(...round(11, 2));

  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const compactCalls: { onComplete?: () => void; onError?: (e: Error) => void }[] = [];
  const sent: { customType?: string }[] = [];
  let extra = 0;
  const pi = {
    on: (ev: string, h: Handler) => {
      handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
    },
    registerTool: (t: Tool) => tools.set(t.name, t),
    registerCommand: () => {},
    appendEntry: (customType: string, data: unknown) => {
      branch.push({ id: `x${++extra}`, parentId: null, timestamp: new Date().toISOString(), type: "custom", customType, data } as SessionEntry);
    },
    sendMessage: (msg: { customType?: string }) => {
      sent.push(msg);
    },
  } as unknown as ExtensionAPI;
  noteContext(pi);

  const usage = { tokens: 365_000, contextWindow: 1_000_000 }; // reminder zone of the 400K budget (≥ 400K − 16384 − 24000): host rollover allowed
  const state = { model: { provider: "p", id: "m", contextWindow: 1_000_000 } };
  // The current run's abort signal, as Pi exposes it on ctx.signal while a run is active.
  const run = { controller: new AbortController() };
  const ctx = {
    cwd: agentDir,
    hasUI: false,
    get model() {
      return state.model;
    },
    get signal() {
      return run.controller.signal;
    },
    sessionManager: { getBranch: () => branch, buildContextEntries: () => branch, getSessionId: () => "s1", getLeafId: () => branch[branch.length - 1]?.id ?? null },
    getContextUsage: () => usage,
    isProjectTrusted: () => true,
    isIdle: () => true,
    compact: (opts: (typeof compactCalls)[number]) => {
      compactCalls.push(opts);
    },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;

  const emit = async (ev: string, event: unknown = {}) => {
    const results: unknown[] = [];
    for (const h of handlers.get(ev) ?? []) results.push(await h(event, ctx));
    return results;
  };
  const notes = async (params: unknown) => {
    const r = await tools.get("notes")!.execute("call", params, undefined, undefined, ctx);
    return r.content.map((c) => c.text).join("\n");
  };
  const newContext = async (params: unknown = {}) => {
    const r = await tools.get("new_context")!.execute("call", params, undefined, undefined, ctx);
    return r.content.map((c) => c.text).join("\n");
  };
  /** Compaction entries our handlers proposed at actionable boundaries (turn_end, agent_before_settle). */
  const boundary: { reason: string; drafts: { type: string; customType?: string; details?: { reason?: string } }[] }[] = [];
  /** Pi's boundary commit: set `pi.rejectBoundary` to model a later handler invalidating the proposal. */
  const piHost = { rejectBoundary: false, otherCompaction: false };
  let committed = 0;
  const collect = (reason: string, results: unknown[]) => {
    for (const r of results) {
      const drafts = (r as { entries?: { type: string; details?: { reason?: string } }[] } | undefined)?.entries;
      if (!drafts?.some((d) => d.type === "compaction")) continue;
      boundary.push({ reason, drafts });
      if (piHost.rejectBoundary) continue;
      for (const d of drafts) {
        if (d.type === "compaction") branch.push({ id: `cmp${++committed}`, parentId: null, timestamp: new Date().toISOString(), type: "compaction", summary: "", firstKeptEntryId: "a10", tokensBefore: 0, details: d.details } as SessionEntry);
      }
    }
  };
  /** An earlier extension's compaction draft already in event.entries. */
  const earlier = () => (piHost.otherCompaction ? [{ type: "compaction", summary: "OTHER", firstKeptEntryId: null }] : []);
  /** turn_end for an assistant message, as Pi emits it after every assistant response. */
  const turnEnd = async (message: Record<string, unknown> = { role: "assistant" }, outcome = "completed") =>
    collect("turn_end", await emit("turn_end", { message, entries: earlier(), continue: false, outcome }));
  /** Pi's settle sequence: the actionable agent_before_settle boundary, then agent_settled. */
  const settle = async (outcome = "completed") => {
    collect("agent_before_settle", await emit("agent_before_settle", { entries: earlier(), continue: false, outcome }));
    await emit("agent_settled");
  };
  /** Rollovers started either way: boundary compaction drafts plus ctx.compact() calls. */
  const compactions = () => boundary.length + compactCalls.length;
  const ledgerRows = async () => {
    await flushLedger();
    try {
      return readFileSync(join(agentDir, "state", "note-context-ledger.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  };
  /** The user presses ESC: Pi aborts the current run's signal. */
  const abort = () => run.controller.abort();
  /** A new run starts (next prompt or a triggered follow-up) with a fresh signal. */
  const startRun = async () => {
    run.controller = new AbortController();
    await emit("agent_start");
  };
  return { branch, ctx, usage, state, emit, notes, newContext, turnEnd, settle, boundary, compactions, piHost, sent, compactCalls, ledgerRows, abort, startRun };
}

describe("host rollover: re-check at agent_settled", () => {
  test("valid pending compacts exactly once; a second settle does nothing", async () => {
    const h = harness();
    const out = await h.notes({ sections: { Task: "parser", Next: "edit parseComment" } });
    expect(out).toContain("Rollover scheduled by the host");
    await h.settle();
    expect(h.compactions()).toBe(1);
    await h.settle();
    expect(h.compactions()).toBe(1);
  });

  test("pending that went stale before settle is cancelled, ctx.compact is not called, ledger says why; next notes re-arms", async () => {
    const h = harness();
    const out = await h.notes({ sections: { Task: "parser", Next: "edit parseComment" } });
    expect(out).toContain("Rollover scheduled by the host");
    // The model kept working: ~60K tokens land after the review marker, so the actual cut
    // would now drop unreviewed material (the real session 01a08e78… on 2026-09-11 05:08).
    for (let i = 20; i <= 31; i++) h.branch.push(...round(i, 20));
    await h.settle();
    expect(h.compactions()).toBe(0);
    const rows = await h.ledgerRows();
    const cancelled = rows.find((r) => r["kind"] === "rollover_cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled?.["reason"]).toBe("host");
    expect(cancelled?.["why"]).toBe("stale_notebook");
    // A fresh notes write re-arms the host rollover and it runs on the next settle.
    const again = await h.notes({ sections: { Next: "resume after re-check" } });
    expect(again).toContain("Rollover scheduled by the host");
    await h.settle();
    expect(h.compactions()).toBe(1);
  });

  test("pressure that fell below the floor before settle (e.g. ObservationPack placeholders) cancels with the gate's blocker", async () => {
    const h = harness();
    const out = await h.notes({ sections: { Task: "parser", Next: "x" } });
    expect(out).toContain("Rollover scheduled by the host");
    h.usage.tokens = 120_000; // below the reminder threshold, which is the host floor
    await h.settle();
    expect(h.compactions()).toBe(0);
    const cancelled = (await h.ledgerRows()).find((r) => r["kind"] === "rollover_cancelled");
    expect(cancelled?.["reason"]).toBe("host");
    expect(cancelled?.["why"]).toBe("low_pressure");
  });

  test("model switched to an external compaction owner before settle: host yields, no compact", async () => {
    const h = harness({ externalCompactionModels: ["p/remote"] });
    const out = await h.notes({ sections: { Task: "parser", Next: "x" } });
    expect(out).toContain("Rollover scheduled by the host");
    h.state.model = { provider: "p", id: "remote", contextWindow: 1_000_000 };
    await h.settle();
    expect(h.compactions()).toBe(0);
    const cancelled = (await h.ledgerRows()).find((r) => r["kind"] === "rollover_cancelled");
    expect(cancelled?.["why"]).toBe("external_owner");
  });

  test("ctx.compact error on a scheduled rollover is recorded as a category, never as the raw message", async () => {
    // ctx.compact() remains only for rollovers handed to Pi's compaction (here: an external owner).
    const h = harness({ externalCompactionModels: ["p/m"], minReclaimTokens: 40_000 });
    await h.notes({ reviewed: true });
    await h.newContext({ userRequested: true });
    await h.settle();
    expect(h.compactCalls.length).toBe(1);
    const secret = "sk-live-SECRET-9f8e7d6c";
    h.compactCalls[0]!.onError?.(new Error(`Compaction cancelled: upstream said ${secret} in the response body`));
    const rows = await h.ledgerRows();
    const failed = rows.find((r) => r["kind"] === "rollover_failed");
    expect(failed?.["reason"]).toBe("user");
    expect(failed?.["why"]).toBe("cancelled");
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toContain("response body");
  });
});

describe("host schedule vs. pressure maintenance and model confirmation", () => {
  test("host pending that went stale under fallback pressure is cancelled at turn_end and maintenance takes over; compaction only after fresh notes", async () => {
    const h = harness();
    expect(await h.notes({ sections: { Task: "parser", Next: "x" } })).toContain("Rollover scheduled by the host");
    // Unreviewed work lands and pressure climbs into the fallback zone
    // (budget 400K − reserve 16384 − fallbackBuffer 12000 ≈ 371.6K).
    for (let i = 20; i <= 31; i++) h.branch.push(...round(i, 20));
    h.usage.tokens = 375_000;
    await h.turnEnd();
    const cancelled = (await h.ledgerRows()).find((r) => r["kind"] === "rollover_cancelled");
    expect(cancelled?.["why"]).toBe("stale_notebook");
    const request = h.sent.find((m) => m.customType === "note-context/maintenance") as { details?: { attempt?: number } } | undefined;
    expect(request?.details?.attempt).toBe(1);
    // The guard is live: a non-notes call is blocked while the checkpoint is requested.
    const [guard] = await h.emit("tool_call", { toolName: "read", input: {} });
    expect((guard as { block?: boolean } | undefined)?.block).toBe(true);
    // Settling does not compact a stale notebook.
    await h.settle();
    expect(h.compactions()).toBe(0);
    // The checkpoint lands → fallback rollover at that turn's turn_end boundary, exactly once, no abort.
    await h.notes({ sections: { Next: "checkpoint under pressure" } });
    expect(h.compactions()).toBe(0);
    await h.turnEnd();
    expect(h.compactions()).toBe(1);
    expect(h.compactCalls.length).toBe(0);
    expect(h.boundary[0]).toMatchObject({ reason: "turn_end", drafts: [{ type: "compaction", details: { reason: "fallback" } }, { type: "custom_message", customType: "note-context/continue" }] });
    await h.turnEnd();
    await h.settle();
    expect(h.compactions()).toBe(1);
  });

  test("host pending cancelled for low pressure does not start maintenance", async () => {
    const h = harness();
    await h.notes({ sections: { Task: "parser", Next: "x" } });
    h.usage.tokens = 120_000;
    await h.turnEnd();
    await h.settle();
    expect(h.compactions()).toBe(0);
    expect(h.sent.some((m) => m.customType === "note-context/maintenance")).toBe(false);
    expect((await h.ledgerRows()).some((r) => r["kind"] === "rollover_cancelled" && r["why"] === "low_pressure")).toBe(true);
  });

  test("model new_context on top of a host schedule confirms it: a later pressure drop no longer cancels; compacts once", async () => {
    const h = harness();
    await h.notes({ sections: { Task: "parser", Next: "x" } });
    const out = await h.newContext();
    expect(out).toContain("rollover scheduled");
    h.usage.tokens = 120_000; // below the host floor — irrelevant to a model request
    await h.settle();
    expect(h.compactions()).toBe(1);
    await h.settle();
    expect(h.compactions()).toBe(1);
    expect((await h.ledgerRows()).some((r) => r["kind"] === "rollover_cancelled")).toBe(false);
  });

  test("model new_context on top of a host schedule still enforces freshness; the host schedule is kept for settle", async () => {
    const h = harness();
    await h.notes({ sections: { Task: "parser", Next: "x" } });
    for (let i = 20; i <= 31; i++) h.branch.push(...round(i, 20));
    await expect(h.newContext()).rejects.toThrow(/stale_notebook|notebook predates/);
    await h.settle();
    expect(h.compactions()).toBe(0);
    expect((await h.ledgerRows()).some((r) => r["kind"] === "rollover_cancelled" && r["why"] === "stale_notebook")).toBe(true);
  });

  test("a second new_context on top of a model schedule is still refused as already pending", async () => {
    const h = harness();
    await h.notes({ sections: { Task: "parser", Next: "x" } });
    await h.newContext();
    await expect(h.newContext()).rejects.toThrow(/already scheduled/);
  });

  test("external owner ordinary model requests preserve legacy re-confirmation without a second compaction", async () => {
    const h = harness({ externalCompactionModels: ["p/m"], minReclaimTokens: 40_000 });
    expect(await h.newContext()).toContain("external compaction owner");
    expect(await h.newContext({ userRequested: false })).toContain("external compaction owner");
    await h.settle();
    await h.settle();
    expect(h.compactions()).toBe(1);
    const gates = (await h.ledgerRows()).filter((r) => r["kind"] === "gate");
    expect(gates.map((r) => [r["reason"], r["ok"]])).toEqual([["model", true], ["model", true]]);
  });
});

describe("user-requested rollover", () => {
  test("explicit user request bypasses low reclaim and retains reason through compaction", async () => {
    const h = harness({ minReclaimTokens: 40_000 });
    h.usage.tokens = 84_000; // below the host pressure floor
    await h.notes({ sections: { Task: "parser", Next: "x" } });
    await expect(h.newContext()).rejects.toThrow(/below the 40K threshold/);
    await expect(h.newContext({ userRequested: false })).rejects.toThrow(/below the 40K threshold/);
    expect(await h.newContext({ userRequested: true })).toContain("rollover scheduled");
    await h.settle();
    expect(h.compactions()).toBe(1);
    expect(h.compactCalls.length).toBe(0);
    const compaction = h.boundary[0]!.drafts[0] as unknown as { details: { reason: string }; summary: string };
    expect(compaction.details.reason).toBe("user");
    expect(compaction.summary).toContain("rollover reason: user");
    expect((await h.ledgerRows()).filter((r) => r["kind"] === "gate" && r["ok"] === true)).toContainEqual(
      expect.objectContaining({ reason: "user" }),
    );
    expect((await h.ledgerRows()).filter((r) => r["kind"] === "rollover")).toContainEqual(
      expect.objectContaining({ reason: "user" }),
    );
  });

  test.each([false, true])("user requests retain missing/stale notebook checks (external owner: %s)", async (external) => {
    const h = harness({ autoRollover: false, externalCompactionModels: external ? ["p/m"] : [] });
    const original = [...h.branch];
    h.branch.splice(0, h.branch.length, ...original.filter((e) => e.type !== "custom"));
    await expect(h.newContext({ userRequested: true })).rejects.toThrow(/no notebook/);
    h.branch.splice(0, h.branch.length, ...original);
    for (let i = 20; i <= 31; i++) h.branch.push(...round(i, 20));
    await expect(h.newContext({ userRequested: true })).rejects.toThrow(/notebook predates/);
    await h.settle();
    expect(h.compactions()).toBe(0);
    const rows = (await h.ledgerRows()).filter((r) => r["kind"] === "gate");
    expect(rows.map((r) => [r["reason"], r["ok"], r["blocker"]])).toEqual([
      ["user", false, "no_notebook"],
      ["user", false, "stale_notebook"],
    ]);
  });

  test("user request confirms a host schedule, keeps user attribution, and cannot schedule twice", async () => {
    const h = harness();
    expect(await h.notes({ sections: { Task: "parser", Next: "x" } })).toContain("Rollover scheduled by the host");
    h.usage.tokens = 84_000;
    expect(await h.newContext({ userRequested: true })).toContain("confirms the host schedule");
    await expect(h.newContext({ userRequested: true })).rejects.toThrow(/already scheduled/);
    await expect(h.newContext()).rejects.toThrow(/already scheduled/);
    await h.settle();
    await h.settle();
    expect(h.compactions()).toBe(1);
    const rows = await h.ledgerRows();
    expect(rows.find((r) => r["kind"] === "rollover")?.["reason"]).toBe("user");
    expect(rows.some((r) => r["kind"] === "rollover_cancelled")).toBe(false);
    expect(h.boundary[0]).toMatchObject({ reason: "agent_before_settle", drafts: [{ type: "compaction" }, { type: "custom_message", customType: "note-context/continue" }] });
  });

  test("user request does not bypass freshness against the actual compaction cut", async () => {
    const h = harness({ autoRollover: false, minReclaimTokens: 40_000 });
    await h.notes({ reviewed: true });
    await h.newContext({ userRequested: true });
    for (let i = 20; i <= 31; i++) h.branch.push(...round(i, 20));
    await h.settle();
    const results = await h.emit("session_before_compact", { reason: "manual", preparation: { firstKeptEntryId: "a31", tokensBefore: 150_000 } });
    expect(results).toEqual([undefined]);
    expect((await h.ledgerRows()).find((r) => r["kind"] === "rollover_declined")?.["why"]).toBe("stale_notebook_at_cut");
  });

  test("user request still yields the summary to an external compaction owner", async () => {
    const h = harness({ externalCompactionModels: ["p/m"], minReclaimTokens: 40_000 });
    await h.notes({ reviewed: true });
    expect(await h.newContext({ userRequested: true })).toContain("external compaction owner");
    await expect(h.newContext()).rejects.toThrow(/already scheduled/);
    await expect(h.newContext({ userRequested: true })).rejects.toThrow(/already scheduled/);
    await h.settle();
    expect(h.compactions()).toBe(1);
    expect(await h.emit("session_before_compact", { reason: "manual", preparation: { firstKeptEntryId: "a10", tokensBefore: 84_000 } })).toEqual([undefined]);
    expect((await h.ledgerRows()).find((r) => r["kind"] === "gate" && r["ok"] === true)?.["reason"]).toBe("user");
    expect((await h.ledgerRows()).some((r) => r["kind"] === "rollover")).toBe(false);
  });

  test.each([false, true])("user request still yields to customInstructions (external owner: %s)", async (external) => {
    const h = harness({ autoRollover: false, externalCompactionModels: external ? ["p/m"] : [] });
    await h.newContext({ userRequested: true });
    const results = await h.emit("session_before_compact", {
      reason: "manual",
      customInstructions: "Focus on the parser API.",
      preparation: { firstKeptEntryId: "a10", tokensBefore: 84_000 },
    });
    expect(results).toEqual([undefined]);
    expect((await h.ledgerRows()).some((r) => r["kind"] === "rollover")).toBe(false);
  });
});

describe("user abort (ESC) before settle", () => {
  // Real session 01a0c846… 2026-09-22 09:35–09:38: notes armed a host schedule, the model kept
  // working, the user pressed ESC; settle still compacted and the continuation restarted work.
  test("cancels a pending host schedule: no compact, no continuation; ledger says user_abort; next run's notes re-arm", async () => {
    const h = harness();
    expect(await h.notes({ sections: { Task: "parser", Next: "x" } })).toContain("Rollover scheduled by the host");
    h.abort();
    // pi-error-auto may rewrite the aborted message into stopReason "error"; the signal is what counts.
    await h.turnEnd({ role: "assistant", stopReason: "error" }, "error");
    await h.emit("agent_end", { messages: [] });
    await h.settle();
    expect(h.compactions()).toBe(0);
    expect(h.sent.some((m) => m.customType === "note-context/continue")).toBe(false);
    const cancelled = (await h.ledgerRows()).find((r) => r["kind"] === "rollover_cancelled");
    expect(cancelled?.["reason"]).toBe("host");
    expect(cancelled?.["why"]).toBe("user_abort");
    await h.startRun();
    expect(await h.notes({ sections: { Next: "resume" } })).toContain("Rollover scheduled by the host");
    await h.settle();
    expect(h.compactions()).toBe(1);
  });

  test("abort seen only at agent_end (ESC during a tool) also cancels", async () => {
    const h = harness();
    await h.notes({ sections: { Task: "parser", Next: "x" } });
    h.abort();
    await h.emit("agent_end", { messages: [] });
    await h.settle();
    expect(h.compactions()).toBe(0);
  });

  test("cancels a model new_context schedule too", async () => {
    const h = harness({ autoRollover: false });
    await h.notes({ sections: { Task: "parser", Next: "x" } });
    expect(await h.newContext()).toContain("rollover scheduled");
    h.abort();
    await h.turnEnd();
    await h.settle();
    expect(h.compactions()).toBe(0);
    expect((await h.ledgerRows()).find((r) => r["kind"] === "rollover_cancelled")?.["why"]).toBe("user_abort");
  });

  test("a user-requested rollover survives the abort", async () => {
    const h = harness({ autoRollover: false });
    await h.notes({ sections: { Task: "parser", Next: "x" } });
    await h.newContext({ userRequested: true });
    h.abort();
    await h.turnEnd();
    await h.settle();
    expect(h.compactions()).toBe(1);
  });

  test("an aborted turn in the fallback zone does not steer a maintenance request", async () => {
    const h = harness({ autoRollover: false });
    h.usage.tokens = 375_000;
    h.abort();
    await h.turnEnd();
    expect(h.sent.some((m) => m.customType === "note-context/maintenance")).toBe(false);
    expect(h.sent.some((m) => m.customType === "note-context/reminder")).toBe(false);
  });
});

describe("split thresholds: reminder budget vs. fallback budget", () => {
  test("host auto-rollover is allowed only from the reminder threshold", async () => {
    const h = harness();
    h.usage.tokens = 300_000; // 75% of 400K, below the reminder threshold (~359.6K)
    expect(await h.notes({ sections: { Task: "parser", Next: "x" } })).not.toContain("Rollover scheduled by the host");
    expect((await h.ledgerRows()).find((r) => r["kind"] === "gate" && r["auto"] === true)?.["blocker"]).toBe("low_pressure");
    h.usage.tokens = 365_000;
    expect(await h.notes({ sections: { Next: "y" } })).toContain("Rollover scheduled by the host");
  });

  test("fallbackBudgetTokens moves only the forced fallback; the reminder stays on budgetTokens", async () => {
    const h = harness({ autoRollover: false, budgetTokens: 400_000, fallbackBudgetTokens: 800_000 });
    h.usage.tokens = 375_000; // past the 400K fallback line, but fallback now sits at 800K − 16384 − 12000
    await h.turnEnd();
    expect(h.sent.some((m) => m.customType === "note-context/maintenance")).toBe(false);
    const reminder = h.sent.find((m) => m.customType === "note-context/reminder") as { content?: string } | undefined;
    expect(reminder?.content).toContain("~397K tokens before forced rollover"); // 800K − 16384 − 12000 − 375K
    h.usage.tokens = 780_000;
    await h.turnEnd();
    expect(h.sent.some((m) => m.customType === "note-context/maintenance")).toBe(true);
  });
});

describe("boundary rollover interop (review 2026-09-23)", () => {
  /** Fallback zone + stale host schedule → maintenance request, as in the fallback test above. */
  async function intoMaintenance(config: Record<string, unknown> = {}) {
    const h = harness(config);
    h.usage.tokens = 375_000;
    await h.turnEnd();
    expect(h.sent.some((m) => m.customType === "note-context/maintenance")).toBe(true);
    return h;
  }

  test("fallback with an external compaction owner goes through ctx.compact(), not a template boundary", async () => {
    const h = await intoMaintenance({ externalCompactionModels: ["p/m"] });
    await h.notes({ sections: { Next: "checkpoint under pressure" } });
    expect(h.compactCalls.length).toBe(1);
    await h.turnEnd();
    expect(h.boundary.length).toBe(0);
    h.compactCalls[0]!.onComplete?.();
    expect(h.sent.some((m) => m.customType === "note-context/continue")).toBe(true);
  });

  test("fallback yields to another extension's compaction at the same turn_end", async () => {
    const h = await intoMaintenance();
    await h.notes({ sections: { Next: "checkpoint under pressure" } });
    h.piHost.otherCompaction = true;
    await h.turnEnd();
    expect(h.boundary.length).toBe(0);
    expect((await h.ledgerRows()).find((r) => r["kind"] === "rollover_cancelled")?.["why"]).toBe("other_compaction");
  });

  test("a scheduled rollover satisfied by another extension's settle compaction is not compacted again", async () => {
    const h = harness();
    expect(await h.notes({ sections: { Task: "parser", Next: "x" } })).toContain("Rollover scheduled by the host");
    h.piHost.otherCompaction = true;
    await h.settle();
    expect(h.compactions()).toBe(0);
    expect((await h.ledgerRows()).find((r) => r["kind"] === "rollover_cancelled")?.["why"]).toBe("other_compaction");
  });

  test("a rejected boundary proposal records no rollover and hands the schedule to Pi's compaction", async () => {
    const h = harness();
    await h.notes({ sections: { Task: "parser", Next: "x" } });
    h.piHost.rejectBoundary = true;
    await h.settle();
    expect(h.boundary.length).toBe(1); // proposed …
    expect(h.compactCalls.length).toBe(1); // … dropped by Pi → agent_settled compacts through Pi
    const rows = await h.ledgerRows();
    expect(rows.some((r) => r["kind"] === "rollover")).toBe(false);
    expect(rows.find((r) => r["kind"] === "rollover_failed")?.["why"]).toBe("boundary_rejected");
  });

  test("a committed proposal writes the rollover row only once it is persisted", async () => {
    const h = harness();
    await h.notes({ sections: { Task: "parser", Next: "x" } });
    await h.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed" });
    expect((await h.ledgerRows()).some((r) => r["kind"] === "rollover")).toBe(false);
    h.branch.push({ id: "cmpX", parentId: null, timestamp: new Date().toISOString(), type: "compaction", summary: "", firstKeptEntryId: "a10", tokensBefore: 0, details: { kind: ROLLOVER_DETAILS_KIND } } as SessionEntry);
    await h.emit("turn_start");
    expect((await h.ledgerRows()).filter((r) => r["kind"] === "rollover")).toHaveLength(1);
  });
});
