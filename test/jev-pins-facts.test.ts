import { describe, expect, test } from "bun:test";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { classifyUserMessage, DEFAULT_JEV, JEV_STATE_MAX_CHARS, resolveApiKey, unrecordedDecisionProbability, type UserKind } from "../src/jev.ts";
import { extractFacts, indexText, pinUserMessages, renderRolloverSummary } from "../src/rollover.ts";
import { reconstructNotebook } from "../src/notebook.ts";
import { assistant, notebookEntry, toolResult, user } from "./fixtures.ts";

const withDetails = (e: SessionEntry, details: unknown, isError = false): SessionEntry => {
  const m = (e as { message: Record<string, unknown> }).message;
  return { ...e, message: { ...m, details, isError } } as SessionEntry;
};

const NOTIFY = "Delegated task node:delegated-task:command%3Amcp%3Aabc%3Adelegate-task%3Ax (pi-error-auto: skip permanent errors) [completed]:\n**Conclusion** long body ...";

describe("pinUserMessages with Jev kinds", () => {
  const opts = { messageMaxChars: 50, totalMaxTokens: 4096, indexMaxTokens: 3072 };

  test("kinds shape each pin; notifications are one line and the first user message stays verbatim", () => {
    const dropped = [
      user("n0", NOTIFY),
      user("u1", "Why is it slow?\nsecond line of the question"),
      user("u2", `Keep the public API stable. ${"Rationale. ".repeat(10)}`),
      assistant("a1", "Should I also drop the legacy flag? It is unused."),
      user("u3", "ok do it"),
      user("u4", "Why does this keep breaking?\nugh"),
      user("u5", `Some context ${"x".repeat(100)}`),
    ];
    const kinds = new Map<string, UserKind>([["u1", "ask"], ["u2", "decide"], ["u3", "ack"], ["u4", "vent"], ["u5", "inform"]]);
    const pinned = pinUserMessages(dropped, opts, kinds);
    const by = Object.fromEntries(pinned.map((p) => [p.id, p]));
    expect(by["n0"]?.text).toBe("[subagent result] pi-error-auto: skip permanent errors [completed]");
    expect(by["u1"]?.text).toBe("Why is it slow?\nsecond line of the question"); // first real message: verbatim despite `ask`
    expect(by["u2"]?.text.length).toBeGreaterThan(50); // decisions keep up to 4× messageMaxChars
    expect(by["u2"]?.truncated).toBe(false);
    expect(by["u3"]?.text).toContain("(answering assistant: Should I also drop the legacy flag?");
    expect(by["u4"]?.text).toBe("Why does this keep breaking?");
    expect(by["u5"]?.text.length).toBeLessThanOrEqual(51);
  });

  test("over budget, informational pins collapse before decisions, oldest first", () => {
    const long = (s: string) => `${s}\n${"detail ".repeat(60)}`;
    const dropped = [user("u0", "start"), user("d1", long("decision one")), user("i1", long("info one")), user("i2", long("info two"))];
    const kinds = new Map<string, UserKind>([["d1", "decide"], ["i1", "inform"], ["i2", "inform"]]);
    const pinned = pinUserMessages(dropped, { messageMaxChars: 5000, totalMaxTokens: 150, indexMaxTokens: 3072 }, kinds);
    const by = Object.fromEntries(pinned.map((p) => [p.id, p]));
    expect(by["i1"]?.text).toBe("info one");
    expect(by["d1"]?.truncated).toBe(false);
  });

  test("the index tags the current notification format", () => {
    expect(indexText(user("n", NOTIFY))).toBe("[delegated task result]");
  });
});

describe("extractFacts", () => {
  const home = process.env["HOME"]!;
  const dropped = [
    assistant("a1", "", [{ id: "c1", name: "replace", args: {} }, { id: "c2", name: "write", args: { path: "/tmp/new.ts" } }, { id: "c3", name: "bash", args: { command: "git commit -m x" } }, { id: "c6", name: "read", args: {} }, { id: "c7", name: "read", args: { path: "/skills/review/SKILL.md" } }, { id: "c8", name: "read", args: { path: "/skills/review/reviewer.md" } }]),
    withDetails(toolResult("t1", "c1", "replace", "ok"), { snapshotId: `v2|${home}/repo/src/a.ts|1|2|3|4` }),
    toolResult("t2", "c2", "write", "Successfully wrote"),
    toolResult("t3", "c3", "bash", "[main 1a2b3c4] feat: add parser\n 1 file changed\n[feat/x (root-commit) 9f8e7d6] init\n[detached HEAD 5e6f7a8] wip"),
    toolResult("t6", "c6", "read", "Example:\n[main 0000aaa] not a real commit"),
    toolResult("t7", "c7", "read", "# Review skill"),
    toolResult("t8", "c8", "read", "reviewer prompt"),
    withDetails(toolResult("t4", "c4", "ask_user_question", "answered"), { answers: [{ question: "Which tier?", answer: "standard" }] }),
    withDetails(toolResult("t5", "c1", "replace", "failed"), { snapshotId: "v2|/tmp/failed.ts|1" }, true),
  ];

  test("files, commits and answers come from tool results; errors are ignored", () => {
    const facts = extractFacts(dropped);
    expect(facts.files).toEqual(["~/repo/src/a.ts", "/tmp/new.ts"]);
    expect(facts.commits).toEqual(["1a2b3c4 feat: add parser (main)", "9f8e7d6 init (feat/x)", "5e6f7a8 wip (detached HEAD)"]); // not the `read` example
    expect(facts.answers).toEqual(["Which tier? → standard"]);
    expect(facts.skills).toEqual(["/skills/review/SKILL.md"]); // only SKILL.md, not other reads
  });

  test("the rollover summary renders them in their own section", () => {
    const branch = [notebookEntry("nb", 1, { Task: "t" }, null)];
    const summary = renderRolloverSummary({ window: 2, reason: "model", notebook: reconstructNotebook(branch), pinned: [], facts: extractFacts(dropped) });
    expect(summary).toContain("## Facts from the dropped range");
    expect(summary).toContain("Commit: 1a2b3c4 feat: add parser (main)");
    expect(summary).toContain("User answered: Which tier? → standard");
    expect(summary).toContain("Skills read (their text left the window; re-read one before following it): /skills/review/SKILL.md");
  });
});

describe("Jev calls", () => {
  const ctxWith = (registry: Record<string, unknown>) => ({ modelRegistry: registry }) as unknown as ExtensionContext;

  test("classifyUserMessage returns the choice, and null without the classifier API", async () => {
    const ctx = ctxWith({ findOfType: () => ({}), classify: async () => ({ stopReason: "stop", answers: { kind: { type: "choice", choice: "decide", probabilities: {} } } }) });
    expect(await classifyUserMessage(ctx, DEFAULT_JEV, "from now on use standard")).toBe("decide");
    expect(await classifyUserMessage(ctxWith({}), DEFAULT_JEV, "x")).toBeNull();
  });

  test("a hung classifier times out to null", async () => {
    const ctx = ctxWith({
      findOfType: () => ({}),
      classify: (_m: unknown, _c: unknown, o: { signal: AbortSignal }) => new Promise((_r, reject) => o.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    });
    expect(await classifyUserMessage(ctx, { ...DEFAULT_JEV, timeoutMs: 20 }, "x")).toBeNull();
    const late = ctxWith({
      findOfType: () => ({}),
      classify: () => new Promise((resolve) => setTimeout(() => resolve({ stopReason: "stop", answers: { kind: { type: "choice", choice: "decide", probabilities: {} } } }), 80)),
    });
    expect(await classifyUserMessage(late, { ...DEFAULT_JEV, timeoutMs: 20 }, "x")).toBeNull(); // ignores the abort: the deadline still wins
    expect(await classifyUserMessage(ctxWith({ findOfType: () => { throw new Error("boom"); }, classify: async () => ({}) }), DEFAULT_JEV, "x")).toBeNull();
  });

  test("model and apiKey reach the registry; a baseUrl calls the typesafe provider directly with the registry model as template", async () => {
    const decide = { stopReason: "stop", answers: { kind: { type: "choice", choice: "decide", probabilities: {} } } };
    const seen: unknown[] = [];
    const registry = {
      findOfType: (_t: string, p: string, id: string) => (seen.push(["find", p, id]), { id, provider: p, baseUrl: "http://registry", cost: {} }),
      classify: async (m: unknown, _c: unknown, o: Record<string, unknown>) => (seen.push(["registry", (m as { id: string }).id, o["apiKey"]]), decide),
      getProvider: (id: string) => ({ classify: async (m: unknown, _c: unknown, o: Record<string, unknown>) => (seen.push(["provider", id, m, o["apiKey"]]), decide) }),
    };
    process.env["NC_TEST_KEY"] = "from-env";
    try {
      expect(await classifyUserMessage(ctxWith(registry), { ...DEFAULT_JEV, model: "jev-x", apiKey: "$NC_TEST_KEY" }, "x")).toBe("decide");
      expect(seen).toEqual([["find", "typesafe", "jev-x"], ["registry", "jev-x", "from-env"]]);
      seen.length = 0;
      expect(await classifyUserMessage(ctxWith(registry), { ...DEFAULT_JEV, model: "jev-x", baseUrl: "http://custom/v1", apiKey: "k" }, "x")).toBe("decide");
      expect(seen[1]).toEqual(["provider", "typesafe", { id: "jev-x", provider: "typesafe", baseUrl: "http://custom/v1", cost: {} }, "k"]);
      const { getProvider: _drop, ...noProvider } = registry;
      expect(await classifyUserMessage(ctxWith(noProvider), { ...DEFAULT_JEV, baseUrl: "http://custom/v1" }, "x")).toBeNull();
    } finally {
      delete process.env["NC_TEST_KEY"];
    }
    expect(resolveApiKey("$NC_MISSING")).toBeUndefined();
  });

  test("unrecordedDecisionProbability keeps the newest messages within the state budget", async () => {
    let sent: { notebook: string; new_user_messages: string[] } | undefined;
    const ctx = ctxWith({
      findOfType: () => ({}),
      classify: async (_m: unknown, c: { state: typeof sent }) => ((sent = c.state), { stopReason: "stop", answers: { unrecorded: { type: "bool", probability: 0.9 } } }),
    });
    const msgs = Array.from({ length: 40 }, (_, i) => `m${i} ${"y".repeat(2000)}`);
    expect(await unrecordedDecisionProbability(ctx, DEFAULT_JEV, "n".repeat(50_000), msgs)).toBe(0.9);
    const size = sent!.notebook.length + sent!.new_user_messages.reduce((n, m) => n + m.length, 0);
    expect(size).toBeLessThanOrEqual(JEV_STATE_MAX_CHARS + 50);
    expect(sent!.new_user_messages.at(-1)).toStartWith("m39");
  });
});
