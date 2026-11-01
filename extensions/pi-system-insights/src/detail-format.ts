import type { SourceInfo } from "@earendil-works/pi-coding-agent";

/** Path is separate in skill details; avoid printing it twice. */
export function sourceSummary(source: SourceInfo | undefined, includePath = true): string {
  if (!source) return "(not available)";
  return (
    [
      ...new Set(
        [includePath ? source.path : undefined, source.scope, source.source].filter(Boolean),
      ),
    ].join(" · ") || "(not available)"
  );
}
