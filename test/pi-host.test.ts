/**
 * Runs the extension inside a real Pi AgentSession driven by a faux provider, so host
 * contracts (prompt sections, boundary drafts, continuation) are checked against Pi itself
 * rather than a hand-written harness.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

const tmpRoot = mkdtempSync(join(tmpdir(), "note-context-host-"));
const savedDir = process.env["PI_CODING_AGENT_DIR"];
afterAll(() => {
  if (savedDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = savedDir;
});
let runs = 0;

async function host(responses: (seen: TranscriptContext[]) => FauxResponseStep[], config: Record<string, unknown> = {}, contextWindow = 200_000, before: ExtensionFactory[] = []) {
  const agentDir = join(tmpRoot, `agent-${++runs}`);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "pi-note-context.json"), JSON.stringify(config));
  // Read by the extension's compactionSettings(): a small kept tail. Pi keeps the entry that crosses keepRecentTokens, so tests put a ~5K `dump` result between the bulk and the tail.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 1_000, keepRecentTokens: 2_000 } }));
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  const { default: noteContext } = await import("../src/index.ts");

  const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow }] });
  const seen: TranscriptContext[] = [];
  faux.setResponses(responses(seen));
  const resourceLoader = new DefaultResourceLoader({
    cwd: tmpRoot, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      ...before,
      noteContext,
      (pi) =>
        pi.registerTool({
          name: "dump", label: "dump", description: "test output", parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text", text: "output ".repeat(3_000) }], details: {} }),
        }),
    ],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  modelRuntime.registerNativeProvider(faux.provider);
  (modelRuntime as unknown as { hasConfiguredAuth: () => boolean }).hasConfiguredAuth = () => true;
  const sessionManager = SessionManager.inMemory(tmpRoot);
  const { session } = await createAgentSession({
    cwd: tmpRoot, agentDir, model: faux.getModel(), thinkingLevel: "off", modelRuntime, resourceLoader, sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });
  // Session events in order, reduced to what the rollover tests compare.
  const events: string[] = [];
  session.subscribe((e) => {
    if (e.type === "agent_settled" || e.type === "agent_start") events.push(e.type);
    if (e.type === "entry_appended" && e.entry.type === "compaction") events.push("compaction");
  });
  return { session, sessionManager, seen, faux, events };
}

const record = (seen: TranscriptContext[], step: FauxResponseStep): FauxResponseStep => (ctx, ...rest) => {
  seen.push(structuredClone(ctx));
  return typeof step === "function" ? step(ctx, ...rest) : step;
};

describe("Pi host integration", () => {
  test("guidance is added as a structured system prompt section, not a forced prompt", async () => {
    const { session, seen } = await host((s) => [record(s, fauxAssistantMessage("ok"))]);
    await session.prompt("hello");
    session.dispose();
    const system = seen[0]!.messages[0] as { role: string; sections?: Record<string, string> };
    expect(system.role).toBe("system");
    expect(system.sections?.["note_context"]).toContain("Working notes across context windows");
  });

  test("guidance still reaches the provider when an earlier extension forces the whole system prompt", async () => {
    const { session, seen } = await host((s) => [record(s, fauxAssistantMessage("ok"))], {}, 200_000, [
      (pi) => {
        pi.on("before_agent_start", () => ({ systemPrompt: "FORCED BASE" }));
      },
    ]);
    await session.prompt("hello");
    session.dispose();
    const text = JSON.stringify(seen[0]!.messages);
    expect(text).toContain("FORCED BASE");
    expect(text.split("Working notes across context windows")).toHaveLength(2);
  });

  const text = (ctx: TranscriptContext) => JSON.stringify(ctx.messages);
  const LONG = "filler ".repeat(22_000); // ~40K tokens by Pi's chars/4 estimate
  /** The first user message is always pinned whole into a rollover summary, so the bulk arrives as a later message. */
  const promptLong = async (session: { prompt(text: string): Promise<void>; waitForIdle(): Promise<void> }) => {
    await session.prompt("Refactor the parser.");
    await session.prompt(`Here is the input dump: ${LONG}`);
    await session.waitForIdle();
  };

  test("model new_context rolls over at agent_before_settle: one settle, compaction before it, continuation in the new window", async () => {
    const { session, sessionManager, seen, events } = await host(
      (s) => [
        record(s, fauxAssistantMessage("Ready.")),
        record(s, fauxAssistantMessage(fauxToolCall("dump", {}), { stopReason: "toolUse" })),
        record(s, fauxAssistantMessage(fauxToolCall("notes", { sections: { Task: "parser", Next: "edit parseComment" } }), { stopReason: "toolUse" })),
        record(s, fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" })),
        record(s, fauxAssistantMessage("Ending the turn for the rollover.")),
        record(s, fauxAssistantMessage("Continuing from the notebook.")),
      ],
      { autoRollover: false, minReclaimTokens: 1_000 },
    );
    await promptLong(session);
    session.dispose();

    expect(seen).toHaveLength(6);
    expect(events.filter((e) => e === "agent_settled")).toHaveLength(2); // first prompt, then the rollover run
    expect(events.indexOf("compaction")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("compaction")).toBeLessThan(events.lastIndexOf("agent_settled"));
    expect(events.slice(events.indexOf("compaction"))).toEqual(["compaction", "agent_start", "agent_settled"]); // continued before settling
    const next = text(seen[5]!);
    expect(next).toContain("edit parseComment"); // notebook carried in the rollover summary
    expect(next).toContain("New context window started");
    expect(next.length).toBeLessThan(text(seen[4]!).length / 2); // the long prompt left the window
    const compaction = sessionManager.getBranch().find((e) => e.type === "compaction") as { details?: { reason?: string } } | undefined;
    expect(compaction?.details?.reason).toBe("model");
  });

  test("fallback rollover lands at the checkpoint's turn_end without aborting the run", async () => {
    const { session, sessionManager, seen, events } = await host(
      (s) => [
        record(s, fauxAssistantMessage("Ready.")),
        record(s, fauxAssistantMessage(fauxToolCall("dump", {}), { stopReason: "toolUse" })),
        record(s, fauxAssistantMessage(fauxToolCall("notes", { sections: { Task: "parser", Next: "checkpoint under pressure" } }), { stopReason: "toolUse" })),
        record(s, fauxAssistantMessage("Continuing in the new window.")),
      ],
      { budgetTokens: 40_000, fallbackBudgetTokens: 40_000, fallbackBufferTokens: 1_000, autoRollover: false },
      60_000,
    );
    await promptLong(session);
    session.dispose();

    expect(text(seen[2]!)).toContain("[note-context]"); // the maintenance request was steered in
    expect(seen).toHaveLength(4);
    expect(events.filter((e) => e === "agent_start")).toHaveLength(2); // first prompt, then the long one: no restart
    expect(events.slice(events.indexOf("compaction"))).toEqual(["compaction", "agent_settled"]);
    const branch = sessionManager.getBranch();
    expect(branch.some((e) => e.type === "message" && e.message.role === "assistant" && e.message.stopReason === "aborted")).toBe(false);
    const compaction = branch.find((e) => e.type === "compaction") as { details?: { reason?: string } } | undefined;
    expect(compaction?.details?.reason).toBe("fallback");
    const next = text(seen[3]!);
    expect(next).toContain("checkpoint under pressure");
    expect(next).toContain("New context window started after the maintenance checkpoint");
    expect(next.length).toBeLessThan(text(seen[2]!).length / 2);
  });
});
