/** Shared test helpers. Cleanup and session state change only when a helper is called. */
export { defer, type Cleanup, type Defer } from "#src/cleanup";
export {
  fakeEventBus,
  fakePi,
  shownOutput,
  type CustomEntry,
  type FakeCommand,
  type FakeEventBus,
  type FakePi,
  type FakeTool,
  type ShownOutput,
} from "#src/fake-pi";
export {
  fauxRuntime,
  fauxSession,
  loadResources,
  messageText,
  toolCall,
  toolResults,
  type FauxCall,
  type FauxRequest,
  type FauxRuntimeOptions,
  type FauxSession,
  type FauxSessionOptions,
} from "#src/faux-session";
export { clearSlots, resetSessionTree, slots, withSlot } from "#src/globals";
export { expectBounded, expectPadded, NARROW_WIDTHS, WIDE_TEXT } from "#src/render";
export { settingsDirs, tempDir, writeFiles, type SettingsDirs } from "#src/temp";
export {
  ansiTheme,
  markupTheme,
  plainLines,
  plainTheme,
  stripAnsi,
  type TestTheme,
} from "#src/theme";
export {
  fakeCustomUi,
  fakeTui,
  keybindings,
  type FakeCustomUiOptions,
  type FakeTui,
} from "#src/ui";
export { flushMicrotasks, sleep, tick, waitFor, type WaitOptions } from "#src/wait";
