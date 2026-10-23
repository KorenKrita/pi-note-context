# pi-note-context

Notebook-backed context windows for the [Pi](https://github.com/earendil-works/pi-mono) coding agent.

Three model-invoked tools:

- `notes` — a small, sectioned checkpoint of working state that survives context-window rollovers
- `history` — read back earlier conversation, including what left the window
- `new_context` — start a fresh window without an LLM summary; the new window opens with the notebook snapshot, a one-line index of every earlier user message, and the task-defining user messages

Design: [`docs/DESIGN.md`](docs/DESIGN.md). Independent review and responses: [`docs/review/`](docs/review/).

## Status

Steps 1–3 of 4 shipped (see DESIGN.md §13) and independently reviewed twice (`docs/review/`): tools, gated rollover, threshold reminder, host fallback with bounded dispatch guard, entry-id trailers, ledger. Step 4 (tuning `leadTokens` / `minReclaimTokens` / section guidance from real sessions) is ongoing.

`/notes` shows the current notebook. Tools are `notes`, `history`, `new_context`.

## User-requested rollover

When the user explicitly asks for a fresh window, update or review `notes`, wait for its result, then call `new_context({ userRequested: true })`. This bypasses `minReclaimTokens`, not notebook existence or freshness (the host pressure floor never applies to model or user requests). It still refuses duplicate schedules and a window that fits entirely in the retained recent tail. The turn must end after scheduling.

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
  "sessionIndexMaxTokens": 3072,
  "externalCompactionModels": [],
  "entryIdTrailers": true,
  "autoRollover": true,
  "budgetTokens": 400000,
  "fallbackBudgetTokens": 400000,
  "statusStepTokens": 40000
}
```

`budgetTokens` (default 400K): the reminder zone and the host auto-rollover floor are measured against `min(contextWindow, budgetTokens)` — a 1M window degrades long before it fills. The reminder zone starts at `budget − reserveTokens − leadTokens`. None of these figures is shown to the model: the host owns rollover timing.

`fallbackBudgetTokens` (default: same as `budgetTokens`): the forced fallback (checkpoint request, tool guard, host compaction) is measured against `min(contextWindow, fallbackBudgetTokens)` and starts at `fallbackBudget − reserveTokens − fallbackBufferTokens`. Set it above `budgetTokens` to remind early but force late, e.g. `400000` / `800000` → reminder from ~360K, forced from ~772K on a 1M window.

`statusStepTokens` (default 40K): staleness step for the status line. The line is appended to a tool result (and persisted with it, so provider prompt caches keep hitting) when there are no notes yet and the context has grown by a multiple of this (a short task is never nudged), or when tokens added since the last notes write/review cross a multiple of this — not on every call, and never merely because overall context usage grew. It also carries the one-shot facts `branch changed — verify workspace state` (after `/tree`) and `compaction: external` (once per window). It contains no token, budget or window figures: per-result budget countdowns make current models anxious about context (suggesting new sessions, trimming their own work) and make some misread genuine mid-turn user messages as prompt injection. Shape: `[note-context] notes rev 7 not reviewed for a while — update them, or call notes({reviewed:true}) if they are still accurate`.

The one-per-window reminder (from the reminder threshold) likewise carries no countdown: `[note-context] A context-window rollover is due. Update notes against what will leave the window (current notebook below), or call notes({reviewed:true}) if they are already sufficient. Then call new_context.`

`autoRollover` (default `true`): after a notes write that passes the gate, the host schedules the rollover itself — the model does not need to call `new_context`. The host only does this from the reminder threshold on; below it the model must call `new_context` itself. The same gate runs again when the turn settles; if it no longer passes (unreviewed work would be dropped, pressure fell below the floor, the model changed to an external compaction owner) the schedule is cancelled (ledger `rollover_cancelled` with the blocker) rather than handed to Pi's LLM summary, and the next notes write re-arms it. A run the user aborts (ESC) also cancels a pending host or model schedule (`why: "user_abort"`): no compaction and no continuation turn; only an explicit `userRequested` rollover survives the abort.

`sessionIndexMaxTokens` (default 3072): budget for the rollover summary's index of earlier user messages — one line per message (`w3 [history entry=…] …`, ~80 chars; attachments, quotes, fenced code and pasted log lines collapse to tags like `[file: x]`, `[log 40 lines]`). Over budget, lines shorten to ~40 chars, then the oldest are dropped behind a count line. It tells a fresh window what the session already worked on, so the model checks `history` before redoing an investigation.

`externalCompactionModels` lists `provider/model` ids whose compaction is owned by another extension (e.g. remote Codex compaction); this plugin then yields the summary step for those models but keeps notes, history, reminders and the status line.

Ledger: `~/.pi/agent/state/note-context-ledger.jsonl` (counts and ids only). Disable with `NOTE_CONTEXT_LEDGER_DISABLED=1`.

## Install

```bash
pi install git:github.com/KorenKrita/pi-note-context
```

Requires Pi `>=0.87.0 <0.88.0`.

## Develop

```bash
bun install
bun run verify   # typecheck + tests
```

## With SoL-Pi

Compatible with SoL-Pi's Action Fusion and ObservationPack; list `pi-note-context` **after** SoL-Pi in `packages`. Do not enable SoL-Pi's Online Context Compact together with this plugin (two competing rollover managers). See DESIGN.md §16.
