import type { SessionStatus } from "#surface";
import { cleanText } from "#src/session/text";

/** What the user is asked, from a native Pi dialog or an open surface form. */
export interface Waiting {
  title?: string;
}

const MAX_TOOL_NAME = 64;

/** A tool name as the status shows it: one clean line, never blank. */
export const toolLabel = (name: unknown) => cleanText(name, MAX_TOOL_NAME) ?? "tool";

/**
 * Derives one status from Pi's lifecycle events and the session's open forms.
 * Precedence: waiting on the user (a native dialog, then an open form),
 * compacting, running a tool (the most recent top-level one), working, idle.
 * `since` changes only when the derived status changes.
 *
 * Everything here is process-bound: a new tracker starts idle, and nothing is
 * restored from history.
 */
export class StatusTracker {
  private running = false;
  private compacting = false;
  private prompt?: Waiting;
  private form?: Waiting;
  private readonly tools = new Map<string, string>();
  private key: string;
  private since: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.since = now();
    this.key = JSON.stringify(this.derive());
  }

  agentStart(): boolean {
    this.running = true;
    return this.touch();
  }
  toolStart(id: string, name: string): boolean {
    this.tools.delete(id);
    this.tools.set(id, toolLabel(name));
    return this.touch();
  }
  toolEnd(id: string): boolean {
    this.tools.delete(id);
    return this.touch();
  }
  compactStart(): boolean {
    this.compacting = true;
    return this.touch();
  }
  compactEnd(): boolean {
    this.compacting = false;
    return this.touch();
  }
  /** A native Pi dialog (select, confirm, input, editor or custom UI) waits for the user. */
  promptStart(title?: string): boolean {
    this.prompt = waiting(title);
    return this.touch();
  }
  promptEnd(): boolean {
    this.prompt = undefined;
    return this.touch();
  }
  /** The oldest open surface form, or `undefined` when none is open. */
  setForm(form: Waiting | undefined): boolean {
    this.form = form && waiting(form.title);
    return this.touch();
  }

  /** Pi has no automatic work left: tools still marked running were interrupted. */
  settled(): boolean {
    this.running = false;
    this.compacting = false;
    this.tools.clear();
    return this.touch();
  }

  current(): SessionStatus {
    return { ...this.derive(), since: this.since };
  }

  private derive(): DistributiveOmit<SessionStatus, "since"> {
    const asking = this.prompt ?? this.form;
    if (asking)
      return asking.title ? { kind: "waiting", title: asking.title } : { kind: "waiting" };
    if (this.compacting) return { kind: "compacting" };
    const tool = [...this.tools.values()].at(-1);
    if (tool) return { kind: "tool", tool };
    return this.running ? { kind: "working" } : { kind: "idle" };
  }

  /** Recomputes the status; true when it changed, and with it `since`. */
  private touch(): boolean {
    const key = JSON.stringify(this.derive());
    if (key === this.key) return false;
    this.key = key;
    this.since = this.now();
    return true;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function waiting(title: unknown): Waiting {
  const clean = cleanText(title);
  return clean ? { title: clean } : {};
}
