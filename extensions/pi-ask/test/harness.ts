import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, onTestFinished, vi } from "vitest";
import { provide } from "#session-tree";
import { createWorkHost, WORK_PARENT_SERVICE, WORK_SERVICE, type WorkRecord } from "#work";
import piAsk from "#src/index";
import { FORM_VIEW_ID, isFormModel, onViewChanged, readView, type FormModel } from "#surface";
import { fakeCustomUi, fakePi, waitFor } from "#test-helpers";

export type Tool = {
  name: string;
  exposure?: string;
  description: string;
  promptSnippet?: string;
  execute: (...args: unknown[]) => Promise<{
    content: { type: string; text: string }[];
    details: Record<string, unknown>;
    terminate?: boolean;
  }>;
};

export interface HarnessOptions {
  mode?: string;
  hasUI?: boolean;
  sessionId?: string;
}

export function harness(options: HarnessOptions = {}) {
  const fake = fakePi();
  const { pi, events } = fake;
  const tools = fake.tools as unknown as Map<string, Tool>;
  const mounted = fakeCustomUi<{
    handleInput?(data: string): void;
    render(width: number): string[];
  }>({ awaitDone: true });
  const ui = { notify: vi.fn(), select: vi.fn(), input: vi.fn(), custom: mounted.custom };
  // An inline window, never an overlay: ui.custom gets no options.
  onTestFinished(() => {
    for (const [, custom] of ui.custom.mock.calls) expect(custom).toBeUndefined();
  });
  /** What Pi says of its own dialogs right now; `stale` throws as a replaced session's ctx does. */
  const dialogs: { state: "yes" | "no" | "stale" } = {
    state: options.hasUI === false ? "no" : "yes",
  };
  const ctx = {
    mode: options.mode ?? "tui",
    get hasUI() {
      if (dialogs.state === "stale") throw new Error("This extension ctx is stale");
      return dialogs.state === "yes";
    },
    ui,
    isIdle: () => true,
    sessionManager: { getSessionId: () => options.sessionId ?? "root", getBranch: () => [] },
  } as unknown as ExtensionContext;
  piAsk(fake.api);
  const start = () => fake.emit("session_start", {}, ctx);
  const shutdown = () => fake.emit("session_shutdown", {}, ctx);
  const ask = (params: unknown, signal?: AbortSignal, id = "call-1") =>
    tools.get("ask")!.execute(id, params, signal, undefined, ctx);
  const until = (check: () => boolean) => waitFor(check, { interval: 0, timeout: 1000 });
  /** The published form, checked against pi-surface's guard on every read. */
  const form = (): FormModel | undefined => {
    const model = readView(events, FORM_VIEW_ID);
    if (model !== undefined) expect(isFormModel(model)).toBe(true);
    return model as FormModel | undefined;
  };
  /**
   * Runs `fn` once, as soon as the form lists a questionnaire: the moment a consumer outside the
   * terminal first sees it, before pi-ask shows it anywhere.
   */
  const whenPublished = (fn: () => void) => {
    let done = false;
    onViewChanged(events, (id) => {
      if (done || id !== FORM_VIEW_ID || !form()?.questionnaires.length) return;
      done = true;
      fn();
    });
  };
  return {
    pi,
    tools,
    registrations: pi.registerTool.mock.calls.map(([tool]) => tool),
    /** What pi-ask published; the action registry's own requests are not publications. */
    get sent() {
      return events.emitted.filter(([channel]) => !channel.startsWith("surface:"));
    },
    events,
    ui,
    ctx,
    dialogs,
    start,
    shutdown,
    ask,
    until,
    form,
    whenPublished,
    /** The ids of the questionnaires the form lists now. */
    formIds: () => form()?.questionnaires.map((questionnaire) => questionnaire.id) ?? [],
    get mounted() {
      return mounted.latest();
    },
    /** Every value a mounted window closed with. */
    windowDone: mounted.done,
  };
}

/**
 * A delegated session as pi-subagent sets it up before the child's extensions bind: a work host
 * under the session's id (`persisted` are the records an earlier instance left in its
 * transcript) and a parent link to tell. Nothing else provides the host, so pi-ask's
 * `ensureWorkHost` finds this one.
 */
export function delegated(
  persisted: WorkRecord[] = [],
  options: { id?: string; parent?: boolean } = {},
) {
  const id = options.id ?? "child";
  const records = [...persisted];
  const send = vi.fn();
  const host = createWorkHost({
    store: { read: () => records, append: (record) => records.push(record) },
    delivery: { isIdle: () => true, send, lost: vi.fn() },
  });
  host.start();
  provide(id, WORK_SERVICE, host);
  const question = vi.fn<(text: string) => void>();
  if (options.parent !== false) provide(id, WORK_PARENT_SERVICE, { question });
  return { host, question, send, records };
}

export const params = {
  questions: [
    {
      question: "Which database?",
      header: "Storage",
      options: [{ label: "Postgres" }, { label: "SQLite" }],
    },
  ],
};
