import { describe, expect, it, vi } from "vitest";
import { openUrl, OPEN_TIMEOUT_MS, urlOpener } from "#src/open";

const URL = "https://github.com/acme/web/pull/42";

describe("urlOpener", () => {
  it("uses the platform's opener, and none on Linux without a display", () => {
    expect(urlOpener("darwin", {})).toBe("open");
    expect(urlOpener("win32", {})).toBe("explorer");
    expect(urlOpener("linux", { DISPLAY: ":0" })).toBe("xdg-open");
    expect(urlOpener("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe("xdg-open");
    expect(urlOpener("linux", {})).toBeUndefined();
  });
});

describe("openUrl", () => {
  it("passes the URL as one argument, with no shell in between", async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0 });
    const tricky = "https://example.com/a?b=1&c=$(rm -rf ~)";
    await expect(openUrl(exec, tricky, "xdg-open")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("xdg-open", [tricky], { timeout: OPEN_TIMEOUT_MS });
  });

  it("reports failure when there is no opener, it fails, or the URL is not https", async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0 });
    await expect(openUrl(exec, URL, undefined)).resolves.toBe(false);
    await expect(openUrl(exec, "http://example.com", "open")).resolves.toBe(false);
    await expect(openUrl(exec, "file:///etc/passwd", "open")).resolves.toBe(false);
    expect(exec).not.toHaveBeenCalled();
    await expect(openUrl(vi.fn().mockResolvedValue({ code: 3 }), URL, "open")).resolves.toBe(false);
    await expect(
      openUrl(vi.fn().mockRejectedValue(new Error("ENOENT")), URL, "open"),
    ).resolves.toBe(false);
  });
});
