/**
 * pi-attention: the status hint and the /attention list. Nothing in the bundle
 * publishes an attention view yet, so the scenario defines one with the items
 * a review handoff and todo findings would raise.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineScenario, ENABLE_ENV } from "#scripted-model/scenario";
import { actionRegistry, viewRegistry, type AttentionItem } from "#surface";

const scripted = defineScenario({
  title: "queue-retries",
  replies: [["Handed acme/api#42 to you for review and armed a watch."]],
});

const MINUTE = 60_000;

function items(now: number): AttentionItem[] {
  return [
    {
      id: "pr:github.com/acme/api#42",
      rev: "a13c90e",
      category: "review",
      title: "Review acme/api#42",
      reason: "Queue retries · draft at a13c90e",
      state: "ready",
      since: now - 12 * MINUTE,
      link: { url: "https://github.com/acme/api/pull/42", label: "acme/api#42" },
      dismiss: { action: "scenario.attention-dismiss", args: { id: "pr:github.com/acme/api#42" } },
    },
    {
      id: "task:backoff",
      category: "findings",
      title: "2 unreviewed findings",
      reason: "backoff · dead-letter",
      state: "ready",
      since: now - 4 * MINUTE,
      open: { action: "scenario.attention-open", args: { id: "backoff" } },
    },
    {
      id: "pr:github.com/acme/api#38",
      category: "review",
      title: "acme/api#38",
      reason: "Pushed since you were asked",
      state: "stale",
      since: now - 3 * 60 * MINUTE,
      link: { url: "https://github.com/acme/api/pull/38", label: "acme/api#38" },
    },
  ];
}

export default function attentionScenario(pi: ExtensionAPI): void {
  scripted(pi);
  if (process.env[ENABLE_ENV] !== "1") return;
  let dispose = () => {};
  pi.on("session_start", () => {
    dispose();
    const views = viewRegistry(pi.events);
    const actions = actionRegistry(pi.events);
    const owed = items(Date.now());
    views.define({
      id: "scenario.attention",
      kind: "attention",
      title: "Scenario",
      model: () => ({ items: owed, total: owed.length }),
    });
    actions.define({ id: "scenario.attention-dismiss", title: "Dismiss", handler: () => {} });
    actions.define({ id: "scenario.attention-open", title: "Open", handler: () => {} });
    dispose = () => {
      views.dispose();
      actions.dispose();
    };
  });
  pi.on("session_shutdown", () => dispose());
}
