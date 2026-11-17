// Text cleaning for the session view. Names, titles, tool names and commands are
// user and model text: control characters never reach a consumer.

const MAX_TEXT = 200;

/** Collapses control characters and whitespace to single spaces and caps the length. */
export function cleanText(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  // oxlint-disable-next-line no-control-regex -- Intentionally matches terminal control characters.
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

/** Replaces control characters with a space, trims, and ends a text longer than `max` with `…`. */
export function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/\r\n?/g, "\n")
    // oxlint-disable-next-line no-control-regex -- Intentionally matches terminal control characters.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
