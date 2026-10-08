import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinExtensionsFor } from "#src/session/builtin-extensions";

/** The names of the built-ins selected for `toolNames`, in selection order. */
function namesFor(toolNames: string[]): string[] {
  return builtinExtensionsFor(toolNames).map((extension) => extension.name);
}

describe("builtinExtensionsFor", () => {
  describe("against Pi's resource loader", () => {
    // Pi resolves a built-in through the operator's `extensions` setting by
    // its `builtin:<name>` path, so these names must be Pi's own for a
    // `-builtin:<name>` entry to reach children.
    let agentDir: string;
    let cwd: string;

    beforeEach(() => {
      agentDir = mkdtempSync(join(tmpdir(), "pi-builtins-agent-"));
      cwd = mkdtempSync(join(tmpdir(), "pi-builtins-cwd-"));
    });

    afterEach(() => {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    });

    async function loadedPaths(extensionsSetting: string[]): Promise<string[]> {
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: extensionsSetting }));
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: SettingsManager.create(cwd, agentDir),
        extensionFactories: builtinExtensionsFor(["codemode", "tool_search", "mcp__x__y"]),
      });
      await loader.reload();
      return loader.getExtensions().extensions.map((extension) => extension.path);
    }

    it("loads each selected built-in under its builtin: path", async () => {
      expect(await loadedPaths([])).toEqual([
        "builtin:codemode",
        "builtin:tool-search",
        "builtin:mcp",
      ]);
    });

    it("leaves out a built-in the operator disabled with -builtin:<name>", async () => {
      expect(await loadedPaths(["-builtin:mcp"])).toEqual([
        "builtin:codemode",
        "builtin:tool-search",
      ]);
    });
  });

  describe("selection by tool name", () => {
    it("selects codemode for the codemode tool", () => {
      expect(namesFor(["read", "codemode"])).toEqual(["codemode"]);
    });

    it("selects tool-search for the tool_search tool", () => {
      expect(namesFor(["read", "tool_search"])).toEqual(["tool-search"]);
    });

    it("selects mcp for an mcp__ tool", () => {
      expect(namesFor(["read", "mcp__github__get_issue"])).toEqual(["mcp"]);
    });

    it.each(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"])(
      "selects mcp for the MCP resource tool %s",
      (tool) => {
        expect(namesFor([tool])).toEqual(["mcp"]);
      },
    );

    it("selects nothing for tools no built-in supplies", () => {
      expect(builtinExtensionsFor(["read", "grep"])).toEqual([]);
    });

    it("selects each built-in once, in Pi's order, as a replaceable built-in", () => {
      const selected = builtinExtensionsFor([
        "mcp__a__b",
        "mcp__a__c",
        "tool_search",
        "codemode",
      ]);

      expect(
        selected.map(({ name, builtin, replaceable }) => ({ name, builtin, replaceable })),
      ).toEqual([
        { name: "codemode", builtin: true, replaceable: true },
        { name: "tool-search", builtin: true, replaceable: true },
        { name: "mcp", builtin: true, replaceable: true },
      ]);
    });
  });
});
