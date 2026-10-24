/**
 * Threshold reminder and host fallback state machine (DESIGN.md §6).
 * Pure decision logic; the host (index.ts) performs the side effects.
 */

export type MaintenanceState =
  | { kind: "idle" }
  | { kind: "requested"; attempt: number; startedAtRevision: number; repairs: number; blocked: number }
  | { kind: "checkpointed"; attempt: number };

export interface Thresholds {
  /** Reminder scale: min(physical window, budgetTokens). */
  contextWindow: number;
  /** Forced-fallback scale: min(physical window, fallbackBudgetTokens). */
  fallbackWindow: number;
  reserveTokens: number;
  leadTokens: number;
  fallbackBufferTokens: number;
}

/** Start of the reminder zone; also the host auto-rollover floor. */
export function reminderThreshold(t: Thresholds): number {
  return t.contextWindow - t.reserveTokens - t.leadTokens;
}

/** Start of the forced maintenance/fallback zone. */
export function fallbackThreshold(t: Thresholds): number {
  return t.fallbackWindow - t.reserveTokens - t.fallbackBufferTokens;
}

export type PressureZone = "normal" | "reminder" | "fallback";

export function zoneFor(tokens: number | null, t: Thresholds): PressureZone {
  if (tokens === null || t.contextWindow <= 0) return "normal";
  if (tokens >= fallbackThreshold(t)) return "fallback";
  if (tokens >= reminderThreshold(t)) return "reminder";
  return "normal";
}

/** No token counts: the host owns rollover timing; the model only needs the action. */
export function reminderText(notebookText: string | null): string {
  const head = `[note-context] A context-window rollover is due. Before it, tidy the whole notebook${notebookText ? " (current notebook below)" : ""}: record what will leave the window, and correct or remove anything outdated or wrong so it is not carried into the new window. If the notes are already accurate and sufficient, call notes({reviewed:true}). Then call new_context.`;
  return notebookText ? `${head}\n\n${notebookText}` : head;
}

export function maintenanceRequestText(attempt: number, repairError?: string): string {
  const base = `[note-context maintenance #${attempt}] The host needs a notes checkpoint before it starts a new window. Make one notes write now that tidies the whole notebook, correcting or removing anything outdated or wrong so it is not carried into the new window (or notes({reviewed:true}) if it is already accurate); the host will start a new window as soon as it lands. Do not call other tools.`;
  return repairError ? `${base}\nThe previous notes call failed: ${repairError}` : base;
}

export const MAX_REPAIRS = 1;
/** Non-notes tool calls tolerated while a checkpoint is requested before the host hands off to Pi's summary. */
export const MAX_BLOCKED_CALLS = 3;

export type MaintenanceEvent =
  | { type: "enter"; notebookRevision: number }
  | { type: "notes_ok"; revision: number }
  | { type: "notes_failed" }
  | { type: "blocked_call" }
  | { type: "rollover_done" }
  | { type: "reset" };

export function step(state: MaintenanceState, ev: MaintenanceEvent, nextAttempt: () => number): { state: MaintenanceState; action: "steer_request" | "steer_repair" | "compact_now" | "give_up" | "none" } {
  switch (ev.type) {
    case "reset":
    case "rollover_done":
      return { state: { kind: "idle" }, action: "none" };
    case "enter":
      if (state.kind !== "idle") return { state, action: "none" };
      return { state: { kind: "requested", attempt: nextAttempt(), startedAtRevision: ev.notebookRevision, repairs: 0, blocked: 0 }, action: "steer_request" };
    case "notes_ok":
      if (state.kind !== "requested") return { state, action: "none" };
      if (ev.revision <= state.startedAtRevision) return { state, action: "none" };
      return { state: { kind: "checkpointed", attempt: state.attempt }, action: "compact_now" };
    case "notes_failed":
      if (state.kind !== "requested") return { state, action: "none" };
      if (state.repairs >= MAX_REPAIRS) return { state: { kind: "idle" }, action: "give_up" };
      return { state: { ...state, repairs: state.repairs + 1 }, action: "steer_repair" };
    case "blocked_call":
      if (state.kind !== "requested") return { state, action: "none" };
      if (state.blocked + 1 >= MAX_BLOCKED_CALLS) return { state: { kind: "idle" }, action: "give_up" };
      return { state: { ...state, blocked: state.blocked + 1 }, action: "none" };
  }
}
