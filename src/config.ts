/**
 * Global-only configuration: ~/.pi/agent/pi-note-context.json (DESIGN.md §11).
 * Missing file or malformed fields fall back to defaults field by field.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIMITS, type NotebookLimits } from "./notebook.ts";
import { DEFAULT_PIN, type PinOptions } from "./rollover.ts";

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
  /** Reminder zone and host auto-rollover floor are measured against min(contextWindow, budgetTokens): large windows degrade before they fill. */
  budgetTokens: number;
  /** Forced fallback is measured against min(contextWindow, fallbackBudgetTokens); defaults to budgetTokens. */
  fallbackBudgetTokens: number;
  /** Status-line step: a reading is delivered when pressure or tokens-since-review cross a multiple of this. */
  statusStepTokens: number;
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
  budgetTokens: 400_000,
  fallbackBudgetTokens: 400_000,
  statusStepTokens: 40_000,
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
    },
    externalCompactionModels: Array.isArray(r["externalCompactionModels"]) ? r["externalCompactionModels"].filter((x): x is string => typeof x === "string") : [],
    historyReadMaxChars: num(r["historyReadMaxChars"], DEFAULT_CONFIG.historyReadMaxChars, 500),
    entryIdTrailers: typeof r["entryIdTrailers"] === "boolean" ? r["entryIdTrailers"] : DEFAULT_CONFIG.entryIdTrailers,
    autoRollover: typeof r["autoRollover"] === "boolean" ? r["autoRollover"] : DEFAULT_CONFIG.autoRollover,
    budgetTokens,
    fallbackBudgetTokens: num(r["fallbackBudgetTokens"], budgetTokens, 32_000),
    statusStepTokens: num(r["statusStepTokens"], DEFAULT_CONFIG.statusStepTokens, 1_000),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    return parseConfig(JSON.parse(readFileSync(configPath(env), "utf8")));
  } catch {
    return DEFAULT_CONFIG;
  }
}
