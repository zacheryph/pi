import { renderBlocks, type Block } from "../../../packages/pi-ui/src/index.ts";
import { plainTheme } from "../../../packages/pi-test-helpers/src/theme.ts";

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

/** Text that follows a `heading` block. */
export function section(blocks: readonly Block[] | undefined, heading: string): string | undefined {
  const list = blocks ?? [];
  const index = list.findIndex((block) => "heading" in block && block.heading === heading);
  const next = list[index + 1];
  return index >= 0 && next && "text" in next ? next.text : undefined;
}
