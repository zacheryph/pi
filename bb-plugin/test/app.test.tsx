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

  it("draws the Todos stack card with counts and the active task, and its task list", async () => {
    const banner = app.composerCustomizations[0]!.banners![0]!;
    const slot = renderSlot(banner, {}, { rpc: rpcFor(fixture), composer: threadComposer });
    // The test host draws bb's card as a section with its title; bb collapses it.
    const card = await slot.findByTestId("bb-collapsible-stack-card");
    expect(card.dataset.active).toBe("true");
    expect(card.querySelector("h3")?.textContent).toBe(
      "Todos 3/7 · Move retries into the queue worker",
    );
    const list = await slot.findByRole("list", { name: "Tasks" });
    expect(list.querySelectorAll("li")).toHaveLength(7);
    expect(list.textContent).toContain("Retry and dead-letter tests");
    expect(list.textContent).toContain("blocked");
  });

  it("draws one row per subagent in the Subagents card", async () => {
    const banner = app.composerCustomizations[0]!.banners![1]!;
    const slot = renderSlot(banner, {}, { rpc: rpcFor(fixture), composer: threadComposer });
    const card = await slot.findByTestId("bb-collapsible-stack-card");
    expect(card.querySelector("h3")?.textContent).toBe("Subagents · 2 running");
    const list = await slot.findByRole("list", { name: "Subagents" });
    expect(list.querySelectorAll(":scope > li")).toHaveLength(3);
    expect(list.textContent).toContain("Map every webhook delivery path");
    expect(list.textContent).toContain("running");
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

  it("loads a task's history and a stash preview on demand in the Pi tab", async () => {
    const tab = app.tabs[0]!;
    const slot = renderSlot(
      tab as never,
      { threadId: THREAD, environment: null },
      { rpc: rpcFor(fixture) },
    );
    fireEvent.click(await slot.findByText("Move retries into the queue worker"));
    expect(
      await slot.findByText(/Worker picks up due attempts; wiring the ack path now\./, {
        selector: "li",
      }),
    ).toBeTruthy();
    fireEvent.click(await slot.findByText("review-notes"));
    expect(await slot.findByText(/delivery_attempts needs an index/)).toBeTruthy();
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toContain("request");
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
