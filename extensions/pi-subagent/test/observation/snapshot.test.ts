import { describe, expect, it } from "vitest";
import { buildSubagentSnapshot } from "#src/observation/snapshot";
import { toPersistedRecord } from "#src/persisted-record";
import { createTestSubagent } from "#test/helpers/make-subagent";

describe("branch subagent snapshot", () => {
  it("restores saved state, overlays live waiting, and excludes live agents outside the branch", () => {
    const done = createTestSubagent({ id: "done", status: "completed", toolUses: 7 });
    const savedWaiting = toPersistedRecord(
      createTestSubagent({ id: "waiting", status: "running" }),
    );
    const live = {
      ...savedWaiting,
      status: "idle" as const,
      outcome: "completed" as const,
      waitingOn: ["CI", "answer"],
      toolUses: 12,
    };
    const outside = createTestSubagent({ id: "other-branch", status: "running" });
    const lookup = (id: string) =>
      id === "waiting" ? live : id === outside.id ? outside : undefined;
    const snapshot = buildSubagentSnapshot([toPersistedRecord(done), savedWaiting], lookup);
    expect(snapshot.version).toBe(1);
    expect(snapshot.agents.map((a) => a.id)).toEqual(["waiting", "done"]);
    expect(snapshot.agents[0]).toMatchObject({
      state: "waiting",
      note: "CI, answer",
      toolUses: 12,
    });
    expect(snapshot.agents[1]).toMatchObject({ state: "completed", toolUses: 7, live: false });
    expect(buildSubagentSnapshot([], lookup).agents).toEqual([]);
  });

  it("reports interrupted saved runs and live progress without keeping stale waiting notes", () => {
    const record = toPersistedRecord(createTestSubagent({ status: "running" }));
    expect(buildSubagentSnapshot([record], () => undefined).agents[0].state).toBe("interrupted");
    const snapshot = buildSubagentSnapshot([record], () => ({
      ...record,
      latestUpdate: "Found 3 callers",
      lifetimeUsage: { input: 1, output: 2, cacheWrite: 3 },
    }));
    expect(snapshot.agents[0]).toMatchObject({
      state: "running",
      note: "Found 3 callers",
      tokens: 6,
    });
  });
});
