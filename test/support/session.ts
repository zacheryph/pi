/**
 * Helpers for bundle scenarios: one scripted session per test, and readers for
 * what the model was sent and what the session's tools did.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, vi } from "vitest";
import {
  type ContextMessage,
  collectToolRuns,
  type ModelRequest,
  type ScriptedSession,
  type SessionOptions,
  startSession,
  type ToolRun,
} from "#scripted-model/harness";

export { HOLD, defineScenario, startAgent, text, tool } from "#scripted-model/scenario";
export type { ModelRequest, ScriptedSession, ToolRun };

let open: ScriptedSession | undefined;
afterEach(async () => {
  await open?.dispose();
  open = undefined;
});

/** Start the bundle on a scenario; the session is disposed when the test ends. */
export async function session(options: SessionOptions): Promise<ScriptedSession> {
  open = await startSession(options);
  expect(open.extensionErrors).toEqual([]);
  return open;
}

/** A message's text content, joined. */
export function textOf(message: { content?: unknown } | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) => (block.type === "text" ? block.text : ""))
    .join("");
}

type Message = { role: string; content?: unknown; toolName?: string; customType?: string };

/** The text of the newest result of `tool` among `messages`, for a step that needs it. */
export function lastResult(messages: readonly Message[], tool: string): string {
  const result = messages.findLast((m) => m.role === "toolResult" && m.toolName === tool);
  if (!result) throw new Error(`no ${tool} result in the context`);
  return textOf(result);
}

/** The first capture of `pattern` in `text`; throws when it does not match. */
export function capture(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  if (!match?.[1]) throw new Error(`${pattern} did not match: ${text.slice(0, 300)}`);
  return match[1];
}

/** The agent ID a subagent_start result reports. */
export const agentId = (startResult: string) => capture(startResult, /^Agent ID: (\S+)$/m);

/** Custom messages of `customType` in the session's transcript, oldest first. */
export function customMessages(pi: ScriptedSession, customType: string): string[] {
  return pi
    .entries()
    .flatMap((entry) =>
      entry.type === "custom_message" && entry.customType === customType
        ? [textOf(entry as { content?: unknown })]
        : [],
    );
}

/** Wait until `count` custom messages of `customType` arrived and the turns they started ended. */
export async function untilMessages(pi: ScriptedSession, customType: string, count = 1) {
  await vi.waitFor(
    () => {
      expect(customMessages(pi, customType)).toHaveLength(count);
      // The turn the message starts has begun once the model answered it.
      expect(pi.session.messages.at(-1)?.role).toBe("assistant");
    },
    { timeout: 15_000 },
  );
  await pi.session.waitForIdle();
}

/** The main session's tool runs named `name`, oldest first. */
export function runsOf(pi: ScriptedSession, name: string): ToolRun[] {
  return pi.toolRuns().filter((run) => run.name === name);
}

/** The single tool run named `name`, which must have succeeded. */
export function onlyRun(pi: ScriptedSession, name: string): ToolRun {
  const runs = runsOf(pi, name);
  expect(runs, `${name} runs`).toHaveLength(1);
  expect(runs[0]!.isError, runs[0]!.text).toBe(false);
  return runs[0]!;
}

/** Context cards (`role: "custom"` messages extensions add per request) by `customType`. */
export function cards(request: ModelRequest): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const message of request.messages as (ContextMessage & Message)[]) {
    if (message.role !== "custom" || !message.customType) continue;
    found.set(message.customType, [...(found.get(message.customType) ?? []), textOf(message)]);
  }
  return found;
}

/**
 * Tool runs of the subagent a completion message reports, read from the
 * transcript file the message names.
 */
export function childRuns(completion: string): ToolRun[] {
  const file = capture(completion, /<output-file>(.+)<\/output-file>/);
  const messages = SessionManager.open(file)
    .getBranch()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  return collectToolRuns(messages as Parameters<typeof collectToolRuns>[0]);
}
