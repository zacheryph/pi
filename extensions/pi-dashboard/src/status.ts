import type { SessionStatus } from "./protocol.ts";

/**
 * Derives one status from Pi's lifecycle events. Priority: waiting on the
 * user, compacting, running a tool (the most recent one), working, idle.
 * `since` changes only when the derived status changes.
 */
export class StatusTracker {
  private running = false;
  private compacting = false;
  private prompt?: { title?: string };
  private readonly tools = new Map<string, string>();
  private key = "idle";
  private since: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.since = now();
  }

  agentStart(): void { this.running = true; this.touch(); }
  toolStart(id: string, name: string): void { this.tools.delete(id); this.tools.set(id, name); this.touch(); }
  toolEnd(id: string): void { this.tools.delete(id); this.touch(); }
  compactStart(): void { this.compacting = true; this.touch(); }
  compactEnd(): void { this.compacting = false; this.touch(); }
  promptStart(title?: string): void { this.prompt = title ? { title } : {}; this.touch(); }
  promptEnd(): void { this.prompt = undefined; this.touch(); }

  /** Pi has no automatic work left. */
  settled(): void {
    this.running = false;
    this.tools.clear();
    this.touch();
  }

  current(): SessionStatus & { since: number } {
    return { ...this.derive(), since: this.since };
  }

  private derive(): SessionStatus {
    if (this.prompt) return this.prompt.title ? { kind: "waiting", title: this.prompt.title } : { kind: "waiting" };
    if (this.compacting) return { kind: "compacting" };
    const tool = [...this.tools.values()].at(-1);
    if (tool) return { kind: "tool", tool };
    return this.running ? { kind: "working" } : { kind: "idle" };
  }

  private touch(): void {
    const status = this.derive();
    const key = JSON.stringify(status);
    if (key !== this.key) {
      this.key = key;
      this.since = this.now();
    }
  }
}
