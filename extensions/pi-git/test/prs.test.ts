import { describe, expect, it } from "vitest";
import { describePr, mergePr, mergeStatus, type PrRecord, type PrStatus } from "#src/prs";

/** A status as one observation at `at` records it: each field stamped with that time. */
const seen = (
  at: number,
  facts: Omit<PrStatus, "observedAt" | "source" | "fieldAt">,
): PrStatus => ({
  ...facts,
  observedAt: at,
  source: "bash",
  fieldAt: Object.fromEntries(Object.keys(facts).map((key) => [key, at])),
});

const record = (status: PrStatus, updatedAt: number): PrRecord => ({
  v: 1,
  kind: "pr",
  key: "github.com/acme/api#12",
  host: "github.com",
  owner: "acme",
  repo: "api",
  number: 12,
  url: "https://github.com/acme/api/pull/12",
  origin: "created",
  status,
  calls: [],
  createdAt: 1,
  updatedAt,
});

describe("mergeStatus", () => {
  it("keeps each field from whichever side saw it last", () => {
    const merged = mergeStatus(
      mergeStatus(
        seen(10, { state: "open" }),
        seen(30, { checks: { passed: 1, failed: 0, pending: 0 } }),
      ),
      seen(20, { state: "merged" }),
    );
    expect(merged).toMatchObject({
      state: "merged",
      checks: { passed: 1, failed: 0, pending: 0 },
      observedAt: 30,
      fieldAt: { state: 20, checks: 30 },
    });
  });

  it("reads a status without per-field times as seen entirely at its observedAt", () => {
    const legacy: PrStatus = { state: "open", observedAt: 40, source: "bash" };
    expect(mergeStatus(seen(20, { state: "merged" }), legacy)?.state).toBe("open");
    expect(mergeStatus(legacy, seen(50, { state: "merged" }))?.state).toBe("merged");
  });
});

describe("reviews", () => {
  it("lets a later no-decision read clear an earlier approval", () => {
    const merged = mergeStatus(seen(10, { review: "approved" }), seen(20, { review: "none" }));
    expect(merged?.review).toBe("none");
    expect(describePr(merged)).toBe("no status seen yet");
    expect(describePr(mergeStatus(merged, seen(30, { state: "open" })))).toBe("open");
  });
});

describe("mergePr", () => {
  it("does not let a subagent's newer checks read bring back its older state", () => {
    // The child saw the PR open (t=10), then read only its checks (t=30);
    // the parent saw it merged in between (t=20).
    const child = record(
      mergeStatus(
        seen(10, { state: "open" }),
        seen(30, { checks: { passed: 2, failed: 0, pending: 0 } }),
      )!,
      30,
    );
    const parent = record(seen(20, { state: "merged" }), 20);
    const merged = mergePr(parent, child);
    expect(merged.status).toMatchObject({
      state: "merged",
      checks: { passed: 2, failed: 0, pending: 0 },
    });
  });
});
