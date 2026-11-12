/**
 * Delivery against the real pi AgentSession (installed runtime) with the faux model provider.
 * Skipped when no installed runtime can be resolved (override: PI_RUNTIME_DIR).
 * Completions travel as custom messages through Pi's run boundaries (see packages/pi-work/src/delivery.ts): the
 * transcript is the inbox, so these tests assert what is in the transcript and what the model saw.
 * Two tests reproduce pi-side races on the idle path and are skipped with a pointer to
 * UPSTREAM-ISSUES.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobsExtension, CUSTOM_TYPE } from "#src/extension";
import type { JobManager } from "#src/jobs";
import { sleep, tempDir, waitUntil } from "#test/helpers";
import { piAiEntry, runtimeDirectory } from "#test/runtime";

const RUNTIME = runtimeDirectory();
const available = RUNTIME !== undefined && existsSync(join(RUNTIME, "dist/index.js"));
const skip = available
  ? false
  : "pi runtime not found; install @earendil-works/pi-coding-agent or set PI_RUNTIME_DIR";
const upstream = (n: number, what: string) =>
  available ? `pi-side race, see UPSTREAM-ISSUES.md #${n}: ${what}` : skip;

let providerSeq = 0;

interface HarnessOptions {
  /** Extra extension, loaded after pi-job (so its handlers run after ours). */
  extra?: (pi: any) => void;
  /** Extra extension, loaded before pi-job (so its handlers run before ours). */
  before?: (pi: any) => void;
}

async function harness(t: Parameters<typeof tempDir>[0], opts: HarnessOptions = {}) {
  const pc: any = await import(join(RUNTIME!, "dist/index.js"));
  const ai: any = await import(piAiEntry(RUNTIME)!);
  const dir = tempDir(t);
  const agentDir = join(dir, "agent");
  const faux = ai.fauxProvider({
    provider: `pijobs-faux-${process.pid}-${++providerSeq}`,
    models: [{ id: "m1" }],
  });
  const modelRuntime = await pc.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = pc.SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1 },
    retry: { enabled: false },
  });
  let manager!: JobManager;
  /** Extension errors, as bound by the session. */
  const errors: unknown[] = [];
  /** Model contexts after all `context` handlers (what the model actually sees). */
  const contexts: any[][] = [];
  const recorder = (pi: any) => pi.on("context", async (e: any) => void contexts.push(e.messages));
  const ext = createJobsExtension({
    logRoot: join(dir, "logs"),
    killGraceMs: 300,
    drainMs: 200,
    onManager: (m) => (manager = m),
  });
  const resourceLoader = new pc.DefaultResourceLoader({
    cwd: dir,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    noExtensions: true,
    extensionFactories: [
      ...(opts.before ? [opts.before] : []),
      ext,
      ...(opts.extra ? [opts.extra] : []),
      recorder,
    ],
  });
  await resourceLoader.reload();
  const sessionManager = pc.SessionManager.inMemory(dir);
  const { session } = await pc.createAgentSession({
    cwd: dir,
    agentDir,
    model: faux.getModel(),
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    noTools: "builtin",
    sessionManager,
    settingsManager,
  });
  // As Pi's print mode binds the extensions: session_start (the work host is provided there).
  await session.bindExtensions({ mode: "print", onError: (error: unknown) => errors.push(error) });
  t.after(async () => {
    try {
      await session.abort();
    } catch {}
    session.dispose();
    await manager?.shutdown(200);
  });
  const completions = () =>
    session.messages.filter((m: any) => m.role === "custom" && m.customType === CUSTOM_TYPE);
  const assistantTexts = () =>
    session.messages
      .filter((m: any) => m.role === "assistant")
      .map((m: any) =>
        m.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join(""),
      );
  /** Most completion messages showing `marker` in any one model context so far. */
  const maxSeen = (marker: string) =>
    Math.max(
      0,
      ...contexts.map(
        (c) =>
          c.filter(
            (m: any) =>
              m.role === "custom" &&
              m.customType === CUSTOM_TYPE &&
              JSON.stringify(m.content).includes(marker),
          ).length,
      ),
    );
  /**
   * A model response that blocks until released or aborted (a long streaming turn).
   * `entered` resolves once pi is inside it, i.e. the turn is provably streaming.
   */
  const blocking = () => {
    let release!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((r) => (markEntered = r));
    const step = (_ctx: unknown, options: { signal?: AbortSignal } | undefined) =>
      new Promise((resolve) => {
        release = () => resolve(ai.fauxAssistantMessage("busy done"));
        options?.signal?.addEventListener(
          "abort",
          () => resolve(ai.fauxAssistantMessage("", { stopReason: "aborted" })),
          { once: true },
        );
        markEntered();
      });
    return { step, entered, release: () => release() };
  };
  const reply = (text: string) => () => ai.fauxAssistantMessage(text);
  const startJob = (command: string) =>
    ai.fauxAssistantMessage([ai.fauxToolCall("job_start", { command, timeoutSeconds: 20 })], {
      stopReason: "toolUse",
    });
  /** A job command that finishes only once the test touches `name` in the session dir. */
  const gated = (name: string, marker: string) =>
    `while [ ! -f ${name} ]; do sleep 0.05; done; echo ${marker}`;
  const open = (name: string) => writeFileSync(join(dir, name), "");
  return {
    session,
    faux,
    ai,
    dir,
    errors,
    manager: () => manager,
    completions,
    assistantTexts,
    maxSeen,
    contexts,
    blocking,
    reply,
    startJob,
    gated,
    open,
  };
}

async function idle(session: any, ms = 5000) {
  await waitUntil(() => session.isIdle, ms, "session idle");
}

for (const [name, escape] of [
  ["Escape (clearQueue + abort)", true],
  ["RPC abort", false],
] as const) {
  void test(
    `completion during a streaming turn survives ${name}: in the transcript, no turn forced, seen once by the next run`,
    { skip },
    async (t) => {
      const h = await harness(t);
      const busy = h.blocking();
      h.faux.setResponses([
        h.startJob(h.gated("go", "ESC-DONE")),
        busy.step,
        ...[1, 2, 3].map(() => h.reply("woken")),
      ]);
      const run = h.session.prompt("go");
      await busy.entered;
      h.open("go");
      await waitUntil(
        () => h.manager().get("j1")?.status === "succeeded",
        5000,
        "job to finish while the turn streams",
      );
      if (escape) h.session.clearQueue();
      await h.session.abort();
      await run;
      await idle(h.session);
      await sleep(300);
      assert.equal(h.completions().length, 1, "the completion is in the transcript");
      assert.equal(h.contexts.length, 2, "Escape forces no turn");
      assert.ok(!h.assistantTexts().includes("woken"));
      assert.equal(h.maxSeen("ESC-DONE"), 0, "the model has not seen it yet");
      // The next run, the user's, sees it.
      await h.session.prompt("next");
      await idle(h.session);
      assert.equal(h.completions().length, 1);
      assert.equal(h.maxSeen("ESC-DONE"), 1);
    },
  );
}

void test(
  "a completion during a streaming turn reaches the model in that same run",
  { skip },
  async (t) => {
    const h = await harness(t);
    const busy = h.blocking();
    h.faux.setResponses([
      h.startJob(h.gated("go", "SAME-RUN")),
      busy.step,
      h.reply("answered in the run"),
      h.reply("must not run"),
    ]);
    const run = h.session.prompt("go");
    await busy.entered;
    h.open("go");
    await waitUntil(() => h.manager().get("j1")?.status === "succeeded", 5000, "job");
    busy.release();
    await run; // prompt() resolves once the whole run, continuation included, has settled
    await idle(h.session);
    await sleep(300);
    assert.ok(h.assistantTexts().includes("answered in the run"));
    assert.ok(!h.assistantTexts().includes("must not run"));
    assert.equal(h.contexts.length, 3, "one extra model request, no second run");
    assert.equal(h.completions().length, 1);
    assert.equal(h.maxSeen("SAME-RUN"), 1);
  },
);

void test(
  "clearQueue right after the turn ended cannot drop the completion: it is answered in the run",
  { skip },
  async (t) => {
    let session: any;
    let armed = false;
    // Runs after pi-job's handlers, at the end of the last turn: Escape.
    const escapeAtEnd = (pi: any) =>
      pi.on("agent_end", async () => {
        if (armed) {
          armed = false;
          session.clearQueue();
        }
      });
    const h = await harness(t, { extra: escapeAtEnd });
    session = h.session;
    const busy = h.blocking();
    h.faux.setResponses([
      h.startJob(h.gated("go", "DROP-DONE")),
      busy.step,
      ...[1, 2, 3].map(() => h.reply("woken")),
    ]);
    const run = h.session.prompt("go");
    await busy.entered;
    h.open("go");
    await waitUntil(() => h.manager().get("j1")?.status === "succeeded", 5000, "job");
    armed = true;
    busy.release();
    await run;
    await idle(h.session);
    await sleep(300);
    assert.ok(h.assistantTexts().includes("woken"), "the completion was answered");
    assert.equal(h.completions().length, 1);
    assert.equal(h.maxSeen("DROP-DONE"), 1);
  },
);

void test(
  "an abort at the end of the turn leaves one copy of the completion; the next run sees it once",
  { skip },
  async (t) => {
    let session: any;
    let armed = false;
    const abortAtEnd = (pi: any) =>
      pi.on("agent_end", async () => {
        if (armed) {
          armed = false;
          void session.abort();
        }
      });
    const h = await harness(t, { extra: abortAtEnd });
    session = h.session;
    const busy = h.blocking();
    h.faux.setResponses([
      h.startJob(h.gated("go", "STRANDED-DONE")),
      busy.step,
      ...[1, 2, 3, 4, 5].map(() => h.reply("ok")),
    ]);
    const run = h.session.prompt("go");
    await busy.entered;
    h.open("go");
    await waitUntil(() => h.manager().get("j1")?.status === "succeeded", 5000, "job");
    armed = true;
    busy.release();
    await run;
    await idle(h.session);
    await sleep(300);
    assert.equal(h.completions().length, 1, "exactly one copy, however the abort raced");
    await h.session.prompt("next");
    await idle(h.session);
    assert.equal(h.completions().length, 1);
    assert.equal(
      h.maxSeen("STRANDED-DONE"),
      1,
      "the model must never see the same completion twice",
    );
  },
);

void test(
  "a completion during manual compaction starts no run; it is in the transcript and the next run sees it once",
  { skip },
  async (t) => {
    const h = await harness(t);
    const summary = h.blocking();
    h.faux.setResponses([
      h.startJob(h.gated("go", "COMPACT-DONE")),
      h.reply("started"),
      summary.step, // the first compaction request blocks
      // Compaction may make one more summarization call; anything else is a run.
      ...[1, 2].map(
        () => () => h.ai.fauxAssistantMessage(h.session.isCompacting ? "summary" : "next run"),
      ),
    ]);
    await h.session.prompt("go");
    const compaction = h.session.compact().catch((e: Error) => e);
    await summary.entered; // compaction is calling the model
    h.open("go"); // the job finishes only now, while compaction is in progress
    await waitUntil(
      () => h.manager().get("j1")?.status === "succeeded",
      5000,
      "job to finish during compaction",
    );
    assert.equal(
      h.session.isStreaming,
      false,
      "a completion started an agent run during compaction",
    );
    summary.release();
    const result = await compaction;
    assert.ok(!(result instanceof Error), String(result));
    await idle(h.session);
    await sleep(300);
    assert.ok(!h.assistantTexts().includes("next run"), "nothing woke the agent");
    assert.equal(h.completions().length, 1, "the completion is in the transcript");
    await h.session.prompt("next");
    await idle(h.session);
    assert.equal(h.completions().length, 1);
    assert.equal(h.maxSeen("COMPACT-DONE"), 1);
  },
);

void test(
  "completions that finish during one turn arrive as one message each and are answered by one request",
  { skip },
  async (t) => {
    const h = await harness(t);
    const busy = h.blocking();
    h.faux.setResponses([
      h.ai.fauxAssistantMessage(
        [
          h.ai.fauxToolCall("job_start", { command: "echo BATCH-A", timeoutSeconds: 20 }),
          h.ai.fauxToolCall("job_start", {
            command: "sleep 0.1; echo BATCH-B",
            timeoutSeconds: 20,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      busy.step,
      h.reply("woken once"),
      h.reply("must not run"),
    ]);
    const run = h.session.prompt("go");
    await busy.entered;
    await waitUntil(
      () => ["j1", "j2"].every((id) => h.manager()?.get(id)?.status === "succeeded"),
      5000,
      "both jobs",
    );
    busy.release();
    await run;
    await idle(h.session);
    await sleep(300);
    assert.ok(h.assistantTexts().includes("woken once"));
    assert.equal(h.contexts.length, 3, "one request answers both completions");
    assert.equal(h.completions().length, 2);
    assert.equal(h.maxSeen("BATCH-A"), 1);
    assert.equal(h.maxSeen("BATCH-B"), 1);
    const last = JSON.stringify(h.contexts[2]);
    assert.match(last, /BATCH-A/);
    assert.match(last, /BATCH-B/);
  },
);

void test(
  "compaction started by an earlier agent_settled handler: the already recorded completion starts no run in it",
  { skip },
  async (t) => {
    let compactOnSettle = false;
    let compactionDone!: () => void;
    const compacted = new Promise<void>((r) => (compactionDone = r));
    // Loaded before pi-job: starts a compaction from agent_settled, then yields. The compaction
    // is slowed down.
    const compactor = (pi: any) => {
      pi.on("agent_settled", async (_e: unknown, ctx: any) => {
        if (!compactOnSettle) return;
        compactOnSettle = false;
        ctx.compact({ onComplete: () => compactionDone(), onError: () => compactionDone() });
        await sleep(10);
      });
      pi.on("session_before_compact", async () => {
        await sleep(80);
      });
    };
    const h = await harness(t, { before: compactor });
    const busy = h.blocking();
    let runDuringCompaction = false;
    const probe = () => {
      if (h.session.isCompacting && h.session.isStreaming) runDuringCompaction = true;
      return h.ai.fauxAssistantMessage(h.session.isCompacting ? "summary" : "woken");
    };
    h.faux.setResponses([
      h.startJob(h.gated("go", "EARLY-DONE")),
      busy.step,
      ...[1, 2, 3, 4, 5].map(() => probe),
    ]);
    const run = h.session.prompt("go");
    await busy.entered;
    h.open("go");
    await waitUntil(
      () => h.manager().get("j1")?.status === "succeeded",
      5000,
      "job (recorded: a run is active)",
    );
    compactOnSettle = true;
    await h.session.abort(); // the settle that starts the compaction
    await run;
    await compacted;
    await idle(h.session);
    await sleep(300);
    assert.equal(runDuringCompaction, false, "a run started during the compaction");
    assert.ok(!h.assistantTexts().includes("woken"), "an abort forces no turn");
    assert.equal(h.maxSeen("EARLY-DONE"), 0);
    // The next run sees the completion, whether the compaction kept it as a message or folded
    // it into its summary.
    await h.session.prompt("next");
    await idle(h.session);
    assert.equal(h.maxSeen("EARLY-DONE"), 1);
  },
);

void test(
  "a completion during branch summarization (/tree) starts no run and is recorded once",
  { skip },
  async (t) => {
    let releaseTree: (() => void) | undefined;
    let markTreeEntered!: () => void;
    const treeEntered = new Promise<void>((r) => (markTreeEntered = r));
    const slowTree = (pi: any) =>
      pi.on("session_before_tree", async () => {
        markTreeEntered();
        await new Promise<void>((r) => (releaseTree = r));
      });
    const h = await harness(t, { extra: slowTree });
    let runDuringSummary = false;
    const probe = () => {
      if (h.session.isCompacting && h.session.isStreaming) runDuringSummary = true;
      return h.ai.fauxAssistantMessage(h.session.isCompacting ? "branch summary" : "woken");
    };
    h.faux.setResponses([
      h.startJob(h.gated("go", "TREE-DONE")),
      h.reply("started"),
      ...[1, 2, 3, 4].map(() => probe),
    ]);
    await h.session.prompt("go");
    const firstUser = h.session.sessionManager
      .getEntries()
      .find((e: any) => e.type === "message" && e.message.role === "user");
    const nav = h.session.navigateTree(firstUser.id, { summarize: true });
    await treeEntered; // pi is busy summarizing the branch
    h.open("go");
    await waitUntil(
      () => h.manager().get("j1")?.status === "succeeded",
      5000,
      "job during the tree navigation",
    );
    releaseTree!();
    const result = await nav;
    assert.equal(result.cancelled, false);
    await idle(h.session);
    await sleep(300);
    assert.equal(runDuringSummary, false);
    assert.ok(!h.assistantTexts().includes("woken"), "nothing woke the agent");
    // Recorded where the session stood when it arrived. The navigation then moved the leaf to an
    // earlier node, so this completion belongs to the branch the user left (see the README).
    const recorded = h.session.sessionManager
      .getEntries()
      .filter((e: any) => e.type === "custom_message" && e.customType === CUSTOM_TYPE);
    assert.equal(recorded.length, 1, "the completion is in the session file, once");
  },
);

void test(
  "prompt race: a completion while a prompt is still preparing loses the user's prompt",
  { skip: upstream(1, "no atomic run reservation") },
  async (t) => {
    let gate!: () => void;
    let armed = false;
    const slowBeforeStart = (pi: any) =>
      pi.on("before_agent_start", async () => {
        if (armed) await new Promise<void>((r) => (gate = r));
      });
    const h = await harness(t, { extra: slowBeforeStart });
    const wake = h.blocking(); // the completion's run is still streaming when the prompt continues
    h.faux.setResponses([
      h.startJob(h.gated("go", "RACE-DONE")),
      h.reply("started"),
      wake.step,
      ...[1, 2, 3].map(() => h.reply("ok")),
    ]);
    await h.session.prompt("go");
    armed = true;
    const user = h.session.prompt("USER-PROMPT").then(
      () => undefined,
      (e: Error) => e,
    );
    await waitUntil(() => gate !== undefined, 2000, "prompt preparing");
    h.open("go");
    await waitUntil(() => h.manager().get("j1")?.status === "succeeded", 5000, "job");
    await wake.entered; // the completion's run is streaming
    gate();
    const error = await user;
    wake.release();
    await idle(h.session);
    assert.equal(error, undefined, `user prompt failed: ${error}`);
    assert.ok(
      JSON.stringify(h.session.messages).includes("USER-PROMPT"),
      "the user's prompt must not be lost",
    );
  },
);

void test(
  "deferred settled action runs during a compaction started by a LATER agent_settled handler",
  { skip: upstream(2, "deferred actions are not revalidated") },
  async (t) => {
    // Deterministic and independent of pi-job (which no longer sends from agent_settled): a waker
    // whose agent_settled handler sends a triggerTurn message, then a one-shot compactor after it,
    // history that can be compacted (keepRecentTokens: 1), and a compaction slowed by
    // session_before_compact.
    let compactOnSettle = false;
    let compactionDone!: () => void;
    const compacted = new Promise<void>((r) => (compactionDone = r));
    let wakeOnSettle = false;
    const compactor = (pi: any) => {
      pi.on("agent_settled", async () => {
        if (!wakeOnSettle) return;
        wakeOnSettle = false;
        pi.sendMessage({ customType: "x", content: "wake", display: true }, { triggerTurn: true });
      });
      pi.on("agent_settled", async (_e: unknown, ctx: any) => {
        if (!compactOnSettle) return;
        compactOnSettle = false;
        ctx.compact({ onComplete: () => compactionDone(), onError: () => compactionDone() });
      });
      pi.on("session_before_compact", async () => {
        await sleep(80);
      });
    };
    const h = await harness(t, { extra: compactor });
    const busy = h.blocking();
    let runDuringCompaction = false;
    const probe = () => {
      if (h.session.isCompacting && h.session.isStreaming) runDuringCompaction = true;
      return h.ai.fauxAssistantMessage(h.session.isCompacting ? "summary" : "ok");
    };
    h.faux.setResponses([
      h.startJob(h.gated("go", "DEFER-DONE")),
      busy.step,
      ...[1, 2, 3, 4, 5].map(() => probe),
    ]);
    const run = h.session.prompt("go");
    await busy.entered;
    h.open("go");
    await waitUntil(() => h.manager().get("j1")?.status === "succeeded", 5000, "job");
    compactOnSettle = true;
    wakeOnSettle = true;
    await h.session.abort(); // the wake is sent from agent_settled: a deferred action
    await run;
    await compacted;
    await idle(h.session);
    assert.equal(
      runDuringCompaction,
      false,
      "an agent run executed while compaction was in progress",
    );
  },
);
