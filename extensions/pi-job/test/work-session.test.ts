/**
 * pi-job on the work contract, end to end: a real AgentSession, a scripted model, the pi-job
 * extension and pi-work's root host. A reload is a real `session.reload()` (the owner registry
 * hands the manager to the new extension instance); a restart is a new session on the old
 * session file with an empty registry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WORK_ENTRY, WORK_LOST, WORK_SERVICE } from "#work";
import type { WorkHost } from "#work";
import { service } from "#session-tree";
import { fauxSession, messageText, toolCall, resetSessionTree } from "#test-helpers";
import { createJobsExtension, CUSTOM_TYPE } from "#src/extension";
import type { JobManager } from "#src/jobs";
import { sessionOwners } from "#src/ownership";
import { sleep, tempDir, waitUntil } from "#test/helpers";

type Cleanup = Parameters<typeof tempDir>[0];

interface BranchEntry {
  type: string;
  customType?: string;
  content?: unknown;
  data?: { op?: string; reason?: string };
  details?: { items?: { id: string; kind: string; label: string }[] };
}

/** pi-job in a faux session on `sessionManager` (a fresh in-memory one by default). */
async function harness(
  t: Cleanup,
  options: { dir?: string; sessionManager?: SessionManager; responses?: unknown[] } = {},
) {
  const dir = options.dir ?? tempDir(t);
  let manager: JobManager | undefined;
  const h = await fauxSession({
    cleanup: t,
    dir,
    sessionManager: options.sessionManager,
    provider: "pi-job-work",
    models: [{ id: "m" }],
    tools: ["job_start", "job_watch", "job_list"],
    bind: {
      mode: "print",
      onError: (error) => {
        throw error;
      },
    },
    extensions: [
      createJobsExtension({
        logRoot: join(dir, "logs"),
        minIntervalSeconds: 0.01,
        killGraceMs: 300,
        drainMs: 200,
        onManager: (m) => (manager = m),
      }),
    ],
    responses: options.responses as never,
  });
  t.after(() => manager?.shutdown(200));
  const sessionId = h.sessionManager.getSessionId();
  const branch = () => h.sessionManager.getBranch() as unknown as BranchEntry[];
  return {
    ...h,
    dir,
    manager: () => manager!,
    host: () => service<WorkHost>(sessionId, WORK_SERVICE)!,
    open: () =>
      (service<WorkHost>(sessionId, WORK_SERVICE)?.list() ?? []).map((item) => item.label),
    completions: () => branch().filter((e) => e.customType === CUSTOM_TYPE),
    lost: () => branch().filter((e) => e.type === "custom_message" && e.customType === WORK_LOST),
    closes: () =>
      branch()
        .filter((e) => e.type === "custom" && e.customType === WORK_ENTRY && e.data?.op === "close")
        .map((e) => e.data?.reason),
    texts: () =>
      h.requests.map((request) => request.messages.map((m) => messageText(m)).join("\n")),
    ready: (name = "ready") => writeFileSync(join(dir, name), ""),
  };
}

const watch = (label: string) =>
  toolCall("job_watch", {
    check: "test -f ready",
    intervalSeconds: 0.05,
    timeoutSeconds: 30,
    label,
  });

test.afterEach(resetSessionTree);

void test("a watch is re-adopted by a reload, and its completion wakes the session once", async (t) => {
  const h = await harness(t, {
    responses: [watch("CI"), fauxAssistantMessage("watching"), fauxAssistantMessage("saw it")],
  });
  await h.session.prompt("watch CI");
  assert.deepEqual(h.open(), ["CI"]);
  const manager = h.manager();
  const requests = h.requests.length;

  await h.session.reload();

  assert.equal(h.manager(), manager, "the same manager: no second watch loop");
  assert.deepEqual(h.open(), ["CI"], "the item is adopted, not closed");
  assert.deepEqual(h.lost(), [], "nothing is reported lost");
  assert.equal(h.requests.length, requests, "a reload asks the model nothing");
  assert.equal(manager.get("j1")?.status, "running");

  h.ready();
  await waitUntil(() => h.completions().length === 1 && h.session.isIdle, 5000, "completion");
  await waitUntil(() => h.requests.length === requests + 1, 5000, "the woken turn");
  assert.match(h.texts().at(-1)!, /Watch j1 matched: CI/);
  assert.deepEqual(h.open(), []);
  assert.deepEqual(h.closes(), ["completed"]);
  await sleep(150);
  assert.equal(h.completions().length, 1, "delivered once");
  assert.equal(h.requests.length, requests + 1);
  assert.deepEqual(h.errors, []);
});

void test("a job that ends while the session reloads is completed after startup", async (t) => {
  const h = await harness(t, {
    responses: [watch("CI"), fauxAssistantMessage("watching"), fauxAssistantMessage("saw it")],
  });
  await h.session.prompt("watch CI");
  const requests = h.requests.length;
  const manager = h.manager(); // the replacement builds its own, and adopts this one at session_start

  await h.session.reload({
    // Between the old extension's shutdown and the new one's session_start.
    beforeSessionStart: async () => {
      h.ready();
      await waitUntil(() => manager.get("j1")?.status === "matched", 5000, "the watch to match");
      assert.deepEqual(h.completions(), [], "nothing can be delivered yet");
    },
  });

  await waitUntil(() => h.completions().length === 1 && h.session.isIdle, 5000, "completion");
  assert.equal(h.requests.length, requests + 1, "one woken turn");
  assert.match(h.texts().at(-1)!, /Watch j1 matched: CI/);
  assert.deepEqual(h.open(), []);
  assert.deepEqual(h.lost(), []);
  assert.deepEqual(h.errors, []);
});

void test("after a restart the job's item is lost: one lost message, no model request, nothing restarted", async (t) => {
  const dir = tempDir(t);
  const file = SessionManager.create(dir, dir);
  const first = await harness(t, {
    dir,
    sessionManager: file,
    responses: [watch("CI"), fauxAssistantMessage("watching")],
  });
  await first.session.prompt("watch CI");
  assert.deepEqual(first.open(), ["CI"]);
  const path = file.getSessionFile()!;
  assert.ok(existsSync(path));
  // The process dies: no shutdown handler runs, the registry and the session tree are gone.
  await first.session.abort();
  first.session.dispose();
  await first.manager().shutdown(100);
  sessionOwners().clear();
  resetSessionTree();

  const second = await harness(t, {
    dir,
    sessionManager: SessionManager.open(path, undefined, dir),
    responses: [fauxAssistantMessage("understood")],
  });
  assert.equal(second.requests.length, 0, "a restart wakes nothing");
  assert.equal(second.session.isIdle, true);
  assert.deepEqual(second.manager().list(), [], "nothing restarted");
  assert.deepEqual(second.open(), []);
  const lost = second.lost();
  assert.equal(lost.length, 1);
  assert.deepEqual(
    lost[0].details?.items?.map((item) => [item.kind, item.label]),
    [["watch", "CI"]],
  );
  assert.deepEqual(second.closes(), ["lost"]);

  // The model learns of it on its next run, and a later restart does not report it again.
  await second.session.prompt("status?");
  assert.match(second.texts()[0], /Work lost: 1 item/);
  assert.match(second.texts()[0], /watch "CI"/);
  assert.deepEqual(second.errors, []);
});

void test("a job finished before the restart is not reported", async (t) => {
  const dir = tempDir(t);
  const file = SessionManager.create(dir, dir);
  const first = await harness(t, {
    dir,
    sessionManager: file,
    responses: [
      toolCall("job_start", { command: "echo quick", timeoutSeconds: 10, label: "quick" }),
      fauxAssistantMessage("started"),
      fauxAssistantMessage("saw it"),
    ],
  });
  await first.session.prompt("go");
  await waitUntil(() => first.completions().length === 1 && first.session.isIdle, 5000, "done");
  const path = file.getSessionFile()!;
  await first.session.abort();
  first.session.dispose();
  sessionOwners().clear();
  resetSessionTree();

  const second = await harness(t, {
    dir,
    sessionManager: SessionManager.open(path, undefined, dir),
  });
  assert.deepEqual(second.lost(), []);
  assert.equal(second.requests.length, 0);
});
