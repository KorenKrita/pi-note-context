# pi-note-context

Notebook-backed context windows for the [Pi](https://github.com/earendil-works/pi-mono) coding agent.

Three model-invoked tools:

- `notes` — a small, sectioned checkpoint of working state that survives context-window rollovers
- `history` — read back earlier conversation, including what left the window
- `new_context` — start a fresh window without an LLM summary *(step 2, not yet shipped)*

Design: [`docs/DESIGN.md`](docs/DESIGN.md). Independent review and responses: [`docs/review/`](docs/review/).

## Status

Step 1 of 4 (see DESIGN.md §13): `notes`, `history`, status line, branch reconstruction. No rollover yet.

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
