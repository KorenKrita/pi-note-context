import { describe, expect, test } from "bun:test";
import {
  applySections,
  DEFAULT_LIMITS,
  EMPTY_NOTEBOOK,
  makeRecord,
  MAX_SECTIONS,
  NOTEBOOK_ENTRY_TYPE,
  reconstructNotebook,
  renderNotebook,
  type BranchEntryLike,
} from "../src/notebook.ts";

describe("applySections", () => {
  test("replaces only named sections and keeps the rest", () => {
    const r = applySections({ Task: "t", State: "s1", Next: "n" }, { sections: { State: "s2" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sections).toEqual({ Task: "t", State: "s2", Next: "n" });
    expect(r.changed).toBe(true);
  });

  test("empty string deletes a section; replaceAll drops unmentioned ones", () => {
    const del = applySections({ Task: "t", Refs: "r" }, { sections: { Refs: "" } });
    expect(del.ok && del.sections).toEqual({ Task: "t" });
    const all = applySections({ Task: "t", Refs: "r" }, { sections: { Next: "n" }, replaceAll: true });
    expect(all.ok && all.sections).toEqual({ Next: "n" });
  });

  test("orders canonical sections first regardless of input order", () => {
    const r = applySections({}, { sections: { Zeta: "z", Next: "n", Task: "t" } });
    expect(r.ok && Object.keys(r.sections)).toEqual(["Task", "Next", "Zeta"]);
  });

  test("rejects oversized writes atomically and reports the excess", () => {
    const big = "x".repeat(DEFAULT_LIMITS.maxBytes + 10);
    const r = applySections({ Task: "keep" }, { sections: { State: big } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("too_large");
    expect(r.detail).toContain("Previous revision kept");
  });

  test("token ceiling triggers before byte ceiling on CJK-heavy text", () => {
    const cjk = "字".repeat(DEFAULT_LIMITS.maxTokens + 1); // 3 bytes each, 1 token each
    const r = applySections({}, { sections: { Task: cjk } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("too_large");
    expect(r.size!.bytes).toBeLessThan(DEFAULT_LIMITS.maxBytes);
  });

  test("refuses to leave the notebook empty", () => {
    const r = applySections({ Task: "t" }, { sections: { Task: "" } });
    expect(!r.ok && r.reason).toBe("empty_result");
  });

  test("caps section count", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= MAX_SECTIONS; i++) many[`S${i}`] = "x";
    const r = applySections({}, { sections: many });
    expect(!r.ok && r.reason).toBe("too_many_sections");
  });

  test("rejects section names that cannot be rendered as headings", () => {
    for (const bad of ["## bad\nname", "", " lead", "1st", "a".repeat(33)]) {
      const r = applySections({}, { sections: { [bad]: "x" } });
      expect(!r.ok && r.reason).toBe("invalid_section_name");
    }
  });

  test("accepts non-ASCII section names (the model writes in its working language)", () => {
    const r = applySections({}, { sections: { "Herdr修改": "x", "État": "y", "状态 2": "z" } });
    expect(r.ok).toBe(true);
    expect(r.ok && Object.keys(r.sections)).toEqual(["Herdr修改", "État", "状态 2"]);
  });

  test("prototype-named sections are stored, not silently dropped", () => {
    const r = applySections({}, { sections: { constructor: "critical constraint", toString: "x", Task: "t" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.sections)).toEqual(["Task", "constructor", "toString"]);
    expect(r.sections["constructor"]).toBe("critical constraint");
  });

  test("reports changed=false for a no-op write", () => {
    const r = applySections({ Task: "t" }, { sections: { Task: "t" } });
    expect(r.ok && r.changed).toBe(false);
  });
});

describe("reconstructNotebook", () => {
  const rec = (id: string, revision: number, sections: Record<string, string>, extra: Record<string, unknown> = {}): BranchEntryLike => ({
    id,
    type: "custom",
    customType: NOTEBOOK_ENTRY_TYPE,
    data: { version: 1, revision, sections, reviewedThrough: null, ...extra },
  });

  test("returns the latest valid record on the branch, ignoring other entry kinds", () => {
    const branch: BranchEntryLike[] = [
      { id: "u1", type: "message" },
      rec("n1", 1, { Task: "a" }),
      { id: "x", type: "custom", customType: "other/thing", data: { version: 1, revision: 99, sections: { Task: "z" }, reviewedThrough: null } },
      rec("n2", 2, { Task: "b" }),
      { id: "u2", type: "message" },
    ];
    const nb = reconstructNotebook(branch);
    expect(nb.revision).toBe(2);
    expect(nb.sections).toEqual({ Task: "b" });
    expect(nb.entryId).toBe("n2");
  });

  test("a malformed later record does not mask an earlier valid one", () => {
    const branch: BranchEntryLike[] = [
      rec("n1", 1, { Task: "a" }),
      { id: "bad", type: "custom", customType: NOTEBOOK_ENTRY_TYPE, data: { version: 1, revision: "2", sections: { Task: 5 } } },
    ];
    expect(reconstructNotebook(branch).entryId).toBe("n1");
  });

  test("empty branch yields the empty notebook", () => {
    expect(reconstructNotebook([])).toEqual(EMPTY_NOTEBOOK);
  });

  test("makeRecord increments revision and carries reviewedThrough", () => {
    const r = makeRecord({ ...EMPTY_NOTEBOOK, revision: 4 }, { Task: "t" }, "a1", true);
    expect(r.revision).toBe(5);
    expect(r.reviewedThrough).toBe("a1");
    expect(r.reviewOnly).toBe(true);
  });
});

describe("renderNotebook", () => {
  test("renders markdown headings in section order", () => {
    expect(renderNotebook({ Task: "do x", Next: "step" })).toBe("## Task\ndo x\n\n## Next\nstep");
  });
});
