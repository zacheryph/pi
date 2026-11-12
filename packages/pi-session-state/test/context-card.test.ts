import { describe, expect, it } from "vitest";
import { type AgentMessage, contextCard } from "#src/index";
import { fakePi } from "../../pi-test-helpers/src/fake-pi.ts";

const TYPE = "example:context";

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const card = (content: string, customType = TYPE): AgentMessage => ({
  role: "custom",
  customType,
  content,
  display: false,
  timestamp: 1,
});

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("contextCard", () => {
  it("passes ctx and stripped messages to build and returns synchronously for a sync build", async () => {
    const fake = fakePi();
    const ctx = { marker: true };
    const calls: unknown[][] = [];
    contextCard(fake.api, {
      type: TYPE,
      build: (...args) => {
        calls.push(args);
        return "card";
      },
      now: () => 7,
    });
    const [handler] = fake.handlers.get("context")!;
    const result = handler({ type: "context", messages: [user("hi"), card("old")] }, ctx);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toEqual({
      messages: [
        user("hi"),
        { role: "custom", customType: TYPE, content: "card", display: false, timestamp: 7 },
      ],
    });
    expect(calls).toEqual([[ctx, [user("hi")]]]);
  });

  it("strips the card when it is not due and leaves unchanged messages alone", async () => {
    const fake = fakePi();
    contextCard(fake.api, { type: TYPE, build: () => undefined });
    expect(await fake.emit("context", { messages: [user("hi"), card("old")] })).toEqual({
      messages: [user("hi")],
    });
    expect(await fake.emit("context", { messages: [user("hi")] })).toBeUndefined();
  });

  it("awaits an async build", async () => {
    const fake = fakePi();
    contextCard(fake.api, { type: TYPE, build: async () => "later", now: () => 3 });
    await fake.emit("session_start");
    expect(await fake.emit("context", { messages: [user("hi")] })).toEqual({
      messages: [
        user("hi"),
        { role: "custom", customType: TYPE, content: "later", display: false, timestamp: 3 },
      ],
    });
  });

  it.each(["session_shutdown", "session_start"])(
    "drops an async card that resolves after %s, but still strips the old one",
    async (event) => {
      const fake = fakePi();
      const pending = deferred<string | undefined>();
      contextCard(fake.api, { type: TYPE, build: () => pending.promise });
      await fake.emit("session_start");
      const result = fake.emit("context", { messages: [user("hi"), card("old")] });
      await fake.emit(event);
      pending.resolve("stale");
      expect(await result).toEqual({ messages: [user("hi")] });
    },
  );

  it("drops a stale async card with nothing to strip as unchanged", async () => {
    const fake = fakePi();
    const pending = deferred<string | undefined>();
    contextCard(fake.api, { type: TYPE, build: () => pending.promise });
    const result = fake.emit("context", { messages: [user("hi")] });
    await fake.emit("session_shutdown");
    pending.resolve("stale");
    expect(await result).toBeUndefined();
  });

  it("keeps each registration's state separate", async () => {
    const fake = fakePi();
    contextCard(fake.api, { type: "a:context", build: () => "a" });
    contextCard(fake.api, { type: "b:context", build: () => undefined });
    const [first, second] = fake.handlers.get("context")!;
    const messages = [user("hi"), card("old a", "a:context"), card("old b", "b:context")];
    expect(first({ type: "context", messages }, {})).toMatchObject({
      messages: [user("hi"), card("old b", "b:context"), { customType: "a:context" }],
    });
    expect(second({ type: "context", messages }, {})).toEqual({
      messages: [user("hi"), card("old a", "a:context")],
    });
  });
});

describe("contextCard with restore", () => {
  function setup(options: { due?: () => boolean | Promise<boolean>; build?: () => unknown } = {}) {
    const fake = fakePi();
    let clock = 10;
    const events: string[] = [];
    let built = 0;
    const card = contextCard(fake.api, {
      type: TYPE,
      now: () => clock,
      restore: (_ctx, event) => {
        events.push(event.type);
        return options.due ? options.due() : true;
      },
      build: () => {
        built += 1;
        return options.build ? (options.build() as string | undefined) : "card";
      },
    });
    const context = (messages: AgentMessage[] = [user("hi")]) => fake.emit("context", { messages });
    return {
      fake,
      card,
      events,
      context,
      built: () => built,
      tick: (to: number) => {
        clock = to;
      },
    };
  }

  it("is hidden until a session event restores it, and never builds while hidden", async () => {
    const h = setup();
    expect(await h.context([user("hi"), card("old")])).toEqual({ messages: [user("hi")] });
    expect(h.built()).toBe(0);
    expect(h.card.shownAt()).toBeUndefined();
  });

  it.each(["session_start", "session_tree", "session_compact"])(
    "asks restore after %s and shows the card when it returns true",
    async (event) => {
      const h = setup();
      await h.fake.emit(event, event === "session_start" ? { reason: "reload" } : {});
      expect(h.events).toEqual([event]);
      expect(h.card.shownAt()).toBe(10);
      expect(await h.context()).toMatchObject({
        messages: [user("hi"), { customType: TYPE, content: "card" }],
      });
    },
  );

  it("hides the card when restore returns false, and at shutdown", async () => {
    let due = true;
    const h = setup({ due: () => due });
    await h.fake.emit("session_start", { reason: "resume" });
    due = false;
    await h.fake.emit("session_tree");
    expect(h.card.shownAt()).toBeUndefined();
    due = true;
    await h.fake.emit("session_compact");
    await h.fake.emit("session_shutdown");
    expect(h.card.shownAt()).toBeUndefined();
    expect(await h.context()).toBeUndefined();
  });

  it("is shown and hidden by the extension", async () => {
    const h = setup();
    h.tick(20);
    h.card.show();
    expect(h.card.shownAt()).toBe(20);
    expect(await h.context()).toMatchObject({ messages: [user("hi"), { content: "card" }] });
    h.card.hide();
    expect(await h.context([user("hi"), card("old")])).toEqual({ messages: [user("hi")] });
  });

  it("can hide itself from build, stripping the old card", async () => {
    const h = setup({
      build: () => {
        h.card.hide();
        return undefined;
      },
    });
    h.card.show();
    expect(await h.context([user("hi"), card("old")])).toEqual({ messages: [user("hi")] });
    expect(h.card.shownAt()).toBeUndefined();
  });

  it("drops an async restore that resolves after a newer session start", async () => {
    const first = deferred<boolean>();
    let next: Promise<boolean> = first.promise;
    const h = setup({ due: () => next });
    const stale = h.fake.emit("session_start", { reason: "resume" });
    next = Promise.resolve(false);
    await h.fake.emit("session_start", { reason: "reload" });
    first.resolve(true);
    await stale;
    expect(h.card.shownAt()).toBeUndefined();
  });

  it("drops an async build when the card is hidden before it resolves", async () => {
    const pending = deferred<string | undefined>();
    const h = setup({ build: () => pending.promise });
    h.card.show();
    const result = h.context([user("hi"), card("old")]);
    h.card.hide();
    pending.resolve("late");
    expect(await result).toEqual({ messages: [user("hi")] });
  });

  it("drops an async build even when the card is shown again at the same time", async () => {
    const pending = deferred<string | undefined>();
    let content: string | Promise<string | undefined> = pending.promise;
    const h = setup({ build: () => content });
    h.card.show();
    const result = h.context([user("hi"), card("old")]);
    h.card.hide();
    h.card.show();
    pending.resolve("stale");
    expect(await result).toEqual({ messages: [user("hi")] });
    content = "current";
    expect(await h.context()).toMatchObject({ messages: [user("hi"), { content: "current" }] });
  });

  it("does not let an async restore undo a later explicit visibility change", async () => {
    const pending = deferred<boolean>();
    const h = setup({ due: () => pending.promise });
    const starting = h.fake.emit("session_start");
    h.card.hide();
    pending.resolve(true);
    await starting;
    expect(h.card.shownAt()).toBeUndefined();
  });

  it.each(["session_tree", "session_compact"])(
    "drops an async restore superseded by %s",
    async (event) => {
      const pending = deferred<boolean>();
      let due: boolean | Promise<boolean> = pending.promise;
      const h = setup({ due: () => due });
      const starting = h.fake.emit("session_start");
      due = false;
      await h.fake.emit(event);
      pending.resolve(true);
      await starting;
      expect(h.card.shownAt()).toBeUndefined();
    },
  );
});
