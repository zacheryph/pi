import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderPage } from "#src/hub/page";

describe("renderPage", () => {
  const page = renderPage("tok_EN-123");

  it("is a complete document with one inline script that parses", () => {
    expect(page.startsWith("<!doctype html>")).toBe(true);
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    expect(scripts).toHaveLength(1);
    expect(() => new Script(scripts[0])).not.toThrow();
  });

  it("embeds the hub token for Focus requests, keeping only token characters", () => {
    expect(page).toContain('<meta name="dashboard-token" content="tok_EN-123">');
    expect(renderPage('"><script>')).toContain('content="script"');
  });

  it("has one modal dialog for stash previews, outside the live-rendered main", () => {
    expect(page).toContain('<main></main>\n<dialog id="preview" class="modal" aria-labelledby="preview-title"></dialog>\n<dialog id="answer" class="modal" aria-labelledby="answer-title"></dialog>');
    expect(page).toContain("modal.showModal()");
    expect(page).toContain('if (event.target === modal) modal.close();');
  });

  it("renders session text through textContent, never innerHTML", () => {
    expect(page).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
    expect(page).toContain("textContent");
  });
});
