import { join } from "node:path";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  type EventBus,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_TREE_KEY } from "../../../packages/pi-session-tree/src/index.ts";
import { GIT_SNAPSHOT_EVENT, type GitSnapshotEvent } from "../src/events.ts";
import piGit from "../src/index.ts";
import { foldLedger } from "../src/fold.ts";
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
      (pi) => piGit(pi, { loadConfig: () => ({ worktreeRoot: box.root, trackReferenced: true }) }),
      // Stands in for the GitHub MCP server's tool: same name, same result shape.
      (pi) =>
        pi.registerTool(
          defineTool({
            name: "mcp__github__create_pull_request",
            label: "Create PR",
            description: "Create a pull request.",
            parameters: Type.Object({
              owner: Type.String(),
              repo: Type.String(),
              title: Type.String(),
            }),
            async execute(_id, params) {
              return {
                content: [
                  {
                    type: "text",
                    text: `{"id":"1","url":"https://github.com/${params.owner}/${params.repo}/pull/66"}`,
                  },
                ],
                details: {},
              };
            },
          }),
        ),
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
    tools: [
      "git_worktree_create",
      "git_worktree_list",
      "git_worktree_remove",
      "git_pr_list",
      "mcp__github__create_pull_request",
    ],
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
    expect([...ledger.worktrees.keys()]).toEqual([api, web]);
  }, 30_000);

  it("records a PR a tool opened and lists it after a resume", async () => {
    const box = sandbox();
    cleanups.push(() => box.cleanup());
    const manager = SessionManager.inMemory(box.dir);

    const first = await fixture(box, manager);
    first.faux.setResponses([
      call("mcp__github__create_pull_request", { owner: "acme", repo: "api", title: "Add login" }),
      fauxAssistantMessage("Opened."),
    ]);
    await first.session.prompt("Open the PR.");
    expect(first.snapshots.at(-1)?.prs).toEqual([
      expect.objectContaining({
        key: "github.com/acme/api#66",
        origin: "created",
        status: expect.objectContaining({
          state: "open",
          source: "mcp__github__create_pull_request",
        }),
      }),
    ]);
    first.session.dispose();

    const resumed = await fixture(box, manager);
    expect(resumed.snapshots[0].prs.map((pr) => pr.key)).toEqual(["github.com/acme/api#66"]);
    resumed.faux.setResponses([call("git_pr_list", {}), fauxAssistantMessage("Listed.")]);
    await resumed.session.prompt("Which PRs did we open?");
    const listed = toolText(manager, "git_pr_list").at(-1)!;
    expect(listed).toContain("Opened here:");
    expect(listed).toContain("acme/api#66");
    expect([...foldLedger(manager.getEntries()).prs.keys()]).toEqual(["github.com/acme/api#66"]);
  }, 30_000);
});
