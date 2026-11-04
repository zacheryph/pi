import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import {
  readPersistedRecords,
  type PersistedSubagentRecord,
  SUBAGENT_RECORD_ENTRY,
} from "#src/persisted-record";

// A real parent session loads this extension and spawns real child sessions
// through it, all answered by one scripted faux provider in call order. The
// parent runs in print mode, so every spawn runs in the foreground.

const CARD = "Subagents started by this session";

let dir: string;
let previousAgentDir: string | undefined;
let offline: ReturnType<typeof vi.spyOn>;
const disposers: Array<() => void> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "records-sdk-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  // Children read their settings (and pi-ask) from here.
  process.env.PI_CODING_AGENT_DIR = dir;
  const createRuntime = ModelRuntime.create.bind(ModelRuntime);
  offline = vi
    .spyOn(ModelRuntime, "create")
    .mockImplementation((options) => createRuntime({ ...options, refreshOnCreate: false }));
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      extensions: [resolve(import.meta.dirname, "../../pi-ask/src/index.ts")],
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
});

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  offline.mockRestore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(dir, { recursive: true, force: true });
});

async function parent(manager = SessionManager.inMemory(dir)) {
  const faux = createFauxCore({ provider: "records-test", models: [{ id: "worker" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "cache"),
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("records-test", {
    api: faux.api,
    apiKey: "test-key",
    models: faux.models,
    streamSimple: faux.streamSimple,
  });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [subagentExtension],
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
      compaction: { enabled: false, keepRecentTokens: 1 },
      retry: { enabled: false },
    }),
    tools: ["subagent_start", "subagent_get"],
  });
  disposers.push(() => session.dispose());
  const errors = vi.fn();
  await session.bindExtensions({ mode: "print", onError: errors });
  return { session, manager, faux, errors };
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

const spawn = (description: string) =>
  call("subagent_start", {
    subagent_type: "general-purpose",
    description,
    prompt: `${description}.`,
  });

/** The text of the latest result `tool` returned in this request. */
const lastResult = (context: Context, tool: string) =>
  JSON.stringify(
    context.messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === tool,
    ),
  );

/** How many roster cards this request carries (the card reaches the model as a user turn). */
const cards = (context: Context) =>
  context.messages.filter((message) => JSON.stringify(message).includes(CARD)).length;

/** The agent IDs subagent_start returned on the current branch, oldest first. */
const spawnedIds = (manager: SessionManager) =>
  manager.getBranch().flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
    if (entry.message.toolName !== "subagent_start") return [];
    const id = /Agent ID: ([\w-]+)/.exec(JSON.stringify(entry.message.content))?.[1];
    return id ? [id] : [];
  });

/**
 * A response that records the request it answers. Assertions must run after
 * the prompt: one thrown inside a response is swallowed as a provider error.
 */
function capture(requests: Context[], reply: ReturnType<typeof fauxAssistantMessage>) {
  return (context: Context) => {
    requests.push(structuredClone(context));
    return reply;
  };
}

/** The last message of a request, where the card sits when it is sent. */
const tail = (context: Context | undefined) => JSON.stringify(context?.messages.at(-1));

describe("subagent records in a real parent session (offline faux provider)", () => {
  it("restores a transcript path from a record captured before the child finishes", async () => {
    const h = await parent();
    let running: PersistedSubagentRecord | undefined;
    h.faux.setResponses([
      spawn("Interrupted work"),
      () => {
        running = readPersistedRecords(h.manager.getBranch())[0];
        return fauxAssistantMessage("finished later");
      },
      fauxAssistantMessage("ok"),
    ]);
    await h.session.prompt("Delegate");
    expect(running).toMatchObject({ status: "running", model: "records-test/worker", cwd: dir });
    expect(running?.outputFile).toBeTruthy();
    const saved = SessionManager.inMemory(dir);
    saved.appendCustomEntry(SUBAGENT_RECORD_ENTRY, running);
    const restored = await parent(saved);
    const requests: Context[] = [];
    restored.faux.setResponses([
      call("subagent_get", { agent_id: running!.id }),
      capture(requests, fauxAssistantMessage("recovered")),
    ]);
    await restored.session.prompt("Recover interrupted work");
    const report = lastResult(requests[0], "subagent_get");
    expect(report).toContain("Status: interrupted");
    expect(report).toContain(`Full transcript available at: ${running!.outputFile}`);
  }, 30_000);

  it("answers subagent_get from the record after a reload, and shows the card until a list", async () => {
    const h = await parent();
    h.faux.setResponses([
      spawn("Map auth"),
      fauxAssistantMessage("Mapped auth call sites."),
      fauxAssistantMessage("Started."),
    ]);
    await h.session.prompt("Delegate");
    const [id] = spawnedIds(h.manager);
    expect(id).toBeTruthy();
    const statuses = h.manager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom" && entry.customType === SUBAGENT_RECORD_ENTRY
          ? [(entry.data as { status: string }).status]
          : [],
      );
    expect(statuses).toEqual(["running", "running", "completed"]);

    await h.session.reload();

    const requests: Context[] = [];
    h.faux.setResponses([
      capture(requests, call("subagent_get", { agent_id: id })),
      capture(requests, call("subagent_get", {})),
      capture(requests, fauxAssistantMessage("Checked.")),
    ]);
    await h.session.prompt("Check on the worker");
    expect(h.faux.getPendingResponseCount()).toBe(0);
    expect(requests.map(cards)).toEqual([1, 1, 0]);
    expect(tail(requests[0])).toContain("restored after reload");
    expect(tail(requests[0])).toContain(`${id} general-purpose \\"Map auth\\": completed`);
    const report = lastResult(requests[1], "subagent_get");
    expect(report).toContain("Mapped auth call sites.");
    expect(report).toContain("Full transcript available at: ");
    expect(report).toContain("Resume: available.");
    expect(lastResult(requests[2], "subagent_get")).toContain(
      `- ${id} general-purpose \\"Map auth\\": completed`,
    );
    // Context-only: the card is never written to the transcript.
    expect(JSON.stringify(h.manager.getEntries())).not.toContain(CARD);
    expect(h.errors).not.toHaveBeenCalled();
  }, 30_000);

  it("keeps the question a worker ended with across a reload", async () => {
    const h = await parent();
    h.faux.setResponses([
      spawn("Pick storage"),
      call("ask", {
        questions: [
          {
            question: "Which database?",
            header: "Storage",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
          },
        ],
      }),
      fauxAssistantMessage("Waiting for the storage decision."),
      fauxAssistantMessage("Asked."),
    ]);
    await h.session.prompt("Delegate");
    const [id] = spawnedIds(h.manager);

    await h.session.reload();

    const requests: Context[] = [];
    h.faux.setResponses([
      capture(requests, call("subagent_get", { agent_id: id })),
      capture(requests, fauxAssistantMessage("Seen.")),
    ]);
    await h.session.prompt("What did it ask?");
    expect(requests).toHaveLength(2);
    expect(tail(requests[0])).toContain(
      `${id} general-purpose \\"Pick storage\\": waiting for your answer: \\"[Storage] Which database?`,
    );
    const report = lastResult(requests[1], "subagent_get");
    expect(report).toContain("This agent is waiting on an answer:");
    expect(report).toContain("Which database?");
    expect(report).toContain(`resume: \\"${id}\\"`);
  }, 30_000);

  it("follows /tree: an agent spawned after the target point is gone from the list, by ID and on the card", async () => {
    const h = await parent();
    h.faux.setResponses([
      spawn("Kept work"),
      fauxAssistantMessage("kept"),
      fauxAssistantMessage("one"),
    ]);
    await h.session.prompt("First");
    const target = h.manager.getLeafId()!;
    h.faux.setResponses([
      spawn("Abandoned work"),
      fauxAssistantMessage("abandoned"),
      fauxAssistantMessage("two"),
    ]);
    await h.session.prompt("Second");
    const [kept, abandoned] = spawnedIds(h.manager);
    expect(abandoned).toBeTruthy();

    await h.session.navigateTree(target, { summarize: false });

    const requests: Context[] = [];
    h.faux.setResponses([
      capture(requests, call("subagent_get", { agent_id: abandoned })),
      capture(requests, call("subagent_get", {})),
      capture(requests, fauxAssistantMessage("done")),
    ]);
    await h.session.prompt("Where are we?");
    expect(requests).toHaveLength(3);
    expect(tail(requests[0])).toContain("restored after /tree");
    expect(tail(requests[0])).toContain(kept);
    expect(tail(requests[0])).not.toContain(abandoned);
    // The abandoned agent is still alive in this runtime, but not on this branch.
    expect(lastResult(requests[1], "subagent_get")).toContain(
      `Agent not found: \\"${abandoned}\\"`,
    );
    const listed = lastResult(requests[2], "subagent_get");
    expect(listed).toContain(kept);
    expect(listed).not.toContain(abandoned);
    expect(cards(requests[2])).toBe(0);
  }, 30_000);

  it("shows no card after /tree to before the first spawn", async () => {
    const h = await parent();
    h.faux.setResponses([fauxAssistantMessage("hello")]);
    await h.session.prompt("Hi");
    const target = h.manager.getLeafId()!;
    h.faux.setResponses([spawn("Later"), fauxAssistantMessage("done"), fauxAssistantMessage("ok")]);
    await h.session.prompt("Spawn");
    await h.session.navigateTree(target, { summarize: false });
    const requests: Context[] = [];
    h.faux.setResponses([capture(requests, fauxAssistantMessage("fine"))]);
    await h.session.prompt("Again");
    expect(requests).toHaveLength(1);
    expect(cards(requests[0])).toBe(0);
  }, 30_000);

  it("ends each request after compaction with the card, sent once", async () => {
    const h = await parent();
    h.faux.setResponses([
      spawn("Index repo"),
      fauxAssistantMessage("indexed"),
      fauxAssistantMessage("one"),
    ]);
    await h.session.prompt("Delegate");
    h.faux.setResponses([fauxAssistantMessage("more")]);
    await h.session.prompt("More work");
    const [id] = spawnedIds(h.manager);
    h.faux.setResponses([
      fauxAssistantMessage("Compacted summary"),
      fauxAssistantMessage("Prefix"),
    ]);
    await h.session.compact();

    const requests: Context[] = [];
    h.faux.setResponses([
      capture(requests, fauxAssistantMessage("Noted.")),
      capture(requests, fauxAssistantMessage("Still noted.")),
    ]);
    await h.session.prompt("After compaction");
    // Still due: no list result has arrived since the compaction.
    await h.session.prompt("And again");
    expect(requests.map(cards)).toEqual([1, 1]);
    expect(tail(requests[0])).toContain("restored after compaction");
    expect(tail(requests[0])).toContain(`${id} general-purpose \\"Index repo\\": completed`);
    expect(JSON.stringify(h.manager.getEntries())).not.toContain(CARD);
  }, 30_000);

  it("loads a session written before records carried the new fields", async () => {
    const manager = SessionManager.inMemory(dir);
    manager.appendMessage({ role: "user", content: "earlier", timestamp: 1 });
    // As the previous release wrote it: terminal only, no question/model/cwd fields.
    manager.appendCustomEntry(SUBAGENT_RECORD_ENTRY, {
      id: "old-agent",
      type: "Explore",
      description: "Old run",
      status: "completed",
      result: "Old result.",
      startedAt: 1_000,
      completedAt: 2_000,
      outputFile: "/tasks/old-agent.jsonl",
      toolUses: 3,
    });
    // Older still: before toolUses, which readers skip.
    manager.appendCustomEntry(SUBAGENT_RECORD_ENTRY, {
      id: "ancient-agent",
      type: "Explore",
      description: "Ancient run",
      status: "completed",
      startedAt: 500,
    });
    const h = await parent(manager);
    const requests: Context[] = [];
    h.faux.setResponses([
      capture(requests, call("subagent_get", { agent_id: "old-agent" })),
      capture(requests, fauxAssistantMessage("ok")),
    ]);
    await h.session.prompt("Status?");
    expect(requests).toHaveLength(2);
    expect(tail(requests[0])).toContain("restored after resume");
    expect(tail(requests[0])).toContain('old-agent Explore \\"Old run\\": completed');
    expect(tail(requests[0])).not.toContain("ancient-agent");
    const report = lastResult(requests[1], "subagent_get");
    expect(report).toContain("Old result.");
    expect(report).toContain("Full transcript available at: /tasks/old-agent.jsonl");
    expect(h.errors).not.toHaveBeenCalled();
  }, 30_000);
});
