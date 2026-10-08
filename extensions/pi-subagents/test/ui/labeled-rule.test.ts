import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { labeledRule } from "#src/ui/labeled-rule";

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/** Leaves the rule unstyled, so outputs compare as plain strings. */
const plain = (rule: string): string => rule;

const POSITION = "142 lines · 87%";
const HINTS = "↑↓ scroll · PgUp/PgDn · Esc close";

describe("labeledRule", () => {
  describe("fit", () => {
    it("embeds a left label after a two-dash lead-in and fills the rest", () => {
      expect(labeledRule(30, plain, ["Subagent session"])).toBe(`── Subagent session ${"─".repeat(10)}`);
    });

    it("embeds a right label before a two-dash trailer", () => {
      expect(labeledRule(80, plain, [POSITION], [HINTS])).toBe(
        `── ${POSITION} ${"─".repeat(24)} ${HINTS} ──`,
      );
    });

    it("keeps both labels at the narrowest width that leaves one dash between them", () => {
      // 3 + 15 + 1 + 1 + 1 + 33 + 3 = 57
      expect(labeledRule(57, plain, [POSITION], [HINTS])).toBe(`── ${POSITION} ─ ${HINTS} ──`);
    });
  });

  describe("fallback", () => {
    it("drops the right label before the left one falls back, even when a shorter left label would fit with it", () => {
      expect(labeledRule(50, plain, [POSITION, "142"], [HINTS])).toBe(`── ${POSITION} ${"─".repeat(31)}`);
    });

    it("drops the right label one column below the width that fits both", () => {
      expect(labeledRule(56, plain, [POSITION], [HINTS])).toBe(`── ${POSITION} ${"─".repeat(37)}`);
    });

    it("tries the left candidates in order, taking the first that fits", () => {
      const candidates = ["Explore  review the diff · anthropic/claude-sonnet-5", "Explore · anthropic/claude-sonnet-5", "Explore"];
      expect(labeledRule(60, plain, candidates)).toBe(`── ${candidates[0]} ${"─".repeat(4)}`);
      expect(labeledRule(45, plain, candidates)).toBe(`── ${candidates[1]} ${"─".repeat(6)}`);
      expect(labeledRule(20, plain, candidates)).toBe(`── Explore ${"─".repeat(9)}`);
    });
  });

  describe("truncation", () => {
    it("truncates the last left candidate with an ellipsis when none fits", () => {
      // pi-tui's truncateToWidth brackets the ellipsis in SGR resets; compare the visible text.
      expect(stripAnsi(labeledRule(12, plain, ["Subagent session"]))).toBe("── Subage… ─");
    });
  });

  describe("painting", () => {
    it("styles only the rule's own characters, never the labels", () => {
      const bracket = (rule: string): string => `<${rule}>`;
      expect(labeledRule(40, bracket, [POSITION], ["hints"])).toBe(`<── >${POSITION}< ${"─".repeat(12)} >hints< ──>`);
    });
  });

  describe("width", () => {
    const cases: Array<[string, string[], string[]]> = [
      ["left only", ["Subagent session"], []],
      ["left and right", [POSITION], [HINTS]],
      ["left fallbacks", ["Explore  review the diff · anthropic/claude-sonnet-5", "Explore"], []],
      ["wide glyphs", ["审查 the diff"], ["↑↓"]],
    ];

    it.each(cases)("spans exactly the width it is given (%s)", (_name, left, right) => {
      for (let width = 6; width <= 120; width++) {
        expect(visibleWidth(labeledRule(width, plain, left, right)), `width ${width}`).toBe(width);
      }
    });
  });
});
