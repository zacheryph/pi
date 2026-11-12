import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { defineTool, type EventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import {
  fauxSession,
  toolCall as call,
  toolResults,
  type FauxRequest,
  resetSessionTree,
} from "#test-helpers";
import { GIT_SNAPSHOT_EVENT, type GitSnapshotEvent } from "#src/events";
import piGit from "#src/index";
import { GhUnavailable } from "#src/status";
import { foldLedger } from "#src/fold";
import { sandbox, type Sandbox } from "#test/support/repos";

afterEach(resetSessionTree);

async function fixture(
  box: Sandbox,
  manager: SessionManager,
  options: { keepRecentTokens?: number } = {},
) {
  const snapshots: GitSnapshotEvent[] = [];
  let bus: EventBus | undefined;
  const h = await fauxSession({
    cleanup: onTestFinished,
    dir: box.dir,
    provider: "git-test",
    sessionManager: manager,
    settings: { compaction: { enabled: false, keepRecentTokens: options.keepRecentTokens } },
    tools: [
      "git_worktree_create",
      "git_worktree_list",
      "git_worktree_remove",
      "git_pr_list",
      "git_pr_status",
      "mcp__github__create_pull_request",
      "mcp__github__pull_request_read",
    ],
    extensions: [
      (pi) =>
        piGit(pi, {
          loadConfig: () => ({
            worktreeRoot: box.root,
            trackReferenced: true,
            watchIntervalSeconds: 60,
          }),
          // As on a machine without gh: git_pr_status must read through the MCP tool.
          runGh: async () => {
            throw new GhUnavailable("gh is not installed");
          },
        }),
      // Stands in for the GitHub MCP server's PR reader.
      (pi) =>
        pi.registerTool(
          defineTool({
            name: "mcp__github__pull_request_read",
            label: "Read PR",
            description: "Read a pull request.",
            parameters: Type.Object({
              method: Type.String(),
              owner: Type.String(),
              repo: Type.String(),
              pullNumber: Type.Number(),
              page: Type.Optional(Type.Number()),
              perPage: Type.Optional(Type.Number()),
            }),
            annotations: { readOnlyHint: true },
            async execute(_id, params) {
              const text =
                params.method === "get"
                  ? JSON.stringify({
                      number: params.pullNumber,
                      html_url: `https://github.com/${params.owner}/${params.repo}/pull/${params.pullNumber}`,
                      title: "Add login",
                      state: "open",
                      draft: false,
                      head: { ref: "feat/login", sha: "abc123" },
                    })
                  : params.method === "get_check_runs"
                    ? JSON.stringify({
                        check_runs: [{ status: "completed", conclusion: "success" }],
                      })
                    : params.method === "get_status"
                      ? JSON.stringify({
                          state: "pending",
                          sha: "abc123",
                          total_count: 0,
                          statuses: [],
                        })
                      : JSON.stringify([
                          { user: { login: "a" }, state: "APPROVED", submitted_at: "1" },
                        ]);
              return { content: [{ type: "text", text }], details: {} };
            },
          }),
        ),
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
  return { ...h, snapshots, bus: bus! };
}

const toolText = (manager: SessionManager, name: string) =>
  toolResults(manager, name).map((result) => JSON.stringify(result.content));

const CARD = "Pull requests and worktrees in this session";
/** The messages of each model request made so far, as the provider got them. */
const messages = (requests: FauxRequest[]) => requests.map((request) => request.messages);
const cardCount = (messages: unknown[]) =>
  messages.filter((message) => JSON.stringify(message).includes(CARD)).length;

describe("pi-git in a real AgentSession (offline faux provider)", () => {
  it("restores PRs and worktrees with a context card after compaction, until a list result", async () => {
    const box = sandbox(onTestFinished);
    const manager = SessionManager.inMemory(box.dir);
    const worktree = join(box.root, "api", "feat-login");

    const h = await fixture(box, manager, { keepRecentTokens: 1 });
    h.faux.setResponses([
      call("git_worktree_create", { repo: "src/api", branch: "feat/login" }),
      call("mcp__github__create_pull_request", { owner: "acme", repo: "api", title: "Add login" }),
      fauxAssistantMessage("Opened."),
    ]);
    await h.session.prompt("Open the PR.");
    h.bus.emit("subagent:session:created", { agentId: "agent-1", cwd: worktree });
    h.faux.setResponses([fauxAssistantMessage("More.")]);
    await h.session.prompt("More work.");
    expect(messages(h.requests).map(cardCount)).toEqual([0, 0, 0, 0]);

    h.faux.setResponses([
      fauxAssistantMessage("Compacted summary"),
      fauxAssistantMessage("Prefix summary"),
    ]);
    await h.session.compact();

    h.requests.length = 0;
    h.faux.setResponses([
      fauxAssistantMessage("Still here."),
      call("git_pr_list", {}),
      fauxAssistantMessage("Listed."),
    ]);
    await h.session.prompt("After compaction.");
    await h.session.prompt("Which PRs?");
    const [first, withList, afterList] = messages(h.requests);
    // Once per request, as its last message, on each request until the list result.
    expect(cardCount(first)).toBe(1);
    expect(cardCount(withList)).toBe(1);
    const card = JSON.stringify(first.at(-1));
    expect(card).toContain(CARD);
    expect(card).toContain("github.com/acme/api PR 66: open");
    expect(card).toContain(`worktree ${worktree} on feat/login: no PR yet (agent agent-1)`);
    expect(JSON.stringify(withList.at(-1))).toContain(CARD);
    expect(cardCount(afterList)).toBe(0);
    // Context-only: never written to the transcript.
    expect(JSON.stringify(manager.getEntries())).not.toContain(CARD);

    h.requests.length = 0;
    h.faux.setResponses([fauxAssistantMessage("No card.")]);
    await h.session.prompt("And now?");
    expect(messages(h.requests).map(cardCount)).toEqual([0]);

    // /tree brings it back.
    const target = manager.getBranch().find((entry) => entry.type === "message")!;
    await h.session.navigateTree(target.id);
    h.requests.length = 0;
    h.faux.setResponses([fauxAssistantMessage("Card again.")]);
    await h.session.prompt("After /tree.");
    expect(messages(h.requests).map(cardCount)).toEqual([1]);
    h.session.dispose();

    // A reload does too: a new session on the same session file.
    const reloaded = await fixture(box, manager);
    reloaded.faux.setResponses([fauxAssistantMessage("Card again.")]);
    await reloaded.session.prompt("After reload.");
    const [afterReload] = messages(reloaded.requests);
    expect(cardCount(afterReload)).toBe(1);
    expect(JSON.stringify(afterReload.at(-1))).toContain(CARD);
  }, 30_000);

  it("gives a session with no ledger entries no card, even after compaction", async () => {
    const box = sandbox(onTestFinished);
    const manager = SessionManager.inMemory(box.dir);
    const h = await fixture(box, manager, { keepRecentTokens: 1 });
    h.faux.setResponses([fauxAssistantMessage("One.")]);
    await h.session.prompt("Work.");
    h.faux.setResponses([fauxAssistantMessage("Two.")]);
    await h.session.prompt("More work.");
    h.faux.setResponses([
      fauxAssistantMessage("Compacted summary"),
      fauxAssistantMessage("Prefix summary"),
    ]);
    await h.session.compact();
    h.faux.setResponses([fauxAssistantMessage("Three.")]);
    await h.session.prompt("After compaction.");
    expect(messages(h.requests).filter((messages) => cardCount(messages) > 0)).toEqual([]);
  }, 30_000);

  it("keeps worktrees and the subagents that used them across a resume", async () => {
    const box = sandbox(onTestFinished);
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
    const box = sandbox(onTestFinished);
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

  it("reads a PR through the GitHub MCP tool when gh is missing, recording it once", async () => {
    const box = sandbox(onTestFinished);
    const manager = SessionManager.inMemory(box.dir);
    const h = await fixture(box, manager);
    h.faux.setResponses([
      call("git_pr_status", { pr: "https://github.com/acme/api/pull/12" }),
      fauxAssistantMessage("Read."),
    ]);
    await h.session.prompt("How is the PR doing?");
    const [text] = toolText(manager, "git_pr_status");
    expect(text).toContain("acme/api#12 — Add login");
    expect(text).toContain(
      "open · approved · checks 1 passed · head abc123 (via mcp__github__pull_request_read)",
    );
    // Pi fired tool_result for each nested MCP read; only git_pr_status's own record counts.
    const entries = manager
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "custom" && (entry.data as { kind?: string } | undefined)?.kind === "pr",
      );
    expect(entries).toHaveLength(1);
    expect(foldLedger(manager.getEntries()).prs.get("github.com/acme/api#12")).toMatchObject({
      origin: "referenced",
      status: { state: "open", review: "approved", source: "mcp__github__pull_request_read" },
      calls: [{ tool: "git_pr_status" }],
    });
  }, 30_000);
});
