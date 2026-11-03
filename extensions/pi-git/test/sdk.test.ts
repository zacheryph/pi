import { join } from "node:path";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  type EventBus,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_TREE_KEY } from "../../../packages/pi-session-tree/src/index.ts";
import { GIT_SNAPSHOT_EVENT, type GitSnapshotEvent } from "../src/events.ts";
import piGit from "../src/index.ts";
import { foldLedger } from "../src/ledger.ts";
import { sandbox, type Sandbox } from "./support/repos.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global in tests
  delete (globalThis as Record<symbol, unknown>)[SESSION_TREE_KEY];
});

async function fixture(box: Sandbox, manager: SessionManager) {
  const snapshots: GitSnapshotEvent[] = [];
  let bus: EventBus | undefined;
  const faux = createFauxCore({ provider: "git-test", models: [{ id: "test" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(box.dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(box.dir, "cache"),
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("git-test", {
    api: faux.api,
    apiKey: "test-key",
    models: faux.models,
    streamSimple: faux.streamSimple,
  });
  const loader = new DefaultResourceLoader({
    cwd: box.dir,
    agentDir: box.dir,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => piGit(pi, { loadConfig: () => ({ worktreeRoot: box.root }) }),
      // Another extension on the same session bus, as pi-dashboard listens.
      (pi) => {
        bus = pi.events;
        pi.events.on(GIT_SNAPSHOT_EVENT, (data) => snapshots.push(data as GitSnapshotEvent));
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: box.dir,
    agentDir: box.dir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    tools: ["git_worktree_create", "git_worktree_list", "git_worktree_remove"],
  });
  cleanups.push(() => session.dispose());
  await session.bindExtensions({ mode: "print" });
  return { session, faux, snapshots, bus: bus! };
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

const toolText = (manager: SessionManager, name: string) =>
  manager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolName === name
        ? [JSON.stringify(entry.message.content)]
        : [],
    );

describe("pi-git in a real AgentSession (offline faux provider)", () => {
  it("keeps worktrees and the subagents that used them across a resume", async () => {
    const box = sandbox();
    cleanups.push(() => box.cleanup());
    const manager = SessionManager.inMemory(box.dir);
    const api = join(box.root, "multi", "api");
    const web = join(box.root, "multi", "web");

    const first = await fixture(box, manager);
    first.faux.setResponses([
      call("git_worktree_create", { repo: "src/api", branch: "feat/multi", workspace: "multi" }),
      call("git_worktree_create", { repo: "src/web", branch: "feat/multi", workspace: "multi" }),
      fauxAssistantMessage("Created."),
    ]);
    await first.session.prompt("Prepare a workspace across api and web.");
    expect(toolText(manager, "git_worktree_create").join("\n")).toContain(
      `subagent_start and cwd: \\"${join(box.root, "multi")}\\"`,
    );
    // pi-subagent announces a child started in the workspace on the parent's bus.
    first.bus.emit("subagent:session:created", {
      sessionId: "child-1",
      agentId: "agent-1",
      cwd: join(box.root, "multi"),
    });
    expect(first.snapshots.at(-1)?.worktrees.map((w) => [w.path, w.agents])).toEqual([
      [web, ["agent-1"]],
      [api, ["agent-1"]],
    ]);
    first.session.dispose();

    // Resume: a new session on the same session file.
    const resumed = await fixture(box, manager);
    expect(resumed.snapshots[0].worktrees.map((w) => w.path)).toEqual([web, api]);
    resumed.faux.setResponses([call("git_worktree_list", {}), fauxAssistantMessage("Listed.")]);
    await resumed.session.prompt("Which worktrees do we have?");
    const listed = toolText(manager, "git_worktree_list").at(-1)!;
    expect(listed).toContain(`- ${web}`);
    expect(listed).toContain(`- ${api}`);
    expect(listed).toContain("api @ feat/multi [workspace multi] — clean");
    expect(listed).toContain("agents: agent-1");

    const ledger = foldLedger(manager.getEntries());
    expect([...ledger.keys()]).toEqual([api, web]);
  }, 30_000);
});
