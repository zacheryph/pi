import { describe, expect, it } from "vitest";
import { SubagentState } from "#src/lifecycle/subagent-state";
import { itemLabel, SubagentWork, WORK_KIND, WORK_OWNER } from "#src/observation/subagent-work";
import { fakeWorkHost } from "#test/helpers/fake-work-host";
import { createTestSubagent } from "#test/helpers/make-subagent";

function setup() {
  const fake = fakeWorkHost();
  const work = new SubagentWork(() => fake.host);
  return { ...fake, work };
}

const done = (id = "agent-1") =>
  createTestSubagent({ id, description: "Audit parser", type: "explore", result: "All good." });

describe("SubagentWork", () => {
  describe("opening", () => {
    it("opens one item per requested run, owned by pi-subagent", () => {
      const { work, items } = setup();
      const record = createTestSubagent({
        id: "agent-1",
        description: "Audit parser",
        type: "explore",
        toolCallId: "call-1",
      });
      work.runRequested(record);
      work.runRequested(record); // a queued run that then starts
      expect(items).toHaveLength(1);
      expect(items[0].spec).toEqual({
        owner: WORK_OWNER,
        kind: WORK_KIND,
        label: "Audit parser (explore agent agent-1)",
        data: {
          agentId: "agent-1",
          type: "explore",
          description: "Audit parser",
          toolCallId: "call-1",
        },
      });
    });

    it("names the agent in the label, keeping its id and type when the description is long", () => {
      const label = itemLabel({
        id: "3f2a9c1e-5b7d-4a",
        type: "general-purpose",
        description: `Investigate\nthe flaky   test ${"in the integration suite ".repeat(10)}`,
      });
      expect(label).toMatch(
        /^Investigate the flaky test .*…\s\(general-purpose agent 3f2a9c1e-5b7d-4a\)$/,
      );
      expect(label.length).toBeLessThan(140);
    });

    it("opens nothing without a host, and the outcome still reaches the host that appears", () => {
      const fake = fakeWorkHost();
      let host: typeof fake.host | undefined;
      const work = new SubagentWork(() => host);
      const record = done();
      work.runRequested(record);
      expect(fake.items).toEqual([]);
      host = fake.host;
      work.runEnded(record);
      expect(fake.items).toHaveLength(1);
      expect(fake.items[0].events.map((e) => e.kind)).toEqual(["complete"]);
    });

    it("survives a host that refuses the item", () => {
      const work = new SubagentWork(() => ({
        open: () => {
          throw new Error("work host is disposed");
        },
        adopt: () => {},
        list: () => [],
      }));
      expect(() => work.runRequested(done())).not.toThrow();
      expect(() => work.runEnded(done())).not.toThrow();
    });
  });

  describe("a run ending", () => {
    it("completes the item with the completion message", () => {
      const { work, items } = setup();
      const record = done();
      work.runRequested(record);
      work.runEnded(record);
      expect(items[0].events).toHaveLength(1);
      const [event] = items[0].events;
      expect(event.kind).toBe("complete");
      expect(event.kind === "complete" && event.message.customType).toBe("subagent:completion");
      expect(event.kind === "complete" && event.message.content).toContain(
        "<task-id>agent-1</task-id>",
      );
    });

    it("completes once: a second end of the same run delivers nothing more", () => {
      const { work, items, messages } = setup();
      const record = done();
      work.runRequested(record);
      work.runEnded(record);
      work.runEnded(record);
      expect(messages()).toHaveLength(1);
      expect(items).toHaveLength(1);
    });

    it("delivers nothing for a run that was never requested", () => {
      const { work, items } = setup();
      work.runEnded(done());
      expect(items).toEqual([]);
    });

    it("still completes after the parent read the result", () => {
      const { work, messages } = setup();
      const record = createTestSubagent({ id: "consumed-1", consumedAt: 5000 });
      work.runRequested(record);
      work.runEnded(record);
      expect(messages()).toHaveLength(1);
    });

    it("delivers a stopped run's message, then cancels the item", () => {
      const { work, items } = setup();
      const record = createTestSubagent({ id: "agent-2", status: "stopped", result: undefined });
      work.runRequested(record);
      work.runEnded(record);
      expect(items[0].events.map((e) => e.kind)).toEqual(["notify", "cancel"]);
      const [event] = items[0].events;
      expect(event.kind === "notify" && event.message.customType).toBe("subagent:completion");
      expect(event.kind === "notify" && event.message.content).toContain("Stopped (user request)");
    });

    it("delivers a never-started agent's message the same way", () => {
      const { work, items } = setup();
      const record = createTestSubagent({
        status: "stopped",
        stoppedWhileQueued: true,
        result: undefined,
      });
      work.runRequested(record);
      work.runEnded(record);
      expect(items[0].events.map((e) => e.kind)).toEqual(["notify", "cancel"]);
    });

    it("opens a new item for new input to the finished agent", () => {
      const { work, items, messages } = setup();
      const record = done();
      work.runRequested(record);
      work.runEnded(record);
      work.runRequested(record); // subagent_send
      expect(items).toHaveLength(2);
      expect(items[1].closed).toBe(false);
      work.runEnded(record);
      expect(items.map((i) => i.closed)).toEqual([true, true]);
      expect(messages()).toHaveLength(2);
    });

    it("keeps each agent's item apart", () => {
      const { work, items } = setup();
      const a = done("a");
      const b = done("b");
      work.runRequested(a);
      work.runRequested(b);
      work.runEnded(b);
      expect(items.map((i) => i.closed)).toEqual([false, true]);
    });
  });

  describe("a running child's update", () => {
    const running = (id = "live-1", extra: object = {}) =>
      createTestSubagent({ id, status: "running", ...extra });

    it("notifies through the item without closing it", () => {
      const { work, items } = setup();
      const record = running();
      work.runRequested(record);
      work.update(record, "Course change.");
      expect(items[0].closed).toBe(false);
      const [event] = items[0].events;
      expect(event.kind).toBe("notify");
      expect(event.kind === "notify" && event.message.customType).toBe("subagent:update");
      expect(event.kind === "notify" && event.message.content).toContain("Course change.");
    });

    it("keeps every update, because two updates are two facts", () => {
      const { work, messages } = setup();
      const record = running();
      work.runRequested(record);
      work.update(record, "First finding.");
      work.update(record, "Second finding.");
      expect(messages()).toHaveLength(2);
    });

    it("is announced even after the parent read an earlier result", () => {
      const { work, messages } = setup();
      const record = running();
      record.markConsumed();
      work.runRequested(record);
      work.update(record, "Course change.");
      expect(messages()).toHaveLength(1);
    });

    it("is no longer owed to the completion message once the item delivered it", () => {
      const { work } = setup();
      const record = running("live-1", { runUpdates: ["Course change.", "A second finding."] });
      work.runRequested(record);
      work.update(record, "Course change.");
      expect(record.runUpdates).toEqual(["A second finding."]);
    });

    it("stays quiet once the child has terminated, leaving the update to the completion message", () => {
      const { work, messages } = setup();
      const state = new SubagentState({ status: "running", startedAt: 1000 });
      state.recordUpdate("Course change.");
      const record = createTestSubagent({ id: "live-1", state });
      work.runRequested(record);
      state.markCompleted("Done.");
      work.update(record, "Course change.");
      expect(messages()).toEqual([]);
      expect(record.runUpdates).toEqual(["Course change."]);
      work.runEnded(record);
      expect(messages()[0].content).toContain(
        "Updates this agent sent while it worked:\n\n  Course change.",
      );
    });

    it("is dropped when the run has no item", () => {
      const { work, messages } = setup();
      work.update(running(), "Course change.");
      expect(messages()).toEqual([]);
    });
  });

  describe("disposal", () => {
    it("delivers and closes nothing, leaving the open items for the next start to report", () => {
      const { work, items, messages } = setup();
      const record = running();
      work.runRequested(record);
      work.dispose();
      work.update(record, "late");
      work.runEnded(record);
      work.runRequested(createTestSubagent({ id: "new" }));
      expect(messages()).toEqual([]);
      expect(items).toHaveLength(1);
      expect(items[0].closed).toBe(false);
      expect(items[0].events).toEqual([]);
    });

    function running() {
      return createTestSubagent({ id: "live-1", status: "running" });
    }
  });
});
