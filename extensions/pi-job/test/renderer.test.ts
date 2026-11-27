import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { JobSnapshot } from "#src/jobs";
import { completionView, createCompletionRenderer, type CompletionDetail } from "#src/renderer";

const job = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
  id: "j1",
  kind: "command",
  command: "sleep 3; echo done",
  cwd: "/repo",
  logPath: "/logs/j1.log",
  startedAt: 0,
  endedAt: 3_000,
  status: "succeeded",
  exitCode: 0,
  timeoutSeconds: 60,
  label: "build",
  ...over,
});

const detail = (over: Partial<JobSnapshot> = {}, text = "one\ntwo\n"): CompletionDetail => ({
  completionId: "c1",
  job: job(over),
  output: { text, truncated: false },
});

/** A theme that marks colours and bold as tags, so the tests read the structure. */
const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
} as never;

const render = (details: unknown, expanded = false, width = 80) => {
  const component = createCompletionRenderer()(
    { role: "custom", customType: "job:completion", content: "", display: true, details } as never,
    { expanded, outputPad: 1 } as never,
    theme,
  );
  return component?.render(width);
};

void test("completionView: collapsed, the facts and the last output line", () => {
  const view = completionView(detail(), false);
  assert.deepEqual(
    { good: view.good, title: view.title, status: view.status },
    { good: true, title: "build", status: "succeeded" },
  );
  assert.deepEqual(
    view.lines.map((line) => line.text),
    ["job j1 · exit 0 · after 3s", "⎿  two"],
  );
});

void test("completionView: expanded, the whole tail, the command and the log", () => {
  const view = completionView(
    {
      ...detail({ status: "timed_out", exitCode: null, error: "killed" }, "a\nb"),
      output: { text: "a\nb", truncated: true },
    },
    true,
  );
  assert.equal(view.good, false);
  assert.equal(view.status, "timed out");
  assert.deepEqual(
    view.lines.map((line) => `${line.color}:${line.text}`),
    [
      "dim:job j1 · after 3s · timeout 60s",
      "error:error: killed",
      "dim:…",
      "dim:a",
      "dim:b",
      "muted:command: sleep 3; echo done",
      "muted:log: /logs/j1.log",
    ],
  );
});

void test("completionView: a watch, no output, a session from before output was kept", () => {
  const watch = completionView(
    detail({ kind: "watch", status: "matched", until: "success", checks: 2, label: undefined }, ""),
    false,
  );
  assert.equal(watch.title, "sleep 3; echo done");
  assert.deepEqual(
    watch.lines.map((line) => line.text),
    ["watch j1 · until success · 2 checks · after 3s", "⎿  (no output)"],
  );
  const old = completionView({ completionId: "c1", job: job() }, false);
  assert.deepEqual(
    old.lines.map((line) => line.text),
    ["job j1 · exit 0 · after 3s"],
  );
});

void test("completionView: terminal controls in the output and the title are stripped", () => {
  const view = completionView(
    detail({ label: "b\u001b[31muild" }, "\u001b]0;title\u0007ok\n"),
    false,
  );
  assert.equal(view.title, "build");
  assert.equal(view.lines.at(-1)?.text, "⎿  ok");
});

void test("renderer: headline, inset lines, one block per completion", () => {
  const lines = render({
    completions: [detail(), detail({ id: "j2", status: "failed", exitCode: 1 })],
  });
  assert.ok(lines);
  const text = lines.map((line) => line.trimEnd()).join("\n");
  assert.equal(
    text,
    [
      " <success>✓</success> <b>build</b> <dim>succeeded</dim>",
      "   <dim>job j1 · exit 0 · after 3s</dim>",
      "   <dim>⎿  two</dim>",
      "",
      " <error>✗</error> <b>build</b> <dim>failed</dim>",
      "   <dim>job j2 · exit 1 · after 3s</dim>",
      "   <dim>⎿  two</dim>",
    ].join("\n"),
  );
});

void test("renderer: fits narrow widths and leaves other messages to Pi", () => {
  for (const width of [12, 30]) {
    for (const line of render({ completions: [detail()] }, true, width) ?? [])
      assert.ok(visibleWidth(line) <= width, `${JSON.stringify(line)} fits ${width}`);
  }
  assert.equal(render(undefined), undefined);
  assert.equal(render({ completions: [] }), undefined);
});
