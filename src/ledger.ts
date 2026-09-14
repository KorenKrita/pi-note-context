/**
 * Observability ledger (DESIGN.md §10): append-only JSONL, counts and ids only.
 * Failures are swallowed; a lost row costs nothing but a smaller n.
 */

import { appendFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { GateReason } from "./gate.ts";
import type { RolloverReason } from "./rollover.ts";

export const LEDGER_MAX_BYTES = 8 * 1024 * 1024;

export type LedgerRow =
  | { kind: "notes_write"; session: string; window: number; revision: number; bytes: number; reviewOnly: boolean }
  | { kind: "notes_rejected"; session: string; window: number; reason: string }
  | { kind: "gate"; session: string; window: number; reason: GateReason; ok: boolean; blocker?: string; reclaim?: number; auto?: boolean }
  | { kind: "rollover"; session: string; fromWindow: number; reason: RolloverReason; notebookRevision: number; reclaim: number | null; pinned: number }
  | { kind: "rollover_declined"; session: string; window: number; why: string }
  /** A host-scheduled rollover failed the host gate again at settle time (`why` = gate blocker or `external_owner`); no compaction ran. */
  | { kind: "rollover_cancelled"; session: string; window: number; reason: string; why: string }
  /** ctx.compact() for a scheduled rollover reported an error; Pi wrote no compaction entry. */
  | { kind: "rollover_failed"; session: string; window: number; reason: string; why: string }
  | { kind: "reminder"; session: string; window: number; zone: string }
  | { kind: "maintenance"; session: string; window: number; action: string; attempt: number }
  | { kind: "history"; session: string; window: number; mode: "search" | "read" | "list"; hits?: number; turnsSinceRollover: number | null }
  /** One row per window, written at rollover; sums provider usage over the window's assistant messages. */
  | { kind: "window_cache"; session: string; window: number; calls: number; cacheRead: number; input: number };

export function ledgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
  return join(base, "state", "note-context-ledger.jsonl");
}

export function ledgerDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["NOTE_CONTEXT_LEDGER_DISABLED"] === "1";
}

let queue: Promise<void> = Promise.resolve();

export function appendLedger(row: LedgerRow, env: NodeJS.ProcessEnv = process.env): void {
  if (ledgerDisabled(env)) return;
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`;
  const path = ledgerPath(env);
  queue = queue
    .then(async () => {
      try {
        await mkdir(dirname(path), { recursive: true });
        try {
          const s = await stat(path);
          if (s.size + line.length > LEDGER_MAX_BYTES) return;
        } catch {
          /* new file */
        }
        await appendFile(path, line, "utf8");
      } catch {
        /* swallow */
      }
    })
    .catch(() => {});
}

export function flushLedger(): Promise<void> {
  return queue;
}
