import { describe, expect, it, vi } from "vitest";
import { fakeEventBus } from "#test-helpers";
import { PresentationService } from "#src/service";
const todo = (key: string) => ({
  version: 1,
  revision: 1,
  tasks: [{ key, subject: key, status: "pending", blocked: false, unreviewed: 0, updates: [] }],
});
describe("presentation service", () => {
  it("isolates sessions, replaces branch state and returns detached snapshots", async () => {
    const bus = fakeEventBus();
    const other = new PresentationService(fakeEventBus());
    const service = new PresentationService(bus);
    const changed = vi.fn();
    const off = service.subscribe(changed);
    bus.emit("todo:snapshot", todo("old"));
    service.snapshot().todos!.tasks[0]!.subject = "mutated";
    expect(service.snapshot().todos!.tasks[0]!.subject).toBe("old");
    expect(other.snapshot().todos).toBeUndefined();
    bus.emit("todo:snapshot", todo("new"));
    await expect(service.request({ command: "todo-history", key: "old" })).rejects.toThrow(
      "No task",
    );
    expect(service.snapshot().todos!.tasks.map((t) => t.key)).toEqual(["new"]);
    off();
    service.reset();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(service.snapshot().todos).toBeUndefined();
    service.dispose();
    other.dispose();
  });
  it("disposes listeners and rejects reads after disposal", async () => {
    const bus = fakeEventBus();
    const service = new PresentationService(bus);
    const listener = vi.fn();
    service.subscribe(listener);
    service.dispose();
    bus.emit("todo:snapshot", todo("ignored"));
    expect(listener).not.toHaveBeenCalled();
    expect(service.snapshot().todos).toBeUndefined();
    await expect(service.request({ command: "todo-history", key: "ignored" })).rejects.toThrow(
      "disposed",
    );
  });
});
