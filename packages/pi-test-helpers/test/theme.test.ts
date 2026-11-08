import { expect, it } from "vitest";
import { ansiTheme, plainLines, plainTheme, stripAnsi } from "#src/theme.ts";

it("plain leaves text alone; ansi wraps it in escape codes that strip back", () => {
  expect(plainTheme.fg("accent", plainTheme.bold("x"))).toBe("x");
  const styled = ansiTheme.fg("accent", ansiTheme.bold("x"));
  expect(styled).not.toBe("x");
  expect(stripAnsi(styled)).toBe("x");
  expect(stripAnsi("\x1b[31ma\x1b[0m\x1b[2J")).toBe("a\x1b[2J");
  expect(plainLines([styled, "y"])).toBe("x\ny");
});
