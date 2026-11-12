/**
 * pi-job's work items: one item in the session's work host (packages/pi-work) per job or watch,
 * opened when it starts and completed with the completion message when it ends. Delivery is the
 * host's: this file never sends a message.
 *
 * What is specific to pi-job is the reload. The manager (processes, timers, watch loops) is
 * retained across a reload in a process-wide owner, but the host is not: it is disposed with the
 * old session instance and the new instance provides another one. The old item handles are dead
 * then, so a `JobItems` travels with the manager (see ownership.ts), and the new instance:
 *
 *  1. `suspend`s the old side at shutdown: jobs that end in the gap are only remembered,
 *  2. `bind`s to the new host at `session_start` and lets the host offer it the items the old
 *     instance left open (`adopt`): each is matched to its job by session id, job id and log
 *     path, so only this session's own live jobs are taken over, and
 *  3. `release`s after every extension has started: the jobs that ended in the gap are
 *     completed through their adopted items, so nothing wakes the session half-initialized.
 *
 * The old host is disposed by its own `session_shutdown` handler, which may run before pi-job's:
 * a job that ends in between reaches a dead handle and its completion is dropped. `adopt` finds
 * such a job terminal, not stopped on request, and completes it through the new item.
 *
 * An item nobody adopts (jobs of an earlier process, or of another session whose records a fork
 * inherited) is closed as lost by the host, with one message that reaches the model.
 */
import type { Json, WorkHost, WorkItem, WorkMessage } from "#work";
import { jobTitle } from "#src/format";
import type { JobManager, JobSnapshot } from "#src/jobs";

/** The `owner` of every item pi-job opens, and what it adopts after a reload. */
export const WORK_OWNER = "pi-job";

/** Custom message type of the completion message an item is completed with. */
export const CUSTOM_TYPE = "job:completion";

/** What an item records so that the job can be recognized again. Persisted with the item. */
export interface JobItemData {
  jobId: string;
  /** The session that started the job: a fork inherits the records, but not the jobs. */
  sessionId: string;
  /** Together with the id, tells this manager's job from a later one with a reused id. */
  logPath: string;
}

export class JobItems {
  private readonly manager: JobManager;
  private readonly describe: (job: JobSnapshot) => WorkMessage;
  private readonly handles = new Map<string, WorkItem>();
  /** Jobs that ended while the host was unreachable or startup was not over, by job id. */
  private readonly ended = new Map<string, JobSnapshot>();
  private host: (() => WorkHost | undefined) | undefined;
  private sessionId = "";
  private holding = false;
  private disposed = false;

  constructor(manager: JobManager, describe: (job: JobSnapshot) => WorkMessage) {
    this.manager = manager;
    this.describe = describe;
  }

  /** The current instance's host accessor and session id. Call at every `session_start`. */
  bind(host: () => WorkHost | undefined, sessionId: string): void {
    this.host = host;
    this.sessionId = sessionId;
  }

  /**
   * Open the item of a job that just started. Throws when the session has no host, or the item
   * cannot be persisted: the caller then stops the job, which could never wake anyone.
   */
  open(job: JobSnapshot): void {
    const host = this.host?.();
    if (!host) throw new Error("pi-job: the session's work host is not available.");
    const data: JobItemData = { jobId: job.id, sessionId: this.sessionId, logPath: job.logPath };
    this.handles.set(
      job.id,
      host.open({
        owner: WORK_OWNER,
        kind: job.kind === "watch" ? "watch" : "job",
        label: jobTitle(job),
        data: data as unknown as Json,
      }),
    );
  }

  /** The job reached a terminal state on its own: complete its item with the completion. */
  finished(job: JobSnapshot): void {
    if (this.disposed) return;
    if (this.holding) this.ended.set(job.id, job);
    else this.complete(job);
  }

  /** The job was stopped on request: close its item without a message. */
  cancel(jobId: string): void {
    const item = this.handles.get(jobId);
    this.handles.delete(jobId);
    this.ended.delete(jobId);
    item?.cancel();
  }

  /**
   * An item the host offers after a reload or restart: take it over if it is a live job of this
   * session. Returns false for everything else, which the host then closes as lost.
   */
  adopt(item: WorkItem): boolean {
    const data = item.data as Partial<JobItemData> | undefined;
    if (typeof data?.jobId !== "string" || data.sessionId !== this.sessionId) return false;
    const job = this.manager.get(data.jobId);
    if (!job || job.logPath !== data.logPath) return false;
    if (job.status !== "running" && job.killedBy === "request") {
      item.cancel(); // stopped on request: nothing to deliver, nothing lost
      return true;
    }
    this.handles.set(job.id, item);
    // Ended on its own but its completion never reached a live host (a reload disposes the host
    // before pi-job's shutdown handler runs): deliver it through this item, not silently cancel.
    if (job.status !== "running" && !this.ended.has(job.id)) this.finished(job);
    return true;
  }

  /** Reload: the old host is going away, and with it these handles. What ends meanwhile waits for the new one. */
  suspend(): void {
    this.holding = true;
    this.handles.clear();
  }

  /** Startup is over: complete the jobs that ended in the reload gap. */
  release(): void {
    if (this.disposed || !this.holding) return;
    this.holding = false;
    const ended = [...this.ended.values()];
    this.ended.clear();
    for (const job of ended) this.complete(job);
  }

  /** The session is over. The items stay persisted: the next start reports them lost. */
  dispose(): void {
    this.disposed = true;
    this.handles.clear();
    this.ended.clear();
  }

  private complete(job: JobSnapshot): void {
    const item = this.handles.get(job.id);
    this.handles.delete(job.id);
    item?.complete(this.describe(job));
  }
}
