import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { fakeEventBus } from "#test-helpers";
import {
  advertiseFormConsumer,
  FORM_CONSUMERS_CHANGED_EVENT,
  hasFormConsumer,
  listFormConsumers,
  onFormCapabilityChanged,
} from "#src/index";

describe("form consumer discovery", () => {
  it("reports live consumers while they advertise", () => {
    const bus = createEventBus();
    expect(hasFormConsumer(bus)).toBe(false);
    const revokeBb = advertiseFormConsumer(bus, { name: "bb" });
    const revokeDashboard = advertiseFormConsumer(bus, { name: "dashboard" });
    expect(hasFormConsumer(bus)).toBe(true);
    expect(listFormConsumers(bus)).toEqual([{ name: "bb" }, { name: "dashboard" }]);
    revokeBb();
    expect(listFormConsumers(bus)).toEqual([{ name: "dashboard" }]);
    revokeDashboard();
    expect(hasFormConsumer(bus)).toBe(false);
  });

  it("tells a producer when capability is gained and when the last consumer withdraws", () => {
    const bus = createEventBus();
    const changed = vi.fn();
    onFormCapabilityChanged(bus, changed);
    const revokeBb = advertiseFormConsumer(bus, { name: "bb" });
    expect(changed.mock.calls).toEqual([[true]]);
    // A second consumer, and one of two withdrawing, change nothing.
    const revokeDashboard = advertiseFormConsumer(bus, { name: "dashboard" });
    revokeBb();
    expect(changed.mock.calls).toEqual([[true]]);
    // The listener reads the state after the change.
    changed.mockImplementation(() => expect(hasFormConsumer(bus)).toBe(false));
    revokeDashboard();
    expect(changed.mock.calls).toEqual([[true], [false]]);
    // Revoking again is a no-op.
    revokeDashboard();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("starts from the current state, and stops after unsubscribing", () => {
    const bus = fakeEventBus();
    advertiseFormConsumer(bus, { name: "bb" });
    const changed = vi.fn();
    const off = onFormCapabilityChanged(bus, changed);
    advertiseFormConsumer(bus, { name: "dashboard" });
    expect(changed).not.toHaveBeenCalled();
    off();
    bus.emit(FORM_CONSUMERS_CHANGED_EVENT, { version: 1 });
    expect(changed).not.toHaveBeenCalled();
  });

  it("ignores malformed traffic", () => {
    const bus = fakeEventBus();
    const changed = vi.fn();
    onFormCapabilityChanged(bus, changed);
    bus.emit(FORM_CONSUMERS_CHANGED_EVENT, null);
    bus.emit(FORM_CONSUMERS_CHANGED_EVENT, { version: 99 });
    bus.emit("surface:form-consumers", { version: 99, kind: "list", add: () => {} });
    expect(changed).not.toHaveBeenCalled();
    expect(() => advertiseFormConsumer(bus, { name: " " })).toThrow("needs a name");
  });

  it("is scoped to one session's bus", () => {
    const parent = createEventBus();
    const child = createEventBus();
    const changed = vi.fn();
    onFormCapabilityChanged(parent, changed);
    advertiseFormConsumer(child, { name: "bb" });
    expect(hasFormConsumer(parent)).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it("revokes quietly on a bus Pi has retired", () => {
    const bus = fakeEventBus();
    const revoke = advertiseFormConsumer(bus, { name: "bb" });
    bus.emit.mockImplementation(() => {
      throw new Error("ctx is stale");
    });
    expect(() => revoke()).not.toThrow();
  });
});
