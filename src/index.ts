/**
 * pi-note-context — composition root.
 * Step 1 of the ship order (DESIGN.md §13): notes + history + status line +
 * branch reconstruction. No rollover yet.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  HISTORY_DESCRIPTION,
  HISTORY_GUIDELINES,
  HISTORY_SNIPPET,
  NOTES_DESCRIPTION,
  NOTES_GUIDELINES,
  NOTES_SNIPPET,
  SYSTEM_PROMPT_SECTION,
} from "./guidance.ts";
import { currentWindow, indexBranch, list, read, renderList, renderRead, renderSearch, search } from "./history.ts";
import {
  applySections,
  DEFAULT_LIMITS,
  makeRecord,
  NOTEBOOK_ENTRY_TYPE,
  reconstructNotebook,
  renderNotebook,
  type Notebook,
  type NotebookLimits,
} from "./notebook.ts";
import { renderStatusLine, STATUS_CUSTOM_TYPE, turnsSince } from "./status.ts";

interface Config {
  enabled: boolean;
  limits: NotebookLimits;
  historyReadMaxChars: number;
  externalCompactionModels: string[];
}

function loadConfig(): Config {
  // Step 1: defaults only. File-backed config arrives with rollover (step 2).
  return { enabled: true, limits: DEFAULT_LIMITS, historyReadMaxChars: 12_000, externalCompactionModels: [] };
}

const NotesParams = Type.Object({
  sections: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Section name → text. \"\" deletes a section." })),
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

type ToolOut = { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean };

function text(msg: string, details: Record<string, unknown> = {}, isError = false): ToolOut {
  return { content: [{ type: "text", text: msg }], details, ...(isError ? { isError: true } : {}) };
}

export default function noteContext(pi: ExtensionAPI): void {
  const config = loadConfig();
  if (!config.enabled) return;

  /** Volatile per-session state; rebuilt from the journal on every session_start. */
  let branchChangedPending = false;

  const branchOf = (ctx: ExtensionContext) => ctx.sessionManager.getBranch();
  const notebookOf = (ctx: ExtensionContext): Notebook => reconstructNotebook(branchOf(ctx));

  /** Id of the assistant message that issued the current tool call: the last assistant entry on the branch. */
  function issuingAssistantId(ctx: ExtensionContext): string | null {
    const branch = branchOf(ctx);
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i]!;
      if (e.type === "message" && e.message.role === "assistant") return e.id;
    }
    return null;
  }

  // ---------------------------------------------------------------- notes

  pi.registerTool({
    name: "notes",
    label: "Notes",
    description: NOTES_DESCRIPTION,
    promptSnippet: NOTES_SNIPPET,
    promptGuidelines: NOTES_GUIDELINES,
    parameters: NotesParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const current = notebookOf(ctx);
      const hasSections = params.sections !== undefined && Object.keys(params.sections).length > 0;

      // Read
      if (!hasSections && !params.reviewed) {
        if (current.revision === 0) {
          return text("Notebook is empty (revision 0). Write with notes({ sections: { Task: \"…\", Next: \"…\" } }).", { revision: 0 });
        }
        return text(`Notebook revision ${current.revision}\n\n${renderNotebook(current.sections)}`, { revision: current.revision, entryId: current.entryId });
      }

      // Review-only attestation
      if (params.reviewed && !hasSections) {
        if (current.revision === 0) {
          return text("Nothing to review: the notebook is empty. Write sections first.", {}, true);
        }
        const record = makeRecord(current, current.sections, issuingAssistantId(ctx), true);
        pi.appendEntry(NOTEBOOK_ENTRY_TYPE, record);
        return text(`Notebook revision ${record.revision}: reviewed, unchanged.`, { revision: record.revision, reviewOnly: true });
      }

      // Write
      const result = applySections(current.sections, { sections: params.sections!, replaceAll: params.replaceAll }, config.limits);
      if (!result.ok) {
        return text(`notes rejected (${result.reason}): ${result.detail}`, { reason: result.reason }, true);
      }
      if (!result.changed && !params.replaceAll) {
        // Treat as a review: same content, fresh review marker.
        const record = makeRecord(current, current.sections, issuingAssistantId(ctx), true);
        pi.appendEntry(NOTEBOOK_ENTRY_TYPE, record);
        return text(`Notebook revision ${record.revision}: content unchanged, review marker updated.`, { revision: record.revision, reviewOnly: true });
      }
      const record = makeRecord(current, result.sections, issuingAssistantId(ctx));
      pi.appendEntry(NOTEBOOK_ENTRY_TYPE, record);
      const remainingBytes = config.limits.maxBytes - result.size.bytes;
      const remainingTokens = config.limits.maxTokens - result.size.tokensEstimate;
      return text(
        `Notebook revision ${record.revision} saved: ${Object.keys(result.sections).length} section(s), ${result.size.bytes} bytes / ~${result.size.tokensEstimate} tokens; ${remainingBytes} bytes / ~${remainingTokens} tokens remaining.`,
        { revision: record.revision, sections: Object.keys(result.sections), bytes: result.size.bytes, tokensEstimate: result.size.tokensEstimate },
      );
    },
  });

  // -------------------------------------------------------------- history

  pi.registerTool({
    name: "history",
    label: "History",
    description: HISTORY_DESCRIPTION,
    promptSnippet: HISTORY_SNIPPET,
    promptGuidelines: HISTORY_GUIDELINES,
    parameters: HistoryParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const items = indexBranch(branchOf(ctx));
      const modes = [params.query !== undefined, params.id !== undefined, params.list === true].filter(Boolean).length;
      if (modes !== 1) {
        return text("history: pass exactly one of query, id, or list:true.", {}, true);
      }
      if (params.id !== undefined) {
        const r = read(items, params.id, params.context ?? 1);
        if (!r) return text(`history: no model-visible entry with id ${params.id} on this branch.`, {}, true);
        return text(renderRead(r, config.historyReadMaxChars), { id: r.target.id, window: r.target.window });
      }
      if (params.query !== undefined) {
        if (params.query.length === 0) return text("history: query must be non-empty.", {}, true);
        const opts = { query: params.query, window: params.window, limit: params.limit };
        const r = search(items, opts);
        return text(renderSearch(r, opts), { hits: r.hits.length, scanned: r.scanned, truncated: r.truncated });
      }
      const r = list(items, { window: params.window, limit: params.limit, offset: params.offset });
      return text(renderList(r, params.window), { total: r.total, shown: r.items.length });
    },
  });

  // ----------------------------------------------------- guidance + status

  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_PROMPT_SECTION}` };
  });

  pi.on("context", async (event, ctx) => {
    const branch = branchOf(ctx);
    const notebook = reconstructNotebook(branch);
    const model = ctx.model;
    const external = model ? config.externalCompactionModels.includes(`${model.provider}/${model.id}`) : false;
    const line = renderStatusLine({
      window: currentWindow(branch),
      usage: ctx.getContextUsage(),
      notebook,
      turnsSinceReview: turnsSince(branch, notebook.reviewedThrough),
      branchChanged: branchChangedPending,
      externalCompaction: external,
    });
    branchChangedPending = false;
    const messages = event.messages.filter((m) => !(m.role === "custom" && m.customType === STATUS_CUSTOM_TYPE));
    messages.push({ role: "custom", customType: STATUS_CUSTOM_TYPE, content: line, display: false, timestamp: Date.now() });
    return { messages };
  });

  pi.on("session_tree", async () => {
    branchChangedPending = true;
  });
  pi.on("session_start", async () => {
    branchChangedPending = false;
  });

  // ------------------------------------------------------------ user view

  pi.registerCommand("notes", {
    description: "Show the current session notebook",
    handler: async (_args, ctx) => {
      const nb = notebookOf(ctx);
      const text = nb.revision === 0 ? "Notebook is empty." : `Notebook revision ${nb.revision}\n\n${renderNotebook(nb.sections)}`;
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    },
  });
}
