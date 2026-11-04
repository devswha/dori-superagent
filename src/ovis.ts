// A lane on another PC, driven through that PC's Ovis HTTP API instead of the local herdr CLI.
// Only routes Ovis already offers are used: workspace/tab create, session, pane input/keys/read/close
// and fs/file. See docs/remote-lanes.md.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentStatus, PaneRef } from "./herdr.ts";

/**
 * One entry of `$DORI_HOME/machines.json`. `device` is a paired-device token (sent as the `ovis_device`
 * cookie), `token` the Ovis token (sent as a Bearer header). `machine` routes through the Ovis at `url`
 * to one of its remote PCs (`/api/machines/<machine>/...`); without it `url` is that PC's own Ovis.
 */
export type MachineConfig = { readonly url: string; readonly token?: string; readonly device?: string; readonly machine?: string };

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const MACHINE_RE = /^[a-z][a-z0-9-]{0,40}$/;

/** A remote lane's pane is stored as `<machine>@<pane id>`, so it never collides with a local pane id. */
export function splitPane(id: string): { machine: string; pane: string } | null {
  const at = id.indexOf("@");
  if (at < 0) return null;
  return { machine: id.slice(0, at), pane: id.slice(at + 1) };
}

export function loadMachines(root: string): Record<string, MachineConfig> {
  const path = join(root, "machines.json");
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const out: Record<string, MachineConfig> = {};
  for (const [name, v] of Object.entries(raw)) {
    const c = v as Partial<MachineConfig>;
    if (!MACHINE_RE.test(name)) throw new Error(`machines.json: machine name ${JSON.stringify(name)} must match ${MACHINE_RE}`);
    if (typeof c.url !== "string" || !/^https?:\/\//.test(c.url)) throw new Error(`machines.json: ${name}.url must be an http(s) URL`);
    if (typeof c.token !== "string" && typeof c.device !== "string") throw new Error(`machines.json: ${name} needs a token or a device token`);
    out[name] = { url: c.url.replace(/\/+$/, ""), token: c.token, device: c.device, machine: c.machine };
  }
  return out;
}

export class OvisError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** The terminal needs a moment to finish a bracketed paste before an Enter is read as a submit. */
const PASTE_SETTLE_MS = 400;
const ENTER_ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;
export class Ovis {
  constructor(
    readonly name: string,
    private readonly config: MachineConfig,
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
    /** how long a started lane's agent may take to show up in its pane, how often that is asked, and the paste settle */
    private readonly timing = { agentTimeoutMs: 60_000, agentEveryMs: 1000, settleMs: PASTE_SETTLE_MS },
  ) {}

  private url(path: string): string {
    const m = this.config.machine;
    return `${this.config.url}/api/${m ? `machines/${encodeURIComponent(m)}/` : ""}${path}`;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    // No Origin header and `x-herdr-machine: 1`: how Ovis admits a non-browser client's mutation.
    const headers: Record<string, string> = { "x-herdr-machine": "1" };
    if (this.config.token) headers["authorization"] = `Bearer ${this.config.token}`;
    if (this.config.device) headers["cookie"] = `ovis_device=${encodeURIComponent(this.config.device)}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchFn(this.url(path), {
      method, headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.ok) return res;
    let code = "http_error";
    let message = `${res.status}`;
    try {
      const e = ((await res.json()) as { error?: { code?: string; message?: string } }).error;
      if (e?.code) code = e.code;
      if (e?.message) message = e.message;
    } catch {
      // not JSON: the status alone says it
    }
    throw new OvisError(res.status, code, `ovis ${this.name} ${method} /api/${path}: ${code}: ${message}`);
  }

  private async json(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
    return (await (await this.call(method, path, body)).json()) as Record<string, unknown>;
  }

  /**
   * Opens a workspace (or a tab in `workspaceId`) on that PC, types `commandLines` into its shell and waits
   * until an agent shows up there. A pane where none does is closed again.
   *
   * Not Ovis's own `agent` + `first_message`: Ovis types a first message only for the browser page that
   * asked for it, and holds it unattended for any other client, so the brief would never arrive.
   */
  async startLane(opts: { label: string; cwd?: string; workspaceId?: string; commandLines: readonly string[] }): Promise<PaneRef> {
    const body = {
      label: opts.label,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.workspaceId ? { workspace_id: opts.workspaceId } : {}),
    };
    const r = await this.json("POST", opts.workspaceId ? "tab/create" : "workspace/create", body);
    const paneId = String(r["pane_id"] ?? "");
    if (!paneId) throw new Error(`ovis ${this.name} did not return a pane id`);
    try {
      for (const line of opts.commandLines) await this.deliver(paneId, line, "shell");
      const deadline = Date.now() + this.timing.agentTimeoutMs;
      for (let st = await this.status(paneId); st === "shell" || st === "gone"; st = await this.status(paneId)) {
        if (st === "gone") throw new Error(`ovis ${this.name}: ${paneId} closed before an agent came up`);
        if (Date.now() >= deadline) throw new Error(`ovis ${this.name}: no agent came up in ${paneId} within ${this.timing.agentTimeoutMs / 1000}s`);
        await Bun.sleep(this.timing.agentEveryMs);
      }
    } catch (e) {
      await this.close(paneId).catch(() => {});
      throw e;
    }
    return { paneId, tabId: "", workspaceId: String(r["workspace_id"] ?? "") };
  }

  async status(paneId: string): Promise<AgentStatus> {
    const r = await this.json("GET", "session");
    const panes = ((r["snapshot"] as Record<string, unknown> | undefined)?.["panes"] ?? []) as Record<string, unknown>[];
    const pane = panes.find((p) => p["pane_id"] === paneId);
    if (!pane) return "gone";
    if (!pane["agent"]) return "shell";
    const s = String(pane["agent_status"] ?? "unknown");
    return (["idle", "working", "blocked", "done"].includes(s) ? s : "unknown") as AgentStatus;
  }

  /** Types the message as one line and presses Enter, as the local fallback does; only the Enter is retried. */
  async deliver(paneId: string, text: string, kind: AgentStatus): Promise<void> {
    // one line whatever the pane runs: a line break typed into a shell would run each line
    const line = text.trim().replace(/\s*\n\s*/g, " / ");
    await this.json("POST", "pane/input", { pane_id: paneId, text: line });
    await Bun.sleep(this.timing.settleMs);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.json("POST", "pane/keys", { pane_id: paneId, keys: ["Enter"] });
        return;
      } catch (err) {
        if (attempt >= ENTER_ATTEMPTS) throw err;
      }
    }
  }

  async read(paneId: string, lines = 80): Promise<string> {
    const q = new URLSearchParams({ pane_id: paneId, source: "recent", lines: String(lines) });
    const r = await this.json("GET", `pane/read?${q}`);
    return String((r["read"] as Record<string, unknown> | undefined)?.["text"] ?? "");
  }

  async close(paneId: string): Promise<void> {
    await this.json("POST", "pane/close", { pane_id: paneId });
  }

  /** A text file on that PC (`~` is its home), or null when there is none yet. */
  async readFile(path: string): Promise<string | null> {
    try {
      return await (await this.call("GET", `fs/file?${new URLSearchParams({ path })}`)).text();
    } catch (e) {
      if (e instanceof OvisError && e.status === 404) return null;
      throw e;
    }
  }
}

export const remoteReportPath = (key: string): string => `~/.dori-lanes/${key}.md`;
export const remoteBriefPath = (key: string): string => `~/.dori-lanes/${key}.brief.md`;

/** Characters of base64 per typed line: text typed before the shell is ready is cut at 4096 per line. */
const KICKOFF_CHUNK = 1000;

/**
 * POSIX shell lines that write the brief to `remoteBriefPath` on that PC and start the agent on it, as a
 * local lane's `omo 'Read your brief at ...'`. The brief travels as base64, so no character in it is ever
 * read by the shell and its line breaks survive being typed, in short lines a terminal never cuts.
 */
export function remoteKickoff(key: string, brief: string, agentCmd: string, shq: (s: string) => string): string[] {
  const file = remoteBriefPath(key).replace(/^~\//, "$HOME/");
  const b64 = `${file}.b64`;
  const data = Buffer.from(brief).toString("base64");
  const kickoff = `Read your brief at ${remoteBriefPath(key)} and execute it. Your lane key is ${key}.`;
  // the report file starts empty, so a READY a former lane of the same key left there is never applied again
  const reports = remoteReportPath(key).replace(/^~\//, "$HOME/");
  const lines = [`mkdir -p "$HOME/.dori-lanes" && : > "${b64}" && : > "${reports}"`];
  for (let at = 0; at < data.length; at += KICKOFF_CHUNK) lines.push(`printf %s ${data.slice(at, at + KICKOFF_CHUNK)} >> "${b64}"`);
  lines.push(`base64 -d < "${b64}" > "${file}" && rm -f "${b64}" && DORI_LANE=${key} ${agentCmd} ${shq(kickoff)}`);
  return lines;
}

export type RemoteEntry = { kind: "report"; status?: "working" | "waiting"; text: string } | { kind: "ready"; text: string; evidence: string[] };

/**
 * Complete entries of a remote lane's report file: each starts with a `## REPORT`, `## REPORT waiting|working`
 * or `## READY` line and ends at a `## END` line; a READY entry names its evidence on `evidence: <link>` lines.
 * An entry still being written (no `## END` yet) is left for the next read. Text outside entries is ignored.
 */
export function parseRemoteReports(text: string): RemoteEntry[] {
  const entries: RemoteEntry[] = [];
  let head: RegExpExecArray | null = null;
  let body: string[] = [];
  const flush = () => {
    if (!head) return;
    if (head[1] === "READY") {
      const evidence = body.map((l) => /^evidence:\s*(\S.*)$/i.exec(l.trim())?.[1]?.trim()).filter((e): e is string => !!e);
      const rest = body.filter((l) => !/^evidence:/i.test(l.trim()));
      entries.push({ kind: "ready", text: rest.join("\n").trim(), evidence });
    } else {
      const status = head[2] as "working" | "waiting" | undefined;
      entries.push({ kind: "report", ...(status ? { status } : {}), text: body.join("\n").trim() });
    }
  };
  for (const line of text.split("\n")) {
    const m = /^## (REPORT|READY)(?: (working|waiting))?\s*$/.exec(line.trimEnd());
    if (m && !(m[1] === "READY" && m[2])) {
      head = m;
      body = [];
    } else if (head && line.trimEnd() === "## END") {
      flush();
      head = null;
    } else if (head) {
      body.push(line);
    }
  }
  return entries;
}
