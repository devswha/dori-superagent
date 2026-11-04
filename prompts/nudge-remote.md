[duty -> {{key}}] You have been idle for {{minutes}} minutes with no READY on record.
- If the deliverable is done: append a `## READY` entry (final answer, `evidence: <link>` lines, then `## END`) to `{{reports}}`.
- If you are blocked outside this pane: append a `## REPORT waiting` entry naming the blocker, then `## END`, to `{{reports}}`.
- Otherwise continue the work now.
