import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AssistantMessage, JsonObject, NestedToolCallRecord, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry, type Skill } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { buildSkillsView, normalizeSkillPath, SKILL_READ_ENTRY, skillReadEvidence } from "../src/skills.js";

const cwd = "/project";
const file = "/project/skills/sample/SKILL.md";
function skill(name = "sample", filePath = file, commandOnly = false): Skill {
  return {
    name, description: `Description ${name}`, filePath, baseDir: dirname(filePath),
    sourceInfo: { path: filePath, source: "project", scope: "project", origin: "top-level" },
    disableModelInvocation: commandOnly,
  };
}
function assistant(id = "read-1", input: JsonObject = { path: file }, name = "read"): AssistantMessage {
  const call: ToolCall = { type: "toolCall", id, name, arguments: input };
  return {
    role: "assistant", content: [call], api: "anthropic-messages", provider: "anthropic", model: "test", stopReason: "toolUse", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
function result(id = "read-1", isError = false, toolName = "read", nested?: NestedToolCallRecord[]): ToolResultMessage {
  return {
    role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text: "SECRET SKILL CONTENT" }], isError, timestamp: 2,
    ...(nested ? { nestedCalls: { calls: nested, complete: false } } : {}),
  };
}
function user(content: UserMessage["content"]): UserMessage {
  return { role: "user", content, timestamp: 1 };
}
let nextId = 0;
function base() {
  return { id: `entry-${nextId++}`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
}
function message(value: AssistantMessage | ToolResultMessage | UserMessage): SessionEntry {
  return { ...base(), type: "message", message: value };
}
function marker(path = file, partial = false): SessionEntry {
  return { ...base(), type: "custom", customType: SKILL_READ_ENTRY, data: { path, partial } };
}
function compaction(): SessionEntry {
  return { ...base(), type: "compaction", summary: "Summary", firstKeptEntryId: "kept", tokensBefore: 100 };
}
function nested(id = "parent/1", args: Record<string, string | number> = { path: file }, status: NestedToolCallRecord["status"] = "ok"): NestedToolCallRecord {
  return { id, name: "read", arguments: args, status };
}
function item(entries: readonly SessionEntry[], discovered = skill()) {
  return buildSkillsView([discovered], entries, cwd).items![0]!;
}

const tempDirs: string[] = [];
afterEach(() => { for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("path normalization and live read evidence", () => {
  it("normalizes relative, absolute, dot segments, tilde and missing paths", () => {
    expect(normalizeSkillPath("./skills/sample/../sample/SKILL.md", cwd)).toBe(file);
    expect(normalizeSkillPath(file, cwd)).toBe(file);
    expect(normalizeSkillPath("~/missing-skill-insights/SKILL.md", cwd)).toBe(resolve(homedir(), "missing-skill-insights/SKILL.md"));
    expect(normalizeSkillPath("~", cwd)).toBe(normalizeSkillPath(homedir(), cwd));
  });

  it("canonicalizes symlinks and matches discovery paths without reading contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-insights-"));
    tempDirs.push(dir);
    const actual = join(dir, "SKILL.md");
    const link = join(dir, "alias.md");
    writeFileSync(actual, "SECRET FILE CONTENT NEVER DISPLAYED");
    symlinkSync(actual, link);
    expect(normalizeSkillPath(link, cwd)).toBe(normalizeSkillPath(actual, cwd));
    const view = item([message(assistant("link", { path: link })), message(result("link"))], skill("sample", actual));
    expect(view.status).toBe("loaded");
    expect(view.detail).not.toContain("SECRET");
  });

  it.each([{ path: "skills/sample/SKILL.md" }, { path: file, offset: null, limit: null }])("accepts successful complete-range observations %j", (input) => {
    expect(skillReadEvidence({ toolName: "read", input, isError: false }, cwd)).toEqual({ path: file, partial: false });
  });
  it.each([{ path: file, offset: 1 }, { path: file, offset: 4 }, { path: file, limit: 20 }])("labels explicit offset/limit partial %j", (input) => {
    expect(skillReadEvidence({ toolName: "read", input, isError: false }, cwd)).toEqual({ path: file, partial: true });
  });
  it.each([
    { toolName: "read", input: { path: file }, isError: true },
    { toolName: "bash", input: { path: file }, isError: false },
    { toolName: "read", input: {}, isError: false },
    { toolName: "read", input: { path: 123 }, isError: false },
    { toolName: "read", input: { path: " " }, isError: false },
  ])("rejects failures, non-read, invalid path %j", (event) => {
    expect(skillReadEvidence(event, cwd)).toBeUndefined();
  });
});

describe("discovered skill metadata", () => {
  it("shows metadata and command-only status, never contents or false unloaded claims", () => {
    const view = buildSkillsView([skill("z-last"), skill("a-first", "/missing.md", true)], [], cwd);
    expect(view.items?.map((row) => row.label)).toEqual(["a-first", "z-last"]);
    const first = view.items![0]!;
    expect(first.status).toBe("not observed · command-only");
    expect(first.detail).toContain("Description: Description a-first");
    expect(first.detail).toContain("Path:        /missing.md");
    expect(first.detail).toContain("Source:      project");
    expect(first.detail).toContain("Invocation:  command-only");
    expect(first.detail).not.toContain('"source":');
    expect(first.detail).toContain("not proof of being unloaded");
    expect(first.detail.split("\n")[0]).toBe("Name:        a-first");
    expect(first.description).toBe("Description a-first");
    expect(first.badge).toEqual({ label: "[loaded]", color: "dim" });
    expect(view.note).toContain("no skill files opened");
    expect(view.legend).toEqual([
      { label: "[loaded]", color: "success", meaning: "fresh observation" },
      { label: "[loaded]", color: "dim", meaning: "unobserved/dirty" },
    ]);
    expect(buildSkillsView([], [], cwd).items).toEqual([]);
  });
});

describe("detail presentation", () => {
  it("aligns multiline descriptions, short source, and invocation without opening files", () => {
    const discovered = { ...skill(), description: "First line\nSecond line\r\nThird line" };
    const snapshot = structuredClone(discovered);
    const row = item([], discovered);
    expect(row.detail).toContain("Description: First line\n             Second line\n             Third line");
    expect(row.detail).toContain("Invocation:  auto");
    expect(row.detail).not.toContain("Loading:");
    expect(row.detail.match(/\/project\/skills\/sample\/SKILL.md/g)).toHaveLength(1);
    expect(row.description).toBe(discovered.description);
    expect(discovered).toEqual(snapshot);
  });

  it("shows missing source without a raw JSON dump", () => {
    const discovered = { ...skill(), sourceInfo: undefined } as unknown as Skill;
    expect(item([], discovered).detail).toContain("Source:      (not available)");
  });

  it("uses identical loaded badge label with fresh/dim colors independently of status", () => {
    for (const [entries, color] of [
      [[], "dim"], [[marker()], "success"], [[marker(file, true)], "success"],
      [[marker(), compaction()], "dim"], [[marker(file, true), compaction()], "dim"],
      [[marker(), compaction(), marker()], "success"],
    ] as const) expect(item(entries).badge).toEqual({ label: "[loaded]", color });
    expect(item([marker(), compaction()]).detail).toContain("Loading:     loaded · dirty");
    expect(item([marker(), compaction()]).detail.match(/Pre-compaction/g)).toHaveLength(1);
  });
});

describe("branch evidence", () => {
  it("pairs read toolResult with matching assistant id and name", () => {
    expect(item([message(assistant()), message(result())]).status).toBe("loaded");
    expect(item([message(result())]).status).toBe("not observed");
    expect(item([message(assistant("other")), message(result())]).status).toBe("not observed");
    expect(item([message(assistant("read-1", { path: file }, "bash")), message(result())]).status).toBe("not observed");
    expect(item([message(assistant()), message(result("read-1", false, "bash"))]).status).toBe("not observed");
  });

  it("never infers pending, failed, unknown-path, raw command, or codemode script loads", () => {
    for (const entries of [
      [message(assistant())],
      [message(assistant()), message(result("read-1", true))],
      [message(assistant("unknown", { path: "/another/SKILL.md" })), message(result("unknown"))],
      [message(user("/skill:sample arguments"))],
      [message(assistant("script", { code: `await tools.read({path: '${file}'})` }, "codemode")), message(result("script", false, "codemode"))],
    ]) expect(item(entries).status).toBe("not observed");
  });

  it("shows explicit partial reads without inferring full-file load", () => {
    const row = item([message(assistant("partial", { path: file, limit: 10 })), message(result("partial"))]);
    expect(row.status).toBe("loaded · partial");
    expect(row.detail).toContain("Partial read: explicit offset/limit");
    expect(row.badge).toEqual({ label: "[loaded]", color: "success" });
    expect(row.detail).not.toContain("SECRET SKILL CONTENT");
  });

  it("reads expanded user blocks through Pi parser, including text-array content and command-only skills", () => {
    const block = `<skill name="sample" location="${file}">\nSECRET EXPANDED CONTENT\n</skill>\n\nDo task`;
    expect(item([message(user(block))], skill("sample", file, true)).status).toBe("loaded · command-only");
    const row = item([message(user([{ type: "text", text: block }]))]);
    expect(row.status).toBe("loaded");
    expect(row.detail).toContain("expanded user skill block");
    expect(row.detail).not.toContain("SECRET EXPANDED CONTENT");
    expect(item([message(user(block.replace('name="sample"', 'name="other"')))]).status).toBe("not observed");
    expect(item([message(user(block.replace(file, "/unknown.md")))]).status).toBe("not observed");
  });

  it("matches relative and tilde evidence against discovered paths", () => {
    expect(item([message(assistant("relative", { path: "skills/sample/SKILL.md" })), message(result("relative"))]).status).toBe("loaded");
    const homePath = resolve(homedir(), "missing-skill-insights/SKILL.md");
    expect(item([message(assistant("home", { path: "~/missing-skill-insights/SKILL.md" })), message(result("home"))], skill("sample", homePath)).status).toBe("loaded");
  });

  it("counts nested status ok with read arguments, even if parent failed or record incomplete", () => {
    const row = item([message(assistant("parent", {}, "codemode")), message(result("parent", true, "codemode", [nested()]))]);
    expect(row.status).toBe("loaded");
    expect(row.detail).toContain("successful nested read");
    expect(item([message(result("parent", false, "codemode", [nested("parent/1", { path: file, limit: 2 })]))]).status).toBe("loaded · partial");
  });

  it("ignores nested failures, unfinished, omitted args, non-read and unknown paths", () => {
    const records: NestedToolCallRecord[] = [
      nested("p/1", { path: file }, "error"), nested("p/2", { path: file }, "unfinished"),
      { id: "p/3", name: "read", status: "ok", argumentsBytes: 9000 },
      { ...nested("p/4"), name: "bash" }, nested("p/5", { path: "/unknown.md" }),
    ];
    expect(item([message(result("p", false, "codemode", records))]).status).toBe("not observed");
  });

  it("restores custom markers; validates data and custom entry type", () => {
    expect(item([marker("skills/sample/SKILL.md", true)]).status).toBe("loaded · partial");
    for (const data of [null, {}, { path: file }, { path: 1, partial: false }, { path: "", partial: false }, { path: "/unknown.md", partial: false }]) {
      expect(item([{ ...base(), type: "custom", customType: SKILL_READ_ENTRY, data }]).status).toBe("not observed");
    }
    expect(item([{ ...base(), type: "custom", customType: "another-extension", data: { path: file, partial: false } }]).status).toBe("not observed");
  });

  it("uses only current branch, never abandoned loads or branch summary file lists", () => {
    const manager = SessionManager.inMemory(cwd);
    const root = manager.appendMessage(user("Root"));
    manager.appendMessage(assistant());
    manager.appendMessage(result());
    expect(item(manager.getBranch()).status).toBe("loaded");
    manager.branchWithSummary(root, `Read ${file}`, { readFiles: [file] });
    expect(item(manager.getBranch()).status).toBe("not observed");
    manager.appendCustomEntry(SKILL_READ_ENTRY, { path: file, partial: false });
    expect(item(manager.getBranch()).status).toBe("loaded");
    manager.branch(root);
    expect(item(manager.getBranch()).status).toBe("not observed");
  });
});

describe("compaction and ordering", () => {
  const loaded = () => [message(assistant()), message(result())];
  it("marks any later compaction dirty, even if evidence may be retained", () => {
    const row = item([...loaded(), compaction()]);
    expect(row.status).toBe("loaded · dirty");
    expect(row.detail).toContain("Pre-compaction evidence; instructions may no longer remain in context");
    expect(item([compaction(), ...loaded()]).status).toBe("loaded");
    expect(item([compaction()]).status).toBe("not observed");
  });

  it("dirties nested, expanded, partial and live-marker observations", () => {
    const block = `<skill name="sample" location="${file}">\nInstructions\n</skill>`;
    for (const evidence of [
      [message(result("parent", false, "codemode", [nested()]))],
      [message(user(block))], [marker()],
    ]) expect(item([...evidence, compaction()]).status).toBe("loaded · dirty");
    expect(item([marker(file, true), compaction()]).status).toBe("loaded · dirty · partial");
  });

  it("fresh successful read or expanded block after compaction cleans; failed or pending reload does not", () => {
    const dirty = [...loaded(), compaction()];
    expect(item([...dirty, message(assistant("reload")), message(result("reload"))]).status).toBe("loaded");
    expect(item([...dirty, message(assistant("reload"))]).status).toBe("loaded · dirty");
    expect(item([...dirty, message(assistant("reload")), message(result("reload", true))]).status).toBe("loaded · dirty");
    expect(item([...dirty, message(user(`<skill name="sample" location="${file}">\nInstructions\n</skill>`))]).status).toBe("loaded");
  });

  it("marks branch summaries dirty conservatively but never treats summary text as fresh evidence", () => {
    const summary: SessionEntry = { ...base(), type: "branch_summary", summary: `Read ${file}`, fromId: "abandoned" };
    expect(item([...loaded(), summary]).status).toBe("loaded · dirty");
    expect(item([...loaded(), summary]).detail).toContain("Pre-branch summary evidence");
    expect(item([summary]).status).toBe("not observed");
  });

  it.each([false, true])("deduplicates live marker before compaction and delayed direct/nested result (nested=%s)", (isNested) => {
    const call = isNested ? assistant("parent", {}, "codemode") : assistant();
    const delayed = isNested ? result("parent", false, "codemode", [nested()]) : result();
    expect(item([message(call), marker(), compaction(), message(delayed)]).status).toBe("loaded · dirty");
    expect(item([message(call), marker(), message(delayed), compaction()]).status).toBe("loaded · dirty");
    expect(item([message(call), marker(), message(delayed)]).status).toBe("loaded");
  });

  it("old marker does not swallow genuine reload from new assistant call after compaction", () => {
    const row = item([message(assistant()), marker(), compaction(), message(result()), message(assistant("reload")), message(result("reload"))]);
    expect(row.status).toBe("loaded");
    expect(item([marker(), compaction(), message(assistant("reload")), message(result("reload"))]).status).toBe("loaded");
  });

  it("new nested call and live marker after compaction clean earlier nested evidence", () => {
    const entries = [
      message(assistant("parent", {}, "codemode")), marker(),
      message(result("parent", false, "codemode", [nested()])), compaction(),
      message(assistant("reload-parent", {}, "codemode")), marker(file, true),
      message(result("reload-parent", false, "codemode", [nested("reload-parent/1", { path: file, offset: 2 })])),
    ];
    expect(item(entries).status).toBe("loaded · partial");
    expect(item([...entries, compaction()]).status).toBe("loaded · dirty · partial");
  });

  it("tracks last evidence independently for each discovered skill", () => {
    const another = "/project/skills/another/SKILL.md";
    const entries = [
      marker(), marker(another), compaction(),
      message(assistant("reload", { path: another })), message(result("reload")),
    ];
    const view = buildSkillsView([skill("sample"), skill("another", another)], entries, cwd);
    expect(view.items?.map((row) => [row.label, row.status])).toEqual([
      ["another", "loaded"], ["sample", "loaded · dirty"],
    ]);
  });

  it("repeated recorded result cannot clean stale evidence", () => {
    expect(item([...loaded(), compaction(), message(result())]).status).toBe("loaded · dirty");
    const parent = message(result("parent", false, "codemode", [nested()]));
    expect(item([parent, compaction(), parent]).status).toBe("loaded · dirty");
  });
});
