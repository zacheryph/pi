/** End-to-end through the registered tools with a fake ExtensionAPI and real processes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobsExtension, CUSTOM_TYPE, liveManagers, NOTIFY_BYTES } from "#src/extension";
import { piAiEntry, runtimeDirectory } from "#test/runtime";
import defaultExtension from "#src/extension";
import { alive, sleep, tempDir, waitForPid, waitUntil, tick } from "#test/helpers";
import { JobManager } from "#src/jobs";
import { sessionOwners } from "#src/ownership";
import { openRecords, WORK_ENTRY, WORK_LOST, WORK_WAKE } from "#work";
import { forget, link } from "#session-tree";
import { waitFor } from "#test-helpers";

interface Sent {
  message: {
    customType: string;
    content: string | { type: string; text: string }[];
    display: boolean;
    details: any;
  };
  options: { triggerTurn?: boolean; deliverAs?: string };
}

function messageText(message: Sent["message"]): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.text).join("");
}

function fakePi(throwOnSend = false, sessionId = randomUUID(), entries: any[] = []) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, ((...a: any[]) => any)[]>();
  const sent: Sent[] = [];
  const notes: { text: string; level: string }[] = [];
  const shown: Sent[] = [];
  // Session state as pi would report it; startRunOnSend mimics pi starting a run on send.
  const state = { idle: true, startRunOnSend: false, stale: false };
  const ui = { notify: (text: string, level: string) => notes.push({ text, level }) };
  const signal = new AbortController().signal;
  const ctxFor = (cwd: string) => ({
    cwd,
    ui,
    signal,
    isIdle: () => {
      if (state.stale) throw new Error("stale runtime");
      return state.idle;
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
      getBranch: () => entries,
    },
  });
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
    on: (event: string, fn: any) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    // Persisted like Pi does: a custom entry in the session's branch.
    appendEntry: (customType: string, data: unknown) =>
      void entries.push({ type: "custom", customType, data }),
    sendMessage: (message: any, options: any) => {
      // Command output is for the user: it lands in `notes` (text without its lead-in) and `shown`.
      if (message.details?.userOutput === true) {
        const lead = { info: "", warning: "Warning: ", error: "Error: " }[
          message.details.level as string
        ];
        shown.push({ message, options });
        notes.push({
          text: String(message.content).slice(lead?.length ?? 0),
          level: message.details.level,
        });
        return;
      }
      sent.push({ message, options });
      if (throwOnSend) throw new Error("sendMessage failed: session gone");
      // Pi appends the message to the transcript (here at once; mid-run Pi does at the turn's end).
      entries.push({
        type: "custom_message",
        customType: message.customType,
        content: message.content,
        details: message.details,
      });
      if (state.startRunOnSend) state.idle = false;
    },
  };
  const emit = async (event: string, payload: unknown = {}) => {
    let result: unknown;
    for (const fn of handlers.get(event) ?? []) result = (await fn(payload, ctxFor("/"))) ?? result;
    return result;
  };
  return {
    pi,
    tools,
    commands,
    handlers,
    sent,
    shown,
    notes,
    state,
    entries,
    ctx: ctxFor,
    emit,
    /** What Pi emits when a session starts: every session_start handler, then resources_discover. */
    start: async (reason = "startup") => {
      await emit("session_start", { type: "session_start", reason });
      await emit("resources_discover", { type: "resources_discover", reason });
    },
    call: (name: string, params: unknown, cwd: string) =>
      tools.get(name).execute("call-1", params, undefined, undefined, ctxFor(cwd)),
  };
}

async function setup(
  t: Parameters<typeof tempDir>[0],
  opts: Parameters<typeof createJobsExtension>[0] = {},
  { production = false, throwOnSend = false } = {},
) {
  const dir = tempDir(t);
  const fake = fakePi(throwOnSend);
  // production: only the log root is set, exactly as the default export configures limits.
  let mgr: JobManager | undefined;
  const onManager = (m: JobManager) => (mgr = m);
  const options = production
    ? { logRoot: join(dir, "logs"), onManager }
    : {
        logRoot: join(dir, "logs"),
        killGraceMs: 300,
        drainMs: 300,
        minIntervalSeconds: 0.1,
        onManager,
        ...opts,
      };
  createJobsExtension(options)(fake.pi as any);
  await fake.start();
  t.after(() => fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }));
  return { dir, ...fake, manager: () => mgr };
}

void test("default export is an extension factory", () => {
  assert.equal(typeof defaultExtension, "function");
});

void test("registers the five tools and /job, with no-poll guidance", async (t) => {
  const { tools, commands } = await setup(t);
  assert.deepEqual(
    [...tools.keys()],
    ["job_start", "job_watch", "job_list", "job_read", "job_kill"],
  );
  assert.ok(commands.has("job"));
  for (const name of ["job_start", "job_watch"])
    assert.match(tools.get(name).description, /End your turn.*woken.*Do not poll/s);
  for (const tool of tools.values()) assert.equal(tool.parameters.type, "object");
  // CI guidance: watch an immutable target, not a PR number.
  assert.match(tools.get("job_start").description, /gh run watch <run-id> --exit-status/);
  assert.match(tools.get("job_start").description, /commit SHA.*not a PR number/s);
});

void test("job_start → completion message wakes the agent exactly once", async (t) => {
  const { dir, call, sent } = await setup(t);
  const res = await call(
    "job_start",
    { command: "printf 'a\\nb\\n'; exit 4", timeoutSeconds: 10, label: "demo" },
    dir,
  );
  assert.match(
    res.content[0].text,
    /^Started job j1 \(demo\), timeout 10s\.\nlog: .*j1\.log\nEnd your turn now/,
  );
  assert.equal(res.details.status, "running");
  await waitUntil(() => sent.length === 1, 5000, "notification");
  await sleep(150);
  assert.equal(sent.length, 1);
  const { message, options } = sent[0];
  assert.deepEqual(options, { triggerTurn: true }, "idle: the completion starts a run");
  assert.equal(message.customType, CUSTOM_TYPE);
  assert.equal(message.display, true);
  assert.match(
    messageText(message),
    /^Job j1 failed: demo\nexit 4 · after \d+s\ncommand: printf .*\nlog: .*\noutput:\na\nb$/,
  );
  assert.equal(message.details.completions[0].job.exitCode, 4);
  assert.match(message.details.completions[0].completionId, /^[0-9a-f-]{36}$/);
});

void test("job_watch → matched notification with the last check output", async (t) => {
  const { dir, call, sent } = await setup(t);
  setTimeout(() => writeFileSync(join(dir, "ready"), "built\n"), 300);
  const res = await call(
    "job_watch",
    { check: "cat ready", intervalSeconds: 0.1, timeoutSeconds: 5 },
    dir,
  );
  assert.match(res.content[0].text, /^Started watch j1 .* until success/);
  await waitUntil(() => sent.length === 1, 5000, "notification");
  const text = messageText(sent[0].message);
  assert.match(
    text,
    /^Watch j1 matched: cat ready\nuntil success · \d+ checks · last check exit 0 · after/,
  );
  assert.match(text, /last check output:\nbuilt$/);
  assert.equal(sent[0].message.details.completions[0].job.lastCheck.output, ""); // bulky output kept out of details
});

void test("validation errors are thrown as tool failures", async (t) => {
  const { dir, call } = await setup(t);
  await assert.rejects(
    call("job_start", { command: "true", timeoutSeconds: 99999 }, dir),
    /timeoutSeconds must be between 1 and 14400/,
  );
  await assert.rejects(
    call("job_start", { command: "  ", timeoutSeconds: 5 }, dir),
    /command must be a non-empty string/,
  );
  await assert.rejects(
    call("job_start", { command: "true", timeoutSeconds: 5, cwd: "missing" }, dir),
    /cwd is not an existing directory/,
  );
  await assert.rejects(
    call(
      "job_watch",
      { check: "true", intervalSeconds: 5, timeoutSeconds: 60, until: "sometimes" },
      dir,
    ),
    /until must be/,
  );
  await assert.rejects(call("job_read", { id: "j42" }, dir), /No job with id j42/);
});

void test("production interval floor is 10 s", async (t) => {
  const { dir, call } = await setup(t, { minIntervalSeconds: undefined });
  await assert.rejects(
    call("job_watch", { check: "true", intervalSeconds: 2, timeoutSeconds: 60 }, dir),
    /intervalSeconds must be between 10 and 3600/,
  );
});

void test("relative cwd resolves against the session cwd", async (t) => {
  const { dir, call, sent } = await setup(t);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "sub"));
  await call("job_start", { command: "pwd", timeoutSeconds: 5, cwd: "sub" }, dir);
  await waitUntil(() => sent.length === 1);
  assert.match(messageText(sent[0].message), /output:\n.*\/sub$/);
});

void test("job_list, job_read and job_kill", async (t) => {
  const { dir, call, sent } = await setup(t);
  await call(
    "job_start",
    {
      command: "echo started; sleep 100 & echo $! > gc.pid; sleep 100",
      timeoutSeconds: 60,
      label: "long",
    },
    dir,
  );
  const gc = await waitForPid(join(dir, "gc.pid"));
  const list = await call("job_list", {}, dir);
  assert.match(list.content[0].text, /^Running \(1\):\n  j1 · job · running · \d+s — long$/);
  // The log is written one event-loop turn after the child's stdout, so the pid file can exist
  // before `started` is in the log: wait for the output instead of reading it once.
  const out = await waitFor(
    async () => {
      const read = await call("job_read", { id: "j1", tailLines: 5 }, dir);
      return read.content[0].text.endsWith("\noutput:\nstarted") ? read : undefined;
    },
    { timeout: 3000, what: "job output" },
  );
  assert.match(out.content[0].text, /log: .*\noutput:\nstarted$/);
  const killed = await call("job_kill", { id: "j1" }, dir);
  assert.match(killed.content[0].text, /^Stopped: j1 · job · killed · exit 143 \(likely SIGTERM\)/);
  await waitUntil(() => !alive(gc), 3000, "grandchild to die");
  const again = await call("job_kill", { id: "j1" }, dir);
  assert.match(again.content[0].text, /^Already finished: /);
  await sleep(200);
  assert.equal(sent.length, 0, "job_kill must not notify");
});

void test("concurrency cap surfaces as a tool error", async (t) => {
  const { dir, call } = await setup(t, { maxRunning: 1 });
  await call("job_start", { command: "sleep 100", timeoutSeconds: 60 }, dir);
  await assert.rejects(
    call("job_start", { command: "true", timeoutSeconds: 5 }, dir),
    /Too many running background jobs \(1\/1\)/,
  );
});

void test("/job command lists and kills", async (t) => {
  const { dir, call, commands, ctx, notes } = await setup(t);
  await call("job_start", { command: "sleep 100", timeoutSeconds: 60 }, dir);
  await commands.get("job").handler("", ctx(dir));
  assert.match(notes[0].text, /Running \(1\):\n  j1 · job · running/);
  await commands.get("job").handler("kill j1", ctx(dir));
  assert.match(notes[1].text, /^Stopped: j1 · job · killed/);
  await commands.get("job").handler("kill", ctx(dir));
  assert.equal(notes[2].level, "warning");
});

void test("/job shows its output as a displayed message that does not start a turn", async (t) => {
  const { dir, call, commands, ctx, sent, shown, entries } = await setup(t);
  await call("job_start", { command: "sleep 100", timeoutSeconds: 60 }, dir);
  const rpc = { ...ctx(dir), mode: "rpc", hasUI: true };
  await commands.get("job").handler("", rpc);
  await commands.get("job").handler("nonsense", rpc);
  assert.equal(shown.length, 2);
  const [list, usage] = shown;
  assert.equal(list.message.customType, "job:output");
  assert.equal(list.message.display, true);
  assert.deepEqual(list.options, { triggerTurn: false });
  assert.match(String(list.message.content as string), /^Running \(1\):\n {2}j1 · job · running/);
  assert.equal(usage.message.content, "Warning: Usage: /job [kill <id>]");
  assert.deepEqual(sent, []);
  assert.deepEqual(
    entries.filter((entry) => entry.type === "custom_message"),
    [],
  );
  // The terminal keeps its notification and sends nothing.
  const notified: string[] = [];
  const tui = { ...rpc, mode: "tui", ui: { notify: (text: string) => notified.push(text) } };
  await commands.get("job").handler("", tui);
  assert.match(notified[0], /^Running \(1\):/);
  assert.equal(shown.length, 2);
  await commands.get("job").handler("kill j1", rpc);
});

void test("session_shutdown kills running jobs without notifying", async (t) => {
  const { dir, call, sent, emit } = await setup(t);
  await call(
    "job_start",
    { command: "sleep 100 & echo $! > gc.pid; sleep 100", timeoutSeconds: 60 },
    dir,
  );
  await call("job_watch", { check: "sleep 100", intervalSeconds: 1, timeoutSeconds: 60 }, dir);
  const gc = await waitForPid(join(dir, "gc.pid"));
  await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  await waitUntil(() => !alive(gc), 3000, "grandchild to die");
  await sleep(200);
  assert.equal(sent.length, 0);
  await assert.rejects(
    call("job_start", { command: "true", timeoutSeconds: 5 }, dir),
    /shutting down/,
  );
});

/** Script helper: start a session on a bare fake pi, as Pi does (session_start, then resources_discover). */
const STARTED = `
		async function started(handlers, id) {
			const ctx = { cwd: "/", ui: {}, isIdle: () => true, sessionManager: { getSessionId: () => id, getEntries: () => [], getBranch: () => [] } };
			for (const event of ["session_start", "resources_discover"])
				for (const fn of handlers.get(event) ?? []) await fn({ type: event, reason: "startup" }, ctx);
		}`;

void test("pi exiting without session_shutdown kills job groups; >10 instances add exactly one exit listener", async (t) => {
  const dir = tempDir(t);
  const ext = new URL("../src/extension.ts", import.meta.url).href;
  const script = `
		import { createJobsExtension } from ${JSON.stringify(ext)};
		import { existsSync } from "node:fs";
		${STARTED}
		const before = process.listenerCount("exit");
		const all = [];
		for (let i = 0; i < 12; i++) {
			const tools = new Map();
			const handlers = new Map();
			const pi = { registerTool: t => tools.set(t.name, t), registerCommand() {}, on: (e, fn) => handlers.set(e, [...(handlers.get(e) ?? []), fn]), sendMessage() {}, appendEntry() {} };
			createJobsExtension({ logRoot: ${JSON.stringify(join(dir, "logs"))} })(pi);
			await started(handlers, "s" + i);
			all.push(tools);
		}
		for (let i = 0; i < all.length; i++)
			await all[i].get("job_start").execute("x", { command: "sleep 100 & echo $! > gc-" + i + ".pid; sleep 100", timeoutSeconds: 60 }, undefined, undefined, { cwd: ${JSON.stringify(dir)} });
		for (let i = 0; i < all.length; i++)
			while (!existsSync(${JSON.stringify(dir)} + "/gc-" + i + ".pid")) await new Promise(r => setTimeout(r, 20));
		console.log("delta=" + (process.listenerCount("exit") - before));
		process.exit(0);`;
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), "delta=1");
  assert.doesNotMatch(res.stderr, /MaxListeners/);
  const pids = await Promise.all(
    Array.from({ length: 12 }, (_, i) => waitForPid(join(dir, `gc-${i}.pid`))),
  );
  await waitUntil(
    () => pids.every((p) => !alive(p)),
    3000,
    "all grandchildren to die after host exit",
  );
});

void test("host exit while a finished job's TERM-ignoring descendant awaits escalation kills it at once", async (t) => {
  const dir = tempDir(t);
  const ext = new URL("../src/extension.ts", import.meta.url).href;
  const script = `
		import { createJobsExtension } from ${JSON.stringify(ext)};
		import { existsSync } from "node:fs";
		${STARTED}
		const tools = new Map();
		let manager;
		const handlers = new Map();
		const pi = { registerTool: t => tools.set(t.name, t), registerCommand() {}, on: (e, fn) => handlers.set(e, [...(handlers.get(e) ?? []), fn]), sendMessage() {}, appendEntry() {} };
		createJobsExtension({ logRoot: ${JSON.stringify(join(dir, "logs"))}, onManager: m => (manager = m) })(pi); // default 5 s grace
		await started(handlers, "s");
		await tools.get("job_start").execute("x", { command: "trap '' TERM; sleep 30 & echo $! > d.pid", timeoutSeconds: 60 }, undefined, undefined, { cwd: ${JSON.stringify(dir)} });
		while (manager.get("j1").status === "running") await new Promise(r => setTimeout(r, 20));
		if (!manager.ownsProcesses) { console.log("not-owned"); process.exit(3); }
		process.exit(0);`;
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const d = await waitForPid(join(dir, "d.pid"));
  await waitUntil(
    () => !alive(d),
    1500,
    "descendant to be killed by the exit hook, well before the 5 s grace",
  );
});

void test("production defaults through the adapter: 8-job cap and 5000 ms kill grace", async (t) => {
  const { dir, call } = await setup(t, {}, { production: true });
  for (let i = 0; i < 8; i++)
    await call("job_start", { command: "sleep 100 # prod-defaults", timeoutSeconds: 60 }, dir);
  await assert.rejects(
    call("job_start", { command: "true", timeoutSeconds: 5 }, dir),
    /Too many running background jobs \(8\/8\)/,
  );
  const ours = [...liveManagers()].find((m) =>
    m.list().some((j) => j.command.includes("prod-defaults")),
  );
  assert.ok(ours, "manager owning running jobs must be in the exit-hook set");
  assert.equal(ours.opts.killGraceMs, 5000);
  assert.equal(ours.opts.maxRunning, 8);
  assert.equal(ours.opts.maxRunningWatches, 32);
});

void test("manager stays in the exit-hook set until shutdown has finished", async (t) => {
  const { dir, call, emit } = await setup(t);
  await call(
    "job_start",
    {
      command: "trap '' TERM; sleep 100 & echo $! > gc.pid; sleep 100 # stays-live",
      timeoutSeconds: 60,
    },
    dir,
  );
  const gc = await waitForPid(join(dir, "gc.pid"));
  const live = liveManagers();
  const ours = [...live].find((m) => m.list().some((j) => j.command.includes("stays-live")))!;
  assert.ok(ours);
  const shutdown = emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.ok(live.has(ours), "removed from the exit-hook set before shutdown completed");
  await shutdown;
  assert.ok(!live.has(ours));
  await waitUntil(() => !alive(gc), 3000, "TERM-ignoring grandchild to be SIGKILLed");
});

void test("a session disposed without session_shutdown leaves the exit-hook set when its jobs end", async (t) => {
  const live = liveManagers();
  const before = live.size;
  const { dir, call, sent } = await setup(t);
  assert.equal(live.size, before, "idle manager must not be registered");
  await call("job_start", { command: "sleep 0.2", timeoutSeconds: 10 }, dir);
  assert.equal(live.size, before + 1, "manager with a running job must be registered");
  await waitUntil(() => sent.length === 1);
  await waitUntil(() => live.size === before, 2000, "manager to leave the set");
});

void test("stale context (sendMessage throws): no retries; the loss is reported once", async (t) => {
  const { dir, call, sent, notes, manager } = await setup(t, {}, { throwOnSend: true });
  await call("job_start", { command: "exit 2", timeoutSeconds: 10 }, dir);
  await waitUntil(() => sent.length === 1, 5000, "send attempt");
  await call("job_start", { command: "true", timeoutSeconds: 10 }, dir);
  // The second completion has been handed to the (disposed) delivery once j2 is terminal.
  await waitUntil(() => manager()!.get("j2")?.status === "succeeded", 5000, "second job terminal");
  assert.equal(sent.length, 1, "nothing is retried or sent after a stale context");
  assert.equal(notes.filter((n) => /was not delivered/.test(n.text)).length, 1);
  const list = await call("job_list", {}, dir);
  assert.match(list.content[0].text, /j1 · job · failed · exit 2/);
});

const completionMessage = (text = "done") => ({
  role: "custom",
  customType: CUSTOM_TYPE,
  content: [{ type: "text", text }],
});
const assistant = { role: "assistant", content: [] };
const settle = (outcome: string, contextMessages: unknown[], pendingMessages: unknown[] = []) => ({
  type: "agent_before_settle",
  outcome,
  context: { contextMessages, pendingMessages },
});

void test("completions during a run are sent at once without a turn, one message each", async (t) => {
  const { dir, call, sent, state, emit, manager } = await setup(t);
  state.idle = false;
  await emit("agent_start", { type: "agent_start" });
  await call("job_start", { command: "echo held", timeoutSeconds: 10 }, dir);
  await waitUntil(() => manager()!.get("j1")?.status === "succeeded", 5000, "first job");
  assert.equal(sent.length, 1, "no waiting for agent_end");
  await call("job_start", { command: "echo held-too", timeoutSeconds: 10 }, dir);
  await waitUntil(() => manager()!.get("j2")?.status === "succeeded", 5000, "second job");
  assert.equal(sent.length, 2);
  for (const { message, options } of sent) {
    assert.deepEqual(options, { triggerTurn: false }, "Pi appends it at the end of the turn");
    assert.equal(message.customType, CUSTOM_TYPE);
  }
  assert.deepEqual(
    sent.map((s) => s.message.details.completions.map((c: any) => c.job.id)),
    [["j1"], ["j2"]],
  );
  await emit("agent_end", { type: "agent_end", messages: [] });
  state.idle = true;
  await emit("agent_settled", { type: "agent_settled" });
  assert.equal(sent.length, 2, "run boundaries never resend or add anything");
});

void test("agent_before_settle continues the run only for a completed run with an unanswered completion", async (t) => {
  const { dir, call, sent, emit } = await setup(t);
  // The host continues for the message types it has delivered: let a job complete first.
  await call("job_start", { command: "true", timeoutSeconds: 10 }, dir);
  await waitUntil(() => sent.length === 1, 5000, "first completion");
  const user = { role: "user", content: "hi" };
  const continued = { continue: true };
  assert.deepEqual(
    await emit("agent_before_settle", settle("completed", [user, assistant, completionMessage()])),
    continued,
  );
  assert.deepEqual(
    await emit(
      "agent_before_settle",
      settle("completed", [user, assistant], [completionMessage()]),
    ),
    continued,
    "pending: Pi appends it right after this handler",
  );
  assert.equal(
    await emit("agent_before_settle", settle("completed", [user, completionMessage(), assistant])),
    undefined,
    "already answered",
  );
  assert.equal(
    await emit("agent_before_settle", settle("completed", [user, assistant])),
    undefined,
  );
  assert.equal(
    await emit(
      "agent_before_settle",
      settle("completed", [user, assistant, { role: "custom", customType: "other", content: "x" }]),
    ),
    undefined,
    "only work messages",
  );
  for (const outcome of ["aborted", "error"])
    assert.equal(
      await emit("agent_before_settle", settle(outcome, [user, assistant, completionMessage()])),
      undefined,
      `${outcome}: the message waits in the transcript for the next run`,
    );
});

void test("a completion sent before Escape is never resent or queued again", async (t) => {
  const { dir, call, sent, state, emit, manager } = await setup(t);
  state.idle = false;
  await emit("agent_start", { type: "agent_start" });
  await call("job_start", { command: "echo lost-once", timeoutSeconds: 10 }, dir);
  await waitUntil(() => manager()!.get("j1")?.status === "succeeded", 5000, "job");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, { triggerTurn: false });
  // Escape: Pi keeps the message in the transcript, aborts, and settles without a boundary.
  state.idle = true;
  await emit("agent_settled", { type: "agent_settled" });
  await emit("agent_settled", { type: "agent_settled" });
  assert.equal(sent.length, 1, "pi already holds it in the transcript");
});

for (const [event, payload] of [
  ["session_compact", {}],
  ["session_compact_failed", { aborted: true }],
  ["session_tree", {}],
] as const) {
  void test(`busy without a run: recorded without a turn, nothing sent after ${event}`, async (t) => {
    const { dir, call, sent, state, emit, manager } = await setup(t);
    state.idle = false; // compacting / summarizing a branch: no agent_start, but not idle
    await call("job_start", { command: "echo busy", timeoutSeconds: 10 }, dir);
    await waitUntil(() => manager()!.get("j1")?.status === "succeeded", 5000, "job");
    assert.equal(sent.length, 1);
    assert.deepEqual(
      sent[0].options,
      { triggerTurn: false },
      "must not start a run while pi is busy",
    );
    state.idle = true;
    await emit(event, { type: event, ...payload });
    await tick();
    assert.equal(sent.length, 1);
  });
}

void test("busy without a run: a compaction that failed is followed by one wake, not a second completion", async (t) => {
  const { dir, call, sent, state, emit, manager } = await setup(t);
  state.idle = false;
  await call("job_start", { command: "echo busy", timeoutSeconds: 10 }, dir);
  await waitUntil(() => manager()!.get("j1")?.status === "succeeded", 5000, "job");
  assert.equal(sent.length, 1);
  state.idle = true;
  await emit("session_compact_failed", { type: "session_compact_failed", aborted: false });
  await tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].message.customType, WORK_WAKE);
  assert.deepEqual(sent[1].options, { triggerTurn: true });
  // Paid once: a second failure owes nothing.
  await emit("session_compact_failed", { type: "session_compact_failed", aborted: false });
  await tick();
  assert.equal(sent.length, 2);
});

void test("a run started by our own wake records the completions that follow", async (t) => {
  const { dir, call, sent, state, emit, manager } = await setup(t);
  state.startRunOnSend = true; // pi starts a run synchronously on a wake
  await call("job_start", { command: "echo first", timeoutSeconds: 10 }, dir);
  await waitUntil(() => sent.length === 1, 5000, "wake");
  await call("job_start", { command: "echo second", timeoutSeconds: 10 }, dir);
  await waitUntil(() => manager()!.get("j2")?.status === "succeeded", 5000, "second job");
  assert.deepEqual(
    sent.map((s) => s.options),
    [{ triggerTurn: true }, { triggerTurn: false }],
  );
  await emit("agent_settled", { type: "agent_settled" });
  state.idle = true;
  state.startRunOnSend = false;
  await call("job_start", { command: "echo third", timeoutSeconds: 10 }, dir);
  await waitUntil(() => sent.length === 3, 5000, "idle again");
  assert.deepEqual(sent[2].options, { triggerTurn: true });
});

void test("jobs that finish in a reload gap are completed one by one once startup is over, each within its own output budget", async (t) => {
  const dir = tempDir(t);
  const id = randomUUID();
  const entries: any[] = [];
  const old = fakePi(false, id, entries);
  const next = fakePi(false, id, entries);
  let manager: JobManager | undefined;
  const options = {
    logRoot: join(dir, "logs"),
    killGraceMs: 50,
    drainMs: 50,
    maxRunning: 20,
    onManager: (m: JobManager) => (manager = m),
  };
  createJobsExtension(options)(old.pi as any);
  await old.start();
  t.after(() => next.emit("session_shutdown", { reason: "quit" }));
  for (let i = 0; i < 20; i++)
    await old.call(
      "job_start",
      {
        command: "while [ ! -f go ]; do sleep 0.02; done; head -c 6000 /dev/zero | tr '\\0' x",
        timeoutSeconds: 10,
      },
      dir,
    );
  await old.emit("session_shutdown", { reason: "reload" });
  writeFileSync(join(dir, "go"), "");
  await waitUntil(
    () => manager!.list().every((j) => j.status !== "running"),
    10_000,
    "all jobs, during the gap",
  );
  assert.equal(old.sent.length, 0, "nothing goes through the stale API");
  createJobsExtension(options)(next.pi as any);
  next.state.startRunOnSend = true; // the first wake starts a run: what follows is recorded
  await next.emit("session_start", { reason: "reload" });
  assert.equal(next.sent.length, 0, "session_start only adopts");
  await next.emit("resources_discover", { reason: "reload" });
  await waitUntil(() => next.sent.length === 20, 10_000, "every completion after the reload");
  assert.deepEqual(
    next.sent.map((s) => s.options.triggerTurn),
    [true, ...Array<boolean>(19).fill(false)],
    "the first wakes the session, the rest are recorded for its run",
  );
  const ids = next.sent.flatMap((s) => s.message.details.completions.map((c: any) => c.job.id));
  assert.equal(new Set(ids).size, 20, "one completion per job");
  for (const { message } of next.sent) {
    const text = messageText(message);
    assert.match(text, /^Job j\d+ succeeded/);
    const outputBytes = (text.match(/x{5,}/g) ?? []).reduce((n, run) => n + run.length, 0);
    assert.ok(outputBytes > 0 && outputBytes <= NOTIFY_BYTES, `output bytes ${outputBytes}`);
  }
});

void test("each extension instance (e.g. a subagent session) owns its jobs", async (t) => {
  const a = await setup(t);
  const b = await setup(t);
  await a.call("job_start", { command: "sleep 100", timeoutSeconds: 60 }, a.dir);
  await b.call("job_start", { command: "true", timeoutSeconds: 60 }, b.dir);
  await waitUntil(() => b.sent.length === 1);
  assert.equal(a.sent.length, 0);
  await b.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  const list = await a.call("job_list", {}, a.dir);
  assert.match(list.content[0].text, /j1 · job · running/);
});

const RUNTIME = runtimeDirectory();
const PI_AI = piAiEntry(RUNTIME);

void test(
  "tool schemas enforce the bounds through pi's own argument validation",
  {
    skip:
      PI_AI && existsSync(PI_AI)
        ? false
        : "pi-ai not found; install the pi runtime or set PI_RUNTIME_DIR",
  },
  async (t) => {
    const { validateToolArguments } = await import(PI_AI!);
    const { tools } = await setup(t, {}, { production: true });
    const ok = (name: string, args: object) =>
      validateToolArguments(tools.get(name), { type: "toolCall", id: "x", name, arguments: args });
    const bad = (name: string, args: object) =>
      assert.throws(
        () => ok(name, args),
        () => true,
        `${name} ${JSON.stringify(args)} must be rejected`,
      );
    ok("job_start", { command: "true", timeoutSeconds: 14400 });
    bad("job_start", { command: "true", timeoutSeconds: 0 });
    bad("job_start", { command: "true", timeoutSeconds: 14401 });
    bad("job_start", { command: "", timeoutSeconds: 5 });
    ok("job_watch", {
      check: "true",
      intervalSeconds: 10,
      timeoutSeconds: 60,
      checkTimeoutSeconds: 30,
    });
    bad("job_watch", { check: "true", intervalSeconds: 9, timeoutSeconds: 60 });
    bad("job_watch", { check: "true", intervalSeconds: 3601, timeoutSeconds: 60 });
    bad("job_watch", {
      check: "true",
      intervalSeconds: 10,
      timeoutSeconds: 60,
      checkTimeoutSeconds: 0,
    });
    bad("job_watch", {
      check: "true",
      intervalSeconds: 10,
      timeoutSeconds: 60,
      until: "sometimes",
    });
    ok("job_read", { id: "j1", tailLines: 200 });
    // pi-schema (Pi 1.5.0) truncates a fractional integer instead of rejecting it.
    assert.deepEqual(ok("job_read", { id: "j1", tailLines: 2.5 }), { id: "j1", tailLines: 2 });
    bad("job_read", { id: "j1", tailLines: 201 });
    bad("job_read", { id: "j1", tailLines: 0 });
    assert.match(
      tools.get("job_watch").parameters.properties.checkTimeoutSeconds.description,
      /Default: min\(120, timeoutSeconds\)/,
    );
  },
);

void test("reload adopts a running command and watch, preserves ids and delivers through the new API", async (t) => {
  const dir = tempDir(t);
  const id = randomUUID();
  const entries: any[] = [];
  const old = fakePi(false, id, entries);
  const next = fakePi(false, id, entries);
  const options = {
    logRoot: join(dir, "logs"),
    killGraceMs: 50,
    drainMs: 50,
    minIntervalSeconds: 0.05,
  };
  createJobsExtension(options)(old.pi as any);
  await old.start();
  t.after(() => next.emit("session_shutdown", { reason: "quit" }));
  const command = await old.call(
    "job_start",
    { command: "while [ ! -f done ]; do sleep 0.02; done; echo completed", timeoutSeconds: 10 },
    dir,
  );
  const watch = await old.call(
    "job_watch",
    { check: "test -f ready", intervalSeconds: 0.05, timeoutSeconds: 10 },
    dir,
  );
  await old.emit("session_shutdown", { reason: "reload" });
  writeFileSync(join(dir, "done"), "");
  await sleep(150); // completion during the reload gap must be buffered
  assert.equal(old.sent.length, 0);
  createJobsExtension(options)(next.pi as any);
  next.pi.on("session_start", () =>
    assert.equal(next.sent.length, 0, "later extension initializes before triggerTurn"),
  );
  await next.start("reload");
  const listed = await next.call("job_list", {}, dir);
  assert.deepEqual(
    listed.details.jobs
      .map((j: { id: string }) => j.id)
      .sort((a: string, b: string) => a.localeCompare(b)),
    [command.details.id, watch.details.id].sort((a: string, b: string) => a.localeCompare(b)),
  );
  writeFileSync(join(dir, "ready"), "");
  await waitUntil(() => next.sent.flatMap((s) => s.message.details.completions).length === 2);
  assert.deepEqual(
    next.sent
      .flatMap((s) => s.message.details.completions)
      .map((c: { job: { status: string } }) => c.job.status)
      .sort(),
    ["matched", "succeeded"],
  );
  assert.equal(old.sent.length, 0);
  const third = await next.call("job_start", { command: "sleep 1", timeoutSeconds: 5 }, dir);
  assert.equal(third.details.id, "j3");
  assert.match(next.notes[0].text, /re-adopted/);
  assert.ok(
    !next.sent.some((s) => s.message.customType === WORK_LOST),
    "adopted items are not reported lost",
  );
  // The reload gap's completion was delivered through the replacement's host, and both items closed.
  const open = openRecords(entries.filter((e) => e.customType === WORK_ENTRY).map((e) => e.data));
  assert.deepEqual(
    open.map((r) => r.data),
    [{ jobId: "j3", sessionId: id, logPath: third.details.logPath }],
    "only the job started after the reload is still open",
  );
});

void test("reload keeps a watch's original deadline and change baseline", async (t) => {
  const dir = tempDir(t),
    id = randomUUID(),
    entries: any[] = [];
  const old = fakePi(false, id, entries),
    next = fakePi(false, id, entries);
  const options = {
    logRoot: join(dir, "logs"),
    killGraceMs: 50,
    drainMs: 50,
    minIntervalSeconds: 0.05,
  };
  createJobsExtension(options)(old.pi as any);
  await old.start();
  await old.call(
    "job_watch",
    { check: "echo unchanged", until: "change", intervalSeconds: 0.05, timeoutSeconds: 1 },
    dir,
  );
  await sleep(650);
  await old.emit("session_shutdown", { reason: "reload" });
  createJobsExtension(options)(next.pi as any);
  t.after(() => next.emit("session_shutdown", { reason: "quit" }));
  await next.start("reload");
  await waitUntil(() => next.sent.length === 1, 800, "original watch deadline");
  assert.equal(next.sent[0].message.details.completions[0].job.status, "timed_out");
});

/** The `work:lost` messages a fake pi was asked to send. */
const lostMessages = (fake: { sent: Sent[] }) =>
  fake.sent.filter((s) => s.message.customType === WORK_LOST);

void test("a reload without a handoff reports the open jobs and watches as lost: once, without a turn, nothing restarted", async (t) => {
  const dir = tempDir(t),
    id = randomUUID();
  const entries: any[] = [];
  const old = fakePi(false, id, entries),
    next = fakePi(false, id, entries),
    third = fakePi(false, id, entries);
  const options = { logRoot: join(dir, "logs"), killGraceMs: 50, minIntervalSeconds: 0.05 };
  createJobsExtension(options)(old.pi as any);
  await old.start();
  const command = await old.call(
    "job_start",
    { command: "while [ ! -f done ]; do sleep 0.02; done", timeoutSeconds: 10, label: "build" },
    dir,
  );
  const watch = await old.call(
    "job_watch",
    {
      check: `echo '${"full command ".repeat(20)}'; false`,
      intervalSeconds: 0.05,
      timeoutSeconds: 10,
    },
    dir,
  );
  // The old process ended without a handoff: its shutdown stopped the work and kept no owner.
  await old.emit("session_shutdown", { reason: "quit" });
  assert.equal(sessionOwners().has(id), false);

  createJobsExtension(options)(next.pi as any);
  t.after(() => next.emit("session_shutdown", { reason: "quit" }));
  await next.start("reload");
  assert.deepEqual((await next.call("job_list", {}, dir)).details.jobs, [], "nothing restarted");
  assert.equal(next.sent.length, 1, "one message for all lost items");
  const [lost] = lostMessages(next);
  assert.deepEqual(lost.options, { triggerTurn: false }, "lost work never starts a turn");
  assert.deepEqual(
    lost.message.details.items.map((item: any) => [item.owner, item.kind, item.label]),
    [
      ["pi-job", "job", "build"],
      ["pi-job", "watch", watch.details.command.slice(0, 79) + "…"],
    ],
  );
  assert.match(messageText(lost.message), /Work lost: 2 items/);
  assert.match(messageText(lost.message), /job "build"/);
  assert.ok(next.notes.some((n) => n.level === "warning" && /closed as lost/.test(n.text)));
  assert.equal(command.details.status, "running");

  // Recorded as closed: the next start reports nothing again.
  createJobsExtension(options)(third.pi as any);
  t.after(() => third.emit("session_shutdown", { reason: "quit" }));
  await third.start("reload");
  assert.deepEqual(third.sent, []);
});

void test("an incompatible handoff stops the old jobs, says so, and reports their items as lost", async (t) => {
  const dir = tempDir(t),
    id = randomUUID(),
    entries: any[] = [];
  const old = fakePi(false, id, entries),
    next = fakePi(false, id, entries);
  const options = { logRoot: join(dir, "logs"), killGraceMs: 50, minIntervalSeconds: 0.05 };
  createJobsExtension(options)(old.pi as any);
  await old.start();
  const watch = await old.call(
    "job_watch",
    { check: "echo incompatible; false", intervalSeconds: 0.05, timeoutSeconds: 10 },
    dir,
  );
  await old.emit("session_shutdown", { reason: "reload" });
  const owner = sessionOwners().get(id)!;
  (owner as any).version = 999;
  createJobsExtension(options)(next.pi as any);
  t.after(() => next.emit("session_shutdown", { reason: "quit" }));
  await next.start("reload");
  assert.equal(owner.manager.get(watch.details.id)?.status, "killed");
  const warning = next.notes.find((n) => /incompatible reload handoff/.test(n.text));
  assert.equal(warning?.level, "warning");
  assert.ok(warning!.text.includes(watch.details.logPath), "names the log of what was stopped");
  assert.equal(next.sent.length, 1);
  const [lost] = lostMessages(next);
  assert.deepEqual(lost.options, { triggerTurn: false });
  assert.ok(messageText(lost.message).includes(watch.details.command));
});

void test("a fork inherits the open records, but its jobs stay with the session that started them", async (t) => {
  const dir = tempDir(t);
  const entries: any[] = [];
  const parent = fakePi(false, randomUUID(), entries);
  const options = { logRoot: join(dir, "logs"), killGraceMs: 50, minIntervalSeconds: 0.05 };
  createJobsExtension(options)(parent.pi as any);
  await parent.start();
  t.after(() => parent.emit("session_shutdown", { reason: "quit" }));
  const job = await parent.call(
    "job_start",
    { command: "while [ ! -f done ]; do sleep 0.02; done", timeoutSeconds: 10 },
    dir,
  );

  // A fork has another session id and a copy of the parent's records.
  const fork = fakePi(false, randomUUID(), [...entries]);
  createJobsExtension(options)(fork.pi as any);
  t.after(() => fork.emit("session_shutdown", { reason: "quit" }));
  await fork.start("fork");
  assert.deepEqual((await fork.call("job_list", {}, dir)).details.jobs, []);
  assert.equal(lostMessages(fork).length, 1, "the fork is told it does not have the job");

  writeFileSync(join(dir, "done"), "");
  await waitUntil(() => parent.sent.length === 1, 5000, "the parent's completion");
  await sleep(150);
  assert.equal(parent.sent[0].message.details.completions[0].job.id, job.details.id);
  assert.equal(
    fork.sent.filter((s) => s.message.customType === CUSTOM_TYPE).length,
    0,
    "only the session that started the job receives its completion",
  );
});

void test("a replacement module adopts compatible older snapshots without intervalSeconds", async (t) => {
  const dir = tempDir(t),
    id = randomUUID(),
    entries: any[] = [];
  const old = fakePi(false, id, entries),
    next = fakePi(false, id, entries);
  const options = {
    logRoot: join(dir, "logs"),
    killGraceMs: 50,
    drainMs: 50,
    minIntervalSeconds: 0.05,
  };
  createJobsExtension(options)(old.pi as any);
  await old.start();
  const command = await old.call(
    "job_start",
    { command: "while [ ! -f done ]; do sleep 0.02; done", timeoutSeconds: 10 },
    dir,
  );
  const watch = await old.call(
    "job_watch",
    { check: "test -f ready", intervalSeconds: 0.05, timeoutSeconds: 10 },
    dir,
  );
  const manager = sessionOwners().get(id)!.manager;
  const list = manager.list.bind(manager);
  manager.list = () => list().map(({ intervalSeconds: _intervalSeconds, ...snapshot }) => snapshot);
  await old.emit("session_shutdown", { reason: "reload" });
  const replacement = await import(`../src/extension.ts?replacement=${randomUUID()}`);
  replacement.createJobsExtension(options)(next.pi as any);
  t.after(() => next.emit("session_shutdown", { reason: "quit" }));
  await next.start("reload");
  assert.equal(sessionOwners().get(id)!.manager, manager);
  assert.deepEqual(
    (await next.call("job_list", {}, dir)).details.jobs.map((job: any) => job.id),
    [command.details.id, watch.details.id],
  );
  assert.equal(next.sent.length, 0);
  writeFileSync(join(dir, "done"), "");
  writeFileSync(join(dir, "ready"), "");
  await waitUntil(
    () => next.sent.flatMap((message) => message.message.details.completions).length === 2,
  );
  assert.equal(old.sent.length, 0);
  assert.deepEqual(
    next.sent
      .flatMap((message) => message.message.details.completions)
      .map((completion: { job: { status: string } }) => completion.job.status)
      .sort(),
    ["matched", "succeeded"],
  );
});

void test("history continues numbering when no manager can be adopted", async (t) => {
  const dir = tempDir(t);
  const fake = fakePi(false, randomUUID(), [
    {
      type: "message",
      message: { role: "toolResult", toolName: "job_start", details: { id: "j544" } },
    },
  ]);
  createJobsExtension({ logRoot: join(dir, "logs"), killGraceMs: 50 })(fake.pi as any);
  t.after(() => fake.emit("session_shutdown", { reason: "quit" }));
  await fake.start("reload");
  const result = await fake.call("job_start", { command: "sleep 1", timeoutSeconds: 5 }, dir);
  assert.equal(result.details.id, "j545");
});

void test("session_start reports and stops proven orphan watches, not another live session", async (t) => {
  const dir = tempDir(t);
  const old = fakePi(),
    live = fakePi(),
    next = fakePi();
  const options = {
    logRoot: join(dir, "logs"),
    killGraceMs: 50,
    drainMs: 50,
    minIntervalSeconds: 0.05,
  };
  for (const fake of [old, live, next]) {
    createJobsExtension(options)(fake.pi as any);
    t.after(() => fake.emit("session_shutdown", { reason: "quit" }));
  }
  await old.start();
  await live.start();
  await old.call(
    "job_watch",
    { check: "sleep 30", intervalSeconds: 0.05, timeoutSeconds: 60 },
    dir,
  );
  await live.call("job_watch", { check: "false", intervalSeconds: 0.05, timeoutSeconds: 60 }, dir);
  old.state.stale = true; // runtime invalidated without a shutdown handler
  await next.start("reload");
  assert.match(next.notes[0].text, /owner session .* is gone; stopped orphaned watch j1.*log:/);
  assert.equal((await old.call("job_list", {}, dir)).details.jobs[0].status, "killed");
  assert.equal((await live.call("job_list", {}, dir)).details.jobs[0].status, "running");
});

/** The reasons of the close records written so far. */
const closeReasons = (entries: any[]) =>
  entries
    .filter((e) => e.customType === WORK_ENTRY && e.data.op === "close")
    .map((e) => e.data.reason);

void test("each job and watch is a work item: opened at start, closed by its completion or by a kill", async (t) => {
  const { dir, call, sent, entries, manager } = await setup(t, { minIntervalSeconds: 0.05 });
  const opened = () =>
    entries.filter((e) => e.customType === WORK_ENTRY && e.data.op === "open").map((e) => e.data);
  await call("job_start", { command: "sleep 100", timeoutSeconds: 60, label: "long" }, dir);
  await call("job_watch", { check: "false", intervalSeconds: 0.05, timeoutSeconds: 60 }, dir);
  await call("job_start", { command: "true", timeoutSeconds: 10 }, dir);
  assert.deepEqual(
    opened().map((r) => [r.owner, r.kind, r.label, r.data.jobId]),
    [
      ["pi-job", "job", "long", "j1"],
      ["pi-job", "watch", "false", "j2"],
      ["pi-job", "job", "true", "j3"],
    ],
  );
  await waitUntil(() => sent.length === 1, 5000, "j3's completion");
  assert.deepEqual(closeReasons(entries), ["completed"]);
  await call("job_kill", { id: "j1" }, dir);
  await call("job_kill", { id: "j2" }, dir);
  assert.deepEqual(closeReasons(entries), ["completed", "cancelled", "cancelled"]);
  await sleep(100);
  assert.equal(sent.length, 1, "a kill sends no message");
  assert.equal(manager()!.get("j1")?.status, "killed");
});

void test("a job that cannot get a work item is stopped, not left running unobserved", async (t) => {
  const dir = tempDir(t);
  const fake = fakePi();
  let manager: JobManager | undefined;
  createJobsExtension({
    logRoot: join(dir, "logs"),
    killGraceMs: 50,
    drainMs: 50,
    onManager: (m) => (manager = m),
  })(fake.pi as any);
  t.after(() => fake.emit("session_shutdown", { reason: "quit" }));
  // No session_start: the session has no work host yet.
  await assert.rejects(
    fake.call("job_start", { command: "sleep 100", timeoutSeconds: 60 }, dir),
    /work host is not available/,
  );
  assert.equal(manager!.get("j1")?.status, "killed");
  assert.equal(fake.sent.length, 0);
});

void test("a quit leaves the running jobs' items open: the next start reports them lost", async (t) => {
  const dir = tempDir(t);
  const entries: any[] = [];
  const fake = fakePi(false, randomUUID(), entries);
  createJobsExtension({ logRoot: join(dir, "logs"), killGraceMs: 50, drainMs: 50 })(fake.pi as any);
  await fake.start();
  await fake.call("job_start", { command: "sleep 100", timeoutSeconds: 60 }, dir);
  await fake.emit("session_shutdown", { reason: "quit" });
  assert.deepEqual(closeReasons(entries), []);
  assert.equal(fake.sent.length, 0, "shutting down sends nothing");
});

void test("/job kill cancels the job's item without a message", async (t) => {
  const { dir, call, commands, ctx, sent, entries, notes } = await setup(t);
  await call("job_start", { command: "sleep 100", timeoutSeconds: 60 }, dir);
  await call("job_watch", { check: "false", intervalSeconds: 0.1, timeoutSeconds: 60 }, dir);
  await commands.get("job").handler("kill j1", ctx(dir));
  assert.match(notes[0].text, /^Stopped: j1/);
  assert.deepEqual(closeReasons(entries), ["cancelled"]);
  await commands.get("job").handler("kill j2", ctx(dir));
  assert.deepEqual(closeReasons(entries), ["cancelled", "cancelled"]);
  // Nothing is left open for the next start to report lost, and no completion was sent.
  const open = openRecords(entries.filter((e) => e.customType === WORK_ENTRY).map((e) => e.data));
  assert.deepEqual(open, []);
  await sleep(100);
  assert.equal(sent.length, 0);
});

/** A reload from `old` to a fresh instance on the same session, up to (not including) startup's end. */
async function reloadGap(t: Parameters<typeof tempDir>[0]) {
  const dir = tempDir(t);
  const id = randomUUID();
  const entries: any[] = [];
  const old = fakePi(false, id, entries);
  const next = fakePi(false, id, entries);
  let manager: JobManager | undefined;
  const options = {
    logRoot: join(dir, "logs"),
    killGraceMs: 50,
    drainMs: 50,
    onManager: (m: JobManager) => (manager = m),
  };
  createJobsExtension(options)(old.pi as any);
  await old.start();
  t.after(() => next.emit("session_shutdown", { reason: "quit" }));
  const started = await old.call(
    "job_start",
    { command: "while [ ! -f go ]; do sleep 0.02; done; echo finished", timeoutSeconds: 10 },
    dir,
  );
  return { dir, entries, old, next, options, manager: () => manager!, started };
}

void test("a job that exits between the host's shutdown and pi-job's is still completed after the reload", async (t) => {
  const { dir, entries, old, next, options, manager } = await reloadGap(t);
  // pi-work's session_shutdown handler (registered first, by ensureWorkHost) disposes the host
  // before pi-job's own handler runs suspend(). The job exits in between.
  const shutdown = old.handlers.get("session_shutdown")!;
  assert.equal(shutdown.length, 2, "pi-work's handler, then pi-job's");
  shutdown.splice(1, 0, async () => {
    writeFileSync(join(dir, "go"), "");
    await waitUntil(() => manager().get("j1")?.status === "succeeded", 5000, "the job to exit");
  });
  await old.emit("session_shutdown", { reason: "reload" });
  assert.equal(old.sent.length, 0, "the old host is gone: nothing is delivered");
  assert.deepEqual(closeReasons(entries), [], "the item is still open");

  createJobsExtension(options)(next.pi as any);
  await next.emit("session_start", { reason: "reload" });
  assert.equal(next.sent.length, 0, "adopting delivers nothing: startup is not over");
  await next.emit("resources_discover", { reason: "reload" });
  await waitUntil(() => next.sent.length === 1, 5000, "the completion");
  assert.match(messageText(next.sent[0].message), /^Job j1 succeeded/);
  assert.match(messageText(next.sent[0].message), /finished/);
  assert.deepEqual(closeReasons(entries), ["completed"], "completed, not cancelled silently");
  assert.ok(!next.sent.some((s) => s.message.customType === WORK_LOST));
});

void test("a reload gap's completion is released by the first agent start when resources_discover never comes", async (t) => {
  const { dir, entries, old, next, options, manager } = await reloadGap(t);
  await old.emit("session_shutdown", { reason: "reload" });
  writeFileSync(join(dir, "go"), "");
  await waitUntil(() => manager().get("j1")?.status === "succeeded", 5000, "the job to exit");

  createJobsExtension(options)(next.pi as any);
  await next.emit("session_start", { reason: "reload" });
  await sleep(50);
  assert.equal(next.sent.length, 0, "held while startup is not over");
  assert.deepEqual(closeReasons(entries), []);

  await next.emit("before_agent_start", { type: "before_agent_start" });
  await waitUntil(() => next.sent.length === 1, 5000, "the completion");
  assert.match(messageText(next.sent[0].message), /^Job j1 succeeded/);
  assert.deepEqual(closeReasons(entries), ["completed"]);
  await next.emit("before_agent_start", { type: "before_agent_start" });
  assert.equal(next.sent.length, 1, "released once");
});

void test("a pending reload handoff of a session this one delegated to raises no notice; another session's still does", async (t) => {
  const dir = tempDir(t);
  const parentId = randomUUID();
  const next = fakePi(false, parentId);
  createJobsExtension({ logRoot: join(dir, "logs"), killGraceMs: 50, drainMs: 50 })(next.pi as any);
  t.after(() => next.emit("session_shutdown", { reason: "quit" }));
  // Suspended by a reload: no token, so nobody owns them until a session takes them back.
  const suspended = (parent?: string) => ({
    version: 4 as const,
    token: undefined,
    parent,
    alive: () => undefined,
    manager: { list: () => [] } as any,
    items: { dispose: () => {} } as any,
  });
  const owners = sessionOwners();
  owners.set("child-of-next", suspended(parentId));
  owners.set("stranger", suspended());
  t.after(() => {
    owners.delete("child-of-next");
    owners.delete("stranger");
  });

  await next.start("reload");

  // The child is reopened by the session that is starting, which takes its owner then; the other
  // session's handoff is still unknown to this one.
  const awaiting = next.notes.filter((note) => /awaiting reload handoff/.test(note.text));
  assert.equal(awaiting.length, 1);
  assert.match(awaiting[0].text, /session stranger is awaiting reload handoff/);
});

void test("a reload records which session delegated the suspended one, so that session knows it will reopen it", async (t) => {
  const dir = tempDir(t);
  const childId = randomUUID();
  const fake = fakePi(false, childId);
  createJobsExtension({ logRoot: join(dir, "logs"), killGraceMs: 50, drainMs: 50 })(fake.pi as any);
  link(childId, { parent: "the-parent" });
  t.after(() => {
    forget(childId);
    sessionOwners().delete(childId);
  });
  await fake.start();
  await fake.emit("session_shutdown", { reason: "reload" });
  const owner = sessionOwners().get(childId);
  assert.equal(owner?.token, undefined, "suspended: nobody owns it until it is taken back");
  assert.equal(owner?.parent, "the-parent");
  clearTimeout(owner?.reloadTimer);
});
