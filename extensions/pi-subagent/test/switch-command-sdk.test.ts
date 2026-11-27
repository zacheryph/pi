import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  profilesAction,
  runSwitchCommand,
  switchAction,
  type SwitchCommandDeps,
} from "#src/handlers/switch-command";
import {
  MAIN_AGENT_ENTRY,
  MAIN_AGENT_REQUIRED_TOOLS,
  registerMainAgentProfile,
  type MainAgentSnapshot,
} from "#src/main-agent-profile";
import type { AgentConfig } from "#src/types";
import { actionRegistry, dispatchAction, type ActionBus } from "#surface";
import { fauxSession } from "#test-helpers";

const PROFILES: Record<string, AgentConfig> = {
  planner: {
    name: "planner",
    description: "Coordinates",
    promptMode: "replace",
    systemPrompt: "PLANNER RULES",
    toolNames: ["read"],
  },
  digger: {
    name: "digger",
    description: "Investigates",
    promptMode: "replace",
    systemPrompt: "DIGGER RULES",
    toolNames: ["read"],
    handoff: "Known, Ruled out and Open, with evidence copied exactly.",
  },
};

async function harness(options: { history?: boolean } = {}) {
  const shown: string[] = [];
  let bus: ActionBus | undefined;
  const sessionManager = SessionManager.inMemory(process.cwd());
  if (options.history !== false) {
    sessionManager.appendMessage({ role: "user", content: "Why is rack 12 slow?", timestamp: 1 });
    sessionManager.appendMessage(fauxAssistantMessage("Delegating to a worker.", { timestamp: 2 }));
    sessionManager.appendMessage({ role: "user", content: "And rack 14?", timestamp: 3 });
    sessionManager.appendMessage(fauxAssistantMessage("Delegating again.", { timestamp: 4 }));
  }
  const snapshot: MainAgentSnapshot = { version: 1, profile: PROFILES.planner! };
  sessionManager.appendCustomEntry(MAIN_AGENT_ENTRY, snapshot);
  const h = await fauxSession({
    cleanup: onTestFinished,
    sessionManager,
    settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
    extensions: [
      (pi) => {
        // Every main profile needs the delegation tools; pi-subagent registers them.
        for (const name of MAIN_AGENT_REQUIRED_TOOLS)
          pi.registerTool({
            name,
            label: name,
            description: name,
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
          });
        const profile = registerMainAgentProfile(pi, {
          resolveProfile: (name) => {
            const found = PROFILES[name];
            if (!found) throw new Error(`Unknown main agent profile: "${name}".`);
            return structuredClone(found);
          },
          diagnostic: () => {},
          env: () => undefined,
        });
        const deps: SwitchCommandDeps = {
          profiles: () => Object.values(PROFILES),
          resolve: (name) => {
            const found = PROFILES[name];
            if (!found) throw new Error(`Unknown main agent profile: "${name}".`);
            return found;
          },
          current: () => profile.current(),
          activate: (c, name) => profile.switchTo(c, name),
          show: (_c, text) => shown.push(text),
        };
        pi.registerCommand("subagent:switch", {
          description: "switch",
          handler: (args, ctx) => runSwitchCommand(args, ctx, deps),
        });
        bus = pi.events;
        const actions = actionRegistry(pi.events);
        pi.on("session_start", (_event, ctx) => {
          actions.dispose();
          actions.define(profilesAction(() => ctx, deps));
          actions.define(switchAction(() => ctx, deps));
        });
      },
    ],
  });
  return { ...h, shown, bus: bus! };
}

const text = (value: unknown) => JSON.stringify(value);

describe("/subagent:switch / installed SDK", () => {
  it("compacts with the target's handoff, then runs the target profile", async () => {
    const h = await harness();
    h.faux.setResponses([
      fauxAssistantMessage("SUMMARY FOR DIGGER"),
      fauxAssistantMessage("Digging."),
    ]);

    await h.session.prompt("/subagent:switch digger the rack 12 traceroutes");

    const summaryRequest = text(h.requests.at(-1));
    expect(summaryRequest).toContain("to the digger agent profile");
    expect(summaryRequest).toContain("from the planner agent profile");
    expect(summaryRequest).toContain("Known, Ruled out and Open, with evidence copied exactly.");
    expect(summaryRequest).toContain("The user also asked to keep: the rack 12 traceroutes");
    expect(summaryRequest).toContain("stash handles (stash:<name>@<hash>)");

    const branch = h.sessionManager.getBranch();
    const compaction = branch.findIndex((e) => e.type === "compaction");
    const switched = branch.findLastIndex(
      (e) =>
        e.type === "custom" &&
        e.customType === MAIN_AGENT_ENTRY &&
        (e.data as MainAgentSnapshot).profile.name === "digger",
    );
    expect(compaction).toBeGreaterThan(-1);
    expect(switched).toBeGreaterThan(compaction);
    expect(h.shown.at(-1)).toBe("Compacted for digger and switched.");

    await h.session.prompt("Continue");
    const next = text(h.requests.at(-1));
    expect(next).toContain("DIGGER RULES");
    expect(next).not.toContain("PLANNER RULES");
    expect(next).toContain("SUMMARY FOR DIGGER");
  });

  it("switches without a summary when there is nothing to compact", async () => {
    const h = await harness({ history: false });

    await h.session.prompt("/subagent:switch digger");

    expect(h.requests).toHaveLength(0);
    expect(h.sessionManager.getBranch().some((e) => e.type === "compaction")).toBe(false);
    expect(h.shown.at(-1)).toBe("Nothing to compact; switched to digger.");
    await h.session.prompt("Continue");
    expect(text(h.requests.at(-1))).toContain("DIGGER RULES");
  });

  it("does the same through the actions a host without slash commands runs", async () => {
    const h = await harness();
    h.faux.setResponses([
      fauxAssistantMessage("SUMMARY FOR DIGGER"),
      fauxAssistantMessage("Digging."),
    ]);

    expect(await dispatchAction(h.bus, "subagent.profiles")).toEqual({
      profiles: [
        { name: "planner", description: "Coordinates", running: true },
        { name: "digger", description: "Investigates", running: false },
      ],
    });
    expect(
      await dispatchAction(h.bus, "subagent.switch", {
        profile: "digger",
        keep: "the rack 12 traceroutes",
      }),
    ).toEqual({ switching: "digger" });
    await vi.waitFor(() => expect(h.shown.at(-1)).toBe("Compacted for digger and switched."));
    expect(text(h.requests.at(-1))).toContain(
      "The user also asked to keep: the rack 12 traceroutes",
    );

    await h.session.prompt("Continue");
    const next = text(h.requests.at(-1));
    expect(next).toContain("DIGGER RULES");
    expect(next).toContain("SUMMARY FOR DIGGER");
  });
});
