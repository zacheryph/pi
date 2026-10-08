import type { SourceInfo } from "@earendil-works/pi-coding-agent";

/** Align values and continuation lines without changing field text. */
export function detailFields(fields: readonly (readonly [label: string, value: string])[]): string[] {
  const width = Math.max(...fields.map(([label]) => label.length)) + 2;
  return fields.map(([label, value]) => {
    const [first, ...rest] = value.split(/\r\n|\n|\r/);
    return `${`${label}:`.padEnd(width)}${first}${rest.map((line) => `\n${" ".repeat(width)}${line}`).join("")}`;
  });
}

/** Path is separate in skill details; avoid printing it twice. */
export function sourceSummary(source: SourceInfo | undefined, includePath = true): string {
  if (!source) return "(not available)";
  return [...new Set([includePath ? source.path : undefined, source.scope, source.source].filter(Boolean))].join(" · ") || "(not available)";
}
