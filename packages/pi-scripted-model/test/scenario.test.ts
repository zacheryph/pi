import { afterEach, describe, expect, it } from "vitest";
import {
  defineScenario,
  ENABLE_ENV,
  HOLD,
  MODEL,
  PROVIDER,
  startAgent,
  TITLE_MODEL,
  tool,
  turnStarts,
} from "#src/scenario.ts";

type Content = { type: string; text?: string; name?: string };
type Provider = {
  id: string;
  getModels(): { id: string }[];
  streamSimple(
    model: { id: string },
    context: { systemPrompt: string; messages: unknown[] },
    options: { signal?: AbortSignal },
  ): { result(): Promise<{ stopReason: string; content: Content[] }> };
};

afterEach(() => {
  delete process.env[ENABLE_ENV];
});

function register(scenario: ReturnType<typeof defineScenario>): Provider[] {
  const providers: Provider[] = [];
  scenario({ registerProvider: (p: Provider) => providers.push(p) } as never);
  return providers;
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const assistant = { role: "assistant", content: [], timestamp: 0 };
const toolResult = { role: "toolResult", content: [], timestamp: 0 };

function client(provider: Provider) {
  const models = provider.getModels();
  const ask = async (messages: unknown[], id = MODEL, signal?: AbortSignal) => {
    const model = models.find((m) => m.id === id)!;
    const result = await provider
      .streamSimple(model, { systemPrompt: "", messages }, { signal })
      .result();
    return { stop: result.stopReason, content: result.content };
  };
  return {
    ask,
    tools: async (messages: unknown[]) =>
      (await ask(messages)).content.filter((c) => c.type === "toolCall").map((c) => c.name),
    text: async (messages: unknown[], id?: string) =>
      (await ask(messages, id)).content.map((c) => c.text ?? "").join(""),
  };
}

describe("defineScenario", () => {
  it("registers nothing unless enabled", () => {
    const scenario = defineScenario({ replies: [] });
    expect(register(scenario)).toEqual([]);
    process.env[ENABLE_ENV] = "1";
    expect(register(scenario).map((p) => p.id)).toEqual([PROVIDER]);
  });

  it("follows the transcript for the main session and subagents", async () => {
    const scenario = defineScenario({
      title: "demo-title",
      replies: [[[tool("todo_list", {})], "first done"], [HOLD]],
    });
    // Defined after the scenario: agents are looked up when a request arrives.
    startAgent({
      type: "Plan",
      description: "child",
      prompt: "Child task.",
      steps: [[tool("read", { path: "a" })], "child done"],
    });
    process.env[ENABLE_ENV] = "1";
    const { ask, tools, text } = client(register(scenario)[0]!);

    expect(await tools([user("go")])).toEqual(["todo_list"]);
    expect(await text([user("go"), assistant])).toBe("first done");
    expect(await text([user("go"), assistant, assistant]), "a turn with no steps ends").toBe("");
    expect(await tools([user("Context.\n\nChild task.")])).toEqual(["read"]);
    expect(await text([user("Child task."), assistant])).toBe("child done");

    // HOLD, and a subagent with no steps left, wait until the request is aborted.
    for (const messages of [
      [user("go"), assistant, user("again")],
      [user("Child task."), assistant, assistant],
    ]) {
      const controller = new AbortController();
      const pending = ask(messages, MODEL, controller.signal);
      const raced = await Promise.race([pending, new Promise((r) => setTimeout(r, 50, "held"))]);
      expect(raced).toBe("held");
      controller.abort();
      expect((await pending).stop).toBe("aborted");
    }

    expect(await text([user("<user_request>\ngo\n</user_request>")], TITLE_MODEL)).toBe(
      "demo-title",
    );
    expect(JSON.parse(await text([user("summarize")], TITLE_MODEL)).title).toBe("demo-title");
  });

  it("keeps playing the turn when an extension adds context mid-turn", async () => {
    const scenario = defineScenario({
      replies: [[[tool("todo_upsert", {})], [tool("todo_list", {})], "done"]],
    });
    process.env[ENABLE_ENV] = "1";
    const { tools, text } = client(register(scenario)[0]!);
    const injected = user("Current task list (revision 2).");
    expect(await tools([user("go"), assistant, toolResult, injected])).toEqual(["todo_list"]);
    expect(await text([user("go"), assistant, toolResult, injected, assistant, toolResult])).toBe(
      "done",
    );
  });
});

describe("turnStarts", () => {
  it("starts a turn at a user message after the assistant finished", () => {
    expect(turnStarts([user("a"), assistant, user("b"), assistant])).toEqual([0, 2]);
  });

  it("does not start a turn at a user message after a tool result", () => {
    expect(turnStarts([user("a"), assistant, toolResult, user("ctx"), assistant])).toEqual([0]);
  });

  it("starts one turn for a run of user messages", () => {
    expect(turnStarts([user("ctx"), user("a"), assistant, user("ctx"), user("b")])).toEqual([0, 3]);
  });

  it("ignores system messages", () => {
    expect(turnStarts([{ role: "system", content: "" }, user("a")])).toEqual([1]);
  });
});
