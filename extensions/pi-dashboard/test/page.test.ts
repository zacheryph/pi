import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderPage } from "#src/hub/page";

describe("renderPage", () => {
  const page = renderPage();

  it("is a complete document with one inline script that parses", () => {
    expect(page.startsWith("<!doctype html>")).toBe(true);
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    expect(scripts).toHaveLength(1);
    expect(() => new Script(scripts[0])).not.toThrow();
  });

  it("renders session text through textContent, never innerHTML", () => {
    expect(page).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
    expect(page).toContain("textContent");
  });
});
