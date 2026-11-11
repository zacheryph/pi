import { describe, expect, it } from "vitest";
import { type AgentMessage, applyCard, contextCard } from "#src/index";
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

describe("applyCard", () => {
  it("returns undefined when there is no card and nothing to strip", () => {
    expect(applyCard([user("hi")], TYPE, () => undefined)).toBeUndefined();
  });

  it("strips an earlier card when no card is due", () => {
    const other = card("other", "other:context");
    expect(applyCard([user("hi"), card("old"), other], TYPE, () => undefined)).toEqual({
      messages: [user("hi"), other],
    });
  });

  it("replaces an earlier card with the current one at the end", () => {
    const result = applyCard(
      [card("old"), user("hi")],
      TYPE,
      () => "new",
      () => 42,
    );
    expect(result).toEqual({
      messages: [
        user("hi"),
        { role: "custom", customType: TYPE, content: "new", display: false, timestamp: 42 },
      ],
    });
  });

  it("builds from the messages without earlier cards", () => {
    let seen: AgentMessage[] = [];
    applyCard([user("a"), card("old")], TYPE, (messages) => {
      seen = messages;
      return undefined;
    });
    expect(seen).toEqual([user("a")]);
  });

  it("treats an empty card as no card", () => {
    expect(applyCard([user("hi")], TYPE, () => "")).toBeUndefined();
  });
});

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
