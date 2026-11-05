import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ansiToHtml,
  cellText,
  color256,
  parseAnsi,
  PALETTE,
} from "../.agents/skills/tui-screenshot/scripts/render-ansi.mjs";

const skill = "../.agents/skills/tui-screenshot/scenarios";

void test("SGR codes become styles on runs, line by line", () => {
  const lines = parseAnsi(
    "\x1b[1mbold\x1b[0m plain\n\x1b[38;5;2mgreen\x1b[39m \x1b[2;3mdim\x1b[0m",
  );
  assert.deepEqual(lines, [
    [
      { text: "bold", style: { bold: true } },
      { text: " plain", style: {} },
    ],
    [
      { text: "green", style: { fg: PALETTE[2] } },
      { text: " ", style: {} },
      { text: "dim", style: { dim: true, italic: true } },
    ],
  ]);
});

void test("256-color, truecolor and background codes resolve to CSS colors", () => {
  assert.equal(color256(4), PALETTE[4]);
  assert.equal(color256(196), "rgb(255,0,0)");
  assert.equal(color256(244), "rgb(128,128,128)");
  const [[run]] = parseAnsi("\x1b[38;2;1;2;3;48;5;0mx");
  assert.deepEqual(run.style, { fg: "rgb(1,2,3)", bg: PALETTE[0] });
});

void test("non-SGR escapes such as titles, links and cursor moves are dropped", () => {
  const input = "\x1b]0;title\x07\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\\x1b[2K\x1b[?25ltext";
  assert.deepEqual(parseAnsi(input), [
    [
      { text: "link", style: {} },
      { text: "text", style: {} },
    ],
  ]);
});

void test("non-ASCII graphemes are boxed at their terminal cell width", () => {
  assert.equal(cellText("a<b"), "a&lt;b");
  assert.equal(cellText("─"), '<span class="w1">─</span>');
  assert.equal(cellText("漢"), '<span class="w2">漢</span>');
  assert.equal(cellText(""), '<span class="w1"></span>');
  assert.match(ansiToHtml("\x1b[1m<x>\x1b[0m"), /^<span style="[^"]*font-weight:700">&lt;x&gt;/);
});

void test("the scenario registers nothing unless the screenshot driver enables it", async () => {
  const { default: scenario } = await import(`${skill}/todo-subagent.ts`);
  const providers = [];
  const pi = { registerProvider: (provider) => providers.push(provider) };
  delete process.env.PI_TUI_SCREENSHOT;
  scenario(pi);
  assert.equal(providers.length, 0);
  process.env.PI_TUI_SCREENSHOT = "1";
  try {
    scenario(pi);
  } finally {
    delete process.env.PI_TUI_SCREENSHOT;
  }
  assert.deepEqual(
    providers.map((p) => p.id),
    ["pi-screenshot"],
  );
});

void test("scripted replies follow the transcript for the main session and subagents", async () => {
  const { defineScenario, startAgent, tool, HOLD } = await import(`${skill}/scenario.ts`);
  const scenario = defineScenario({
    title: "demo-title",
    replies: [[[tool("todo_list", {})], "first done"], [HOLD]],
  });
  // Defined after the scenario: agents are looked up when a request arrives.
  startAgent({
    type: "Plan",
    description: "child",
    prompt: "Child task.",
    steps: [[tool("read", { path: "a" })], "child done"],
  });
  let provider;
  process.env.PI_TUI_SCREENSHOT = "1";
  try {
    scenario({ registerProvider: (p) => (provider = p) });
  } finally {
    delete process.env.PI_TUI_SCREENSHOT;
  }
  const models = provider.getModels();
  const model = (id) => models.find((m) => m.id === id);
  const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
  const assistant = { role: "assistant", content: [], timestamp: 0 };
  const ask = async (messages, id = "screenshot-model", signal) => {
    const result = await provider
      .streamSimple(model(id), { systemPrompt: "", messages }, { signal })
      .result();
    return { stop: result.stopReason, content: result.content };
  };
  const toolNames = ({ content }) =>
    content.filter((c) => c.type === "toolCall").map((c) => c.name);
  const text = ({ content }) => content.map((c) => c.text ?? "").join("");

  assert.deepEqual(toolNames(await ask([user("go")])), ["todo_list"]);
  assert.equal(text(await ask([user("go"), assistant])), "first done");
  assert.equal(
    text(await ask([user("go"), assistant, assistant])),
    "",
    "a turn with no steps ends",
  );
  assert.deepEqual(toolNames(await ask([user("Context.\n\nChild task.")])), ["read"]);
  assert.equal(text(await ask([user("Child task."), assistant])), "child done");

  // HOLD, and a subagent with no steps left, wait until the request is aborted.
  for (const messages of [
    [user("go"), assistant, user("again")],
    [user("Child task."), assistant, assistant],
  ]) {
    const controller = new AbortController();
    const pending = ask(messages, undefined, controller.signal);
    const raced = await Promise.race([pending, new Promise((r) => setTimeout(r, 50, "held"))]);
    assert.equal(raced, "held");
    controller.abort();
    assert.equal((await pending).stop, "aborted");
  }

  assert.equal(
    text(await ask([user("<user_request>\ngo\n</user_request>")], "screenshot-haiku")),
    "demo-title",
  );
  assert.equal(
    JSON.parse(text(await ask([user("summarize")], "screenshot-haiku"))).title,
    "demo-title",
  );
});
