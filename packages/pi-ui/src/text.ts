/** Adapted from this bundle's MIT-licensed browser sanitizers; see ../LICENSE. */

/** Normalize untrusted plain text before styling, wrapping or truncation. */
export function sanitizeText(text: string): string {
  return (
    text
      .replace(/\r\n?|[\u2028\u2029]/g, "\n")
      // oxlint-disable-next-line no-control-regex -- Consume string commands, including incomplete and C1 forms, with their payloads.
      .replace(/(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
      // oxlint-disable-next-line no-control-regex -- CSI, including C1 CSI.
      .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
      // oxlint-disable-next-line no-control-regex -- Other ESC commands.
      .replace(/\x1b[ -/]*[0-~]/g, "")
      // oxlint-disable-next-line no-control-regex -- Unsafe terminal controls and directional formatting marks.
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\t/g, "    ")
  );
}

/** Single-line counterpart; limits belong to the consumer and apply after normalization. */
export function sanitizeLine(text: string): string {
  return sanitizeText(text).replace(/\n/g, " ");
}

/** Clip a trusted, already styled row without stripping ANSI or Pi's cursor marker. */
export function firstPhysicalLine(text: string): string {
  return text.split(/[\r\n\v\f\u2028\u2029]/, 1)[0] ?? "";
}
