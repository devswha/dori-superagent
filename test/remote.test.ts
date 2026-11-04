import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { done, dutyTick, Refusal, send, startLane } from "../src/harness.ts";
import { loadMachines, parseRemoteReports } from "../src/ovis.ts";
import { World } from "./fake.ts";

function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("w1:p1", "idle");
  d.store.setRole("lead", "w1:p1");
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.\nThen open a PR.");
  return { w, d, lead, brief };
}

describe("remote lanes (--machine)", () => {
  test("start opens a workspace on that PC through Ovis, writes the brief there and starts omo on it", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { machine: "pc", cwd: "/home/u/repo" });
    expect(lane.paneId).toMatch(/^pc@w9:p\d+$/);
    expect(lane.machine).toBe("pc");
    const pane = w.remote.get(lane.paneId.slice("pc@".length))!;
    expect(pane.cwd).toBe("/home/u/repo");
    expect(pane.label).toBe("fix-login");
    const typed = pane.received;
    expect(pane.ran).toEqual(typed.map(() => "Enter"));
    expect(typed.length).toBeGreaterThan(3);
    for (const line of typed) expect(line.length < 1100 && !line.includes("\n")).toBe(true);
    expect(typed[0]).toBe(`mkdir -p "$HOME/.dori-lanes" && : > "$HOME/.dori-lanes/fix-login.brief.md.b64" && : > "$HOME/.dori-lanes/fix-login.md"`);
    expect(typed.at(-1)).toBe(`base64 -d < "$HOME/.dori-lanes/fix-login.brief.md.b64" > "$HOME/.dori-lanes/fix-login.brief.md" && rm -f "$HOME/.dori-lanes/fix-login.brief.md.b64" && DORI_LANE=fix-login omo 'Read your brief at ~/.dori-lanes/fix-login.brief.md and execute it. Your lane key is fix-login.'`);
    const chunks = typed.slice(1, -1).map((l) => /^printf %s ([A-Za-z0-9+/=]+) >> "\$HOME\/\.dori-lanes\/fix-login\.brief\.md\.b64"$/.exec(l)![1]!);
    const sent = Buffer.from(chunks.join(""), "base64").toString();
    expect(sent).toBe(await Bun.file(lane.brief).text());
    expect(sent).toStartWith("Fix the flaky login test.\nThen open a PR.\n\n## Lane rules");
    expect(sent).toContain("~/.dori-lanes/fix-login.md");
    expect(sent).not.toContain("dori report");
    expect(w.panes.size).toBe(1);
    const create = w.ovisCalls[0]!;
    expect(create.path).toBe("workspace/create");
    expect(create.headers["authorization"]).toBe("Bearer secret");
    expect(create.headers["x-herdr-machine"]).toBe("1");
    expect(create.headers["origin"]).toBeUndefined();
    expect(lead.received).toEqual([`[START fix-login] lane opened in ${lane.paneId}`]);
  });

  test("a given workspace gets a tab; an agent that did not start closes its pane and opens no lane", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "in-tab", brief, { machine: "pc", workspace: "w9" });
    expect(w.ovisCalls[0]!.path).toBe("tab/create");
    expect(w.ovisCalls[0]!.body!["workspace_id"]).toBe("w9");
    w.remoteAgentFails = true;
    await expect(startLane(d, "no-omo", brief, { machine: "pc" })).rejects.toThrow("no agent came up");
    expect(w.ovisCalls.at(-1)!.path).toBe("pane/close");
    expect(d.store.lane("no-omo")).toBeUndefined();
    await expect(startLane(d, "nowhere", brief, { machine: "other" })).rejects.toThrow(Refusal);
  });

  test("send queues for a busy remote lane and types it in with Enter once the duty loop sees it idle", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { machine: "pc" });
    const pane = w.remote.get(lane.paneId.slice("pc@".length))!;
    pane.status = "working";
    pane.received.length = 0;
    pane.ran.length = 0;
    expect(await send(d, "fix-login", "rebase on main\nthen push", "lead")).toBe("QUEUED");
    expect(pane.received).toEqual([]);
    pane.status = "idle";
    expect(await dutyTick(d)).toContainEqual({ pane: lane.paneId, action: "flushed" });
    expect(pane.received).toEqual(["rebase on main / then push"]);
    expect(pane.ran).toEqual(["Enter"]);
  });

  test("the duty loop applies new report-file entries once, through report and ready", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { machine: "pc" });
    const file = "~/.dori-lanes/fix-login.md";
    w.remoteFiles.set(file, "## REPORT\ntests green\n## END\n");
    await dutyTick(d);
    w.remoteFiles.set(file, "## REPORT\ntests green\n## END\n## REPORT waiting\nCI running\n## END\n");
    await dutyTick(d);
    expect(lead.received.slice(1)).toEqual(["[REPORT fix-login] tests green", "[REPORT fix-login WAITING] CI running"]);
    expect(d.store.lane("fix-login")!.status).toBe("waiting");

    w.remoteFiles.set(file, `${w.remoteFiles.get(file)}## READY\nall done\n`);
    expect(await dutyTick(d)).toEqual([]);
    w.remoteFiles.set(file, `${w.remoteFiles.get(file)}evidence: https://github.com/o/r/pull/1\n## END\n`);
    await dutyTick(d);
    await dutyTick(d);
    expect(lead.received.at(-1)).toBe("[READY fix-login] all done\nevidence: https://github.com/o/r/pull/1");
    expect(lead.received).toHaveLength(4);
    expect(d.store.lane("fix-login")!.final!.evidence).toEqual(["https://github.com/o/r/pull/1"]);
    await done(d, "fix-login");
    expect(w.remote.has(lane.paneId.slice("pc@".length))).toBe(false);
  });

  test("a READY without evidence is sent back to the lane, once, and the lane stays open", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { machine: "pc" });
    const pane = w.remote.get(lane.paneId.slice("pc@".length))!;
    w.remoteFiles.set("~/.dori-lanes/fix-login.md", "## READY\ndone, trust me\n## END\n");
    pane.received.length = 0;
    expect(await dutyTick(d)).toContainEqual({ lane: "fix-login", action: "remote-ready-refused" });
    expect(pane.received).toHaveLength(1);
    expect(pane.received[0]).toContain("evidence: <link>");
    pane.received.length = 0;
    await dutyTick(d);
    expect(pane.received).toEqual([]);
    expect(d.store.lane("fix-login")!.log.filter((l) => l.kind === "ready")).toEqual([]);
    expect(d.store.lane("fix-login")!.status).toBe("working");
  });

  test("an unreachable PC is a failed read, never a lost lane", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "fix-login", brief, { machine: "pc" });
    await startLane(d, "second", brief, { machine: "pc" });
    w.remoteDown = true;
    const events = await dutyTick(d);
    expect(events.map((e) => e.action)).toEqual(["pull-failed", "pull-failed", "lane-failed", "lane-failed"]);
    expect(events[1]!.detail).toBe("pc unreachable this tick");
    expect(d.store.lane("fix-login")!.status).toBe("working");
    expect(d.store.lane("second")!.status).toBe("working");
  });

  test("a lane reopened under the same key never gets the former lane's READY again", async () => {
    const { w, d, lead, brief } = setup();
    await startLane(d, "again", brief, { machine: "pc" });
    w.remoteFiles.set("~/.dori-lanes/again.md", "## READY\nold answer\nevidence: https://x/1\n## END\n");
    await dutyTick(d);
    await done(d, "again");
    await startLane(d, "again", brief, { machine: "pc" });
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("again")!.status).toBe("working");
    expect(lead.received.filter((m) => m.startsWith("[READY again]"))).toHaveLength(1);
  });

  test("a pane that closes before its agent comes up is a failed start, not a lane", async () => {
    const { w, d, brief } = setup();
    w.remoteVanishes = true;
    await expect(startLane(d, "vanish", brief, { machine: "pc" })).rejects.toThrow("closed before an agent came up");
    expect(d.store.lane("vanish")).toBeUndefined();
  });

  test("an idle remote lane is nudged to its report file, never to a dori command it does not have", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "quiet", brief, { machine: "pc" });
    const pane = w.remote.get(lane.paneId.slice("pc@".length))!;
    pane.received.length = 0;
    w.clock += 11 * 60_000;
    expect(await dutyTick(d)).toContainEqual({ lane: "quiet", action: "nudge-1" });
    expect(pane.received[0]).toContain("~/.dori-lanes/quiet.md");
    expect(pane.received[0]).not.toContain("dori ready");
  });

  test("dori start --machine goes through the CLI", async () => {
    const { w, d, brief } = setup();
    expect(await main(["start", "cli-lane", "--brief", brief, "--machine", "pc", "--cwd", "/srv/x"], d)).toBe(0);
    expect(d.store.lane("cli-lane")!.paneId).toStartWith("pc@");
    expect(w.ovisCalls[0]!.body!["cwd"]).toBe("/srv/x");
  });
});

describe("report file and machines.json", () => {
  test("entries run from their heading to ## END, an unfinished one is left for later; evidence lines are taken out of a READY's text", () => {
    expect(parseRemoteReports("notes\n## REPORT\nfirst\n\n## END\nstray\n## REPORT waiting\nblocked\n## END\n## READY\nok\nevidence: a\nEvidence:  b \n## READY waiting\nx\n## END\n## REPORT\nstill being writ")).toEqual([
      { kind: "report", text: "first" },
      { kind: "report", status: "waiting", text: "blocked" },
      { kind: "ready", text: "ok\n## READY waiting\nx", evidence: ["a", "b"] },
    ]);
    expect(parseRemoteReports("")).toEqual([]);
  });

  test("machines.json is checked: a name, an http(s) URL and a credential", () => {
    const { d } = setup();
    expect(loadMachines(d.store.root)).toEqual({});
    const write = (v: unknown) => writeFileSync(join(d.store.root, "machines.json"), JSON.stringify(v));
    write({ "old-desktop": { url: "http://100.1.2.3:7420/", device: "dev" } });
    expect(loadMachines(d.store.root)["old-desktop"]!.url).toBe("http://100.1.2.3:7420");
    write({ "Old Desktop": { url: "http://x", token: "t" } });
    expect(() => loadMachines(d.store.root)).toThrow("machine name");
    write({ pc: { url: "x", token: "t" } });
    expect(() => loadMachines(d.store.root)).toThrow("http(s) URL");
    write({ pc: { url: "http://x" } });
    expect(() => loadMachines(d.store.root)).toThrow("token");
  });
});
