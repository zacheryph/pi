/**
 * A task the agent sets waiting on the user is an attention item that takes a
 * reply (pi-todo's `todo.attention` through pi-surface to `/attention`), and
 * the reply wakes the session once through pi-work's root host, even after a
 * resume in between. A reply to a wait that has changed is refused.
 */
import { expect, it } from "vitest";
import { dispatchAction, readView, type AttentionModel } from "#surface";
import {
  customMessages,
  defineScenario,
  session,
  tool,
  untilMessages,
} from "#test/support/session";

const ASK = "Set QUEUE_MAX_ATTEMPTS in .env.staging: 5 or 8?";

it("lists a waiting task, takes the user's reply, and wakes the agent with it once", async () => {
  // The scenario is an extension too: it hands the test the session's bus.
  let bus: Parameters<typeof readView>[0] | undefined;
  const script = defineScenario({
    replies: [
      [
        [
          tool("todo_upsert", {
            tasks: [
              { key: "limit", subject: "Pick the attempt limit", status: "waiting", message: ASK },
              { key: "dlq", subject: "Dead-letter jobs", dependsOn: ["limit"] },
            ],
          }),
        ],
        "The attempt limit is yours to pick.",
      ],
      // The reply starts this turn.
      ["Using 8 attempts."],
    ],
  });
  const pi = await session({
    scenario: (api) => {
      bus = api.events;
      return script(api);
    },
  });
  const attention = async () => {
    await pi.prompt("/attention");
    return customMessages(pi, "attention").at(-1)!;
  };
  const openItems = () => {
    const open = new Map<string, unknown>();
    for (const entry of pi.entries("work:item")) {
      const record = (entry as { data: { op: string; id: string; data?: unknown } }).data;
      if (record.op === "open") open.set(record.id, record.data);
      else open.delete(record.id);
    }
    return [...open.values()];
  };

  await pi.prompt("Plan the dead-letter queue");
  const listed = await attention();
  expect(listed).toContain("Pick the attempt limit");
  expect(listed).toContain(ASK);

  // A resume while waiting keeps one item, and the reply still reaches the agent.
  await pi.resume();
  const model = readView(bus!, "todo.attention") as AttentionModel;
  expect(model.items).toHaveLength(1);
  const reply = model.items[0]!.reply!;
  expect(openItems()).toEqual([{ key: "limit", rev: (reply.args as { rev: string }).rev }]);

  await expect(
    dispatchAction(bus!, reply.action, { ...(reply.args as object), rev: "0", text: "8" }),
  ).rejects.toThrow("set waiting again since it was shown");
  await dispatchAction(bus!, reply.action, { ...(reply.args as object), text: "8, like payments" });
  await untilMessages(pi, "todo:reply");

  expect(customMessages(pi, "todo:reply")).toEqual([
    `Task limit (Pick the attempt limit) was waiting on you: ${ASK}\nThe user replied: 8, like payments`,
  ]);
  // The model was asked once more, on a context that ends with the reply.
  const woken = pi
    .requests()
    .filter((request) =>
      request.messages.some((m) => m.role === "custom" && m.customType === "todo:reply"),
    );
  expect(woken).toHaveLength(1);
  // The reply, then pi-todo's note that the user moved the task back to pending.
  expect(woken[0]!.messages.slice(-2)).toMatchObject([
    { role: "custom", customType: "todo:reply" },
    { role: "custom", customType: "todo:sync" },
  ]);
  expect(JSON.stringify(woken[0]!.messages.at(-1))).toContain(
    "limit: waiting → pending, by the user",
  );
  expect(openItems()).toEqual([]);
  expect(await attention()).toBe("Nothing needs you in this session.");
  expect(pi.extensionErrors).toEqual([]);
});
