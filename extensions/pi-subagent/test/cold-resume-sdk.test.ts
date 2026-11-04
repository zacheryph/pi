import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentExtension from "#src/index";
import { readPersistedRecords, SUBAGENT_RECORD_ENTRY } from "#src/persisted-record";

// A real parent session spawns real child sessions through the extension, all
// answered by one scripted faux provider. The parent runs in print mode, so a
// spawn runs in the foreground unless the call says otherwise.

const SWEEP_INTERVAL_MS = 60_000;

let dir: string;
let previousAgentDir: string | undefined;
let offline: ReturnType<typeof vi.spyOn>;
let sweeps: Array<() => void>;
const disposers: Array<() => void> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cold-resume-sdk-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const createRuntime = ModelRuntime.create.bind(ModelRuntime);
  offline = vi
    .spyOn(ModelRuntime, "create")
    .mockImplementation((options) => createRuntime({ ...options, refreshOnCreate: false }));
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }),
  );
  // The minimum the setting allows.
  writeFileSync(join(dir, "subagent.json"), JSON.stringify({ consumedSessionRetentionMinutes: 1 }));
  // Catch the manager's retention sweep, so a test can run it without waiting.
  sweeps = [];
  const realSetInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((
    fn: () => void,
    ms: number,
    ...rest: unknown[]
  ) => {
    if (ms === SWEEP_INTERVAL_MS) sweeps.push(fn);
    return realSetInterval(fn, ms, ...rest);
  }) as typeof setInterval);
});

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
  offline.mockRestore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(dir, { recursive: true, force: true });
});

async function parent(manager = SessionManager.inMemory(dir)) {
  const faux = createFauxCore({ provider: "cold-test", models: [{ id: "worker" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "cache"),
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("cold-test", {
    api: faux.api,
    apiKey: "test-key",
    models: faux.models,
    streamSimple: faux.streamSimple,
  });
  const events: Array<{ channel: string; data: unknown }> = [];
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      subagentExtension,
      (pi) => {
        for (const channel of ["subagent:session:disposed", "subagent:resumed"]) {
          pi.events.on(channel, (data) => events.push({ channel, data }));
        }
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    tools: ["subagent_start", "subagent_get", "subagent_steer"],
  });
  disposers.push(() => session.dispose());
  const errors = vi.fn();
  await session.bindExtensions({ mode: "print", onError: errors });
  return { session, manager, faux, errors, events };
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

const spawn = (description: string, extra: Record<string, unknown> = {}) =>
  call("subagent_start", {
    subagent_type: "general-purpose",
    description,
    prompt: `${description}.`,
    ...extra,
  });

const resume = (id: string, prompt: string, extra: Record<string, unknown> = {}) =>
  call("subagent_start", {
    subagent_type: "general-purpose",
    description: "resume",
    prompt,
    resume: id,
    foreground: true,
    ...extra,
  });

const lastResult = (context: Context, tool: string) =>
  JSON.stringify(
    context.messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === tool,
    ),
  );

function capture(requests: Context[], reply: ReturnType<typeof fauxAssistantMessage>) {
  return (context: Context) => {
    requests.push(structuredClone(context));
    return reply;
  };
}

const latestRecord = (manager: SessionManager) => readPersistedRecords(manager.getBranch())[0];

type Harness = Awaited<ReturnType<typeof parent>>;

/** Run a worker to completion; it learns a fact only its transcript can remember. */
async function finishedWorker(h: Harness, extra: Record<string, unknown> = {}) {
  h.faux.setResponses([
    spawn("Remember the codeword", extra),
    fauxAssistantMessage("The codeword is PLOVER."),
    fauxAssistantMessage("Started."),
  ]);
  await h.session.prompt("Delegate");
  const record = latestRecord(h.manager);
  expect(record).toMatchObject({ status: "completed" });
  expect(record.outputFile).toBeTruthy();
  return { id: record.id, transcript: record.outputFile!, record };
}

/** Run the retention sweep past the shortest window and wait for the release. */
async function forceRelease(h: Harness) {
  const later = Date.now() + 2 * SWEEP_INTERVAL_MS;
  const clock = vi.spyOn(Date, "now").mockReturnValue(later);
  for (const sweep of sweeps) sweep();
  clock.mockRestore();
  await vi.waitFor(() =>
    expect(h.events.some(({ channel }) => channel === "subagent:session:disposed")).toBe(true),
  );
}

/** Resume in the foreground; returns the child's request and the parent's view of the result. */
async function resumeForeground(h: Harness, id: string) {
  const child: Context[] = [];
  const after: Context[] = [];
  h.faux.setResponses([
    resume(id, "What was the codeword?"),
    capture(child, fauxAssistantMessage("It was PLOVER.")),
    capture(after, fauxAssistantMessage("Resumed.")),
  ]);
  await h.session.prompt("Ask the worker");
  expect(h.faux.getPendingResponseCount()).toBe(0);
  return { child: child[0], result: lastResult(after[0], "subagent_start") };
}

describe("cold resume in a real parent session (offline faux provider)", () => {
  it("continues with earlier context after its session was released", async () => {
    const h = await parent();
    const { id } = await finishedWorker(h);

    await forceRelease(h);
    const { child, result } = await resumeForeground(h, id);

    const conversation = JSON.stringify(child.messages);
    expect(conversation).toContain("Remember the codeword.");
    expect(conversation).toContain("The codeword is PLOVER.");
    expect(conversation).toContain("What was the codeword?");
    expect(result).toContain("It was PLOVER.");
    expect(latestRecord(h.manager)).toMatchObject({ id, status: "completed" });
    expect(h.errors).not.toHaveBeenCalled();
  }, 30_000);

  it("continues with earlier context after a full reload", async () => {
    const h = await parent();
    const { id, record } = await finishedWorker(h);

    await h.session.reload();
    const { child, result } = await resumeForeground(h, id);

    const conversation = JSON.stringify(child.messages);
    expect(conversation).toContain("Remember the codeword.");
    expect(conversation).toContain("The codeword is PLOVER.");
    expect(result).toContain("It was PLOVER.");
    expect(latestRecord(h.manager)).toMatchObject({
      id,
      status: "completed",
      result: "It was PLOVER.",
      description: record.description,
      model: record.model,
      thinkingLevel: record.thinkingLevel,
      cwd: record.cwd,
      outputFile: record.outputFile,
    });
    expect(h.errors).not.toHaveBeenCalled();
  }, 30_000);

  it("appends to the agent's existing transcript rather than starting a new one", async () => {
    const h = await parent();
    const { id, transcript } = await finishedWorker(h);
    const before = readFileSync(transcript, "utf8");
    const filesBefore = readdirSync(dirname(transcript));

    await h.session.reload();
    await resumeForeground(h, id);

    const after = readFileSync(transcript, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toContain("It was PLOVER.");
    expect(readdirSync(dirname(transcript))).toEqual(filesBefore);
    expect(latestRecord(h.manager).outputFile).toBe(transcript);
  }, 30_000);

  it("stays refused when its directory was removed, and names the transcript", async () => {
    const worktree = join(dir, "worktree");
    mkdirSync(worktree);
    const h = await parent();
    const { id, transcript, record } = await finishedWorker(h, { cwd: worktree });
    expect(record.cwd).toBe(worktree);

    rmSync(worktree, { recursive: true });
    await h.session.reload();

    const requests: Context[] = [];
    h.faux.setResponses([
      resume(id, "Keep going"),
      capture(requests, call("subagent_get", { agent_id: id })),
      capture(requests, fauxAssistantMessage("Refused.")),
    ]);
    await h.session.prompt("Ask the worker");

    expect(h.faux.getPendingResponseCount()).toBe(0);
    const refusal = lastResult(requests[0], "subagent_start");
    expect(refusal).toContain("the directory it ran in no longer exists");
    expect(refusal).toContain(transcript);
    // subagent_get reports the same answer, from the same check.
    const report = lastResult(requests[1], "subagent_get");
    expect(report).toContain("Resume: not available, because the directory it ran in");
    expect(report).toContain(`Full transcript available at: ${transcript}`);
    expect(latestRecord(h.manager)).toMatchObject({ id, status: "completed" });
  }, 30_000);

  it("reports it resumable from subagent_get and the list once its session is gone", async () => {
    const h = await parent();
    const { id } = await finishedWorker(h);
    await h.session.reload();

    const requests: Context[] = [];
    h.faux.setResponses([
      capture(requests, call("subagent_get", { agent_id: id })),
      capture(requests, call("subagent_get", {})),
      capture(requests, fauxAssistantMessage("Checked.")),
    ]);
    await h.session.prompt("Check on the worker");

    // The roster card, restored after the reload, already says so.
    expect(JSON.stringify(requests[0].messages.at(-1))).toMatch(/completed \d\d:\d\d, resumable/);
    expect(lastResult(requests[1], "subagent_get")).toContain(
      `Resume: available. Call subagent_start with resume: \\"${id}\\"`,
    );
    expect(lastResult(requests[2], "subagent_get")).toMatch(/completed \d\d:\d\d, resumable/);
  }, 30_000);

  it("resumes an agent whose run a reload interrupted", async () => {
    const h = await parent();
    const { transcript, record } = await finishedWorker(h);
    // As the parent saved it while the run was still under way.
    const saved = SessionManager.inMemory(dir);
    saved.appendCustomEntry(SUBAGENT_RECORD_ENTRY, {
      ...record,
      id: "interrupted-1",
      status: "running",
      result: undefined,
      completedAt: undefined,
    });
    const restored = await parent(saved);

    const { child, result } = await resumeForeground(restored, "interrupted-1");

    expect(JSON.stringify(child.messages)).toContain("The codeword is PLOVER.");
    expect(result).toContain("It was PLOVER.");
    expect(readFileSync(transcript, "utf8")).toContain("It was PLOVER.");
  }, 30_000);

  it("refuses a live run with still-running, and works as usual once rebuilt", async () => {
    const h = await parent();
    const { id } = await finishedWorker(h);
    await h.session.reload();

    let releaseChild = () => {};
    const childGate = new Promise<void>((done) => {
      releaseChild = done;
    });
    let childAsked = () => {};
    const childRunning = new Promise<void>((done) => {
      childAsked = done;
    });
    const requests: Context[] = [];
    const parentReplies = [
      resume(id, "Keep going", { foreground: false }),
      async (context: Context) => {
        await childRunning;
        requests.push(structuredClone(context));
        return resume(id, "And again", { foreground: false });
      },
      (context: Context) => {
        requests.push(structuredClone(context));
        return call("subagent_steer", { agent_id: id, message: "Also check the tests." });
      },
      (context: Context) => {
        requests.push(structuredClone(context));
        releaseChild();
        return fauxAssistantMessage("Waiting on the worker.");
      },
    ];
    const childContexts: Context[] = [];
    // Parent and child share one provider and race for its queue, so each step
    // answers whichever of them is asking.
    const answer = async (context: Context) => {
      const isChild = context.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message).includes("Remember the codeword."),
      );
      if (isChild) {
        childContexts.push(structuredClone(context));
        childAsked();
        await childGate;
        return fauxAssistantMessage("Picked it back up.");
      }
      const reply = parentReplies.shift() ?? fauxAssistantMessage("Noted.");
      return typeof reply === "function" ? reply(context) : reply;
    };
    h.faux.setResponses(Array.from({ length: 12 }, () => answer));

    await h.session.prompt("Continue the worker");
    await vi.waitFor(() =>
      expect(h.events.some(({ channel }) => channel === "subagent:resumed")).toBe(true),
    );

    expect(lastResult(requests[0], "subagent_start")).toContain("Agent resumed in background.");
    expect(lastResult(requests[1], "subagent_start")).toContain(
      `Agent \\"${id}\\" is still running`,
    );
    expect(lastResult(requests[2], "subagent_steer")).not.toContain("Agent not found");
    // The completion notification reached the parent, as for any background run.
    await vi.waitFor(() =>
      expect(JSON.stringify(h.manager.getEntries())).toContain("subagent:completion"),
    );
    expect(JSON.stringify(childContexts[0].messages)).toContain("The codeword is PLOVER.");
    expect(latestRecord(h.manager)).toMatchObject({ id, result: "Picked it back up." });
  }, 30_000);
});
