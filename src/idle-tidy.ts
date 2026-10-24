/** One idle tidy opportunity per genuine user input; never re-arm from tidy/continuation work. */
import { randomUUID } from "node:crypto";

export const IDLE_TIDY_CUSTOM_TYPE = "note-context/idle-tidy";
export const IDLE_TIDY_TEXT = "[note-context] Idle notebook tidy: read the existing notes, replace outdated content, and record new conclusions or working state from this conversation. If the notes are already sufficient, review them. After the notes result, decide whether to call new_context yourself; its normal gate still applies. For this tidy run the host defers ordinary rollover reminders and automatic scheduling after notes writes, but the high-pressure checkpoint fallback remains active. This is housekeeping, not a new user task: do not resume unrelated work. When tidying (and any chosen rollover) is finished, end the run.";

/** Return an idempotent cancellation function. Injectable so timer tests need no wall-clock waits. */
export type ScheduleIdle = (callback: () => void, delayMs: number) => () => void;
const scheduleIdle: ScheduleIdle = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref(); // Never keep print/JSON/SDK processes alive, even if a host misreports its mode.
  return () => clearTimeout(timer);
};

export class IdleTidy {
  private cancelTimer: (() => void) | null = null;
  private generation = 0;
  private eligible = false;
  private requestId: string | null = null;

  constructor(private readonly enabled: boolean, private readonly delayMs: number, private readonly schedule: ScheduleIdle = scheduleIdle) {}

  get activeRequest(): string | null { return this.requestId; }

  /** Starting work or receiving input cancels the clock, not the already-running tidy scope. */
  cancel(): void {
    this.generation++;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  input(genuineUser: boolean): void {
    this.cancel();
    if (!genuineUser) return;
    this.eligible = true;
    this.requestId = null; // Real user work supersedes the housekeeping request immediately.
  }

  /** agent_end is the clock origin; retries/continuations cancel it on agent_start. */
  agentEnded(interactive: boolean, canSend: () => boolean, send: (requestId: string) => void): void {
    this.cancel();
    if (!this.enabled || !interactive || !this.eligible || this.requestId !== null) return;
    const generation = this.generation;
    this.cancelTimer = this.schedule(() => {
      if (generation !== this.generation) return;
      this.cancelTimer = null;
      try {
        if (!canSend()) return;
        // Consume before calling the host: sendMessage can synchronously begin a new run.
        this.eligible = false;
        this.requestId = randomUUID();
        send(this.requestId);
      } catch {
        // A replaced session's ctx can throw. No timer retries (nor asynchronous rejection loops).
        this.requestId = null;
      }
    }, this.delayMs);
  }

  /** Keep the scope across low-level agent_end/restart pairs; finish only at final settlement. */
  settled(): void { this.requestId = null; }

  reset(): void {
    this.cancel();
    this.eligible = false;
    this.requestId = null;
  }
}
