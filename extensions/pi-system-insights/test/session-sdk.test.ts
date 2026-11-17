import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  isSessionModel,
  listViews,
  onViewChanged,
  readView,
  SESSION_VIEW_ID,
  type SessionModel,
} from "#surface";
import systemInsights from "#src/index";
import { fauxSession, toolCall } from "#test-helpers";

const spent = (input: number, output: number, cost: number): Usage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

/** A real Pi session with only system-insights loaded: no dashboard, no bb. */
async function fixture() {
  let bus: EventBus | undefined;
  const h = await fauxSession({
    cleanup: onTestFinished,
    provider: "insights-test",
    models: [
      {
        id: "test",
        contextWindow: 100_000,
        cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
      },
    ],
    tools: ["read"],
    extensions: [
      (pi) => {
        bus = pi.events;
        systemInsights(pi);
      },
    ],
  });
  const view = () => {
    const model = readView(bus!, SESSION_VIEW_ID);
    expect(isSessionModel(model)).toBe(true);
    return model as SessionModel;
  };
  /** The session view as each announcement left it. */
  const seen: SessionModel[] = [];
  onViewChanged(bus!, (id) => {
    if (id === SESSION_VIEW_ID) seen.push(view());
  });
  const stats = () => {
    const { tokens, cost } = h.session.getSessionStats();
    return {
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      cost: expect.closeTo(cost, 10),
    };
  };
  return { ...h, bus: bus!, view, seen, stats };
}

describe("system.session in a real session", () => {
  it("publishes from session start and follows a run with a tool call", async () => {
    const h = await fixture();
    expect(listViews(h.bus).map((view) => view.id)).toEqual([SESSION_VIEW_ID]);
    expect(h.view()).toMatchObject({
      sessionId: h.sessionManager.getSessionId(),
      cwd: h.dir,
      model: { provider: "insights-test", id: "test" },
      status: { kind: "idle" },
    });
    expect(h.view().piVersion).toEqual(expect.any(String));

    const file = join(h.dir, "notes.md");
    writeFileSync(file, "hello\n");
    h.faux.setResponses([toolCall("read", { path: file }, "call-1"), fauxAssistantMessage("done")]);
    await h.session.prompt("read the notes");

    const kinds = h.seen.map((model) => model.status.kind);
    expect(kinds).toContain("working");
    expect(
      h.seen.some((model) => model.status.kind === "tool" && model.status.tool === "read"),
    ).toBe(true);
    const running = h.seen.find((model) => model.activity?.[0]?.live);
    expect(running?.activity?.[0]).toMatchObject({ tool: "read", summary: file, live: true });

    const after = h.view();
    expect(after.status.kind).toBe("idle");
    expect(after.activity).toEqual([
      { tool: "read", summary: file, at: expect.any(Number), durationMs: expect.any(Number) },
    ]);
    expect(after.context).toMatchObject({ window: 100_000 });
    expect(after.usage).toEqual(h.stats());
    expect(after.usage!.input + after.usage!.output).toBeGreaterThan(0);
  });

  it("keeps usage equal to /session across branches and compaction", async () => {
    const h = await fixture();
    await h.session.prompt("first");
    const first = h.sessionManager.getLeafId()!;
    // An abandoned branch, a branch summary and a compaction, each billed.
    h.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "abandoned" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: spent(30, 3, 0.1),
      stopReason: "stop",
      timestamp: 1,
    });
    h.sessionManager.branchWithSummary(
      first,
      "Tried another way",
      undefined,
      false,
      spent(5, 1, 0.01),
    );
    h.sessionManager.appendCompaction("Summary", first, 900, undefined, false, spent(40, 10, 0.2));
    h.sessionManager.appendUsage("cache_warm", "test", "test", spent(7, 3, 0.02));

    h.faux.setResponses([fauxAssistantMessage("again")]);
    await h.session.prompt("second");
    expect(h.view().usage).toEqual(h.stats());
    expect(h.view().usage!.input).toBeGreaterThanOrEqual(82);
  });
});
