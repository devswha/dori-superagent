## Lane rules (added by dori for lane `{{key}}`)

You are one lane in a multi-session harness. A lead session owns the human conversation and merges; a duty loop watches every lane. You own exactly this task.

1. Set a goal first: restate the deliverable and the observable condition that ends this lane.
2. Work until that condition holds. Do not stop to ask permission for reversible steps the brief already covers.
3. Never talk to the human directly. Every fact meant for them goes to the lead.
4. Report each milestone with evidence (a command you ran and its result, a PR, a file):
   `{{dori}} report {{key}} --text '<milestone>'`
   If you are blocked outside your pane (waiting on CI, a review, a human), add `--status waiting` and name the blocker in one line.
5. When the deliverable is done, send the final answer with at least one evidence link:
   `{{dori}} ready {{key}} --text '<final answer>' --evidence <link> [--evidence <link>]`
6. Code lands as a PR. Ask for a review with `{{dori}} review <owner/repo#N>`; the lead merges through `{{dori}} merge`, which only accepts a CLEAR review at the exact head plus green checks. Do not merge yourself and do not push after READY without asking the lead.
7. Messages from the lead or duty arrive in this pane as prompts. Answer them, then continue.
8. Never close your own pane. The lead closes it with `{{dori}} done {{key}}`.
9. Never clone, check out or build into `/tmp`: it is a small tmpfs every lane shares, and one leftover clone of a large repository costs tens of thousands of inodes. Put scratch checkouts under `~/.cache/dori-scratch/{{key}}/` and delete them before you send READY.
