// Slot 1: composer banners (chrome "bare") drawn as bb's collapsible stack cards,
// one per widget view the session offers.
//
// bb draws the card's header (12px inset, 14px icon, 6px gap) and a collapse
// row under the body, but leaves the body's padding to us. The body matches the
// header: the same 12px inset on every side, and each row keeps a leading
// column as wide as the header's icon, so row text lines up under the title.
//
// The collapse row is a second button that does what clicking the header
// already does, and the card takes no prop to leave it out, so the body hides
// it: the row is the body's next sibling inside bb's region.
import {
  experimental_CollapsibleStackCard as CollapsibleStackCard,
  type ExperimentalCollapsibleStackCardProps,
} from "@get-bb/plugin-sdk/app";
import type { WidgetModel } from "../contract.ts";
import { viewModel } from "../views.ts";
import { useComposerThread, useSession } from "./session.ts";
import { titleText, widgetTitle, WidgetRows } from "./surface.tsx";

type CardIcon = ExperimentalCollapsibleStackCardProps["icon"];

/**
 * Hides bb's collapse row (a `div` holding the "Collapse <title>" chevron button)
 * that follows the body; the header toggles the card instead.
 */
export const HIDE_COLLAPSE_ROW_CLASS = "[&~div:has(>button[aria-label^='Collapse_'])]:hidden";

/** The card body's class: the header's 12px inset on every side, and no collapse row. */
export const STACK_CARD_BODY_CLASS = `p-3 ${HIDE_COLLAPSE_ROW_CLASS}`;

/** The widget views that get a stack card, in order, with bb's icon for each. */
export const WIDGET_CARDS: ReadonlyArray<{ banner: string; view: string; icon: CardIcon }> = [
  { banner: "todos", view: "todo.widget", icon: "ListTodo" },
  { banner: "subagents", view: "subagent.widget", icon: "Bot" },
];

export function WidgetCard({ model, icon }: { model: WidgetModel; icon: CardIcon }) {
  return (
    <CollapsibleStackCard
      label={titleText(model.title)}
      title={widgetTitle(model)}
      icon={icon}
      isActive={model.active !== false}
    >
      <WidgetRows model={model} className={STACK_CARD_BODY_CLASS} />
    </CollapsibleStackCard>
  );
}

/** The banner for one widget view on the composer's thread, while the view has something to show. */
export function widgetBanner(view: string, icon: CardIcon) {
  return function WidgetBanner() {
    const model = viewModel(useSession(useComposerThread()), view, "widget");
    return model ? <WidgetCard model={model} icon={icon} /> : null;
  };
}
