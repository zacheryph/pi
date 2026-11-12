import { debugLog } from "#src/debug";
import {
  isRestoreCandidate,
  type RestoredAgent,
  type RestoreRequest,
} from "#src/lifecycle/subagent-manager";
import { type LostAgent, lostReport } from "#src/observation/lost-report";
import type { RestoredWork } from "#src/observation/subagent-work";
import type { PersistedSubagentRecord } from "#src/persisted-record";
import type { WorkMessage } from "#work";

/**
 * The startup of the spawning session: bring back the agents the previous instance left holding
 * work (roadmap step 12).
 *
 * Runs on `session_start`, after the work host of the session exists (so its items can be
 * adopted) and before the host settles its startup (so what is not adopted is reported lost):
 *
 *  1. adopt the spawner's items of the agents to restore (`SubagentWork.adopt`);
 *  2. restore the agents: reopen their sessions without a run so their producers can take their
 *     work over, and close the rest as lost (`SubagentManager.restore`);
 *  3. settle each item: kept for an agent that goes on, cancelled for one that does not (reopening
 *     one agent is bounded, so a hung session cannot hold the startup: see `RESTORE_TIMEOUT_MS`);
 *  4. tell the parent once, in one message that starts no turn, which agents lost what.
 *
 * Which session starts matters:
 *  - `reload`, `startup` and `resume` restore. A reload is the same process, so a child's retained
 *    jobs can be taken back; the others are restarts, where only questions can be.
 *  - `new` has no agents. `fork` copies a branch whose agents belong to the session it was
 *    forked from: it neither reopens their sessions nor adopts their items, which the host then
 *    reports lost.
 *  - A delegated session never restores. Its own subagents end with the reload that ended it, so
 *    their items are reported lost to it by its own host.
 */
export interface RestoreManager {
  restore(request: RestoreRequest): Promise<RestoredAgent[]>;
}

export interface RestoreWork {
  adopt(agentIds: ReadonlySet<string>): void;
  settle(agent: RestoredWork): void;
}

export interface StartupRestoreDeps {
  manager: RestoreManager;
  work: RestoreWork;
  /** The saved records of the context's branch; undefined when the context carries no session. */
  readRecords(ctx: unknown): readonly PersistedSubagentRecord[] | undefined;
  /** Whether the context is a delegated session, which has a delegator above it. */
  isChild(ctx: unknown): boolean;
  /** Write a message into the transcript without starting a turn. */
  report(message: WorkMessage): void;
}

const toLostAgent = (agent: RestoredAgent): LostAgent => ({
  id: agent.id,
  type: agent.type,
  description: agent.description,
  interrupted: agent.interrupted,
  lost: agent.lost,
  waitingOn: agent.waitingOn,
  timedOut: agent.unreachable === "timed-out",
});

export class StartupRestore {
  constructor(private readonly deps: StartupRestoreDeps) {}

  async handleSessionStart(event: { reason: string }, ctx: unknown): Promise<void> {
    const { reason } = event;
    if (reason === "new" || reason === "fork" || this.deps.isChild(ctx)) return;
    const records = this.deps.readRecords(ctx) ?? [];
    const candidates = records.filter(isRestoreCandidate);
    if (candidates.length === 0) return;

    this.deps.work.adopt(new Set(candidates.map((record) => record.id)));
    let agents: RestoredAgent[] = [];
    try {
      agents = await this.deps.manager.restore({
        records,
        startReason: reason === "reload" ? "reload" : "resume",
      });
    } catch (err) {
      debugLog("restore agents", err);
    }
    const restored = new Set(agents.map((agent) => agent.id));
    for (const agent of agents) this.deps.work.settle(agent);
    // An adopted item whose agent was not restored at all must not stay open and unreported.
    for (const record of candidates) {
      if (!restored.has(record.id)) {
        this.deps.work.settle({ ...record, continuing: false });
      }
    }
    const message = lostReport(agents.map(toLostAgent));
    if (message) this.deps.report(message);
  }
}
