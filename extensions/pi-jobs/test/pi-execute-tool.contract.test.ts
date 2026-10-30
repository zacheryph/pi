/**
 * Contract: what Pi's ctx.executeTool() does when a tool keeps its ExtensionToolContext and calls
 * it after the tool call itself has returned, which is how job_watch tool checks will run (#9).
 * Pins Pi behaviour that pi-jobs relies on; a Pi upgrade that changes any of it fails here.
 * Offline: real AgentSession, faux provider, no pi-jobs code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionAPI, type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface Seen { toolName: string; toolCallId: string; parentToolCallId?: string }
type Outcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;

const text = (o: Outcome) => (o.result.content ?? []).filter(c => c.type === "text").map(c => (c as { text: string }).text).join("");

async function fixture(t: { after(fn: () => void | Promise<void>): void }) {
	const dir = mkdtempSync(join(tmpdir(), "pi-jobs-contract-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const faux = createFauxCore({ provider: "contract", models: [{ id: "m" }] });
	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "cache"), refreshOnCreate: false });
	modelRuntime.registerProvider("contract", { api: faux.api, apiKey: "k", models: faux.models, streamSimple: faux.streamSimple });
	let retained: ExtensionToolContext | undefined;
	const probes: string[] = [];
	const seen: Seen[] = [];
	const ext = (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "retain", label: "retain", description: "keeps its ctx", parameters: Type.Object({}),
			execute: async (_id, _p, _s, _u, ctx) => {
				retained = ctx;
				return { content: [{ type: "text", text: "retained" }], details: {} };
			},
		});
		pi.registerTool({
			name: "probe", label: "probe", description: "read-only probe", parameters: Type.Object({ tag: Type.Optional(Type.String()) }),
			annotations: { readOnlyHint: true },
			execute: async (_id, p: { tag?: string }) => {
				probes.push(p.tag ?? "");
				return { content: [{ type: "text", text: `probe:${p.tag ?? ""}` }], details: {} };
			},
		});
		pi.on("tool_call", async e => {
			seen.push({ toolName: e.toolName, toolCallId: e.toolCallId, parentToolCallId: e.parentToolCallId });
			if ((e.input as { tag?: string }).tag === "deny") return { block: true, reason: "denied by hook" };
			return undefined;
		});
	};
	const loader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory({}),
		noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true,
		extensionFactories: [ext, createCodemodeExtension()],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel(), resourceLoader: loader,
		sessionManager: SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } }),
		tools: ["retain", "probe", "codemode"],
	});
	t.after(() => session.dispose());
	await session.bindExtensions({ mode: "print", onError: e => { throw e; } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("retain", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	await session.prompt("go");
	assert.ok(retained, "retain ran");
	const nestedRecords = () => session.messages.filter(m => m.role === "toolResult" && "nestedCalls" in m && m.nestedCalls);
	return { session, faux, ctx: retained!, probes, seen, nestedRecords };
}

test("a kept ctx calls tools after its tool call returned, while idle", async t => {
	const f = await fixture(t);
	const out = await f.ctx.executeTool("probe", { tag: "idle" });
	assert.equal(out.isError, false);
	assert.equal(text(out), "probe:idle");
	assert.deepEqual(f.probes, ["idle"]);
	// The calling tool's record was already taken when its result was saved: nothing lands on a message.
	assert.deepEqual(f.nestedRecords(), []);
});

test("a kept ctx calls tools while another run is streaming, without touching that run's messages", async t => {
	const f = await fixture(t);
	let release!: () => void;
	let entered!: () => void;
	const inside = new Promise<void>(r => (entered = r));
	f.faux.setResponses([() => new Promise(resolve => {
		release = () => resolve(fauxAssistantMessage("busy done"));
		entered();
	}) as never]);
	const run = f.session.prompt("second");
	await inside;
	assert.equal(f.session.isStreaming, true);
	const out = await f.ctx.executeTool("probe", { tag: "busy" });
	release();
	await run;
	assert.equal(out.isError, false);
	assert.deepEqual(f.nestedRecords(), []);
});

test("a kept ctx keeps working after compaction", async t => {
	const f = await fixture(t);
	f.faux.setResponses([fauxAssistantMessage("a".repeat(400)), fauxAssistantMessage("b".repeat(400))]);
	await f.session.prompt("more history ".repeat(50));
	await f.session.prompt("even more history ".repeat(50));
	f.faux.setResponses([fauxAssistantMessage("history summary"), fauxAssistantMessage("turn prefix summary")]);
	await f.session.compact();
	const out = await f.ctx.executeTool("probe", { tag: "compacted" });
	assert.equal(out.isError, false);
});

test("after /tree to a point with no assistant message, calls fail without running", async t => {
	const f = await fixture(t);
	const [first] = f.session.getUserMessagesForForking();
	assert.equal((await f.session.navigateTree(first.entryId)).cancelled, false);
	const out = await f.ctx.executeTool("probe", { tag: "tree" });
	assert.equal(out.isError, true);
	assert.match(text(out), /No assistant message issued this call/);
	assert.deepEqual(f.probes, []);
});

test("after reload, a kept ctx is stale and throws", async t => {
	const f = await fixture(t);
	await f.session.reload();
	await assert.rejects(() => f.ctx.executeTool("probe", { tag: "reloaded" }), /stale/);
	assert.deepEqual(f.probes, []);
});

test("tool_call hooks run for kept-ctx calls and can block them; ids nest under the caller", async t => {
	const f = await fixture(t);
	const out = await f.ctx.executeTool("probe", { tag: "deny" });
	assert.equal(out.isError, true);
	assert.equal(text(out), "denied by hook");
	assert.deepEqual(f.probes, []);
	const caller = f.seen.find(s => s.toolName === "retain")!;
	const nested = f.seen.at(-1)!;
	assert.equal(nested.toolName, "probe");
	assert.equal(nested.parentToolCallId, caller.toolCallId);
	assert.equal(nested.toolCallId, `${caller.toolCallId}/1`);
});

test("codemode is model-only: executeTool cannot run it even while active", async t => {
	const f = await fixture(t);
	assert.ok(f.session.getActiveToolNames().includes("codemode"));
	const out = await f.ctx.executeTool("codemode", { code: "return 1;" });
	assert.equal(out.isError, true);
	assert.equal(text(out), "Tool codemode not found");
});
