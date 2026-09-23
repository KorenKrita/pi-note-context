/**
 * pi-note-context — composition root (DESIGN.md).
 * Tools: notes, history, new_context. Events: guidance, status line, id
 * trailers, rollover via session_before_compact, threshold reminder and
 * host fallback, branch-state reset.
 */

import { SettingsManager, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { loadConfig, type Config } from "./config.ts";
import { evaluateGate, projectCut, type GateVerdict } from "./gate.ts";
import {
  HISTORY_DESCRIPTION,
  HISTORY_GUIDELINES,
  HISTORY_SNIPPET,
  NEW_CONTEXT_DESCRIPTION,
  NEW_CONTEXT_GUIDELINES,
  NEW_CONTEXT_SNIPPET,
  NOTES_DESCRIPTION,
  NOTES_GUIDELINES,
  NOTES_SNIPPET,
  SYSTEM_PROMPT_SECTION,
} from "./guidance.ts";
import { currentWindow, indexBranch, isRolloverDetails, list, read, renderList, renderRead, renderSearch, search } from "./history.ts";
import { appendLedger, flushLedger } from "./ledger.ts";
import { fallbackThreshold, maintenanceRequestText, reminderText, reminderThreshold, step, zoneFor, type MaintenanceState, type Thresholds } from "./maintenance.ts";
import { applySections, makeRecord, NOTEBOOK_ENTRY_TYPE, reconstructNotebook, renderNotebook, type Notebook } from "./notebook.ts";
import { estimateTokens as estimateText } from "./notebook.ts";
import { droppedRange, makeDetails, pinUserMessages, renderRolloverSummary, type RolloverReason } from "./rollover.ts";
import { appendSuffixPatch, renderStatusLine, StatusOdometer, tokensSinceReview, turnsSince } from "./status.ts";
import { addTrailers, buildIdIndex } from "./trailers.ts";

type ToolOut = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
function text(msg: string, details: Record<string, unknown> = {}): ToolOut {
  return { content: [{ type: "text", text: msg }], details };
}
/** Pi turns a thrown error into an error tool result; a returned `isError` flag is ignored by agent-core. */
function fail(msg: string): never {
  throw new Error(msg);
}

const NotesParams = Type.Object({
  sections: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'Section name → text. "" deletes a section.' })),
  replaceAll: Type.Optional(Type.Boolean({ description: "With sections: replace the whole notebook with exactly these sections." })),
  reviewed: Type.Optional(Type.Boolean({ description: "Alone: attest the current revision is sufficient; no content change." })),
});

const HistoryParams = Type.Object({
  query: Type.Optional(Type.String({ description: "Literal substring to search for." })),
  id: Type.Optional(Type.String({ description: "Entry id to read in full." })),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "Neighbouring entries on each side when reading by id. Default 1." })),
  list: Type.Optional(Type.Boolean({ description: "Chronological listing." })),
  window: Type.Optional(Type.Integer({ minimum: 1, description: "Restrict to one context window number." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "list: entries to skip. query: matching entries to skip. id: character offset into the entry text." })),
});

const NewContextParams = Type.Object({
  userRequested: Type.Optional(Type.Boolean({ description: "Set true only when the user explicitly asks for a fresh context window. Skips reclaim and pressure thresholds, not notebook or freshness checks. Defaults to false." })),
});
const MAINTENANCE_CUSTOM_TYPE = "note-context/maintenance";
/** Custom type of the per-request status message written by versions ≤ 0.3; filtered out of context, never written. */
const LEGACY_STATUS_CUSTOM_TYPE = "note-context/status";
const OWN_TOOLS = new Set(["notes", "history", "new_context"]);

export default function noteContext(pi: ExtensionAPI): void {
  const config: Config = loadConfig();
  if (!config.enabled) return;

  const SCHEDULED_CONTINUE = "[note-context] New context window started. Continue with the notebook's Next action.";
  const FALLBACK_CONTINUE = "[note-context] New context window started after the maintenance checkpoint. Continue with the notebook's Next action.";

  // ------------------------------------------------------------ volatile state
  // All of this is rebuilt from the journal or reset on session replacement.
  let branchChangedPending = false;
  let pendingRollover: { reason: RolloverReason; requestedAtLeaf: string | null } | null = null;
  let inFlightRollover: { reason: RolloverReason } | null = null;
  /** A rollover proposed as boundary entries, not yet seen persisted (see reconcileProposal). */
  let proposal: { reason: RolloverReason; afterLeaf: string | null; record: () => void } | null = null;
  /** The current run was aborted by the user (ESC). Seen on ctx.signal at turn_end/agent_end; cleared at agent_start. */
  let runAborted = false;
  let maintenance: MaintenanceState = { kind: "idle" };
  let attemptCounter = 0;
  let reminderShownForWindow: number | null = null;
  let maintenanceExhaustedForWindow: number | null = null;
  let lastCompactionWasOurs = false;
  let cacheAcc = { calls: 0, cacheRead: 0, input: 0 }; // provider cache stats for the current window
  const statusOdometer = new StatusOdometer();

  const resetVolatile = () => {
    branchChangedPending = false;
    pendingRollover = null;
    inFlightRollover = null;
    proposal = null;
    runAborted = false;
    maintenance = { kind: "idle" };
    reminderShownForWindow = null;
    maintenanceExhaustedForWindow = null;
    lastCompactionWasOurs = false;
    cacheAcc = { calls: 0, cacheRead: 0, input: 0 };
    statusOdometer.reset();
  };

  // ------------------------------------------------------------------ helpers
  const branchOf = (ctx: ExtensionContext) => ctx.sessionManager.getBranch();
  /** Compaction-aware active context entries: what the model actually sees (and what the next compaction can drop). */
  const contextOf = (ctx: ExtensionContext) => ctx.sessionManager.buildContextEntries();
  const notebookOf = (ctx: ExtensionContext): Notebook => reconstructNotebook(branchOf(ctx));
  const sessionId = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const modelKey = (ctx: ExtensionContext) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null);
  const externalOwner = (ctx: ExtensionContext) => {
    const k = modelKey(ctx);
    return k !== null && config.externalCompactionModels.includes(k);
  };

  function issuingAssistantId(ctx: ExtensionContext): string | null {
    const branch = branchOf(ctx);
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i]!;
      if (e.type === "message" && e.message.role === "assistant") return e.id;
    }
    return null;
  }

  const DEFAULT_COMPACTION = { keepRecentTokens: 20_000, reserveTokens: 16_384, enabled: true };
  let settingsCache: { key: string; value: typeof DEFAULT_COMPACTION } | null = null;
  /** The user's real compaction settings (global + project, honouring Pi's project-trust decision), so gate projection matches Pi's cut. */
  function compactionSettings(ctx: ExtensionContext): typeof DEFAULT_COMPACTION {
    const cwd = ctx.cwd;
    const trusted = ctx.isProjectTrusted();
    const key = `${cwd}|${trusted}`;
    if (settingsCache && settingsCache.key === key) return settingsCache.value;
    try {
      const sm = SettingsManager.create(cwd, process.env["PI_CODING_AGENT_DIR"], { projectTrusted: trusted });
      const c = sm.getCompactionSettings();
      const value = {
        keepRecentTokens: c.keepRecentTokens ?? DEFAULT_COMPACTION.keepRecentTokens,
        reserveTokens: c.reserveTokens ?? DEFAULT_COMPACTION.reserveTokens,
        enabled: c.enabled ?? DEFAULT_COMPACTION.enabled,
      };
      settingsCache = { key, value };
      return value;
    } catch {
      return DEFAULT_COMPACTION;
    }
  }

  const physicalWindow = (ctx: ExtensionContext) => ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const capped = (physical: number, budget: number) => (physical > 0 ? Math.min(physical, budget) : 0);

  /** The scale pressure is read against: the physical window capped at budgetTokens. */
  function budgetWindow(ctx: ExtensionContext): number {
    return capped(physicalWindow(ctx), config.budgetTokens);
  }

  function thresholds(ctx: ExtensionContext): Thresholds {
    return {
      contextWindow: budgetWindow(ctx),
      fallbackWindow: capped(physicalWindow(ctx), config.fallbackBudgetTokens),
      reserveTokens: compactionSettings(ctx).reserveTokens,
      leadTokens: config.leadTokens,
      fallbackBufferTokens: config.fallbackBufferTokens,
    };
  }

  /** Assistant turns since this branch's latest template rollover, for history ledger rows. */
  function turnsSinceRollover(ctx: ExtensionContext): number | null {
    const branch = branchOf(ctx);
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i]!;
      if (e.type === "compaction" && isRolloverDetails(e.details)) return turnsSince(branch, e.id);
    }
    return null;
  }

  function summaryTokenEstimate(ctx: ExtensionContext, notebook: Notebook): number {
    const context = contextOf(ctx);
    const cut = projectCut(context, compactionSettings(ctx).keepRecentTokens);
    const pinned = cut.firstKeptEntryId ? pinUserMessages(droppedRange(context, cut.firstKeptEntryId), config.pin) : [];
    return estimateText(renderRolloverSummary({ window: currentWindow(branchOf(ctx)) + 1, reason: "model", notebook, pinned }));
  }

  /** Freshness against a concrete cut: true when nothing that will be dropped post-dates the notebook's review marker. */
  function freshAgainstCut(context: readonly SessionEntry[], notebook: Notebook, firstKeptEntryId: string): boolean {
    const cutIdx = context.findIndex((e) => e.id === firstKeptEntryId);
    if (cutIdx <= 0) return true;
    const reviewedIdx = notebook.reviewedThrough ? context.findIndex((e) => e.id === notebook.reviewedThrough) : -1;
    return reviewedIdx >= cutIdx - 1;
  }

  // ------------------------------------------------------------------- notes
  pi.registerTool({
    name: "notes",
    label: "Notes",
    description: NOTES_DESCRIPTION,
    promptSnippet: NOTES_SNIPPET,
    promptGuidelines: NOTES_GUIDELINES,
    parameters: NotesParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const current = notebookOf(ctx);
      const window = currentWindow(branchOf(ctx));
      const hasSections = params.sections !== undefined && Object.keys(params.sections).length > 0;

      if (!hasSections && !params.reviewed) {
        if (current.revision === 0) return text('Notebook is empty (revision 0). Write with notes({ sections: { Task: "…", Next: "…" } }).', { revision: 0 });
        return text(`Notebook revision ${current.revision}\n\n${renderNotebook(current.sections)}`, { revision: current.revision, entryId: current.entryId });
      }

      const commitReview = () => {
        const record = makeRecord(current, current.sections, issuingAssistantId(ctx), true, ctx.getContextUsage()?.tokens ?? null);
        pi.appendEntry(NOTEBOOK_ENTRY_TYPE, record);
        appendLedger({ kind: "notes_write", session: sessionId(ctx), window, revision: record.revision, bytes: 0, reviewOnly: true });
        onNotesLanded(ctx, record.revision);
        return { record, auto: considerAutoRollover(ctx, notebookOf(ctx)) };
      };

      if (params.reviewed && !hasSections) {
        if (current.revision === 0) {
          onNotesFailed(ctx, "nothing to review: the notebook is empty");
          return fail("Nothing to review: the notebook is empty. Write sections first.");
        }
        const { record, auto } = commitReview();
        return text(`Notebook revision ${record.revision}: reviewed, unchanged.${auto}`, { revision: record.revision, reviewOnly: true, autoRollover: auto !== "" });
      }

      const result = applySections(current.sections, { sections: params.sections!, replaceAll: params.replaceAll }, config.limits);
      if (!result.ok) {
        appendLedger({ kind: "notes_rejected", session: sessionId(ctx), window, reason: result.reason });
        onNotesFailed(ctx, `${result.reason}: ${result.detail}`);
        return fail(`notes rejected (${result.reason}): ${result.detail}`);
      }
      if (!result.changed && !params.replaceAll) {
        const { record, auto } = commitReview();
        return text(`Notebook revision ${record.revision}: content unchanged, review marker updated.${auto}`, { revision: record.revision, reviewOnly: true, autoRollover: auto !== "" });
      }
      const record = makeRecord(current, result.sections, issuingAssistantId(ctx), false, ctx.getContextUsage()?.tokens ?? null);
      pi.appendEntry(NOTEBOOK_ENTRY_TYPE, record);
      appendLedger({ kind: "notes_write", session: sessionId(ctx), window, revision: record.revision, bytes: result.size.bytes, reviewOnly: false });
      onNotesLanded(ctx, record.revision);
      const auto = considerAutoRollover(ctx, notebookOf(ctx));
      const remainingBytes = config.limits.maxBytes - result.size.bytes;
      const remainingTokens = config.limits.maxTokens - result.size.tokensEstimate;
      return text(
        `Notebook revision ${record.revision} saved: ${Object.keys(result.sections).length} section(s), ${result.size.bytes} bytes / ~${result.size.tokensEstimate} tokens; ${remainingBytes} bytes / ~${remainingTokens} tokens remaining.${auto}`,
        { revision: record.revision, sections: Object.keys(result.sections), bytes: result.size.bytes, tokensEstimate: result.size.tokensEstimate, autoRollover: auto !== "" },
      );
    },
  });

  // ----------------------------------------------------------------- history
  pi.registerTool({
    name: "history",
    label: "History",
    description: HISTORY_DESCRIPTION,
    promptSnippet: HISTORY_SNIPPET,
    promptGuidelines: HISTORY_GUIDELINES,
    parameters: HistoryParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const branch = branchOf(ctx);
      const items = indexBranch(branch);
      const window = currentWindow(branch);
      const modes = [params.query !== undefined, params.id !== undefined, params.list === true].filter(Boolean).length;
      if (modes !== 1) return fail("history: pass exactly one of query, id, or list:true.");
      const since = turnsSinceRollover(ctx);
      if (params.id !== undefined) {
        const r = read(items, params.id, params.context ?? 1);
        appendLedger({ kind: "history", session: sessionId(ctx), window, mode: "read", hits: r ? 1 : 0, turnsSinceRollover: since });
        if (!r) return fail(`history: no model-visible entry with id ${params.id} on this branch.`);
        return text(renderRead(r, { offset: params.offset ?? 0, maxChars: config.historyReadMaxChars }), { id: r.target.id, window: r.target.window, offset: params.offset ?? 0, totalChars: r.target.text.length });
      }
      if (params.query !== undefined) {
        if (params.query.length === 0) return fail("history: query must be non-empty.");
        const opts = { query: params.query, window: params.window, limit: params.limit, offset: params.offset };
        const r = search(items, opts);
        appendLedger({ kind: "history", session: sessionId(ctx), window, mode: "search", hits: r.hits.length, turnsSinceRollover: since });
        return text(renderSearch(r, opts), { hits: r.hits.length, scanned: r.scanned, truncated: r.truncated });
      }
      const r = list(items, { window: params.window, limit: params.limit, offset: params.offset });
      appendLedger({ kind: "history", session: sessionId(ctx), window, mode: "list", hits: r.items.length, turnsSinceRollover: since });
      return text(renderList(r, params.window), { total: r.total, shown: r.items.length });
    },
  });

  // ------------------------------------------------------------- new_context
  pi.registerTool({
    name: "new_context",
    label: "New Context",
    description: NEW_CONTEXT_DESCRIPTION,
    promptSnippet: NEW_CONTEXT_SNIPPET,
    promptGuidelines: NEW_CONTEXT_GUIDELINES,
    parameters: NewContextParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const reason = params.userRequested === true ? "user" : "model";
      const branch = branchOf(ctx);
      const notebook = notebookOf(ctx);
      const window = currentWindow(branch);
      const external = externalOwner(ctx);
      if (external && reason === "model" && pendingRollover?.reason !== "user") {
        // Preserve the existing owner-controlled model path, without overwriting a
        // user schedule. User requests still run the structural gate below; the
        // owner continues to produce the summary.
        if (notebook.revision === 0) return fail("no notebook on this branch — write notes first.");
        pendingRollover = { reason, requestedAtLeaf: ctx.sessionManager.getLeafId() };
        appendLedger({ kind: "gate", session: sessionId(ctx), window, reason, ok: true });
        return text(`rollover scheduled (external compaction owner for ${modelKey(ctx)}): window #${window} → #${window + 1} at the end of this turn. End the turn now without further tool calls.`, { external: true });
      }
      // A host schedule can be confirmed by a model or user request. Re-run the
      // request's gate so freshness is still checked; a later host-only blocker
      // (pressure floor, external owner) no longer cancels the confirmed schedule.
      const confirmingHost = pendingRollover?.reason === "host";
      const verdict = evaluateGate({
        branch: contextOf(ctx),
        reason,
        notebook,
        settings: { keepRecentTokens: compactionSettings(ctx).keepRecentTokens },
        minReclaimTokens: config.minReclaimTokens,
        pending: pendingRollover !== null && !confirmingHost,
        summaryTokens: summaryTokenEstimate(ctx, notebook),
      });
      appendLedger({ kind: "gate", session: sessionId(ctx), window, reason: verdict.reason, ok: verdict.ok, ...(verdict.ok ? { reclaim: verdict.reclaimTokens } : { blocker: verdict.blocker, reclaim: verdict.reclaimTokens }) });
      if (!verdict.ok) return fail(`new_context refused: ${verdict.message}`);
      pendingRollover = { reason: verdict.reason, requestedAtLeaf: ctx.sessionManager.getLeafId() };
      if (external) return text(`rollover scheduled (external compaction owner for ${modelKey(ctx)}): window #${window} → #${window + 1} at the end of this turn. End the turn now without further tool calls.`, { external: true, reason: verdict.reason });
      return text(
        `rollover scheduled${confirmingHost ? " (confirms the host schedule)" : ""}: window #${window} → #${window + 1} at the end of this turn (~${Math.round(verdict.reclaimTokens / 1000)}K tokens reclaimed, ${verdict.droppedEntries} entries leave the window). End the turn now without further tool calls.`,
        { reason: verdict.reason, reclaimTokens: verdict.reclaimTokens, droppedEntries: verdict.droppedEntries, confirmedHost: confirmingHost },
      );
    },
  });

  // -------------------------------------------------- maintenance hooks (notes)
  /**
   * Host-initiated rollover (DESIGN.md §15): after every notes write, run the gate. When it
   * passes, schedule the rollover without waiting for the model to call new_context, and
   * tell the model in the notes result. Returns the suffix to append to that result.
   */
  /** The host gate: the model gate plus the pressure floor and the external-owner yield. Used at schedule time and again at settle. */
  function hostGate(ctx: ExtensionContext, notebook: Notebook): GateVerdict | { ok: false; blocker: "external_owner"; message: string } {
    if (externalOwner(ctx)) return { ok: false, blocker: "external_owner", message: "another extension owns compaction for this model" };
    const usage = ctx.getContextUsage();
    return evaluateGate({
      branch: contextOf(ctx),
      reason: "host",
      notebook,
      settings: { keepRecentTokens: compactionSettings(ctx).keepRecentTokens },
      minReclaimTokens: config.minReclaimTokens,
      pending: false,
      summaryTokens: summaryTokenEstimate(ctx, notebook),
      pressure: usage?.tokens != null ? { tokens: usage.tokens, floorTokens: reminderThreshold(thresholds(ctx)) } : undefined,
    });
  }

  function considerAutoRollover(ctx: ExtensionContext, notebook: Notebook): string {
    if (!config.autoRollover) return "";
    if (pendingRollover || inFlightRollover || maintenance.kind !== "idle") return "";
    const window = currentWindow(branchOf(ctx));
    const verdict = hostGate(ctx, notebook);
    if (!verdict.ok) {
      if (verdict.blocker === "low_pressure") appendLedger({ kind: "gate", session: sessionId(ctx), window, reason: "host", ok: false, blocker: verdict.blocker, auto: true });
      return "";
    }
    pendingRollover = { reason: "host", requestedAtLeaf: ctx.sessionManager.getLeafId() };
    appendLedger({ kind: "gate", session: sessionId(ctx), window, reason: verdict.reason, ok: true, reclaim: verdict.reclaimTokens, auto: true });
    return `\nRollover scheduled by the host: window #${window} → #${window + 1} at the end of this turn (~${Math.round(verdict.reclaimTokens / 1000)}K tokens reclaimed). Finish what this turn needs; the new window opens with these notes.`;
  }

  function onNotesLanded(ctx: ExtensionContext, revision: number): void {
    const r = step(maintenance, { type: "notes_ok", revision }, () => ++attemptCounter);
    maintenance = r.state;
    if (r.action === "compact_now") {
      appendLedger({ kind: "maintenance", session: sessionId(ctx), window: currentWindow(branchOf(ctx)), action: "compact_now", attempt: maintenance.kind === "checkpointed" ? maintenance.attempt : 0 });
      if (!externalOwner(ctx)) {
        // Rolled over at this turn's turn_end boundary (the notes call's turn), without aborting the run.
        pendingRollover = { reason: "fallback", requestedAtLeaf: ctx.sessionManager.getLeafId() };
        return;
      }
      // An external compaction owner writes the summary, so this goes through Pi's compaction.
      // ctx.compact() aborts the in-flight run; a continuation resumes the task afterwards.
      inFlightRollover = { reason: "fallback" };
      ctx.compact({
        onComplete: () => {
          inFlightRollover = null;
          pi.sendMessage(
            { customType: "note-context/continue", content: FALLBACK_CONTINUE, display: true },
            { deliverAs: "followUp", triggerTurn: true },
          );
        },
        onError: (error) => {
          maintenance = { kind: "idle" };
          inFlightRollover = null;
          appendLedger({ kind: "rollover_failed", session: sessionId(ctx), window: currentWindow(branchOf(ctx)), reason: "fallback", why: compactFailureCategory(error) });
        },
      });
    }
  }
  function onNotesFailed(ctx: ExtensionContext, error: string): void {
    const r = step(maintenance, { type: "notes_failed" }, () => ++attemptCounter);
    maintenance = r.state;
    const window = currentWindow(branchOf(ctx));
    if (r.action === "steer_repair" && maintenance.kind === "requested") {
      appendLedger({ kind: "maintenance", session: sessionId(ctx), window, action: "steer_repair", attempt: maintenance.attempt });
      pi.sendMessage({ customType: MAINTENANCE_CUSTOM_TYPE, content: maintenanceRequestText(maintenance.attempt, error), display: true, details: { attempt: maintenance.attempt } }, { deliverAs: "steer" });
    } else if (r.action === "give_up") {
      appendLedger({ kind: "maintenance", session: sessionId(ctx), window, action: "give_up", attempt: 0 });
      // Hand off: no more maintenance attempts this window; Pi's threshold compaction runs its
      // LLM summary (session_before_compact declines the template on a stale notebook).
      maintenanceExhaustedForWindow = window;
    }
  }

  // ---------------------------------------------------- dispatch guard (§6)
  pi.on("tool_call", async (event, ctx) => {
    if (maintenance.kind !== "requested") return undefined;
    if (event.toolName === "notes") return undefined;
    // The model is not cooperating with the checkpoint request. Bound the guard: after a few
    // blocked calls hand off to Pi's own threshold compaction instead of stalling the task.
    const r = step(maintenance, { type: "blocked_call" }, () => ++attemptCounter);
    maintenance = r.state;
    if (r.action === "give_up") {
      const window = currentWindow(branchOf(ctx));
      appendLedger({ kind: "maintenance", session: sessionId(ctx), window, action: "give_up_uncooperative", attempt: 0 });
      maintenanceExhaustedForWindow = window;
      return undefined; // let this call through; guard is lifted for the window
    }
    return { block: true, reason: "context maintenance in progress — only `notes` is available until the checkpoint lands." };
  });

  // -------------------------------------------------- rollover (compaction)
  /**
   * The template rollover for a concrete cut, or null (ledger row written) when it must not be
   * used: no notebook, or the cut would drop material the notebook was not reviewed against.
   * `record()` writes the rollover and window-cache ledger rows once the compaction is persisted.
   */
  function templateRollover(ctx: ExtensionContext, context: readonly SessionEntry[], firstKeptEntryId: string, reason: RolloverReason): { summary: string; details: ReturnType<typeof makeDetails>; record: () => void } | null {
    const branch = branchOf(ctx);
    const notebook = reconstructNotebook(branch);
    const window = currentWindow(branch);
    if (notebook.revision === 0) {
      appendLedger({ kind: "rollover_declined", session: sessionId(ctx), window, why: "no_notebook" });
      return null; // never template-rollover without a notebook (§6 step 4)
    }
    // Freshness against the *actual* cut, for every trigger: the gate's projection may be
    // stale by the time compaction runs, and manual /compact never went through the gate.
    if (!freshAgainstCut(context, notebook, firstKeptEntryId)) {
      appendLedger({ kind: "rollover_declined", session: sessionId(ctx), window, why: "stale_notebook_at_cut" });
      return null;
    }
    const pinned = pinUserMessages(droppedRange(context, firstKeptEntryId), config.pin);
    const session = sessionId(ctx);
    const record = () => {
      appendLedger({ kind: "rollover", session, fromWindow: window, reason, notebookRevision: notebook.revision, reclaim: null, pinned: pinned.length });
      if (cacheAcc.calls > 0) {
        appendLedger({ kind: "window_cache", session, window, ...cacheAcc });
        cacheAcc = { calls: 0, cacheRead: 0, input: 0 };
      }
    };
    return { summary: renderRolloverSummary({ window: window + 1, reason, notebook, pinned }), details: makeDetails(window + 1, reason, notebook, pinned), record };
  }

  /** Volatile state for a freshly opened window. */
  function onWindowOpened(): void {
    pendingRollover = null;
    inFlightRollover = null;
    maintenance = step(maintenance, { type: "rollover_done" }, () => attemptCounter).state;
    reminderShownForWindow = null;
    maintenanceExhaustedForWindow = null;
    lastCompactionWasOurs = false;
    statusOdometer.reset(); // new window: first reading always shows
  }

  /**
   * Our own rollovers are proposed as boundary entries (turn_end / agent_before_settle): the
   * compaction and the continuation message are persisted in order and Pi runs the next request
   * on the new window, with no abort and no follow-up race. Pi does not emit
   * session_before_compact / session_compact for boundary entries, so this path runs the
   * template checks itself and leaves a proposal: a later handler can still replace the drafts
   * or make the boundary invalid, so the window reset and ledger row wait for reconcileProposal.
   * Returns null (ledger row written) when the template must not be used.
   */
  function boundaryRollover(ctx: ExtensionContext, reason: RolloverReason, continueText: string): SessionBoundaryDraft[] | null {
    const context = contextOf(ctx);
    const cut = projectCut(context, compactionSettings(ctx).keepRecentTokens);
    if (cut.firstKeptEntryId === null || cut.firstKeptIndex <= cut.start) {
      appendLedger({ kind: "rollover_declined", session: sessionId(ctx), window: currentWindow(branchOf(ctx)), why: "nothing_to_cut" });
      return null;
    }
    const template = templateRollover(ctx, context, cut.firstKeptEntryId, reason);
    if (!template) return null;
    proposal = { reason, afterLeaf: ctx.sessionManager.getLeafId(), record: template.record };
    return [
      { type: "compaction", summary: template.summary, firstKeptEntryId: cut.firstKeptEntryId, details: template.details },
      { type: "custom_message", customType: "note-context/continue", content: continueText, display: true },
    ];
  }

  /**
   * Settle a boundary proposal at the next hook (turn_start of the continued request, or the
   * settle hooks when Pi did not continue). Committed: our compaction is on the branch after the
   * proposal's leaf → ledger row + window reset. Otherwise Pi dropped the drafts: a scheduled
   * rollover keeps its schedule for agent_settled (Pi's compaction); a fallback hands the window
   * to Pi's threshold compaction.
   */
  function reconcileProposal(ctx: ExtensionContext): void {
    if (!proposal) return;
    const p = proposal;
    proposal = null;
    const branch = branchOf(ctx);
    const from = p.afterLeaf === null ? -1 : branch.findIndex((e) => e.id === p.afterLeaf);
    const committed = (p.afterLeaf === null || from >= 0) && branch.slice(from + 1).some((e) => e.type === "compaction" && isRolloverDetails(e.details));
    if (committed) {
      p.record();
      onWindowOpened();
      return;
    }
    const window = currentWindow(branch);
    appendLedger({ kind: "rollover_failed", session: sessionId(ctx), window, reason: p.reason, why: "boundary_rejected" });
    if (p.reason === "fallback") {
      maintenance = { kind: "idle" };
      maintenanceExhaustedForWindow = window;
    }
  }
  pi.on("turn_start", async (_event, ctx) => reconcileProposal(ctx));

  // Pi-driven compaction (threshold, manual /compact) and the external-owner path still arrive
  // here; the template replaces Pi's LLM summary when the notebook covers the cut.
  pi.on("session_before_compact", async (event, ctx) => {
    lastCompactionWasOurs = false;
    if (event.customInstructions) return undefined; // user-directed /compact: Pi's LLM summary
    if (externalOwner(ctx)) return undefined; // another extension owns compaction for this model
    // Pi's automatic compaction can fire mid-run (before the next assistant response). A
    // template rollover there would drop context the model is actively working from.
    if (inFlightRollover === null && event.reason !== "manual" && !ctx.isIdle()) {
      appendLedger({ kind: "rollover_declined", session: sessionId(ctx), window: currentWindow(branchOf(ctx)), why: "auto_compaction_mid_run" });
      return undefined;
    }
    const reason: RolloverReason = inFlightRollover?.reason ?? (event.reason === "manual" ? "model" : "threshold");
    const template = templateRollover(ctx, contextOf(ctx), event.preparation.firstKeptEntryId, reason);
    if (!template) return undefined;
    template.record();
    lastCompactionWasOurs = true;
    return { compaction: { summary: template.summary, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: template.details } };
  });

  pi.on("session_compact", async (event, ctx) => {
    const ours = isRolloverDetails(event.compactionEntry.details);
    if (!ours && lastCompactionWasOurs && ctx.hasUI) ctx.ui.notify("note-context: another extension replaced this compaction summary.", "warning");
    onWindowOpened();
  });
  pi.on("session_compact_failed", async () => {
    pendingRollover = null;
    inFlightRollover = null;
    maintenance = { kind: "idle" };
  });

  // --------------------------------------- scheduled rollover + pressure watch
  // A model-, user- or host-requested rollover runs once the agent run has settled: the model
  // was told to end its turn after new_context, and ctx.compact() aborts any
  // in-flight run, so this is the only safe moment. pendingRollover is cleared
  // synchronously before compact() to make the schedule idempotent.
  //
  // A host schedule is re-run through the same host gate here: it passed when notes were
  // written, but the model may have kept working ("finish what this turn needs") and the
  // world can move either way before settle — the cut can pass the review marker (stale
  // notebook), pressure can fall below the floor (ObservationPack placeholders shrink the
  // live context), the model can change, or an external compaction owner can take over.
  // Handing a stale schedule to compaction would make session_before_compact decline the
  // template and fall through to Pi's LLM summary — the outcome the host path exists to
  // avoid. A failed re-check cancels the schedule and records the blocker; the next notes
  // write re-arms it. Model/user requests are not re-checked for economics: the tool
  // call is the judgment, and session_before_compact still guards template freshness.
  //
  // The same re-check also runs at turn_end (below) so that a host schedule which went stale
  // inside the run is cancelled before it can mask the pressure maintenance for that turn.
  //
  /** Re-run the host gate on a pending host schedule; cancel and record it when it fails. Returns true when cancelled. */
  function cancelHostScheduleIfStale(ctx: ExtensionContext): boolean {
    if (pendingRollover?.reason !== "host") return false;
    const branch = branchOf(ctx);
    const verdict = hostGate(ctx, reconstructNotebook(branch));
    if (verdict.ok) return false;
    pendingRollover = null;
    appendLedger({ kind: "rollover_cancelled", session: sessionId(ctx), window: currentWindow(branch), reason: "host", why: verdict.blocker });
    return true;
  }

  pi.on("agent_start", async () => {
    runAborted = false;
  });
  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.signal?.aborted) runAborted = true;
  });

  const scheduled = (r: RolloverReason) => r === "model" || r === "user" || r === "host";

  pi.on("agent_before_settle", async (event, ctx) => {
    reconcileProposal(ctx);
    if (!pendingRollover || !scheduled(pendingRollover.reason)) return undefined;
    // An external compaction owner writes the summary: agent_settled runs Pi's compaction.
    if (externalOwner(ctx)) return undefined;
    // ESC means stop: rolling over would compact and then continue the run the user just
    // interrupted. Only an explicit user request for a fresh window survives the abort.
    if ((runAborted || event.outcome === "aborted") && pendingRollover.reason !== "user") {
      appendLedger({ kind: "rollover_cancelled", session: sessionId(ctx), window: currentWindow(branchOf(ctx)), reason: pendingRollover.reason, why: "user_abort" });
      pendingRollover = null;
      return undefined;
    }
    if (cancelHostScheduleIfStale(ctx)) return undefined;
    // Another extension already compacts at this boundary: that compaction opens the new window,
    // so the schedule is satisfied rather than compacted a second time.
    if (event.entries.some((e) => e.type === "compaction")) {
      appendLedger({ kind: "rollover_cancelled", session: sessionId(ctx), window: currentWindow(branchOf(ctx)), reason: pendingRollover.reason, why: "other_compaction" });
      pendingRollover = null;
      return undefined;
    }
    const drafts = boundaryRollover(ctx, pendingRollover.reason, SCHEDULED_CONTINUE);
    // Declined (ledger row written): the schedule stays for agent_settled, which hands the
    // window to Pi's compaction exactly as before boundary rollovers existed.
    if (!drafts) return undefined;
    return { entries: [...event.entries, ...drafts], continue: true };
  });

  // Rollovers agent_before_settle did not take: an external compaction owner, a declined
  // template (Pi's LLM summary takes over), or another extension compacting at that boundary.
  pi.on("agent_settled", async (_event, ctx) => {
    reconcileProposal(ctx);
    if (!pendingRollover || !scheduled(pendingRollover.reason)) return;
    // ESC means stop: rolling over would compact and then trigger a continuation turn the user
    // just interrupted. Only an explicit user request for a fresh window survives the abort.
    if (runAborted && pendingRollover.reason !== "user") {
      appendLedger({ kind: "rollover_cancelled", session: sessionId(ctx), window: currentWindow(branchOf(ctx)), reason: pendingRollover.reason, why: "user_abort" });
      pendingRollover = null;
      return;
    }
    if (cancelHostScheduleIfStale(ctx)) return;
    const reason = pendingRollover.reason;
    pendingRollover = null;
    inFlightRollover = { reason };
    ctx.compact({
      onComplete: () => {
        inFlightRollover = null;
        pi.sendMessage(
          { customType: "note-context/continue", content: SCHEDULED_CONTINUE, display: true },
          { deliverAs: "followUp", triggerTurn: true },
        );
      },
      onError: (error) => {
        inFlightRollover = null;
        appendLedger({ kind: "rollover_failed", session: sessionId(ctx), window: currentWindow(branchOf(ctx)), reason, why: compactFailureCategory(error) });
      },
    });
  });

  /**
   * Stable category for a ctx.compact() error — the ledger stores counts and ids only, never
   * provider text. Matches Pi's own compact() messages (agent-session.ts); anything else is "other".
   */
  function compactFailureCategory(error: unknown): string {
    const m = error instanceof Error ? error.message : String(error);
    if (/^Compaction cancelled/.test(m)) return "cancelled";
    if (/^Already compacted/.test(m)) return "already_compacted";
    if (/^Nothing to compact/.test(m)) return "nothing_to_compact";
    if (/^No model/i.test(m)) return "no_model";
    return "other";
  }

  pi.on("turn_end", async (event, ctx) => {
    if (ctx.signal?.aborted) runAborted = true;
    // Fallback rollover: the maintenance checkpoint landed in this turn's notes call. Roll over
    // here, inside the run, so the model continues in the new window without an abort.
    if (pendingRollover?.reason === "fallback") {
      pendingRollover = null;
      const window = currentWindow(branchOf(ctx));
      if (runAborted || event.outcome !== "completed") {
        appendLedger({ kind: "rollover_cancelled", session: sessionId(ctx), window, reason: "fallback", why: runAborted || event.outcome === "aborted" ? "user_abort" : "turn_error" });
        maintenance = { kind: "idle" };
        return undefined;
      }
      if (event.entries.some((e) => e.type === "compaction")) {
        // Another extension compacts at this boundary; its compaction opens the new window.
        appendLedger({ kind: "rollover_cancelled", session: sessionId(ctx), window, reason: "fallback", why: "other_compaction" });
        maintenance = { kind: "idle" };
        return undefined;
      }
      const drafts = boundaryRollover(ctx, "fallback", FALLBACK_CONTINUE);
      if (drafts) return { entries: [...event.entries, ...drafts], continue: true };
      // Declined (ledger row written): hand this window to Pi's threshold compaction.
      maintenance = { kind: "idle" };
      maintenanceExhaustedForWindow = window;
      return undefined;
    }
    if (runAborted) return; // no reminder or maintenance steer into a run the user stopped; settle decides the schedule
    if (event.message.role === "assistant") cancelHostScheduleIfStale(ctx);
    if (pendingRollover || inFlightRollover || maintenance.kind !== "idle") return;
    if (event.message.role !== "assistant") return;
    const usage = ctx.getContextUsage();
    const t = thresholds(ctx);
    const zone = zoneFor(usage?.tokens ?? null, t);
    if (zone === "normal") return;
    const branch = branchOf(ctx);
    const notebook = reconstructNotebook(branch);
    const window = currentWindow(branch);
    if (zone === "fallback") {
      if (maintenanceExhaustedForWindow === window) return;
      const r = step(maintenance, { type: "enter", notebookRevision: notebook.revision }, () => ++attemptCounter);
      maintenance = r.state;
      if (r.action === "steer_request" && maintenance.kind === "requested") {
        appendLedger({ kind: "maintenance", session: sessionId(ctx), window, action: "steer_request", attempt: maintenance.attempt });
        pi.sendMessage({ customType: MAINTENANCE_CUSTOM_TYPE, content: maintenanceRequestText(maintenance.attempt), display: true, details: { attempt: maintenance.attempt } }, { deliverAs: "steer" });
      }
      return;
    }
    if (reminderShownForWindow === window) return;
    reminderShownForWindow = window;
    const toThreshold = fallbackThreshold(t) - (usage?.tokens ?? 0);
    appendLedger({ kind: "reminder", session: sessionId(ctx), window, zone });
    pi.sendMessage(
      { customType: "note-context/reminder", content: reminderText(toThreshold, notebook.revision > 0 ? renderNotebook(notebook.sections) : null), display: true },
      { deliverAs: "steer" },
    );
  });

  // ---------------------------------------------------- guidance + context
  // Add a structured prompt section instead of returning `systemPrompt`: a returned prompt forces
  // a whole-prompt replacement, which drops section changes made by extensions loaded later and
  // prevents Pi from recording the change as a transcript delta.
  pi.on("before_agent_start", async (event) => {
    // An earlier handler forced the whole prompt: sections are not rendered, so append to it.
    const forced = event.systemPromptOptions.forceSystemPrompt;
    if (forced !== undefined) return forced.includes(SYSTEM_PROMPT_SECTION) ? undefined : { systemPrompt: `${forced}\n\n${SYSTEM_PROMPT_SECTION}` };
    event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, note_context: SYSTEM_PROMPT_SECTION };
    return undefined;
  });

  pi.on("context", async (event, ctx) => {
    const branch = branchOf(ctx);
    const activeAttempt = maintenance.kind === "requested" ? maintenance.attempt : null;
    let messages = event.messages
      // Status messages written by earlier versions (a trailing custom message per
      // request) are dropped; the status line now lives inside tool results.
      .filter((m) => !(m.role === "custom" && m.customType === LEGACY_STATUS_CUSTOM_TYPE))
      .map((m) => {
        // A maintenance instruction is imperative; once its attempt is no longer active it must
        // not survive in the retained tail as a live command.
        if (m.role === "custom" && m.customType === MAINTENANCE_CUSTOM_TYPE) {
          const attempt = (m.details as { attempt?: number } | undefined)?.attempt;
          if (attempt !== undefined && attempt === activeAttempt) return m;
          return { ...m, content: `[note-context] (earlier maintenance request #${attempt ?? "?"} — completed; no action required)` };
        }
        return m;
      });
    if (config.entryIdTrailers) messages = addTrailers(messages, buildIdIndex(branch));
    return { messages };
  });

  // The status line is a suffix on a tool result, persisted with it, so every later
  // request replays it byte-for-byte (a trailing message that changes between requests
  // breaks implicit prefix caching). Delivered when pressure crosses a step of
  // `statusStepTokens`, when tokens added since the last notes review cross a step, on
  // the first reading of a window, and once after /tree navigation. Own tool results
  // and error results are never decorated.
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || OWN_TOOLS.has(event.toolName)) return undefined;
    const branch = branchOf(ctx);
    const notebook = reconstructNotebook(branch);
    const physicalUsage = ctx.getContextUsage();
    const tokens = physicalUsage?.tokens ?? null;
    const since = tokensSinceReview(tokens, notebook);
    if (branchChangedPending) statusOdometer.force();
    if (!statusOdometer.shouldShow(config.statusStepTokens, tokens, since, notebook)) return undefined;
    const line = renderStatusLine({
      usage: physicalUsage ? { tokens, contextWindow: budgetWindow(ctx), physicalWindow: physicalUsage.contextWindow } : undefined,
      notebook,
      tokensSinceReview: since,
      branchChanged: branchChangedPending,
      externalCompaction: externalOwner(ctx),
    });
    const patch = appendSuffixPatch(event.content, line);
    if (!patch) return undefined; // no text part to carry it: stay armed for the next result
    statusOdometer.confirm(config.statusStepTokens, tokens, since, notebook);
    branchChangedPending = false;
    return patch;
  });

  // Provider cache statistics are accumulated in memory and written as ONE row per
  // window at rollover (see session_before_compact). A per-call row carried no
  // behavioural information and outnumbered every other ledger kind 20:1.
  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return undefined;
    const u = event.message.usage;
    if (u && (u.cacheRead > 0 || u.input > 0)) {
      cacheAcc.calls += 1;
      cacheAcc.cacheRead += u.cacheRead;
      cacheAcc.input += u.input;
    }
    return undefined;
  });

  // ------------------------------------------------------- branch lifecycle
  pi.on("session_tree", async () => {
    resetVolatile();
    branchChangedPending = true;
  });
  pi.on("session_start", async () => resetVolatile());
  pi.on("session_before_switch", async () => resetVolatile());
  pi.on("session_before_fork", async () => resetVolatile());
  pi.on("session_shutdown", async () => {
    await flushLedger();
  });

  // --------------------------------------------------------------- user view
  pi.registerCommand("notes", {
    description: "Show the current session notebook",
    handler: async (_args, ctx) => {
      const nb = notebookOf(ctx);
      const body = nb.revision === 0 ? "Notebook is empty." : `Notebook revision ${nb.revision}\n\n${renderNotebook(nb.sections)}`;
      if (ctx.hasUI) ctx.ui.notify(body, "info");
    },
  });
}
