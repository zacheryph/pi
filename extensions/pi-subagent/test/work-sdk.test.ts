import { copyFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { service } from "../../../packages/pi-session-tree/src/index.ts";
import { messageText, toolCall } from "../../../packages/pi-test-helpers/src/faux-session.ts";
import { resetSessionTree } from "../../../packages/pi-test-helpers/src/globals.ts";
import {
  WORK_ENTRY,
  WORK_LOST,
  WORK_SERVICE,
  type WorkHost,
} from "../../../packages/pi-work/src/index.ts";
import {
  delegate,
  gated,
  sendCall,
  startParent,
  untilAnnounced,
  type Parent,
} from "./characterization/harness.ts";
import { offlineAgentDir } from "./helpers/sdk.ts";

// pi-subagent as a work producer, on a real parent session: each run is an item in the parent's
// work host, completed with the completion message. The host writes the messages into the
// transcript, wakes an idle parent and answers a running one in the same run.

afterEach(resetSessionTree);

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/** The parent's work host. */
const hostOf = (h: Parent) => service<WorkHost>(h.manager.getSessionId(), WORK_SERVICE)!;

/**
 * What the work host and this extension wrote to the branch, oldest first: `open`, `close:<reason>`,
 * and `message:<customType>` for the subagent messages.
 */
function trail(h: Parent): string[] {
  return h.manager.getBranch().flatMap((entry) => {
    if (entry.type === "custom_message" && entry.customType.startsWith("subagent:"))
      return [`message:${entry.customType}`];
    if (entry.type === "custom" && entry.customType === WORK_ENTRY) {
      const data = entry.data as { op: string; reason?: string };
      return [data.op === "open" ? "open" : `close:${data.reason}`];
    }
    return [];
  });
}

const lastRequest = (h: Parent) => messageText(h.requests.parent.at(-1)!.messages.at(-1));

describe("a spawned agent is an item in the spawner's work host", () => {
  it("opens it at spawn, and completing it wakes an idle parent", async () => {
    const h = await startParent();
    const child = gated(fauxAssistantMessage("Did the work."));
    h.script({
      parent: [
        delegate("Audit parser"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Noted."),
      ],
      child: [child.step],
    });

    await h.session.prompt("Delegate");
    await child.started;

    const [id] = h.agentIds();
    expect(hostOf(h).list()).toMatchObject([
      {
        owner: "pi-subagent",
        kind: "subagent",
        label: `Audit parser (general-purpose agent ${id})`,
        data: { agentId: id, type: "general-purpose", description: "Audit parser" },
      },
    ]);
    expect(h.requests.parent).toHaveLength(2);

    child.release();
    await vi.waitFor(() => expect(h.requests.parent).toHaveLength(3), { timeout: 15_000 });
    await vi.waitFor(() => expect(hostOf(h).list()).toEqual([]));

    // The woken run has the completion as its trigger.
    expect(lastRequest(h)).toContain("<task-notification>");
    expect(lastRequest(h)).toContain("Did the work.");
    // The close record comes after the message it promises, never before.
    expect(trail(h)).toEqual(["open", "message:subagent:completion", "close:completed"]);
    expect(h.announcements()).toHaveLength(1);
    expect(h.errors).toEqual([]);
  }, 30_000);

  it("answers a completion that arrives during a run in that same run", async () => {
    const h = await startParent();
    const parentBusy = gated(fauxAssistantMessage("Still on it."));
    h.script({
      parent: [delegate("Work"), parentBusy.step, fauxAssistantMessage("Saw the completion.")],
      child: [fauxAssistantMessage("Did the work.")],
    });

    const run = h.session.prompt("Delegate");
    await parentBusy.started;
    // The child finishes while the parent's run is active: the item is completed...
    await vi.waitFor(() => expect(hostOf(h).list()).toEqual([]), { timeout: 15_000 });
    // ...and Pi holds the message until the turn ends, so nothing is closed yet.
    expect(h.announcements()).toHaveLength(0);
    expect(trail(h)).toEqual(["open"]);

    parentBusy.release();
    await run;

    // One more request in the same run, which saw the completion. Nothing woke a second run.
    expect(h.requests.parent).toHaveLength(3);
    expect(lastRequest(h)).toContain("<task-notification>");
    await settle();
    expect(h.requests.parent).toHaveLength(3);
    expect(trail(h)).toEqual(["open", "message:subagent:completion", "close:completed"]);
    expect(h.errors).toEqual([]);
  }, 30_000);

  it("delivers a parent_notify update through the item without closing it", async () => {
    const h = await startParent();
    const rest = gated(fauxAssistantMessage("Did the work."));
    h.script({
      parent: [
        delegate("Work"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Saw the update."),
        fauxAssistantMessage("Saw the completion."),
      ],
      child: [toolCall("parent_notify", { message: "The premise is wrong." }), rest.step],
    });

    await h.session.prompt("Delegate");
    await vi.waitFor(() => expect(h.requests.parent).toHaveLength(3), { timeout: 15_000 });
    await rest.started;
    await vi.waitFor(() => expect(h.session.isIdle).toBe(true));

    const [id] = h.agentIds();
    expect(lastRequest(h)).toContain("<subagent-update>");
    expect(lastRequest(h)).toContain("The premise is wrong.");
    expect(lastRequest(h)).toContain(`subagent_send("${id}", "...")`);
    expect(hostOf(h).list()).toHaveLength(1); // the agent is still running
    expect(closes(h)).toEqual([]);
    expect(h.announcements("subagent:update")).toHaveLength(1);

    rest.release();
    await untilAnnounced(h);
    await vi.waitFor(() => expect(h.requests.parent).toHaveLength(4), { timeout: 15_000 });
    // The update was delivered by its own message, so the completion does not repeat it.
    expect(h.announcements()[0].text).not.toContain("Updates this agent sent while it worked");
    expect(hostOf(h).list()).toEqual([]);
    expect(h.errors).toEqual([]);
  }, 30_000);

  it("cancels the item when the agent is stopped, and still says so", async () => {
    const h = await startParent();
    const child = gated();
    const parentBusy = gated();
    h.script({
      parent: [delegate("Work"), parentBusy.step, fauxAssistantMessage("Interrupted.")],
      child: [child.step],
    });

    const run = h.session.prompt("Delegate");
    await Promise.all([child.started, parentBusy.started]);
    await h.session.abort(); // ESC stops the parent's agents
    await run.catch(() => {});
    await untilAnnounced(h);
    await vi.waitFor(() => expect(closes(h)).toHaveLength(1));

    expect(h.announcements()[0].text).toContain("<status>Stopped (user request)</status>");
    expect(closes(h)).toEqual(["cancelled"]);
    expect(hostOf(h).list()).toEqual([]);
    // Stopped, not completed: the message is delivered and the item is cancelled.
    expect(trail(h).filter((entry) => entry !== "open")).toContain("close:cancelled");
    expect(trail(h)).not.toContain("close:completed");
    // The stopped child winds down after the parent's run settled, so the message wakes it,
    // as the completion nudge did before.
    await vi.waitFor(() => expect(h.requests.parent).toHaveLength(3));
    expect(lastRequest(h)).toContain("Stopped (user request)");
  }, 30_000);

  it("opens a new item for new input to the agent", async () => {
    const h = await startParent();
    const second = gated(fauxAssistantMessage("Did more."));
    h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started."), fauxAssistantMessage("Noted.")],
      child: [fauxAssistantMessage("Did the work.")],
    });
    await h.session.prompt("Delegate");
    await untilAnnounced(h);
    await vi.waitFor(() => expect(h.requests.parent).toHaveLength(3));
    await vi.waitFor(() => expect(h.session.isIdle).toBe(true));
    const [id] = h.agentIds();
    expect(hostOf(h).list()).toEqual([]);

    h.script({
      parent: [
        sendCall(id, "Go on"),
        fauxAssistantMessage("Sent."),
        fauxAssistantMessage("Noted."),
      ],
      child: [second.step],
    });
    await h.session.prompt("More");
    await second.started;

    // The earlier item is closed; the new run holds a new one for the same agent.
    expect(hostOf(h).list()).toMatchObject([{ kind: "subagent", data: { agentId: id } }]);
    expect(trail(h)).toEqual(["open", "message:subagent:completion", "close:completed", "open"]);

    second.release();
    await untilAnnounced(h, 2);
    await vi.waitFor(() => expect(hostOf(h).list()).toEqual([]));
    expect(trail(h)).toEqual([
      "open",
      "message:subagent:completion",
      "close:completed",
      "open",
      "message:subagent:completion",
      "close:completed",
    ]);
    expect(h.errors).toEqual([]);
  }, 30_000);
});

/** The reasons of the work close records on the parent's branch. */
function closes(h: Parent): string[] {
  return trail(h)
    .filter((entry) => entry.startsWith("close:"))
    .map((entry) => entry.slice("close:".length));
}

describe("after a restart", () => {
  it("reports an agent that was still running as lost work, naming it", async () => {
    const dir = offlineAgentDir();
    const manager = SessionManager.create(dir, dir);
    const first = await startParent({ dir, manager });
    const child = gated();
    first.script({
      parent: [delegate("Audit parser"), fauxAssistantMessage("Started.")],
      child: [child.step],
    });
    await first.session.prompt("Delegate");
    await child.started;
    const [id] = first.agentIds();
    expect(hostOf(first).list()).toHaveLength(1);

    // The process dies here: what is on disk now is all the next one has.
    const crashed = `${manager.getSessionFile()!}.crashed`;
    copyFileSync(manager.getSessionFile()!, crashed);
    child.release();
    first.session.dispose();
    resetSessionTree();

    const second = await startParent({
      dir,
      manager: SessionManager.open(crashed, undefined, dir),
    });
    await settle();

    // Nothing woke, nothing restarted, and the item is closed as lost.
    expect(second.requests.parent).toHaveLength(0);
    expect(hostOf(second).list()).toEqual([]);
    expect(closes(second)).toEqual(["lost"]);
    const lost = second.manager
      .getBranch()
      .filter((entry) => entry.type === "custom_message" && entry.customType === WORK_LOST);
    expect(lost).toHaveLength(1);
    const text = JSON.stringify(lost[0].type === "custom_message" ? lost[0].content : "");
    expect(text).toContain("Work lost: 1 item");
    expect(text).toContain(`subagent \\"Audit parser (general-purpose agent ${id})\\"`);
    expect(text).toContain("pi-subagent");
    expect(lost[0].type === "custom_message" && lost[0].details).toMatchObject({
      items: [{ owner: "pi-subagent", kind: "subagent" }],
    });

    // The model learns of it on its next run, and the agent can be given more work.
    second.script({
      parent: [
        sendCall(id, "Pick it up"),
        fauxAssistantMessage("Sent."),
        fauxAssistantMessage("Done."),
      ],
      child: [fauxAssistantMessage("Picked it up.")],
    });
    await second.session.prompt("What happened?");
    expect(JSON.stringify(second.requests.parent[0].messages)).toContain("Work lost: 1 item");
    await untilAnnounced(second);
    expect(second.errors).toEqual([]);
  }, 30_000);
});
