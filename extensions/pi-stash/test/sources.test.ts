import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guessMime, literalContent, readCwdFile, readToolResult } from "#src/sources";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-stash-sources-"));
  dirs.push(dir);
  return dir;
}

describe("readCwdFile", () => {
  it("reads files inside the cwd with read-style spelling", () => {
    const cwd = temp();
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "data.json"), '{"a":1}');
    expect(readCwdFile("@src/data.json", cwd, 1000)).toEqual({
      text: '{"a":1}',
      mime: "application/json",
      source: "path:src/data.json",
    });
    expect(readCwdFile(join(cwd, "src", "data.json"), cwd, 1000).source).toBe("path:src/data.json");
  });

  it("rejects paths and symlinks that leave the cwd", () => {
    const base = temp();
    const cwd = join(base, "project");
    mkdirSync(cwd);
    writeFileSync(join(base, "secret.txt"), "secret");
    symlinkSync(join(base, "secret.txt"), join(cwd, "link.txt"));
    expect(() => readCwdFile("../secret.txt", cwd, 1000)).toThrow(/outside the working directory/);
    expect(() => readCwdFile(join(base, "secret.txt"), cwd, 1000)).toThrow(/outside/);
    expect(() => readCwdFile("link.txt", cwd, 1000)).toThrow(/outside/);
    expect(() => readCwdFile("missing.txt", cwd, 1000)).toThrow(/File not found/);
  });

  it("rejects directories, binary files, and oversized files", () => {
    const cwd = temp();
    mkdirSync(join(cwd, "dir"));
    writeFileSync(join(cwd, "bin"), Buffer.from([1, 0, 2]));
    writeFileSync(join(cwd, "big.txt"), "x".repeat(20));
    expect(() => readCwdFile("dir", cwd, 1000)).toThrow(/Not a regular file/);
    expect(() => readCwdFile("bin", cwd, 1000)).toThrow(/Binary/);
    expect(() => readCwdFile("big.txt", cwd, 10)).toThrow(/limit is 10 bytes/);
  });
});

describe("readToolResult", () => {
  const entry = (toolCallId: string, text: string, details?: unknown) => ({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "grep",
      content: [
        { type: "text", text },
        { type: "image", data: "x" },
      ],
      details,
    },
  });

  it("joins the text content of the matching result on the branch", () => {
    expect(readToolResult([entry("a", "first"), entry("b", "second")], "b", 1000)).toEqual({
      text: "second",
      mime: "text/plain",
      source: "tool:grep",
    });
    expect(() => readToolResult([entry("a", "first")], "zzz", 1000)).toThrow(
      /No tool result with id "zzz"/,
    );
    expect(() => readToolResult([entry("a", "x".repeat(20))], "a", 10)).toThrow(/limit/);
  });

  it("prefers a full output file in the temp directory and ignores others", () => {
    const dir = temp();
    const full = join(dir, "full.log");
    writeFileSync(full, "complete output");
    expect(
      readToolResult([entry("a", "truncated", { fullOutputPath: full })], "a", 1000).text,
    ).toBe("complete output");
    expect(
      readToolResult([entry("a", "truncated", { fullOutputPath: "/etc/hostname" })], "a", 1000)
        .text,
    ).toBe("truncated");
    expect(
      readToolResult([entry("a", "truncated", { fullOutputPath: "relative" })], "a", 1000).text,
    ).toBe("truncated");
  });
});

describe("literal content and mime", () => {
  it("guesses JSON and enforces the size cap", () => {
    expect(literalContent("[1,2]", 100).mime).toBe("application/json");
    expect(literalContent("{ broken", 100).mime).toBe("text/plain");
    expect(guessMime("", "notes.md")).toBe("text/markdown");
    expect(() => literalContent("é".repeat(10), 10)).toThrow(/20 bytes/);
  });
});
