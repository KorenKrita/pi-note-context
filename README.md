# pi-note-context

Notebook-backed context windows for the [Pi](https://github.com/earendil-works/pi-mono) coding agent.

Three model-invoked tools:

- `notes` — a small, sectioned checkpoint of working state that survives context-window rollovers
- `history` — read back earlier conversation, including what left the window
- `new_context` — start a fresh window without an LLM summary; the new window opens with the notebook snapshot and the task-defining user messages

Design: [`docs/DESIGN.md`](docs/DESIGN.md). Independent review and responses: [`docs/review/`](docs/review/).

## Status

Steps 1–3 of 4 shipped (see DESIGN.md §13) and independently reviewed twice (`docs/review/`): tools, gated rollover, threshold reminder, host fallback with bounded dispatch guard, entry-id trailers, ledger. Step 4 (tuning `leadTokens` / `minReclaimTokens` / section guidance from real sessions) is ongoing.

`/notes` shows the current notebook. Tools are `notes`, `history`, `new_context`.

## User-requested rollover

When the user explicitly asks for a fresh window, update or review `notes`, wait for its result, then call `new_context({ userRequested: true })`. This bypasses `minReclaimTokens` and the host pressure floor (the reminder threshold), not notebook existence or freshness. It still refuses duplicate schedules and a window that fits entirely in the retained recent tail. The turn must end after scheduling.

`new_context()` and `new_context({ userRequested: false })` keep the existing model-decided behavior; automatic host rollovers keep both economic thresholds. Do not use the flag merely because a model-decided rollover was refused. Accepted user requests carry `reason: "user"` through the gate ledger and, when this plugin owns compaction, the rollover summary/details and ledger. External compaction owners still supply their own summary. The flag is a model attestation of the user's request, not a separately authenticated permission.

Reload/restart Pi after updating this local path package so the new tool schema is loaded. No configuration change is needed.

## Configuration

Optional `~/.pi/agent/pi-note-context.json` (global only; every field optional):

```json
{
  "notebookMaxBytes": 16384,
  "notebookMaxTokens": 4096,
  "leadTokens": 24000,
  "fallbackBufferTokens": 12000,
  "minReclaimTokens": 20000,
  "pinnedMessageMaxChars": 600,
  "pinnedTotalMaxTokens": 4096,
  "externalCompactionModels": [],
  "entryIdTrailers": true,
  "autoRollover": true,
  "budgetTokens": 400000,
  "fallbackBudgetTokens": 400000,
  "statusStepTokens": 40000
}
```

`budgetTokens` (default 400K): the status line, the reminder zone and the host auto-rollover floor are measured against `min(contextWindow, budgetTokens)` — a 1M window degrades long before it fills. The reminder zone starts at `budget − reserveTokens − leadTokens`. The status line shows `used/400K budget (1M window)`.

`fallbackBudgetTokens` (default: same as `budgetTokens`): the forced fallback (checkpoint request, tool guard, host compaction) is measured against `min(contextWindow, fallbackBudgetTokens)` and starts at `fallbackBudget − reserveTokens − fallbackBufferTokens`. Set it above `budgetTokens` to remind early but force late, e.g. `400000` / `800000` → reminder from ~360K, forced from ~772K on a 1M window.

`statusStepTokens` (default 40K): the status line is appended to a tool result (and persisted with it, so provider prompt caches keep hitting) when context usage crosses a multiple of this, or when tokens added since the last notes write/review cross it — not on every call. Shape: `[note-context] 142K/400K budget (1M window) · notes rev 7, +52K since review`.

`autoRollover` (default `true`): after a notes write that passes the gate, the host schedules the rollover itself — the model does not need to call `new_context`. The host only does this from the reminder threshold on; below it the model must call `new_context` itself. The same gate runs again when the turn settles; if it no longer passes (unreviewed work would be dropped, pressure fell below the floor, the model changed to an external compaction owner) the schedule is cancelled (ledger `rollover_cancelled` with the blocker) rather than handed to Pi's LLM summary, and the next notes write re-arms it. A run the user aborts (ESC) also cancels a pending host or model schedule (`why: "user_abort"`): no compaction and no continuation turn; only an explicit `userRequested` rollover survives the abort.

`externalCompactionModels` lists `provider/model` ids whose compaction is owned by another extension (e.g. remote Codex compaction); this plugin then yields the summary step for those models but keeps notes, history, reminders and the status line.

Ledger: `~/.pi/agent/state/note-context-ledger.jsonl` (counts and ids only). Disable with `NOTE_CONTEXT_LEDGER_DISABLED=1`.

## Install

```bash
pi install git:github.com/KorenKrita/pi-note-context
```

Requires Pi `>=0.85.0 <0.86.0`.

## Develop

```bash
bun install
bun run verify   # typecheck + tests
```

## With SoL-Pi

Compatible with SoL-Pi's Action Fusion and ObservationPack; list `pi-note-context` **after** SoL-Pi in `packages`. Do not enable SoL-Pi's Online Context Compact together with this plugin (two competing rollover managers). See DESIGN.md §16.
