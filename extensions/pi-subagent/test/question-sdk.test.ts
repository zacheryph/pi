import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { WORK_WAKE_PROMPT } from "#src/lifecycle/run";
import { toolCall } from "../../../packages/pi-test-helpers/src/faux-session.ts";
import { resetSessionTree } from "../../../packages/pi-test-helpers/src/globals.ts";
import { createJobsExtension } from "../../pi-job/src/extension.ts";
import { delegate, sendCall, startParent, untilAnnounced } from "./characterization/harness.ts";
import { expectNoUnmanagedRuns, trackChildRuns } from "./helpers/managed-runs.ts";
import { EXTENSIONS, offlineAgentDir, realChildDeps } from "./helpers/sdk.ts";
import { widgetUi } from "./helpers/widget-ui.ts";

// Roadmap step 10 on real sessions: a child's `ask` is an item in the child's work host. The child
// ends its turn (the tool terminates it) and is idle and waiting; the parent hears the question
// once, through the agent's item; its `subagent_send` is the answer, closes the question item and
// is the prompt of the run the limiter gives the child. The question holds the child's session,
// and survives a reload or restart because pi-ask adopts it.

afterEach(resetSessionTree);

/** The parent loads pi-job too, so its children inherit `job_watch` as they would for a user. */
const parentJobs = createJobsExtension({
  logRoot: join(tmpdir(), "pi-subagent-test-jobs"),
  minIntervalSeconds: 0.1,
});

const QUESTION = {
  questions: [
    {
      question: "Which database?",
      header: "Storage",
      options: [{ label: "Postgres" }, { label: "SQLite" }],
    },
  ],
};
const ask = () => toolCall("ask", QUESTION);

/** A child's `job_watch` call: runs until `gate` exists. */
const watch = (gate: string, label = "CI") =>
  toolCall("job_watch", {
    check: `test -f '${gate}'`,
    intervalSeconds: 0.1,
    timeoutSeconds: 30,
    label,
  });

async function parentForQuestions() {
  const runs = trackChildRuns();
  const dir = offlineAgentDir({ extensions: [EXTENSIONS.ask, EXTENSIONS.fastJobs] });
  const ui = widgetUi();
  const h = await startParent({
    dir,
    extensions: [parentJobs],
    tools: ["job_start", "job_watch"],
    bind: { uiContext: ui.uiContext },
  });
  return { h, dir, ui, runs, gate: join(dir, "ci-finished") };
}

/** What the work host and the model left in a child's transcript, oldest first. */
function trace(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const entry = JSON.parse(line) as {
        type: string;
        customType?: string;
        data?: { op?: string; reason?: string; label?: string; kind?: string };
        message?: { role?: string };
      };
      if (entry.type === "custom_message") return [`message:${entry.customType}`];
      if (entry.type === "custom" && entry.customType === "work:item")
        return [
          entry.data?.op === "open"
            ? `open:${entry.data.kind}:${entry.data.label}`
            : `close:${entry.data?.reason}`,
        ];
      if (entry.type === "message" && entry.message?.role === "assistant") return ["assistant"];
      return [];
    });
}

const said = (request: Context): string => JSON.stringify(request.messages);
const lastUserText = (request: Context): string => {
  const message = request.messages.filter((m) => m.role === "user").at(-1);
  return JSON.stringify(message?.content);
};

describe("a child that asks its parent a question", () => {
  it("ends its turn idle and waiting; the parent hears it once; send answers it and wakes the child", async () => {
    const { h, ui, runs } = await parentForQuestions();
    const childRequests: Context[] = [];
    h.script({
      parent: [
        delegate("Pick storage"),
        fauxAssistantMessage("Started."),
        // Woken by the question message: answer it.
        (context) => {
          expect(said(context)).toContain("<subagent-question>");
          return sendCall(h.agentIds()[0], "Use Postgres.");
        },
        fauxAssistantMessage("Answered."),
        fauxAssistantMessage("Noted the result."),
      ],
      child: [
        ask(),
        (context) => {
          childRequests.push(structuredClone(context));
          return fauxAssistantMessage("Using Postgres. Done.");
        },
      ],
    });
    await h.session.prompt("Delegate storage");
    const [id] = h.agentIds();

    // The question reached the parent, once, as its own message with the exact answer call.
    await vi.waitFor(() => expect(h.announcements("subagent:question")).toHaveLength(1), {
      timeout: 15_000,
    });
    const question = h.announcements("subagent:question")[0];
    expect(question.text).toContain("<subagent-question>");
    expect(question.text).toContain("[Storage] Which database?");
    expect(question.text).toContain("a) Postgres");
    expect(question.text).toContain(`subagent_send with agent_id: "${id}"`);
    expect(question.details).toMatchObject({ id, question: expect.stringContaining("Postgres") });

    // The parent answered; the child was woken and saw the answer as its prompt.
    await untilAnnounced(h);
    await vi.waitFor(() => expect(h.requests.parent).toHaveLength(5), { timeout: 15_000 });
    expect(h.announcements("subagent:question")).toHaveLength(1); // never repeated
    expect(h.announcements()).toHaveLength(1);
    expect(h.announcements()[0].text).toContain("Using Postgres. Done.");
    // The ask call ended the child's turn: the request after it is the answer's run, not a
    // continuation of the first run (that would have seen the tool result as its last message).
    expect(h.requests.child).toHaveLength(2);
    expect(childRequests).toHaveLength(1);
    expect(lastUserText(childRequests[0])).toContain("Use Postgres.");
    expect(said(childRequests[0])).toContain("Your question was sent to the delegating agent");
    // The wake was the run's prompt alone: no work message, no wake prompt.
    expect(said(childRequests[0])).not.toContain(WORK_WAKE_PROMPT);

    // The question item was opened and closed in the child's own transcript, around the run.
    const transcript = h.savedRecord(id)!.outputFile!;
    expect(trace(transcript)).toEqual([
      "assistant", // the ask call: an assistant message with the tool call...
      "open:question:answer", // ...which opened the item when it ran
      "close:cancelled", // the answer closed it, with no message of its own
      "assistant", // the answered run's final message
    ]);
    expect(ui.text()).not.toContain("waiting");
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs); // the answer's run went through the agent and its limiter
  }, 40_000);

  it("is idle and waiting on `answer` while the parent has not answered, and keeps its session", async () => {
    const { h, ui, runs } = await parentForQuestions();
    h.script({
      parent: [
        delegate("Pick storage"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("I will answer later."),
      ],
      child: [ask()],
    });
    await h.session.prompt("Delegate storage");
    const [id] = h.agentIds();
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: answer"), { timeout: 15_000 });
    await vi.waitFor(() => expect(h.requests.parent).toHaveLength(3), { timeout: 15_000 });

    expect(ui.status()).toBe("1 waiting agent");
    expect(ui.text()).toContain("--:--"); // no clock runs for a waiting agent
    expect(h.seen("subagent:waiting")).toMatchObject([{ data: { id, reason: "answer" } }]);
    // The run ended with the tool call: the model was asked once, and not again.
    expect(h.requests.child).toHaveLength(1);
    // Not done: no completion, no failure, and the saved record is the waiting agent's.
    expect(h.announcements()).toEqual([]);
    expect(h.seen("subagent:completed")).toEqual([]);
    expect(h.savedRecord(id)).toMatchObject({ status: "idle", outcome: "completed" });
    expect(h.savedRecord(id)).not.toHaveProperty("pendingQuestion");

    // A day later the sweep still leaves it alone: the question holds its session.
    await h.sweepAfter(24 * 60);
    expect(h.seen("subagent:session:disposed")).toEqual([]);
    expect(trace(h.savedRecord(id)!.outputFile!)).toEqual(["assistant", "open:question:answer"]);

    // The roster says what it waits on.
    h.script({ parent: [toolCall("subagent_get", {}), fauxAssistantMessage("Seen.")] });
    await h.session.prompt("Who is waiting?");
    expect(h.lastResult(h.requests.parent[1], "subagent_get")).toContain(": waiting: answer");
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
  }, 40_000);

  it("with a watch also open: the watch's completion wakes it, the question stays open, and the answer closes only the question", async () => {
    const { h, ui, gate, runs } = await parentForQuestions();
    const childRequests: Context[] = [];
    h.script({
      parent: [
        delegate("Review CI and pick storage"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("I will answer once CI is in."),
      ],
      child: [
        watch(gate),
        ask(),
        (context) => {
          childRequests.push(structuredClone(context));
          return fauxAssistantMessage("CI is green; still waiting for the storage decision.");
        },
      ],
    });
    await h.session.prompt("Delegate");
    const [id] = h.agentIds();
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: CI, answer"), {
      timeout: 15_000,
    });
    expect(h.announcements("subagent:question")).toHaveLength(1);

    // The watch matches. The completion wakes the child through the limiter, with the question
    // still open: it sees the completion and its own unanswered ask.
    writeFileSync(gate, "");
    await vi.waitFor(() => expect(childRequests).toHaveLength(1), { timeout: 15_000 });
    expect(said(childRequests[0])).toContain("Watch j1 matched: CI");
    expect(said(childRequests[0])).toContain(WORK_WAKE_PROMPT);
    expect(said(childRequests[0])).toContain("Your question was sent to the delegating agent");
    // It answered the completion and went back to waiting, now only on the answer.
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: answer"), { timeout: 15_000 });
    expect(ui.text()).not.toContain("waiting: CI");
    expect(ui.status()).toBe("1 waiting agent");
    expect(h.announcements()).toEqual([]); // still not done
    expect(h.announcements("subagent:question")).toHaveLength(1); // the parent is not told again
    const transcript = h.savedRecord(id)!.outputFile!;
    const waiting = trace(transcript);
    expect(waiting.filter((e) => e.startsWith("open:"))).toEqual([
      "open:watch:CI",
      "open:question:answer",
    ]);
    expect(waiting.filter((e) => e.startsWith("close:"))).toEqual(["close:completed"]); // the watch

    // The parent answers: the question closes (and nothing else), and the child finishes.
    h.script({
      parent: [
        sendCall(id, "Use Postgres."),
        fauxAssistantMessage("Answered."),
        fauxAssistantMessage("Noted the result."),
      ],
      child: [fauxAssistantMessage("Using Postgres. Done.")],
    });
    await h.session.prompt("Now answer it");
    await untilAnnounced(h);
    expect(h.announcements()[0].text).toContain("Using Postgres. Done.");
    expect(trace(transcript).filter((e) => e.startsWith("close:"))).toEqual([
      "close:completed",
      "close:cancelled",
    ]);
    expect(ui.text()).not.toContain("waiting");
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
  }, 40_000);
});

describe("a question across a reload or restart", () => {
  /** The transcript of a child that asked and is waiting, copied while it was live: what a kill -9 leaves. */
  async function askedAndCrashed() {
    const { h, dir, ui } = await parentForQuestions();
    h.script({
      parent: [
        delegate("Pick storage"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Noted."),
      ],
      child: [ask()],
    });
    await h.session.prompt("Delegate storage");
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: answer"), { timeout: 15_000 });
    const [id] = h.agentIds();
    const crashed = join(dir, "crashed.jsonl");
    copyFileSync(h.savedRecord(id)!.outputFile!, crashed);
    return { h, dir, crashed, id };
  }

  /** A new process opens the child's transcript, as a cold resume or a restart does. */
  async function reopen(dir: string, crashed: string, announceQuestion = vi.fn()) {
    resetSessionTree();
    const { snapshot, deps } = await realChildDeps(dir, {
      type: "general-purpose",
      provider: "restart",
    });
    const wake = vi.fn();
    const reopened = await createSubagentSession(
      {
        type: "general-purpose",
        snapshot,
        transcriptPath: crashed,
        announceQuestion,
        work: { wake, changed: vi.fn() },
      },
      deps,
    );
    onTestFinished(() => reopened.dispose());
    return { reopened, wake, announceQuestion };
  }

  it("is still open when the child is opened again: pi-ask adopts it, nothing is reported lost, the parent is not told again", async () => {
    const { dir, crashed } = await askedAndCrashed();
    expect(trace(crashed)).toEqual(["assistant", "open:question:answer"]);

    const { reopened, wake, announceQuestion } = await reopen(dir, crashed);

    // Still waiting on the question: adopted, so neither closed nor reported lost.
    expect(reopened.openWork()).toMatchObject([{ owner: "pi-ask", kind: "question" }]);
    expect(trace(crashed)).toEqual(["assistant", "open:question:answer"]);
    expect(readFileSync(crashed, "utf8")).not.toContain("Work lost");
    // It was told once, when it was asked. Opening the session again says nothing, wakes nothing.
    expect(announceQuestion).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(reopened.session.isIdle).toBe(true);

    // The parent's answer closes it, and the next start finds nothing open.
    expect(reopened.answerQuestions()).toBe(1);
    expect(reopened.openWork()).toEqual([]);
    expect(trace(crashed)).toEqual(["assistant", "open:question:answer", "close:cancelled"]);
  }, 40_000);

  it("is closed as lost when nothing in the new process adopts it", async () => {
    // pi-ask is the question's owner: without it the item has nobody to take it over. This is
    // also what the previous test would see if pi-ask did not adopt.
    const { h, dir, crashed } = await askedAndCrashed();
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ extensions: [], compaction: { enabled: false }, retry: { enabled: false } }),
    );
    const { reopened } = await reopen(dir, crashed);
    expect(reopened.openWork()).toEqual([]);
    expect(trace(crashed)).toContain("close:lost");
    expect(trace(crashed)).toContain("message:work:lost");
    expect(h.errors).toEqual([]);
  }, 40_000);

  // Rewritten by roadmap step 11 (was: "is closed by the parent's send to a child that failed
  // after asking, when its transcript is reopened"). The failed run's session was released with the
  // question still open in its transcript, for pi-ask to adopt when the agent was reopened. A
  // session is never released with open work now: the failure ends the assignment, so the question
  // is called off with the rest before the release, and the parent's send is just the next prompt.
  it("calls off the question of a child that failed after asking, and its transcript is reopened by the parent's send", async () => {
    // `ask` alongside another tool call does not end the turn (terminate needs every tool in the
    // batch to terminate), and this run then fails. The question is cancelled and the session
    // released. The parent's next `subagent_send` reopens the transcript with nothing open in it:
    // the child is not left waiting on a question, nor told it was lost.
    const { h, ui } = await parentForQuestions();
    h.script({
      parent: [delegate("Pick storage"), fauxAssistantMessage("Started.")],
      child: [
        fauxAssistantMessage([fauxToolCall("ask", QUESTION), fauxToolCall("ls", { path: "." })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider fell over" }),
      ],
    });
    await h.session.prompt("Delegate storage");
    const [id] = h.agentIds();
    await untilAnnounced(h);
    await vi.waitFor(() => expect(h.announcements("subagent:question")).toHaveLength(1));
    await h.session.waitForIdle();
    expect(h.announcements()[0].text).toContain("provider fell over");
    expect(ui.text()).not.toContain("waiting");
    const transcript = h.savedRecord(id)!.outputFile!;
    await vi.waitFor(() => expect(h.seen("subagent:session:disposed")).toHaveLength(1));
    expect(trace(transcript)).toContain("open:question:answer");
    expect(trace(transcript).filter((entry) => entry.startsWith("close:"))).toEqual([
      "close:cancelled",
    ]);

    const requests: Context[] = [];
    h.script({
      parent: [
        sendCall(id, "Use Postgres."),
        fauxAssistantMessage("Sent."),
        fauxAssistantMessage("Noted."),
      ],
      child: [
        (context) => {
          requests.push(structuredClone(context));
          return fauxAssistantMessage("Using Postgres. Done.");
        },
      ],
    });
    await h.session.prompt("Answer it");
    await untilAnnounced(h, 2);
    expect(requests).toHaveLength(1);
    expect(lastUserText(requests[0])).toContain("Use Postgres.");
    expect(said(requests[0])).not.toContain("Work lost");
    // It was told the question was called off (once, before the parent's message), so it does
    // not wait for an answer that will never come.
    expect(said(requests[0]).match(/Work called off/g)).toHaveLength(1);
    expect(said(requests[0]).indexOf("Work called off")).toBeLessThan(
      said(requests[0]).indexOf("Use Postgres."),
    );
    // Nothing more was closed by the send: the question was already called off.
    expect(trace(transcript).filter((entry) => entry.startsWith("close:"))).toEqual([
      "close:cancelled",
    ]);
    expect(trace(transcript)).not.toContain("message:work:lost");
    expect(trace(transcript).filter((entry) => entry === "message:work:called-off")).toHaveLength(
      1,
    );
    // Done, not waiting on a question that was answered.
    expect(h.announcements()[1].text).toContain("Using Postgres. Done.");
    expect(h.errors).toEqual([]);
  }, 40_000);
});
