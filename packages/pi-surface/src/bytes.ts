import { readDeliverySnapshot, type DeliverySnapshot } from "#src/delivery";

// Byte ceilings and the receiving side's size check. Sizes are UTF-8 bytes as
// they travel, never `String.length`: one "é" is 2 bytes, one emoji 4.

/** Largest view model, as UTF-8 JSON, a collection carries; a larger one becomes an error entry. */
export const MAX_VIEW_BYTES = 256 * 1024;

/**
 * Largest message the bb plugin accepts from a session (`MAX_MESSAGE_BYTES`
 * in `bb-plugin/protocol.ts`). A pi-bb adapter's whole message, framing
 * included, must fit.
 */
export const BB_MESSAGE_BYTES = 2 * 1024 * 1024;

/**
 * Longest line the dashboard hub reads from a reporter (`MAX_LINE_BYTES` in
 * `extensions/pi-dashboard/src/protocol.ts`). A reporter's whole line, framing
 * included, must fit.
 */
export const DASHBOARD_LINE_BYTES = 1024 * 1024;

/** The number of bytes `text` takes as UTF-8, as `TextEncoder` would encode it. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    }
    // Any other unit, a lone surrogate included (encoded as U+FFFD), takes 3.
    else bytes += 3;
  }
  return bytes;
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** What a size-checked read produced: the value, or why there is none. */
export type Decoded<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * One complete received message or line (without its line terminator) as
 * JSON, refused before parsing when it is over `maxBytes` of UTF-8: a string
 * is measured as it would be encoded, bytes by their length. Never throws.
 */
export function decodeJson(data: string | Uint8Array, maxBytes: number): Decoded<unknown> {
  let text: string;
  if (typeof data === "string") {
    // Every UTF-16 unit takes at least one UTF-8 byte, so a long string is refused without counting.
    if (data.length > maxBytes) return { ok: false, error: tooLarge(data.length, maxBytes, true) };
    const bytes = utf8Bytes(data);
    if (bytes > maxBytes) return { ok: false, error: tooLarge(bytes, maxBytes) };
    text = data;
  } else {
    if (data.byteLength > maxBytes)
      return { ok: false, error: tooLarge(data.byteLength, maxBytes) };
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      return { ok: false, error: "Message is not UTF-8." };
    }
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "Message is not JSON." };
  }
}

function tooLarge(bytes: number, maxBytes: number, atLeast = false): string {
  return `Message too large: ${atLeast ? "at least " : ""}${bytes} bytes, over ${maxBytes}.`;
}

/**
 * A received message that is exactly one encoded `DeliverySnapshot`: checked
 * against `maxBytes`, parsed, then read with `readDeliverySnapshot`, which
 * tolerates a newer producer's view kinds. A transport whose message wraps the
 * snapshot in its own envelope uses `decodeJson` and reads the snapshot field.
 */
export function decodeDeliverySnapshot(
  data: string | Uint8Array,
  maxBytes: number,
): Decoded<DeliverySnapshot> {
  const decoded = decodeJson(data, maxBytes);
  if (!decoded.ok) return decoded;
  const snapshot = readDeliverySnapshot(decoded.value);
  return snapshot ? { ok: true, value: snapshot } : { ok: false, error: "Malformed snapshot." };
}
