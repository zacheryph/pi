/** Unit tests for job_watch tool checks (local addition): toolcheck.ts, probe.ts, watch.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startProbe, type ProbeOutcome } from "../src/probe.ts";
import {
  assertWatchable,
  canonicalJson,
  createToolProbe,
  evaluateMatch,
  getPath,
  globMatch,
  parseAllowList,
  parseToolCheck,
  resultData,
  toolCheckTitle,
  type ExecuteTool,
  type ToolCallOutcome,
} from "../src/toolcheck.ts";
import { evaluateWatch, type CheckResult } from "../src/watch.ts";

const ok = (structuredContent?: unknown, text = ""): ToolCallOutcome => ({
  isError: false,
  result: { content: [{ type: "text", text }], structuredContent },
});
const err = (text: string): ToolCallOutcome => ({
  isError: true,
  result: { content: [{ type: "text", text }] },
});
const signal = new AbortController().signal;

void test("parseToolCheck validates shape and keeps at most one predicate", () => {
  assert.deepEqual(parseToolCheck({ tool: " probe " }), { tool: "probe", args: {} });
  assert.deepEqual(
    parseToolCheck({ tool: "p", args: { a: 1 }, match: { path: "s", equals: "done" } }),
    { tool: "p", args: { a: 1 }, match: { path: "s", equals: "done" } },
  );
  assert.deepEqual(parseToolCheck({ tool: "p", match: { path: "s" } }).match, { path: "s" });
  assert.throws(() => parseToolCheck("probe"), /must be an object/);
  assert.throws(() => parseToolCheck({ tool: "" }), /tool must be a tool name/);
  assert.throws(() => parseToolCheck({ tool: "p", args: [] }), /args must be an object/);
  assert.throws(() => parseToolCheck({ tool: "p", match: { equals: 1 } }), /string path/);
  assert.throws(
    () => parseToolCheck({ tool: "p", match: { path: "s", equals: 1, contains: "x" } }),
    /at most one/,
  );
  assert.throws(
    () => parseToolCheck({ tool: "p", match: { path: "s", in: "x" } }),
    /in must be an array/,
  );
  assert.throws(
    () => parseToolCheck({ tool: "p", match: { path: "s", contains: 3 } }),
    /contains must be a string/,
  );
});

void test("allow list globs", () => {
  assert.deepEqual(parseAllowList(" mcp__github__* , ,probe "), ["mcp__github__*", "probe"]);
  assert.deepEqual(parseAllowList(undefined), []);
  assert.ok(globMatch("mcp__github__*", "mcp__github__get_check_run"));
  assert.ok(!globMatch("mcp__github__*", "mcp__gitlab__x"));
  assert.ok(globMatch("a.b", "a.b"));
  assert.ok(!globMatch("a.b", "aXb"), "dots are literal");
});

void test("assertWatchable: read-only or allow-listed tools only; never commands, codemode or jobs", () => {
  const tools = [
    { name: "ro", annotations: { readOnlyHint: true } },
    { name: "rw" },
    { name: "mcp__github__get", annotations: {} },
    { name: "orchestrate", exposure: "model-only", annotations: { readOnlyHint: true } },
    { name: "bash", annotations: { readOnlyHint: true } },
  ];
  assertWatchable("ro", tools, []);
  assertWatchable("mcp__github__get", tools, ["mcp__github__*"]);
  assert.throws(
    () => assertWatchable("rw", tools, []),
    /not marked read-only.*PI_JOBS_WATCH_TOOLS/,
  );
  assert.throws(() => assertWatchable("missing", tools, ["*"]), /Unknown tool missing/);
  assert.throws(() => assertWatchable("orchestrate", tools, ["*"]), /exposure model-only/);
  for (const name of ["bash", "edit", "write", "codemode", "job_list", "job_start"]) {
    assert.throws(() => assertWatchable(name, tools, ["*"]), /cannot be a watch check/, name);
  }
});

void test("canonicalJson sorts keys at every level", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } }),
    '{"a":{"c":null,"d":[2,{"x":0,"y":1}]},"b":1}',
  );
  assert.equal(canonicalJson(undefined), "null");
});

void test("getPath and evaluateMatch", () => {
  const data = {
    check_runs: [{ status: "completed", conclusion: "success", name: "lint" }],
    total: 1,
  };
  assert.deepEqual(getPath(data, "check_runs.0.status"), { found: true, value: "completed" });
  assert.deepEqual(getPath(data, ""), { found: true, value: data });
  assert.equal(getPath(data, "check_runs.1.status").found, false);
  assert.equal(getPath(data, "total.x").found, false);
  assert.equal(getPath({ constructor: 1 }, "toString").found, false, "own properties only");
  assert.equal(
    evaluateMatch({ path: "check_runs.0.status", equals: "completed" }, data).holds,
    true,
  );
  assert.equal(evaluateMatch({ path: "check_runs.0.status", equals: "queued" }, data).holds, false);
  assert.equal(
    evaluateMatch({ path: "check_runs.0.conclusion", in: ["failure", "success"] }, data).holds,
    true,
  );
  assert.equal(
    evaluateMatch(
      {
        path: "check_runs.0",
        equals: { name: "lint", status: "completed", conclusion: "success" },
      },
      data,
    ).holds,
    true,
    "key order ignored",
  );
  assert.equal(evaluateMatch({ path: "check_runs.0.name", contains: "in" }, data).holds, true);
  assert.equal(
    evaluateMatch({ path: "check_runs", contains: '"lint"' }, data).holds,
    true,
    "non-strings as JSON",
  );
  assert.equal(
    evaluateMatch({ path: "total" }, data).holds,
    true,
    "path alone: holds when present",
  );
  assert.deepEqual(evaluateMatch({ path: "nope" }, data), {
    holds: false,
    found: false,
    value: undefined,
  });
});

void test("resultData prefers structured content, then JSON text, then text", () => {
  assert.deepEqual(resultData(ok({ a: 1 }, "ignored")), { a: 1 });
  assert.deepEqual(resultData(ok(undefined, '{"b":2}')), { b: 2 });
  assert.equal(resultData(ok(undefined, "plain")), "plain");
});

void test("tool probe: verdicts, selected output, and errors as inconclusive until the limit", async () => {
  const answers: Array<ToolCallOutcome | Error> = [
    ok({ s: "queued", at: 1 }),
    ok({ s: "done", at: 2 }),
    err("rate limited"),
    err("rate limited"),
    ok({ s: "done", at: 3 }),
    err("x"),
    err("x"),
    err("x"),
  ];
  const calls: Array<{ name: string; args: unknown }> = [];
  const execute: ExecuteTool = async (name, args) => {
    calls.push({ name, args });
    const next = answers.shift()!;
    if (next instanceof Error) throw next;
    return next;
  };
  const probe = createToolProbe(
    { tool: "probe", args: { ref: "abc" }, match: { path: "s", equals: "done" } },
    execute,
    3,
  );
  assert.deepEqual(
    await probe.run(signal),
    { exitCode: 1, output: 's = "queued"\ncondition does not hold' },
    "output is the selected value, not the timestamp",
  );
  assert.deepEqual(await probe.run(signal), { exitCode: 0, output: 's = "done"\ncondition holds' });
  const e1 = await probe.run(signal);
  assert.equal(e1.error, "probe failed: rate limited");
  assert.equal(e1.final, false);
  assert.equal((await probe.run(signal)).final, false);
  assert.equal((await probe.run(signal)).exitCode, 0, "a success resets the error count");
  await probe.run(signal);
  await probe.run(signal);
  const last = await probe.run(signal);
  assert.equal(last.final, true);
  assert.match(last.error!, /3 consecutive check errors; giving up/);
  assert.deepEqual(calls[0], { name: "probe", args: { ref: "abc" } });
});

void test("tool probe without match: success is a successful call; output is the canonical result", async () => {
  const probe = createToolProbe({ tool: "p", args: {} }, async () => ok({ b: 1, a: 2 }));
  assert.deepEqual(await probe.run(signal), { exitCode: 0, output: '{\n  "a": 2,\n  "b": 1\n}' });
});

void test("tool probe: a stale context ends the watch at once with a re-arm hint", async () => {
  const probe = createToolProbe({ tool: "p", args: {} }, async () => {
    throw new Error("This extension ctx is stale after session replacement or reload.");
  });
  const r = await probe.run(signal);
  assert.equal(r.final, true);
  assert.match(r.error!, /reloaded or replaced.*Start it again/);
});

void test("tool probe passes the check's abort signal to the tool call", async () => {
  let seen: AbortSignal | undefined;
  const controller = new AbortController();
  await createToolProbe(
    { tool: "p", args: {} },
    async (_n, _a, o) => ((seen = o.signal), ok({})),
  ).run(controller.signal);
  assert.equal(seen, controller.signal);
});

void test("toolCheckTitle is short and shows the condition", () => {
  assert.equal(
    toolCheckTitle({ tool: "p", args: { b: 1, a: 2 }, match: { path: "s", equals: "done" } }),
    'tool:p {"a":2,"b":1} · s == "done"',
  );
  assert.equal(
    toolCheckTitle({ tool: "p", args: { x: "y".repeat(200) } }).length,
    "tool:p ".length + 120,
  );
});

void test("startProbe: one outcome; terminate wins over a late result; errors are inconclusive", async () => {
  const outcomes: ProbeOutcome[] = [];
  const output: string[] = [];
  let resolve!: (v: { exitCode: number; output: string }) => void;
  const run = startProbe(
    { run: () => new Promise((r) => (resolve = r)) },
    (c) => output.push(c.toString()),
    (o) => outcomes.push(o),
  );
  await new Promise((r) => setImmediate(r));
  run.terminate();
  resolve({ exitCode: 0, output: "late" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(outcomes, [{ exitCode: null, signal: null }]);
  assert.deepEqual(output, [], "late output is dropped");

  const done: ProbeOutcome[] = [];
  startProbe(
    { run: async () => ({ exitCode: 1, output: "o", error: "boom", final: true }) },
    () => {},
    (o) => done.push(o),
  );
  startProbe(
    {
      run: async () => {
        throw new Error("threw");
      },
    },
    () => {},
    (o) => done.push(o),
  );
  startProbe(
    { run: async () => ({ exitCode: 0, output: "fine" }) },
    () => {},
    (o) => done.push(o),
  );
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(done, [
    { exitCode: null, signal: null, error: "boom", inconclusive: true, final: true },
    { exitCode: null, signal: null, error: "threw", inconclusive: true },
    { exitCode: 0, signal: null },
  ]);

  const disposed: ProbeOutcome[] = [];
  startProbe(
    { run: () => new Promise(() => {}) },
    () => {},
    (o) => disposed.push(o),
  ).dispose();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(disposed, [], "dispose reports nothing");
});

void test("evaluateWatch: an inconclusive check never matches and never sets the change baseline", () => {
  const r = (over: Partial<CheckResult>): CheckResult => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    output: "",
    outputHash: "h1",
    ...over,
  });
  assert.deepEqual(evaluateWatch("success", r({ inconclusive: true }), undefined), {
    matched: false,
    baseline: undefined,
  });
  assert.deepEqual(evaluateWatch("change", r({ exitCode: null, inconclusive: true }), undefined), {
    matched: false,
    baseline: undefined,
  });
  const first = evaluateWatch("change", r({}), undefined);
  assert.deepEqual(
    evaluateWatch(
      "change",
      r({ exitCode: null, outputHash: "h2", inconclusive: true }),
      first.baseline,
    ),
    { matched: false, baseline: first.baseline },
  );
  assert.equal(evaluateWatch("change", r({ outputHash: "h2" }), first.baseline).matched, true);
});
