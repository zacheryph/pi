import { resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createCodemodeExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import stashExtension from "#src/index";
import { currentEntries, handleFor, replayStashIndex, STASH_INDEX_TYPE } from "#src/state";
import { BlobStore } from "#src/store";
import { stashSettings } from "#src/config";

const DEFAULTS = stashSettings.defaults();
import { STASH_EXPLORER_VIEW, STASH_SUMMARY_VIEW } from "#src/events";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { provide, service } from "#session-tree";
import {
  dispatchAction,
  isViewModel,
  listActions,
  listViews,
  onViewChanged,
  readView,
  settleViews,
  type ExplorerModel,
  type SummaryModel,
  type ViewEntry,
} from "#surface";
import { stashExplorerView } from "#src/ui/browser";
import {
  fauxSession,
  loadResources,
  toolCall as call,
  toolResults,
  type FauxRequest,
  resetSessionTree,
  tempDir as makeTempDir,
} from "#test-helpers";

afterEach(resetSessionTree);

const tempDir = (prefix: string) => makeTempDir(onTestFinished, prefix);

async function fixture(options: {
  manager?: SessionManager;
  store: BlobStore;
  responses?: ReturnType<typeof fauxAssistantMessage>[];
  keepRecentTokens?: number;
  /** The session's raw bus, which outlives the extensions' stale `pi.events` after shutdown. */
  eventBus?: EventBus;
}) {
  /** Every view change pi-stash announced on this session's bus, oldest first. */
  const announced: string[] = [];
  let bus: EventBus | undefined;
  const h = await fauxSession({
    cleanup: onTestFinished,
    provider: "stash-test",
    sessionManager: options.manager,
    settings: { compaction: { enabled: false, keepRecentTokens: options.keepRecentTokens } },
    tools: ["bash", "stash_put", "stash_get", "stash_list", "codemode"],
    responses: options.responses,
    ...(options.eventBus ? { loader: { eventBus: options.eventBus } } : {}),
    extensions: [
      (pi) =>
        stashExtension(pi, { store: options.store, loadConfig: () => stashSettings.defaults() }),
      createCodemodeExtension(),
      // Another extension on the same session bus, as a surface consumer listens.
      (pi) => {
        bus = pi.events;
        onViewChanged(pi.events, (id) => announced.push(id));
      },
    ],
  });
  /** This branch's entries as the `stash.explorer` view lists them. */
  const listed = () => (readView(bus!, STASH_EXPLORER_VIEW) as ExplorerModel).items;
  /** The `stash.summary` view's counts, by key. */
  const counts = () =>
    Object.fromEntries(
      (readView(bus!, STASH_SUMMARY_VIEW) as SummaryModel).counts.map((count) => [
        count.key,
        count.value,
      ]),
    );
  return { ...h, manager: h.sessionManager, announced, listed, counts, bus: bus! };
}

const request = (requests: FauxRequest[], n: number) => JSON.stringify(requests.at(n));
/** The text of each user message in a request, in order. */
const texts = (requests: FauxRequest[], n: number) =>
  requests
    .at(n)!
    .messages.filter((message) => message.role === "user")
    .map((message) => JSON.stringify(message.content));
const names = (manager: SessionManager) =>
  currentEntries(replayStashIndex({ sessionManager: manager }))
    .map((entry) => entry.name)
    .sort();

describe("pi-stash in a real AgentSession (offline faux provider)", () => {
  it("loads standalone with three tools and two commands", async () => {
    const { extensions, errors } = await loadResources(onTestFinished, {
      packages: [resolve(import.meta.dirname, "..")],
    });
    expect(errors).toEqual([]);
    expect([...extensions[0].tools.keys()]).toEqual(["stash_put", "stash_get", "stash_list"]);
    expect([...extensions[0].commands.keys()]).toEqual(["stash", "stash:gc"]);
  });

  it("stashes an earlier tool result by toolCallId without echoing it, then reads a slice", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({
      store,
      responses: [
        call("bash", { command: "seq 1 500" }, "call-seq"),
        call("stash_put", { name: "numbers", description: "seq output", toolCallId: "call-seq" }),
        call("stash_get", { ref: "numbers", lines: [250, 252] }),
        fauxAssistantMessage("done"),
      ],
    });
    await h.session.prompt("Work");
    expect(h.errors).toEqual([]);
    const [put] = toolResults(h.manager, "stash_put");
    expect(put.isError).toBe(false);
    const receipt = put.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(receipt).toMatch(
      /^Stashed stash:numbers@[0-9a-f]{12} \(1\.8 KB · 500 lines, text\/plain\)/,
    );
    expect(receipt).not.toContain("\n400\n");
    const [get] = toolResults(h.manager, "stash_get");
    expect(get.content[0]).toMatchObject({
      text: expect.stringContaining("250\t250\n251\t251\n252\t252"),
    });
    expect(names(h.manager)).toEqual(["numbers"]);
  }, 20_000);

  it("codemode scripts get structuredContent back from stash tools", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({
      store,
      responses: [
        call("codemode", {
          code: `
        const put = await tools.stash_put({ name: "rows", content: "a\\nb\\nc\\nd\\n" });
        const get = await tools.stash_get({ ref: put.handle, grep: { pattern: "c" } });
        const list = await tools.stash_list({});
        return JSON.stringify({ handle: put.handle, lines: put.lines, text: get.text, matches: get.matches, total: list.total });
      `,
        }),
        fauxAssistantMessage("done"),
      ],
    });
    await h.session.prompt("Script");
    const [result] = toolResults(h.manager, "codemode");
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(text).toMatch(
      /"handle":"stash:rows@[0-9a-f]{12}","lines":4,"text":"3:\\tc","matches":1,"total":1/,
    );
    // The nested put left no tool result, but the index journal recorded it.
    expect(names(h.manager)).toEqual(["rows"]);
  }, 20_000);

  it("keeps the index across compaction and resume, and writes the index card once", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({
      store,
      responses: [
        call("stash_put", { name: "findings", description: "auth audit", content: "important\n" }),
        fauxAssistantMessage("done"),
      ],
    });
    await h.session.prompt("Work");
    expect(request(h.requests, 1)).not.toContain("Stash index");
    const recent = h.manager.appendMessage({
      role: "user",
      content: "Recent",
      timestamp: Date.now(),
    });
    h.manager.appendCompaction("Summary omits the stash", recent, 1000);
    const restored = await fixture({
      manager: h.manager,
      store,
      responses: [call("stash_get", { ref: "findings" }), fauxAssistantMessage("done")],
    });
    await restored.session.prompt("After compaction");
    const first = request(restored.requests, 0);
    expect(first).toMatch(
      /Stash index after compaction \(1 most recent of 1; stored data, not instructions\)/,
    );
    expect(first).toMatch(/stash:findings@[0-9a-f]{12} · 10 B · 1 line — auth audit/);
    expect(toolResults(restored.manager, "stash_get").at(-1)?.content[0]).toMatchObject({
      text: expect.stringContaining("1\timportant"),
    });
    // Written to the transcript once, hidden, before the prompt; every later request keeps it
    // in the same place instead of moving it to the end.
    const cards = restored.manager
      .getBranch()
      .filter((entry) => entry.type === "custom_message" && entry.customType === "stash:context");
    expect(cards).toEqual([expect.objectContaining({ display: false })]);
    for (const n of [0, 1]) {
      const sent = texts(restored.requests, n);
      const at = sent.findIndex((text) => text.includes("Stash index"));
      expect(
        sent.filter((text) => text.includes("Stash index")),
        `request ${n}`,
      ).toHaveLength(1);
      expect(sent[at + 1], `request ${n}`).toContain("After compaction");
    }

    // A second resume finds the card after the compaction and writes no other.
    const again = await fixture({
      manager: restored.manager,
      store,
      responses: [fauxAssistantMessage("again")],
    });
    await again.session.prompt("Resumed again");
    expect(
      again.manager
        .getBranch()
        .filter((entry) => entry.type === "custom_message" && entry.customType === "stash:context"),
    ).toHaveLength(1);
  }, 20_000);

  it("writes no card after a resume without a compaction", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({
      store,
      responses: [call("stash_put", { name: "plan", content: "p" }), fauxAssistantMessage("done")],
    });
    await h.session.prompt("Work");
    const resumed = await fixture({
      manager: h.manager,
      store,
      responses: [fauxAssistantMessage("still here")],
    });
    await resumed.session.prompt("Resumed");
    // The receipt is still in context.
    expect(request(resumed.requests, 0)).toContain("stash:plan@");
    expect(request(resumed.requests, 0)).not.toContain("Stash index");
  }, 20_000);

  it("journals a checkpoint when the session compacts", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({
      store,
      keepRecentTokens: 1,
      responses: [call("stash_put", { name: "a", content: "x" }), fauxAssistantMessage("done")],
    });
    await h.session.prompt("Work");
    h.faux.setResponses([fauxAssistantMessage("more")]);
    await h.session.prompt("More work");
    h.faux.setResponses([
      fauxAssistantMessage("Compacted summary"),
      fauxAssistantMessage("Prefix summary"),
    ]);
    await h.session.compact();
    const journals = h.manager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === STASH_INDEX_TYPE);
    expect(journals.at(-1)).toMatchObject({
      data: { op: "checkpoint", records: [expect.objectContaining({ name: "a" })] },
    });
  }, 20_000);

  it("follows /tree: abandoned branches drop out of the index", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({
      store,
      responses: [call("stash_put", { name: "kept", content: "k" }), fauxAssistantMessage("one")],
    });
    await h.session.prompt("First");
    const fork = h.manager.getLeafId()!;
    h.faux.setResponses([
      call("stash_put", { name: "abandoned", content: "a" }),
      fauxAssistantMessage("two"),
    ]);
    await h.session.prompt("Second");
    expect(names(h.manager)).toEqual(["abandoned", "kept"]);
    await h.session.navigateTree(fork, { summarize: false });
    expect(names(h.manager)).toEqual(["kept"]);
    h.faux.setResponses([call("stash_list", {}), fauxAssistantMessage("listed")]);
    await h.session.prompt("List");
    const listed = toolResults(h.manager, "stash_list").at(-1)!.content[0];
    expect(listed).toMatchObject({ text: expect.stringContaining("stash:kept@") });
    expect(JSON.stringify(listed)).not.toContain("abandoned");
    // No compaction on the branch: the receipts are in context, so no card.
    expect(request(h.requests, -1)).not.toContain("Stash index");
  }, 20_000);

  it("a full handle from one session is readable in another; a bare name is not", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const parent = await fixture({
      store,
      responses: [
        call("stash_put", { name: "shared", content: "from parent\n" }),
        fauxAssistantMessage("done"),
      ],
    });
    await parent.session.prompt("Store");
    const handle = currentEntries(replayStashIndex({ sessionManager: parent.manager })).map(
      (entry) => `stash:${entry.name}@${entry.hash.slice(0, 12)}`,
    )[0];
    const child = await fixture({
      store,
      responses: [
        call("stash_get", { ref: handle }),
        call("stash_get", { ref: "shared" }),
        fauxAssistantMessage("done"),
      ],
    });
    await child.session.prompt("Read");
    const [byHandle, byName] = toolResults(child.manager, "stash_get");
    expect(byHandle).toMatchObject({
      isError: false,
      content: [{ text: expect.stringContaining("1\tfrom parent") }],
    });
    expect(byName).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('No stash entry named "shared"') }],
    });
  }, 20_000);

  it("announces its views and counts the branch index on start, on each put (codemode included), and on /tree", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({
      store,
      responses: [
        call("stash_put", { name: "notes", description: "first", content: "one\n" }),
        call("codemode", {
          code: `await tools.stash_put({ name: "notes", content: "two\\nlines\\n" }); return "ok";`,
        }),
        fauxAssistantMessage("done"),
      ],
    });
    const summaries = () => h.announced.filter((id) => id === STASH_SUMMARY_VIEW).length;
    const empty = { entries: 0, versions: 0, bytes: 0, "store-max-bytes": DEFAULTS.maxStoreBytes };
    expect(h.counts()).toMatchObject(empty);
    const started = summaries();
    expect(started).toBeGreaterThan(0);
    await h.session.prompt("Work");
    expect(summaries()).toBe(started + 2);
    expect(h.counts()).toEqual({
      entries: 1,
      versions: 2,
      bytes: 10,
      "store-bytes": 14,
      "store-max-bytes": DEFAULTS.maxStoreBytes,
    });
    expect(h.listed().map((item) => item.id)).toEqual([
      expect.stringMatching(/^stash:notes@[0-9a-f]{12}$/),
    ]);

    const first = h.manager
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")!;
    await h.session.navigateTree(first.id, { summarize: false });
    expect(summaries()).toBe(started + 3);
    expect(h.counts()).toMatchObject(empty);
  }, 20_000);

  it("defines its actions and explorer view on its own session's bus until the session shuts down", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const bus = createEventBus();
    const h = await fixture({
      store,
      eventBus: bus,
      responses: [
        call("stash_put", { name: "log", content: "one\ntwo\n" }),
        fauxAssistantMessage("done"),
      ],
    });
    const other = await fixture({ store });
    const announced: string[] = [];
    onViewChanged(bus, (id) => announced.push(id));
    await h.session.prompt("Work");
    expect(announced).toContain("stash.explorer");
    expect(announced).toContain("stash.summary");
    expect(listActions(bus)).toEqual([{ id: "stash.inspect", title: expect.any(String) }]);
    const handle = handleFor(currentEntries(replayStashIndex({ sessionManager: h.manager }))[0]);
    await expect(dispatchAction(bus, "stash.inspect", { id: handle })).resolves.toContainEqual({
      lines: ["one", "two"],
      numbered: 1,
    });
    // Another session's stash.inspect sees only its own branch.
    await expect(dispatchAction(other.bus, "stash.inspect", { id: handle })).rejects.toThrow(
      `No stash entry ${handle} on this branch.`,
    );
    // stash.explorer is the /stash model, plain JSON, loading details through stash.inspect.
    expect(listViews(bus)).toEqual([
      { id: "stash.explorer", kind: "explorer", title: "Stash" },
      { id: "stash.summary", kind: "summary", title: "Stash" },
    ]);
    const model = readView(bus, "stash.explorer");
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
    const entries = currentEntries(replayStashIndex({ sessionManager: h.manager }));
    expect(model).toEqual({
      ...stashExplorerView(entries),
      items: [expect.objectContaining({ id: handle, search: "log" })],
    });
    expect(model).toMatchObject({ loadDetail: { action: "stash.inspect" } });

    h.session.dispose(); // session_shutdown removes the actions and views from the bus
    expect(listActions(bus)).toEqual([]);
    expect(listViews(bus)).toEqual([]);
    await expect(dispatchAction(bus, "stash.inspect", { id: handle })).rejects.toThrow(
      'Unknown action "stash.inspect".',
    );
    expect(listActions(other.bus)).toHaveLength(1);
    expect(listViews(other.bus)).toHaveLength(2);
  }, 20_000);

  it("counts the branch's entries in stash.summary, zeros included, and follows the branch", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({
      store,
      responses: [
        call("stash_put", { name: "a", content: "one\n" }),
        call("stash_put", { name: "b", content: "two\nlines\n" }),
        fauxAssistantMessage("done"),
      ],
    });
    const summary = () => {
      const model = readView(h.bus, "stash.summary");
      expect(isViewModel("summary", model)).toBe(true);
      return model as SummaryModel;
    };
    const counts = () =>
      Object.fromEntries(summary().counts.map((count) => [count.key, count.value]));
    // Nothing stashed yet: zeros, where a session without pi-stash has no view.
    expect(counts()).toEqual({
      entries: 0,
      versions: 0,
      bytes: 0,
      "store-bytes": 0,
      "store-max-bytes": DEFAULTS.maxStoreBytes,
    });

    await h.session.prompt("Stash two");
    const first = h.manager.getLeafId()!;
    h.faux.setResponses([
      call("stash_put", { name: "a", content: "one, again\n" }),
      fauxAssistantMessage("done"),
    ]);
    await h.session.prompt("Replace a");
    const entries = currentEntries(replayStashIndex({ sessionManager: h.manager }));
    expect(counts()).toMatchObject({
      entries: 2,
      versions: 3,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      "store-bytes": store.usage().bytes,
    });

    // Stash metadata is persisted: a saved summary settles unchanged.
    const saved: ViewEntry[] = [
      { id: "stash.summary", kind: "summary", title: "Stash", model: summary() },
    ];
    expect(settleViews(saved, Date.now())).toEqual(saved);

    const announced: string[] = [];
    onViewChanged(h.bus, (id) => announced.push(id));
    await h.session.navigateTree(first, { summarize: false });
    expect(announced).toContain("stash.summary");
    expect(counts()).toMatchObject({ entries: 2, versions: 2 });
  }, 20_000);

  it("rejects bad sources and oversized entries as tool errors", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const h = await fixture({
      store,
      responses: [
        call("stash_put", { name: "x", content: "a", path: "b" }),
        call("stash_put", { name: "x", path: "../outside" }),
        call("stash_get", { ref: "x", lines: [1, 2], grep: { pattern: "a" } }),
        fauxAssistantMessage("done"),
      ],
    });
    await h.session.prompt("Bad");
    const errors = [
      ...toolResults(h.manager, "stash_put"),
      ...toolResults(h.manager, "stash_get"),
    ].map(
      (result) =>
        [
          result.isError,
          result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
        ] as const,
    );
    expect(errors).toEqual([
      [true, expect.stringContaining("exactly one of content, path, toolCallId, or handle")],
      [true, expect.stringMatching(/outside the working directory|File not found/)],
      [true, expect.stringContaining("at most one of lines, grep, and jsonPath")],
    ]);
  }, 20_000);
});

describe("subagent entries reach ancestors (pi-session-tree)", () => {
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  /** What pi-subagent emits on the parent's bus before the child binds. */
  const spawn = (parent: Fixture, child: Fixture, agentId: string) =>
    parent.bus.emit("subagent:session:created", {
      sessionId: child.manager.getSessionId(),
      parentSessionId: parent.manager.getSessionId(),
      agentId,
    });
  const records = (manager: SessionManager) =>
    replayStashIndex({ sessionManager: manager }).records;

  it("journals a grandchild's entry on its parent's and grandparent's branches, with its origin", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const root = await fixture({ store });
    const child = await fixture({ store });
    const grandchild = await fixture({
      store,
      responses: [
        call("stash_put", { name: "findings", description: "auth audit", content: "important\n" }),
        fauxAssistantMessage("done"),
      ],
    });
    spawn(root, child, "a3f2b1c4-9d8e-4f6a");
    spawn(child, grandchild, "c07e0000-1111-2222");

    await grandchild.session.prompt("Work");

    const [own] = records(grandchild.manager);
    expect(own).toMatchObject({
      name: "findings",
      agent: "c07e0000-1111-2222",
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(own.via).toBeUndefined();
    for (const holder of [child, root]) {
      expect(records(holder.manager)).toEqual([{ ...own, via: "adopt" }]);
      expect(holder.listed()).toEqual([
        expect.objectContaining({
          id: expect.stringMatching(/^stash:findings@/),
          badge: { text: expect.stringMatching(/^↑ agent c07e0000 · /) },
        }),
      ]);
    }

    // The root's model never saw a receipt, so a hidden note names the entry, origin included.
    for (const holder of [child, root]) {
      expect(
        holder.manager
          .getBranch()
          .filter(
            (entry) => entry.type === "custom_message" && entry.customType === "stash:adopted",
          ),
      ).toEqual([expect.objectContaining({ display: false })]);
    }
    root.faux.setResponses([call("stash_list", {}), fauxAssistantMessage("listed")]);
    await root.session.prompt("What did the subagents find?");
    expect(request(root.requests, 0)).toMatch(
      /Stash entry added by a subagent .*stash:findings@[0-9a-f]{12} · 10 B · 1 line · from agent c07e0000 — auth audit/,
    );
    // Written once: a later request carries the same note, not another.
    expect(request(root.requests, 1).match(/Stash entry added by a subagent/g)).toHaveLength(1);
    expect(toolResults(root.manager, "stash_list")[0].content[0]).toMatchObject({
      text: expect.stringContaining("by agent c07e0000"),
    });
  }, 30_000);

  it("hands an entry only to its parent, which passes it on; a gap ends the chain", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const root = await fixture({ store });
    const child = await fixture({ store });
    const grandchild = await fixture({
      store,
      responses: [call("stash_put", { name: "found", content: "f" }), fauxAssistantMessage("done")],
    });
    spawn(root, child, "a3f2b1c4-9d8e-4f6a");
    spawn(child, grandchild, "c07e0000-1111-2222");
    // The child's pi-stash is replaced by one that records calls and passes nothing on.
    const adopted: unknown[] = [];
    provide(child.manager.getSessionId(), "stash:service", {
      version: 1,
      adopt: (record: unknown) => {
        adopted.push(record);
        return true;
      },
    });

    await grandchild.session.prompt("Work");

    expect(adopted).toEqual([
      expect.objectContaining({ name: "found", createdBy: grandchild.manager.getSessionId() }),
    ]);
    expect(names(root.manager)).toEqual([]);
    expect(names(grandchild.manager)).toEqual(["found"]);
  }, 30_000);

  it("leaves a root session's entries and unlinked sessions alone", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const root = await fixture({
      store,
      responses: [call("stash_put", { name: "plan", content: "p" }), fauxAssistantMessage("done")],
    });
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
    const child = await fixture({
      store,
      responses: [call("stash_put", { name: "found", content: "f" }), fauxAssistantMessage("done")],
    });
    spawn(parent, child, "a3f2b1c4-9d8e-4f6a");
    await child.session.prompt("Work");
    expect(names(parent.manager)).toEqual(["found"]);

    await parent.session.navigateTree(beforeSpawn, { summarize: false });

    expect(names(parent.manager)).toEqual([]);
    expect(parent.listed()).toEqual([]);
    expect(names(child.manager)).toEqual(["found"]);
  }, 20_000);

  it("keeps the child's put when the parent has shut down or its runtime is stale", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const parent = await fixture({ store });
    const child = await fixture({
      store,
      responses: [
        call("stash_put", { name: "one", content: "1" }),
        call("stash_put", { name: "two", content: "2" }),
        fauxAssistantMessage("done"),
      ],
    });
    spawn(parent, child, "a3f2b1c4-9d8e-4f6a");
    parent.session.dispose(); // session_shutdown withdraws the parent's service
    // A stale instance still registered for the parent throws, as Pi does after a reload.
    provide(parent.manager.getSessionId(), "stash:service", {
      version: 1,
      adopt: () => {
        throw new Error("This extension ctx is stale");
      },
    });

    await child.session.prompt("Work");

    expect(toolResults(child.manager, "stash_put").map((result) => result.isError)).toEqual([
      false,
      false,
    ]);
    expect(names(child.manager)).toEqual(["one", "two"]);
    expect(child.errors).toEqual([]);
  }, 20_000);

  it("adopts a version once and refuses malformed records", async () => {
    const store = new BlobStore(tempDir("pi-stash-root-"));
    const parent = await fixture({ store });
    const adopt = service<{ adopt(record: unknown): boolean }>(
      parent.manager.getSessionId(),
      "stash:service",
    )!;
    const hash = store.put("x").hash;
    const record = {
      name: "x",
      hash,
      bytes: 1,
      lines: 1,
      mime: "text/plain",
      createdAt: 1,
      createdBy: "child",
      source: "content",
      id: "0123456789abcdef",
    };

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
    const other = await fixture({
      store,
      responses: [
        call("stash_put", { name: "report", content: '{"ok":true}' }),
        fauxAssistantMessage("done"),
      ],
    });
    await other.session.prompt("Store");
    const [stored] = records(other.manager);
    const handle = `stash:report@${stored.hash.slice(0, 12)}`;
    const mine = await fixture({
      store,
      responses: [call("stash_put", { name: "kept-report", handle }), fauxAssistantMessage("done")],
    });

    await mine.session.prompt("Keep it");

    expect(toolResults(mine.manager, "stash_put")[0].isError).toBe(false);
    expect(records(mine.manager)).toEqual([
      expect.objectContaining({
        name: "kept-report",
        hash: stored.hash,
        mime: "application/json",
        source: `handle:${handle}`,
      }),
    ]);
  }, 20_000);
});
