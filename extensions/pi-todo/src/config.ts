import { bool, defineSettings, int, oneOf, type SettingsOf } from "#foundations/settings";

/** Same layering as subagents, without requiring its package to be installed. */
export const todoSettings = defineSettings({
  name: "todo",
  scope: "layered",
  writable: true,
  fields: {
    widget: bool({ default: true }),
    maxVisible: int({ default: 5, min: 1, max: 12 }),
    showCompleted: bool({ default: true }),
    singleActive: bool({ default: false }),
    confirmClear: bool({ default: true }),
    contextSync: oneOf(["changes", "off"], { default: "changes" }),
    /** Let a subagent with a `ledger` claim add prerequisites to tasks it does not hold. */
    childPrerequisites: bool({ default: true }),
  },
});
export type TodoConfig = SettingsOf<typeof todoSettings>;
