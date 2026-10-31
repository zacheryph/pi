import { afterEach, describe, expect, it } from "vitest";
import {
  discardPendingSince,
  getSubagentsService,
  markPendingPublications,
  publishSubagentsService,
  SUBAGENT_EVENTS,
  type SubagentsService,
  unpublishSubagentsService,
} from "#src/service/service";

const SERVICE_KEY = Symbol.for("@gotgenes/pi-subagents:service");
const PUBLICATIONS_KEY = Symbol.for("@gotgenes/pi-subagents:services.v1");

function makeService(name: string): SubagentsService {
  return { spawn: () => name } as unknown as SubagentsService;
}

describe("SubagentsService accessors", () => {
  afterEach(() => {
    // Clean up globalThis after each test
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- required to clean up Symbol-keyed global in tests
    delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- required to clean up Symbol-keyed global in tests
    delete (globalThis as Record<symbol, unknown>)[PUBLICATIONS_KEY];
  });

  it("getSubagentsService returns undefined when not published", () => {
    expect(getSubagentsService()).toBeUndefined();
  });

  it("publishSubagentsService stores service on globalThis", () => {
    const mock = makeService("parent");
    publishSubagentsService(mock, "parent-session");
    expect((globalThis as Record<symbol, unknown>)[SERVICE_KEY]).toBe(mock);
  });

  it("getSubagentsService retrieves the published service", () => {
    const mock = makeService("parent");
    publishSubagentsService(mock, "parent-session");
    expect(getSubagentsService()).toBe(mock);
  });

  it("unpublishSubagentsService removes the service from globalThis", () => {
    const mock = makeService("parent");
    publishSubagentsService(mock, "parent-session");
    unpublishSubagentsService(mock);
    expect(getSubagentsService()).toBeUndefined();
    expect((globalThis as Record<symbol, unknown>)[SERVICE_KEY]).toBeUndefined();
  });

  describe("with child sessions publishing in the same process", () => {
    it("keeps the outermost service in the slot when a child publishes", () => {
      const parent = makeService("parent");
      const child = makeService("child");
      publishSubagentsService(parent, "parent-session");
      publishSubagentsService(child, "child-session");

      expect(getSubagentsService()).toBe(parent);
    });

    it("keeps the parent's service after a child unpublishes", () => {
      const parent = makeService("parent");
      const child = makeService("child");
      publishSubagentsService(parent, "parent-session");
      publishSubagentsService(child, "child-session");

      unpublishSubagentsService(child);

      expect(getSubagentsService()).toBe(parent);
      expect(getSubagentsService("child-session")).toBeUndefined();
    });

    it("finds each session's own service by session id", () => {
      const parent = makeService("parent");
      const child = makeService("child");
      publishSubagentsService(parent, "parent-session");
      publishSubagentsService(child, "child-session");

      expect(getSubagentsService("parent-session")).toBe(parent);
      expect(getSubagentsService("child-session")).toBe(child);
      expect(getSubagentsService("unknown")).toBeUndefined();
    });

    it("replaces a lingering publication for the same session in place", () => {
      const stale = makeService("stale");
      const child = makeService("child");
      const fresh = makeService("fresh");
      publishSubagentsService(stale, "parent-session");
      publishSubagentsService(child, "child-session");

      // A new instance for the same session whose predecessor never unpublished.
      publishSubagentsService(fresh, "parent-session");

      expect(getSubagentsService()).toBe(fresh);
      expect(getSubagentsService("parent-session")).toBe(fresh);
      unpublishSubagentsService(stale);
      expect(getSubagentsService()).toBe(fresh);
    });

    it("re-publishing the same service is idempotent", () => {
      const parent = makeService("parent");
      publishSubagentsService(parent, "parent-session");
      publishSubagentsService(parent, "parent-session");

      unpublishSubagentsService(parent);

      expect(getSubagentsService()).toBeUndefined();
    });

    it("ignores unpublishing a service that is not published", () => {
      const parent = makeService("parent");
      publishSubagentsService(parent, "parent-session");

      unpublishSubagentsService(makeService("stranger"));

      expect(getSubagentsService()).toBe(parent);
    });

    it("hands the slot to the next outermost service when the parent unpublishes first", () => {
      const parent = makeService("parent");
      const child = makeService("child");
      publishSubagentsService(parent, "parent-session");
      publishSubagentsService(child, "child-session");

      unpublishSubagentsService(parent);
      expect(getSubagentsService()).toBe(child);

      unpublishSubagentsService(child);
      expect(getSubagentsService()).toBeUndefined();
    });

    it("publishes the replacement after a reload's shutdown", () => {
      const before = makeService("before-reload");
      const after = makeService("after-reload");
      publishSubagentsService(before, "parent-session");

      unpublishSubagentsService(before);
      publishSubagentsService(after, "parent-session");

      expect(getSubagentsService()).toBe(after);
      expect(getSubagentsService("parent-session")).toBe(after);
    });
  });
});

describe("pending publications while a session's extensions load", () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- required to clean up Symbol-keyed global in tests
    delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- required to clean up Symbol-keyed global in tests
    delete (globalThis as Record<symbol, unknown>)[PUBLICATIONS_KEY];
  });
  const slot = () => (globalThis as Record<symbol, unknown>)[SERVICE_KEY];

  it("makes the loading session's service the default until it starts, then the outermost again", () => {
    const parent = makeService("parent");
    const child = makeService("child");
    publishSubagentsService(parent);
    publishSubagentsService(parent, "parent-session");

    // The child's factory runs: companion factories that follow must get the child's.
    publishSubagentsService(child);
    expect(getSubagentsService()).toBe(child);
    expect(slot()).toBe(child);
    expect(getSubagentsService("child-session")).toBeUndefined();

    publishSubagentsService(child, "child-session");
    expect(getSubagentsService()).toBe(parent);
    expect(slot()).toBe(parent);
    expect(getSubagentsService("child-session")).toBe(child);
  });

  it("drops a pending publication that never started once a later session starts", () => {
    // A project-trust bootstrap pass runs factories, then the real pass loads again.
    const bootstrap = makeService("bootstrap");
    const real = makeService("real");
    publishSubagentsService(bootstrap);
    publishSubagentsService(real);
    expect(getSubagentsService()).toBe(real);

    publishSubagentsService(real, "session-1");
    expect(getSubagentsService()).toBe(real);

    unpublishSubagentsService(real);
    expect(getSubagentsService()).toBeUndefined();
  });

  it("never lets a load that did not start outlive a later session (A, then load-only B, then C)", () => {
    const a = makeService("a");
    const b = makeService("b");
    const c = makeService("c");
    publishSubagentsService(a);
    publishSubagentsService(a, "session-a");
    publishSubagentsService(b); // factory only: never starts, never shuts down
    unpublishSubagentsService(a);

    publishSubagentsService(c);
    expect(getSubagentsService()).toBe(c);
    publishSubagentsService(c, "session-c");
    expect(getSubagentsService()).toBe(c);

    unpublishSubagentsService(c);
    expect(getSubagentsService()).toBeUndefined();
    expect(slot()).toBeUndefined();
  });

  it("discards the pending publications of a child load that failed", () => {
    const parent = makeService("parent");
    publishSubagentsService(parent, "parent-session");

    const mark = markPendingPublications();
    publishSubagentsService(makeService("failed-child"));
    discardPendingSince(mark);

    expect(getSubagentsService()).toBe(parent);
    expect(slot()).toBe(parent);
  });

  it("keeps started publications when discarding", () => {
    const parent = makeService("parent");
    const sibling = makeService("sibling");
    publishSubagentsService(parent, "parent-session");
    const mark = markPendingPublications();
    publishSubagentsService(sibling);
    publishSubagentsService(sibling, "sibling-session");

    discardPendingSince(mark);

    expect(getSubagentsService("sibling-session")).toBe(sibling);
    expect(getSubagentsService()).toBe(parent);
  });
});

describe("SUBAGENT_EVENTS", () => {
  it("exports expected event channel constants", () => {
    expect(SUBAGENT_EVENTS.STARTED).toBe("subagents:started");
    expect(SUBAGENT_EVENTS.COMPLETED).toBe("subagents:completed");
    expect(SUBAGENT_EVENTS.FAILED).toBe("subagents:failed");
    expect(SUBAGENT_EVENTS.COMPACTED).toBe("subagents:compacted");
    expect(SUBAGENT_EVENTS.CREATED).toBe("subagents:created");
    expect(SUBAGENT_EVENTS.STEERED).toBe("subagents:steered");
  });

  it("does not declare a vacant activity channel", () => {
    expect("ACTIVITY" in SUBAGENT_EVENTS).toBe(false);
  });
});
