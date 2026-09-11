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
  "statusStepTokens": 40000
}
```

`budgetTokens` (default 400K): pressure, reminders and the fallback are measured against `min(contextWindow, budgetTokens)` — a 1M window degrades long before it fills. The status line shows `used/400K budget (1M window)`.

`statusStepTokens` (default 40K): the status line is appended to a tool result (and persisted with it, so provider prompt caches keep hitting) when context usage crosses a multiple of this, or when tokens added since the last notes write/review cross it — not on every call. Shape: `[note-context] 142K/400K budget (1M window) · notes rev 7, +52K since review`.

`autoRollover` (default `true`): after a notes write that passes the gate, the host schedules the rollover itself — the model does not need to call `new_context`. The schedule is re-checked when the turn settles; if work that landed after the write would be dropped unreviewed, it is cancelled (ledger `rollover_cancelled`) rather than handed to Pi's LLM summary, and the next notes write re-arms it.

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
