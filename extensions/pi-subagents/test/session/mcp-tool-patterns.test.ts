import { describe, expect, it } from "vitest";
import { expandMcpToolPatterns } from "#src/session/mcp-tool-patterns";

const PARENT_TOOLS = [
  "read",
  "codemode",
  "mcp__github__get_issue",
  "mcp__github__list_issues",
  "mcp__github__get_pull_request",
  "mcp__gitlab__get_issue",
];

describe("expandMcpToolPatterns", () => {
  describe("literal entries", () => {
    it("passes them through in order", () => {
      expect(expandMcpToolPatterns(["read", "codemode", "mcp__other__tool"], PARENT_TOOLS)).toEqual({
        toolNames: ["read", "codemode", "mcp__other__tool"],
        unmatchedPatterns: [],
      });
    });

    it("keeps a starred entry without the mcp__ prefix as a literal name", () => {
      expect(expandMcpToolPatterns(["github_*"], ["github_search"])).toEqual({
        toolNames: ["github_*"],
        unmatchedPatterns: [],
      });
    });
  });

  describe("mcp__ patterns", () => {
    it("expands a whole server to its tools, in the parent's order", () => {
      expect(expandMcpToolPatterns(["read", "mcp__github__*"], PARENT_TOOLS).toolNames).toEqual([
        "read",
        "mcp__github__get_issue",
        "mcp__github__list_issues",
        "mcp__github__get_pull_request",
      ]);
    });

    it("expands a prefix to the subset it matches", () => {
      expect(expandMcpToolPatterns(["mcp__github__get_*"], PARENT_TOOLS).toolNames).toEqual([
        "mcp__github__get_issue",
        "mcp__github__get_pull_request",
      ]);
    });

    it("expands mcp__* to every MCP tool", () => {
      expect(expandMcpToolPatterns(["mcp__*"], PARENT_TOOLS).toolNames).toEqual([
        "mcp__github__get_issue",
        "mcp__github__list_issues",
        "mcp__github__get_pull_request",
        "mcp__gitlab__get_issue",
      ]);
    });

    it("matches the whole name, not a prefix of it", () => {
      expect(
        expandMcpToolPatterns(["mcp__git*x"], ["mcp__github__x", "mcp__github__xy"]).toolNames,
      ).toEqual(["mcp__github__x"]);
    });

    it("treats regex metacharacters in a pattern literally", () => {
      expect(expandMcpToolPatterns(["mcp__a.b*"], ["mcp__aXb_c", "mcp__a.b_c"]).toolNames).toEqual([
        "mcp__a.b_c",
      ]);
    });

    it("lists a tool a literal and a pattern both name once", () => {
      expect(
        expandMcpToolPatterns(["mcp__github__list_issues", "mcp__github__*"], PARENT_TOOLS).toolNames,
      ).toEqual([
        "mcp__github__list_issues",
        "mcp__github__get_issue",
        "mcp__github__get_pull_request",
      ]);
    });

    it("drops a pattern that matches nothing and reports it", () => {
      expect(expandMcpToolPatterns(["read", "mcp__jira__*"], PARENT_TOOLS)).toEqual({
        toolNames: ["read"],
        unmatchedPatterns: ["mcp__jira__*"],
      });
    });
  });
});
