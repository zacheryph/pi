# Roadmap data prototype

A design exploration for expanding `make-it-easy` and `execute-roadmap` with a JSON source of truth and generated Markdown and HTML. This prototype is isolated from the installed skills and extensions.

Start with [design options](design-options.md), then inspect the [example roadmap](generated/community-tool-library.md). Download [the HTML snapshot](generated/community-tool-library.html) and open it in a browser to compare the dependency map and delivery board. GitHub's file viewer displays HTML source.

The community tool library and all completion evidence are fictional. Both visual templates show the same twelve-step roadmap with branching and joining dependencies.

## Run

From the repository root, using Node 24 or later:

```sh
cd docs/prototypes/roadmap-data
node roadmap.mjs validate example.roadmap.json
node roadmap.mjs render example.roadmap.json generated
```

The prototype uses Node built-ins and requires no package installation.

## Contents

- `example.roadmap.json`: complete planning record, stable step IDs, dependencies and illustrative execution evidence.
- `roadmap.schema.json`: JSON Schema for the sample model.
- `roadmap.mjs`: shape and graph validation, derived readiness, Markdown and HTML generation.
- `template.html`: reusable template for the offline visual snapshot.
- `generated/community-tool-library.md`: full generated roadmap with progress and a Mermaid dependency map.
- `generated/community-tool-library.html`: dependency map, delivery board, full planning record and JSON/Markdown downloads.
- `design-options.md`: packaging and storage alternatives, authority boundaries and a suggested migration.

## Boundaries

The HTML is a read-only snapshot. It does not update source files, poll GitHub, run agents or synchronize session todos. Edit JSON and regenerate.

Validation checks schema shape and recorded state: unknown IDs, dependency cycles, prerequisites, the chosen decision and completion evidence. It does not verify that an evidence reference identifies a real commit, merge or deployment.

This fixed schema requires fully populated planning sections. A production version should accept incomplete drafts, use the repository's AJV setup and add narrow mutations with concurrency control. Output files are replaced atomically one at a time, not as a single transaction.

The original exploration exercised schema and graph checks and syntax-checked the generated JavaScript. The saved snapshots and reconstructed generator were checked for matching Markdown and HTML during PR preparation. Repository checks and browser verification could not be rerun without an execution environment.
