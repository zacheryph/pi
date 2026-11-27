import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { BUILTIN_AGENTS_DIR, DEFAULT_AGENTS } from "#src/config/default-agents";
import type { AgentConfig } from "#src/types";
import { makeAgentConfig } from "#test/helpers/make-agent-config";

describe("AgentTypeRegistry", () => {
  function makeRegistry(userAgents: Map<string, AgentConfig> = new Map()): AgentTypeRegistry {
    return new AgentTypeRegistry(() => userAgents);
  }

  describe("construction and reload", () => {
    it("loads default agents on construction", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("general-purpose")).toBe(true);
      expect(registry.isValidType("orchestrate")).toBe(true);
      expect(registry.isValidType("explore")).toBe(true);
      expect(registry.isValidType("plan")).toBe(true);
    });

    it("does not call loadUserAgents until construction", () => {
      let callCount = 0;
      const registry = new AgentTypeRegistry(() => {
        callCount++;
        return new Map();
      });
      // constructor calls reload() once
      expect(callCount).toBe(1);
      registry.reload();
      expect(callCount).toBe(2);
    });

    it("reload picks up new agents from loader", () => {
      let userAgents = new Map<string, AgentConfig>();
      const registry = new AgentTypeRegistry(() => userAgents);

      expect(registry.isValidType("auditor")).toBe(false);

      userAgents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registry.reload();

      expect(registry.isValidType("auditor")).toBe(true);
    });

    it("reload clears previous user agents", () => {
      const userAgents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      const registry = new AgentTypeRegistry(() => userAgents);
      expect(registry.isValidType("auditor")).toBe(true);

      userAgents.clear();
      registry.reload();

      expect(registry.isValidType("auditor")).toBe(false);
      expect(registry.isValidType("general-purpose")).toBe(true);
    });
  });

  describe("resolveType", () => {
    it("returns canonical key for exact match", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("explore")).toBe("explore");
      expect(registry.resolveType("general-purpose")).toBe("general-purpose");
    });

    it("returns canonical key for case-insensitive match", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("EXPLORE")).toBe("explore");
      expect(registry.resolveType("GENERAL-PURPOSE")).toBe("general-purpose");
    });

    it("returns undefined for unknown type", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("nonexistent")).toBeUndefined();
    });
  });

  describe("resolveAgentConfig", () => {
    it("returns config for a known enabled type", () => {
      const registry = makeRegistry();
      const config = registry.resolveAgentConfig("explore");
      expect(config.name).toBe("explore");
      expect(config.promptMode).toBe("replace");
    });

    it("performs case-insensitive lookup", () => {
      const registry = makeRegistry();
      const config = registry.resolveAgentConfig("EXPLORE");
      expect(config.name).toBe("explore");
    });

    it("falls back to general-purpose for unknown type", () => {
      const registry = makeRegistry();
      const config = registry.resolveAgentConfig("nonexistent");
      expect(config.name).toBe("general-purpose");
    });

    it("returns config for disabled type (no fallback for existing disabled)", () => {
      const registry = makeRegistry(
        new Map([
          [
            "plan",
            makeAgentConfig({ name: "plan", description: "Disabled", visibility: "disabled" }),
          ],
        ]),
      );
      const config = registry.resolveAgentConfig("plan");
      expect(config.name).toBe("plan");
      expect(config.visibility).toBe("disabled");
    });

    it("returns user-defined agent config", () => {
      const registry = makeRegistry(
        new Map([
          ["auditor", makeAgentConfig({ name: "auditor", description: "Security auditor" })],
        ]),
      );
      const config = registry.resolveAgentConfig("auditor");
      expect(config.name).toBe("auditor");
      expect(config.description).toBe("Security auditor");
    });
  });

  describe("an agent whose file does not parse", () => {
    const broken = makeAgentConfig({ name: "auditor", definitionError: "invalid frontmatter" });

    it("is not valid, available or listed", () => {
      const registry = makeRegistry(new Map([["auditor", broken]]));
      expect(registry.isValidType("auditor")).toBe(false);
      expect(registry.getListedTypes()).not.toContain("auditor");
    });

    it("still shadows the built-in it names", () => {
      const registry = makeRegistry(
        new Map([["plan", makeAgentConfig({ name: "plan", definitionError: "bad" })]]),
      );
      expect(registry.resolveAgentConfig("plan").definitionError).toBe("bad");
      expect(registry.isValidType("plan")).toBe(false);
    });
  });

  describe("getListedTypes", () => {
    it("lists visible agents and those that declare no visibility", () => {
      const registry = makeRegistry(
        new Map([
          ["auditor", makeAgentConfig({ name: "auditor", visibility: "visible" })],
          ["linter", makeAgentConfig({ name: "linter" })],
        ]),
      );
      expect(registry.getListedTypes()).toEqual(expect.arrayContaining(["auditor", "linter"]));
    });

    it("leaves out hidden and disabled agents", () => {
      const registry = makeRegistry(
        new Map([
          ["auditor", makeAgentConfig({ name: "auditor", visibility: "hidden" })],
          ["plan", makeAgentConfig({ name: "plan", visibility: "disabled" })],
        ]),
      );
      expect(registry.getListedTypes()).not.toContain("auditor");
      expect(registry.getListedTypes()).not.toContain("plan");
    });
  });

  describe("getAllTypes", () => {
    it("includes disabled agents", () => {
      const registry = makeRegistry(
        new Map([["plan", makeAgentConfig({ name: "plan", visibility: "disabled" })]]),
      );
      expect(registry.getAllTypes()).toContain("plan");
    });
  });

  describe("isValidType", () => {
    it("returns true for enabled defaults", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("general-purpose")).toBe(true);
      expect(registry.isValidType("explore")).toBe(true);
    });

    it("returns true case-insensitively", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("explore")).toBe(true);
      expect(registry.isValidType("PLAN")).toBe(true);
    });

    it("returns false for disabled agents", () => {
      const registry = makeRegistry(
        new Map([["plan", makeAgentConfig({ name: "plan", visibility: "disabled" })]]),
      );
      expect(registry.isValidType("plan")).toBe(false);
    });

    it("returns true for user agents, and for hidden ones, which spawn by name", () => {
      const registry = makeRegistry(
        new Map([
          ["auditor", makeAgentConfig({ name: "auditor" })],
          ["scout", makeAgentConfig({ name: "scout", visibility: "hidden" })],
        ]),
      );
      expect(registry.isValidType("auditor")).toBe(true);
      expect(registry.isValidType("scout")).toBe(true);
    });

    it("returns false for unknown types", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("nonexistent")).toBe(false);
      expect(registry.isValidType("")).toBe(false);
    });
  });

  describe("getToolNamesForType", () => {
    it("selects all available tools for general-purpose", () => {
      const registry = makeRegistry();
      const names = registry.getToolNamesForType("general-purpose");
      expect(names).toEqual(["all"]);
    });

    it("returns restricted tools for explore", () => {
      const registry = makeRegistry();
      const names = registry.getToolNamesForType("explore");
      expect(names).toEqual([
        "read",
        "bash",
        "grep",
        "find",
        "ls",
        "stash_get",
        "stash_list",
        "stash_put",
      ]);
    });

    it("defaults explore to the newest available Haiku rather than a pinned version", () => {
      expect(makeRegistry().resolveAgentConfig("explore").model).toBe(
        "anthropic/claude-haiku@latest",
      );
    });

    it("lets Plan read the stash but not write to it", () => {
      const registry = makeRegistry();
      expect(registry.getToolNamesForType("plan")).toEqual([
        "read",
        "bash",
        "grep",
        "find",
        "ls",
        "stash_get",
        "stash_list",
      ]);
    });

    it("lets reviewer read and run checks without stash or edit tools", () => {
      const registry = makeRegistry();
      expect(registry.getToolNamesForType("review")).toEqual([
        "read",
        "bash",
        "grep",
        "find",
        "ls",
        "stash_get",
        "stash_list",
      ]);
    });

    it("returns custom tool names for user agent", () => {
      const registry = makeRegistry(
        new Map([["auditor", makeAgentConfig({ name: "auditor", toolNames: ["read", "grep"] })]]),
      );
      expect(registry.getToolNamesForType("auditor")).toEqual(["read", "grep"]);
    });

    it("selects all tools for an unknown type", () => {
      const registry = makeRegistry();
      const names = registry.getToolNamesForType("nonexistent");
      expect(names).toEqual(["all"]);
    });

    it("returns an empty list for an agent that declared tools: none", () => {
      const registry = makeRegistry(
        new Map([["silent", makeAgentConfig({ name: "silent", toolNames: [] })]]),
      );
      expect(registry.getToolNamesForType("silent")).toEqual([]);
    });

    it("selects all available tools for a user agent with no tools key", () => {
      const registry = makeRegistry(
        new Map([
          ["unrestricted", makeAgentConfig({ name: "unrestricted", toolNames: undefined })],
        ]),
      );
      expect(registry.getToolNamesForType("unrestricted")).toEqual(["all"]);
    });

    it("returns a disabled agent's own list rather than the built-ins", () => {
      const registry = makeRegistry(
        new Map([
          [
            "retired",
            makeAgentConfig({ name: "retired", toolNames: ["read"], visibility: "disabled" }),
          ],
        ]),
      );
      expect(registry.getToolNamesForType("retired")).toEqual(["read"]);
    });
  });

  describe("built-in agents", () => {
    it("are loaded from the extension's agents/*.md files", () => {
      const files = readdirSync(BUILTIN_AGENTS_DIR)
        .filter((file) => file.endsWith(".md"))
        .map((file) => file.slice(0, -3));
      expect([...DEFAULT_AGENTS.keys()].sort()).toEqual(files.sort());
      expect([...DEFAULT_AGENTS.keys()]).toEqual(
        expect.arrayContaining(["general-purpose", "orchestrate", "explore", "plan", "review"]),
      );
    });

    it.each([...DEFAULT_AGENTS.keys()])("%s records its built-in source and file", (name) => {
      const config = DEFAULT_AGENTS.get(name)!;
      expect(config.source).toBe("default");
      expect(config.sourcePath).toBe(join(BUILTIN_AGENTS_DIR, `${name}.md`));
    });

    it.each([...DEFAULT_AGENTS.keys()])("%s carries a description and guidance", (name) => {
      const config = DEFAULT_AGENTS.get(name)!;
      expect(config.description).not.toBe(name);
      expect(config.guidance).toMatch(/^Use /);
    });

    it("keeps general-purpose a pure copy of its parent", () => {
      expect(DEFAULT_AGENTS.get("general-purpose")).toMatchObject({
        promptMode: "append",
        systemPrompt: "",
        toolNames: ["all"],
      });
    });
  });

  describe("orchestrator profile", () => {
    it("is discoverable case-insensitively, delegates, and names its todo tools", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("orchestrate")).toBe("orchestrate");
      expect(registry.getListedTypes()).toContain("orchestrate");
      expect(registry.resolveAgentConfig("orchestrate")).toMatchObject({
        name: "orchestrate",
        displayName: "orchestrate",
        source: "default",
        promptMode: "replace",
        delegate: true,
        toolNames: ["all", "todo_list", "todo_upsert", "todo_replace", "todo_remove", "todo_clear"],
        reservedTools: ["edit", "write", "bash", "job_start"],
      });
    });

    it("delegates the work however the request is phrased", () => {
      const prompt = makeRegistry().resolveAgentConfig("orchestrate").systemPrompt;
      expect(prompt).toContain("# Delegation boundary");
      expect(prompt).toContain(
        "as a request for the outcome, not an instruction to do it yourself",
      );
      expect(prompt).toContain("edit, write, bash and job_start are reserved for your workers");
    });

    it("runs implementation tasks in worktrees it hands to workers as cwd", () => {
      const prompt = makeRegistry().resolveAgentConfig("orchestrate").systemPrompt;
      expect(prompt).toContain("Give each implementation task its own git worktree");
      expect(prompt).toContain("pass the returned path as subagent_start's cwd");
      expect(prompt).toContain("send the reviewer and any follow-up worker to the same cwd");
      expect(prompt).toContain("remove it with git_worktree_remove");
      expect(prompt).toContain("Call git_worktree_list and git_pr_list");
      expect(prompt).toContain("call todo_list only if it has not");
      expect(prompt).toContain("subagent_get without agent_id for the workers you started");
    });

    it("reads pull requests with git_pr_status and waits on them with git_pr_watch", () => {
      const prompt = makeRegistry().resolveAgentConfig("orchestrate").systemPrompt;
      expect(prompt).toContain("read it with git_pr_status rather than gh");
      expect(prompt).toContain("Wait on it with git_pr_watch and end your turn; never poll.");
      expect(prompt).not.toContain("job_watch on git_pr_status");
      expect(prompt).toContain("a task to land a PR stays open until it is merged");
      expect(prompt).toContain("Never approve or merge.");
    });

    it("can give a PR owner the CI and review follow-up loop", () => {
      const prompt = makeRegistry().resolveAgentConfig("orchestrate").systemPrompt;
      expect(prompt).toContain("Keep one owner for a PR's watch");
      expect(prompt).toContain("a worker that owns the whole loop with the babysit-pr skill");
      expect(prompt).not.toContain("a watch it starts would wake no one");
    });

    it("sets a task waiting on the user, hands a ready PR to the user, and defers to execute-roadmap", () => {
      const prompt = makeRegistry().resolveAgentConfig("orchestrate").systemPrompt;
      expect(prompt).toContain(
        "set the task waiting with a message saying what you need from the user and where",
      );
      expect(prompt).toContain("Only the main session sets waiting");
      expect(prompt).toContain("pending, in_progress, waiting, completed");
      expect(prompt).not.toContain("Represent a waiting or blocked item as pending");
      expect(prompt).not.toContain("record on the task what it waits on");
      expect(prompt).toContain(
        "A task whose pull request waits on the user's review or merge stays in_progress",
      );
      expect(prompt).toContain("When you run as the main agent and the PR is ready for review");
      expect(prompt).toContain("git_pr_request_review at the full head SHA you checked");
      expect(prompt).not.toContain("user_notify");
      expect(prompt).toContain(
        "To carry out a roadmap document, follow the execute-roadmap skill.",
      );
    });

    it("stays available: delegates in the background and ends its turn instead of waiting", () => {
      const prompt = makeRegistry().resolveAgentConfig("orchestrate").systemPrompt;
      expect(prompt).toContain(
        "Stay available to the user. Subagents always run in the background",
      );
      expect(prompt).toContain("then end your turn. Each completion message wakes you");
      expect(prompt).toContain("Never poll or block on a worker.");
      expect(prompt).not.toMatch(/foreground|wait: true|subagent_get with wait/);
      expect(prompt).not.toContain("wait when progress depends on a worker");
    });

    it("keeps a delegated orchestrator waiting on its open work", () => {
      const prompt = makeRegistry().resolveAgentConfig("orchestrate").systemPrompt;
      expect(prompt).toContain("When you run as a subagent yourself");
      expect(prompt).toContain("Open work keeps you idle and waiting");
      expect(prompt).toContain("its completion wakes you through the concurrency limiter");
      expect(prompt).not.toContain("nothing wakes you");
    });

    it("asks workers to stash large results and name the handle in their final answer", () => {
      const prompt = makeRegistry().resolveAgentConfig("orchestrate").systemPrompt;
      expect(prompt).toContain(
        "ask workers to store large results with stash_put and name the handle in their final answer",
      );
      expect(prompt).toContain("A completion message carries only the first 500 characters");
    });

    it("can be overridden or disabled like every other built-in", () => {
      const custom = makeAgentConfig({
        name: "orchestrate",
        systemPrompt: "Custom PM",
        visibility: "disabled",
      });
      const registry = makeRegistry(new Map([["orchestrate", custom]]));
      expect(registry.resolveAgentConfig("orchestrate")).toBe(custom);
      expect(registry.isValidType("orchestrate")).toBe(false);
    });
  });

  describe("implementation profile", () => {
    it("loads as a non-delegating worker with inherited model settings", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("IMPLEMENT")).toBe("implement");
      expect(registry.getListedTypes()).toContain("implement");
      expect(registry.resolveAgentConfig("implement")).toMatchObject({
        name: "implement",
        displayName: "implement",
        promptMode: "replace",
        toolNames: ["all", "-subagent_start", "-subagent_get", "-subagent_send"],
      });
      expect(registry.resolveAgentConfig("implement").delegate).not.toBe(true);
      expect(registry.resolveAgentConfig("implement").model).toBeUndefined();
    });
  });

  describe("reviewer profile", () => {
    it("is a read-only built-in that reports a verdict without fixing", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("review")).toBe("review");
      const config = registry.resolveAgentConfig("review");
      expect(config).toMatchObject({
        name: "review",
        displayName: "review",
        source: "default",
        promptMode: "replace",
      });
      expect(config.model).toBeUndefined();
      expect(config.toolNames).not.toContain("edit");
      expect(config.toolNames).not.toContain("write");
      expect(config.systemPrompt).toContain("Verdict: PASS");
      expect(config.systemPrompt).toContain("You do NOT fix anything");
    });

    it("is the orchestrator's verifier", () => {
      const prompt = makeRegistry().resolveAgentConfig("orchestrate").systemPrompt;
      expect(prompt).toContain("review for verification");
      expect(prompt).toContain(
        "Verify implementation tasks with a reviewer worker that did not do the work",
      );
    });

    it("yields to a user definition with the same name", () => {
      const custom = makeAgentConfig({ name: "review", systemPrompt: "My review rules" });
      expect(makeRegistry(new Map([["review", custom]])).resolveAgentConfig("review")).toBe(custom);
    });
  });

  describe("assist profile", () => {
    it("delegates but keeps file changes for workers", () => {
      expect(makeRegistry().resolveAgentConfig("assist")).toMatchObject({
        name: "assist",
        displayName: "assist",
        source: "default",
        promptMode: "replace",
        delegate: true,
        reservedTools: ["edit", "write"],
      });
    });

    it("answers first, then confidence, then evidence", () => {
      const prompt = makeRegistry().resolveAgentConfig("assist").systemPrompt;
      const answer = prompt.indexOf("1. **Answer**");
      const confidence = prompt.indexOf("2. **Confidence**");
      const evidence = prompt.indexOf("3. **Evidence**");
      expect(answer).toBeGreaterThan(-1);
      expect(confidence).toBeGreaterThan(answer);
      expect(evidence).toBeGreaterThan(confidence);
    });

    it("looks things up itself and asks before changing state anywhere", () => {
      const prompt = makeRegistry().resolveAgentConfig("assist").systemPrompt;
      expect(prompt).toContain("Read, search, fetch, and run read-only commands yourself");
      expect(prompt).toContain("Read-only means no side effect on any system");
      expect(prompt).toContain("wait for the user's go-ahead");
      expect(prompt).toContain("Never poll through model turns");
    });

    it("keeps incident notes and follow-ups that survive compaction", () => {
      const prompt = makeRegistry().resolveAgentConfig("assist").systemPrompt;
      expect(prompt).toContain("`incident/<short-id>`");
      expect(prompt).toContain(
        "read the note with stash_get before answering about an earlier incident",
      );
      expect(prompt).toContain("`/subagent:switch orchestrate`");
    });
  });

  describe("dig profile", () => {
    it("delegates sweeps without reserving tools", () => {
      const config = makeRegistry().resolveAgentConfig("dig");
      expect(config).toMatchObject({
        name: "dig",
        displayName: "dig",
        source: "default",
        promptMode: "replace",
        delegate: true,
      });
      expect(config.reservedTools ?? []).toEqual([]);
    });

    it("ends each answer with a branch point for /tree", () => {
      const prompt = makeRegistry().resolveAgentConfig("dig").systemPrompt;
      expect(prompt).toContain("**Known**");
      expect(prompt).toContain("**Ruled out**");
      expect(prompt).toContain("**Open**");
      expect(prompt).toContain("this block is where they land");
    });

    it("carries findings across branches as full stash handles", () => {
      const prompt = makeRegistry().resolveAgentConfig("dig").systemPrompt;
      expect(prompt).toContain("give its full handle (stash:<name>@<hash>)");
      expect(prompt).toContain("a bare name from the abandoned branch no longer resolves");
    });
  });

  describe("switch handoffs", () => {
    it.each(["orchestrate", "assist", "dig"])("%s says what a switch to it must keep", (name) => {
      expect(makeRegistry().resolveAgentConfig(name).handoff).toMatch(/\S/);
    });

    it("dig keeps its evidence verbatim and assist its incident notes", () => {
      expect(makeRegistry().resolveAgentConfig("dig").handoff).toContain("copied exactly");
      expect(makeRegistry().resolveAgentConfig("assist").handoff).toContain("stash note handle");
    });

    it("workers carry no handoff", () => {
      expect(makeRegistry().resolveAgentConfig("implement").handoff).toBeUndefined();
    });
  });

  describe("orchestrator routing", () => {
    it("points non-project conversations at assist or dig", () => {
      const prompt = makeRegistry().resolveAgentConfig("orchestrate").systemPrompt;
      expect(prompt).toContain("`/subagent:switch assist`");
      expect(prompt).toContain("`/subagent:switch dig`");
    });
  });

  describe("instance isolation", () => {
    it("two registries have independent state", () => {
      const r1 = makeRegistry(new Map([["auditor", makeAgentConfig({ name: "auditor" })]]));
      const r2 = makeRegistry();

      expect(r1.isValidType("auditor")).toBe(true);
      expect(r2.isValidType("auditor")).toBe(false);
    });
  });
});
