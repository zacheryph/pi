/**
 * observe.ts — find the pull requests a tool call touched, and what its output
 * said about them.
 *
 * Three sources, from most to least certain:
 *
 * - `gh pr <verb>` and `gh api repos/<o>/<r>/pulls/<n>` in a shell command,
 *   with the command's output parsed for status (`--json`, `gh pr view`'s
 *   plain `key:\tvalue` output, `gh pr checks` rows);
 * - GitHub tools (an MCP server's `mcp__github__*`, or any tool whose name
 *   says github) whose input names `owner`, `repo` and a pull number, with
 *   their JSON output parsed for status;
 * - a pull request URL anywhere in another tool's input: the model chose to
 *   pass it, so the session is looking at that PR.
 *
 * Other output is never scanned: a `git log` or a file that mentions PR URLs
 * is not the session checking those PRs.
 */
import { isRecord } from "#foundations/guards";

import { prUrl, type PrChecks, type PrFacts, type PrOrigin, type PrRef } from "#src/prs";

export interface Observation {
  ref: PrRef;
  url: string;
  origin: PrOrigin;
  title?: string;
  facts?: PrFacts;
}

export interface ToolResultLike {
  toolName: string;
  input: Record<string, unknown>;
  content: readonly { type: string; text?: string }[];
  isError?: boolean;
}

/** The GitHub repository a directory's `origin` remote points at, when it has one. */
export type RepoResolver = (cwd: string) => Promise<Omit<PrRef, "number"> | undefined>;

/** Output beyond this is not parsed; a PR's JSON or `gh` rows come first. */
const MAX_OUTPUT = 256 * 1024;
const PR_URL =
  /https?:\/\/([A-Za-z0-9.-]+(?::\d+)?)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;
const REPO_URL =
  /https?:\/\/([A-Za-z0-9.-]+(?::\d+)?)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:pull|actions|runs|commit|checks)\b/;
const GH_PR_VERBS = "view|checks|merge|review|ready|edit|comment|close|reopen|create|diff";
const GH_PR = new RegExp(String.raw`(?:^|[\s;&|(])gh\s+pr\s+(${GH_PR_VERBS})\b([^\n;&|]*)`, "g");
const GH_API_PULL =
  /(?:^|[\s;&|(])gh\s+api\b[^\n;&|]*?['"]?\/?repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pulls\/(\d+)(\/[A-Za-z0-9_/-]*)?/g;

export function outputText(content: ToolResultLike["content"]): string {
  return content
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .slice(0, MAX_OUTPUT);
}

export function parsePrUrls(text: string): Array<{ ref: PrRef; url: string }> {
  const found = new Map<string, { ref: PrRef; url: string }>();
  for (const match of text.matchAll(PR_URL)) {
    const ref = { host: match[1], owner: match[2], repo: match[3], number: Number(match[4]) };
    found.set(match[0].toLowerCase(), { ref, url: match[0] });
  }
  return [...found.values()];
}

/** Parse `git remote get-url` output: https, ssh and scp-like forms. */
export function parseRemote(url: string): Omit<PrRef, "number"> | undefined {
  const trimmed = url.trim();
  const match =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      trimmed,
    ) ?? /^(?:[^@]+@)?([^:/]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  return match ? { host: match[1], owner: match[2], repo: match[3] } : undefined;
}

export async function observe(
  result: ToolResultLike,
  options: { cwd: string; resolveRepo: RepoResolver },
): Promise<Observation[]> {
  // A shell command can exit nonzero and still report: `gh pr checks` exits 1
  // when a check failed and 8 while checks are pending.
  if (result.toolName === "bash") return observeShell(result, options);
  if (result.isError) return [];
  if (/github/i.test(result.toolName)) return observeGithubTool(result);
  return observeInput(result.input);
}

// ── Shell: gh pr / gh api ──────────────────────────────────────────────────

async function observeShell(
  result: ToolResultLike,
  options: { cwd: string; resolveRepo: RepoResolver },
): Promise<Observation[]> {
  const command = typeof result.input.command === "string" ? result.input.command : "";
  if (!/\bgh\s+(?:pr|api)\b/.test(command)) return [];
  // Pi's bash tool appends the exit status to a failed command's output.
  const output = outputText(result.content).replace(/\n*Command exited with code \d+\s*$/, "");
  const json = parseJson(output);
  const observations: Observation[] = [];

  const prCommands = [...command.matchAll(GH_PR)];
  const apiCommands = [...command.matchAll(GH_API_PULL)];
  // The output belongs to the whole call. With one PR command it is that
  // command's; with several, which part belongs to which is unknown, so
  // status and repositories come only from what each command names itself.
  const shared = prCommands.length + apiCommands.length > 1;
  const creates = prCommands.filter((match) => match[1] === "create").length;

  for (const match of prCommands) {
    const verb = match[1];
    const args = match[2];
    // A nonzero exit is a failure, except for `gh pr checks`, which exits 1
    // when a check failed and 8 while checks are pending.
    if (result.isError && verb !== "checks") continue;
    let ref: PrRef | undefined;
    let url: string | undefined;
    const argUrl = parsePrUrls(args)[0];
    const number = /(?:^|\s)#?(\d+)(?=\s|$)/.exec(args)?.[1];
    const repoFlag = /(?:^|\s)(?:-R|--repo)[=\s]+(\S+)/.exec(args)?.[1];
    if (argUrl) ({ ref, url } = argUrl);
    else if (verb === "create") {
      // Batched, the printed URL is the create's only when it is the only one.
      const printed = parsePrUrls(output);
      const created = shared
        ? creates === 1 && printed.length === 1
          ? printed[0]
          : undefined
        : printed.at(-1);
      if (created) ({ ref, url } = created);
    } else if (number) {
      const repo =
        (repoFlag && parseRepoFlag(repoFlag)) ??
        (shared ? undefined : repoFromOutput(output)) ??
        (await options.resolveRepo(cdTarget(command, options.cwd)));
      if (repo) ref = { ...repo, number: Number(number) };
    } else if (!shared) {
      // The current branch's PR: its URL is in `--json url` or plain output.
      const shown = jsonPr(json) ?? parsePrUrls(output)[0];
      if (shown) ({ ref, url } = shown);
    }
    if (!ref) continue;
    // `gh pr create`'s facts come from its own arguments; every other verb's from the output.
    const facts = shared && verb !== "create" ? {} : ghFacts(verb, args, output, json);
    // A failed `gh pr checks` counts only when it listed checks.
    if (result.isError && !facts.facts?.checks) continue;
    observations.push({
      ref,
      url: url ?? prUrl(ref),
      origin: verb === "create" ? "created" : "referenced",
      ...facts,
    });
  }

  for (const match of apiCommands) {
    if (result.isError) break;
    const host = /--hostname[=\s]+(\S+)/.exec(command)?.[1] ?? "github.com";
    const ref = { host, owner: match[1], repo: match[2], number: Number(match[3]) };
    const facts = shared ? {} : restFacts(json, match[4] ?? "");
    observations.push({ ref, url: prUrl(ref), origin: "referenced", ...facts });
  }
  return dedupe(observations);
}

function parseRepoFlag(flag: string): Omit<PrRef, "number"> | undefined {
  const cleaned = flag.replace(/^['"]|['"]$/g, "").replace(/^https?:\/\//, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length === 2) return { host: "github.com", owner: parts[0], repo: parts[1] };
  if (parts.length === 3) return { host: parts[0], owner: parts[1], repo: parts[2] };
  return undefined;
}

function repoFromOutput(output: string): Omit<PrRef, "number"> | undefined {
  const match = REPO_URL.exec(output);
  return match ? { host: match[1], owner: match[2], repo: match[3] } : undefined;
}

/** The directory a leading `cd <dir> &&` moves the command into. */
function cdTarget(command: string, cwd: string): string {
  const dir = /^\s*cd\s+(['"]?)([^'"\s;&|]+)\1\s*&&/.exec(command)?.[2];
  if (!dir) return cwd;
  return dir.startsWith("/") ? dir : `${cwd.replace(/\/$/, "")}/${dir}`;
}

function ghFacts(
  verb: string,
  args: string,
  output: string,
  json: unknown,
): { title?: string; facts?: PrFacts } {
  if (verb === "create")
    return { facts: { state: "open", ...(/--draft\b/.test(args) ? { draft: true } : {}) } };
  if (verb === "merge") {
    if (/--auto\b/.test(args)) return {};
    return /merged pull request/i.test(output) ? { facts: { state: "merged" } } : {};
  }
  if (verb === "close" && /closed pull request/i.test(output))
    return { facts: { state: "closed" } };
  if (verb === "reopen" && /reopened pull request/i.test(output))
    return { facts: { state: "open" } };
  if (verb === "ready" && /ready for review/i.test(output)) return { facts: { draft: false } };
  if (verb === "checks") {
    const checks = Array.isArray(json) ? checksFromBuckets(json) : checksFromRows(output);
    return checks ? { facts: { checks } } : {};
  }
  if (verb === "view") {
    if (isRecord(json)) return graphqlFacts(json);
    return plainViewFacts(output);
  }
  return {};
}

/** `gh pr view` without `--json` prints `key:\tvalue` lines when not on a terminal. */
function plainViewFacts(output: string): { title?: string; facts?: PrFacts } {
  const field = (name: string) =>
    new RegExp(String.raw`^${name}:\t(.*)$`, "m").exec(output)?.[1]?.trim();
  const title = field("title");
  const state = field("state")?.toUpperCase();
  const facts: PrFacts = {};
  if (state === "OPEN" || state === "DRAFT") facts.state = "open";
  if (state === "DRAFT") facts.draft = true;
  if (state === "CLOSED") facts.state = "closed";
  if (state === "MERGED") facts.state = "merged";
  return { ...(title ? { title } : {}), ...(Object.keys(facts).length ? { facts } : {}) };
}

/** `gh pr checks` rows: `name\t<bucket>\t<elapsed>\t<link>…`. */
function checksFromRows(output: string): PrChecks | undefined {
  const buckets: unknown[] = [];
  for (const line of output.split("\n")) {
    const bucket = line.split("\t")[1]?.trim();
    if (bucket) buckets.push({ bucket });
  }
  return checksFromBuckets(buckets);
}

/** `gh pr checks --json bucket` items: pass, fail, pending, skipping, cancel. */
function checksFromBuckets(items: readonly unknown[]): PrChecks | undefined {
  const checks: PrChecks = { passed: 0, failed: 0, pending: 0 };
  let seen = false;
  for (const item of items) {
    if (!isRecord(item)) continue;
    const bucket = typeof item.bucket === "string" ? item.bucket.toLowerCase() : "";
    if (bucket === "pass" || bucket === "skipping") checks.passed += 1;
    else if (bucket === "fail" || bucket === "cancel") checks.failed += 1;
    else if (bucket === "pending") checks.pending += 1;
    else continue;
    seen = true;
  }
  return seen ? checks : undefined;
}

/** `gh pr view --json …` fields. */
export function graphqlFacts(json: Record<string, unknown>): { title?: string; facts?: PrFacts } {
  const facts: PrFacts = {};
  const state = typeof json.state === "string" ? json.state.toUpperCase() : undefined;
  if (state === "OPEN") facts.state = "open";
  if (state === "CLOSED") facts.state = "closed";
  if (state === "MERGED") facts.state = "merged";
  if (typeof json.isDraft === "boolean") facts.draft = json.isDraft;
  const review =
    typeof json.reviewDecision === "string" ? json.reviewDecision.toUpperCase() : undefined;
  // An empty decision is gh saying no decision stands, not that it was not asked.
  if (review === "") facts.review = "none";
  if (review === "APPROVED") facts.review = "approved";
  if (review === "CHANGES_REQUESTED") facts.review = "changes_requested";
  if (review === "REVIEW_REQUIRED") facts.review = "review_required";
  if (json.mergeable === "MERGEABLE") facts.mergeable = true;
  if (json.mergeable === "CONFLICTING") facts.mergeable = false;
  if (typeof json.headRefOid === "string" && json.headRefOid) facts.headSha = json.headRefOid;
  if (typeof json.headRefName === "string" && json.headRefName) facts.headRef = json.headRefName;
  if (Array.isArray(json.statusCheckRollup)) {
    const checks = checksFromRollup(json.statusCheckRollup);
    if (checks) facts.checks = checks;
  }
  const title = typeof json.title === "string" ? json.title : undefined;
  return { ...(title ? { title } : {}), ...(Object.keys(facts).length ? { facts } : {}) };
}

/** `statusCheckRollup`: CheckRun (status, conclusion) and StatusContext (state) items. */
function checksFromRollup(items: readonly unknown[]): PrChecks | undefined {
  const checks: PrChecks = { passed: 0, failed: 0, pending: 0 };
  let seen = false;
  for (const item of items) {
    if (!isRecord(item)) continue;
    const outcome = checkOutcome(item);
    if (!outcome) continue;
    checks[outcome] += 1;
    seen = true;
  }
  return seen || items.length === 0 ? checks : undefined;
}

/** One check run or status context, from GraphQL or REST, as passed, failed or pending. */
function checkOutcome(item: Record<string, unknown>): keyof PrChecks | undefined {
  const state = typeof item.state === "string" ? item.state.toUpperCase() : undefined;
  if (state && item.status === undefined && item.conclusion === undefined) {
    if (state === "SUCCESS") return "passed";
    if (state === "FAILURE" || state === "ERROR") return "failed";
    if (state === "PENDING" || state === "EXPECTED") return "pending";
    return undefined;
  }
  const status = typeof item.status === "string" ? item.status.toUpperCase() : "";
  if (status && status !== "COMPLETED") return "pending";
  const conclusion = typeof item.conclusion === "string" ? item.conclusion.toUpperCase() : "";
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) return "passed";
  if (
    ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(
      conclusion,
    )
  )
    return "failed";
  return conclusion ? undefined : "pending";
}

// ── GitHub tools (MCP and others) ──────────────────────────────────────────

const NUMBER_KEYS = ["pullNumber", "pull_number", "pullRequestNumber", "pull_request_number"];

function inputRef(input: Record<string, unknown>, allowPlainNumber: boolean): PrRef | undefined {
  const owner = input.owner;
  const repo = input.repo;
  if (typeof owner !== "string" || typeof repo !== "string" || !owner || !repo) return undefined;
  const keys = allowPlainNumber ? [...NUMBER_KEYS, "number"] : NUMBER_KEYS;
  for (const key of keys) {
    const value = Number(input[key]);
    if (Number.isSafeInteger(value) && value > 0)
      return { host: "github.com", owner, repo, number: value };
  }
  return undefined;
}

function observeGithubTool(result: ToolResultLike): Observation[] {
  const output = outputText(result.content);
  const json = parseJson(output);
  const pullTool = /pull/i.test(result.toolName);
  if (/create_pull_request/i.test(result.toolName)) {
    const shown = jsonPr(json) ?? parsePrUrls(output)[0];
    if (!shown) return [];
    const rest = restFacts(json, "");
    return [
      {
        ...shown,
        origin: "created",
        ...(rest.title ? { title: rest.title } : {}),
        facts: { state: "open", ...rest.facts },
      },
    ];
  }
  const ref = inputRef(result.input, pullTool);
  if (ref) {
    const merged =
      /merge_pull_request/i.test(result.toolName) && isRecord(json) && json.merged === true;
    // pull_request_read's `method` says what the result is, even when it is an empty list.
    const method = typeof result.input.method === "string" ? result.input.method : "";
    const facts = restFacts(json, method === "get_reviews" ? "/reviews" : "");
    return [
      {
        ref,
        url: prUrl(ref),
        origin: "referenced",
        ...facts,
        ...(merged ? { facts: { ...facts.facts, state: "merged" as const } } : {}),
      },
    ];
  }
  return observeInput(result.input);
}

/**
 * Status from a REST-shaped result: a pull request object, its reviews, its
 * check runs, or its combined status. `sub` is the path after `pulls/<n>`.
 */
export function restFacts(json: unknown, sub: string): { title?: string; facts?: PrFacts } {
  if (Array.isArray(json)) {
    // Only the reviews list can establish that no decision stands. A review's
    // comments are a different endpoint and carry no decision, even when empty.
    if (
      /^\/reviews\/?$/.test(sub) ||
      json.some((item) => isRecord(item) && "submitted_at" in item)
    ) {
      const review = reviewFromList(json);
      return review ? { facts: { review } } : {};
    }
    return {};
  }
  if (!isRecord(json)) return {};
  if (Array.isArray(json.check_runs)) {
    const checks = checksFromRollup(json.check_runs);
    return checks ? { facts: { checks } } : {};
  }
  if (Array.isArray(json.statuses) && typeof json.state === "string" && !("number" in json)) {
    const checks = checksFromRollup(json.statuses);
    return checks ? { facts: { checks } } : {};
  }
  if (typeof json.number !== "number" && typeof json.html_url !== "string") return {};
  const facts: PrFacts = {};
  if (json.merged === true || typeof json.merged_at === "string") facts.state = "merged";
  else if (json.state === "open") facts.state = "open";
  else if (json.state === "closed") facts.state = "closed";
  if (typeof json.draft === "boolean") facts.draft = json.draft;
  if (typeof json.mergeable === "boolean") facts.mergeable = json.mergeable;
  const head = isRecord(json.head) ? json.head : undefined;
  if (typeof head?.sha === "string" && head.sha) facts.headSha = head.sha;
  if (typeof head?.ref === "string" && head.ref) facts.headRef = head.ref;
  const title = typeof json.title === "string" ? json.title : undefined;
  return { ...(title ? { title } : {}), ...(Object.keys(facts).length ? { facts } : {}) };
}

/** Latest review per reviewer: any change request wins, then any approval. */
function reviewFromList(items: readonly unknown[]): PrFacts["review"] {
  const latest = new Map<string, string>();
  for (const item of items) {
    if (!isRecord(item) || typeof item.state !== "string") continue;
    const user = isRecord(item.user) && typeof item.user.login === "string" ? item.user.login : "";
    const state = item.state.toUpperCase();
    if (state === "APPROVED" || state === "CHANGES_REQUESTED" || state === "DISMISSED")
      latest.set(user, state);
  }
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED")) return "approved";
  // The reviews were read and no decision stands: none given, or all dismissed.
  return "none";
}

/** A PR named by a JSON result: `{ number, url }` (gh) or `{ number, html_url }` (REST). */
function jsonPr(json: unknown): { ref: PrRef; url: string } | undefined {
  if (!isRecord(json)) return undefined;
  for (const key of ["url", "html_url"]) {
    const value = json[key];
    if (typeof value === "string") {
      const hit = parsePrUrls(value)[0];
      if (hit) return hit;
    }
  }
  return undefined;
}

// ── Any other tool: PR URLs in its input ───────────────────────────────────

function observeInput(input: Record<string, unknown>): Observation[] {
  // pi-job's job_watch polls another tool: `toolCheck: { tool, args }`.
  const check = isRecord(input.toolCheck) ? input.toolCheck : undefined;
  const args = check && isRecord(check.args) ? check.args : undefined;
  const fromArgs = args ? inputRef(args, /pull/i.test(String(check?.tool))) : undefined;
  const observations: Observation[] = fromArgs
    ? [{ ref: fromArgs, url: prUrl(fromArgs), origin: "referenced" }]
    : [];
  for (const hit of parsePrUrls(strings(input).join("\n")))
    observations.push({ ...hit, origin: "referenced" });
  return dedupe(observations);
}

/** String values in `value`, a few levels deep and bounded in total size. */
function strings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (out.join("").length > 64 * 1024 || depth > 4) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, depth + 1, out);
  else if (isRecord(value)) for (const item of Object.values(value)) strings(item, depth + 1, out);
  return out;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** One observation per PR; a created one wins, facts and titles combine. */
function dedupe(observations: Observation[]): Observation[] {
  const byKey = new Map<string, Observation>();
  for (const next of observations) {
    const key =
      `${next.ref.host}/${next.ref.owner}/${next.ref.repo}#${next.ref.number}`.toLowerCase();
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, next);
      continue;
    }
    byKey.set(key, {
      ...prior,
      origin: prior.origin === "created" || next.origin === "created" ? "created" : "referenced",
      ...((next.title ?? prior.title) ? { title: next.title ?? prior.title } : {}),
      ...(prior.facts || next.facts ? { facts: { ...prior.facts, ...next.facts } } : {}),
    });
  }
  return [...byKey.values()];
}
