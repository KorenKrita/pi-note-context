/**
 * Global-only configuration: ~/.pi/agent/pi-note-context.json (DESIGN.md §11).
 * Missing file or malformed fields fall back to defaults field by field.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIMITS, type NotebookLimits } from "./notebook.ts";
import { DEFAULT_PIN, type PinOptions } from "./rollover.ts";
import { DEFAULT_JEV, type JevOptions } from "./jev.ts";

export interface Config {
  enabled: boolean;
  limits: NotebookLimits;
  leadTokens: number;
  fallbackBufferTokens: number;
  minReclaimTokens: number;
  pin: PinOptions;
  externalCompactionModels: string[];
  historyReadMaxChars: number;
  entryIdTrailers: boolean;
  /** Host schedules a rollover after a notes write when the gate passes (no new_context call needed). */
  autoRollover: boolean;
  /** Opt-in housekeeping after the agent finishes, at most once until the next real user input. */
  idleTidyEnabled: boolean;
  idleTidyAfterMinutes: number;
  /** Reminder zone and host auto-rollover floor are measured against min(contextWindow, budgetTokens): large windows degrade before they fill. */
  budgetTokens: number;
  /** Forced fallback is measured against min(contextWindow, fallbackBudgetTokens); defaults to budgetTokens. */
  fallbackBudgetTokens: number;
  /** Staleness step: a reading is delivered when tokens since the last notes write/review cross a multiple of this. */
  statusStepTokens: number;
  /** Step for the "no notes yet" nudge, measured on context size; defaults to statusStepTokens. */
  noNotesStepTokens: number;
  /** Jev classifier: pins by message kind and flags user decisions the notes miss. Fails open to the mechanical rules. */
  jev: JevOptions;
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  limits: DEFAULT_LIMITS,
  leadTokens: 24_000,
  fallbackBufferTokens: 12_000,
  minReclaimTokens: 20_000,
  pin: DEFAULT_PIN,
  externalCompactionModels: [],
  historyReadMaxChars: 12_000,
  entryIdTrailers: true,
  autoRollover: true,
  idleTidyEnabled: false,
  idleTidyAfterMinutes: 55,
  budgetTokens: 400_000,
  fallbackBudgetTokens: 400_000,
  statusStepTokens: 40_000,
  noNotesStepTokens: 40_000,
  jev: DEFAULT_JEV,
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
  return join(base, "pi-note-context.json");
}

function num(v: unknown, d: number, min = 0): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min ? v : d;
}

export function parseConfig(raw: unknown): Config {
  if (!raw || typeof raw !== "object") return DEFAULT_CONFIG;
  const r = raw as Record<string, unknown>;
  const budgetTokens = num(r["budgetTokens"], DEFAULT_CONFIG.budgetTokens, 32_000);
  // Node clamps overflowing timeouts to 1 ms: reject them rather than tidying immediately.
  const idleMinutes = num(r["idleTidyAfterMinutes"], DEFAULT_CONFIG.idleTidyAfterMinutes, 1);
  return {
    enabled: typeof r["enabled"] === "boolean" ? r["enabled"] : DEFAULT_CONFIG.enabled,
    limits: {
      maxBytes: num(r["notebookMaxBytes"], DEFAULT_LIMITS.maxBytes, 1024),
      maxTokens: num(r["notebookMaxTokens"], DEFAULT_LIMITS.maxTokens, 256),
    },
    leadTokens: num(r["leadTokens"], DEFAULT_CONFIG.leadTokens),
    fallbackBufferTokens: num(r["fallbackBufferTokens"], DEFAULT_CONFIG.fallbackBufferTokens),
    minReclaimTokens: num(r["minReclaimTokens"], DEFAULT_CONFIG.minReclaimTokens),
    pin: {
      messageMaxChars: num(r["pinnedMessageMaxChars"], DEFAULT_PIN.messageMaxChars, 40),
      totalMaxTokens: num(r["pinnedTotalMaxTokens"], DEFAULT_PIN.totalMaxTokens, 128),
      indexMaxTokens: num(r["sessionIndexMaxTokens"], DEFAULT_PIN.indexMaxTokens, 128),
    },
    externalCompactionModels: Array.isArray(r["externalCompactionModels"]) ? r["externalCompactionModels"].filter((x): x is string => typeof x === "string") : [],
    historyReadMaxChars: num(r["historyReadMaxChars"], DEFAULT_CONFIG.historyReadMaxChars, 500),
    entryIdTrailers: typeof r["entryIdTrailers"] === "boolean" ? r["entryIdTrailers"] : DEFAULT_CONFIG.entryIdTrailers,
    autoRollover: typeof r["autoRollover"] === "boolean" ? r["autoRollover"] : DEFAULT_CONFIG.autoRollover,
    idleTidyEnabled: typeof r["idleTidyEnabled"] === "boolean" ? r["idleTidyEnabled"] : DEFAULT_CONFIG.idleTidyEnabled,
    idleTidyAfterMinutes: idleMinutes * 60_000 <= 2_147_483_647 ? idleMinutes : DEFAULT_CONFIG.idleTidyAfterMinutes,
    budgetTokens,
    fallbackBudgetTokens: num(r["fallbackBudgetTokens"], budgetTokens, 32_000),
    statusStepTokens: num(r["statusStepTokens"], DEFAULT_CONFIG.statusStepTokens, 1_000),
    noNotesStepTokens: num(r["noNotesStepTokens"], num(r["statusStepTokens"], DEFAULT_CONFIG.statusStepTokens, 1_000), 1_000),
    jev: {
      enabled: typeof r["jevEnabled"] === "boolean" ? r["jevEnabled"] : DEFAULT_JEV.enabled,
      timeoutMs: num(r["jevTimeoutMs"], DEFAULT_JEV.timeoutMs, 500),
      unrecordedThreshold: typeof r["jevUnrecordedThreshold"] === "number" && r["jevUnrecordedThreshold"] > 0 && r["jevUnrecordedThreshold"] <= 1 ? r["jevUnrecordedThreshold"] : DEFAULT_JEV.unrecordedThreshold,
      model: typeof r["jevModel"] === "string" && r["jevModel"] ? r["jevModel"] : DEFAULT_JEV.model,
      ...(typeof r["jevBaseUrl"] === "string" && r["jevBaseUrl"] ? { baseUrl: r["jevBaseUrl"] } : {}),
      ...(typeof r["jevApiKey"] === "string" && r["jevApiKey"] ? { apiKey: r["jevApiKey"] } : {}),
    },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    return parseConfig(JSON.parse(readFileSync(configPath(env), "utf8")));
  } catch {
    return DEFAULT_CONFIG;
  }
}
