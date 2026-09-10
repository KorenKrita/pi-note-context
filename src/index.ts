/**
 * pi-note-context — composition root (DESIGN.md).
 * Tools: notes, history, new_context. Events: guidance, status line, id
 * trailers, rollover via session_before_compact, threshold reminder and
 * host fallback, branch-state reset.
 */

import { SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { loadConfig, type Config } from "./config.ts";
import { evaluateGate, projectCut } from "./gate.ts";
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
import { maintenanceRequestText, reminderText, step, zoneFor, type MaintenanceState, type Thresholds } from "./maintenance.ts";
import { applySections, makeRecord, NOTEBOOK_ENTRY_TYPE, reconstructNotebook, renderNotebook, type Notebook } from "./notebook.ts";
import { estimateTokens as estimateText } from "./notebook.ts";
import { droppedRange, makeDetails, pinUserMessages, renderRolloverSummary, type RolloverReason } from "./rollover.ts";
import { renderStatusLine, STATUS_CUSTOM_TYPE, turnsSince } from "./status.ts";
import { addTrailers, buildIdIndex } from "./trailers.ts";

type ToolOut = { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean };
function text(msg: string, details: Record<string, unknown> = {}, isError = false): ToolOut {
  return { content: [{ type: "text", text: msg }], details, ...(isError ? { isError: true } : {}) };
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
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

const NewContextParams = Type.Object({});

export default function noteContext(pi: ExtensionAPI): void {
  const config: Config = loadConfig();
  if (!config.enabled) return;

  // ------------------------------------------------------------ volatile state
  // All of this is rebuilt from the journal or reset on session replacement.
  let branchChangedPending = false;
  let pendingRollover: { reason: RolloverReason; requestedAtLeaf: string | null } | null = null;
  let inFlightRollover: { reason: RolloverReason } | null = null;
  let maintenance: MaintenanceState = { kind: "idle" };
  let attemptCounter = 0;
  let reminderShownForWindow: number | null = null;
  let lastRolloverLeafId: string | null = null; // for "turns since rollover" in history ledger rows
  let lastCompactionWasOurs = false;

  const resetVolatile = () => {
    branchChangedPending = false;
    pendingRollover = null;
    inFlightRollover = null;
    maintenance = { kind: "idle" };
    reminderShownForWindow = null;
    lastRolloverLeafId = null;
    lastCompactionWasOurs = false;
  };

  // ------------------------------------------------------------------ helpers
  const branchOf = (ctx: ExtensionContext) => ctx.sessionManager.getBranch();
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
  let settingsCache: { cwd: string; value: typeof DEFAULT_COMPACTION } | null = null;
  /** The user's real compaction settings (global + project), so gate projection matches Pi's cut. */
  function compactionSettings(ctx?: ExtensionContext): typeof DEFAULT_COMPACTION {
    const cwd = ctx?.cwd ?? process.cwd();
    if (settingsCache && settingsCache.cwd === cwd) return settingsCache.value;
    try {
      const sm = SettingsManager.create(cwd, process.env["PI_CODING_AGENT_DIR"]);
      const c = sm.getCompactionSettings();
      const value = {
        keepRecentTokens: c.keepRecentTokens ?? DEFAULT_COMPACTION.keepRecentTokens,
        reserveTokens: c.reserveTokens ?? DEFAULT_COMPACTION.reserveTokens,
        enabled: c.enabled ?? DEFAULT_COMPACTION.enabled,
      };
      settingsCache = { cwd, value };
      return value;
    } catch {
      return DEFAULT_COMPACTION;
    }
  }

  function thresholds(ctx: ExtensionContext): Thresholds {
    const usage = ctx.getContextUsage();
    return {
      contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
      reserveTokens: compactionSettings(ctx).reserveTokens,
      leadTokens: config.leadTokens,
      fallbackBufferTokens: config.fallbackBufferTokens,
    };
  }

  function turnsSinceRollover(ctx: ExtensionContext): number | null {
    if (!lastRolloverLeafId) return null;
    return turnsSince(branchOf(ctx), lastRolloverLeafId);
  }

  function summaryTokenEstimate(ctx: ExtensionContext, notebook: Notebook): number {
    const branch = branchOf(ctx);
    const cut = projectCut(branch, compactionSettings(ctx).keepRecentTokens);
    const pinned = cut.firstKeptEntryId ? pinUserMessages(droppedRange(branch, cut.firstKeptEntryId), config.pin) : [];
    return estimateText(renderRolloverSummary({ window: currentWindow(branch) + 1, reason: "model", notebook, pinned }));
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
        const record = makeRecord(current, current.sections, issuingAssistantId(ctx), true);
        pi.appendEntry(NOTEBOOK_ENTRY_TYPE, record);
        appendLedger({ kind: "notes_write", session: sessionId(ctx), window, revision: record.revision, bytes: 0, reviewOnly: true });
        onNotesLanded(ctx, record.revision);
        return record;
      };

      if (params.reviewed && !hasSections) {
        if (current.revision === 0) return text("Nothing to review: the notebook is empty. Write sections first.", {}, true);
        const record = commitReview();
        return text(`Notebook revision ${record.revision}: reviewed, unchanged.`, { revision: record.revision, reviewOnly: true });
      }

      const result = applySections(current.sections, { sections: params.sections!, replaceAll: params.replaceAll }, config.limits);
      if (!result.ok) {
        appendLedger({ kind: "notes_rejected", session: sessionId(ctx), window, reason: result.reason });
        onNotesFailed(ctx, `${result.reason}: ${result.detail}`);
        return text(`notes rejected (${result.reason}): ${result.detail}`, { reason: result.reason }, true);
      }
      if (!result.changed && !params.replaceAll) {
        const record = commitReview();
        return text(`Notebook revision ${record.revision}: content unchanged, review marker updated.`, { revision: record.revision, reviewOnly: true });
      }
      const record = makeRecord(current, result.sections, issuingAssistantId(ctx));
      pi.appendEntry(NOTEBOOK_ENTRY_TYPE, record);
      appendLedger({ kind: "notes_write", session: sessionId(ctx), window, revision: record.revision, bytes: result.size.bytes, reviewOnly: false });
      onNotesLanded(ctx, record.revision);
      const remainingBytes = config.limits.maxBytes - result.size.bytes;
      const remainingTokens = config.limits.maxTokens - result.size.tokensEstimate;
      return text(
        `Notebook revision ${record.revision} saved: ${Object.keys(result.sections).length} section(s), ${result.size.bytes} bytes / ~${result.size.tokensEstimate} tokens; ${remainingBytes} bytes / ~${remainingTokens} tokens remaining.`,
        { revision: record.revision, sections: Object.keys(result.sections), bytes: result.size.bytes, tokensEstimate: result.size.tokensEstimate },
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
      if (modes !== 1) return text("history: pass exactly one of query, id, or list:true.", {}, true);
      const since = turnsSinceRollover(ctx);
      if (params.id !== undefined) {
        const r = read(items, params.id, params.context ?? 1);
        appendLedger({ kind: "history", session: sessionId(ctx), window, mode: "read", hits: r ? 1 : 0, turnsSinceRollover: since });
        if (!r) return text(`history: no model-visible entry with id ${params.id} on this branch.`, {}, true);
        return text(renderRead(r, config.historyReadMaxChars), { id: r.target.id, window: r.target.window });
      }
      if (params.query !== undefined) {
        if (params.query.length === 0) return text("history: query must be non-empty.", {}, true);
        const opts = { query: params.query, window: params.window, limit: params.limit };
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
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const branch = branchOf(ctx);
      const notebook = notebookOf(ctx);
      const window = currentWindow(branch);
      if (externalOwner(ctx)) {
        // Owner produces the summary; we only validate that notes exist and schedule.
        if (notebook.revision === 0) return text("no notebook on this branch — write notes first.", { blocker: "no_notebook" }, true);
        pendingRollover = { reason: "model", requestedAtLeaf: ctx.sessionManager.getLeafId() };
        appendLedger({ kind: "gate", session: sessionId(ctx), window, ok: true });
        return text(`rollover scheduled (external compaction owner for ${modelKey(ctx)}): window #${window} → #${window + 1} at the end of this turn. End the turn now without further tool calls.`, { external: true });
      }
      const verdict = evaluateGate({
        branch,
        notebook,
        settings: { keepRecentTokens: compactionSettings(ctx).keepRecentTokens },
        minReclaimTokens: config.minReclaimTokens,
        pending: pendingRollover !== null,
        summaryTokens: summaryTokenEstimate(ctx, notebook),
      });
      appendLedger({ kind: "gate", session: sessionId(ctx), window, ok: verdict.ok, ...(verdict.ok ? { reclaim: verdict.reclaimTokens } : { blocker: verdict.blocker, reclaim: verdict.reclaimTokens }) });
      if (!verdict.ok) return text(`new_context refused: ${verdict.message}`, { blocker: verdict.blocker }, true);
      pendingRollover = { reason: "model", requestedAtLeaf: ctx.sessionManager.getLeafId() };
      return text(
        `rollover scheduled: window #${window} → #${window + 1} at the end of this turn (~${Math.round(verdict.reclaimTokens / 1000)}K tokens reclaimed, ${verdict.droppedEntries} entries leave the window). End the turn now without further tool calls.`,
        { reclaimTokens: verdict.reclaimTokens, droppedEntries: verdict.droppedEntries },
      );
    },
  });

  // -------------------------------------------------- maintenance hooks (notes)
  function onNotesLanded(ctx: ExtensionContext, revision: number): void {
    const r = step(maintenance, { type: "notes_ok", revision }, () => ++attemptCounter);
    maintenance = r.state;
    if (r.action === "compact_now") {
      appendLedger({ kind: "maintenance", session: sessionId(ctx), window: currentWindow(branchOf(ctx)), action: "compact_now", attempt: maintenance.kind === "checkpointed" ? maintenance.attempt : 0 });
      inFlightRollover = { reason: "fallback" };
      // ctx.compact() aborts the in-flight run. Resume with a continuation so the
      // task the model was doing does not stall in the new window.
      ctx.compact({
        onComplete: () => {
          inFlightRollover = null;
          pi.sendMessage(
            { customType: "note-context/continue", content: "[note-context] New context window started after the maintenance checkpoint. Continue with the notebook's Next action.", display: true },
            { deliverAs: "followUp", triggerTurn: true },
          );
        },
        onError: () => {
          maintenance = { kind: "idle" };
          inFlightRollover = null;
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
      pi.sendMessage({ customType: "note-context/maintenance", content: maintenanceRequestText(maintenance.attempt, error), display: true }, { deliverAs: "steer" });
    } else if (r.action === "give_up") {
      appendLedger({ kind: "maintenance", session: sessionId(ctx), window, action: "give_up", attempt: 0 });
    }
  }

  // ---------------------------------------------------- dispatch guard (§6)
  pi.on("tool_call", async (event) => {
    if (maintenance.kind !== "requested") return undefined;
    if (event.toolName === "notes") return undefined;
    return { block: true, reason: "context maintenance in progress — only `notes` is available until the checkpoint lands." };
  });

  // -------------------------------------------------- rollover (compaction)
  pi.on("session_before_compact", async (event, ctx) => {
    lastCompactionWasOurs = false;
    if (event.customInstructions) return undefined; // user-directed /compact: Pi's LLM summary
    if (externalOwner(ctx)) return undefined; // another extension owns compaction for this model
    const branch = branchOf(ctx);
    const notebook = reconstructNotebook(branch);
    const window = currentWindow(branch);
    if (notebook.revision === 0) {
      appendLedger({ kind: "rollover_declined", session: sessionId(ctx), window, why: "no_notebook" });
      return undefined; // never template-rollover without a notebook (§6 step 4)
    }
    const requested = inFlightRollover ?? pendingRollover;
    const reason: RolloverReason = requested?.reason ?? (event.reason === "manual" ? "model" : "threshold");
    if (!requested && event.reason !== "manual") {
      // Threshold/overflow reached without a model request. Our notebook exists, so a
      // template rollover is still better than an LLM summary — but only if the notebook
      // is not stale relative to what will be dropped. Otherwise let Pi summarise.
      const cutIdx = branch.findIndex((e) => e.id === event.preparation.firstKeptEntryId);
      const reviewedIdx = notebook.reviewedThrough ? branch.findIndex((e) => e.id === notebook.reviewedThrough) : -1;
      if (cutIdx > 0 && reviewedIdx < cutIdx - 1) {
        appendLedger({ kind: "rollover_declined", session: sessionId(ctx), window, why: "stale_notebook_at_threshold" });
        return undefined;
      }
    }
    const dropped = droppedRange(branch, event.preparation.firstKeptEntryId);
    const pinned = pinUserMessages(dropped, config.pin);
    const summary = renderRolloverSummary({ window: window + 1, reason, notebook, pinned });
    const details = makeDetails(window + 1, reason, notebook, pinned);
    lastCompactionWasOurs = true;
    appendLedger({ kind: "rollover", session: sessionId(ctx), fromWindow: window, reason, notebookRevision: notebook.revision, reclaim: null, pinned: pinned.length });
    return { compaction: { summary, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details } };
  });

  pi.on("session_compact", async (event, ctx) => {
    const ours = isRolloverDetails(event.compactionEntry.details);
    if (ours) lastRolloverLeafId = event.compactionEntry.id;
    if (!ours && lastCompactionWasOurs && ctx.hasUI) ctx.ui.notify("note-context: another extension replaced this compaction summary.", "warning");
    pendingRollover = null;
    inFlightRollover = null;
    maintenance = step(maintenance, { type: "rollover_done" }, () => attemptCounter).state;
    reminderShownForWindow = null;
    lastCompactionWasOurs = false;
  });
  pi.on("session_compact_failed", async () => {
    pendingRollover = null;
    inFlightRollover = null;
    maintenance = { kind: "idle" };
  });

  // --------------------------------------- scheduled rollover + pressure watch
  // A model-requested rollover runs once the agent run has settled: the model
  // was told to end its turn after new_context, and ctx.compact() aborts any
  // in-flight run, so this is the only safe moment. pendingRollover is cleared
  // synchronously before compact() to make the schedule idempotent.
  pi.on("agent_settled", async (_event, ctx) => {
    if (!pendingRollover || pendingRollover.reason !== "model") return;
    inFlightRollover = { reason: pendingRollover.reason };
    pendingRollover = null;
    ctx.compact({
      onComplete: () => {
        inFlightRollover = null;
        pi.sendMessage(
          { customType: "note-context/continue", content: "[note-context] New context window started. Continue with the notebook's Next action.", display: true },
          { deliverAs: "followUp", triggerTurn: true },
        );
      },
      onError: () => {
        inFlightRollover = null;
      },
    });
  });

  pi.on("turn_end", async (event, ctx) => {
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
      const r = step(maintenance, { type: "enter", notebookRevision: notebook.revision }, () => ++attemptCounter);
      maintenance = r.state;
      if (r.action === "steer_request" && maintenance.kind === "requested") {
        appendLedger({ kind: "maintenance", session: sessionId(ctx), window, action: "steer_request", attempt: maintenance.attempt });
        pi.sendMessage({ customType: "note-context/maintenance", content: maintenanceRequestText(maintenance.attempt), display: true }, { deliverAs: "steer" });
      }
      return;
    }
    if (reminderShownForWindow === window) return;
    reminderShownForWindow = window;
    const toThreshold = t.contextWindow - t.reserveTokens - (usage?.tokens ?? 0);
    appendLedger({ kind: "reminder", session: sessionId(ctx), window, zone });
    pi.sendMessage(
      { customType: "note-context/reminder", content: reminderText(toThreshold, notebook.revision > 0 ? renderNotebook(notebook.sections) : null), display: true },
      { deliverAs: "steer" },
    );
  });

  // ---------------------------------------------------- guidance + context
  pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_PROMPT_SECTION}` }));

  pi.on("context", async (event, ctx) => {
    const branch = branchOf(ctx);
    const notebook = reconstructNotebook(branch);
    let messages = event.messages.filter((m) => !(m.role === "custom" && m.customType === STATUS_CUSTOM_TYPE));
    if (config.entryIdTrailers) messages = addTrailers(messages, buildIdIndex(branch));
    const line = renderStatusLine({
      window: currentWindow(branch),
      usage: ctx.getContextUsage(),
      notebook,
      turnsSinceReview: turnsSince(branch, notebook.reviewedThrough),
      branchChanged: branchChangedPending,
      externalCompaction: externalOwner(ctx),
    });
    branchChangedPending = false;
    messages.push({ role: "custom", customType: STATUS_CUSTOM_TYPE, content: line, display: false, timestamp: Date.now() });
    return { messages };
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return undefined;
    const u = event.message.usage;
    if (u && (u.cacheRead > 0 || u.input > 0)) {
      appendLedger({ kind: "cache", session: sessionId(ctx), window: currentWindow(branchOf(ctx)), cacheRead: u.cacheRead, input: u.input });
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
