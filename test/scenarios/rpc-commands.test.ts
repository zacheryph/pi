/**
 * Every slash command in a host that runs Pi over RPC (bb): `ctx.mode` is "rpc", dialogs work,
 * `ctx.ui.notify` is dropped and `ctx.ui.custom()` returns undefined. Each command must answer with
 * a displayed custom message (or a dialog), and none of those messages may reach the model.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import {
  customMessages,
  defineScenario,
  session,
  startAgent,
  tool,
  untilMessages,
} from "#test/support/session";

/** An RPC host's UI: dialogs answer, notifications are recorded (bb drops them), custom() is undefined. */
function rpcUi() {
  const dialogs: string[] = [];
  const ui = {
    notify: vi.fn(),
    select: vi.fn(async (title: string, options: string[]) => {
      dialogs.push(title);
      return options[0];
    }),
    input: vi.fn(async (title: string) => {
      dialogs.push(title);
      return "Write tests";
    }),
    confirm: vi.fn(async (title: string) => {
      dialogs.push(title);
      return true;
    }),
    custom: vi.fn(async () => undefined),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    setTitle: vi.fn(),
    setWorkingMessage: vi.fn(),
    setFooter: vi.fn(),
    setHeader: vi.fn(),
    onTerminalInput: vi.fn(() => () => {}),
  };
  return { ui: ui as unknown as ExtensionUIContext, notify: ui.notify, dialogs, spies: ui };
}

/** Every command: what to type, the message type it answers with, and a pattern for its text. */
const COMMANDS: Array<[command: string, type: string, text: RegExp]> = [
  ["/todo", "todo:output", /^Todos 0\/1 completed\n○ a: Write docs \[pending\]/],
  ["/todo:add", "todo:output", /^Added write-tests \(pending\)/],
  ["/todo:update a in_progress", "todo:output", /^Updated a\.$/],
  ["/todo:review", "todo:output", /^No unreviewed task messages\.$/],
  ["/todo:remove write-tests", "todo:output", /^Removed tasks/],
  ["/todo:settings", "todo:output", /^Task settings saved to \.pi\/todo\.json\.$/],
  ["/todo:clear", "todo:output", /^Cleared task list\.$/],
  ["/stash", "stash:output", /^stash:notes@\w+ · 17 B · 2 lines/],
  ["/stash:gc", "stash:output", /^Stash GC: removed 0 blobs, freed 0 B; 1 kept/],
  ["/git:worktrees", "git:output", /^No worktrees in this session's ledger\.$/],
  ["/git:worktrees remove", "git:output", /^No worktrees to remove\.$/],
  ["/git:prs", "git:output", /^Opened here:\n {2}\(none\)\n\nReferenced:\n {2}\(none\)$/],
  ["/git:refresh", "git:output", /^Refreshed 0 of 0 open pull requests; worktrees checked\.$/],
  ["/job", "job:output", /^No background jobs in this session\.\nlogs: /],
  ["/job kill j9", "job:output", /^Error: .*j9/],
  [
    "/subagent:watch",
    "subagent:output",
    /^Warning: The subagent watch overlay needs the terminal UI/,
  ],
  [
    "/subagent:agents",
    "subagent:output",
    /^Subagent agents \(\d+\), read-only[\s\S]*- general-purpose \[/,
  ],
  [
    "/subagent:sessions",
    "subagent:output",
    /^agent \(Do task A\)\nuser: Do task A\.\nassistant: A is done\.$/,
  ],
  ["/subagent:settings", "subagent:output", /./],
  ["/system:prompt", "system:output", /^System insights · System prompt\n/],
  ["/system:tools", "system:output", /^System insights · Tools\n[\s\S]*\n- read /],
  ["/system:skills", "system:output", /^System insights · Skills\n/],
  ["/tldr", "tldr:output", /^TLDR · scripted\nPremise: scripted\n/],
  ["/dashboard", "dashboard:output", /Dashboard/],
  ["/work:wake", "work:output", /^pi-work: no work is waiting for an answer\.$/],
];

it("answers every command with a displayed message in RPC mode, and keeps them from the model", async () => {
  const host = rpcUi();
  const pi = await session({
    mode: "rpc",
    ui: host.ui,
    // A throwaway stash and settings: nothing outside the session's own directory is written.
    scenario: defineScenario({
      replies: [
        [
          [
            tool("todo_upsert", { tasks: [{ key: "a", subject: "Write docs" }] }),
            tool("stash_put", { name: "notes", content: "line one\nline two" }),
          ],
          [
            startAgent({
              type: "general-purpose",
              description: "Do task A",
              prompt: "Do task A.",
              steps: ["A is done."],
            }),
          ],
          "Started.",
        ],
        // The subagent's completion message starts the second turn.
        ["Noted."],
        ["Hello."],
      ],
    }),
  });

  await pi.prompt("Set things up");
  await untilMessages(pi, "subagent:completion");
  // The commands reach the session's extensions only: nothing here is a model turn.
  const turns = pi.requests().length;

  for (const [command, type, text] of COMMANDS) {
    const before = customMessages(pi, type).length;
    await pi.prompt(command);
    const messages = customMessages(pi, type);
    expect(messages.length, `${command} answered with a ${type} message`).toBe(before + 1);
    expect(messages.at(-1), command).toMatch(text);
  }
  expect(pi.requests()).toHaveLength(turns);
  // bb drops notifications, so nothing a command said depends on them.
  expect(host.notify).not.toHaveBeenCalled();
  expect(host.spies.custom).not.toHaveBeenCalled();
  expect(host.dialogs).toEqual(
    expect.arrayContaining(["New task subject", "Clear task list?", "Task settings", "Settings"]),
  );

  // The messages are in the session and displayed ...
  const shown = pi
    .entries()
    .filter(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType.endsWith(":output") &&
        entry.display === true,
    );
  expect(shown).toHaveLength(COMMANDS.length);

  // ... and a later model turn does not see any of them.
  await pi.prompt("Say hello");
  const request = pi.requests().at(-1)!;
  expect(
    request.messages.filter((m) => m.role === "custom" && (m.customType ?? "").endsWith(":output")),
  ).toEqual([]);
  expect(request.messages.some((m) => m.role === "user")).toBe(true);
});
