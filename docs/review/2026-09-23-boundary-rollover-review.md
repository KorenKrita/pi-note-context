## Findings

Found **4 defects in `4e422f6`**. No defect found in the structured-prompt change in `8df9572`.

### 1. [P1] Fallback rollovers bypass configured external compaction owners
**Location:** `src/index.ts:603–612`

**Trigger:** The current model matches `externalCompactionModels`, pressure enters the fallback zone, and the requested notes checkpoint succeeds.

The fallback handler calls `boundaryRollover()` without checking `externalOwner(ctx)`. That helper directly creates the notebook-template summary. Pi does **not** emit `session_before_compact` for boundary drafts, so the owner check at line 470 never runs.

**Reproduced against installed Pi 0.87.1:** With `externalCompactionModels: ["p/m"]`, the checkpoint returned a `compaction` with `details.reason: "fallback"` plus the continuation; **zero `ctx.compact()` calls** occurred.

**Impact:** The configured owner never produces the summary, contrary to the required contract. Before this change, fallback called `ctx.compact()` and reached the owner through `session_before_compact`.

**Minimal fix:** Route external-owner fallback checkpoints through the `ctx.compact()` path, preserving the fallback reason and continuation. Do not generate template boundary drafts for those models.

### 2. [P1] Fallback can overwrite another handler’s boundary compaction
**Location:** `src/index.ts:611–612`; related `src/index.ts:449–460`

**Trigger:** An earlier `turn_end` handler proposes a compaction on the turn that completes maintenance.

Unlike `agent_before_settle`, the fallback handler does not check for an existing compaction in `event.entries`. It computes its cut from the still-uncommitted session and appends a second compaction.

**Reproduction:** Have the earlier handler return:
```ts
{
  entries: [{
    type: "compaction",
    summary: "OTHER OWNER SUMMARY",
    firstKeptEntryId: null,
  }]
}
```

The installed Pi committed:
```text
other compaction → note-context fallback compaction → continuation
```
The resulting model context **did not contain `OTHER OWNER SUMMARY`**. The second compaction also referenced the pre-boundary tail, undoing the first compaction’s “retain nothing” cut.

**Pi evidence:** `_applyBoundaryDrafts()` applies drafts sequentially; `buildSessionProjection()` exposes the latest compaction summary and suppresses earlier compaction summaries.

**Impact:** Another handler’s summary is silently lost from active context, and its retention decision is overridden.

**Minimal fix:** Respect existing compaction drafts at fallback boundaries. Coordinate continuation and state reconciliation without appending another compaction computed from the old session.

### 3. [P2] Yielding to an existing settle-boundary compaction leaves a duplicate rollover scheduled
**Location:** `src/index.ts:547–548`, `558–571`

**Trigger:** A model/user rollover is pending and an earlier `agent_before_settle` handler supplies a compaction.

Line 548 returns without clearing or otherwise reconciling the schedule. Pi commits the other compaction, but emits no `session_compact`, so `onWindowOpened()` never runs. The subsequent `agent_settled` handler calls `ctx.compact()` again.

**Reproduced:** One other-owner boundary compaction was committed, followed by **one additional `ctx.compact()` call**.

**Pi evidence:** If the other compaction is the final entry, Pi’s `prepareCompaction2()` returns no preparation and `compact()` throws `Already compacted`. If the owner also appended a message, the redundant compaction can instead proceed.

**Impact:** A successful rollover becomes a spurious failed or repeated rollover. In the compaction-only case, this plugin’s continuation is never sent because it is attached only to `onComplete`. Window-scoped state also remains unreconciled.

**Minimal fix:** Recognize a newly persisted boundary compaction as satisfying the pending rollover. Reconcile/reset state before the settled fallback, and arrange any necessary continuation without invoking compaction again.

### 4. [P2] Window state is reset before Pi validates or commits the proposed rollover
**Location:** `src/index.ts:456–458`; ledger/cache effects at `422–425`

`boundaryRollover()` clears the pending schedule, maintenance state, reminders, and status odometer while merely constructing a proposal. Later handlers can replace the draft list or make it invalid.

**Reproduction:** After note-context proposes its rollover, a later handler appends:
```ts
{ type: "context_edit", targetId: "missing-id", replacement: null }
```

Installed Pi’s `ExtensionRunner.emitBoundary()` rejected the final proposal and returned:
```text
valid: false
entries: []
```

Nevertheless, note-context had already recorded **one successful rollover row**, cleared its schedule, and subsequently made **zero `ctx.compact()` calls**. No rollover actually occurred.

**Impact:** Failed boundary transactions lose rollover/recovery state and produce false success accounting.

**Minimal fix:** Separate “proposed rollover” from “committed rollover.” Finalize window resets and success/cache accounting only after observing the corresponding persisted compaction; retain or explicitly fail the schedule when the proposal disappears. The premature boundary-state reset is new; early ledger emission also existed on the legacy compaction hook.

## Validation and scope

- Reviewed `git diff 22f2e7c^ 4e422f6`, supporting gate/notebook/maintenance code, and changed tests.
- Checked the installed **Pi 0.87.1** declarations and implementation, especially `emitBoundary`, boundary commit/projection, settlement, and compaction.
- Reproduced all four cases using the installed Pi’s real `ExtensionRunner`, `AgentSession` boundary methods, and an in-memory `SessionManager`; configuration, ledger, and `ctx.compact()` invocation capture were isolated in memory.
- Verified guidance preserves earlier/later prompt sections and does not set `forceSystemPrompt`.
- Typecheck passed. **48 tests passed, 0 failed** across the four filesystem-write-free test files.
- Did **not** execute the two host test files because they create configuration/ledger files. Full provider-loop, live ESC timing, and actual external-owner summarization remain unexecuted.
- No repository files were modified; the pre-existing untracked review file was left untouched.
