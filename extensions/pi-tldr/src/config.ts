import {
  bool,
  defineSettings,
  string,
  type SettingsOf,
} from "../../../packages/pi-foundations/src/settings.ts";

/** Project settings override global settings. No configuration is written implicitly. */
export const tldrSettings = defineSettings({
  name: "tldr",
  scope: "layered",
  fields: {
    /** auto prefers the most recent available Haiku, then Luna. */
    model: string({ default: "auto", trim: true, nonEmpty: true }),
    /** Controls automatic session naming (Pi manages the terminal title). */
    setSessionName: bool({ default: true }),
  },
});
export type TldrConfig = SettingsOf<typeof tldrSettings>;
