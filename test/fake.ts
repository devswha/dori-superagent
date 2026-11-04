import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Refusal, type Deps } from "../src/harness.ts";
import { Herdr, type AgentStatus, type Exec } from "../src/herdr.ts";
import { Ovis, type Fetch } from "../src/ovis.ts";
import { Store, type HostLoad } from "../src/store.ts";
import type { DutyCounts, TelemetryEvent, Usage } from "../src/telemetry.ts";

/** `screen` is what `pane read` returns; undefined makes the read fail. */
type Pane = { status: AgentStatus; received: string[]; ran: string[]; screen?: string | undefined };

export class World {
  panes = new Map<string, Pane>();
  calls: { cmd: string; argv: readonly string[] }[] = [];
  clock = 1_000_000;
  host: HostLoad = { load1: 1, cores: 8, memFreePct: 50 };
  next = 1;
  /** pane id -> herdr error text returned by `agent prompt` (exit 1) */
  promptFails = new Map<string, string>();
  /** number of upcoming `pane send-keys` calls that fail (exit 1) */
  keyFails = 0;
  gh: (argv: readonly string[]) => { code: number; stdout: string } = () => ({ code: 1, stdout: "" });
  usage: TelemetryEvent[] = [];
  dutyCounts: DutyCounts[] = [];
  touches = 0;
  recorder: Usage = {
    touch: () => { this.touches++; },
    record: (e) => { this.usage.push(e); },
    duty: (c) => { this.dutyCounts.push(c); },
    flush: async () => {},
  };
  reviewer: (argv: readonly string[]) => { code: number; stdout: string } = () => ({ code: 0, stdout: "VERDICT: CLEAR" });

  /** The one remote PC, `pc`, as its Ovis answers: its panes, its files and every request it got. */
  remote = new Map<string, Pane & { label?: string; cwd?: string }>();
  remoteFiles = new Map<string, string>();
  ovisCalls: { method: string; path: string; headers: Record<string, string>; body?: Record<string, unknown> }[] = [];
  /** set: the command typed into a created pane brings up no agent */
  remoteAgentFails = false;
  /** set: a created pane closes as soon as it is typed into */
  remoteVanishes = false;
  /** set: the PC cannot be reached at all */
  remoteDown = false;

  ovisFetch: Fetch = async (url, init) => {
    if (this.remoteDown) throw new TypeError("fetch failed: connection refused");
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\//, "");
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    this.ovisCalls.push({ method: String(init.method), path, headers: { ...(init.headers as Record<string, string>) }, ...(body ? { body } : {}) });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (path === "workspace/create" || path === "tab/create") {
      const id = `w9:p${++this.next}`;
      this.remote.set(id, { status: "shell", received: [], ran: [], label: String(body!.label), ...(body!.cwd ? { cwd: String(body!.cwd) } : {}) });
      return json({ workspace_id: "w9", pane_id: id, agent_started: false });
    }
    if (path === "session") {
      return json({ snapshot: { panes: [...this.remote].map(([pane_id, p]) => ({ pane_id, agent: p.status === "shell" ? null : "omo", agent_status: p.status })) } });
    }
    if (path === "fs/file") {
      const file = this.remoteFiles.get(u.searchParams.get("path") ?? "");
      return file === undefined ? json({ error: { code: "not_found", message: "no readable file at that path" } }, 404) : new Response(file);
    }
    const id = String(body?.["pane_id"] ?? u.searchParams.get("pane_id"));
    const pane = this.remote.get(id);
    if (!pane) return json({ error: { code: "pane_not_found", message: id } }, 404);
    if (path === "pane/input") { pane.received.push(String(body!.text)); return json({ ok: true }); }
    if (path === "pane/keys") {
      pane.ran.push((body!.keys as string[]).join(" "));
      const truncated = /: > "\$HOME\/\.dori-lanes\/([a-z0-9-]+)\.md"/.exec(pane.received.at(-1) ?? "");
      if (truncated) this.remoteFiles.set(`~/.dori-lanes/${truncated[1]}.md`, "");
      if (this.remoteVanishes && pane.received.at(-1)?.includes("Read your brief")) this.remote.delete(id);
      if (pane.status === "shell" && !this.remoteAgentFails && pane.received.at(-1)?.includes(" omo ")) pane.status = "idle";
      return json({ ok: true });
    }
    if (path === "pane/read") return json({ read: { text: pane.screen ?? "" } });
    if (path === "pane/close") { this.remote.delete(id); return json({ ok: true }); }
    return json({ error: { code: "not_found", message: path } }, 404);
  };

  addPane(id: string, status: AgentStatus = "idle"): Pane {
    const p = { status, received: [], ran: [] };
    this.panes.set(id, p);
    return p;
  }

  exec: Exec = async (cmd, argv) => {
    this.calls.push({ cmd, argv });
    if (cmd === "gh") return { ...this.gh(argv), stderr: "" };
    if (cmd !== "herdr") return { ...this.reviewer(argv), stderr: "" };
    const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
    const [group, verb, id] = argv;
    if ((group === "tab" || group === "workspace") && verb === "create") {
      const pane = `w1:p${++this.next}`;
      this.addPane(pane, "shell");
      return ok({ root_pane: { pane_id: pane, tab_id: `w1:t${this.next}`, workspace_id: "w1" } });
    }
    if (group === "pane" && verb === "split") {
      const pane = `w1:p${++this.next}`;
      this.addPane(pane, "shell");
      return ok({ pane: { pane_id: pane, tab_id: "w1:t1", workspace_id: "w1" } });
    }
    const pane = id ? this.panes.get(id) : undefined;
    if (!pane) return { code: 1, stdout: "", stderr: `pane_not_found ${id}` };
    if (group === "pane" && verb === "get") {
      return ok({ pane: { pane_id: id, agent: pane.status === "shell" ? null : "pi", agent_status: pane.status } });
    }
    if (group === "pane" && verb === "read") {
      return pane.screen === undefined ? { code: 1, stdout: "", stderr: "read failed" } : { code: 0, stdout: pane.screen, stderr: "" };
    }
    if (group === "pane" && verb === "run") { pane.ran.push(String(argv[3])); return ok({}); }
    if (group === "pane" && verb === "send-text") { pane.received.push(String(argv[3])); return ok({}); }
    if (group === "pane" && verb === "send-keys") {
      if (this.keyFails > 0) { this.keyFails--; return { code: 1, stdout: "", stderr: "key press failed" }; }
      return ok({});
    }
    if (group === "agent" && verb === "prompt") {
      const fail = this.promptFails.get(id!);
      if (fail) return { code: 1, stdout: "", stderr: fail };
      pane.received.push(String(argv[3]));
      return ok({});
    }
    if (group === "pane" && verb === "close") { this.panes.delete(id!); return ok({}); }
    return { code: 1, stdout: "", stderr: `unhandled ${argv.join(" ")}` };
  };

  deps(): Deps {
    return {
      store: new Store(mkdtempSync(join(tmpdir(), "dori-test-"))),
      herdr: new Herdr(this.exec, undefined),
      exec: this.exec,
      now: () => this.clock,
      agentCmd: "omo",
      doriCmd: "dori",
      host: () => this.host,
      usage: this.recorder,
      machine: (name) => {
        if (name !== "pc") throw new Refusal(`no machine ${name}`);
        return new Ovis(name, { url: "http://pc.test:7420", token: "secret" }, this.ovisFetch, { agentTimeoutMs: 50, agentEveryMs: 5, settleMs: 1 });
      },
    };
  }
}
