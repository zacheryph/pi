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
import { STASH_PREVIEW_REQUEST, STASH_SNAPSHOT_EVENT, type StashPreviewResult, type StashSnapshotEvent } from "#src/events";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { provide, SESSION_TREE_KEY, service } from "../../../packages/pi-session-tree/src/index.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global in tests
  delete (globalThis as Record<symbol, unknown>)[SESSION_TREE_KEY];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(options: { manager?: SessionManager; store: BlobStore; responses?: ReturnType<typeof fauxAssistantMessage>[]; keepRecentTokens?: number }) {
  const snapshots: StashSnapshotEvent[] = [];
  let bus: EventBus | undefined;
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
      // Another extension on the same session bus, as pi-dashboard listens.
      pi => { bus = pi.events; pi.events.on(STASH_SNAPSHOT_EVENT, data => snapshots.push(data as StashSnapshotEvent)); },
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
  /** Asks pi-stash for a preview the way pi-dashboard does. */
  const preview = (request: Record<string, unknown>) => {
    let result: StashPreviewResult | undefined;
    bus!.emit(STASH_PREVIEW_REQUEST, { ...request, respond: (value: StashPreviewResult) => { result = value; } });
    return result;
  };
  return { session, manager, faux, calls, errors, dir, snapshots, preview, bus: bus! };
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

  it("publishes the branch index to other extensions on start, on each put (codemode included), and on /tree", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({ store, responses: [
      call("stash_put", { name: "notes", description: "first", content: "one\n" }),
      call("codemode", { code: `await tools.stash_put({ name: "notes", content: "two\\nlines\\n" }); return "ok";` }),
      fauxAssistantMessage("done"),
    ] });
    const size = { bytes: expect.any(Number), maxBytes: DEFAULT_CONFIG.maxStoreBytes };
    expect(h.snapshots).toEqual([{ version: 1, entries: [], store: size }]);
    await h.session.prompt("Work");
    expect(h.snapshots).toHaveLength(3);
    expect(h.snapshots.at(-1)).toEqual({ version: 1, entries: [{
      handle: expect.stringMatching(/^stash:notes@[0-9a-f]{12}$/), name: "notes", hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      bytes: 10, lines: 2, mime: "text/plain", createdAt: expect.any(Number), createdBy: h.manager.getSessionId(),
      source: "content", versions: 2,
    }], store: { bytes: 14, maxBytes: DEFAULT_CONFIG.maxStoreBytes } });
    expect(JSON.stringify(h.snapshots)).not.toContain("lines\\n");

    const first = h.manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user")!;
    await h.session.navigateTree(first.id, { summarize: false });
    expect(h.snapshots.at(-1)).toEqual({ version: 1, entries: [], store: size });
  }, 20_000);

  it("answers preview requests for this branch's entries only, bounded", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const content = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const h = await fixture({ store, responses: [call("stash_put", { name: "log", content }), fauxAssistantMessage("done")] });
    await h.session.prompt("Work");
    const head = h.preview({ name: "log", maxLines: 3 });
    expect(head).toEqual({ ok: true, handle: expect.stringMatching(/^stash:log@[0-9a-f]{12}$/), lines: ["line 1", "line 2", "line 3"], total: 300, complete: false });
    const capped = h.preview({ name: "log", maxLines: 10_000 });
    expect(capped?.ok && capped.lines).toHaveLength(200);
    expect(h.preview({ name: "missing" })).toEqual({ ok: false, error: 'No stash entry named "missing" on this branch.' });
    const handle = head?.ok ? head.handle : "";
    expect(h.preview({ name: handle })).toEqual({ ok: false, error: "Invalid stash entry name." });
    expect(h.preview({ name: "../../etc/passwd" })).toEqual({ ok: false, error: "Invalid stash entry name." });
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
      [true, expect.stringContaining("exactly one of content, path, toolCallId, or handle")],
      [true, expect.stringMatching(/outside the working directory|File not found/)],
      [true, expect.stringContaining("at most one of lines, grep, and jsonPath")],
    ]);
  }, 20_000);
});

describe("subagent entries reach ancestors (pi-session-tree)", () => {
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  /** What pi-subagents emits on the parent's bus before the child binds. */
  const spawn = (parent: Fixture, child: Fixture, agentId: string) => parent.bus.emit("subagents:child:session-created", {
    sessionId: child.manager.getSessionId(), parentSessionId: parent.manager.getSessionId(), agentId,
  });
  const records = (manager: SessionManager) => replayStashIndex({ sessionManager: manager }).records;

  it("journals a grandchild's entry on its parent's and grandparent's branches, with its origin", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const root = await fixture({ store });
    const child = await fixture({ store });
    const grandchild = await fixture({ store, responses: [
      call("stash_put", { name: "findings", description: "auth audit", content: "important\n" }), fauxAssistantMessage("done"),
    ] });
    spawn(root, child, "a3f2b1c4-9d8e-4f6a");
    spawn(child, grandchild, "c07e0000-1111-2222");

    await grandchild.session.prompt("Work");

    const [own] = records(grandchild.manager);
    expect(own).toMatchObject({ name: "findings", agent: "c07e0000-1111-2222", id: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(own.via).toBeUndefined();
    for (const holder of [child, root]) {
      expect(records(holder.manager)).toEqual([{ ...own, via: "adopt" }]);
      expect(holder.snapshots.at(-1)?.entries).toEqual([expect.objectContaining({
        name: "findings", createdBy: grandchild.manager.getSessionId(), agent: "c07e0000-1111-2222", via: "adopt",
      })]);
    }

    // The root's model never saw a receipt, so it gets the card, origin included.
    root.faux.setResponses([call("stash_list", {}), fauxAssistantMessage("listed")]);
    await root.session.prompt("What did the subagents find?");
    expect(request(root.calls, 0)).toMatch(/stash:findings@[0-9a-f]{12} · 10 B · 1 line · from agent c07e0000 — auth audit/);
    expect(toolResults(root.manager, "stash_list")[0].content[0]).toMatchObject({ text: expect.stringContaining("by agent c07e0000") });
  }, 30_000);

  it("hands an entry only to its parent, which passes it on; a gap ends the chain", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const root = await fixture({ store });
    const child = await fixture({ store });
    const grandchild = await fixture({ store, responses: [call("stash_put", { name: "found", content: "f" }), fauxAssistantMessage("done")] });
    spawn(root, child, "a3f2b1c4-9d8e-4f6a");
    spawn(child, grandchild, "c07e0000-1111-2222");
    // The child's pi-stash is replaced by one that records calls and passes nothing on.
    const adopted: unknown[] = [];
    provide(child.manager.getSessionId(), "pi-stash", { version: 1, adopt: (record: unknown) => { adopted.push(record); return true; } });

    await grandchild.session.prompt("Work");

    expect(adopted).toEqual([expect.objectContaining({ name: "found", createdBy: grandchild.manager.getSessionId() })]);
    expect(names(root.manager)).toEqual([]);
    expect(names(grandchild.manager)).toEqual(["found"]);
  }, 30_000);

  it("leaves a root session's entries and unlinked sessions alone", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const root = await fixture({ store, responses: [call("stash_put", { name: "plan", content: "p" }), fauxAssistantMessage("done")] });
    const stranger = await fixture({ store });
    await root.session.prompt("Work");
    expect(names(root.manager)).toEqual(["plan"]);
    expect(names(stranger.manager)).toEqual([]);
    expect(records(root.manager)[0].agent).toBeUndefined();
  }, 20_000);

  it("drops an adopted entry when the parent's /tree goes back before it", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const parent = await fixture({ store, responses: [fauxAssistantMessage("before")] });
    await parent.session.prompt("Before the spawn");
    const beforeSpawn = parent.manager.getLeafId()!;
    const child = await fixture({ store, responses: [call("stash_put", { name: "found", content: "f" }), fauxAssistantMessage("done")] });
    spawn(parent, child, "a3f2b1c4-9d8e-4f6a");
    await child.session.prompt("Work");
    expect(names(parent.manager)).toEqual(["found"]);

    await parent.session.navigateTree(beforeSpawn, { summarize: false });

    expect(names(parent.manager)).toEqual([]);
    expect(parent.snapshots.at(-1)?.entries).toEqual([]);
    expect(names(child.manager)).toEqual(["found"]);
  }, 20_000);

  it("keeps the child's put when the parent has shut down or its runtime is stale", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const parent = await fixture({ store });
    const child = await fixture({ store, responses: [
      call("stash_put", { name: "one", content: "1" }), call("stash_put", { name: "two", content: "2" }), fauxAssistantMessage("done"),
    ] });
    spawn(parent, child, "a3f2b1c4-9d8e-4f6a");
    parent.session.dispose(); // session_shutdown withdraws the parent's service
    // A stale instance still registered for the parent throws, as Pi does after a reload.
    provide(parent.manager.getSessionId(), "pi-stash", { version: 1, adopt: () => { throw new Error("This extension ctx is stale"); } });

    await child.session.prompt("Work");

    expect(toolResults(child.manager, "stash_put").map(result => result.isError)).toEqual([false, false]);
    expect(names(child.manager)).toEqual(["one", "two"]);
    expect(child.errors).not.toHaveBeenCalled();
  }, 20_000);

  it("adopts a version once and refuses malformed records", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const parent = await fixture({ store });
    const adopt = service<{ adopt(record: unknown): boolean }>(parent.manager.getSessionId(), "pi-stash")!;
    const hash = store.put("x").hash;
    const record = { name: "x", hash, bytes: 1, lines: 1, mime: "text/plain", createdAt: 1, createdBy: "child", source: "content", id: "0123456789abcdef" };

    expect(adopt.adopt(record)).toBe(true);
    expect(adopt.adopt(record)).toBe(false);
    expect(adopt.adopt({ ...record, id: "other", hash: "not-a-hash" })).toBe(false);
    expect(adopt.adopt({ ...record, id: "other", via: "sideways" })).toBe(false);
    // Without an id adoption could not be told apart from a repeat, so it is refused.
    expect(adopt.adopt({ ...record, id: undefined })).toBe(false);
    expect(records(parent.manager)).toEqual([{ ...record, via: "adopt" }]);
  }, 20_000);

  it("keeps another session's entry on this branch with stash_put {handle}", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const other = await fixture({ store, responses: [call("stash_put", { name: "report", content: "{\"ok\":true}" }), fauxAssistantMessage("done")] });
    await other.session.prompt("Store");
    const [stored] = records(other.manager);
    const handle = `stash:report@${stored.hash.slice(0, 12)}`;
    const mine = await fixture({ store, responses: [call("stash_put", { name: "kept-report", handle }), fauxAssistantMessage("done")] });

    await mine.session.prompt("Keep it");

    expect(toolResults(mine.manager, "stash_put")[0].isError).toBe(false);
    expect(records(mine.manager)).toEqual([expect.objectContaining({
      name: "kept-report", hash: stored.hash, mime: "application/json", source: `handle:${handle}`,
    })]);
  }, 20_000);
});
