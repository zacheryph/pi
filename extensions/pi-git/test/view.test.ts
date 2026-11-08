import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  expectPadded,
  NARROW_WIDTHS,
  WIDE_TEXT,
} from "../../../packages/pi-test-helpers/src/render.ts";
import { ansiTheme, stripAnsi } from "../../../packages/pi-test-helpers/src/theme.ts";
import { Explorer } from "../../../packages/pi-ui/src/index.ts";
import type { GitSnapshotEvent, GitSnapshotPr, GitSnapshotWorktree } from "../src/events.ts";
import { explorerView, LIST_LIMIT, listText, prExplorerView, statusText } from "../src/view.ts";

// Colors every token so width math must ignore escape sequences.
const ansi = ansiTheme as Theme;

const worktree = (overrides: Partial<GitSnapshotWorktree> = {}): GitSnapshotWorktree => ({
  path: "/w/api/feat-login",
  repo: "/src/api",
  branch: "feat/login",
  base: { ref: "main", sha: "a".repeat(40) },
  agents: [],
  state: "active",
  createdAt: Date.UTC(2026, 10, 3),
  updatedAt: Date.UTC(2026, 10, 3),
  ...overrides,
});

const snapshot = (
  worktrees: GitSnapshotWorktree[],
  found: GitSnapshotEvent["found"] = [],
): GitSnapshotEvent => ({ version: 1, worktrees, found, prs: [] });

describe("statusText", () => {
  it("names the state, or the git status of an active worktree", () => {
    expect(statusText(worktree({ state: "removed" }))).toBe("removed");
    expect(statusText(worktree({ state: "missing" }))).toBe("missing: deleted outside Pi");
    expect(statusText(worktree({ error: "boom" }))).toBe("status unknown: boom");
    expect(statusText(worktree())).toBe("active");
    expect(
      statusText(worktree({ status: { dirty: true, detached: 0, unpushed: 3, merged: true } })),
    ).toBe("uncommitted changes; 3 commits on no remote; merged into main");
  });
});

describe("listText", () => {
  it("lists worktrees with their workspace and agents, hiding removed ones", () => {
    const text = listText(
      snapshot([
        worktree({ workspace: "auth", agents: ["0123456789abcdef"] }),
        worktree({ path: "/w/old", state: "removed" }),
      ]),
      false,
    );
    expect(text).toBe(
      [
        "- /w/api/feat-login",
        "  api @ feat/login [workspace auth] — active",
        "  agents: 01234567",
        "(1 removed worktree not shown)",
      ].join("\n"),
    );
  });

  it("caps the listing and names worktrees found outside the ledger", () => {
    const many = Array.from({ length: LIST_LIMIT + 2 }, (_, i) => worktree({ path: `/w/${i}` }));
    const text = listText(snapshot(many, [{ path: "/w/x/y", repo: "/src/web" }]), false);
    expect(text.split("\n").filter((line) => line.startsWith("- /w/")).length).toBe(LIST_LIMIT + 1);
    expect(text).toContain("…and 2 more");
    expect(text).toContain(
      "Under the worktree root but not in this session's ledger:\n- /w/x/y — web",
    );
  });
});

describe("/git:worktrees explorer", () => {
  const make = (view = explorerView(snapshot([worktree()]))) =>
    new Explorer({
      tui: { requestRender: vi.fn(), terminal: { rows: 30, columns: 80 } },
      theme: ansi,
      keys: new KeybindingsManager(TUI_KEYBINDINGS),
      view,
      done: vi.fn(),
    });

  it("groups this session's, removed and other worktrees in tabs", () => {
    const view = explorerView(
      snapshot(
        [worktree(), worktree({ path: "/w/gone", state: "removed" })],
        [{ path: "/w/other", repo: "/src/web", branch: "x" }],
      ),
    );
    expect(view.tabs?.map((tab) => [tab.label, tab.ids])).toEqual([
      ["This session", ["/w/api/feat-login"]],
      ["Removed", ["/w/gone"]],
      ["Other", ["found:/w/other"]],
    ]);
    expect(view.items[0]).toMatchObject({
      label: [
        { text: "api @ feat/login", tone: "accent" },
        { text: " — /w/api/feat-login", tone: "muted" },
      ],
      badge: { text: "active", tone: "success" },
    });
  });

  it("warns in the badge when removal would lose work", () => {
    const view = explorerView(
      snapshot([worktree({ status: { dirty: true, detached: 0, unpushed: 0, merged: false } })]),
    );
    expect(view.items[0].badge).toEqual({ text: "uncommitted changes", tone: "warning" });
  });

  it("opens a worktree's details with its agents and how to use it", async () => {
    const browser = make(
      explorerView(
        snapshot([
          worktree({
            workspace: "auth",
            workspacePath: "/w/auth",
            agents: ["agent-1"],
            createdBy: "agent-0",
          }),
        ]),
      ),
    );
    browser.handleInput("\r");
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const detail = browser.render(80).map(stripAnsi).join("\n");
    expect(detail).toMatch(/Workspace +\/w\/auth/);
    expect(detail).toMatch(/Created by +subagent agent-0/);
    expect(detail).toContain("agent-1");
    expect(detail).toContain('subagent_start { cwd: "/w/auth" }');
  });

  it("keeps body rows padded at every width, with wide and control-laden text", () => {
    const browser = make(
      explorerView(
        snapshot([
          worktree({ branch: `${WIDE_TEXT}\x1b[2J`, path: `/w/${WIDE_TEXT}/\x1b]52;c;evil\x07x` }),
        ]),
      ),
    );
    for (const width of NARROW_WIDTHS) {
      const rows = browser.render(width);
      for (const row of rows.slice(1, -1)) expectPadded(row, width);
      expect(rows.join("\n")).not.toContain("evil");
    }
  });
});

describe("/git:prs explorer", () => {
  const NOW = Date.UTC(2026, 10, 3, 12);
  const pr = (overrides: Partial<GitSnapshotPr> = {}): GitSnapshotPr => ({
    key: "github.com/acme/api#12",
    host: "github.com",
    owner: "acme",
    repo: "api",
    number: 12,
    url: "https://github.com/acme/api/pull/12",
    origin: "created",
    title: "Add login",
    status: {
      state: "open",
      review: "approved",
      checks: { passed: 3, failed: 1, pending: 0 },
      headRef: "feat/login",
      observedAt: NOW - 120_000,
      source: "bash",
    },
    calls: [{ tool: "bash", toolCallId: "c1", at: NOW - 120_000, agentId: "agent-7" }],
    createdAt: NOW - 600_000,
    updatedAt: NOW - 120_000,
    ...overrides,
  });

  it("splits opened and referenced PRs and colors failing checks", () => {
    const view = prExplorerView(
      [
        pr(),
        pr({
          key: "github.com/acme/web#7",
          repo: "web",
          number: 7,
          origin: "referenced",
          status: undefined,
        }),
      ],
      NOW,
    );
    expect(view.tabs?.map((tab) => [tab.label, tab.ids])).toEqual([
      ["Opened here", ["github.com/acme/api#12"]],
      ["Referenced", ["github.com/acme/web#7"]],
    ]);
    expect(view.items[0]).toMatchObject({
      label: [
        { text: "acme/api#12", tone: "accent" },
        { text: " — Add login", tone: "muted" },
      ],
      badge: { text: "open · approved · checks 1 failed, 3 passed", tone: "error" },
    });
    expect(view.items[1].badge).toEqual({ text: "no status seen yet", tone: "dim" });
  });

  it("shows the tool calls that touched a PR in its details", async () => {
    const browser = new Explorer({
      tui: { requestRender: vi.fn(), terminal: { rows: 30, columns: 80 } },
      theme: ansi,
      keys: new KeybindingsManager(TUI_KEYBINDINGS),
      view: prExplorerView([pr()], NOW),
      done: vi.fn(),
    });
    browser.handleInput("\r");
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const detail = browser.render(80).map(stripAnsi).join("\n");
    expect(detail).toMatch(/Branch +feat\/login/);
    expect(detail).toMatch(/Observed +seen 2m ago via bash/);
    expect(detail).toContain("bash · 2m ago · subagent agent-7");
  });

  it("keeps body rows padded at every width, with wide and control-laden titles", () => {
    const browser = new Explorer({
      tui: { requestRender: vi.fn(), terminal: { rows: 30, columns: 80 } },
      theme: ansi,
      keys: new KeybindingsManager(TUI_KEYBINDINGS),
      view: prExplorerView([pr({ title: `${WIDE_TEXT}\x1b]52;c;evil\x07 title` })], NOW),
      done: vi.fn(),
    });
    for (const width of NARROW_WIDTHS) {
      const rows = browser.render(width);
      for (const row of rows.slice(1, -1)) expectPadded(row, width);
      expect(rows.join("\n")).not.toContain("evil");
    }
  });
});
