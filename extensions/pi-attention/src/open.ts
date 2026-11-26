import { isAttentionUrl } from "#surface";

/** Runs a program with an argument list, never through a shell, as `pi.exec` does. */
export type Exec = (
  command: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<{ code: number }>;

/** How long the platform opener may take before the URL is printed instead. */
export const OPEN_TIMEOUT_MS = 10_000;

/**
 * The program that hands a URL to the desktop's browser, or `undefined` when
 * there is none to use: on Linux and the BSDs without a display, `xdg-open`
 * would fall back to a text browser in the same terminal Pi is drawing in.
 */
export function urlOpener(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (platform === "darwin") return "open";
  if (platform === "win32") return "explorer";
  return env.DISPLAY || env.WAYLAND_DISPLAY ? "xdg-open" : undefined;
}

/**
 * Open an `https:` URL in the user's browser with an argv launch: the URL is
 * one argument, so nothing in it is ever read by a shell. Resolves false when
 * there is no opener, the URL is not `https:`, or the opener fails, so the
 * caller prints the URL instead.
 */
export async function openUrl(
  exec: Exec,
  url: string,
  opener: string | undefined = urlOpener(),
): Promise<boolean> {
  if (!opener || !isAttentionUrl(url)) return false;
  try {
    const { code } = await exec(opener, [url], { timeout: OPEN_TIMEOUT_MS });
    return code === 0;
  } catch {
    return false;
  }
}
