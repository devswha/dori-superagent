# Lanes on another PC

`dori start <key> --brief FILE --machine <name>` opens a lane on another PC through that PC's
[Ovis](https://github.com/devswha/ovis) HTTP API instead of the local herdr CLI. Status, `send`, the duty
loop (queued delivery, nudges, lost-lane detection) and `done` work for it as for a local lane.

## Setup

Add the PC to `$DORI_HOME/machines.json` (keep it private, mode `0600`):

```json
{
  "old-desktop": { "url": "http://100.64.0.12:7420", "device": "<paired device token>" },
  "lab": { "url": "http://127.0.0.1:7420", "token": "<Ovis token>", "machine": "<Ovis PC id>" }
}
```

- `url` is the Ovis that answers. Without `machine` it is that PC's own Ovis (for example its Tailscale
  address); with `machine` the requests go through this Ovis to one of its remote PCs
  (`/api/machines/<machine>/...`).
- `device` is a paired-device token: start a pairing on that PC (Settings, devices), then
  `curl -si -X POST <url>/api/devices/pair -H 'content-type: application/json' -d '{"code":"<code>","label":"dori"}'`
  and keep the value of the `ovis_device` cookie it sets. It can be revoked from the device list.
  `token` is the Ovis token instead, sent as `Authorization: Bearer`.
- `agent` (optional) is the command a lane runs on that PC (for example `claude`), when it differs from
  this PC's `DORI_AGENT_CMD`. Letters, digits, spaces and `_./=-` only.
- The end-to-end encrypted relay is not used: dori has no client for it, so the PC must be reachable
  over Tailscale or through a local Ovis.

## What happens

- `start` calls `POST /api/workspace/create` (or `/api/tab/create` with `--workspace <remote id>`) with
  `cwd` (`--cwd`, a path on that PC), then types into its shell a few short lines that write the brief
  plus the remote lane rules to `~/.dori-lanes/<key>.brief.md` (as base64, about 1000 characters a line,
  since a terminal cuts text typed ahead of the shell at 4096 characters a line) and run
  `DORI_LANE=<key> $DORI_AGENT_CMD 'Read your brief at ~/.dori-lanes/<key>.brief.md ...'`. It waits up to
  60 s for an agent to show up in the pane, and closes the pane when none does. The shell must be POSIX
  with `base64` (Linux, macOS); Windows PCs are not supported yet.
- Ovis's own `agent` + `first_message` on create is not used: Ovis types a first message only for the
  browser page that asked for it and holds it for any other client, so the brief would never arrive.
- The lane's pane is recorded as `<machine>@<pane id>` (`old-desktop@w3:p1`), so it never collides with
  a local pane. `dori send` accepts that form as well as the lane key.
- Status comes from `GET /api/session`; messages go in with `POST /api/pane/input` and an Enter through
  `/api/pane/keys`; the omo idle-screen check reads `GET /api/pane/read`; `done` calls `/api/pane/close`.
  A PC that cannot be reached is a failed read (`lane-failed`), never a lost lane.
- That PC has no dori, so the lane reports by appending `## REPORT`, `## REPORT waiting` and `## READY`
  entries (READY with `evidence: <link>` lines), each closed by a `## END` line, to
  `~/.dori-lanes/<key>.md` on its own PC. `start` empties that file, so a former lane of the same key
  never reports into the new one. Each duty tick reads it with `GET /api/fs/file` and applies the
  closed entries it has not applied yet through the usual report and ready, so the lead hears about
  it as from a local lane; an entry is counted only after it was applied. A READY without evidence is
  sent back to the lane, and an idle remote lane is nudged to its report file.
- A PC whose file read fails is skipped for the rest of that tick: its lanes are neither marked lost
  nor each made to wait out the request timeout.
- Reviews and merges stay with the lead: the lane names its PR in a REPORT.

Every request carries `x-herdr-machine: 1` and no `Origin`, which is how Ovis admits a non-browser
client's changes.
