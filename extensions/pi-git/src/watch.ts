/**
 * watch.ts — pull requests the session waits on (`git_pr_watch`).
 *
 * One watch is one item in the session's work host (packages/pi-work): open work keeps the
 * session waiting, and the item's messages wake it. A watch reads its pull request on a timer
 * and compares each reading with the one before it (the baseline). What the agent should act
 * on is reported once, with the head commit it is for:
 *
 *  - checks finished on the head (again after a rerun or a push),
 *  - the head moved,
 *  - the review decision changed, or reviews or comments were added,
 *  - the pull request now conflicts with its base,
 *  - it was merged or closed, which ends the watch.
 *
 * Delivery is the host's: `notify` for a report that leaves the watch open, `complete` for the
 * one that ends it (`until` reached, merged or closed, the timeout, or reads that keep failing).
 *
 * The item persists what is needed to adopt the watch after a reload or restart. The baseline
 * moves while the watch runs, so each change to it is saved through `saveBaseline` (a session
 * entry) and handed back to `adopt`: a restarted watch never repeats a report.
 */
import { errorText } from "#foundations/errors";
import { oneLine } from "#foundations/format";
import { isRecord } from "#foundations/guards";
import type { Json, WorkHost, WorkItem, WorkMessage } from "#work";
import { checksSettled, prKey, prLabel, type PrFacts, type PrRef } from "#src/prs";
import type { Fetched } from "#src/status";

/** The `owner` of every item pi-git opens, and what it adopts after a reload. */
export const WATCH_OWNER = "pi-git";
/** The `kind` of a watch's work item. */
export const WATCH_KIND = "pr";
/** Custom message type of a watch's reports. */
export const WATCH_MESSAGE = "git:pr-watch";
/** Custom entry type of a saved baseline (see `SavedBaseline`). */
export const WATCH_ENTRY = "git:watch";

/** At most this many pull requests are watched in one session. */
export const MAX_WATCHES = 10;
export const DEFAULT_TIMEOUT_SECONDS = 2 * 60 * 60;
export const MIN_TIMEOUT_SECONDS = 60;
export const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
/** This many reads failing in a row end a watch. */
export const MAX_READ_FAILURES = 5;
/** The longest wait between two reads while reads fail. */
const MAX_BACKOFF_MS = 15 * 60_000;
/** An adopted watch reads this soon, to report what happened while nothing was watching. */
const ADOPT_DELAY_MS = 5_000;
const MAX_CHECK_NAMES = 10;

/** `settled`: until checks finish on the head. `merged`: until the PR is merged or closed. */
export type WatchUntil = "settled" | "merged";

/** A reading of the pull request: what `git_pr_status` reads. */
export type Reading = Fetched;

/** What the next reading is compared with. Small on purpose: every change to it is persisted. */
export interface Baseline {
  headSha?: string;
  /** The head and counts of the finished checks already reported; absent while checks run. */
  settled?: string;
  review?: PrFacts["review"];
  mergeable?: boolean;
  comments?: number;
  reviews?: number;
  /** `gh` or `mcp`: the two count comments and reviews differently, so counts are compared within one. */
  via?: "gh" | "mcp";
}

/** A saved baseline: the newest entry per `item` is the one to continue from. */
export interface SavedBaseline {
  v: 1;
  /** The work item's id. */
  item: string;
  baseline: Baseline;
}

export function isSavedBaseline(value: unknown): value is SavedBaseline {
  return (
    isRecord(value) && value.v === 1 && typeof value.item === "string" && isRecord(value.baseline)
  );
}

/** What a watch's work item persists. */
export interface WatchData {
  v: 1;
  /** The session that started the watch: a fork inherits the item, but not the watch. */
  sessionId: string;
  ref: PrRef;
  url: string;
  until: WatchUntil;
  /** Epoch milliseconds. */
  deadline: number;
  /** The `git_pr_watch` call that started it. */
  callId: string;
  baseline: Baseline;
}

function isWatchData(value: unknown): value is WatchData {
  if (!isRecord(value) || value.v !== 1) return false;
  const ref = value.ref;
  return (
    typeof value.sessionId === "string" &&
    isRecord(ref) &&
    typeof ref.host === "string" &&
    typeof ref.owner === "string" &&
    typeof ref.repo === "string" &&
    typeof ref.number === "number" &&
    typeof value.url === "string" &&
    (value.until === "settled" || value.until === "merged") &&
    typeof value.deadline === "number" &&
    typeof value.callId === "string" &&
    isRecord(value.baseline)
  );
}

/** A watch as tools, the snapshot and the dashboard see it. */
export interface WatchView {
  key: string;
  ref: PrRef;
  url: string;
  until: WatchUntil;
  /** Epoch milliseconds. */
  since: number;
  deadline: number;
}

const short = (sha: string | undefined) => (sha ? sha.slice(0, 12) : "unknown");

function settledKey(facts: PrFacts): string | undefined {
  if (!checksSettled(facts) || !facts.checks) return undefined;
  return `${facts.headSha ?? ""}:${facts.checks.passed}/${facts.checks.failed}`;
}

/** The baseline a reading leaves behind. A field the reading does not show keeps its value. */
export function nextBaseline(previous: Baseline | undefined, reading: Reading): Baseline {
  const { facts } = reading;
  const via = reading.source === "gh" ? "gh" : "mcp";
  const sameVia = previous?.via === undefined || previous.via === via;
  const headSha = facts.headSha ?? previous?.headSha;
  // Checks that were not read leave the last report standing; checks still running clear it.
  const settled = facts.checks ? settledKey(facts) : previous?.settled;
  const review = facts.review ?? previous?.review;
  const mergeable = facts.mergeable ?? previous?.mergeable;
  const comments = reading.comments ?? (sameVia ? previous?.comments : undefined);
  const reviews = reading.reviews ?? (sameVia ? previous?.reviews : undefined);
  return {
    ...(headSha ? { headSha } : {}),
    ...(settled ? { settled } : {}),
    ...(review ? { review } : {}),
    ...(mergeable !== undefined ? { mergeable } : {}),
    ...(comments !== undefined ? { comments } : {}),
    ...(reviews !== undefined ? { reviews } : {}),
    via,
  };
}

export type WatchEvent =
  | { type: "ended"; state: "merged" | "closed" }
  | { type: "head"; from: string; to: string }
  | { type: "checks"; headSha?: string; passed: number; failed: number; failedChecks: string[] }
  | { type: "review"; from: string; to: string }
  | { type: "activity"; reviews: number; comments: number }
  | { type: "conflicts" };

/** What changed between the baseline and a reading, in the order it is reported. */
export function diff(baseline: Baseline, reading: Reading): WatchEvent[] {
  const { facts } = reading;
  const events: WatchEvent[] = [];
  if (facts.state === "merged" || facts.state === "closed")
    events.push({ type: "ended", state: facts.state });
  if (baseline.headSha && facts.headSha && baseline.headSha !== facts.headSha)
    events.push({ type: "head", from: baseline.headSha, to: facts.headSha });
  const settled = settledKey(facts);
  if (settled && settled !== baseline.settled && facts.checks)
    events.push({
      type: "checks",
      ...(facts.headSha ? { headSha: facts.headSha } : {}),
      passed: facts.checks.passed,
      failed: facts.checks.failed,
      failedChecks: reading.failedChecks ?? [],
    });
  if (baseline.review && facts.review && baseline.review !== facts.review)
    events.push({ type: "review", from: baseline.review, to: facts.review });
  const sameVia =
    baseline.via === undefined || baseline.via === (reading.source === "gh" ? "gh" : "mcp");
  const more = (before: number | undefined, now: number | undefined) =>
    sameVia && before !== undefined && now !== undefined && now > before ? now - before : 0;
  const reviews = more(baseline.reviews, reading.reviews);
  const comments = more(baseline.comments, reading.comments);
  if (reviews || comments) events.push({ type: "activity", reviews, comments });
  if (facts.mergeable === false && baseline.mergeable !== false && facts.state !== "merged")
    events.push({ type: "conflicts" });
  return events;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "1 failed (lint), 3 passed". Check names come from GitHub: flattened, clipped and capped. */
export function checksText(event: Extract<WatchEvent, { type: "checks" }>): string {
  if (!event.failed) return `all ${event.passed} passed`;
  const names = event.failedChecks.slice(0, MAX_CHECK_NAMES).map((name) => oneLine(name, 80));
  const hidden = event.failedChecks.length - names.length;
  const named = names.length
    ? ` (${names.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""})`
    : "";
  return `${event.failed} failed${named}${event.passed ? `, ${event.passed} passed` : ""}`;
}

function eventText(event: WatchEvent): string {
  switch (event.type) {
    case "ended":
      return event.state === "merged" ? "Merged." : "Closed without merging.";
    case "head":
      return `Head moved from ${short(event.from)} to ${short(event.to)}: someone pushed.`;
    case "checks":
      return `Checks finished on head ${short(event.headSha)}: ${checksText(event)}.`;
    case "review":
      return `Review decision is now ${event.to.replace("_", " ")} (was ${event.from.replace("_", " ")}).`;
    case "activity": {
      const parts = [
        event.reviews ? plural(event.reviews, "new review") : "",
        event.comments ? plural(event.comments, "new comment") : "",
      ].filter(Boolean);
      return `${parts.join(" and ")} since the last report. A reply in a review thread counts as a review, and your own are counted.`;
    }
    case "conflicts":
      return "It now conflicts with its base branch.";
  }
}

const untilText = (until: WatchUntil) =>
  until === "settled" ? "checks finish on its head" : "it is merged or closed";

interface Watch extends WatchView {
  item: WorkItem;
  callId: string;
  baseline: Baseline;
  failures: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Aborts the read in flight. */
  reading: AbortController | undefined;
}

export interface WatchDependencies {
  /** The session's work host; undefined before `session_start` and after shutdown. */
  host(): WorkHost | undefined;
  /**
   * Read the pull request and record what it showed in the ledger. Throws when it cannot be
   * read; an error with `final` set means no later read can work either.
   */
  read(watch: WatchView & { callId: string }, signal: AbortSignal): Promise<Reading>;
  /** Persist a watch's moved baseline. */
  saveBaseline(saved: SavedBaseline): void;
  /** The set of watches changed. */
  onChange(): void;
  /** A watch ended, for any reason. */
  onEnd?(watch: WatchView & { callId: string }): void;
  now(): number;
  intervalMs(): number;
}

/** An error no retry can get past. */
export class FinalReadError extends Error {
  override name = "FinalReadError";
  readonly final = true;
}

/** This session's watches, by pull request key. */
export class PrWatches {
  private readonly deps: WatchDependencies;
  private readonly watches = new Map<string, Watch>();

  constructor(deps: WatchDependencies) {
    this.deps = deps;
  }

  get(key: string): WatchView | undefined {
    const watch = this.watches.get(key);
    return watch ? view(watch) : undefined;
  }

  list(): WatchView[] {
    return [...this.watches.values()].map(view);
  }

  get size(): number {
    return this.watches.size;
  }

  /**
   * Start watching from `reading`, taken just now. Throws when the session has no work host or
   * the item cannot be persisted: a watch that could wake nobody is not started.
   */
  open(input: {
    ref: PrRef;
    url: string;
    until: WatchUntil;
    deadline: number;
    callId: string;
    sessionId: string;
    reading: Reading;
  }): WatchView {
    const host = this.deps.host();
    if (!host) throw new Error("the session's work host is not available");
    const key = prKey(input.ref);
    const baseline = nextBaseline(undefined, input.reading);
    const data: WatchData = {
      v: 1,
      sessionId: input.sessionId,
      ref: input.ref,
      url: input.url,
      until: input.until,
      deadline: input.deadline,
      callId: input.callId,
      baseline,
    };
    const item = host.open({
      owner: WATCH_OWNER,
      kind: WATCH_KIND,
      label: `PR ${input.ref.number} ${input.until === "settled" ? "CI" : "until merged"}`,
      data: data as unknown as Json,
    });
    const watch: Watch = {
      key,
      ref: input.ref,
      url: input.url,
      until: input.until,
      since: item.openedAt,
      deadline: input.deadline,
      item,
      callId: input.callId,
      baseline,
      failures: 0,
      timer: undefined,
      reading: undefined,
    };
    this.watches.set(key, watch);
    this.schedule(watch, this.deps.intervalMs());
    this.deps.onChange();
    return view(watch);
  }

  /**
   * The agent looked at the pull request itself (a second `git_pr_watch`): continue from this
   * reading, so what it already saw, or did, is not reported back to it.
   */
  rebase(key: string, reading: Reading): void {
    const watch = this.watches.get(key);
    if (!watch) return;
    watch.failures = 0;
    this.move(watch, nextBaseline(watch.baseline, reading));
    this.schedule(watch, this.deps.intervalMs());
  }

  /**
   * An item the host offers after a reload or restart: take it over if this session started
   * it. `saved` is the newest baseline saved for it, if any.
   */
  adopt(item: WorkItem, sessionId: string, saved: Baseline | undefined): boolean {
    const data = item.data;
    if (item.kind !== WATCH_KIND || !isWatchData(data) || data.sessionId !== sessionId)
      return false;
    const key = prKey(data.ref);
    if (this.watches.has(key)) return false;
    const watch: Watch = {
      key,
      ref: data.ref,
      url: data.url,
      until: data.until,
      since: item.openedAt,
      deadline: data.deadline,
      item,
      callId: data.callId,
      baseline: saved ?? data.baseline,
      failures: 0,
      timer: undefined,
      reading: undefined,
    };
    this.watches.set(key, watch);
    this.schedule(watch, Math.min(ADOPT_DELAY_MS, this.deps.intervalMs()));
    this.deps.onChange();
    return true;
  }

  /** Stop watching on request: the item is closed without a message. */
  stop(key: string): boolean {
    const watch = this.watches.get(key);
    if (!watch) return false;
    this.drop(watch);
    watch.item.cancel();
    this.deps.onChange();
    return true;
  }

  /** The session is going away. The items stay open for the next instance to adopt. */
  shutdown(): void {
    for (const watch of this.watches.values()) this.halt(watch);
    this.watches.clear();
  }

  private schedule(watch: Watch, delayMs: number): void {
    if (watch.timer) clearTimeout(watch.timer);
    // Never sleep past the deadline: the timeout is reported when it passes.
    const untilDeadline = Math.max(0, watch.deadline - this.deps.now());
    watch.timer = setTimeout(() => void this.tick(watch), Math.min(delayMs, untilDeadline));
    watch.timer.unref?.();
  }

  private current(watch: Watch): boolean {
    return this.watches.get(watch.key) === watch;
  }

  private async tick(watch: Watch): Promise<void> {
    watch.timer = undefined;
    if (!this.current(watch)) return;
    if (this.deps.now() >= watch.deadline) {
      this.end(watch, [
        `Timed out before ${untilText(watch.until)}.`,
        "Read it with git_pr_status, and call git_pr_watch again to keep waiting.",
      ]);
      return;
    }
    const controller = new AbortController();
    watch.reading = controller;
    let reading: Reading;
    try {
      reading = await this.deps.read({ ...view(watch), callId: watch.callId }, controller.signal);
    } catch (error) {
      if (!this.current(watch) || controller.signal.aborted) return;
      watch.reading = undefined;
      watch.failures += 1;
      const final = (error as { final?: unknown } | undefined)?.final === true;
      if (final || watch.failures >= MAX_READ_FAILURES) {
        this.end(watch, [
          final
            ? `Its status can no longer be read: ${oneLine(errorText(error), 300)}`
            : `Its status could not be read ${watch.failures} times in a row: ${oneLine(errorText(error), 300)}`,
          "Call git_pr_watch again once it can be read.",
        ]);
        return;
      }
      this.schedule(watch, Math.min(this.deps.intervalMs() * 2 ** watch.failures, MAX_BACKOFF_MS));
      return;
    }
    if (!this.current(watch) || controller.signal.aborted) return;
    watch.reading = undefined;
    watch.failures = 0;
    const all = diff(watch.baseline, reading);
    // Once it is merged or closed nothing else about it needs the agent.
    const over = all.filter((event) => event.type === "ended");
    const events = over.length ? over : all;
    const lines = events.map(eventText);
    const ended =
      events.some((event) => event.type === "ended") ||
      (watch.until === "settled" && events.some((event) => event.type === "checks"));
    if (ended) {
      this.end(watch, lines, events, reading.facts.headSha);
      return;
    }
    this.move(watch, nextBaseline(watch.baseline, reading));
    if (events.length)
      watch.item.notify(
        this.message(watch, [...lines, `Still watching until ${untilText(watch.until)}.`], {
          events,
          headSha: reading.facts.headSha,
          ended: false,
        }),
      );
    this.schedule(watch, this.deps.intervalMs());
  }

  /** Replace the baseline, saving it when it changed. A failed save only costs a repeat report. */
  private move(watch: Watch, baseline: Baseline): void {
    const changed = JSON.stringify(baseline) !== JSON.stringify(watch.baseline);
    watch.baseline = baseline;
    if (!changed) return;
    try {
      this.deps.saveBaseline({ v: 1, item: watch.item.id, baseline });
    } catch {
      // The watch itself goes on.
    }
  }

  private message(
    watch: Watch,
    lines: readonly string[],
    details: { events: WatchEvent[]; headSha?: string; ended: boolean },
  ): WorkMessage {
    return {
      customType: WATCH_MESSAGE,
      content: [`Pull request ${prLabel(watch.ref)}:`, ...lines, watch.url].join("\n"),
      details: {
        key: watch.key,
        url: watch.url,
        until: watch.until,
        ended: details.ended,
        ...(details.headSha ? { headSha: details.headSha } : {}),
        events: details.events as unknown as Json,
      },
    };
  }

  /** End the watch with its last report. */
  private end(
    watch: Watch,
    lines: readonly string[],
    events: WatchEvent[] = [],
    headSha?: string,
  ): void {
    this.drop(watch);
    watch.item.complete(
      this.message(watch, [...lines, "The watch has ended."], { events, headSha, ended: true }),
    );
    this.deps.onChange();
  }

  private halt(watch: Watch): void {
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = undefined;
    watch.reading?.abort();
    watch.reading = undefined;
  }

  private drop(watch: Watch): void {
    this.halt(watch);
    this.watches.delete(watch.key);
    this.deps.onEnd?.({ ...view(watch), callId: watch.callId });
  }
}

function view(watch: Watch): WatchView {
  const { key, ref, url, until, since, deadline } = watch;
  return { key, ref, url, until, since, deadline };
}

/** "watching until checks finish on its head (45m left)". */
export function describeWatch(watch: Pick<WatchView, "until" | "deadline">, now: number): string {
  const left = Math.max(0, Math.round((watch.deadline - now) / 60_000));
  return `watching until ${untilText(watch.until)} (${left}m left)`;
}
