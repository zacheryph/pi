// @vitest-environment jsdom
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshot, SurfaceRequest } from "../contract.ts";
import { fixtureResponder, fixtureSnapshot } from "../fixture.ts";
import { toAnswer } from "../ui/questionnaire.tsx";
import { duration, todoCounts } from "../ui/format.ts";

afterEach(cleanup);

const THREAD = "thr_demo";
const NOW = Date.UTC(2026, 10, 13, 12);
const fixture = fixtureSnapshot(NOW);

/** Test handlers take the wire input, as the host hands it over. */
function rpcFor(snapshot: SessionSnapshot | null): PluginRpcTestHandlers<PluginRpcContract> {
  const respond = fixtureResponder(NOW);
  return {
    snapshot: (input: unknown) => {
      const { threadId } = input as { threadId: string };
      return {
        snapshot: threadId === THREAD ? snapshot : null,
        source: threadId === THREAD && snapshot ? "fixture" : null,
        connected: !!snapshot,
      };
    },
    sessions: () => ({
      sessions: snapshot
        ? [
            {
              threadId: THREAD,
              source: "fixture" as const,
              connected: true,
              updatedAt: NOW,
              cwd: snapshot.cwd,
              name: snapshot.name!,
              agent: snapshot.agent!,
              status: snapshot.status.kind,
              todos: { done: 3, total: 7, active: "Move retries into the queue worker" },
              runningAgents: 2,
              questions: 1,
            },
          ]
        : [],
    }),
    request: (input: unknown) => ({
      data: respond((input as { request: SurfaceRequest }).request),
    }),
  };
}

const app = await loadPluginApp(() => import("../app.tsx"));
const threadComposer = { scope: { kind: "thread" as const, threadId: THREAD } };

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
    expect(app.tabs.map((tab) => [tab.id, tab.availability, tab.context.kind])).toEqual([
      ["session", "fixed", "thread"],
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

  it("draws no card for a widget view with nothing to show", async () => {
    const quiet = {
      ...fixture,
      views: fixture.views!.filter((view) => view.id !== "subagent.widget"),
    };
    const banner = app.composerCustomizations[0]!.banners![1]!;
    const slot = renderSlot(banner, {}, { rpc: rpcFor(quiet), composer: threadComposer });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.container.textContent).toBe("");
  });

  it("draws a stack card only from a widget view, whatever other kinds share its id", async () => {
    // A newer session might offer the card's id as another kind; it is skipped, not drawn as a widget.
    const other = {
      ...fixture,
      views: [
        ...fixture.views!.filter((view) => view.id !== "todo.widget"),
        { id: "todo.widget", kind: "summary", title: "Tasks", model: { counts: [] } },
      ] as unknown as SessionSnapshot["views"],
    };
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
    const props = {
      threadId: THREAD,
      projectId: "proj",
      environment: null,
      segments: [],
      isExpanded: false,
      onToggle: () => {},
    };
    const segment = renderSlot({ component: app.threadContextSegments[0]!.summary }, props, {
      rpc: rpcFor(fixture),
    });
    const button = await segment.findByRole("button", { name: /3\/7 tasks/ });
    // bb's CONTEXT_CARD_SEGMENT_CLASS, inside the row's p-1.
    expect(classes(button)).toEqual(expect.arrayContaining(["px-2", "py-1", "min-h-6"]));
  });

  it("renders nothing without a session, in every thread slot", async () => {
    const empty = rpcFor(null);
    const banner = renderSlot(
      app.composerCustomizations[0]!.banners![0]!,
      {},
      {
        rpc: empty,
        composer: threadComposer,
      },
    );
    const props = { threadId: THREAD, projectId: "proj", environment: null };
    const row = renderSlot(app.threadContextCardRows[0]!, props, { rpc: empty });
    const section = renderSlot(app.threadContextCardSections[0]!, props, { rpc: empty });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(banner.container.textContent).toBe("");
    expect(row.container.textContent).toBe("");
    expect(section.container.textContent).toBe("");
  });

  it("shows the stash count row and the worktree and pull request rows in the context card", async () => {
    const props = { threadId: THREAD, projectId: "proj", environment: null };
    const row = renderSlot(app.threadContextCardRows[0]!, props, { rpc: rpcFor(fixture) });
    expect((await row.findByText("Stash")).closest("button")?.textContent).toContain("4");
    const section = renderSlot(app.threadContextCardSections[0]!, props, { rpc: rpcFor(fixture) });
    expect(await section.findByText("feat/retry-worker")).toBeTruthy();
    expect(await section.findByText("#212 Retry webhooks from the queue worker")).toBeTruthy();
    expect(section.container.textContent).toContain("✓9 ✗1 ●2");
  });

  it("inserts the picked stash handle into the draft from the popup", async () => {
    const popup = app.composerCustomizations[0]!.experimental_popups![0]!;
    const slot = renderSlot(popup, {}, { rpc: rpcFor(fixture), composer: threadComposer });
    const filter = await slot.findByRole("combobox", { name: "Filter stash entries" });
    fireEvent.change(filter, { target: { value: "review" } });
    expect(slot.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(slot.inspection.composer.text).toBe("stash:review-notes@3f9c2a81d0e4 ");
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
      tab: { id: "session", context: { kind: "thread" }, availability: "fixed" },
    });
  });

  it("draws every explorer view in the Pi tab, loading details through actions", async () => {
    const tab = app.tabs[0]!;
    const slot = renderSlot(
      tab as never,
      { threadId: THREAD, environment: null },
      { rpc: rpcFor(fixture) },
    );
    for (const section of ["Todos", "Subagents", "Stash", "Git worktrees", "Pull requests"])
      expect(await slot.findByText(section)).toBeTruthy();
    fireEvent.click(await slot.findByText("worker: Move retries into the queue worker"));
    expect(
      await slot.findByText(/Worker picks up due attempts; wiring the ack path now\./, {
        selector: "li",
      }),
    ).toBeTruthy();
    // Opening a task with an unreviewed message reviews it, as the terminal does.
    fireEvent.click(await slot.findByText("schema: Add the delivery_attempts table"));
    fireEvent.click(await slot.findByText("stash:review-notes@3f9c2a81d0e4"));
    expect(await slot.findByText(/delivery_attempts needs an index/)).toBeTruthy();
    const actions = slot.inspection.rpcCalls
      .filter((call) => call.method === "request")
      .map((call) => (call.input as { request: { id?: string; args?: unknown } }).request);
    expect(actions).toEqual(
      expect.arrayContaining([
        { command: "action", id: "todo.inspect", args: { id: "worker" } },
        { command: "action", id: "todo.review", args: { branch: 1, ids: ["schema"] } },
        {
          command: "action",
          id: "stash.inspect",
          args: { id: "stash:review-notes@3f9c2a81d0e4" },
        },
      ]),
    );
  });

  it("skips views of kinds it does not draw in the Pi tab", async () => {
    const newer = {
      ...fixture,
      views: [
        ...fixture.views!,
        {
          id: "system.session",
          kind: "session",
          title: "Session",
          model: { sessionId: "s", cwd: "/w", status: { kind: "idle", since: 1 }, startedAt: 1 },
        },
        { id: "ask.questions", kind: "form", title: "Questions", model: { questionnaires: [] } },
        { id: "future.timeline", kind: "timeline", title: "Timeline", model: { lanes: [] } },
        { id: "future.broken", kind: "hologram", title: "Hologram", error: "Not drawn" },
      ] as unknown as SessionSnapshot["views"],
    };
    const slot = renderSlot(
      app.tabs[0]! as never,
      { threadId: THREAD, environment: null },
      { rpc: rpcFor(newer) },
    );
    for (const section of ["Todos", "Subagents", "Stash", "Git worktrees", "Pull requests"])
      expect(await slot.findByText(section)).toBeTruthy();
    for (const title of ["Session", "Questions", "Timeline", "Hologram", "Not drawn"])
      expect(slot.queryByText(title)).toBeNull();
  });

  it("opens inline details, and a pull request's URL in bb", async () => {
    const slot = renderSlot(
      app.tabs[0]! as never,
      { threadId: THREAD, environment: null },
      { rpc: rpcFor(fixture) },
    );
    fireEvent.click(await slot.findByText("acme/webhooks#212"));
    fireEvent.click(
      await slot.findByRole("button", { name: "https://github.com/acme/webhooks/pull/212" }),
    );
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openUrl",
      url: "https://github.com/acme/webhooks/pull/212",
    });
  });

  it("shows why a view is missing", async () => {
    const broken = {
      ...fixture,
      views: [
        { id: "git.prs", kind: "explorer" as const, title: "Pull requests", error: "Too large" },
      ],
    };
    const slot = renderSlot(
      app.tabs[0]! as never,
      { threadId: THREAD, environment: null },
      { rpc: rpcFor(broken) },
    );
    expect((await slot.findByRole("alert")).textContent).toBe("Too large");
  });

  it("sends every question's answer as one submission from the questionnaire form", async () => {
    const submit = vi.fn(async () => {});
    const slot = renderSlot(
      app.pendingInteractions[0]!,
      {
        interaction: {
          id: "int_1",
          threadId: THREAD,
          title: "Pi's questions",
          payload: fixture.questions![0]! as never,
          createdAt: NOW,
          expiresAt: null,
        },
        submit,
        cancel: vi.fn(async () => {}),
      },
      {},
    );
    fireEvent.click(await slot.findByRole("button", { name: /^8/ }));
    fireEvent.click(slot.getByRole("button", { name: /^Timeouts/ }));
    fireEvent.click(slot.getByRole("button", { name: /^429/ }));
    fireEvent.change(slot.getByRole("textbox", { name: /Which failures/ }), {
      target: { value: "also 408" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Send answers" }));
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit).toHaveBeenCalledWith({
      answers: [
        { questionIndex: 0, optionIndexes: [1] },
        { questionIndex: 1, optionIndexes: [1, 2], text: "also 408" },
      ],
    });
  });
});

describe("helpers", () => {
  it("counts tasks and formats durations", () => {
    expect(todoCounts(fixture.todos)).toMatchObject({
      done: 3,
      total: 7,
      active: { key: "worker" },
    });
    expect(todoCounts({ revision: 1, total: 0, tasks: [] })).toBeUndefined();
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
    expect(await slot.findByText("feat/retry-worker")).toBeTruthy();
    expect(await slot.findByRole("form", { name: "Pi's questions" })).toBeTruthy();
  });
});
