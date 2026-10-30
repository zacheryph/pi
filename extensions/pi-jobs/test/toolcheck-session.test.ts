/**
 * job_watch tool checks end to end (local addition): real AgentSession, faux provider, the pi-jobs
 * extension, and a fake read-only status tool. Offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createJobsExtension, CUSTOM_TYPE } from "../src/extension.ts";
import type { JobManager } from "../src/jobs.ts";
import { tempDir, waitUntil } from "./helpers.ts";

type Ctx = Parameters<typeof tempDir>[0];

async function harness(t: Ctx, opts: { block?: boolean } = {}) {
	const dir = tempDir(t);
	const faux = createFauxCore({ provider: "toolcheck", models: [{ id: "m" }] });
	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "cache"), refreshOnCreate: false });
	modelRuntime.registerProvider("toolcheck", { api: faux.api, apiKey: "k", models: faux.models, streamSimple: faux.streamSimple });
	const state = { status: "queued", calls: 0 };
	let manager: JobManager | undefined;
	const tools = (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "ci_status", label: "ci_status", description: "CI status for a commit", parameters: Type.Object({ sha: Type.String() }),
			annotations: { readOnlyHint: true },
			execute: async () => {
				state.calls++;
				return { content: [{ type: "text", text: JSON.stringify({ status: state.status, polledAt: state.calls }) }], details: {} };
			},
		});
		pi.registerTool({
			name: "deploy", label: "deploy", description: "not read-only", parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "deployed" }], details: {} }),
		});
		if (opts.block) pi.on("tool_call", async e => (e.toolName === "ci_status" && e.parentToolCallId ? { block: true, reason: "blocked by policy" } : undefined));
	};
	const loader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory({}),
		noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true,
		extensionFactories: [createJobsExtension({ logRoot: join(dir, "logs"), minIntervalSeconds: 0.01, killGraceMs: 300, drainMs: 200, onManager: m => (manager = m) }), tools],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel(), resourceLoader: loader,
		sessionManager: SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		tools: ["job_watch", "job_list", "ci_status", "deploy"],
	});
	t.after(async () => {
		try { await session.abort(); } catch {}
		session.dispose();
		await manager?.shutdown(200);
	});
	await session.bindExtensions({ mode: "print", onError: e => { throw e; } });
	/** One model turn that calls job_watch with `params`, then ends; plus replies for wake-ups. */
	const watch = async (params: Record<string, unknown>) => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("job_watch", params as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" }),
			fauxAssistantMessage("watching"),
			...Array.from({ length: 5 }, () => fauxAssistantMessage("woken")),
		]);
		await session.prompt("watch it");
		const result = [...session.messages].reverse().find(m => m.role === "toolResult" && m.toolName === "job_watch");
		assert.ok(result && result.role === "toolResult");
		return { isError: result.isError, text: result.content.map(c => (c.type === "text" ? c.text : "")).join("") };
	};
	const completions = () =>
		session.messages
			.filter(m => m.role === "custom" && (m as { customType?: string }).customType === CUSTOM_TYPE)
			.map(m => JSON.stringify((m as { content?: unknown }).content));
	return { session, state, watch, completions };
}

const params = (over: Record<string, unknown> = {}) => ({
	toolCheck: { tool: "ci_status", args: { sha: "abc123" }, match: { path: "status", equals: "completed" } },
	intervalSeconds: 0.02,
	timeoutSeconds: 10,
	label: "CI on abc123",
	...over,
});

test("a tool watch matches when the condition holds and wakes the agent once", async t => {
	const h = await harness(t);
	const started = await h.watch(params());
	assert.equal(started.isError, false, started.text);
	assert.match(started.text, /Started watch j1 \(CI on abc123\) until success/);
	await waitUntil(() => h.state.calls >= 2, 5000, "a few checks");
	assert.deepEqual(h.completions(), [], "no wake-up while the condition does not hold");
	h.state.status = "completed";
	await waitUntil(() => h.completions().length === 1, 5000, "completion");
	const [note] = h.completions();
	assert.match(note, /Watch j1 matched: CI on abc123/);
	assert.match(note, /status = \\"completed\\"/);
	assert.match(note, /condition holds/);
	await waitUntil(() => h.session.isIdle, 5000, "woken turn done");
	assert.equal(h.completions().length, 1);
});

test("until change compares only the selected value, not the rest of the result", async t => {
	const h = await harness(t);
	const started = await h.watch(params({ until: "change", toolCheck: { tool: "ci_status", args: { sha: "abc123" }, match: { path: "status" } } }));
	assert.equal(started.isError, false, started.text);
	// polledAt changes on every call; the watch must not fire on it.
	await waitUntil(() => h.state.calls >= 4, 5000, "several checks");
	assert.deepEqual(h.completions(), []);
	h.state.status = "in_progress";
	await waitUntil(() => h.completions().length === 1, 5000, "change");
	assert.match(h.completions()[0], /Watch j1 matched/);
	assert.match(h.completions()[0], /status = \\"in_progress\\"/);
});

test("blocked tool calls are inconclusive, and three in a row fail the watch", async t => {
	const h = await harness(t, { block: true });
	assert.equal((await h.watch(params())).isError, false);
	await waitUntil(() => h.completions().length === 1, 5000, "failure notice");
	const [note] = h.completions();
	assert.match(note, /Watch j1 failed/);
	assert.match(note, /blocked by policy \(3 consecutive check errors; giving up\)/);
	assert.match(note, /last check inconclusive/);
	assert.equal(h.state.calls, 0, "the blocked tool never ran");
});

test("job_watch rejects unsafe or malformed tool checks", async t => {
	const h = await harness(t);
	const notReadOnly = await h.watch(params({ toolCheck: { tool: "deploy", args: {} } }));
	assert.equal(notReadOnly.isError, true);
	assert.match(notReadOnly.text, /deploy is not marked read-only.*PI_JOBS_WATCH_TOOLS/);
	assert.match((await h.watch(params({ toolCheck: { tool: "bash", args: { command: "true" } } }))).text, /cannot be a watch check/);
	assert.match((await h.watch(params({ until: "failure" }))).text, /until success or change/);
	assert.match((await h.watch(params({ check: "true" }))).text, /exactly one of check or toolCheck/);
	const { toolCheck: _, ...neither } = params();
	assert.match((await h.watch(neither)).text, /exactly one of check or toolCheck/);
	assert.match((await h.watch(params({ toolCheck: { tool: "missing" } }))).text, /Unknown tool missing/);
});

test("PI_JOBS_WATCH_TOOLS allows a tool that is not marked read-only", async t => {
	const previous = process.env.PI_JOBS_WATCH_TOOLS;
	process.env.PI_JOBS_WATCH_TOOLS = "dep*";
	t.after(() => {
		if (previous === undefined) delete process.env.PI_JOBS_WATCH_TOOLS;
		else process.env.PI_JOBS_WATCH_TOOLS = previous;
	});
	const h = await harness(t);
	const started = await h.watch(params({ toolCheck: { tool: "deploy", args: {} } }));
	assert.equal(started.isError, false, started.text);
	await waitUntil(() => h.completions().length === 1, 5000, "match");
	assert.match(h.completions()[0], /Watch j1 matched/);
});

test("after reload, a running tool watch fails with a re-arm hint instead of polling on", async t => {
	const h = await harness(t);
	assert.equal((await h.watch(params())).isError, false);
	await waitUntil(() => h.state.calls >= 1, 5000, "first check");
	await h.session.reload();
	await waitUntil(() => h.completions().length === 1, 5000, "failure after reload");
	const [note] = h.completions();
	assert.match(note, /Watch j1 failed/);
	assert.match(note, /reloaded or replaced.*Start it again/);
});
