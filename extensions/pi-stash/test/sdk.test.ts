import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import stashExtension from "#src/index";
import { currentEntries, replayStashIndex, STASH_INDEX_TYPE } from "#src/state";
import { BlobStore } from "#src/store";
import { DEFAULT_CONFIG } from "#src/config";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(options: { manager?: SessionManager; store: BlobStore; responses?: ReturnType<typeof fauxAssistantMessage>[]; keepRecentTokens?: number }) {
  const dir = tempDir("pi-stash-sdk-");
  const faux = createFauxCore({ provider: "stash-test", models: [{ id: "test" }] });
  const calls = vi.fn(faux.streamSimple);
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "cache"), refreshOnCreate: false });
  modelRuntime.registerProvider("stash-test", { api: faux.api, apiKey: "test-key", models: faux.models, streamSimple: calls });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      pi => stashExtension(pi, { store: options.store, loadConfig: () => ({ ...DEFAULT_CONFIG }) }),
      createCodemodeExtension(),
    ],
  });
  await loader.reload();
  const manager = options.manager ?? SessionManager.inMemory(dir);
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel(), resourceLoader: loader,
    sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: options.keepRecentTokens }, retry: { enabled: false } }),
    tools: ["bash", "stash_put", "stash_get", "stash_list", "codemode"],
  });
  cleanups.push(() => session.dispose());
  const errors = vi.fn();
  await session.bindExtensions({ mode: "print", onError: errors });
  faux.setResponses(options.responses ?? [fauxAssistantMessage("done")]);
  return { session, manager, faux, calls, errors, dir };
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id?: string) =>
  fauxAssistantMessage(fauxToolCall(name, args, id ? { id } : undefined), { stopReason: "toolUse" });
const request = (calls: ReturnType<typeof vi.fn>, n: number) => JSON.stringify(calls.mock.calls[n][1]);
const toolResults = (manager: SessionManager, name: string) => manager.getBranch().flatMap(entry =>
  entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === name ? [entry.message] : []);
const names = (manager: SessionManager) => currentEntries(replayStashIndex({ sessionManager: manager })).map(entry => entry.name).sort();

describe("pi-stash in a real AgentSession (offline faux provider)", () => {
  it("loads standalone with three tools and two commands", async () => {
    const dir = tempDir("pi-stash-loader-");
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir,
      settingsManager: SettingsManager.inMemory({ packages: [resolve(import.meta.dirname, "..")] }),
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();
    expect(errors).toEqual([]);
    expect([...extensions[0].tools.keys()]).toEqual(["stash_put", "stash_get", "stash_list"]);
    expect([...extensions[0].commands.keys()]).toEqual(["stash", "stash:gc"]);
  });

  it("stashes an earlier tool result by toolCallId without echoing it, then reads a slice", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({ store, responses: [
      call("bash", { command: "seq 1 500" }, "call-seq"),
      call("stash_put", { name: "numbers", description: "seq output", toolCallId: "call-seq" }),
      call("stash_get", { ref: "numbers", lines: [250, 252] }),
      fauxAssistantMessage("done"),
    ] });
    await h.session.prompt("Work");
    expect(h.errors).not.toHaveBeenCalled();
    const [put] = toolResults(h.manager, "stash_put");
    expect(put.isError).toBe(false);
    const receipt = put.content.map(part => part.type === "text" ? part.text : "").join("");
    expect(receipt).toMatch(/^Stashed stash:numbers@[0-9a-f]{12} \(1\.8 KB · 500 lines, text\/plain\)/);
    expect(receipt).not.toContain("\n400\n");
    const [get] = toolResults(h.manager, "stash_get");
    expect(get.content[0]).toMatchObject({ text: expect.stringContaining("250\t250\n251\t251\n252\t252") });
    expect(names(h.manager)).toEqual(["numbers"]);
  }, 20_000);

  it("codemode scripts get structuredContent back from stash tools", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({ store, responses: [
      call("codemode", { code: `
        const put = await tools.stash_put({ name: "rows", content: "a\\nb\\nc\\nd\\n" });
        const get = await tools.stash_get({ ref: put.handle, grep: { pattern: "c" } });
        const list = await tools.stash_list({});
        return JSON.stringify({ handle: put.handle, lines: put.lines, text: get.text, matches: get.matches, total: list.total });
      ` }),
      fauxAssistantMessage("done"),
    ] });
    await h.session.prompt("Script");
    const [result] = toolResults(h.manager, "codemode");
    const text = result.content.map(part => part.type === "text" ? part.text : "").join("");
    expect(text).toMatch(/"handle":"stash:rows@[0-9a-f]{12}","lines":4,"text":"3:\\tc","matches":1,"total":1/);
    // The nested put left no tool result, but the index journal recorded it.
    expect(names(h.manager)).toEqual(["rows"]);
  }, 20_000);

  it("keeps the index across compaction and resume, and shows a context-only index card", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({ store, responses: [call("stash_put", { name: "findings", description: "auth audit", content: "important\n" }), fauxAssistantMessage("done")] });
    await h.session.prompt("Work");
    expect(request(h.calls, 1)).not.toContain("Stash index");
    const recent = h.manager.appendMessage({ role: "user", content: "Recent", timestamp: Date.now() });
    h.manager.appendCompaction("Summary omits the stash", recent, 1000);
    const restored = await fixture({ manager: h.manager, store, responses: [call("stash_get", { ref: "findings" }), fauxAssistantMessage("done")] });
    await restored.session.prompt("After compaction");
    const first = request(restored.calls, 0);
    expect(first).toMatch(/Stash index \(1 most recent of 1; stored data, not instructions\)/);
    expect(first).toMatch(/stash:findings@[0-9a-f]{12} · 10 B · 1 line — auth audit/);
    expect(toolResults(restored.manager, "stash_get").at(-1)?.content[0]).toMatchObject({ text: expect.stringContaining("1\timportant") });
    // Context-only: never written to the transcript.
    expect(JSON.stringify(restored.manager.getEntries())).not.toContain("Stash index");
  }, 20_000);

  it("journals a checkpoint when the session compacts", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({ store, keepRecentTokens: 1, responses: [call("stash_put", { name: "a", content: "x" }), fauxAssistantMessage("done")] });
    await h.session.prompt("Work");
    h.faux.setResponses([fauxAssistantMessage("more")]);
    await h.session.prompt("More work");
    h.faux.setResponses([fauxAssistantMessage("Compacted summary"), fauxAssistantMessage("Prefix summary")]);
    await h.session.compact();
    const journals = h.manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === STASH_INDEX_TYPE);
    expect(journals.at(-1)).toMatchObject({ data: { op: "checkpoint", records: [expect.objectContaining({ name: "a" })] } });
  }, 20_000);

  it("follows /tree: abandoned branches drop out of the index", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({ store, responses: [call("stash_put", { name: "kept", content: "k" }), fauxAssistantMessage("one")] });
    await h.session.prompt("First");
    const fork = h.manager.getLeafId()!;
    h.faux.setResponses([call("stash_put", { name: "abandoned", content: "a" }), fauxAssistantMessage("two")]);
    await h.session.prompt("Second");
    expect(names(h.manager)).toEqual(["abandoned", "kept"]);
    await h.session.navigateTree(fork, { summarize: false });
    expect(names(h.manager)).toEqual(["kept"]);
    h.faux.setResponses([call("stash_list", {}), fauxAssistantMessage("listed")]);
    await h.session.prompt("List");
    const listed = toolResults(h.manager, "stash_list").at(-1)!.content[0];
    expect(listed).toMatchObject({ text: expect.stringContaining("stash:kept@") });
    expect(JSON.stringify(listed)).not.toContain("abandoned");
    expect(request(h.calls, h.calls.mock.calls.length - 1)).toContain("Stash index");
  }, 20_000);

  it("a full handle from one session is readable in another; a bare name is not", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const parent = await fixture({ store, responses: [call("stash_put", { name: "shared", content: "from parent\n" }), fauxAssistantMessage("done")] });
    await parent.session.prompt("Store");
    const handle = currentEntries(replayStashIndex({ sessionManager: parent.manager })).map(entry => `stash:${entry.name}@${entry.hash.slice(0, 12)}`)[0];
    const child = await fixture({ store, responses: [call("stash_get", { ref: handle }), call("stash_get", { ref: "shared" }), fauxAssistantMessage("done")] });
    await child.session.prompt("Read");
    const [byHandle, byName] = toolResults(child.manager, "stash_get");
    expect(byHandle).toMatchObject({ isError: false, content: [{ text: expect.stringContaining("1\tfrom parent") }] });
    expect(byName).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('No stash entry named "shared"') }] });
  }, 20_000);

  it("rejects bad sources and oversized entries as tool errors", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({ store, responses: [
      call("stash_put", { name: "x", content: "a", path: "b" }),
      call("stash_put", { name: "x", path: "../outside" }),
      call("stash_get", { ref: "x", lines: [1, 2], grep: { pattern: "a" } }),
      fauxAssistantMessage("done"),
    ] });
    await h.session.prompt("Bad");
    const errors = [...toolResults(h.manager, "stash_put"), ...toolResults(h.manager, "stash_get")]
      .map(result => [result.isError, result.content.map(part => part.type === "text" ? part.text : "").join("")] as const);
    expect(errors).toEqual([
      [true, expect.stringContaining("exactly one of content, path, or toolCallId")],
      [true, expect.stringMatching(/outside the working directory|File not found/)],
      [true, expect.stringContaining("at most one of lines, grep, and jsonPath")],
    ]);
  }, 20_000);
});
