# Response to Astra review v1 (2026-09-10)

Review: `2026-09-10-astra-review-v1.md`. Brief reviewed: `2026-09-10-brief-v1.md`. Resulting design: `../DESIGN.md`.

| # | Finding | Decision | Where in DESIGN.md |
|---|---|---|---|
| 1 | Per-section replace needs atomic multi-section; fewer canonical sections; don't distinguish whole-rewrite by omitted key | Accepted. `sections` map, `replaceAll` explicit, 5 canonical sections, ≤8 total | §3.1 |
| 2 | Byte cap ≠ token cap; reject oversized atomically; notes writes accumulate in transcript | Accepted. Dual ceiling, atomic reject, guidance says "after meaningful batches, not every edit" | §3.1, §7 |
| 3 | "Before latest user message" is not the tail; changing header defeats cache; steer ≠ developer role | Accepted. Notebook no longer injected per call (decided independently before the review); status line placed at last protocol boundary; "developer message" wording removed | §4 |
| 4 | Freshness gate is an activity check; "fresh" = reviewed against what is dropped | Accepted. `reviewedThrough` entry id compared against cut point; `reviewed:true` attestation | §3.1, §3.2 |
| 5 | Guidance over-triggers and under-triggers; milestone alone not a reason; reclaim check | Accepted. Guidance rewritten (merged Astra's text with the concrete moments kept as examples, not triggers); host refuses reclaim < 20K | §7, §3.2 |
| 6 | "One write then new_context" is two LLM calls; need state machine; enforce in dispatch; scope reminders | Accepted in full. Host compacts after checkpoint; dispatch guard; attempt-scoped reminders; never template-rollover without valid notebook | §6 |
| 7 | Make notebook visible; frame as working state; uncertainty labels | Accepted | §3.1, §7 |
| 8 | Separate instruction authority from factual reliability | Accepted, wording adopted nearly verbatim | §7 |
| 9 | Use real journal ids; `[history entry=…]`; annotate in `context` not `tool_result`; neighbours on read | Accepted | §3.3, §4.3 |
| 10A | Branch semantics unspecified | Accepted | §8 |
| 10B | Recovery must not depend on the hook | Accepted — snapshot embedded in compaction summary | §5 |
| 10C | Preserve task-defining request + corrections, labelled historical | Accepted | §5 step 2 |
| 10D | Transactional rollover/concurrency | Accepted as implementation requirements (gate "already pending", volatile state reset, window advances only on `session_compact`) | §3.2, §6, §8 |
| 10E | History allowlist | Accepted | §3.3 |
| 10F | Compaction ownership mode; don't override `/compact` with instructions | Accepted | §5.1 |
| 10G | Real budget accounting; `tokens: null` ≠ 0 | Accepted (status line shows `?`); full accounting deferred to implementation | §4.1 |
| 10H | Outcome evaluation not activity logging | Partially. Ledger stays counts-only; correctness via session reading, ledger locates candidates | §10 |
| — | "Ship first as opt-in notebook assistance, keep Pi summaries" | Not adopted as stated. Ship order keeps rollover in step 2, but the embedded snapshot (10B) plus the never-without-notebook rule (§6 step 4) address the underlying risk | §13 |
