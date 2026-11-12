import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import {
  type CreateSubagentSessionParams,
  StaleSessionError,
} from "#src/lifecycle/create-subagent-session";
import { WORK_WAKE_PROMPT } from "#src/lifecycle/run";
import {
  RESTORE_CONCURRENCY,
  RESTORE_TIMEOUT_MS,
  SubagentManager,
} from "#src/lifecycle/subagent-manager";
import type { TranscriptWork } from "#src/lifecycle/transcript-work";
import type { PersistedSubagentRecord } from "#src/persisted-record";
import { createSubagentSessionStub, openItem, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { turnLoopResult } from "#test/helpers/turn-loop-result";
import { tempDir, tick } from "#test-helpers";
import type { WorkItemView } from "#work";

// Roadmap step 12 at the manager: bring back the agents a reload or restart left holding work,
// without a model run and without a concurrency slot. The work host belongs to the child's
// session; these tests stand in for it through the policy the agent hands it (`params.work`) and
// the open items of the session stub, and for pi-job and pi-ask through what the factory leaves
// open or reports lost.

interface Child {
  params: CreateSubagentSessionParams;
  stub: ReturnType<typeof createSubagentSessionStub>;
}

/** What the reopened child's producers do at its `session_start`. */
interface Startup {
  /** Items the transcript still holds after the producers adopted theirs. */
  open?: WorkItemView[];
  /** Items nobody adopted: closed as lost by the host. */
  lost?: WorkItemView[];
  /** A message arrives while the session starts (a job that ended in the reload gap). */
  wake?: boolean;
  fail?: boolean;
  /** The session is not ready until this settles: a child whose extension hangs at startup. */
  hold?: Promise<void>;
  /** The factory honours `params.isStale` like the real one: it throws once it was abandoned. */
  honourStale?: boolean;
}

function record(overrides: Partial<PersistedSubagentRecord> = {}): PersistedSubagentRecord {
  return {
    version: 2,
    id: "agent-1",
    type: "general-purpose",
    description: "Review CI",
    status: "idle",
    outcome: "completed",
    result: "Watching.",
    error: undefined,
    turnBudget: undefined,
    startedAt: 1000,
    completedAt: 2000,
    outputFile: undefined,
    toolUses: 1,
    ...overrides,
  };
}

function harness(
  options: { limit?: number; startups?: Record<string, Startup>; restoreTimeoutMs?: number } = {},
) {
  const dir = tempDir(onTestFinished, "restore-");
  const startups = options.startups ?? {};
  const created: Child[] = [];
  const persisted: PersistedSubagentRecord[] = [];
  const events: string[] = [];
  const limiter = new ConcurrencyLimiter(() => options.limit ?? 1);
  const schedule = vi.spyOn(limiter, "schedule");
  const stored = new Map<string, WorkItemView[]>();
  const transcripts: TranscriptWork = {
    openItems: vi.fn((path: string) => [...(stored.get(path) ?? [])]),
    closeLost: vi.fn((path: string, items: readonly WorkItemView[]) => {
      stored.set(path, []);
      return items.length > 0;
    }),
  };
  let inFlight = 0;
  let peak = 0;
  const manager = new SubagentManager({
    registry: new AgentTypeRegistry(() => new Map()),
    limiter,
    transcripts,
    ...(options.restoreTimeoutMs !== undefined
      ? { restoreTimeoutMs: options.restoreTimeoutMs }
      : {}),
    createSubagentSession: async (params) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      const startup = startups[params.agentId!] ?? {};
      await startup.hold;
      if (startup.honourStale && params.isStale?.()) throw new StaleSessionError();
      if (startup.fail) throw new Error("cannot build the session");
      const stub = createSubagentSessionStub(undefined, params.transcriptPath);
      stub.openItems.push(...(startup.open ?? []));
      const child = { params, stub };
      created.push(child);
      if (startup.lost?.length) params.work!.lost!(startup.lost);
      if (startup.wake) params.work!.wake();
      return toSubagentSession(stub);
    },
    observer: {
      onSubagentCreated() {},
      onSubagentStarted() {},
      onSubagentResuming: () => events.push("resuming"),
      onSubagentResumeQueued: () => events.push("queued"),
      onSubagentCompleted: () => events.push("completed"),
      onSubagentResumed: () => events.push("resumed"),
      onSubagentCompacted() {},
      onSubagentWaiting: (agent) => events.push(`waiting:${agent.id}`),
    },
    savedAgents: {
      find: () => undefined,
      parent: () => ({
        snapshot: STUB_SNAPSHOT,
        parentSession: { parentSessionFile: join(dir, "parent.jsonl"), parentSessionId: "parent" },
      }),
      persist: (entry) => persisted.push(entry),
    },
  });
  onTestFinished(() => manager.dispose());
  /** A saved record whose transcript exists in `dir`. */
  const saved = (overrides: Partial<PersistedSubagentRecord> = {}) => {
    const id = overrides.id ?? "agent-1";
    const outputFile = join(dir, `${id}.jsonl`);
    writeFileSync(outputFile, "{}\n");
    return record({ outputFile, cwd: dir, ...overrides, id });
  };
  return {
    manager,
    dir,
    created,
    persisted,
    events,
    schedule,
    stored,
    transcripts,
    saved,
    peak: () => peak,
  };
}

const waitingRecord = (h: ReturnType<typeof harness>, id = "agent-1", labels = ["CI"]) =>
  h.saved({ id, waitingOn: labels });

describe("restoring agents after a reload or restart", () => {
  describe("which agents it looks at", () => {
    it("reopens only an agent that was waiting or mid-run; a done agent stays a saved record", async () => {
      const h = harness();
      const found = await h.manager.restore({
        startReason: "reload",
        records: [
          h.saved({ id: "done" }), // finished, waiting on nothing
          waitingRecord(h, "waiting"),
        ],
      });
      expect(found.map((agent) => agent.id)).toEqual(["waiting"]);
      expect(h.created.map((child) => child.params.agentId)).toEqual(["waiting"]);
      expect(h.manager.getRecord("done")).toBeUndefined();
    });

    it("skips an agent the manager already holds", async () => {
      const h = harness({ startups: { a: { open: [openItem("CI")] } } });
      const request = { startReason: "reload" as const, records: [waitingRecord(h, "a")] };
      await h.manager.restore(request);
      expect(h.created).toHaveLength(1);
      expect(await h.manager.restore(request)).toEqual([]);
      expect(h.created).toHaveLength(1);
    });
  });

  describe("an agent that still holds work after the producers took theirs back", () => {
    const startups = { a: { open: [openItem("CI", "w1", "watch")] } };

    it("is rebuilt idle and waiting, with its session reopened from its transcript and no run", async () => {
      const h = harness({ startups });
      const saved = waitingRecord(h, "a");
      const [found] = await h.manager.restore({ startReason: "reload", records: [saved] });

      expect(found).toMatchObject({
        id: "a",
        interrupted: false,
        lost: [],
        waitingOn: ["CI"],
        woken: false,
        continuing: true,
      });
      const live = h.manager.getRecord("a")!;
      expect(live.status).toBe("idle");
      expect(live.outcome).toBe("completed");
      expect(live.result).toBe("Watching.");
      expect(live.waitingOn).toEqual(["CI"]);
      expect(live.isDone()).toBe(false);
      expect(live.isSessionReady()).toBe(true);
      // Reopened from its transcript, as a reload.
      expect(h.created[0].params).toMatchObject({
        transcriptPath: saved.outputFile,
        startReason: "reload",
        agentId: "a",
      });
      // Nothing was prompted, and no slot was asked for.
      expect(h.created[0].stub.runTurnLoop).not.toHaveBeenCalled();
      expect(h.created[0].stub.resumeTurnLoop).not.toHaveBeenCalled();
      expect(h.schedule).not.toHaveBeenCalled();
      // It is announced as waiting, so the widget and the saved record say so.
      expect(h.events).toEqual(["waiting:a"]);
    });

    it("tells the child's extensions a restart is a resume, not a reload", async () => {
      const h = harness({ startups });
      await h.manager.restore({ startReason: "resume", records: [waitingRecord(h, "a")] });
      expect(h.created[0].params.startReason).toBe("resume");
    });

    it("keeps its session through a retention sweep, however long it waits", async () => {
      const h = harness({ startups });
      await h.manager.restore({ startReason: "reload", records: [waitingRecord(h, "a")] });
      const live = h.manager.getRecord("a")!;
      expect(live.isDone()).toBe(false);
      await live.releaseSession();
      expect(h.created[0].stub.dispose).not.toHaveBeenCalled();
    });

    it("is woken through the limiter when its work reports back, like a live waiting agent", async () => {
      const h = harness({ startups });
      await h.manager.restore({ startReason: "reload", records: [waitingRecord(h, "a")] });
      const { stub, params } = h.created[0];
      stub.openItems.length = 0; // the last item completed
      params.work!.wake();
      await h.manager.getRecord("a")!.promise;
      expect(h.schedule).toHaveBeenCalledTimes(1);
      expect(stub.resumeTurnLoop).toHaveBeenCalledWith(WORK_WAKE_PROMPT, expect.anything());
    });

    it("reports its completion to the spawner when its work runs out: it is not left waiting for good", async () => {
      const h = harness({ startups });
      await h.manager.restore({ startReason: "reload", records: [waitingRecord(h, "a")] });
      const { stub, params } = h.created[0];
      stub.openItems.length = 0; // the last item was cancelled, with no message to wake it
      params.work!.changed();
      expect(h.events).toContain("completed");
      expect(h.manager.getRecord("a")!.isDone()).toBe(true);
    });
  });

  describe("an agent whose work nobody could take over", () => {
    it("reports what it lost, is done, and its session is released and the record corrected", async () => {
      const lostItem = openItem("CI", "w1", "watch");
      const h = harness({ startups: { a: { lost: [lostItem] } } });
      const saved = waitingRecord(h, "a");
      const [found] = await h.manager.restore({ startReason: "resume", records: [saved] });

      expect(found).toMatchObject({
        id: "a",
        interrupted: false,
        lost: [{ kind: "watch", label: "CI" }],
        waitingOn: [],
        continuing: false,
      });
      // Done: not kept in the manager, its session released, and no completion announced.
      expect(h.manager.getRecord("a")).toBeUndefined();
      expect(h.created[0].stub.dispose).toHaveBeenCalledTimes(1);
      expect(h.events).toEqual([]);
      expect(h.persisted).toHaveLength(1);
      expect(h.persisted[0]).toMatchObject({ id: "a", status: "idle", outcome: "completed" });
      expect(h.persisted[0]).not.toHaveProperty("waitingOn");
      expect(h.schedule).not.toHaveBeenCalled();
    });

    it("keeps waiting on what it still holds, and reports only what it lost", async () => {
      const h = harness({
        startups: {
          a: {
            open: [openItem("answer", "q1", "question")],
            lost: [openItem("CI", "w1", "watch")],
          },
        },
      });
      const [found] = await h.manager.restore({
        startReason: "resume",
        records: [waitingRecord(h, "a", ["CI", "answer"])],
      });
      expect(found).toMatchObject({
        lost: [{ kind: "watch", label: "CI" }],
        waitingOn: ["answer"],
        continuing: true,
      });
      expect(h.manager.getRecord("a")!.waitingOn).toEqual(["answer"]);
    });

    it("answers a message that arrived during the startup with a run through the limiter", async () => {
      const h = harness({ startups: { a: { wake: true } } });
      const [found] = await h.manager.restore({
        startReason: "reload",
        records: [waitingRecord(h, "a")],
      });
      expect(found).toMatchObject({ woken: true, continuing: true });
      const live = h.manager.getRecord("a")!;
      await live.promise;
      expect(h.schedule).toHaveBeenCalledTimes(1);
      expect(h.created[0].stub.resumeTurnLoop).toHaveBeenCalledWith(
        WORK_WAKE_PROMPT,
        expect.anything(),
      );
      expect(h.events).toContain("resumed");
    });
  });

  describe("an agent whose run was in progress", () => {
    it("is idle with the outcome interrupted, recorded so the next start does not report it again", async () => {
      const h = harness();
      for (const status of ["queued", "running"] as const) {
        const [found] = await h.manager.restore({
          startReason: "resume",
          records: [h.saved({ id: status, status, outcome: undefined })],
        });
        expect(found).toMatchObject({ id: status, interrupted: true, lost: [], continuing: false });
      }
      expect(h.persisted.map((entry) => [entry.id, entry.status, entry.outcome])).toEqual([
        ["queued", "idle", "interrupted"],
        ["running", "idle", "interrupted"],
      ]);
      // Its transcript held no open work, so there was nothing to reopen it for.
      expect(h.created).toEqual([]);
    });

    it("is reopened when its transcript holds work its record never heard of, and the job is reported lost", async () => {
      const h = harness({ startups: { a: { lost: [openItem("CI", "w1", "watch")] } } });
      const saved = h.saved({ id: "a", status: "running", outcome: undefined });
      h.stored.set(saved.outputFile!, [openItem("CI", "w1", "watch")]);
      const [found] = await h.manager.restore({ startReason: "resume", records: [saved] });
      expect(found).toMatchObject({
        interrupted: true,
        lost: [{ kind: "watch", label: "CI" }],
        continuing: false,
      });
      expect(h.persisted[0]).toMatchObject({ id: "a", status: "idle", outcome: "interrupted" });
    });

    it("stays waiting, interrupted, when the work it left open was taken over", async () => {
      const h = harness({ startups: { a: { open: [openItem("CI", "w1", "watch")] } } });
      const saved = h.saved({ id: "a", status: "running", outcome: undefined });
      h.stored.set(saved.outputFile!, [openItem("CI", "w1", "watch")]);
      const [found] = await h.manager.restore({ startReason: "reload", records: [saved] });
      expect(found).toMatchObject({ interrupted: true, waitingOn: ["CI"], continuing: true });
      const live = h.manager.getRecord("a")!;
      expect(live.outcome).toBe("interrupted");
      expect(live.waitingOn).toEqual(["CI"]);
    });

    it("has no transcript to look in when it never got a session: interrupted, nothing more", async () => {
      const h = harness();
      const [found] = await h.manager.restore({
        startReason: "resume",
        records: [record({ id: "queued", status: "queued", outcome: undefined })],
      });
      expect(found).toMatchObject({ interrupted: true, lost: [], continuing: false });
      expect(h.persisted[0]).toMatchObject({ status: "idle", outcome: "interrupted" });
    });
  });

  describe("an agent whose transcript cannot be reopened", () => {
    it("has its open items closed as lost in the transcript itself, and reports them", async () => {
      const h = harness();
      const saved = waitingRecord(h, "a");
      // The directory it ran in is gone, so no session can be built around the transcript.
      const gone = { ...saved, cwd: join(h.dir, "gone") };
      h.stored.set(gone.outputFile!, [openItem("CI", "w1", "watch")]);
      const [found] = await h.manager.restore({ startReason: "reload", records: [gone] });
      expect(found).toMatchObject({
        unreachable: "directory-unavailable",
        lost: [{ kind: "watch", label: "CI" }],
        continuing: false,
      });
      expect(h.transcripts.closeLost).toHaveBeenCalledWith(gone.outputFile, [
        expect.objectContaining({ label: "CI" }),
      ]);
      expect(h.created).toEqual([]);
      expect(h.persisted[0]).toMatchObject({ id: "a", status: "idle" });
      expect(h.persisted[0]).not.toHaveProperty("waitingOn");
    });

    it("reports the labels its record kept when the transcript itself is gone", async () => {
      const h = harness();
      const saved = h.saved({ id: "a", waitingOn: ["CI", "answer"] });
      const [found] = await h.manager.restore({
        startReason: "reload",
        records: [{ ...saved, outputFile: join(h.dir, "missing.jsonl") }],
      });
      expect(found).toMatchObject({
        unreachable: "session-released",
        lost: [{ label: "CI" }, { label: "answer" }],
      });
      expect(h.transcripts.closeLost).not.toHaveBeenCalled();
    });

    it("is reported, and the others still restore, when its session cannot be built", async () => {
      const h = harness({
        startups: { bad: { fail: true }, good: { open: [openItem("CI", "w1", "watch")] } },
      });
      const found = await h.manager.restore({
        startReason: "reload",
        records: [waitingRecord(h, "bad"), waitingRecord(h, "good")],
      });
      expect(found.map((agent) => [agent.id, agent.continuing, agent.unreachable])).toEqual([
        ["bad", false, "session-failed"],
        ["good", true, undefined],
      ]);
      expect(h.manager.getRecord("good")!.waitingOn).toEqual(["CI"]);
    });
  });

  describe("many agents", () => {
    it("reopens a few at a time, takes no slot, and starts no run for any", async () => {
      const count = 12;
      const startups = Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`a${i}`, { open: [openItem("CI", `w${i}`)] }]),
      );
      const h = harness({ limit: 2, startups });
      const records = Array.from({ length: count }, (_, i) => waitingRecord(h, `a${i}`));
      const found = await h.manager.restore({ startReason: "resume", records });
      expect(found.map((agent) => agent.id)).toEqual(records.map((r) => r.id)); // order kept
      expect(found.every((agent) => agent.continuing)).toBe(true);
      expect(h.peak()).toBeLessThanOrEqual(RESTORE_CONCURRENCY);
      expect(h.peak()).toBeGreaterThan(1);
      expect(h.schedule).not.toHaveBeenCalled(); // not one slot
      for (const child of h.created) expect(child.stub.runTurnLoop).not.toHaveBeenCalled();
      expect(h.manager.listAgents()).toHaveLength(count);
    });
  });
});

describe("an agent whose session never comes up", () => {
  // Only the timers the bound uses are faked: the harness and the limiter wait on `setImmediate`.
  const fakeTimers = () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => void vi.useRealTimers());
  };

  it("is given up on after the bound: the others restore, the late session is disposed once, its record is kept", async () => {
    fakeTimers();
    const late = Promise.withResolvers<void>();
    const h = harness({
      startups: {
        slow: { hold: late.promise, open: [openItem("CI", "w1", "watch")] },
        a: { open: [openItem("CI", "wa", "watch")] },
        b: { open: [openItem("CI", "wb", "watch")] },
      },
    });
    const records = ["slow", "a", "b"].map((id) => waitingRecord(h, id));
    let done = false;
    const restoring = h.manager
      .restore({ startReason: "reload", records })
      .finally(() => void (done = true));

    // The others come up; the hung one holds the restore, but not past the bound.
    await vi.advanceTimersByTimeAsync(RESTORE_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    expect(h.manager.getRecord("a")!.waitingOn).toEqual(["CI"]);
    expect(h.manager.getRecord("b")!.waitingOn).toEqual(["CI"]);
    await vi.advanceTimersByTimeAsync(1);
    const found = await restoring;

    expect(found.map((agent) => [agent.id, agent.continuing, agent.unreachable])).toEqual([
      ["slow", false, "timed-out"],
      ["a", true, undefined],
      ["b", true, undefined],
    ]);
    // Nothing is claimed lost: nothing is known. Its record is not touched, so a later
    // `subagent_send` reopens it, and it is not registered.
    expect(found[0].lost).toEqual([]);
    expect(h.persisted.map((entry) => entry.id)).not.toContain("slow");
    expect(h.transcripts.closeLost).not.toHaveBeenCalled();
    expect(h.manager.getRecord("slow")).toBeUndefined();

    // The session arrives late: it is disposed, once, and nothing runs in it.
    expect(h.created.map((child) => child.params.agentId)).toEqual(["a", "b"]);
    late.resolve();
    await vi.waitFor(() =>
      expect(h.created.map((child) => child.params.agentId)).toContain("slow"),
    );
    const lateChild = h.created.find((child) => child.params.agentId === "slow")!;
    await vi.waitFor(() => expect(lateChild.stub.dispose).toHaveBeenCalledTimes(1));
    expect(lateChild.stub.runTurnLoop).not.toHaveBeenCalled();
    expect(lateChild.stub.resumeTurnLoop).not.toHaveBeenCalled();
    expect(h.manager.getRecord("slow")).toBeUndefined();
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it("holds one lane for the bound at most: with every lane hung, the rest still restore after it", async () => {
    fakeTimers();
    const never = new Promise<void>(() => {});
    const hung = Array.from({ length: RESTORE_CONCURRENCY }, (_, i) => `hung${i}`);
    const startups = {
      ...Object.fromEntries(hung.map((id) => [id, { hold: never }])),
      ok: { open: [openItem("CI", "w", "watch")] },
    };
    const h = harness({ startups });
    const records = [...hung, "ok"].map((id) => waitingRecord(h, id));
    const restoring = h.manager.restore({ startReason: "reload", records });
    await vi.advanceTimersByTimeAsync(RESTORE_TIMEOUT_MS - 1);
    expect(h.manager.getRecord("ok")).toBeUndefined(); // waits for a lane
    await vi.advanceTimersByTimeAsync(1);
    const found = await restoring;
    expect(found.filter((agent) => agent.unreachable === "timed-out")).toHaveLength(
      RESTORE_CONCURRENCY,
    );
    expect(found.at(-1)).toMatchObject({ id: "ok", continuing: true });
  });

  it("uses the bound it is given", async () => {
    fakeTimers();
    const h = harness({
      restoreTimeoutMs: 50,
      startups: { slow: { hold: new Promise(() => {}) } },
    });
    const restoring = h.manager.restore({
      startReason: "resume",
      records: [waitingRecord(h, "slow")],
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(await restoring).toMatchObject([{ id: "slow", unreachable: "timed-out" }]);
  });

  it("never starts the timer for a session that comes up in time, and clears it", async () => {
    fakeTimers();
    const h = harness({ startups: { a: { open: [openItem("CI", "w", "watch")] } } });
    await h.manager.restore({ startReason: "reload", records: [waitingRecord(h, "a")] });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a restore that completes after the manager was disposed", () => {
  it.each([false, true])(
    "disposes the session it got and registers, persists and writes nothing (the factory honours staleness: %s)",
    async (honourStale) => {
      // Shutting down is `suspend` then `dispose`, but `dispose` alone must reach a record that is
      // still being reopened too, so one of the two cases leaves `suspend` out.
      const late = Promise.withResolvers<void>();
      const h = harness({
        startups: { a: { hold: late.promise, honourStale, open: [openItem("CI", "w1", "watch")] } },
      });
      const saved = waitingRecord(h, "a");
      const restoring = h.manager.restore({ startReason: "reload", records: [saved] });
      await tick();
      await tick();

      // The parent shuts down while the session is being built: the record is in no registry yet.
      if (!honourStale) h.manager.suspend();
      await h.manager.dispose("reload");
      late.resolve();
      const [found] = await restoring;

      expect(found).toMatchObject({ id: "a", continuing: false, lost: [], waitingOn: [] });
      expect(h.manager.getRecord("a")).toBeUndefined();
      expect(h.manager.listAgents()).toEqual([]);
      expect(h.persisted).toEqual([]);
      expect(h.events).toEqual([]);
      expect(h.transcripts.closeLost).not.toHaveBeenCalled();
      expect(h.schedule).not.toHaveBeenCalled();
      // A factory that built the session anyway has it disposed, once, never attached.
      const built = h.created.filter((child) => child.params.agentId === "a");
      expect(built).toHaveLength(honourStale ? 0 : 1);
      for (const child of built) {
        expect(child.stub.dispose).toHaveBeenCalledTimes(1);
        expect(child.stub.runTurnLoop).not.toHaveBeenCalled();
      }
    },
  );

  it("starts no agent of the restore once it was disposed", async () => {
    const h = harness({ startups: { a: { open: [openItem("CI", "w1")] } } });
    await h.manager.dispose();
    const found = await h.manager.restore({
      startReason: "reload",
      records: [waitingRecord(h, "a")],
    });
    expect(found).toMatchObject([{ id: "a", continuing: false }]);
    expect(h.created).toEqual([]);
    expect(h.persisted).toEqual([]);
  });
});

describe("suspending agents for a shutdown", () => {
  /** An agent with a live session, run to the end of its first turn with one item open. */
  async function waitingAgent(h: ReturnType<typeof harness>) {
    await h.manager.restore({ startReason: "reload", records: [waitingRecord(h, "w")] });
    return { agent: h.manager.getRecord("w")!, child: h.created[0] };
  }

  it("leaves a waiting agent waiting: nothing is cancelled, nothing reported, and each child is told why", async () => {
    const h = harness({ startups: { w: { open: [openItem("CI", "w1", "watch")] } } });
    const { agent, child } = await waitingAgent(h);
    h.events.length = 0;

    h.manager.suspend();
    await h.manager.dispose("reload");

    expect(child.stub.cancelWork).not.toHaveBeenCalled();
    expect(child.stub.reportCalledOff).not.toHaveBeenCalled();
    expect(child.stub.openItems).toHaveLength(1);
    // The last argument: the agent is kept, so what is tied to it (a todo claim) is too.
    expect(child.stub.dispose).toHaveBeenCalledWith("reload", true, true);
    expect(h.events).toEqual([]);
    expect(agent.outcome).toBe("completed");
  });

  it("tells each child `quit` by default, so its jobs are not kept for a reload that is not one", async () => {
    const h = harness({ startups: { w: { open: [openItem("CI", "w1", "watch")] } } });
    const { child } = await waitingAgent(h);
    h.manager.suspend();
    await h.manager.dispose();
    expect(child.stub.dispose).toHaveBeenCalledWith("quit", true, true);
  });

  it("cuts a running agent short as interrupted without calling its work off or reporting an outcome", async () => {
    const h = harness({ startups: { w: { open: [openItem("CI", "w1", "watch")] } } });
    const { agent, child } = await waitingAgent(h);
    // A wake starts a run that hangs until it is aborted.
    const run = Promise.withResolvers<ReturnType<typeof turnLoopResult>>();
    child.stub.resumeTurnLoop.mockImplementation(
      (_prompt: string, options: { signal: AbortSignal }) => {
        options.signal.addEventListener("abort", () => run.resolve(turnLoopResult()));
        return run.promise;
      },
    );
    child.params.work!.wake();
    await tick();
    expect(agent.status).toBe("running");
    h.events.length = 0;

    h.manager.suspend();
    expect(agent.status).toBe("idle");
    expect(agent.outcome).toBe("interrupted");
    await h.manager.dispose("reload");
    await agent.promise;

    expect(child.stub.cancelWork).not.toHaveBeenCalled();
    expect(child.stub.openItems).toHaveLength(1);
    // The run's end is not an outcome: no completion for the spawner, no record written. The
    // saved record still reads running, which is how the next start knows to report it.
    expect(h.events).toEqual([]);
    expect(child.stub.dispose).toHaveBeenCalledTimes(1);
  });

  it("interrupts a queued run, and its slot never opens", async () => {
    const h = harness({
      limit: 1,
      startups: { w: { open: [openItem("CI", "w1", "watch")] } },
    });
    const { agent, child } = await waitingAgent(h);
    // Another agent holds the only slot.
    const hold = Promise.withResolvers<void>();
    void h.manager["limiter"].schedule(() => hold.promise);
    child.params.work!.wake();
    expect(agent.status).toBe("queued");

    h.manager.suspend();
    expect(agent.status).toBe("idle");
    expect(agent.outcome).toBe("interrupted");
    hold.resolve();
    await tick();
    expect(child.stub.resumeTurnLoop).not.toHaveBeenCalled();
  });
});
