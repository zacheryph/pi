import { defineSettings, int, optional, string, type SettingsOf } from "#foundations/settings";
import { DEFAULT_PORT } from "#src/protocol";

/** Global only (`<agent dir>/dashboard.json`): one hub serves every project. */
export const dashboardSettings = defineSettings({
  name: "dashboard",
  scope: "global",
  fields: {
    port: int({ default: DEFAULT_PORT, min: 1, max: 65_535 }),
    /** Node binary for the hub; defaults to Pi's own runtime. */
    node: optional(string({ trim: true, nonEmpty: true })),
  },
});
export type DashboardConfig = SettingsOf<typeof dashboardSettings>;
