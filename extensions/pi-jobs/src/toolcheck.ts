/**
 * job_watch tool checks (local addition, see UPSTREAM.md): call one Pi tool per interval through
 * the session's ctx.executeTool(), so validation, tool_call hooks and permission checks apply as
 * for model-issued calls. No model is involved, so only read-only or explicitly allowed tools
 * may be watched, and a failed call is inconclusive rather than a verdict.
 */
import type { ProbeResult, WatchProbe } from "./probe.ts";

export interface MatchSpec {
	/** Dot path into the result, e.g. `check_runs.0.status`; empty for the whole result. */
	path: string;
	equals?: unknown;
	in?: unknown[];
	contains?: string;
}

export interface ToolCheckSpec {
	tool: string;
	args: Record<string, unknown>;
	match?: MatchSpec;
}

/** What a watch needs to know about a registered tool (a subset of Pi's ToolInfo). */
export interface ToolFacts {
	name: string;
	exposure?: string;
	annotations?: { readOnlyHint?: boolean };
}

export interface ToolCallOutcome {
	isError: boolean;
	result: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
}

export type ExecuteTool = (name: string, args: unknown, options: { signal: AbortSignal }) => Promise<ToolCallOutcome>;

export const DEFAULT_MAX_CHECK_ERRORS = 3;

/** Never valid as a check: they change state, run arbitrary code, or would start more jobs. */
const NEVER = new Set(["bash", "edit", "write", "codemode"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseToolCheck(value: unknown): ToolCheckSpec {
	if (!isRecord(value)) throw new Error("toolCheck must be an object with tool and args.");
	const { tool, args, match } = value;
	if (typeof tool !== "string" || !tool.trim()) throw new Error("toolCheck.tool must be a tool name.");
	if (args !== undefined && !isRecord(args)) throw new Error("toolCheck.args must be an object.");
	const spec: ToolCheckSpec = { tool: tool.trim(), args: (args as Record<string, unknown> | undefined) ?? {} };
	if (match !== undefined) {
		if (!isRecord(match) || typeof match.path !== "string") throw new Error("toolCheck.match must be an object with a string path.");
		const predicates = (["equals", "in", "contains"] as const).filter(key => match[key] !== undefined);
		if (predicates.length > 1) throw new Error("toolCheck.match takes at most one of equals, in, contains.");
		if (match.in !== undefined && !Array.isArray(match.in)) throw new Error("toolCheck.match.in must be an array.");
		if (match.contains !== undefined && typeof match.contains !== "string") throw new Error("toolCheck.match.contains must be a string.");
		spec.match = { path: match.path, ...(predicates.length ? { [predicates[0]]: match[predicates[0]] } : {}) };
	}
	return spec;
}

/** Comma-separated tool-name globs (`*` matches any run of characters), e.g. `mcp__github__*`. */
export function parseAllowList(value: string | undefined): string[] {
	return (value ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

export function globMatch(pattern: string, name: string): boolean {
	const source = pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
	return new RegExp(`^${source}$`).test(name);
}

/** Throws with the reason when `name` may not be used as a watch check. */
export function assertWatchable(name: string, tools: readonly ToolFacts[], allow: readonly string[]): void {
	if (NEVER.has(name) || name.startsWith("job_")) throw new Error(`${name} cannot be a watch check; use a shell check for commands.`);
	const tool = tools.find(t => t.name === name);
	if (!tool) throw new Error(`Unknown tool ${name}.`);
	if (tool.exposure === "model-only" || tool.exposure === "hidden") throw new Error(`${name} cannot be called by extensions (exposure ${tool.exposure}).`);
	if (tool.annotations?.readOnlyHint === true || allow.some(pattern => globMatch(pattern, name))) return;
	throw new Error(`${name} is not marked read-only. Allow it explicitly with PI_JOBS_WATCH_TOOLS (comma-separated globs, e.g. ${name}).`);
}

/** JSON with object keys sorted at every level, so equal data always renders the same. */
export function canonicalJson(value: unknown, indent?: number): string {
	const sort = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(sort);
		if (isRecord(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])]));
		return v;
	};
	return JSON.stringify(sort(value), null, indent) ?? "null";
}

export function getPath(value: unknown, path: string): { found: boolean; value: unknown } {
	let current = value;
	for (const key of path.split(".").filter(Boolean)) {
		if (Array.isArray(current) && /^\d+$/.test(key) && Number(key) < current.length) current = current[Number(key)];
		else if (isRecord(current) && Object.hasOwn(current, key)) current = current[key];
		else return { found: false, value: undefined };
	}
	return { found: true, value: current };
}

export function evaluateMatch(match: MatchSpec, data: unknown): { holds: boolean; found: boolean; value: unknown } {
	const { found, value } = getPath(data, match.path);
	if (!found) return { holds: false, found, value };
	const same = (expected: unknown) => canonicalJson(expected) === canonicalJson(value);
	let holds = true;
	if (match.equals !== undefined) holds = same(match.equals);
	else if (match.in !== undefined) holds = match.in.some(same);
	else if (match.contains !== undefined) holds = (typeof value === "string" ? value : canonicalJson(value)).includes(match.contains);
	return { holds, found, value };
}

function textOf(outcome: ToolCallOutcome): string {
	return (outcome.result.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
}

/** Structured content when the tool returns it, else the text, parsed when it is JSON. */
export function resultData(outcome: ToolCallOutcome): unknown {
	if (outcome.result.structuredContent !== undefined) return outcome.result.structuredContent;
	const text = textOf(outcome);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * One tool call per check. With `match`, the output is the selected value and the verdict, so
 * until:"change" compares only that value; without it, the whole result (condition holds when the
 * call succeeds). Errors are inconclusive; `maxErrors` consecutive ones, or a stale session, end
 * the watch.
 */
export function createToolProbe(spec: ToolCheckSpec, execute: ExecuteTool, maxErrors = DEFAULT_MAX_CHECK_ERRORS): WatchProbe {
	let errors = 0;
	const failure = (message: string, output = ""): ProbeResult => {
		errors++;
		const final = errors >= maxErrors;
		return { exitCode: 1, output, error: final ? `${message} (${errors} consecutive check errors; giving up)` : message, final };
	};
	return {
		async run(signal) {
			let outcome: ToolCallOutcome;
			try {
				outcome = await execute(spec.tool, spec.args, { signal });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (/stale/i.test(message)) {
					return { exitCode: 1, output: "", error: "The session was reloaded or replaced, so this watch can no longer call tools. Start it again.", final: true };
				}
				return failure(message);
			}
			if (outcome.isError) return failure(`${spec.tool} failed: ${textOf(outcome) || "tool error"}`, textOf(outcome));
			errors = 0;
			const data = resultData(outcome);
			if (!spec.match) return { exitCode: 0, output: typeof data === "string" ? data : canonicalJson(data, 2) };
			const verdict = evaluateMatch(spec.match, data);
			const shown = verdict.found ? canonicalJson(verdict.value, 2) : "(missing)";
			const where = spec.match.path || "(result)";
			return { exitCode: verdict.holds ? 0 : 1, output: `${where} = ${shown}\n${verdict.holds ? "condition holds" : "condition does not hold"}` };
		},
	};
}

/** Short label for /jobs, the log header and notifications. */
export function toolCheckTitle(spec: ToolCheckSpec): string {
	const args = canonicalJson(spec.args);
	const shown = args.length > 120 ? `${args.slice(0, 117)}...` : args;
	const match = spec.match ? ` · ${spec.match.path || "(result)"}${spec.match.equals !== undefined ? ` == ${canonicalJson(spec.match.equals)}` : spec.match.in !== undefined ? ` in ${canonicalJson(spec.match.in)}` : spec.match.contains !== undefined ? ` contains ${JSON.stringify(spec.match.contains)}` : ""}` : "";
	return `tool:${spec.tool} ${shown}${match}`;
}
