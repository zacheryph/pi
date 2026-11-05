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

// The scenario library itself is tested in packages/pi-scripted-model.
void test("the example scenario loads and registers only when enabled", async () => {
  const { default: scenario } = await import(`${skill}/todo-subagent.ts`);
  const providers = [];
  const pi = { registerProvider: (provider) => providers.push(provider) };
  delete process.env.PI_SCRIPTED_MODEL;
  scenario(pi);
  assert.equal(providers.length, 0);
  process.env.PI_SCRIPTED_MODEL = "1";
  try {
    scenario(pi);
  } finally {
    delete process.env.PI_SCRIPTED_MODEL;
  }
  assert.deepEqual(
    providers.map((p) => p.id),
    ["pi-scripted"],
  );
});
