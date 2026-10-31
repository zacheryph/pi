import { execFile } from "node:child_process";
import type { TerminalInfo } from "./protocol.ts";

export type Run = (command: string, args: string[]) => Promise<void>;

/** Brings a session's terminal to the front. Runs inside the Pi process, which has the terminal's environment. */
export interface TerminalAdapter {
  readonly info: TerminalInfo;
  focus(): Promise<void>;
}

export interface TerminalOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: Run;
}

const TIMEOUT_MS = 5_000;

export const runCommand: Run = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const detail =
        String(stderr || "")
          .trim()
          .split("\n")[0] || error.message;
      reject(new Error(`${command} ${args[0] ?? ""}: ${detail}`.trim()));
    });
  });

/**
 * cmux: `focus-panel` selects the panel's workspace, surface and tab; it does
 * not raise cmux over another app, so macOS also activates the app bundle.
 * The CLI authenticates with the socket capability cmux put in this process's
 * environment, which is why focus runs here rather than in the hub.
 */
export function cmuxAdapter(options: TerminalOptions = {}): TerminalAdapter | undefined {
  const env = options.env ?? process.env;
  const panel = env.CMUX_PANEL_ID || env.CMUX_SURFACE_ID;
  if (!panel) return undefined;
  const run = options.run ?? runCommand;
  const cli = env.CMUX_BUNDLED_CLI_PATH || "cmux";
  const bundle = env.CMUX_BUNDLE_ID || "com.cmuxterm.app";
  const macOS = (options.platform ?? process.platform) === "darwin";
  return {
    info: { kind: "cmux", label: "cmux" },
    async focus() {
      await run(cli, ["focus-panel", "--panel", panel]);
      if (macOS) await run("open", ["-b", bundle]);
    },
  };
}

/** The first adapter that recognizes this process's terminal. */
export function detectTerminal(options: TerminalOptions = {}): TerminalAdapter | undefined {
  return cmuxAdapter(options);
}
