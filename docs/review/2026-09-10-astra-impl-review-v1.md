## Findings

Reviewed **HEAD `f7bfe47`**. P1 = high severity; P2 = medium severity.

### 1. [P1] Actual compaction bypasses notebook freshness for manual and scheduled rollovers
**Location:** `src/index.ts:324–335`

Freshness is checked only when there is **no pending/in-flight request and the reason is not manual**.

Two reproduced failures:
- Notebook reviewed through `a1`, actual cut at `a8`: plain `/compact` returns the template summary; the equivalent threshold event correctly declines.
- `new_context` initially succeeds with review through `a10`; the model continues working until the cut advances to `a22`. Compaction still returns the template because a request exists.

Unreviewed material is removed from context without being summarized. The initial gate cannot protect against subsequent work or a different actual cut.

**Fix direction:** Before returning any template compaction, validate freshness against `event.preparation.firstKeptEntryId`, regardless of trigger or pending state. Decline safely when stale.

### 2. [P2] Settings loading bypasses Pi’s project-trust boundary
**Location:** `src/index.ts:103–114`

`SettingsManager.create()` is called without `{ projectTrusted: ctx.isProjectTrusted() }`. Pi 0.85.1 defaults this option to `true`, so the extension consumes `.pi/settings.json` even when Pi itself refuses to trust that project.

**Reproduction:** With an untrusted project containing:
```json
{"compaction":{"reserveTokens":99000,"keepRecentTokens":0}}
```
and usage of **1,000/100,000 tokens**, the production handler enters maintenance and blocks ordinary tools. Pi’s trust-respecting settings retain `reserveTokens: 16384` and would not consider this context exhausted.

**Fix direction:** Pass the host’s trust decision into settings loading and include trust state in cache invalidation. This defect was introduced by `f7bfe47`.

### 3. [P2] Previous compaction’s retained tail is omitted from reclaim accounting and pinning
**Locations:** `src/gate.ts:25–36,66–67`; `src/rollover.ts:47–57`

Both functions treat entries after the latest compaction journal entry as the entire current window. Pi’s `buildContextEntries()` instead includes the previous compaction’s **retained pre-compaction entries**, followed by newer entries.

Reproduced consequences:
- With approximately 31K tokens of retained context and little new work, the gate returns `nothing_to_drop`, although Pi’s actual preparation drops approximately 30.7K tokens.
- A user correction retained by the previous compaction remains visible in current context, but is omitted from `droppedRange()` when the next compaction removes it. It is consequently not pinned.

**Fix direction:** Derive reclaim and dropped user messages from the compaction-aware active context, respecting the previous `firstKeptEntryId`. Compare against Pi’s actual preparation. The assertions at `test/gate-rollover.test.ts:57–60,91–94` currently reinforce the incorrect boundary assumption.

### 4. [P2] Automatic compaction can execute a template rollover during an active agent run
**Location:** `src/index.ts:313–343`, particularly `324–326`

Scheduling at `agent_settled` does not prevent Pi’s automatic-compaction hook from consuming a pending request—or independently producing a threshold template—before the run settles.

Pi 0.85.1 calls `_runAutoCompaction()` from `_compactBeforeNextAssistantResponse()` during next-turn preparation. Using those actual host methods with an in-memory session reproduced a persisted template compaction while `_isAgentRunActive === true`, without any `ctx.compact()` call.

This violates the required in-flight restriction and allows a scheduled rollover to execute earlier than advertised.

**Fix direction:** Gate template ownership on the actual run lifecycle. During an active run, defer the template or initiate it only through the permitted `ctx.compact()` abort path; do not treat an automatic hook as fulfillment of a pending settled-boundary request.

### 5. [P2] Exhausting maintenance repairs immediately starts another attempt
**Locations:** `src/maintenance.ts:63–66`; `src/index.ts:293–302,385–402`

After the second invalid checkpoint, `step()` returns `idle` and `give_up`, but the integration only logs that outcome. At the same turn’s `turn_end`, usage is still in the fallback zone, so another maintenance attempt begins.

**Reproduction:** Enter maintenance → submit two oversized notes writes → emit `turn_end`. The extension sends `maintenance #2` and blocks `read` again; no fallback compaction is requested.

There is also no bounded failure transition when the model only reads notes or requests `reviewed:true` on an empty notebook—the latter returns before `onNotesFailed()`.

**Impact:** Work can remain trapped behind the tool guard while repeated maintenance turns consume the remaining context.

**Fix direction:** Add an exhausted/hand-off state that suppresses re-entry until recovery completes, and route exhausted or missing checkpoints to the default-summary fallback. Count all unsuccessful checkpoint outcomes.

### 6. [P2] Completed maintenance instructions remain active in model context
**Locations:** `src/maintenance.ts:37–39`; `src/index.ts:346–354,417–432`

Compaction clears the in-memory maintenance state, but the context handler removes only status messages. A retained `note-context/maintenance` message still says:

> Make one notes write … Do not call other tools.

Its attempt number has no implemented neutralization semantics. Pi converts custom messages directly into user-role LLM messages.

**Reproduction:** Feed a retained maintenance message through `emitContext()` after `session_compact`; the complete imperative survives unchanged.

**Impact:** The new window receives an obsolete maintenance instruction conflicting with the continuation, potentially causing repeated checkpointing or refusal to resume work.

**Fix direction:** Store attempt identity structurally and remove or explicitly neutralize inactive maintenance messages during context transformation, including after resume or branch replacement.

### 7. [P2] `history` cannot recover substantial parts of long entries
**Locations:** `src/history.ts:112–115,226–241`; `src/index.ts:213–224`

Two independent truncations undermine read-back:
- `safeJson()` truncates tool-call arguments to 400 characters **before indexing**. A unique marker beyond that point is unavailable to both search and read.
- Entry reads clip at 12,000 characters by default, but `offset` is ignored in read and search modes. The instruction to “read with a larger budget” refers to no available tool parameter.

**Reproduction:** A write call containing a 1,000-character argument plus `UNIQUE_TAIL` produces zero search hits for that marker. Reading a 16K-character tool result with `offset:12000` returns exactly the same prefix as the initial read.

**Fix direction:** Keep full allowed content in the index; truncate only rendered pages. Implement usable read/search pagination with continuation metadata and an aggregate output budget.

### 8. [P2] Valid custom section names can silently discard notebook content
**Location:** `src/notebook.ts:133–142`

`orderSections()` uses `name in out`, which includes inherited properties. Valid names such as `constructor`, `toString`, and `hasOwnProperty` are consequently skipped.

**Reproduction:**
```ts
applySections({}, {
  sections: { constructor: "critical constraint" }
})
```
returns `ok: true`, nonzero reported size, and `sections: {}`.

The caller persists this as a successful positive revision, which subsequent gates consider an existing notebook despite its missing content.

**Fix direction:** Use `Object.hasOwn(out, name)` or a null-prototype dictionary, and validate the final representation before persistence.

### 9. [P2] Tool failures are recorded by Pi as successful results
**Location:** `src/index.ts:33–35` and rejection returns such as `175–179`

The helper encodes failure as an extra `isError` property on `AgentToolResult`. Pi 0.85.1 does not consume that property: agent-core marks resolved executions successful, and derives failure from exceptions or the supported tool-result hook.

**Reproduction through actual `runAgentLoop()`:** An oversized notes write produces:
```text
content: "notes rejected (too_large): ..."
details: { reason: "too_large" }
isError: false
```

The same mismatch affects gate refusals and invalid history requests. Consumers receive incorrect structured success/failure information.

**Fix direction:** Use Pi’s supported failure mechanism. Throwing produces a host error result with `details: {}`; if structured rejection details must be preserved, propagate failure through the supported result hook.

## Verification and limits

- Read all scoped source/tests, `package.json`, and the contract sections; included the settings commit that arrived during review.
- Checked relevant Pi 0.85.1 declarations and implementations, including `emit`/`emitContext`, compaction/run lifecycle, `buildContextEntries`, settings trust, and tool execution.
- **36 tests passed, 97 assertions; `tsc --noEmit` passed.**
- Ran additional in-memory reproductions using actual host dispatch, compaction methods, `SessionManager`, and agent-core tool execution.
- Confirmed sibling-branch notebook entries are ignored. Existing allowlist tests pass for excluded bash output, foreign custom entries, and assistant thinking.
- Existing tests do not exercise the composition root’s lifecycle interactions or external-owner load orders.
- No live-provider or full interactive-session validation was performed. No repository files were modified; final working tree was clean.

Except for finding 2, these defects predate the latest settings commit and remain present at reviewed HEAD.
