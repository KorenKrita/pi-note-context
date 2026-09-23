/**
 * Runs the extension inside a real Pi AgentSession driven by a faux provider, so host
 * contracts (prompt sections, boundary drafts, continuation) are checked against Pi itself
 * rather than a hand-written harness.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const tmpRoot = mkdtempSync(join(tmpdir(), "note-context-host-"));
const savedDir = process.env["PI_CODING_AGENT_DIR"];
afterAll(() => {
  if (savedDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = savedDir;
});
let runs = 0;

async function host(responses: (seen: TranscriptContext[]) => FauxResponseStep[], config: Record<string, unknown> = {}) {
  const agentDir = join(tmpRoot, `agent-${++runs}`);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "pi-note-context.json"), JSON.stringify(config));
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  const { default: noteContext } = await import("../src/index.ts");

  const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 200_000 }] });
  const seen: TranscriptContext[] = [];
  faux.setResponses(responses(seen));
  const resourceLoader = new DefaultResourceLoader({
    cwd: tmpRoot, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [noteContext],
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
  return { session, sessionManager, seen, faux };
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
});
