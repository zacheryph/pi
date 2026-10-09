import { describe, expect, it, vi } from "vitest";
import { composeAgentInstructions, parseFragments } from "#src/config/prompt-fragments";
import type { AgentConfig } from "#src/types";

const profile: AgentConfig = {
  name: "engineer", description: "Engineering", promptMode: "append",
  systemPrompt: "  PROFILE BODY\n", source: "project", sourcePath: "/project/.pi/agents/engineer.md",
};

describe("fragment declarations", () => {
  it("accepts only an explicit array; omission and empty list need no fragments", () => {
    expect(parseFragments(undefined)).toEqual({});
    expect(parseFragments([])).toEqual({ fragments: [] });
    expect(parseFragments(["aws", "git", "aws", "kube_ops-2"])).toEqual({ fragments: ["aws", "git", "kube_ops-2"] });
  });
  it.each([null, "aws", "aws,git", 1, {}, [false], [null], [1]])("records invalid schema without coercion: %j", value => {
    expect(parseFragments(value).fragmentError).toBeTruthy();
    expect(parseFragments(value).fragments).toBeUndefined();
  });
  it.each(["", "../aws", "a/b", "a\\b", "aws.md", "/aws", "~/aws", "*.md", "${AWS}", " aws ", ".hidden", "a.b"])('rejects path/expression name "%s"', name => {
    expect(parseFragments([name]).fragmentError).toContain("Invalid fragment name");
  });
});

describe("source-local composition", () => {
  it("reads in declared order, once per name, then puts body last", () => {
    const readFile = vi.fn((path: string) => path.endsWith("aws.md") ? "  AWS\n" : "GIT\n");
    const result = composeAgentInstructions({ ...profile, fragments: ["aws", "git", "aws"] }, { projectTrusted: true, readFile });
    expect(readFile.mock.calls).toEqual([["/project/.pi/agents/fragments/aws.md"], ["/project/.pi/agents/fragments/git.md"]]);
    expect(result.body).toBe("PROFILE BODY");
    expect(result.fragments).toEqual([
      { name: "aws", path: "/project/.pi/agents/fragments/aws.md", content: "AWS" },
      { name: "git", path: "/project/.pi/agents/fragments/git.md", content: "GIT" },
    ]);
    expect(result.systemPrompt).toBe("AWS\n\n---\n\nGIT\n\n---\n\nPROFILE BODY");
    expect(profile.systemPrompt).toBe("  PROFILE BODY\n");
  });
  it("global fragments are rooted beside global profile, not session project", () => {
    const readFile = vi.fn(() => "GLOBAL AWS");
    const result = composeAgentInstructions({ ...profile, source: "global", sourcePath: "/custom-agent-home/agents/engineer.md", fragments: ["aws"] }, { readFile });
    expect(readFile).toHaveBeenCalledWith("/custom-agent-home/agents/fragments/aws.md");
    expect(result.systemPrompt).toContain("GLOBAL AWS");
  });
  it("no fragments preserves exact legacy body and never reads files or needs trust", () => {
    const readFile = vi.fn();
    for (const fragments of [undefined, []]) {
      expect(composeAgentInstructions({ ...profile, fragments }, { readFile }).systemPrompt).toBe(profile.systemPrompt);
    }
    expect(readFile).not.toHaveBeenCalled();
  });
  it("untrusted project fragments fail before any file read", () => {
    const readFile = vi.fn();
    expect(() => composeAgentInstructions({ ...profile, fragments: ["aws"] }, { readFile })).toThrow("require Pi project trust");
    expect(() => composeAgentInstructions({ ...profile, fragments: ["aws"] }, { readFile, projectTrusted: false })).toThrow("require Pi project trust");
    expect(readFile).not.toHaveBeenCalled();
  });
  it("invalid declarations fail before any file read", () => {
    const readFile = vi.fn();
    expect(() => composeAgentInstructions({ ...profile, fragmentError: "bad fragment declaration" }, { readFile })).toThrow('Agent "engineer": bad fragment declaration');
    expect(() => composeAgentInstructions({ ...profile, fragments: ["../secret"] }, { readFile, projectTrusted: true })).toThrow("Invalid fragment name");
    expect(readFile).not.toHaveBeenCalled();
  });
  it("fragment names require a source profile path", () => {
    const readFile = vi.fn();
    expect(() => composeAgentInstructions({ ...profile, sourcePath: undefined, fragments: ["aws"] }, { projectTrusted: true, readFile })).toThrow("require a profile source path");
    expect(readFile).not.toHaveBeenCalled();
  });
  it.each(["ENOENT: no such file", "EACCES: permission denied", "EISDIR: directory"])("reports profile, fragment and path for read error: %s", message => {
    expect(() => composeAgentInstructions({ ...profile, fragments: ["aws"] }, {
      projectTrusted: true, readFile: () => { throw new Error(message); },
    })).toThrow(`Agent "engineer" fragment "aws" (/project/.pi/agents/fragments/aws.md): ${message}`);
  });
  it("fragments are literal Markdown, without expansion, recursion or settings merging", () => {
    const text = "---\nmodel: not-a-model\nfragments: [nested]\n---\n${HOME}\n@other.md";
    const readFile = vi.fn(() => text);
    const result = composeAgentInstructions({ ...profile, systemPrompt: "", fragments: ["aws"] }, { projectTrusted: true, readFile });
    expect(result.systemPrompt).toBe(text);
    expect(readFile).toHaveBeenCalledTimes(1);
  });
  it("empty fragments/body add no separators, while keeping source provenance", () => {
    const result = composeAgentInstructions({ ...profile, systemPrompt: "", fragments: ["aws"] }, { projectTrusted: true, readFile: () => "\n \n" });
    expect(result.systemPrompt).toBe("");
    expect(result.fragments).toHaveLength(1);
  });
});
