import {
  defineSettings,
  int,
  number,
  type SettingsOf,
} from "../../../packages/pi-foundations/src/settings.ts";

/**
 * Global only (`<agent dir>/stash.json`): the store is shared by every project,
 * so a project file must not shorten retention for everyone else's entries.
 */
export const stashSettings = defineSettings({
  name: "stash",
  scope: "global",
  fields: {
    /** Delete content not read or written for this many days. */
    retentionDays: number({ default: 30, min: 0, exclusiveMin: true }),
    /** Reject entries larger than this. */
    maxEntryBytes: int({ default: 20 * 1024 * 1024, min: 1 }),
    /** Warn in /stash when the store is larger than this. */
    maxStoreBytes: int({ default: 1024 * 1024 * 1024, min: 1 }),
  },
});
export type StashConfig = SettingsOf<typeof stashSettings>;
