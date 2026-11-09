import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi, onTestFinished } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import type { SavedAgents } from "#src/lifecycle/subagent-manager";
import {
  resolveRetentionWindow,
  SubagentManager,
  type SubagentManagerObserver,
} from "#src/lifecycle/subagent-manager";
import type { SubagentSession, TurnLoopResult } from "#src/lifecycle/subagent-session";
import { NotificationManager } from "#src/observation/notification";
import type { PersistedSubagentRecord } from "#src/persisted-record";
import type { RunConfig } from "#src/runtime";
import type { AgentConfig, Subagent } from "#src/types";
import { makeModel } from "#test/helpers/make-model";
import {
  createBlockingFactory,
  createSessionFactory,
  resumeAndSettle,
} from "#test/helpers/manager-stubs";
import {
  createMockSession,
  createSubagentSessionStub,
  emitResumeUsageAndCompaction,
  toSubagentSession,
} from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { turnLoopResult } from "#test/helpers/turn-loop-result";
import { tick } from "../../../../packages/pi-test-helpers/src/wait.ts";
import { tempDir } from "../../../../packages/pi-test-helpers/src/temp.ts";
import { makeAgentConfig } from "#test/helpers/make-agent-config";

/** Default max concurrent background agents (matches production default). */
const DEFAULT_MAX_CONCURRENT = 4;

type SessionFactory = (params: CreateSubagentSessionParams) => Promise<SubagentSession>;

/** Default factory: resolves to a fresh SubagentSession stub on every spawn. */
function defaultFactory(): SessionFactory {
  return vi.fn(async (_params: CreateSubagentSessionParams) =>
    toSubagentSession(createSubagentSessionStub()),
  );
}

/** Registry with default agents only. */
function defaultRegistry(): AgentTypeRegistry {
  return new AgentTypeRegistry(() => new Map());
}

/** Registry with a single custom agent override, keyed by its canonical name. */
function registryWith(name: string, overrides: Partial<AgentConfig>): AgentTypeRegistry {
  return new AgentTypeRegistry(() => new Map([[name, makeAgentConfig({ name, ...overrides })]]));
}

/** Test helper: construct an SubagentManager with injected stubs. */
function createManager(overrides?: {
  createSubagentSession?: SessionFactory;
  observer?: Partial<SubagentManagerObserver>;
  getMaxConcurrent?: () => number;
  getRunConfig?: () => RunConfig;
  getRetentionPolicy?: () => {
    consumedSessionRetentionMinutes: number;
    unconsumedSessionRetentionMinutes: number;
  };
  registry?: AgentTypeRegistry;
  savedAgents?: SavedAgents;
}) {
  const createSubagentSession: SessionFactory =
    overrides?.createSubagentSession ?? defaultFactory();
  const observer: SubagentManagerObserver | undefined = overrides?.observer
    ? {
        onSubagentStarted: overrides.observer.onSubagentStarted ?? (() => {}),
        onSubagentCompleted: overrides.observer.onSubagentCompleted ?? (() => {}),
        onSubagentResumed: overrides.observer.onSubagentResumed ?? (() => {}),
        onSubagentResuming: overrides.observer.onSubagentResuming ?? (() => {}),
        onSubagentCompacted: overrides.observer.onSubagentCompacted ?? (() => {}),
        onSubagentCreated: overrides.observer.onSubagentCreated ?? (() => {}),
      }
    : undefined;
  const limiter = new ConcurrencyLimiter(
    overrides?.getMaxConcurrent ?? (() => DEFAULT_MAX_CONCURRENT),
  );
  const mgr = new SubagentManager({
    createSubagentSession,
    observer,
    limiter,
    getRunConfig: overrides?.getRunConfig,
    getRetentionPolicy: overrides?.getRetentionPolicy,
    registry: overrides?.registry ?? defaultRegistry(),
    savedAgents: overrides?.savedAgents,
  });
  return { manager: mgr, createSubagentSession, limiter };
}

/** Spawn an agent using STUB_SNAPSHOT. */
function spawnBg(mgr: SubagentManager, prompt = "test", desc = prompt) {
  return mgr.spawn(STUB_SNAPSHOT, "general-purpose", prompt, {
    description: desc,
  });
}

/** Spawn an agent and wait for its first run to end. */
async function spawnSettled(mgr: SubagentManager, prompt = "test", desc = prompt) {
  const record = mgr.getRecord(spawnBg(mgr, prompt, desc))!;
  await record.promise;
  return record;
}

/** Spawn a background agent carrying a parentSession.toolCallId (notification path). */
function spawnBgWithToolCall(
  mgr: SubagentManager,
  toolCallId: string,
  prompt = "test",
  desc = prompt,
) {
  return mgr.spawn(STUB_SNAPSHOT, "general-purpose", prompt, {
    description: desc,
    parentSession: { toolCallId },
  });
}

/** Arrange a manager at limit 1 with two bg agents over a blocking factory: first runs, second queues. */
function arrangeQueuedPair(observer?: Partial<SubagentManagerObserver>) {
  const factory = createBlockingFactory();
  const { manager: mgr } = createManager({
    createSubagentSession: factory,
    getMaxConcurrent: () => 1,
    observer,
  });
  const running = spawnBg(mgr, "a");
  const queued = spawnBg(mgr, "b");
  return { manager: mgr, factory, running, queued };
}

/**
 * Arrange a manager whose onSubagentCompleted observer forwards to a real
 * NotificationManager (mirroring SubagentEventsObserver's unconditional
 * sendCompletion delegation), with one agent spawned via a tool call. The
 * act (when the record is marked consumed relative to awaiting) stays in each
 * test.
 */
function seedNotificationScenario(createSubagentSession?: SessionFactory) {
  const sendMessage = vi.fn();
  const notifications = new NotificationManager(sendMessage);
  const { manager } = createManager({
    observer: { onSubagentCompleted: (r) => notifications.sendCompletion(r) },
    createSubagentSession,
  });
  // The spawning tool call runs inside a parent agent run, so nudges are
  // withheld until it settles.
  notifications.onParentAgentStart();
  const id = spawnBgWithToolCall(manager, "tc-1");
  const record = manager.getRecord(id)!;
  return { manager, record, notifications, sendMessage };
}

describe("SubagentManager", () => {
  describe("spawn", () => {
    let manager: SubagentManager;

    afterEach(() => {
      manager.abortAll();
    });

    describe("type resolution", () => {
      it("stores the canonical type for case-variant input", () => {
        ({ manager } = createManager());

        const id = manager.spawn(STUB_SNAPSHOT, "explore", "test", {
          description: "d",
        });

        expect(manager.getRecord(id)!.type).toBe("explore");
      });

      it("falls back to general-purpose for an unknown type", () => {
        ({ manager } = createManager());

        const id = manager.spawn(STUB_SNAPSHOT, "no-such-agent", "test", {
          description: "d",
        });

        expect(manager.getRecord(id)!.type).toBe("general-purpose");
      });

      it("throws for a known-but-disabled type", () => {
        ({ manager } = createManager({
          registry: registryWith("plan", { visibility: "disabled" }),
        }));

        expect(() =>
          manager.spawn(STUB_SNAPSHOT, "plan", "test", {
            description: "d",
          }),
        ).toThrow('Agent type "plan" is disabled');
      });

      it("reports the canonical casing in the disabled-agent error for case-insensitive input", () => {
        ({ manager } = createManager({
          registry: registryWith("plan", { visibility: "disabled" }),
        }));

        expect(() =>
          manager.spawn(STUB_SNAPSHOT, "plan", "test", {
            description: "d",
          }),
        ).toThrow('Agent type "plan" is disabled');
      });

      it("throws with the parse error for a type whose file does not parse", () => {
        ({ manager } = createManager({
          registry: registryWith("plan", {
            definitionError: "invalid frontmatter in /p/plan.md: x",
          }),
        }));

        expect(() => manager.spawn(STUB_SNAPSHOT, "plan", "test", { description: "d" })).toThrow(
          'Agent type "plan" cannot load: invalid frontmatter in /p/plan.md: x',
        );
        expect(manager.listAgents()).toEqual([]);
      });

      it("spawns a hidden type by name", () => {
        ({ manager } = createManager({ registry: registryWith("plan", { visibility: "hidden" }) }));

        const id = manager.spawn(STUB_SNAPSHOT, "plan", "test", {
          description: "d",
        });

        expect(manager.getRecord(id)!.type).toBe("plan");
      });

      it("does not create a record for a rejected spawn", () => {
        ({ manager } = createManager({
          registry: registryWith("plan", { visibility: "disabled" }),
        }));

        expect(() =>
          manager.spawn(STUB_SNAPSHOT, "plan", "test", {
            description: "d",
          }),
        ).toThrow();

        expect(manager.listAgents()).toEqual([]);
      });
    });

    describe("admission", () => {
      it("queues an agent behind a full concurrency limit", () => {
        ({ manager } = createManager({
          registry: registryWith("explore", {}),
          getMaxConcurrent: () => 1,
          createSubagentSession: createBlockingFactory(),
        }));
        spawnBg(manager, "occupies-the-only-slot");

        const id = manager.spawn(STUB_SNAPSHOT, "explore", "test", { description: "d" });

        expect(manager.getRecord(id)!.status).toBe("queued");
      });

      it("starts a bypassQueue spawn at once even behind a full concurrency limit", async () => {
        // Only the first session creation blocks, so the first agent holds the
        // single limiter slot open while the bypassing agent runs.
        let creations = 0;
        const factory = vi.fn((_params: CreateSubagentSessionParams) => {
          creations += 1;
          return creations === 1
            ? new Promise<SubagentSession>(() => {})
            : Promise.resolve(toSubagentSession(createSubagentSessionStub()));
        });
        ({ manager } = createManager({
          registry: registryWith("explore", {}),
          getMaxConcurrent: () => 1,
          createSubagentSession: factory,
        }));
        spawnBg(manager, "occupies-the-only-slot");

        const id = manager.spawn(STUB_SNAPSHOT, "explore", "test", {
          description: "d",
          bypassQueue: true,
        });
        // Were this routed through the limiter, the await would never settle.
        await manager.getRecord(id)!.promise;

        expect(manager.getRecord(id)!.status).toBe("completed");
      });
    });
  });

  describe("concurrency", () => {
    describe("queueing with injected stubs", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("queues excess background agents and drains them in order", async () => {
        const startOrder: string[] = [];
        const { promise: gate1, resolve: resolve1 } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
        const { promise: gate2, resolve: resolve2 } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args

        let callCount = 0;
        const factory: SessionFactory = vi.fn(async () => {
          callCount++;
          const n = callCount;
          startOrder.push(`start-${n}`);
          const stub = createSubagentSessionStub();
          stub.runTurnLoop.mockImplementation(async () => {
            if (n === 1) await gate1;
            if (n === 2) await gate2;
            return turnLoopResult({ responseText: `result-${n}` });
          });
          return toSubagentSession(stub);
        });
        ({ manager } = createManager({
          createSubagentSession: factory,
          getMaxConcurrent: () => 1,
        }));

        // Spawn two background agents — first runs, second queues
        const id1 = spawnBg(manager, "test1", "first");
        const id2 = spawnBg(manager, "test2", "second");

        expect(manager.getRecord(id1)!.status).toBe("running");
        expect(manager.getRecord(id2)!.status).toBe("queued");

        // Complete first agent — second should start
        resolve1();
        await manager.getRecord(id1)!.promise;

        // Wait for the second to start
        await vi.waitFor(() => expect(manager.getRecord(id2)!.status).toBe("running"));

        resolve2();
        await manager.getRecord(id2)!.promise;

        expect(startOrder).toEqual(["start-1", "start-2"]);
        expect(manager.getRecord(id1)!.result).toBe("result-1");
        expect(manager.getRecord(id2)!.result).toBe("result-2");
      });

      it("gives a queued agent an awaitable promise at spawn (before its slot opens)", () => {
        const { manager: mgr, running, queued } = arrangeQueuedPair();
        manager = mgr;

        // A still-queued agent must already expose a settle-on-completion promise,
        // so waitForAll can await it without relying on a re-poll. (Regression
        // guard: #374 made the promise lazy; the limiter handle is captured eagerly.)
        expect(manager.getRecord(queued)!.status).toBe("queued");
        expect(manager.getRecord(queued)!.promise).toBeInstanceOf(Promise);

        manager.abort(running);
        manager.abort(queued);
      });

      it("abort removes a queued agent without ever running it", () => {
        const { manager: mgr, factory, running, queued } = arrangeQueuedPair();
        manager = mgr;

        expect(manager.getRecord(queued)!.status).toBe("queued");

        // Abort the queued agent
        expect(manager.abort(queued)).toBe(true);
        expect(manager.getRecord(queued)!.status).toBe("stopped");

        // factory was called once (for the first agent), never for the aborted one
        expect(factory).toHaveBeenCalledOnce();

        manager.abort(running);
      });

      it("onStart fires when agent transitions from queued to running", async () => {
        const startedIds: string[] = [];
        const { promise: gate, resolve } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args

        let callCount = 0;
        const factory: SessionFactory = vi.fn(async () => {
          callCount++;
          const n = callCount;
          const stub = createSubagentSessionStub();
          stub.runTurnLoop.mockImplementation(async () => {
            if (n === 1) await gate;
            return turnLoopResult({ responseText: "ok" });
          });
          return toSubagentSession(stub);
        });
        ({ manager } = createManager({
          createSubagentSession: factory,
          getMaxConcurrent: () => 1,
          observer: {
            onSubagentStarted: (record) => {
              startedIds.push(record.id);
            },
          },
        }));

        const id1 = spawnBg(manager, "a");
        const id2 = spawnBg(manager, "b");

        // First agent started immediately
        expect(startedIds).toEqual([id1]);

        // Complete first — second should start and fire onStart
        resolve();
        await manager.getRecord(id1)!.promise;
        await vi.waitFor(() => expect(startedIds).toHaveLength(2));

        expect(startedIds).toEqual([id1, id2]);

        await manager.getRecord(id2)!.promise;
      });
    });

    // Diagnosis, boundary, and these three cases contributed by @daoguademeng in #665.
    describe("stopping a queued agent", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("abort() on a queued agent notifies onSubagentCompleted", () => {
        const completed: Subagent[] = [];
        const {
          manager: mgr,
          running,
          queued,
        } = arrangeQueuedPair({
          onSubagentCompleted: (record) => completed.push(record),
        });
        manager = mgr;

        expect(manager.abort(queued)).toBe(true);

        expect(completed).toHaveLength(1);
        expect(completed[0]).toBe(manager.getRecord(queued));
        expect(manager.getRecord(queued)!.status).toBe("stopped");
        expect(manager.getRecord(queued)!.stoppedWhileQueued).toBe(true);

        manager.abort(running);
      });

      it("abortAll() notifies onSubagentCompleted for queued agents", () => {
        const completed: Subagent[] = [];
        const { manager: mgr, queued } = arrangeQueuedPair({
          onSubagentCompleted: (record) => completed.push(record),
        });
        manager = mgr;

        expect(manager.abortAll()).toBe(2);

        // Only the queued agent notifies here: the running one's session creation
        // never resolves, so its run never reaches completeRun/failRun.
        expect(completed).toHaveLength(1);
        expect(completed[0]).toBe(manager.getRecord(queued));
        expect(manager.getRecord(queued)!.stoppedWhileQueued).toBe(true);
      });

      it("notifies exactly once, even after the stopped agent's slot frees", async () => {
        const completed: Subagent[] = [];
        const { promise: gate, resolve } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args

        let callCount = 0;
        const factory: SessionFactory = vi.fn(async () => {
          callCount++;
          const n = callCount;
          const stub = createSubagentSessionStub();
          stub.runTurnLoop.mockImplementation(async () => {
            if (n === 1) await gate;
            return turnLoopResult({ responseText: `result-${n}` });
          });
          return toSubagentSession(stub);
        });
        ({ manager } = createManager({
          createSubagentSession: factory,
          getMaxConcurrent: () => 1,
          observer: { onSubagentCompleted: (record) => completed.push(record) },
        }));

        const running = spawnBg(manager, "a");
        const queued = spawnBg(manager, "b");
        expect(manager.getRecord(queued)!.status).toBe("queued");

        manager.abort(queued);
        const notificationsFor = (id: string) => completed.filter((record) => record.id === id);
        expect(notificationsFor(queued)).toHaveLength(1);

        // Free the slot. The limiter runs the stopped agent's thunk, which must
        // no-op on guardedRun()'s active guard rather than run and notify again.
        resolve();
        await manager.getRecord(running)!.promise;
        await manager.getRecord(queued)!.promise;

        expect(notificationsFor(queued)).toHaveLength(1);
        expect(factory).toHaveBeenCalledOnce();
      });
    });
  });

  describe("observer notifications", () => {
    describe("completion callbacks", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("does not let onComplete errors turn a completed agent into a failed run", async () => {
        ({ manager } = createManager({
          observer: {
            onSubagentCompleted: () => {
              throw new Error("stale extension context");
            },
          },
        }));

        const id = spawnBg(manager);
        await expect(manager.getRecord(id)!.promise).resolves.toBeUndefined();

        expect(manager.getRecord(id)!.status).toBe("completed");
      });
    });

    describe("onSubagentCreated", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("fires onSubagentCreated when an agent is spawned", () => {
        const onCreated = vi.fn();
        ({ manager } = createManager({ observer: { onSubagentCreated: onCreated } }));

        const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
          description: "test agent",
        });

        expect(onCreated).toHaveBeenCalledOnce();
        expect(onCreated).toHaveBeenCalledWith(manager.getRecord(id));

        manager.abort(id);
      });

      it("fires onSubagentCreated before onSubagentStarted", async () => {
        const callOrder: string[] = [];
        ({ manager } = createManager({
          observer: {
            onSubagentCreated: () => {
              callOrder.push("created");
            },
            onSubagentStarted: () => {
              callOrder.push("started");
            },
          },
        }));

        const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
          description: "bg agent",
        });
        await manager.getRecord(id)!.promise;

        expect(callOrder).toEqual(["created", "started"]);
      });
    });

    describe("lifecycle observer forwarding", () => {
      let manager: SubagentManager;

      beforeEach(() => {
        const { factory } = createSessionFactory(createMockSession());
        ({ manager } = createManager({ createSubagentSession: factory }));
      });

      afterEach(async () => {
        await manager.dispose();
      });

      it("forwards onSessionCreated from spawn options observer to Agent", async () => {
        const received: { agent: Subagent | undefined } = { agent: undefined };

        const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
          description: "test",
          observer: {
            onSessionCreated: (agent) => {
              received.agent = agent;
            },
          },
        });
        await manager.getRecord(id)!.promise;

        expect(received.agent).toBe(manager.getRecord(id));
        expect(received.agent!.id).toBe(id);
      });
    });

    describe("toolCallId notification wiring", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("wires toolCallId on spawn when provided", () => {
        ({ manager } = createManager());

        const id = spawnBgWithToolCall(manager, "tc-42", "test", "bg");
        const record = manager.getRecord(id)!;

        expect(record.toolCallId).toBe("tc-42");
        manager.abort(id);
      });

      it("toolCallId is undefined when absent", () => {
        ({ manager } = createManager());

        const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
          description: "bg",
        });
        const record = manager.getRecord(id)!;

        expect(record.toolCallId).toBeUndefined();
        manager.abort(id);
      });
    });

    describe("the completion message versus what the parent read", () => {
      let manager: SubagentManager;

      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(async () => {
        await manager.dispose();
        vi.useRealTimers();
      });

      it("still delivers the message when the parent read the result after awaiting", async () => {
        const seeded = seedNotificationScenario();
        manager = seeded.manager;
        const { record, sendMessage } = seeded;

        // onSubagentCompleted already withheld the message by the time this
        // await resumes. The parent reads the result (markConsumed) later in the
        // same run; reading is not delivery, so the message still goes out.
        await record.promise;
        record.markConsumed();

        seeded.notifications.onParentAgentSettled();
        expect(sendMessage).toHaveBeenCalledOnce();
      });

      it("still delivers the message when the parent read the result before it was sent", async () => {
        const seeded = seedNotificationScenario();
        manager = seeded.manager;
        const { record, sendMessage } = seeded;

        record.markConsumed();
        await record.promise;

        seeded.notifications.onParentAgentSettled();
        expect(sendMessage).toHaveBeenCalledOnce();
      });

      it("calls the completion observer for every agent", async () => {
        let onCompleteCalled = false;
        ({ manager } = createManager({
          observer: {
            onSubagentCompleted: () => {
              onCompleteCalled = true;
            },
          },
        }));

        await manager.getRecord(spawnBg(manager))!.promise;

        // The lifecycle event and the session-history record are facts about the
        // run, owed for every agent.
        expect(onCompleteCalled).toBe(true);
      });

      /** A session whose turn loop ends the way `outcome` says. */
      function endingAs(outcome: "completed" | "error" | "stopped"): SessionFactory {
        return async () => {
          const stub = createSubagentSessionStub();
          stub.runTurnLoop.mockImplementation(async (_prompt, options) => {
            if (outcome === "error") throw new Error("boom");
            if (outcome === "stopped") {
              await new Promise<void>((resolve) =>
                options.signal?.addEventListener("abort", () => resolve()),
              );
            }
            return turnLoopResult({ responseText: "Done." });
          });
          return toSubagentSession(stub);
        };
      }

      it.each(["completed", "error", "stopped"] as const)(
        "delivers exactly one completion message for an agent that %s",
        async (outcome) => {
          const seeded = seedNotificationScenario(endingAs(outcome));
          manager = seeded.manager;
          const { record, sendMessage } = seeded;
          if (outcome === "stopped") {
            await vi.waitFor(() => expect(record.status).toBe("running"));
            manager.abort(record.id);
          }

          await record.promise;
          // Reading the result mid-run changes nothing about delivery.
          record.markConsumed();
          seeded.notifications.onParentAgentSettled();
          seeded.notifications.onParentAgentSettled();

          expect(record.status).toBe(outcome);
          expect(sendMessage).toHaveBeenCalledOnce();
          const [message] = sendMessage.mock.calls[0];
          expect(message.customType).toBe("subagent:completion");
          expect(message.details).toMatchObject({ id: record.id, status: outcome });
        },
      );
    });
  });

  describe("session retention and teardown", () => {
    describe("cleanup timer", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("does not keep the process alive on its own", () => {
        ({ manager } = createManager());

        expect((manager as any).sweepInterval.hasRef()).toBe(false);
      });
    });

    describe("clearCompleted", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("clearCompleted removes completed records", async () => {
        ({ manager } = createManager());

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        expect(manager.listAgents()).toHaveLength(1);
        await manager.clearCompleted();
        expect(manager.listAgents()).toHaveLength(0);
      });

      it("clearCompleted does not remove running or queued agents", async () => {
        // Use maxConcurrent=1 to keep second agent queued; factory never resolves
        ({ manager } = createManager({
          getMaxConcurrent: () => 1,
          createSubagentSession: createBlockingFactory(),
        }));

        const id1 = spawnBg(manager, "test1", "running agent");
        // Second agent should be queued (limit=1)
        const id2 = spawnBg(manager, "test2", "queued agent");

        expect(manager.getRecord(id1)!.status).toBe("running");
        expect(manager.getRecord(id2)!.status).toBe("queued");

        await manager.clearCompleted();

        // Both should still be present
        expect(manager.getRecord(id1)).toBeDefined();
        expect(manager.getRecord(id2)).toBeDefined();

        // Abort to allow cleanup
        manager.abort(id1);
        manager.abort(id2);
      });

      it("clearCompleted calls dispose on sessions of removed records", async () => {
        const disposeSpy = vi.fn();
        const sess = createMockSession({ dispose: disposeSpy });
        const { factory } = createSessionFactory(sess);
        ({ manager } = createManager({ createSubagentSession: factory }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        await manager.clearCompleted();

        expect(disposeSpy).toHaveBeenCalledOnce();
      });

      it("clearCompleted removes error and stopped records", async () => {
        const { factory, stub } = createSessionFactory();
        stub.runTurnLoop.mockRejectedValue(new Error("boom"));
        ({ manager } = createManager({ createSubagentSession: factory }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;
        expect(manager.getRecord(id)!.status).toBe("error");

        await manager.clearCompleted();
        expect(manager.getRecord(id)).toBeUndefined();
      });
    });

    describe("teardown awaits each child's shutdown", () => {
      let manager: SubagentManager;

      /** A manager holding one completed agent whose teardown the test controls. */
      async function seedGatedTeardown() {
        const { factory, stub } = createSessionFactory();
        const teardown = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
        stub.dispose = vi.fn((): Promise<void> => teardown.promise);
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;
        return { id, teardown, stub };
      }

      it("clearCompleted resolves only after the removed record's teardown settles", async () => {
        const { teardown } = await seedGatedTeardown();

        let settled = false;
        const pending = manager.clearCompleted().then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        teardown.resolve();
        await pending;
        expect(settled).toBe(true);
      });

      it("clearCompleted drops the record before awaiting its teardown", async () => {
        const { id, teardown } = await seedGatedTeardown();

        const pending = manager.clearCompleted();
        expect(manager.getRecord(id)).toBeUndefined();

        teardown.resolve();
        await pending;
      });

      it("dispose resolves only after every record's teardown settles", async () => {
        const { teardown } = await seedGatedTeardown();

        let settled = false;
        const pending = manager.dispose().then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        teardown.resolve();
        await pending;
        expect(settled).toBe(true);
      });

      it("dispose tears down every record even when one teardown rejects", async () => {
        const failing = createSessionFactory();
        failing.stub.dispose = vi.fn((): Promise<void> =>
          Promise.reject(new Error("teardown failed")),
        );
        const healthy = createSessionFactory();
        const factories = [failing.factory, healthy.factory];
        ({ manager } = createManager({
          createSubagentSession: vi.fn(async (params: CreateSubagentSessionParams) =>
            (factories.shift() ?? healthy.factory)(params),
          ),
        }));

        const first = spawnBg(manager, "test1", "first");
        const second = spawnBg(manager, "test2", "second");
        await manager.getRecord(first)!.promise;
        await manager.getRecord(second)!.promise;

        await expect(manager.dispose()).resolves.toBeUndefined();
        expect(failing.stub.dispose).toHaveBeenCalledOnce();
        expect(healthy.stub.dispose).toHaveBeenCalledOnce();
        expect(manager.listAgents()).toHaveLength(0);
      });
    });

    describe("consumption-aware session release sweep", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        vi.restoreAllMocks();
        await manager.dispose();
      });

      /** Spawn a background agent over a session factory and await its completion. */
      async function spawnCompleted(
        outputFile: string | undefined = "/tasks/agent.jsonl",
        getRetentionPolicy?: () => {
          consumedSessionRetentionMinutes: number;
          unconsumedSessionRetentionMinutes: number;
        },
      ): Promise<string> {
        const { factory } = createSessionFactory(createMockSession(), outputFile);
        ({ manager } = createManager({ createSubagentSession: factory, getRetentionPolicy }));
        const id = spawnBg(manager, "test", "investigate the bug");
        await manager.getRecord(id)!.promise;
        return id;
      }

      it("releases a consumed agent's session 10 min after consumption but keeps the record", async () => {
        const id = await spawnCompleted("/tasks/agent.jsonl");
        const record = manager.getRecord(id)!;
        const completedAt = record.completedAt!;
        record.markConsumed(completedAt + 5 * 60_000); // consumed 5 min after completion
        const nowSpy = vi.spyOn(Date, "now");

        // 10 min after completion is only 5 min after consumption → still retained.
        nowSpy.mockReturnValue(completedAt + 10 * 60_000);
        (manager as any).sweep();
        expect(manager.getRecord(id)!.isSessionReady()).toBe(true);

        // 10 min after consumption → session released, record survives.
        nowSpy.mockReturnValue(completedAt + 15 * 60_000);
        (manager as any).sweep();
        const swept = manager.getRecord(id)!;
        expect(swept).toBeDefined();
        expect(swept.isSessionReady()).toBe(false);
        expect(swept.outputFile).toBe("/tasks/agent.jsonl");
      });

      it("holds an unconsumed agent's session past 10 min and releases it at the cap", async () => {
        const id = await spawnCompleted("/tasks/agent.jsonl");
        const completedAt = manager.getRecord(id)!.completedAt!;
        const nowSpy = vi.spyOn(Date, "now");

        nowSpy.mockReturnValue(completedAt + 11 * 60_000); // past the consumed window
        (manager as any).sweep();
        expect(manager.getRecord(id)!.isSessionReady()).toBe(true); // unconsumed → held

        nowSpy.mockReturnValue(completedAt + 721 * 60_000); // past the 12h cap
        (manager as any).sweep();
        expect(manager.getRecord(id)!.isSessionReady()).toBe(false);
      });

      it("never releases a running or queued agent's session", async () => {
        ({ manager } = createManager({
          getMaxConcurrent: () => 1,
          createSubagentSession: createBlockingFactory(),
        }));
        const runningId = spawnBg(manager, "t1");
        const queuedId = spawnBg(manager, "t2");
        expect(manager.getRecord(runningId)!.status).toBe("running");
        expect(manager.getRecord(queuedId)!.status).toBe("queued");
        const runRelease = vi.spyOn(manager.getRecord(runningId)!, "releaseSession");
        const queueRelease = vi.spyOn(manager.getRecord(queuedId)!, "releaseSession");

        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000 * 60_000);
        (manager as any).sweep();

        expect(runRelease).not.toHaveBeenCalled();
        expect(queueRelease).not.toHaveBeenCalled();
        manager.abort(runningId);
        manager.abort(queuedId);
      });

      it("honors a custom retention policy from getRetentionPolicy", async () => {
        const id = await spawnCompleted("/t.jsonl", () => ({
          consumedSessionRetentionMinutes: 1,
          unconsumedSessionRetentionMinutes: 2,
        }));
        const record = manager.getRecord(id)!;
        const completedAt = record.completedAt!;
        record.markConsumed(completedAt);
        vi.spyOn(Date, "now").mockReturnValue(completedAt + 2 * 60_000); // 2 min > 1 min window
        (manager as any).sweep();
        expect(manager.getRecord(id)!.isSessionReady()).toBe(false);
      });

      it("leaves records in place after release (getRecord still resolves them)", async () => {
        const id = await spawnCompleted("/tasks/agent.jsonl");
        const completedAt = manager.getRecord(id)!.completedAt!;
        vi.spyOn(Date, "now").mockReturnValue(completedAt + 721 * 60_000);
        (manager as any).sweep();
        expect(manager.listAgents()).toHaveLength(1);
        expect(manager.getRecord(id)).toBeDefined();
      });
    });

    describe("subagent session state", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("sets record.subagentSession with session and outputFile after session creation", async () => {
        const session = createMockSession();
        const { factory } = createSessionFactory(session, "/tmp/session.jsonl");
        ({ manager } = createManager({ createSubagentSession: factory }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        const record = manager.getRecord(id)!;
        expect(record.subagentSession).toBeDefined();
        expect(record.subagentSession!.session).toBe(session);
        expect(record.subagentSession!.outputFile).toBe("/tmp/session.jsonl");
      });

      it("record.subagentSession is undefined before the session is created", () => {
        ({ manager } = createManager({ createSubagentSession: createBlockingFactory() }));

        const id = spawnBg(manager);
        const record = manager.getRecord(id)!;
        expect(record.subagentSession).toBeUndefined();
        manager.abort(id);
      });
    });
  });

  describe("record initialization", () => {
    // Eager init removes the optional/required asymmetry that previously required
    // `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
    describe("lifetime usage and compaction count are eagerly initialized", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
        // Factory never resolves — we just want to inspect the record at spawn time.
        ({ manager } = createManager({ createSubagentSession: createBlockingFactory() }));

        const id = spawnBg(manager);
        const record = manager.getRecord(id)!;

        expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
        expect(record.compactionCount).toBe(0);

        manager.abort(id);
      });

      it("record observer accumulates assistant usage into record.lifetimeUsage", async () => {
        // The record observer subscribes to session events via the wired subagentSession.
        // Emitting message_end events from runTurnLoop drives stats.
        const session = createMockSession();
        const { factory, stub } = createSessionFactory(session);
        stub.runTurnLoop.mockImplementation(async () => {
          session.emit({
            type: "message_end",
            message: { role: "assistant", usage: { input: 100, output: 50, cacheWrite: 10 } },
          });
          session.emit({
            type: "message_end",
            message: { role: "assistant", usage: { input: 200, output: 80, cacheWrite: 20 } },
          });
          return turnLoopResult({ responseText: "done" });
        });
        ({ manager } = createManager({ createSubagentSession: factory }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
          input: 300,
          output: 130,
          cacheWrite: 30,
        });
      });

      it("record observer increments compactionCount on compaction_end events", async () => {
        const compactSeen: any[] = [];

        const session = createMockSession();
        const { factory, stub } = createSessionFactory(session);
        stub.runTurnLoop.mockImplementation(async () => {
          // Compaction fires while the agent is still running — the record passed to
          // onCompact should reflect the just-incremented count.
          session.emit({
            type: "compaction_end",
            aborted: false,
            result: { tokensBefore: 12345 },
            reason: "threshold",
          });
          session.emit({
            type: "compaction_end",
            aborted: false,
            result: { tokensBefore: 22222 },
            reason: "manual",
          });
          return turnLoopResult({ responseText: "done" });
        });

        ({ manager } = createManager({
          createSubagentSession: factory,
          observer: {
            onSubagentCompacted: (record, info) => {
              compactSeen.push({ count: record.compactionCount, reason: info.reason });
            },
          },
        }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        expect(compactSeen).toEqual([
          { count: 1, reason: "threshold" },
          { count: 2, reason: "manual" },
        ]);
        expect(manager.getRecord(id)!.compactionCount).toBe(2);
      });

      it("resume() also accumulates usage and increments compactions on the same record", async () => {
        // Spawn with a subscribable session that resume can latch onto.
        const session = createMockSession();
        const { factory, stub } = createSessionFactory(session);
        stub.resumeTurnLoop.mockImplementation(async () => {
          // Emit events through the session — the record observer subscribed by
          // SubagentManager.resume() will pick them up.
          emitResumeUsageAndCompaction(session);
          return turnLoopResult({ responseText: "second" });
        });
        ({ manager } = createManager({ createSubagentSession: factory }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        // Pre-resume: lifetimeUsage from spawn was zero (run did not emit usage events)
        expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
          input: 0,
          output: 0,
          cacheWrite: 0,
        });
        expect(manager.getRecord(id)!.compactionCount).toBe(0);

        await resumeAndSettle(manager, id, "more");

        expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
          input: 70,
          output: 30,
          cacheWrite: 5,
        });
        expect(manager.getRecord(id)!.compactionCount).toBe(1);
      });
    });

    describe("getRunConfig threads defaultMaxTurns and wrapUpTurns into the turn loop", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("passes defaultMaxTurns and wrapUpTurns from getRunConfig to runTurnLoop", async () => {
        const getRunConfig = vi.fn(() => ({
          defaultMaxTurns: 10,
          wrapUpTurns: 3,
          midRunUpdates: true,
        }));
        const { factory, stub } = createSessionFactory();
        ({ manager } = createManager({ getRunConfig, createSubagentSession: factory }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        const turnOpts = stub.runTurnLoop.mock.calls[0][1];
        expect(turnOpts.defaultMaxTurns).toBe(10);
        expect(turnOpts.wrapUpTurns).toBe(3);
      });

      it("omits defaultMaxTurns and wrapUpTurns from runTurnLoop when no getRunConfig is provided", async () => {
        const { factory, stub } = createSessionFactory();
        ({ manager } = createManager({ createSubagentSession: factory }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        const turnOpts = stub.runTurnLoop.mock.calls[0][1];
        expect(turnOpts.defaultMaxTurns).toBeUndefined();
        expect(turnOpts.wrapUpTurns).toBeUndefined();
      });
    });

    describe("parent session threading", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("threads parentSession from AgentSpawnConfig to the factory params", async () => {
        const { factory } = createSessionFactory();
        ({ manager } = createManager({ createSubagentSession: factory }));

        manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
          description: "test",
          parentSession: {
            parentSessionFile: "/sessions/parent.jsonl",
            parentSessionId: "parent-session-123",
          },
        });

        await vi.waitFor(() => expect(factory).toHaveBeenCalled());

        const params = vi.mocked(factory).mock.calls[0][0];
        expect(params.parentSession?.parentSessionFile).toBe("/sessions/parent.jsonl");
        expect(params.parentSession?.parentSessionId).toBe("parent-session-123");
      });
    });
  });

  describe("dependency injection via options bag", () => {
    let manager: SubagentManager;

    afterEach(async () => {
      await manager.dispose();
    });

    it("calls the injected factory when spawning an agent", async () => {
      const { factory } = createSessionFactory();
      ({ manager } = createManager({ createSubagentSession: factory }));

      const id = spawnBg(manager);
      await manager.getRecord(id)!.promise;

      expect(factory).toHaveBeenCalledOnce();
      expect(manager.getRecord(id)!.result).toBe("done");
    });

    it("calls resumeTurnLoop on the SubagentSession when resuming an agent", async () => {
      const { factory, stub } = createSessionFactory();
      stub.resumeTurnLoop.mockResolvedValue(turnLoopResult({ responseText: "second" }));
      ({ manager } = createManager({ createSubagentSession: factory }));

      const id = spawnBg(manager);
      await manager.getRecord(id)!.promise;

      await resumeAndSettle(manager, id, "continue");

      expect(stub.resumeTurnLoop).toHaveBeenCalledOnce();
      expect(manager.getRecord(id)!.result).toBe("second");
    });

    it("fires onSubagentResumed when an agent is resumed", async () => {
      const onSubagentResumed = vi.fn();
      const { factory, stub } = createSessionFactory();
      stub.resumeTurnLoop.mockResolvedValue(turnLoopResult({ responseText: "second" }));
      ({ manager } = createManager({
        createSubagentSession: factory,
        observer: { onSubagentResumed },
      }));

      const id = spawnBg(manager);
      await manager.getRecord(id)!.promise;
      await resumeAndSettle(manager, id, "continue");

      expect(onSubagentResumed).toHaveBeenCalledExactlyOnceWith(manager.getRecord(id));
    });
  });

  describe("resume", () => {
    let manager: SubagentManager;

    afterEach(async () => {
      await manager.dispose();
    });

    describe("refused", () => {
      it("reports an id no record answers to", async () => {
        ({ manager } = createManager());

        expect(await resumeAndSettle(manager, "nope", "continue")).toEqual({
          kind: "refused",
          reason: "unknown-agent",
        });
      });

      it("reports a run that has not settled", async () => {
        ({ manager } = createManager({ createSubagentSession: createBlockingFactory() }));
        const id = spawnBg(manager);

        await vi.waitFor(() => expect(manager.getRecord(id)!.status).toBe("running"));

        expect(await resumeAndSettle(manager, id, "continue")).toEqual({
          kind: "refused",
          reason: "still-running",
        });
      });

      it("reports a session released by the retention sweep", async () => {
        const { factory } = createSessionFactory();
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;
        await manager.getRecord(id)!.releaseSession();

        expect(await resumeAndSettle(manager, id, "continue")).toEqual({
          kind: "refused",
          reason: "session-released",
        });
      });

      it("starts no turn loop for a refused resume", async () => {
        const { factory, stub } = createSessionFactory();
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;
        await manager.getRecord(id)!.releaseSession();

        await resumeAndSettle(manager, id, "continue");

        expect(stub.resumeTurnLoop).not.toHaveBeenCalled();
      });
    });

    describe("accepted", () => {
      it("reports a resumed run that failed as started, carrying the error", async () => {
        const { factory, stub } = createSessionFactory();
        stub.resumeTurnLoop.mockRejectedValue(new Error("resume exploded"));
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        const outcome = await resumeAndSettle(manager, id, "continue");

        expect(outcome.kind).toBe("started");
        expect(manager.getRecord(id)!.status).toBe("error");
      });

      it("tells the observer a resume started, before it reports one finished", async () => {
        const calls: string[] = [];
        const { factory, stub } = createSessionFactory();
        stub.resumeTurnLoop.mockResolvedValue(turnLoopResult({ responseText: "second" }));
        ({ manager } = createManager({
          createSubagentSession: factory,
          observer: {
            onSubagentResuming: () => calls.push("resuming"),
            onSubagentResumed: () => calls.push("resumed"),
          },
        }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        await resumeAndSettle(manager, id, "continue");

        expect(calls).toEqual(["resuming", "resumed"]);
      });

      it("runs the resumed turn loop under the record's own lever", async () => {
        const { factory, stub } = createSessionFactory();
        stub.resumeTurnLoop.mockResolvedValue(turnLoopResult({ responseText: "second" }));
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;
        const signal = new AbortController().signal;

        await resumeAndSettle(manager, id, "continue", { signal });

        // The caller's signal is wired through the record's abort(), so the loop
        // runs under the one lever abort(id) can also pull.
        expect(stub.resumeTurnLoop).toHaveBeenCalledWith(
          "continue",
          expect.objectContaining({ signal: manager.getRecord(id)!.abortController.signal }),
        );
      });

      it("stops an in-flight resume when the caller aborts it by id", async () => {
        const { factory, stub } = createSessionFactory();
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;
        const gate = Promise.withResolvers<TurnLoopResult>();
        let signalled = false;
        stub.resumeTurnLoop.mockImplementation(
          (_prompt: string, { signal }: { signal?: AbortSignal }) => {
            signal?.addEventListener("abort", () => {
              signalled = true;
              gate.resolve(turnLoopResult({ responseText: "partial answer" }));
            });
            return gate.promise;
          },
        );

        const resumed = resumeAndSettle(manager, id, "continue");
        await vi.waitFor(() => expect(stub.resumeTurnLoop).toHaveBeenCalled());

        expect(manager.abort(id)).toBe(true);
        await resumed;

        expect(signalled).toBe(true);
        expect(manager.getRecord(id)!.status).toBe("stopped");
      });
    });

    describe("announcing a resumed outcome", () => {
      let sendMessage: Mock;

      // A real NotificationManager wired the way SubagentEventsObserver wires it,
      // with the parent idle, so a resumed outcome is sent at once.
      beforeEach(() => {
        sendMessage = vi.fn();
        const notifications = new NotificationManager(sendMessage);
        const { factory, stub } = createSessionFactory();
        stub.resumeTurnLoop.mockResolvedValue(turnLoopResult({ responseText: "second" }));
        ({ manager } = createManager({
          createSubagentSession: factory,
          observer: { onSubagentResumed: (r) => notifications.sendCompletion(r) },
        }));
      });

      it("announces the resumed outcome once", async () => {
        const record = await spawnSettled(manager);

        await resumeAndSettle(manager, record.id, "continue");

        expect(sendMessage).toHaveBeenCalledOnce();
      });

      it("announces each resume, even after the parent read the earlier result", async () => {
        const record = await spawnSettled(manager);
        await resumeAndSettle(manager, record.id, "first answer");
        record.markConsumed();

        await resumeAndSettle(manager, record.id, "second answer");

        expect(sendMessage).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("startResume", () => {
    let manager: SubagentManager;

    afterEach(async () => {
      await manager.dispose();
    });

    it("returns the record already running the resume, before the resumed run settles", async () => {
      const { factory, stub } = createSessionFactory();
      ({ manager } = createManager({ createSubagentSession: factory }));
      const id = spawnBg(manager);
      const record = manager.getRecord(id)!;
      await record.promise;
      const gate = Promise.withResolvers<TurnLoopResult>();
      stub.resumeTurnLoop.mockReturnValue(gate.promise);

      const start = manager.startResume(id, "continue");

      expect(start).toEqual({ kind: "started", record });
      expect(record.status).toBe("running");
      gate.resolve(turnLoopResult({ responseText: "second" }));
      await record.promise;
      expect(record.status).toBe("completed");
    });

    it("refuses an id no record answers to", () => {
      ({ manager } = createManager());

      expect(manager.startResume("nope", "continue")).toEqual({
        kind: "refused",
        reason: "unknown-agent",
      });
    });

    it("refuses a run that has not settled, starting no turn loop", async () => {
      const { factory, stub } = createSessionFactory();
      // The session exists and its first run is still in flight, so only the
      // refusal stands between this call and a second turn loop.
      stub.runTurnLoop.mockReturnValue(new Promise(() => {}));
      ({ manager } = createManager({ createSubagentSession: factory }));
      const id = spawnBg(manager);
      await vi.waitFor(() => expect(stub.runTurnLoop).toHaveBeenCalled());

      expect(manager.startResume(id, "continue")).toEqual({
        kind: "refused",
        reason: "still-running",
      });
      expect(stub.resumeTurnLoop).not.toHaveBeenCalled();
    });
  });
});

describe("resolveRetentionWindow", () => {
  const policy = {
    consumedSessionRetentionMinutes: 10,
    unconsumedSessionRetentionMinutes: 720,
  };

  describe("an outcome the parent never collected", () => {
    it("holds for the long window, measured from completion", () => {
      expect(
        resolveRetentionWindow(
          {
            consumed: false,
            completedAt: 5_000,
            consumedAt: undefined,
            pendingQuestion: undefined,
          },
          policy,
        ),
      ).toEqual({ referenceAt: 5_000, windowMinutes: 720 });
    });

    it("measures from zero when the record has no completion time", () => {
      expect(
        resolveRetentionWindow(
          {
            consumed: false,
            completedAt: undefined,
            consumedAt: undefined,
            pendingQuestion: undefined,
          },
          policy,
        ),
      ).toEqual({ referenceAt: 0, windowMinutes: 720 });
    });
  });

  describe("an outcome the parent collected", () => {
    it("holds for the short window, measured from collection", () => {
      expect(
        resolveRetentionWindow(
          { consumed: true, completedAt: 5_000, consumedAt: 9_000, pendingQuestion: undefined },
          policy,
        ),
      ).toEqual({ referenceAt: 9_000, windowMinutes: 10 });
    });

    it("measures from completion when that is the later of the two", () => {
      expect(
        resolveRetentionWindow(
          { consumed: true, completedAt: 9_000, consumedAt: 5_000, pendingQuestion: undefined },
          policy,
        ),
      ).toEqual({ referenceAt: 9_000, windowMinutes: 10 });
    });
  });

  describe("a collected outcome that still carries an unanswered question", () => {
    it("holds for the long window, because the parent has not finished with it", () => {
      expect(
        resolveRetentionWindow(
          {
            consumed: true,
            completedAt: 5_000,
            consumedAt: 9_000,
            pendingQuestion: "Which config wins?",
          },
          policy,
        ),
      ).toEqual({ referenceAt: 5_000, windowMinutes: 720 });
    });

    it("measures from completion rather than collection, as an uncollected outcome does", () => {
      expect(
        resolveRetentionWindow(
          {
            consumed: true,
            completedAt: 9_000,
            consumedAt: 5_000,
            pendingQuestion: "Which config wins?",
          },
          policy,
        ),
      ).toEqual({ referenceAt: 9_000, windowMinutes: 720 });
    });
  });
});

describe("SubagentManager — cold resume", () => {
  let dir: string;
  let transcript: string;
  let cwd: string;
  let manager: SubagentManager;

  beforeEach(() => {
    dir = tempDir(onTestFinished, "cold-resume-manager-");
    transcript = join(dir, "agent.jsonl");
    writeFileSync(transcript, "{}\n");
    cwd = join(dir, "worktree");
    mkdirSync(cwd);
  });

  afterEach(async () => {
    await manager.dispose();
  });

  const savedRecord = (
    overrides: Partial<PersistedSubagentRecord> = {},
  ): PersistedSubagentRecord => ({
    id: "saved-1",
    type: "explore",
    description: "map the module",
    status: "completed",
    result: "Mapped it.",
    error: undefined,
    turnBudget: undefined,
    startedAt: 1_000,
    completedAt: 4_000,
    outputFile: transcript,
    toolUses: 7,
    cwd,
    ...overrides,
  });

  const savedAgents = (...records: PersistedSubagentRecord[]): SavedAgents => ({
    find: (id) => records.find((record) => record.id === id),
    parent: () => ({
      snapshot: STUB_SNAPSHOT,
      parentSession: { parentSessionFile: "/parent.jsonl", parentSessionId: "parent" },
    }),
  });

  describe("an agent whose session the sweep released", () => {
    async function releasedAgent(factory: SessionFactory) {
      ({ manager } = createManager({ createSubagentSession: factory }));
      const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "work", {
        description: "work",
        cwd,
        maxTurns: 5,
      });
      const record = manager.getRecord(id)!;
      await record.promise;
      await record.releaseSession();
      return { id, record };
    }

    it("reopens the transcript on the same record", async () => {
      const first = createSessionFactory(createMockSession(), transcript);
      const second = createSubagentSessionStub(createMockSession(), transcript);
      const factory = vi
        .fn<SessionFactory>()
        .mockImplementationOnce(first.factory)
        .mockResolvedValueOnce(toSubagentSession(second));
      const { id, record } = await releasedAgent(factory);

      const outcome = await resumeAndSettle(manager, id, "continue");

      expect(outcome).toEqual({ kind: "started", record });
      expect(factory).toHaveBeenCalledTimes(2);
      expect(factory.mock.calls[1][0]).toMatchObject({ transcriptPath: transcript, cwd });
      expect(second.applyTurnLimits).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: 5 }));
      expect(second.resumeTurnLoop).toHaveBeenCalledWith("continue", expect.anything());
      expect(record.status).toBe("completed");
      expect(record.result).toBe("resumed");
      expect(record.isSessionReady()).toBe(true);
      expect(record.outputFile).toBe(transcript);
    });

    it("stays refused once the transcript is gone, and names it", async () => {
      const { factory } = createSessionFactory(createMockSession(), transcript);
      const { id } = await releasedAgent(factory);
      rmSync(transcript);
      expect(await resumeAndSettle(manager, id, "continue")).toEqual({
        kind: "refused",
        reason: "session-released",
        transcriptPath: transcript,
      });
    });

    it("waits for the released session's shutdown before reopening its transcript", async () => {
      const first = createSessionFactory(createMockSession(), transcript);
      const shutdown = Promise.withResolvers<void>();
      first.stub.dispose.mockImplementation(() => shutdown.promise);
      const second = createSubagentSessionStub(createMockSession(), transcript);
      const factory = vi
        .fn<SessionFactory>()
        .mockImplementationOnce(first.factory)
        .mockResolvedValueOnce(toSubagentSession(second));
      ({ manager } = createManager({ createSubagentSession: factory }));
      const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "work", {
        description: "work",
        cwd,
      });
      const record = manager.getRecord(id)!;
      await record.promise;
      const released = record.releaseSession();
      manager.startResume(id, "continue");
      expect(record.status).toBe("running");
      expect(factory).toHaveBeenCalledTimes(1);
      shutdown.resolve();
      await released;
      await record.promise;
      expect(factory).toHaveBeenCalledTimes(2);
      expect(second.resumeTurnLoop).toHaveBeenCalled();
    });

    it("keeps the original resolved turn ceiling after the runtime default changes", async () => {
      const first = createSessionFactory(createMockSession(), transcript);
      first.stub.runTurnLoop.mockImplementation(async (_prompt, opts) => {
        const result = turnLoopResult({ turnBudget: { maxTurns: 3, used: 1, phase: "within" } });
        opts.onTurnBudget?.(result.turnBudget);
        return result;
      });
      const second = createSubagentSessionStub(createMockSession(), transcript);
      const factory = vi
        .fn<SessionFactory>()
        .mockImplementationOnce(first.factory)
        .mockResolvedValueOnce(toSubagentSession(second));
      ({ manager } = createManager({
        createSubagentSession: factory,
        getRunConfig: () => ({ defaultMaxTurns: 20 }) as RunConfig,
      }));
      const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "work", {
        description: "work",
        cwd,
      });
      const record = manager.getRecord(id)!;
      await record.promise;
      await record.releaseSession();
      await resumeAndSettle(manager, id, "continue");
      expect(second.applyTurnLimits).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: 3 }));
    });

    it("waits for an ongoing retention release when disposing the manager for a reload", async () => {
      const { factory, stub } = createSessionFactory(createMockSession(), transcript);
      ({ manager } = createManager({ createSubagentSession: factory }));
      const id = spawnBg(manager);
      const record = manager.getRecord(id)!;
      await record.promise;
      const shutdown = Promise.withResolvers<void>();
      stub.dispose.mockImplementation(() => shutdown.promise);
      const released = record.releaseSession();
      const disposed = vi.fn();
      const teardown = manager.dispose().then(disposed);
      await tick();
      expect(disposed).not.toHaveBeenCalled();
      shutdown.resolve();
      await released;
      await teardown;
      expect(disposed).toHaveBeenCalledOnce();
    });

    it("stays refused once its directory is gone, and names the transcript", async () => {
      const { factory, stub } = createSessionFactory(createMockSession(), transcript);
      const { id } = await releasedAgent(factory);
      rmSync(cwd, { recursive: true });
      expect(await resumeAndSettle(manager, id, "continue")).toEqual({
        kind: "refused",
        reason: "directory-unavailable",
        transcriptPath: transcript,
      });
      expect(stub.resumeTurnLoop).not.toHaveBeenCalled();
    });

    it("refuses a second resume while the first is still rebuilding", async () => {
      const first = createSessionFactory(createMockSession(), transcript);
      const factory = vi
        .fn<SessionFactory>()
        .mockImplementationOnce(first.factory)
        .mockImplementationOnce(() => new Promise<SubagentSession>(() => {}));
      const { id } = await releasedAgent(factory);
      expect(manager.startResume(id, "continue").kind).toBe("started");
      expect(manager.startResume(id, "again")).toEqual({
        kind: "refused",
        reason: "still-running",
      });
    });

    it("buffers a steer sent during the rebuild and delivers it to the new session", async () => {
      const first = createSessionFactory(createMockSession(), transcript);
      const second = createSubagentSessionStub(createMockSession(), transcript);
      let finish = (_session: SubagentSession) => {};
      const factory = vi
        .fn<SessionFactory>()
        .mockImplementationOnce(first.factory)
        .mockImplementationOnce(
          () =>
            new Promise<SubagentSession>((resolve) => {
              finish = resolve;
            }),
        );
      const { id, record } = await releasedAgent(factory);
      manager.startResume(id, "continue");
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));

      expect(await record.steer("also this")).toEqual({ kind: "buffered" });
      finish(toSubagentSession(second));
      await record.promise;

      expect(second.steer).toHaveBeenCalledWith("also this");
    });

    it("disposes a session that finishes rebuilding after the agent was stopped", async () => {
      const first = createSessionFactory(createMockSession(), transcript);
      const second = createSubagentSessionStub(createMockSession(), transcript);
      let finish = (_session: SubagentSession) => {};
      const factory = vi
        .fn<SessionFactory>()
        .mockImplementationOnce(first.factory)
        .mockImplementationOnce(
          () =>
            new Promise<SubagentSession>((resolve) => {
              finish = resolve;
            }),
        );
      const { id, record } = await releasedAgent(factory);
      manager.startResume(id, "continue");
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));

      expect(manager.abort(id)).toBe(true);
      expect(manager.startResume(id, "too soon")).toEqual({
        kind: "refused",
        reason: "still-running",
      });
      finish(toSubagentSession(second));
      await record.promise;

      expect(record.status).toBe("stopped");
      expect(second.dispose).toHaveBeenCalledTimes(1);
      expect(second.resumeTurnLoop).not.toHaveBeenCalled();
      expect(record.isSessionReady()).toBe(false);
      expect(record.resumeRefusal).toBeUndefined();
    });

    it("reports a failed rebuild as the run's error and can try again", async () => {
      const first = createSessionFactory(createMockSession(), transcript);
      const third = createSubagentSessionStub(createMockSession(), transcript);
      const factory = vi
        .fn<SessionFactory>()
        .mockImplementationOnce(first.factory)
        .mockRejectedValueOnce(new Error("not a valid session"))
        .mockResolvedValueOnce(toSubagentSession(third));
      const { id, record } = await releasedAgent(factory);

      await resumeAndSettle(manager, id, "continue");
      expect(record.status).toBe("error");
      expect(record.error).toContain("not a valid session");

      await resumeAndSettle(manager, id, "try again");
      expect(third.resumeTurnLoop).toHaveBeenCalledWith("try again", expect.anything());
      expect(record.status).toBe("completed");
    });
  });

  describe("an agent this runtime has no record of", () => {
    const model = makeModel({ provider: "open", id: "model-1" });
    const snapshotWithModel = {
      ...STUB_SNAPSHOT,
      modelRegistry: { find: () => model, getAll: () => [model] },
    };

    it("rebuilds a record from the saved entry and reopens the transcript", async () => {
      const { factory, stub } = createSessionFactory(createMockSession(), transcript);
      const observer = { onSubagentResuming: vi.fn(), onSubagentResumed: vi.fn() };
      const saved = savedRecord({ model: "open/model-1", thinkingLevel: "high", maxTurns: 4 });
      ({ manager } = createManager({
        createSubagentSession: factory,
        observer,
        savedAgents: {
          ...savedAgents(saved),
          parent: () => ({
            snapshot: snapshotWithModel,
            parentSession: { parentSessionFile: "/parent.jsonl", parentSessionId: "parent" },
          }),
        },
      }));
      expect(manager.getRecord("saved-1")).toBeUndefined();

      const outcome = await resumeAndSettle(manager, "saved-1", "continue");

      const record = manager.getRecord("saved-1")!;
      expect(outcome).toEqual({ kind: "started", record });
      expect(factory.mock.calls[0][0]).toMatchObject({
        type: "explore",
        transcriptPath: transcript,
        cwd,
        model,
        thinkingLevel: "high",
        agentId: "saved-1",
      });
      expect(stub.applyTurnLimits).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: 4 }));
      expect(stub.runTurnLoop).not.toHaveBeenCalled();
      expect(stub.resumeTurnLoop).toHaveBeenCalledWith("continue", expect.anything());
      expect(record.result).toBe("resumed");
      expect(record.toolUses).toBe(7);
      expect(observer.onSubagentResuming).toHaveBeenCalledWith(record);
      expect(observer.onSubagentResumed).toHaveBeenCalledWith(record);
    });

    it("resumes an agent that was interrupted mid-run", async () => {
      const { factory, stub } = createSessionFactory(createMockSession(), transcript);
      ({ manager } = createManager({
        createSubagentSession: factory,
        savedAgents: savedAgents(savedRecord({ status: "running", completedAt: undefined })),
      }));
      expect((await resumeAndSettle(manager, "saved-1", "continue")).kind).toBe("started");
      expect(stub.resumeTurnLoop).toHaveBeenCalled();
    });

    it.each([3, undefined])("keeps a saved resolved turn ceiling of %s", async (maxTurns) => {
      const { factory, stub } = createSessionFactory(createMockSession(), transcript);
      ({ manager } = createManager({
        createSubagentSession: factory,
        getRunConfig: () => ({ defaultMaxTurns: 20 }) as RunConfig,
        savedAgents: savedAgents(
          savedRecord({ turnBudget: { maxTurns, used: 1, phase: "within" } }),
        ),
      }));
      await resumeAndSettle(manager, "saved-1", "continue");
      expect(stub.applyTurnLimits).toHaveBeenCalledWith(
        expect.objectContaining({ maxTurns: maxTurns ?? 0 }),
      );
    });

    it.each([
      ["no entry at all", undefined, "unknown-agent", false],
      ["no transcript recorded", { outputFile: undefined }, "no-session", false],
      ["a transcript that is gone", { outputFile: "/nope.jsonl" }, "session-released", true],
      ["a directory that is gone", { cwd: "/nope" }, "directory-unavailable", true],
      ["no directory recorded", { cwd: undefined }, "directory-unavailable", true],
      ["an unknown agent type", { type: "Vanished" }, "agent-type-unavailable", true],
    ] as const)("refuses %s", async (_name, overrides, reason, namesTranscript) => {
      const { factory } = createSessionFactory();
      const record = savedRecord(overrides ?? {});
      ({ manager } = createManager({
        createSubagentSession: factory,
        savedAgents: savedAgents(...(overrides ? [record] : [])),
      }));
      const outcome = await resumeAndSettle(manager, "saved-1", "continue");
      expect(outcome).toEqual({
        kind: "refused",
        reason,
        ...(namesTranscript ? { transcriptPath: record.outputFile } : {}),
      });
      expect(factory).not.toHaveBeenCalled();
      expect(manager.getRecord("saved-1")).toBeUndefined();
    });

    it("refuses a disabled agent type rather than falling back to another", async () => {
      const { factory } = createSessionFactory();
      ({ manager } = createManager({
        createSubagentSession: factory,
        registry: registryWith("custom", { visibility: "disabled" }),
        savedAgents: savedAgents(savedRecord({ type: "custom" })),
      }));
      expect(await resumeAndSettle(manager, "saved-1", "continue")).toMatchObject({
        kind: "refused",
        reason: "agent-type-unavailable",
      });
    });

    it("answers from the same check it would resume on", () => {
      ({ manager } = createManager({ savedAgents: savedAgents() }));
      expect(manager.resumeRefusalFor(savedRecord())).toBeUndefined();
      expect(manager.resumeRefusalFor(savedRecord({ cwd: "/nope" }))).toBe("directory-unavailable");
      expect(manager.resumeRefusalFor(savedRecord({ outputFile: undefined }))).toBe("no-session");
    });

    it("lets a live record answer for itself, whatever the saved entry says", async () => {
      const { factory } = createSessionFactory();
      ({ manager } = createManager({ createSubagentSession: factory, savedAgents: savedAgents() }));
      const id = spawnBg(manager);
      await manager.getRecord(id)!.promise;
      expect(manager.resumeRefusalFor(savedRecord({ id, cwd: "/nope" }))).toBeUndefined();
    });
  });
});
