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
import { buildSessionProjection, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { flushLedger } from "../src/ledger.ts";
import { ROLLOVER_DETAILS_KIND } from "../src/history.ts";
import { IDLE_TIDY_CUSTOM_TYPE } from "../src/idle-tidy.ts";
import { withIdleTimers } from "./idle-timer.ts";
import { notebookEntry, rolloverEntry, round, user } from "./fixtures.ts";

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
  const sent: { customType?: string; content?: string; details?: unknown }[] = [];
  const deliveries: unknown[] = [];
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
    sendMessage: (msg: (typeof sent)[number], options: unknown) => {
      sent.push(msg);
      deliveries.push(options);
    },
  } as unknown as ExtensionAPI;
  noteContext(pi);

  const usage = { tokens: 365_000, contextWindow: 1_000_000 }; // reminder zone of the 400K budget (≥ 400K − 16384 − 24000): host rollover allowed
  const state = { model: { provider: "p", id: "m", contextWindow: 1_000_000 }, mode: "print" as ExtensionContext["mode"], busy: false, queued: false };
  // The current run's abort signal, as Pi exposes it on ctx.signal while a run is active.
  const run = { controller: new AbortController() };
  const ctx = {
    cwd: agentDir,
    hasUI: false,
    get mode() { return state.mode; },
    get model() {
      return state.model;
    },
    get signal() {
      return run.controller.signal;
    },
    sessionManager: { getBranch: () => branch, buildContextEntries: () => branch, buildSessionProjection: () => buildSessionProjection(branch.map((e, i) => ({ ...e, parentId: i ? branch[i - 1]!.id : null }))), getSessionId: () => "s1", getLeafId: () => branch[branch.length - 1]?.id ?? null },
    getContextUsage: () => usage,
    isProjectTrusted: () => true,
    isIdle: () => !state.busy,
    hasPendingMessages: () => state.queued,
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
  const history = async (params: unknown) => {
    const r = await tools.get("history")!.execute("call", params, undefined, undefined, ctx);
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
        if (d.type === "custom_message") branch.push({ ...d, id: `msg${++committed}`, parentId: null, timestamp: new Date().toISOString() } as SessionEntry);
      }
    }
  };
  /** An earlier extension's compaction draft already in event.entries. */
  const earlier = () => (piHost.otherCompaction ? [{ type: "compaction", summary: "OTHER", firstKeptEntryId: null }] : []);
  /** turn_end for an assistant message, as Pi emits it after every assistant response. */
  const turnEnd = async (message: Record<string, unknown> = { role: "assistant" }, outcome = "completed") =>
    collect("turn_end", await emit("turn_end", { message, entries: earlier(), continue: false, outcome }));
  const beforeSettle = async (outcome = "completed") =>
    collect("agent_before_settle", await emit("agent_before_settle", { entries: earlier(), continue: false, outcome }));
  /** A continuation reaches turn_start/context before agent_settled; never silently skip it in tidy tests. */
  const nextRequest = async () => {
    await emit("turn_start");
    return emit("context", { messages: ctx.sessionManager.buildSessionProjection().messages });
  };
  /** Tests not inspecting a continuation can go straight to final settlement. */
  const settle = async (outcome = "completed") => {
    await beforeSettle(outcome);
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
  return { branch, ctx, usage, state, emit, notes, history, newContext, turnEnd, settle, beforeSettle, nextRequest, boundary, compactions, piHost, sent, deliveries, compactCalls, ledgerRows, abort, startRun };
}

describe("idle tidy hook policy", () => {
  const beginTidy = async (h: ReturnType<typeof harness>, timers: { fire(): void }[]) => {
    h.state.mode = "rpc";
    await h.emit("input", { source: "rpc" });
    await h.startRun();
    await h.emit("agent_end");
    await h.settle();
    timers.at(-1)!.fire();
    await h.startRun();
  };

  test("timer is unref'ed; tidy defers host auto-rollover/reminders but new_context keeps its gate", async () => withIdleTimers(async (timers) => {
    const h = harness({ idleTidyEnabled: true, jevEnabled: false });
    await beginTidy(h, timers);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ customType: IDLE_TIDY_CUSTOM_TYPE, details: { window: 1 } });
    expect(typeof (h.sent[0]!.details as { requestId: string }).requestId).toBe("string");
    expect(h.deliveries[0]).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    const message = { ...h.sent[0], role: "custom", timestamp: 1 };
    const projected = await h.emit("context", { messages: [message] });
    expect((projected[0] as { messages: unknown[] }).messages[0]).toBe(message);
    expect(await h.notes({ reviewed: true })).not.toContain("Rollover scheduled by the host");
    await h.turnEnd();
    expect(h.sent).toHaveLength(1); // no ordinary reminder
    expect(await h.newContext()).toContain("rollover scheduled");
    await h.beforeSettle();
    const next = JSON.stringify(await h.nextRequest());
    expect(next).toContain("Idle notebook tidy is complete");
    expect(next).toContain("Do not resume any work");
    expect(next).not.toContain("Continue with the notebook's Next action");
    await h.emit("agent_end");
    await h.settle();
    expect(h.compactions()).toBe(1);
    const expired = await h.emit("context", { messages: [message] });
    expect((expired[0] as { messages: { content: string }[] }).messages[0]!.content).toContain("expired; no action required");
    await h.startRun();
    await h.emit("agent_end");
    expect(timers).toHaveLength(1); // continuation cannot loop
  }));

  test("tidy does not bypass low reclaim or freshness; userRequested is not assumed", async () => withIdleTimers(async (timers) => {
    const h = harness({ idleTidyEnabled: true, jevEnabled: false, minReclaimTokens: 1_000_000 });
    await beginTidy(h, timers);
    await h.notes({ reviewed: true });
    await expect(h.newContext()).rejects.toThrow("too little");
    for (let i = 20; i < 32; i++) h.branch.push(...round(i, 20));
    await expect(h.newContext()).rejects.toThrow("notebook predates");
  }));

  test("tidy's high-pressure fallback still guards tools, checkpoints and rolls over at turn_end", async () => withIdleTimers(async (timers) => {
    const h = harness({ idleTidyEnabled: true, jevEnabled: false });
    await beginTidy(h, timers);
    const message = { ...h.sent[0], role: "custom", timestamp: 1 };
    h.usage.tokens = 380_000;
    await h.turnEnd();
    expect(h.sent.some((m) => m.customType === "note-context/maintenance")).toBe(true);
    expect((await h.emit("tool_call", { toolName: "read" }))[0]).toMatchObject({ block: true });
    await h.notes({ reviewed: true });
    await h.turnEnd();
    expect(h.boundary[0]).toMatchObject({ reason: "turn_end", drafts: [{ type: "compaction", details: { reason: "fallback" } }, { type: "custom_message" }] });
    const next = JSON.stringify(await h.nextRequest()); // real continuation, before settlement
    expect(next).toContain("Idle notebook tidy is complete");
    expect(next).toContain("Do not resume any work");
    expect(next).not.toContain("Continue with the notebook's Next action");
    const expired = await h.emit("context", { messages: [message] });
    expect((expired[0] as { messages: { content: string }[] }).messages[0]!.content).toContain("expired; no action required");
    expect(await h.notes({ reviewed: true })).not.toContain("Rollover scheduled by the host");
    await h.emit("agent_end");
    await h.settle();
    expect(timers).toHaveLength(1);
  }));

  test.each(["agent_settled", "input", "session_start", "session_tree", "session_before_switch", "session_before_fork", "session_shutdown", "session_compact", "restart"])("tidy boundary continuation expires after %s without changing the journal", async (expiry) => withIdleTimers(async (timers) => {
    const h = harness({ idleTidyEnabled: true, jevEnabled: false });
    await beginTidy(h, timers);
    await h.notes({ reviewed: true });
    await h.newContext();
    await h.beforeSettle();
    expect(JSON.stringify(await h.nextRequest())).toContain("Do not resume any work");
    const persisted = h.branch.find((e) => e.type === "custom_message" && String(e.content).includes("Idle notebook tidy is complete"))!;
    expect(persisted).toBeDefined();
    const messages = h.ctx.sessionManager.buildSessionProjection().messages;
    if (expiry === "restart") {
      // New extension instance has no volatile scope; replay even before any lifecycle event.
      const restarted = harness({ idleTidyEnabled: true, jevEnabled: false });
      restarted.branch.splice(0, restarted.branch.length, ...h.branch);
      const next = JSON.stringify(await restarted.emit("context", { messages }));
      expect(next).toContain("earlier idle tidy continuation — expired; no action required");
      expect(next).not.toContain("Do not resume any work");
    } else {
      await h.emit(expiry, { source: "rpc", compactionEntry: { details: {} } });
      const next = JSON.stringify(await h.emit("context", { messages }));
      expect(next).toContain("earlier idle tidy continuation — expired; no action required");
      expect(next).not.toContain("Do not resume any work");
    }
    expect(persisted.type === "custom_message" && persisted.content).toContain("Do not resume any work");
  }));

  test("user input between a boundary proposal and its continuation cannot revive tidy", async () => withIdleTimers(async (timers) => {
    const h = harness({ idleTidyEnabled: true, jevEnabled: false });
    await beginTidy(h, timers);
    await h.notes({ reviewed: true });
    await h.newContext();
    await h.beforeSettle();
    await h.emit("input", { source: "rpc" });
    const next = JSON.stringify(await h.nextRequest());
    expect(next).toContain("earlier idle tidy continuation — expired; no action required");
    expect(next).not.toContain("Do not resume any work");
  }));

  test.each(["input", "session_start"])("%s before a compact callback cannot revive the captured tidy policy", async (expiry) => withIdleTimers(async (timers) => {
    const h = harness({ idleTidyEnabled: true, jevEnabled: false, externalCompactionModels: ["p/m"] });
    await beginTidy(h, timers);
    await h.notes({ reviewed: true });
    await h.newContext();
    await h.settle();
    await h.emit(expiry, { source: "rpc" });
    await h.emit("session_compact", { compactionEntry: { details: {} } });
    h.compactCalls[0]!.onComplete!();
    await h.startRun();
    const next = JSON.stringify(await h.emit("context", { messages: [{ ...h.sent.at(-1), role: "custom", timestamp: 1 }] }));
    expect(next).toContain("earlier idle tidy continuation — expired; no action required");
    expect(next).not.toContain("Do not resume any work");
  }));

  test("legacy tidy continuations expire on restart but ordinary continuations are unchanged", async () => {
    const h = harness({ jevEnabled: false });
    const messages = [
      "[note-context] New context window started. Idle notebook tidy is complete. Do not resume any work or execute the notebook's Next action. End this run now.",
      "[note-context] New context window started. Continue with the notebook's Next action.",
      "[note-context] New context window started after the maintenance checkpoint. Continue with the notebook's Next action.",
    ].map((content) => ({ role: "custom", customType: "note-context/continue", content, timestamp: 1 }));
    const result = (await h.emit("context", { messages }))[0] as { messages: { content: string }[] };
    expect(result.messages[0]!.content).toContain("earlier idle tidy continuation — expired; no action required");
    expect(result.messages[1]).toBe(messages[1]);
    expect(result.messages[2]).toBe(messages[2]);
  });

  test("tidy continuation survives settled cleanup on external-owner and declined-boundary compaction", async () => withIdleTimers(async (timers) => {
    for (const external of [false, true]) {
      const h = harness({ idleTidyEnabled: true, jevEnabled: false, externalCompactionModels: external ? ["p/m"] : [] });
      await beginTidy(h, timers);
      await h.notes({ reviewed: true });
      await h.newContext();
      h.piHost.rejectBoundary = !external;
      await h.settle();
      expect(h.compactCalls).toHaveLength(1);
      await h.emit("session_compact", { compactionEntry: { details: {} } });
      h.compactCalls[0]!.onComplete!(); // after settled() has already cleared the tidy request
      const continuation = h.sent.at(-1)!;
      await h.startRun();
      const next = JSON.stringify(await h.emit("context", { messages: [{ ...continuation, role: "custom", timestamp: 1 }] }));
      expect(next).toContain("Idle notebook tidy is complete");
      expect(next).toContain("Do not resume any work");
      expect(next).not.toContain("Continue with the notebook's Next action");
      await h.emit("agent_settled");
      const expired = JSON.stringify(await h.emit("context", { messages: [{ ...continuation, role: "custom", timestamp: 1 }] }));
      expect(expired).toContain("earlier idle tidy continuation — expired; no action required");
      expect(expired).not.toContain("Do not resume any work");
    }
  }));

  test("external fallback continuation stays live across the previous run's settlement", async () => withIdleTimers(async (timers) => {
    const h = harness({ idleTidyEnabled: true, jevEnabled: false, externalCompactionModels: ["p/m"] });
    await beginTidy(h, timers);
    h.usage.tokens = 380_000;
    await h.turnEnd();
    await h.notes({ reviewed: true });
    expect(h.compactCalls).toHaveLength(1);
    await h.emit("session_compact", { compactionEntry: { details: {} } });
    h.compactCalls[0]!.onComplete!();
    await h.emit("agent_settled"); // queued continuation has not reached context yet
    await h.startRun();
    const messages = [{ ...h.sent.at(-1), role: "custom", timestamp: 1 }];
    const next = JSON.stringify(await h.emit("context", { messages }));
    expect(next).toContain("Do not resume any work");
    await h.emit("agent_settled");
    const expired = JSON.stringify(await h.emit("context", { messages }));
    expect(expired).toContain("earlier idle tidy continuation — expired; no action required");
    expect(expired).not.toContain("Do not resume any work");
  }));

  test("final settlement expires tidy in the same window; extension input cannot re-arm but genuine input can", async () => withIdleTimers(async (timers) => {
    const h = harness({ idleTidyEnabled: true, jevEnabled: false });
    await beginTidy(h, timers);
    const message = { ...h.sent[0], role: "custom", timestamp: 1 };
    await h.emit("agent_end");
    await h.settle();
    expect(timers).toHaveLength(1);
    const expired = await h.emit("context", { messages: [message] });
    expect((expired[0] as { messages: { content: string }[] }).messages[0]!.content).toContain("expired; no action required");
    await h.emit("input", { source: "extension" });
    await h.startRun();
    await h.emit("agent_end");
    await h.settle();
    expect(timers).toHaveLength(1);
    await h.emit("input", { source: "rpc" });
    await h.startRun();
    expect(await h.notes({ reviewed: true })).toContain("Rollover scheduled by the host");
    await h.emit("agent_end");
    expect(timers).toHaveLength(2);
    expect(timers[1]!.handle.hasRef()).toBe(false);
  }));

  test("user input during tidy supersedes it and re-enables the normal reminder", async () => withIdleTimers(async (timers) => {
    const h = harness({ idleTidyEnabled: true, jevEnabled: false });
    await beginTidy(h, timers);
    await h.emit("input", { source: "rpc" });
    await h.turnEnd();
    expect(h.sent.some((m) => m.customType === "note-context/reminder")).toBe(true);
    await h.emit("agent_end");
    expect(timers).toHaveLength(2);
  }));

  test("only tui/rpc opt-in sessions arm; shutdown/session replacement/agent_start/input cancel", async () => withIdleTimers(async (timers) => {
    for (const mode of ["print", "json", "tui", "rpc"] as const) {
      for (const enabled of [false, true]) {
        const h = harness({ idleTidyEnabled: enabled, jevEnabled: false });
        h.state.mode = mode;
        await h.emit("session_start");
        await h.emit("input", { source: mode === "rpc" ? "rpc" : "interactive" });
        await h.startRun();
        const count = timers.length;
        await h.emit("agent_end");
        expect(timers.length - count).toBe(enabled && (mode === "tui" || mode === "rpc") ? 1 : 0);
        await h.emit("session_shutdown");
      }
    }
    for (const event of ["agent_start", "before_agent_start", "input", "session_start", "session_before_switch", "session_before_fork", "session_tree", "session_shutdown"]) {
      const h = harness({ idleTidyEnabled: true, jevEnabled: false });
      h.state.mode = "rpc";
      await h.emit("input", { source: "rpc" });
      await h.emit("agent_end");
      const timer = timers.at(-1)!;
      expect(timer.handle.hasRef()).toBe(false);
      await h.emit(event, { source: "rpc", systemPromptOptions: {} });
      timer.fire(); // emulate a callback already dispatched when cancellation happened
      expect(h.sent).toEqual([]);
    }
  }));

  test("deadline checks pending/busy/aborted state before sending", async () => withIdleTimers(async (timers) => {
    for (const reason of ["busy", "queued", "aborted"]) {
      const h = harness({ idleTidyEnabled: true, jevEnabled: false });
      h.state.mode = "rpc";
      await h.emit("input", { source: "rpc" });
      if (reason === "aborted") h.abort();
      await h.emit("agent_end");
      if (reason === "busy") h.state.busy = true;
      if (reason === "queued") h.state.queued = true;
      timers.at(-1)!.fire();
      expect(h.sent).toEqual([]);
    }
  }));
});

describe("history tool wiring", () => {
  test("search includes originals by default; explicit includeActive:false opts into canonical filtering", async () => {
    const h = harness({ jevEnabled: false });
    expect(await h.history({ query: "nested comments" })).toContain("[history entry=u1]");
    expect(await h.history({ query: "nested comments", includeActive: false })).toContain("0 hits");
    expect(await h.history({ query: "nested comments", includeActive: false })).toContain("Skipped 1");
    expect(await h.history({ query: ["NESTED COMMENTS", "absent"], includeActive: true, from: "newest" })).toContain("[history entry=u1]");
    expect(await h.history({ id: "u1", context: 0 })).toContain("Refactor the parser");
    await expect(h.history({ query: [] })).rejects.toThrow("non-empty");
  });
});

describe("rollover reminder context scope", () => {
  test("current reminder stays live; retained and legacy reminders expire without changing the journal", async () => {
    const h = harness({ entryIdTrailers: false, jevEnabled: false });
    await h.turnEnd();
    const sent = h.sent.find((m) => m.customType === "note-context/reminder") as { customType: string; content: string; details: { window: number } };
    expect(sent).toMatchObject({ details: { window: 1 } });
    const reminder = { ...sent, role: "custom", timestamp: 1 };
    const legacy = { ...reminder, details: undefined };
    const other = { role: "custom", customType: "other", content: "keep", timestamp: 2 };
    const project = async () => {
      const results = await h.emit("context", { messages: [reminder, legacy, other] });
      return (results[0] as { messages: { content: string }[] }).messages;
    };
    const before = await project();
    expect(before[0]).toBe(reminder);
    expect(before[1]!.content).toContain("expired; no action required");
    h.branch.push(rolloverEntry("r2", "a10", 2));
    const after = await project();
    expect(after[0]!.content).toBe("[note-context] (earlier rollover reminder — expired; no action required)");
    expect(after[2]).toBe(other);
    expect(sent).toMatchObject({ content: expect.stringContaining("Then call new_context") });
    // Returning along the session tree to the original window makes its scoped reminder live.
    h.branch.pop();
    expect((await project())[0]).toBe(reminder);
  });
});

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
    await expect(h.newContext()).rejects.toThrow(/too little would leave the window/);
    await expect(h.newContext({ userRequested: false })).rejects.toThrow(/too little would leave the window/);
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
    expect(reminder?.content).toContain("A context-window rollover is due.");
    expect(reminder?.content).not.toMatch(/\d+K|tokens/); // no countdown: the host owns timing
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

describe("status line on tool results: notes staleness only", () => {
  const result = async (h: ReturnType<typeof harness>) => {
    const [r] = await h.emit("tool_result", { toolName: "bash", isError: false, content: [{ type: "text", text: "out" }] });
    return (r as { content?: { text: string }[] } | undefined)?.content?.[0]?.text;
  };
  test("overall usage never shows it; tokens since the last review do, without any figures", async () => {
    const h = harness({ autoRollover: false, statusStepTokens: 40_000 });
    h.usage.tokens = 100_000;
    await h.notes({ sections: { Task: "parser", Next: "x" } }); // reviewed at 100K
    for (const t of [101_000, 121_000, 139_000]) {
      h.usage.tokens = t; // crosses usage steps 2 → 3 without going stale
      expect(await result(h)).toBeUndefined();
    }
    h.usage.tokens = 141_000;
    const line = await result(h);
    expect(line).toContain("[note-context] notes rev 2 not reviewed for a while");
    expect(line).not.toMatch(/\d+(\.\d+)?\s*[KkMm]\b|\d{4,}|\btokens?\b|\bbudget\b|\bwindow\b/);
    expect(await result(h)).toBeUndefined(); // once per staleness step
  });
  test("after a rollover, staleness counts from the new window's start", async () => {
    const h = harness({ autoRollover: false, statusStepTokens: 40_000 });
    h.usage.tokens = 360_000;
    await h.notes({ sections: { Task: "parser", Next: "x" } }); // reviewed at 360K
    expect(await h.newContext({ userRequested: true })).toContain("rollover scheduled");
    await h.settle();
    for (const t of [25_000, 45_000, 64_000]) {
      h.usage.tokens = t;
      expect(await result(h)).toBeUndefined();
    }
    h.usage.tokens = 66_000; // 41K into the new window
    expect(await result(h)).toContain("not reviewed for a while");
  });
});
