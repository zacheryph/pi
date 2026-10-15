import { strict as assert } from "node:assert";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { MAX_CAMPAIGN_ROWS, renderCampaignWidget, type CampaignRow, type WidgetTheme } from "../src/widget.ts";

const row = (id: string, extra: Partial<CampaignRow> = {}): CampaignRow =>
  ({ id, done: 3, total: 12, blocked: 0, paused: false, checking: false, ...extra });
const ansi: WidgetTheme = { fg: (_color, text) => "\u001b[36m" + text + "\u001b[39m" };
const longId = "network-cutover-" + "x".repeat(48);

test("body rows keep one space on both sides and fill the width exactly", () => {
  const rows = [row(longId, { blocked: 2, paused: true }), row("dns", { checking: true })];
  for (const theme of [undefined, ansi]) {
    for (let width = 3; width <= 100; width++) {
      const [header, ...body] = renderCampaignWidget(rows, width, theme);
      assert.ok(visibleWidth(header) <= width, "header fits at " + width);
      for (const line of body) {
        const text = stripTerminalSequences(line);
        assert.equal(visibleWidth(line), width, "row width at " + width);
        assert.equal(text[0], " ", "left inset at " + width);
        assert.equal(text.at(-1), " ", "right inset at " + width);
      }
    }
  }
});

test("rows are blank when the width cannot fit both padding spaces plus content", () => {
  for (const width of [1, 2]) {
    const [, ...body] = renderCampaignWidget([row("dns")], width, ansi);
    assert.deepEqual(body, [" ".repeat(width)]);
  }
  assert.deepEqual(renderCampaignWidget([row("dns")], 0), []);
});

test("long ids truncate before the progress and blocked status", () => {
  const [, line] = renderCampaignWidget([row(longId, { blocked: 2 })], 50);
  assert.match(line, /…/);
  assert.match(line, /3\/12  ! 2 blocked $/);
});

test("wide Unicode and control characters stay on one row within the width", () => {
  const rows = [row("移行-キャンペーン-データセンター\nsecond"), row("tab\there")];
  for (const width of [7, 13, 24, 41]) {
    const lines = renderCampaignWidget(rows, width, ansi);
    assert.equal(lines.length, 3);
    for (const line of lines.slice(1)) {
      assert.equal(visibleWidth(line), width);
      assert.doesNotMatch(stripTerminalSequences(line), /[\n\t]/);
    }
  }
});

test("overflow collapses extra campaigns into an inset count row", () => {
  const rows = Array.from({ length: MAX_CAMPAIGN_ROWS + 3 }, (_, i) => row("c-" + i));
  const lines = renderCampaignWidget(rows, 40);
  assert.equal(lines.length, 1 + MAX_CAMPAIGN_ROWS);
  assert.equal(lines.at(-1), " " + "+4 more · /campaigns".padEnd(38) + " ");
  assert.equal(renderCampaignWidget(rows.slice(0, MAX_CAMPAIGN_ROWS), 40).length, 1 + MAX_CAMPAIGN_ROWS);
});
