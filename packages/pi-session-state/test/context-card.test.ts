import { describe, expect, it } from "vitest";
import { type AgentMessage, contextCard } from "#src/index";
import { fakePi } from "#test-helpers";

const TYPE = "example:context";

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const card = (content: string, customType = TYPE): AgentMessage => ({
  role: "custom",
  customType,
  content,
  display: false,
  timestamp: 1,
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
    expect(await fake.emit("context", { messages: [user("hi")] })).toEqual({
      messages: [
        user("hi"),
        { role: "custom", customType: TYPE, content: "later", display: false, timestamp: 3 },
      ],
    });
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
