import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { createChildLifecyclePublisher } from "#src/lifecycle/child-lifecycle";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { buildAgentPrompt } from "#src/session/prompts";

// Real SDK children with the repository's pi-stash extension loaded, as a
// parent bundle would provide it. Checks capability, not model judgment.
let dir: string;
let previousAgentDir: string | undefined;
let previousStashDir: string | undefined;
let offline: ReturnType<typeof vi.spyOn>;
const disposers: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stash-subagent-sdk-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  previousStashDir = process.env.PI_STASH_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_STASH_DIR = join(dir, "stash");
  const createRuntime = ModelRuntime.create.bind(ModelRuntime);
  offline = vi
    .spyOn(ModelRuntime, "create")
    .mockImplementation((options) => createRuntime({ ...options, refreshOnCreate: false }));
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      extensions: [resolve(import.meta.dirname, "../../pi-stash/src/index.ts")],
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  offline.mockRestore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousStashDir === undefined) delete process.env.PI_STASH_DIR;
  else process.env.PI_STASH_DIR = previousStashDir;
  rmSync(dir, { recursive: true, force: true });
});

async function child(type: "Explore" | "Plan") {
  const faux = createFauxCore({ provider: "stash-subagent-test", models: [{ id: "worker" }] });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "cache"),
  });
  runtime.registerProvider("stash-subagent-test", {
    api: faux.api,
    apiKey: "test-key",
    models: faux.models,
    streamSimple: faux.streamSimple,
  });
  const parentTools = [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "stash_put",
    "stash_get",
    "stash_list",
  ];
  const session = await createSubagentSession(
    {
      type,
      model: faux.getModel(),
      snapshot: {
        cwd: dir,
        systemPrompt: "PROJECT BASE",
        model: faux.getModel(),
        modelRegistry: new ModelRegistry(runtime),
      },
    },
    {
      registry: new AgentTypeRegistry(() => new Map()),
      exec: vi.fn(),
      lifecycle: createChildLifecyclePublisher(() => {}),
      resolvePromptInheritance: () => "full",
      listParentToolNames: () => parentTools,
      io: {
        detectEnv: async () => ({ isGitRepo: false, branch: "", platform: "linux" }),
        getAgentDir: () => dir,
        deriveSessionDir: () => join(dir, "sessions"),
        createSessionManager: (cwd, sessionDir) => SessionManager.create(cwd, sessionDir),
        createSettingsManager: (cwd, agentDir) => SettingsManager.create(cwd, agentDir),
        createLoaderSettingsManager: (settings) => settings,
        createResourceLoader: (options) =>
          new DefaultResourceLoader({ ...options, noSkills: true }),
        createSession: async ({
          sessionManager,
          resourceLoader,
          modelRegistry: _registry,
          ...rest
        }) =>
          createAgentSession({
            ...rest,
            sessionManager: sessionManager as SessionManager,
            resourceLoader: resourceLoader as ResourceLoader,
            modelRuntime: runtime,
          }),
        assemblerIO: { buildAgentPrompt, loadProjectContext: () => undefined },
      },
    },
  );
  disposers.push(() => session.dispose());
  return { session, faux };
}

const results = (session: Awaited<ReturnType<typeof child>>["session"], name: string) =>
  session.session.messages.flatMap((message) =>
    message.role === "toolResult" && message.toolName === name ? [message] : [],
  );

it("Explore can stash large findings and read them back by handle", async () => {
  const { session, faux } = await child("Explore");
  expect(session.session.getActiveToolNames()).toEqual(
    expect.arrayContaining(["read", "stash_put", "stash_get", "stash_list"]),
  );
  expect(session.session.getActiveToolNames()).not.toContain("write");
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("stash_put", { name: "findings", content: "a.ts:1\nb.ts:2\n" }),
    ),
    (context) => {
      const receipt = JSON.stringify(context.messages.at(-1));
      const handle = /stash:findings@[0-9a-f]{12}/.exec(receipt)?.[0];
      expect(handle).toBeTruthy();
      return fauxAssistantMessage(fauxToolCall("stash_get", { ref: handle! }));
    },
    fauxAssistantMessage("Findings stored."),
  ]);
  const result = await session.runTurnLoop("Find usages.", {});
  expect(result.responseText).toContain("Findings stored.");
  expect(results(session, "stash_put")[0]).toMatchObject({ isError: false });
  expect(results(session, "stash_get")[0]).toMatchObject({
    isError: false,
    content: [{ text: expect.stringContaining("2\tb.ts:2") }],
  });
}, 20_000);

it("Plan can read the stash but cannot write to it", async () => {
  const { session, faux } = await child("Plan");
  const active = session.session.getActiveToolNames();
  expect(active).toEqual(expect.arrayContaining(["stash_get", "stash_list"]));
  expect(active).not.toContain("stash_put");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("stash_put", { name: "plan", content: "x" })),
    fauxAssistantMessage("Could not stash."),
  ]);
  await session.runTurnLoop("Plan it.", {});
  const [attempt] = results(session, "stash_put");
  expect(attempt?.isError).toBe(true);
}, 20_000);
