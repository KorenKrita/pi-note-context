# Response to implementation review v1 (2026-09-10)

Review: `2026-09-10-astra-impl-review-v1.md` (reviewed HEAD `f7bfe47`). All nine findings accepted; fixes in the following commit. Each was re-verified: unit tests (39 pass) and three live Pi 0.85.1 sessions (model-requested rollover, fallback rollover, uncooperative model).

| # | Finding | Fix |
|---|---|---|
| 1 P1 | Freshness not checked against the actual cut for manual/scheduled rollovers | `session_before_compact` now runs `freshAgainstCut(context, notebook, preparation.firstKeptEntryId)` for every trigger; declines (`stale_notebook_at_cut`) → Pi's LLM summary |
| 2 P2 | `SettingsManager.create` ignored project trust | Passes `{ projectTrusted: ctx.isProjectTrusted() }`; cache keyed by cwd+trust |
| 3 P2 | Window = "after last compaction" ignores the previous compaction's retained tail | Gate, reclaim projection and `droppedRange` now operate on `ctx.sessionManager.buildContextEntries()` (compaction-aware active context); range starts after the leading compaction entry. Tests rewritten to the correct boundary; retained user corrections are pinned |
| 4 P2 | Pi's mid-run auto-compaction could consume the template | Declined (`auto_compaction_mid_run`) unless `inFlightRollover` is set (our own `ctx.compact()`), or the trigger is manual, or the agent is idle |
| 5 P2 | Maintenance re-entered forever after give-up; empty-notebook review not counted | `maintenanceExhaustedForWindow` suppresses re-entry for the window; `reviewed:true` on an empty notebook now feeds `notes_failed`. Additionally (found in live test): a model that ignores the request is bounded — after `MAX_BLOCKED_CALLS` (3) blocked tool calls the guard lifts and Pi's summary takes over |
| 6 P2 | Completed maintenance instruction survives in the retained tail | Messages carry `details.attempt`; the `context` handler rewrites any maintenance message whose attempt is not the active one to a neutral "completed; no action required" line |
| 7 P2 | Tool-call args truncated at index time; read/search not pageable | Full args indexed; `history({id, offset})` pages by character with a continuation footer; `history({query, offset})` skips matching entries; header tells the next offset |
| 8 P2 | `in` operator skipped prototype-named sections | Null-prototype section maps + `Object.hasOwn`; post-order key-count check rejects any collision |
| 9 P2 | Returned `isError` ignored by agent-core | All failure paths `throw`; helper `fail()`; structured refusal details moved into the message text |

Live verification after fixes (Pi 0.85.1, `local-openai/deepseek-v4-flash`):

- 256K window, model-requested: gate ok (38K reclaim) → `agent_settled` → template rollover `reason: model` → continuation → window #2 visible → `history` reaches window #1.
- 60K window, model asked not to call `new_context`: reminder → model wrote notes and called `new_context` anyway (gate ok, 13K) → template rollover.
- 60K window, model forbidden from `notes` and `new_context`: reminder → maintenance #1 → 2 blocked reads → guard lifted → Pi's own LLM compaction (`rollover_declined`) → task completed (`END`).
