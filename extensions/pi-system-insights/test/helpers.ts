import { renderBlocks, type Block } from "#ui";
import { plainTheme } from "#test-helpers";

const identity = plainTheme;

/** Plain rendered detail, wide enough that nothing wraps. */
export function detailText(blocks: readonly Block[] | undefined): string {
  return blocks ? renderBlocks(blocks, 1000, identity).join("\n") : "";
}

/** Value of an aligned `fields` row. */
export function field(blocks: readonly Block[] | undefined, label: string): string | undefined {
  for (const block of blocks ?? [])
    if ("fields" in block) {
      const found = block.fields.find(([name]) => name === label);
      if (found) return typeof found[1] === "string" ? found[1] : JSON.stringify(found[1]);
    }
  return undefined;
}

/** The Pi events the `system.session` observer handles, in registration order. */
export const SESSION_EVENTS = [
  "session_start",
  "session_shutdown",
  "session_info_changed",
  "model_select",
  "thinking_level_select",
  "session_tree",
  "message_end",
  "turn_end",
  "agent_start",
  "agent_settled",
  "tool_execution_start",
  "tool_execution_end",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "ui_prompt_start",
  "ui_prompt_end",
];

/** Text that follows a `heading` block. */
export function section(blocks: readonly Block[] | undefined, heading: string): string | undefined {
  const list = blocks ?? [];
  const index = list.findIndex((block) => "heading" in block && block.heading === heading);
  const next = list[index + 1];
  return index >= 0 && next && "text" in next ? next.text : undefined;
}
