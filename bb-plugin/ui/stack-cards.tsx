// Slot 1: composer banners (chrome "bare") drawn as bb's collapsible stack cards,
// one per widget view the session offers.
//
// bb draws the card's header (12px inset, 14px icon, 6px gap) and the collapse
// row, but leaves the body's padding to us. The body matches the header: the
// same 12px inset on the left, right and top, and each row keeps a leading
// column as wide as the header's icon, so row text lines up under the title.
import {
  experimental_CollapsibleStackCard as CollapsibleStackCard,
  type ExperimentalCollapsibleStackCardProps,
} from "@get-bb/plugin-sdk/app";
import type { WidgetModel } from "../contract.ts";
import { viewModel } from "../views.ts";
import { useComposerThread, useSession } from "./session.ts";
import { titleText, widgetTitle, WidgetRows } from "./surface.tsx";

type CardIcon = ExperimentalCollapsibleStackCardProps["icon"];

/** The card body's padding: the header's 12px inset on three sides. */
export const STACK_CARD_BODY_CLASS = "px-3 pt-3 pb-1";

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
