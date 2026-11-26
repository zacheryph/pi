// @vitest-environment jsdom
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleSnapshot } from "pi-surface/settle";
import type { DeliverySnapshot, SessionSummary, SurfaceRequest, ViewEntry } from "../contract.ts";
import { fixtureResponder, fixtureSnapshot } from "../fixture.ts";
import { duration } from "../ui/format.ts";
import { toAnswer } from "../ui/questionnaire.tsx";
import { SessionList } from "../ui/sessions.tsx";
import {
  countText,
  openQuestionnaires,
  profileName,
  runningAgents,
  sessionModel,
  stashEntries,
  todoProgress,
} from "../views.ts";

afterEach(cleanup);

const THREAD = "thr_demo";
const NOW = Date.UTC(2026, 10, 13, 12);
const fixture = fixtureSnapshot(NOW);

type Source = "live" | "fixture" | "saved";

/** Test handlers take the wire input, as the host hands it over. */
function rpcFor(
  snapshot: DeliverySnapshot | null,
  source: Source = "fixture",
): PluginRpcTestHandlers<PluginRpcContract> {
  const respond = fixtureResponder(NOW);
  const row: SessionSummary = {
    threadId: THREAD,
    source,
    connected: source !== "saved",
    updatedAt: NOW,
    cwd: "/work/webhooks",
    name: "Webhook retry queue",
    profile: "orchestrate",
    status: "tool",
    todos: { done: 3, total: 7, active: "Move retries into the queue worker" },
    runningAgents: 2,
    questions: 1,
    attention: { blocking: 1, owed: 2 },
  };
  return {
    snapshot: (input: unknown) => {
      const { threadId } = input as { threadId: string };
      return {
        snapshot: threadId === THREAD ? snapshot : null,
        source: threadId === THREAD && snapshot ? source : null,
        connected: !!snapshot && source !== "saved",
      };
    },
    sessions: () => ({ sessions: snapshot ? [row] : [] }),
    request: (input: unknown) => ({
      value: (respond((input as { request: SurfaceRequest }).request as never) ?? null) as never,
    }),
  };
}

/** The fixture without some views, or with others in their place. */
function withViews(drop: readonly string[], add: readonly ViewEntry[] = []): DeliverySnapshot {
  return {
    ...fixture,
    views: [...fixture.views.filter((view) => !drop.includes(view.id)), ...add],
  };
}

const app = await loadPluginApp(() => import("../app.tsx"));
const threadComposer = { scope: { kind: "thread" as const, threadId: THREAD } };
const contextProps = {
  threadId: THREAD,
  projectId: "proj",
  environment: null,
  segments: [],
  isExpanded: false,
  onToggle: () => {},
};
const cardProps = { threadId: THREAD, projectId: "proj", environment: null };

function segment(snapshot: DeliverySnapshot) {
  return renderSlot({ component: app.threadContextSegments[0]!.summary }, contextProps, {
    rpc: rpcFor(snapshot),
  });
}

function tab(snapshot: DeliverySnapshot | null, source: Source = "fixture", index = 0) {
  return renderSlot(
    app.tabs[index]! as never,
    { threadId: THREAD, environment: null },
    { rpc: rpcFor(snapshot, source) },
  );
}

/** The Pi Git tab: pull requests, worktrees and stash. */
const gitTab = (snapshot: DeliverySnapshot | null, source: Source = "fixture") =>
  tab(snapshot, source, 1);

const PI_SECTIONS = ["Todos", "Subagents"];
const GIT_SECTIONS = ["Pull requests", "Git worktrees", "Stash"];

/** Section headings in the order the tab draws them. */
function headings(slot: { container: HTMLElement }, labels: readonly string[]): string[] {
  const text = slot.container.textContent ?? "";
  return labels
    .filter((label) => text.includes(label))
    .sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

const requests = (slot: {
  inspection: { rpcCalls: readonly { method: string; input: unknown }[] };
}) =>
  slot.inspection.rpcCalls
    .filter((call) => call.method === "request")
    .map((call) => (call.input as { request: SurfaceRequest }).request);

describe("pi-surface app", () => {
  it("registers one example per slot", () => {
    const [customization] = app.composerCustomizations;
    expect(customization?.banners?.map((banner) => [banner.id, banner.chrome])).toEqual([
      ["todos", "bare"],
      ["subagents", "bare"],
    ]);
    expect(customization?.actions?.map((action) => action.id)).toEqual(["open-session"]);
    expect(customization?.experimental_popups?.map((popup) => popup.id)).toEqual(["stash"]);
    expect(app.threadContextSegments.map((slot) => slot.id)).toEqual(["pi"]);
    expect(app.threadContextCardRows.map((slot) => slot.id)).toEqual(["stash"]);
    expect(app.threadContextCardSections.map((slot) => slot.id)).toEqual(["git"]);
    expect(app.tabs.map((tab) => [tab.id, tab.title, tab.availability, tab.context.kind])).toEqual([
      ["session", "Pi", "fixed", "thread"],
      ["git", "Pi Git", "fixed", "thread"],
    ]);
    expect(app.threadRowMetadata.map((slot) => slot.id)).toEqual(["pi"]);
    expect(app.navPanels.map((panel) => panel.path)).toEqual(["sessions"]);
    expect(app.pendingInteractions.map((slot) => slot.id)).toEqual(["questionnaire"]);
  });

  it("draws the todo.widget view as the Todos stack card", async () => {
    const banner = app.composerCustomizations[0]!.banners![0]!;
    const slot = renderSlot(banner, {}, { rpc: rpcFor(fixture), composer: threadComposer });
    // The test host draws bb's card as a section with its title; bb collapses it.
    const card = await slot.findByTestId("bb-collapsible-stack-card");
    expect(card.dataset.active).toBe("true");
    expect(card.querySelector("h3")?.textContent).toBe("Todos · 1 active / 3 pending");
    const list = await slot.findByRole("list", { name: "Todos" });
    const rows = Array.from(list.querySelectorAll(":scope > li"));
    expect(rows).toHaveLength(7);
    // Each task's state is bb's icon in the leading column.
    expect(rows.map((row) => row.firstElementChild?.getAttribute("aria-label"))).toEqual([
      "done",
      "done",
      "done",
      "active",
      "blocked",
      "pending",
      "pending",
    ]);
    expect(list.textContent).toContain("tests: Retry and dead-letter tests ← worker");
    // The key is bold; a task held by a subagent names it at the right, before its status.
    expect(rows[3]!.querySelector(".font-semibold")?.textContent).toBe("worker");
    expect(rows[3]!.lastElementChild?.textContent).toBe("→ agent a3f2b1c4 · in_progress");
    expect(rows[5]!.lastElementChild?.textContent).toBe("pending");
  });

  it("draws the subagent.widget view as the Subagents stack card", async () => {
    const banner = app.composerCustomizations[0]!.banners![1]!;
    const slot = renderSlot(banner, {}, { rpc: rpcFor(fixture), composer: threadComposer });
    const card = await slot.findByTestId("bb-collapsible-stack-card");
    expect(card.querySelector("h3")?.textContent).toBe("Subagents · 2 active");
    const list = await slot.findByRole("list", { name: "Subagents" });
    expect(list.querySelectorAll(":scope > li")).toHaveLength(2);
    expect(list.textContent).toContain("Map every webhook delivery path");
    expect(list.textContent).toContain("Reading src/admin/replay.ts");
    // The state icon, the clock, the agent type bold with its separator, the activity at the right.
    expect((await slot.findByText("explore")).className).toContain("font-semibold");
    const rows = Array.from(list.querySelectorAll(":scope > li"));
    expect(rows[0]!.children[0]!.getAttribute("aria-label")).toBe("active");
    expect(rows[0]!.children[1]!.textContent).toMatch(/^\d+:\d\d$/);
    expect(rows[0]!.children[2]!.textContent).toBe("explore: Map every webhook delivery path");
    expect(rows[0]!.lastElementChild?.textContent).toBe("Reading src/admin/replay.ts");
  });

  it("draws a saved Subagents card settled: inactive, stopped, no running clock", async () => {
    const saved = settleSnapshot(fixture, NOW);
    const banner = app.composerCustomizations[0]!.banners![1]!;
    const slot = renderSlot(
      banner,
      {},
      {
        rpc: rpcFor(saved, "saved"),
        composer: threadComposer,
      },
    );
    const card = await slot.findByTestId("bb-collapsible-stack-card");
    expect(card.dataset.active).toBe("false");
    expect(card.querySelector("h3")?.textContent).toBe("Subagents");
    const list = await slot.findByRole("list", { name: "Subagents" });
    const rows = Array.from(list.querySelectorAll(":scope > li"));
    expect(rows.map((row) => row.firstElementChild?.getAttribute("aria-label"))).toEqual([
      "stopped",
      "stopped",
    ]);
    expect(rows.map((row) => row.lastElementChild?.textContent)).toEqual(["stopped", "stopped"]);
  });

  it("draws no card for a widget view with nothing to show", async () => {
    const banner = app.composerCustomizations[0]!.banners![1]!;
    const slot = renderSlot(
      banner,
      {},
      {
        rpc: rpcFor(withViews(["subagent.widget"])),
        composer: threadComposer,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.container.textContent).toBe("");
  });

  it("draws a stack card only from a widget view, whatever other kinds share its id", async () => {
    // A newer session might offer the card's id as another kind; it is skipped, not drawn as a widget.
    const other = withViews(
      ["todo.widget"],
      [
        {
          id: "todo.widget",
          kind: "summary",
          title: "Tasks",
          model: { counts: [] },
        },
      ],
    );
    const banner = app.composerCustomizations[0]!.banners![0]!;
    const slot = renderSlot(banner, {}, { rpc: rpcFor(other), composer: threadComposer });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.container.textContent).toBe("");
  });

  it("insets card bodies and the context segment like bb's card header (12px)", async () => {
    // jsdom has no layout; the bb-screenshot skill's `bb-shot.mjs --check`
    // measures the real pixels in bb.
    const classes = (el: Element | null | undefined) => el?.className.split(/\s+/) ?? [];
    for (const [index, name] of [
      [0, "Todos"],
      [1, "Subagents"],
    ] as const) {
      const banner = app.composerCustomizations[0]!.banners![index]!;
      const slot = renderSlot(banner, {}, { rpc: rpcFor(fixture), composer: threadComposer });
      const list = await slot.findByRole("list", { name });
      expect(classes(list)).toEqual(expect.arrayContaining(["px-3", "pt-3"]));
      for (const row of Array.from(list.querySelectorAll(":scope > li"))) {
        expect(classes(row).filter((c) => /^-?(p|px|pl|pr|m|mx|ml|mr)-/.test(c))).toEqual([]);
        // A header-icon-wide leading column, so text starts under the card's title.
        expect(classes(row.firstElementChild)).toEqual(expect.arrayContaining(["size-3.5"]));
      }
      cleanup();
    }
    const button = await segment(fixture).findByRole("button", {
      name: /3\/7 tasks/,
    });
    // bb's CONTEXT_CARD_SEGMENT_CLASS, inside the row's p-1.
    expect(classes(button)).toEqual(expect.arrayContaining(["px-2", "py-1", "min-h-6"]));
  });

  it("reads the context segment from summaries: profile, task progress, running agents, a question", async () => {
    const button = await segment(fixture).findByRole("button", {
      name: /orchestrate/,
    });
    expect(button.textContent).toBe("orchestrate · 3/7 tasks · 2 agents · question");
  });

  it("keeps the context segment's counts when the session hides its widgets", async () => {
    const hidden = withViews([
      "todo.widget",
      "subagent.widget",
      "todo.explorer",
      "subagent.explorer",
    ]);
    const button = await segment(hidden).findByRole("button", {
      name: /orchestrate/,
    });
    expect(button.textContent).toBe("orchestrate · 3/7 tasks · 2 agents · question");
  });

  it("names the main agent's profile when it has no subagents", async () => {
    const quiet = withViews(
      ["subagent.summary", "subagent.widget", "subagent.explorer", "todo.summary", "ask.questions"],
      [
        {
          id: "subagent.summary",
          kind: "summary",
          title: "Subagents",
          model: {
            counts: [
              { key: "running", label: "running", value: 0, live: true },
              { key: "total", label: "subagents", value: 0 },
            ],
            profile: { name: "review", label: "Reviewer" },
          },
        },
      ],
    );
    const button = await segment(quiet).findByRole("button", {
      name: /Reviewer/,
    });
    expect(button.textContent).toBe("Reviewer");
    const header = (await tab(quiet).findByRole("heading", { level: 2 })).parentElement!;
    expect(header.textContent).toContain("Reviewer · Claude Opus");
  });

  it("renders nothing without a session, in every thread slot", async () => {
    const empty = rpcFor(null);
    const banner = renderSlot(
      app.composerCustomizations[0]!.banners![0]!,
      {},
      { rpc: empty, composer: threadComposer },
    );
    const row = renderSlot(app.threadContextCardRows[0]!, cardProps, {
      rpc: empty,
    });
    const section = renderSlot(app.threadContextCardSections[0]!, cardProps, {
      rpc: empty,
    });
    const seg = renderSlot({ component: app.threadContextSegments[0]!.summary }, contextProps, {
      rpc: empty,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const slot of [banner, row, section, seg]) expect(slot.container.textContent).toBe("");
  });

  it("shows the stash count from stash.summary and the Git explorers' items in the context card", async () => {
    const row = renderSlot(app.threadContextCardRows[0]!, cardProps, {
      rpc: rpcFor(fixture),
    });
    const stash = (await row.findByText("Stash")).closest("button");
    expect(stash?.textContent).toContain("4");
    // The tooltip is the summary's own count text, the size formatted as one.
    expect(stash?.getAttribute("title")).toBe("4 entries · 25.3 KiB on this branch");
    const section = renderSlot(app.threadContextCardSections[0]!, cardProps, {
      rpc: rpcFor(fixture),
    });
    expect(await section.findByText("webhooks @ feat/retry-worker")).toBeTruthy();
    expect(section.container.textContent).toContain("uncommitted changes; 3 unpushed commits");
    // The pull requests opened here and still in play, with their status as the badge; a row
    // opens its URL. Merged and referenced ones are left to the Pi Git tab.
    for (const label of ["acme/webhooks#212", "acme/webhooks#214"])
      expect(await section.findByText(label)).toBeTruthy();
    for (const label of ["acme/webhooks#209", "acme/platform#88"])
      expect(section.queryByText(label)).toBeNull();
    expect(section.container.textContent).toContain("draft · checks 1 failed, 2 pending, 9 passed");
    fireEvent.click(await section.findByText("acme/webhooks#212"));
    expect(section.inspection.navigateCalls).toContainEqual({
      method: "openUrl",
      url: "https://github.com/acme/webhooks/pull/212",
    });
  });

  it("hides the stash row and Git section when their views are empty or missing", async () => {
    const bare = withViews(["stash.summary", "git.worktrees", "git.prs"]);
    const row = renderSlot(app.threadContextCardRows[0]!, cardProps, {
      rpc: rpcFor(bare),
    });
    const section = renderSlot(app.threadContextCardSections[0]!, cardProps, {
      rpc: rpcFor(bare),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(row.container.textContent).toBe("");
    expect(section.container.textContent).toBe("");
  });

  it("inserts the picked stash handle into the draft from the popup", async () => {
    const popup = app.composerCustomizations[0]!.experimental_popups![0]!;
    const slot = renderSlot(popup, {}, { rpc: rpcFor(fixture), composer: threadComposer });
    const filter = await slot.findByRole("combobox", {
      name: "Filter stash entries",
    });
    expect(slot.getAllByRole("option")).toHaveLength(4);
    fireEvent.change(filter, { target: { value: "review" } });
    expect(slot.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(slot.inspection.composer.text).toBe("stash:review-notes@3f9c2a81d0e4 ");
  });

  it("says a thread without stash views has no stash", async () => {
    const popup = app.composerCustomizations[0]!.experimental_popups![0]!;
    const slot = renderSlot(
      popup,
      {},
      {
        rpc: rpcFor(withViews(["stash.explorer", "stash.summary"])),
        composer: threadComposer,
      },
    );
    expect(await slot.findByText("This thread has no Pi stash.")).toBeTruthy();
  });

  it("opens the Pi tab from the composer action", async () => {
    const action = app.composerCustomizations[0]!.actions![0]!;
    const openTab = vi.fn(() => true);
    const slot = renderSlot(
      action,
      {},
      {
        rpc: rpcFor(fixture),
        composer: threadComposer,
        experimental_panel: { openTab },
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Open the Pi session tab" }));
    expect(openTab).toHaveBeenCalledWith({
      tab: {
        id: "session",
        context: { kind: "thread" },
        availability: "fixed",
      },
    });
  });

  it("opens the Pi Git tab from the context card's stash row", async () => {
    const openTab = vi.fn(() => true);
    const row = renderSlot(app.threadContextCardRows[0]!, cardProps, {
      rpc: rpcFor(fixture),
      experimental_panel: { openTab },
    });
    fireEvent.click(await row.findByText("Stash"));
    expect(openTab).toHaveBeenCalledWith({
      tab: { id: "git", context: { kind: "thread" }, availability: "fixed" },
    });
  });

  it("draws the Pi tab's header, activity and usage from the system.session view", async () => {
    const slot = tab(fixture);
    const heading = await slot.findByRole("heading", {
      level: 2,
      name: "Webhook retry queue",
    });
    expect(heading.parentElement!.textContent).toContain(
      "Running bash · orchestrate · Claude Opus · thinking high · context 42%",
    );
    expect(await slot.findByText("Recent activity")).toBeTruthy();
    expect(slot.container.textContent).toContain("npm test -- test/deliver.test.ts");
    expect(slot.container.textContent).toContain("running");
    expect(await slot.findByText("Usage")).toBeTruthy();
    expect(slot.container.textContent).toContain("$4.87");
    expect(await slot.findByText("Open questions")).toBeTruthy();
    expect(slot.container.textContent).toContain("Which failures should be retried?");
  });

  it("draws the Pi tab without a system view: the other views and a plain header", async () => {
    const slot = tab(withViews(["system.session"]));
    expect(await slot.findByRole("heading", { level: 2, name: "Pi session" })).toBeTruthy();
    expect(slot.container.textContent).toContain("Connected · orchestrate");
    for (const section of PI_SECTIONS) expect(await slot.findByText(section)).toBeTruthy();
    expect(slot.queryByText("Usage")).toBeNull();
    expect(slot.queryByText("Recent activity")).toBeNull();
  });

  it("draws every explorer but Git's and the stash's in the Pi tab, loading details through actions", async () => {
    const slot = tab(fixture);
    for (const section of PI_SECTIONS) expect(await slot.findByText(section)).toBeTruthy();
    for (const section of GIT_SECTIONS) expect(slot.queryByText(section)).toBeNull();
    fireEvent.click(await slot.findByText("worker: Move retries into the queue worker"));
    expect(
      await slot.findByText(/Worker picks up due attempts; wiring the ack path now\./, {
        selector: "li",
      }),
    ).toBeTruthy();
    // Opening a task with an unreviewed message reviews it, as the terminal does.
    fireEvent.click(await slot.findByText("schema: Add the delivery_attempts table"));
    expect(requests(slot)).toEqual(
      expect.arrayContaining([
        { action: "todo.inspect", args: { id: "worker" } },
        { action: "todo.review", args: { branch: 1, ids: ["schema"] } },
      ]),
    );
  });

  it("draws pull requests, worktrees and stash in the Pi Git tab, in that order", async () => {
    const slot = gitTab(fixture);
    for (const section of GIT_SECTIONS) expect(await slot.findByText(section)).toBeTruthy();
    expect(headings(slot, GIT_SECTIONS)).toEqual(GIT_SECTIONS);
    for (const section of PI_SECTIONS) expect(slot.queryByText(section)).toBeNull();
    expect(slot.queryByRole("heading", { level: 2 })).toBeNull();
    fireEvent.click(await slot.findByText("stash:review-notes@3f9c2a81d0e4"));
    expect(await slot.findByText(/delivery_attempts needs an index/)).toBeTruthy();
    expect(requests(slot)).toEqual([
      {
        action: "stash.inspect",
        args: { id: "stash:review-notes@3f9c2a81d0e4" },
      },
    ]);
  });

  it("says when the session has nothing for the Pi Git tab", async () => {
    const slot = gitTab(withViews(["git.prs", "git.worktrees", "stash.explorer"]));
    expect(
      await slot.findByText("This session has no pull requests, worktrees or stash entries yet."),
    ).toBeTruthy();
  });

  it("filters pull requests by All, Draft, Open and Approved, the rest under More", async () => {
    const slot = gitTab(fixture);
    const shown = () =>
      ["#212", "#214", "#209", "#88"].filter((pr) => slot.container.textContent?.includes(pr));
    expect(await slot.findByText("acme/webhooks#212")).toBeTruthy();
    expect(slot.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(
      expect.arrayContaining(["All", "Draft", "Open", "Approved"]),
    );
    expect(shown()).toEqual(["#212", "#214"]);
    fireEvent.click(slot.getByRole("tab", { name: "Draft" }));
    expect(shown()).toEqual(["#212"]);
    fireEvent.click(slot.getByRole("tab", { name: "Open" }));
    expect(shown()).toEqual(["#214"]);
    fireEvent.click(slot.getByRole("tab", { name: "Approved" }));
    expect(shown()).toEqual(["#214"]);
    const more = slot.getByRole("combobox", { name: "More Pull requests filters" });
    expect(
      Array.from(more.querySelectorAll("option:not([disabled])")).map((o) => o.textContent),
    ).toEqual(["Closed", "Other"]);
    fireEvent.change(more, { target: { value: "4" } });
    expect(shown()).toEqual(["#209"]);
    for (const name of ["All", "Draft", "Open", "Approved"])
      expect(slot.getByRole("tab", { name }).getAttribute("aria-selected")).toBe("false");
    fireEvent.change(more, { target: { value: "5" } });
    expect(shown()).toEqual(["#88"]);
  });

  it("expands and collapses every pull request in view from the section heading", async () => {
    const slot = gitTab(fixture);
    fireEvent.click(await slot.findByRole("button", { name: "Expand all Pull requests" }));
    for (const pr of ["212", "214"])
      expect(
        await slot.findByRole("button", { name: `https://github.com/acme/webhooks/pull/${pr}` }),
      ).toBeTruthy();
    // Only the filter in view opens: merged and referenced pull requests stay closed.
    for (const url of [
      "https://github.com/acme/webhooks/pull/209",
      "https://github.com/acme/platform/pull/88",
    ])
      expect(slot.queryByRole("button", { name: url })).toBeNull();
    fireEvent.change(slot.getByRole("combobox", { name: "More Pull requests filters" }), {
      target: { value: "5" },
    });
    expect(slot.getByRole("button", { name: "Expand all Pull requests" })).toBeTruthy();
    fireEvent.click(slot.getByRole("tab", { name: "All" }));
    fireEvent.click(slot.getByRole("button", { name: "Collapse all Pull requests" }));
    expect(slot.queryByRole("button", { name: /^https:\/\/github\.com/ })).toBeNull();
    // Other sections stay as they were.
    expect(slot.getByRole("button", { name: "Expand all Git worktrees" })).toBeTruthy();
  });

  it("shows an action's failure where its detail would be", async () => {
    const failing = withViews(
      ["todo.explorer"],
      [
        {
          id: "todo.explorer",
          kind: "explorer",
          title: "Todos",
          model: {
            title: "Todos",
            items: [{ id: "ghost", label: "ghost: A task that is gone" }],
            loadDetail: { action: "todo.inspect" },
          },
        },
      ],
    );
    const slot = tab(failing);
    fireEvent.click(await slot.findByText("ghost: A task that is gone"));
    expect((await slot.findByRole("alert")).textContent).toContain('No task "ghost"');
  });

  it("opens only included details of a saved session, asking nothing of Pi", async () => {
    const slot = tab(settleSnapshot(fixture, NOW), "saved");
    const heading = await slot.findByRole("heading", { level: 2 });
    expect(heading.parentElement!.textContent).toContain("Not running");
    // Live state settled: running agents read stopped, and no question is listed.
    expect(slot.getAllByText("stopped")).toHaveLength(2);
    expect(slot.queryByText("Open questions")).toBeNull();
    fireEvent.click(await slot.findByText("worker: Move retries into the queue worker"));
    fireEvent.click(await slot.findByText(/Review the attempts schema/));
    expect(await slot.findByText("Two findings, stashed as review-notes.")).toBeTruthy();
    expect(requests(slot)).toEqual([]);
  });

  it("skips views of kinds it does not draw in the Pi tab", async () => {
    const newer = withViews([], [
      {
        id: "future.timeline",
        kind: "timeline",
        title: "Timeline",
        model: { lanes: [] },
      },
      {
        id: "future.broken",
        kind: "hologram",
        title: "Hologram",
        error: "Not drawn",
      },
    ] as unknown as ViewEntry[]);
    const slot = tab(newer);
    for (const section of PI_SECTIONS) expect(await slot.findByText(section)).toBeTruthy();
    for (const title of ["Timeline", "Hologram", "Not drawn"])
      expect(slot.queryByText(title)).toBeNull();
  });

  it("opens inline details, and a pull request's URL in bb", async () => {
    const slot = gitTab(fixture);
    fireEvent.click(await slot.findByText("acme/webhooks#212"));
    fireEvent.click(
      await slot.findByRole("button", {
        name: "https://github.com/acme/webhooks/pull/212",
      }),
    );
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openUrl",
      url: "https://github.com/acme/webhooks/pull/212",
    });
  });

  it("shows why a view is missing", async () => {
    const broken: DeliverySnapshot = {
      id: "fixture",
      views: [
        {
          id: "git.prs",
          kind: "explorer",
          title: "Pull requests",
          error: "Too large",
        },
      ],
    };
    expect((await gitTab(broken).findByRole("alert")).textContent).toBe("Too large");
  });

  it("titles the stash row with the producer's singular label and a formatted size", async () => {
    const one = withViews(
      ["stash.summary"],
      [
        {
          id: "stash.summary",
          kind: "summary",
          title: "Stash",
          model: {
            counts: [
              { key: "entries", label: "entry", value: 1 },
              { key: "versions", label: "version", value: 1, tone: "muted" },
              { key: "bytes", label: "on this branch", value: 887, unit: "bytes", tone: "muted" },
            ],
          },
        },
      ],
    );
    const row = renderSlot(app.threadContextCardRows[0]!, cardProps, { rpc: rpcFor(one) });
    const stash = (await row.findByText("Stash")).closest("button");
    expect(stash?.textContent).toContain("1");
    expect(stash?.getAttribute("title")).toBe("1 entry · 887 B on this branch");
  });

  it("reads count text as the producer labels it, sizes formatted as sizes", () => {
    const git = {
      counts: [
        { key: "worktrees", label: "worktree", value: 1 },
        { key: "prs", label: "pull requests", value: 2 },
      ],
    };
    expect(countText(git, "worktrees")).toBe("1 worktree");
    expect(countText(git, "prs")).toBe("2 pull requests");
    expect(countText(git, "missing")).toBeUndefined();
    expect(countText(undefined, "worktrees")).toBeUndefined();
    const stash = fixture.views.find((view) => view.id === "stash.summary")!.model as never;
    expect(countText(stash, "entries")).toBe("4 entries");
    expect(countText(stash, "bytes")).toBe("25.3 KiB on this branch");
    expect(countText(stash, "store-bytes")).toBe("25.3 KiB in the store");
    expect(countText(stash, "store-max-bytes")).toBe("50.0 MiB store cap");
  });

  it("agrees the sessions page's running agents with their number", () => {
    const session: SessionSummary = {
      threadId: THREAD,
      source: "live",
      connected: true,
      updatedAt: NOW,
      status: "working",
      runningAgents: 1,
      questions: 0,
      attention: { blocking: 0, owed: 0 },
    };
    const one = render(<SessionList sessions={[session]} onOpen={() => {}} now={NOW} />);
    expect(one.container.textContent).toContain("Working · 1 agent running");
    expect(one.container.textContent).not.toContain("agents");
    cleanup();
    const two = render(
      <SessionList sessions={[{ ...session, runningAgents: 2 }]} onOpen={() => {}} now={NOW} />,
    );
    expect(two.container.textContent).toContain("Working · 2 agents running");
  });

  it("lists sessions with their profile and counts, and badges rows with a question and running agents", async () => {
    const page = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpcFor(fixture, "live") });
    const list = await page.findByRole("list", { name: "Pi sessions" });
    expect(list.textContent).toContain("Webhook retry queue");
    expect(list.textContent).toContain("orchestrate");
    expect(list.textContent).toContain(
      "Running a tool · 3/7 tasks · 2 agents running · question waiting",
    );
    expect(list.textContent).toContain("Move retries into the queue worker");
  });

  it("sends every question's answer as one submission from the questionnaire form", async () => {
    const submit = vi.fn(async () => {});
    const [{ questionnaire }] = openQuestionnaires(fixture) as [
      ReturnType<typeof openQuestionnaires>[number],
    ];
    const slot = renderSlot(
      app.pendingInteractions[0]!,
      {
        interaction: {
          id: "int_1",
          threadId: THREAD,
          title: "Retry policy",
          payload: questionnaire as never,
          createdAt: NOW,
          expiresAt: null,
        },
        submit,
        cancel: vi.fn(async () => {}),
      },
      {},
    );
    fireEvent.click(await slot.findByRole("button", { name: /^8/ }));
    const send = slot.getByRole("button", {
      name: "Send answers",
    }) as HTMLButtonElement;
    // pi-ask takes an answer to every question or none.
    expect(send.disabled).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: /^Timeouts/ }));
    fireEvent.click(slot.getByRole("button", { name: /^429/ }));
    fireEvent.change(slot.getByRole("textbox", { name: /Which failures/ }), {
      target: { value: "also 408" },
    });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit).toHaveBeenCalledWith({
      answers: [
        { questionIndex: 0, optionIndexes: [1] },
        { questionIndex: 1, optionIndexes: [1, 2], text: "also 408" },
      ],
    });
  });

  it("draws no form for a payload that is not a form questionnaire", async () => {
    const slot = renderSlot(
      app.pendingInteractions[0]!,
      {
        interaction: {
          id: "int_2",
          threadId: THREAD,
          title: "Old",
          payload: {
            id: "q",
            questions: [{ header: "x", question: "y", options: [] }],
          } as never,
          createdAt: NOW,
          expiresAt: null,
        },
        submit: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
      },
      {},
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.container.textContent).toBe("");
  });
});

describe("helpers", () => {
  it("reads counts, profile and questions from views, and formats durations", () => {
    expect(todoProgress(fixture)).toEqual({
      done: 3,
      total: 7,
      active: "Move retries into the queue worker",
    });
    expect(runningAgents(fixture)).toBe(2);
    expect(runningAgents(settleSnapshot(fixture, NOW))).toBe(0);
    expect(profileName(fixture)).toBe("orchestrate");
    expect(stashEntries(fixture)).toBe(4);
    expect(sessionModel(fixture)?.name).toBe("Webhook retry queue");
    expect(
      openQuestionnaires(fixture).map(({ view, questionnaire }) => [view, questionnaire.id]),
    ).toEqual([["ask.questions", "fixture-ask-1"]]);
    const empty: DeliverySnapshot = { id: "x", views: [] };
    expect([
      todoProgress(empty),
      runningAgents(empty),
      profileName(empty),
      stashEntries(empty),
    ]).toEqual([undefined, 0, undefined, 0]);
    expect([duration(42_000), duration(6 * 60_000), duration(125 * 60_000)]).toEqual([
      "42s",
      "6m",
      "2h 5m",
    ]);
    expect(toAnswer([{ options: [], text: " " }], "")).toEqual({ answers: [] });
  });
});

describe("gallery", () => {
  it("draws the experiment-only slots from a fixture session on the plugin's page", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "gallery" }, { rpc: rpcFor(fixture) });
    expect(await slot.findByText("Thread context card: row and section")).toBeTruthy();
    expect(await slot.findByText("webhooks @ feat/retry-worker")).toBeTruthy();
    expect(await slot.findByRole("form", { name: "Pi's questions" })).toBeTruthy();
  });
});
