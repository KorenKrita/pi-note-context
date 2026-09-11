/**
 * Extension-hook timing for the host-initiated rollover (DESIGN.md §15):
 * notes write → gate passes → pending → more work lands → agent_settled.
 * The pending rollover must be re-checked against the current cut before
 * ctx.compact() runs; a stale one is cancelled and recorded, never handed to
 * Pi's LLM summary. Isolated config + ledger under a temp PI_CODING_AGENT_DIR.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { flushLedger } from "../src/ledger.ts";
import { notebookEntry, round, user } from "./fixtures.ts";

const tmp = mkdtempSync(join(tmpdir(), "note-context-settled-"));
const savedEnv = { dir: process.env["PI_CODING_AGENT_DIR"], ledger: process.env["NOTE_CONTEXT_LEDGER_DISABLED"] };
process.env["PI_CODING_AGENT_DIR"] = tmp;
delete process.env["NOTE_CONTEXT_LEDGER_DISABLED"];
const { default: noteContext } = await import("../src/index.ts");

afterAll(() => {
  if (savedEnv.dir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = savedEnv.dir;
  if (savedEnv.ledger === undefined) delete process.env["NOTE_CONTEXT_LEDGER_DISABLED"];
  else process.env["NOTE_CONTEXT_LEDGER_DISABLED"] = savedEnv.ledger;
  rmSync(tmp, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;
type Tool = { name: string; execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<{ content: { type: string; text: string }[] }> };

function harness() {
  const branch: SessionEntry[] = [user("u1", "Refactor the parser to support nested comments.")];
  for (let i = 1; i <= 10; i++) branch.push(...round(i, 20)); // ~50K tokens of old tool output
  branch.push(notebookEntry("n0", 1, { Task: "parser" }, "a10"));
  branch.push(...round(11, 2));

  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const compactCalls: { onComplete?: () => void; onError?: (e: Error) => void }[] = [];
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
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  noteContext(pi);

  const usage = { tokens: 250_000, contextWindow: 1_000_000 }; // 62% of the 400K budget: above the host floor
  const ctx = {
    cwd: tmp,
    hasUI: false,
    model: { provider: "p", id: "m", contextWindow: 1_000_000 },
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
    for (const h of handlers.get(ev) ?? []) await h(event, ctx);
  };
  const notes = async (params: unknown) => {
    const r = await tools.get("notes")!.execute("call", params, undefined, undefined, ctx);
    return r.content.map((c) => c.text).join("\n");
  };
  return { branch, ctx, emit, notes, compactCalls };
}

const ledgerRows = async () => {
  await flushLedger();
  try {
    return readFileSync(join(tmp, "state", "note-context-ledger.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
};

beforeEach(() => rmSync(join(tmp, "state"), { recursive: true, force: true }));

describe("host rollover: re-check at agent_settled", () => {
  test("valid pending compacts exactly once; a second settle does nothing", async () => {
    const h = harness();
    const out = await h.notes({ sections: { Task: "parser", Next: "edit parseComment" } });
    expect(out).toContain("Rollover scheduled by the host");
    await h.emit("agent_settled");
    expect(h.compactCalls.length).toBe(1);
    await h.emit("agent_settled");
    expect(h.compactCalls.length).toBe(1);
  });

  test("pending that went stale before settle is cancelled, ctx.compact is not called, ledger says why; next notes re-arms", async () => {
    const h = harness();
    const out = await h.notes({ sections: { Task: "parser", Next: "edit parseComment" } });
    expect(out).toContain("Rollover scheduled by the host");
    // The model kept working: ~60K tokens land after the review marker, so the actual cut
    // would now drop unreviewed material (the real session 01a08e78… on 2026-09-11 05:08).
    for (let i = 20; i <= 31; i++) h.branch.push(...round(i, 20));
    await h.emit("agent_settled");
    expect(h.compactCalls.length).toBe(0);
    const rows = await ledgerRows();
    const cancelled = rows.find((r) => r["kind"] === "rollover_cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled?.["reason"]).toBe("host");
    expect(cancelled?.["why"]).toBe("stale_notebook");
    // A fresh notes write re-arms the host rollover and it runs on the next settle.
    const again = await h.notes({ sections: { Next: "resume after re-check" } });
    expect(again).toContain("Rollover scheduled by the host");
    await h.emit("agent_settled");
    expect(h.compactCalls.length).toBe(1);
  });

  test("ctx.compact error on a scheduled rollover is recorded", async () => {
    const h = harness();
    await h.notes({ sections: { Task: "parser", Next: "x" } });
    await h.emit("agent_settled");
    expect(h.compactCalls.length).toBe(1);
    h.compactCalls[0]!.onError?.(new Error("Nothing to compact (session too small)"));
    const rows = await ledgerRows();
    const failed = rows.find((r) => r["kind"] === "rollover_failed");
    expect(failed?.["reason"]).toBe("host");
    expect(String(failed?.["error"])).toContain("Nothing to compact");
  });
});
