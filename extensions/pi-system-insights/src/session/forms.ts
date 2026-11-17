import { listViews, onViewChanged, readView, type ActionBus } from "#surface";
import type { Waiting } from "#src/session/status";

// Open questionnaires, observed through surface's public form contract: any
// view of kind `form` on the session's bus (pi-ask's `ask.questions` by
// convention). Nothing here knows pi-ask or listens to its own events.

type Questionnaire = { title?: unknown; openedAt?: unknown; questions?: unknown };

function questionnaires(bus: ActionBus, id: string): Questionnaire[] {
  let model: unknown;
  try {
    model = readView(bus, id);
  } catch {
    // A failing form is the collector's to report; it says nothing about waiting.
    return [];
  }
  const list = (model as { questionnaires?: unknown } | undefined)?.questionnaires;
  return Array.isArray(list)
    ? list.filter((item): item is Questionnaire => !!item && typeof item === "object")
    : [];
}

function title(questionnaire: Questionnaire): unknown {
  if (questionnaire.title) return questionnaire.title;
  const [first] = Array.isArray(questionnaire.questions) ? questionnaire.questions : [];
  return (first as { header?: unknown } | undefined)?.header;
}

/**
 * The oldest questionnaire open in any form view on `bus` but `exclude`, or
 * `undefined` when none is. Reads only: it announces nothing.
 */
export function openForm(bus: ActionBus, exclude: string): Waiting | undefined {
  let oldest: Questionnaire | undefined;
  for (const view of listViews(bus)) {
    if (view.kind !== "form" || view.id === exclude) continue;
    for (const questionnaire of questionnaires(bus, view.id)) {
      const at = questionnaire.openedAt;
      const best = oldest?.openedAt;
      // Each form lists its own oldest first; across forms the earlier `openedAt` wins.
      if (!oldest || (typeof at === "number" && typeof best === "number" && at < best))
        oldest = questionnaire;
    }
  }
  if (!oldest) return undefined;
  const text = title(oldest);
  return typeof text === "string" ? { title: text } : {};
}

/**
 * Calls `changed` after any view on `bus` announces a change, except `ownId`:
 * the observer's own announcements never wake it, so publishing the waiting
 * status cannot loop back into another read. Returns the unsubscribe.
 */
export function watchForms(bus: ActionBus, ownId: string, changed: () => void): () => void {
  return onViewChanged(bus, (id) => {
    if (id !== ownId) changed();
  });
}
