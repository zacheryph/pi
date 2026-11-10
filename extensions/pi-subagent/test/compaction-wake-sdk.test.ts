import type { AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { gated } from "./characterization/harness.ts";
import { offlineAgentDir, realChildSession } from "./helpers/sdk.ts";

// A wake run (roadmap step 9) prompts the child's session; Pi refuses a prompt while a manual
// compaction runs. A child extension can start one (`ctx.compact()`), and the wake can arrive
// while it is under way. The run waits for the compaction to end and then prompts.

/** A child with some history, then a compaction held open at its summary request. */
async function compactingChild() {
  const dir = offlineAgentDir({
    files: {
      "settings.json": {
        extensions: [],
        compaction: { enabled: false, keepRecentTokens: 1 },
        retry: { enabled: false },
      },
    },
  });
  const { session, faux } = await realChildSession(dir, {
    type: "general-purpose",
    provider: "compaction",
  });
  faux.setResponses([
    fauxAssistantMessage("First."),
    fauxAssistantMessage("Second."),
    fauxAssistantMessage("Third."),
  ]);
  await session.runTurnLoop("one", {});
  await session.resumeTurnLoop("two", {});
  await session.resumeTurnLoop("three", {});

  // Whichever request carries the wake prompt is the run's; the others summarize.
  const summary = gated(fauxAssistantMessage("SUMMARY"));
  const prompted: string[] = [];
  const answer = (context: Context, options?: SimpleStreamOptions) => {
    if (!JSON.stringify(context.messages.at(-1)).includes("wake")) {
      return (summary.step as (c: Context, o?: SimpleStreamOptions) => Promise<AssistantMessage>)(
        context,
        options,
      );
    }
    prompted.push("wake");
    return fauxAssistantMessage("Answered after the compaction.");
  };
  faux.setResponses(Array.from({ length: 10 }, () => answer));
  const compacting = session.session.compact();
  await summary.started;
  expect(session.session.isCompacting).toBe(true);
  return { session, summary, compacting, prompted };
}

it("a run that begins during a compaction waits for it and then runs", async () => {
  const { session, summary, compacting, prompted } = await compactingChild();
  // What the wait is for: Pi refuses a prompt while a compaction runs.
  await expect(session.session.prompt("now")).rejects.toThrow(/compaction is in progress/);

  let finished = false;
  const run = session.resumeTurnLoop("wake", {}).then((result) => {
    finished = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(finished).toBe(false); // waiting, not failed
  expect(prompted).toEqual([]);

  summary.release();
  await compacting;
  const result = await run;
  expect(result.responseText).toBe("Answered after the compaction.");
  expect(prompted).toEqual(["wake"]);
});

it("a run stopped while it waits for the compaction never prompts", async () => {
  const { session, compacting, prompted } = await compactingChild();
  const stop = new AbortController();
  const run = session.resumeTurnLoop("wake", { signal: stop.signal });
  await new Promise((resolve) => setTimeout(resolve, 50));
  stop.abort(); // the stop cuts the compaction short too
  await compacting.catch(() => {});
  await run;
  expect(prompted).toEqual([]);
});
