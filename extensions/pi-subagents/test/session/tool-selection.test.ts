import { describe, expect, it } from "vitest";
import { resolveToolSelection } from "#src/session/tool-selection";

const AVAILABLE = [
  "read", "bash", "codemode", "tool_search", "extension_tool",
  "mcp__github__get_issue", "mcp__github__list_issues",
  "mcp__github__get_pull_request", "mcp__gitlab__get_issue",
];

describe("resolveToolSelection", () => {
  it("defaults to all registered built-in and extension tools", () => {
    expect(resolveToolSelection(undefined, AVAILABLE).toolNames).toEqual(AVAILABLE);
    expect(resolveToolSelection(["all"], AVAILABLE).toolNames).toEqual(AVAILABLE);
  });

  it("supports all with exact and server-wide exclusions", () => {
    expect(resolveToolSelection(["all", "-bash", "-mcp__github__*"], AVAILABLE).toolNames)
      .toEqual(AVAILABLE.filter(n => n !== "bash" && !n.startsWith("mcp__github__")));
  });

  it("treats negative-only selectors as all minus the exclusions", () => {
    expect(resolveToolSelection(["-bash", "-extension_tool"], AVAILABLE).toolNames)
      .toEqual(AVAILABLE.filter(n => n !== "bash" && n !== "extension_tool"));
  });

  it("applies exclusions after additions regardless of their order", () => {
    expect(resolveToolSelection(["-bash", "all", "bash"], AVAILABLE).toolNames)
      .toEqual(AVAILABLE.filter(n => n !== "bash"));
  });

  it("preserves explicit allowlists and excludes from those allowlists", () => {
    expect(resolveToolSelection(["read", "extension_tool", "-extension_tool"], AVAILABLE).toolNames)
      .toEqual(["read"]);
    expect(resolveToolSelection(["read", "bash"], AVAILABLE).toolNames).toEqual(["read", "bash"]);
  });

  it("supports none and empty lists", () => {
    expect(resolveToolSelection([], AVAILABLE).toolNames).toEqual([]);
    expect(resolveToolSelection(["none"], AVAILABLE).toolNames).toEqual([]);
  });

  it("expands MCP patterns with order preservation and deduplication", () => {
    expect(resolveToolSelection(["mcp__github__list_issues", "mcp__github__*"], AVAILABLE).toolNames)
      .toEqual(["mcp__github__list_issues", "mcp__github__get_issue", "mcp__github__get_pull_request"]);
  });

  it("supports prefix and whole-name matching", () => {
    expect(resolveToolSelection(["mcp__github__get_*"], AVAILABLE).toolNames)
      .toEqual(["mcp__github__get_issue", "mcp__github__get_pull_request"]);
    expect(resolveToolSelection(["mcp__git*x"], ["mcp__github__x", "mcp__github__xy"]).toolNames)
      .toEqual(["mcp__github__x"]);
  });

  it("matches regex metacharacters literally", () => {
    expect(resolveToolSelection(["mcp__a.b*"], ["mcp__aXb_c", "mcp__a.b_c"]).toolNames)
      .toEqual(["mcp__a.b_c"]);
  });

  it("does not re-add excluded literal names through positive patterns", () => {
    expect(resolveToolSelection(["-mcp__github__get_issue", "mcp__github__*"], AVAILABLE).toolNames)
      .toEqual(["mcp__github__list_issues", "mcp__github__get_pull_request"]);
  });

  it("keeps explicit missing literals for child-local registration", () => {
    expect(resolveToolSelection(["read", "child_extension_tool"], ["read"]).toolNames)
      .toEqual(["read", "child_extension_tool"]);
  });

  it("keeps missing literal exclusions for later protocol-tool filtering", () => {
    expect(resolveToolSelection(["all", "-subagent"], ["read"]).excludedToolNames)
      .toEqual(["subagent"]);
  });

  it("reports unmatched positive MCP globs but not negative globs", () => {
    expect(resolveToolSelection(["read", "mcp__jira__*", "-mcp__missing__*"], AVAILABLE))
      .toEqual({ toolNames: ["read"], unmatchedPatterns: ["mcp__jira__*"], excludedToolNames: [] });
  });

  it("deduplicates a parent tool registry snapshot", () => {
    expect(resolveToolSelection(["all"], ["read", "read", "tool_search"]).toolNames)
      .toEqual(["read", "tool_search"]);
  });
});
