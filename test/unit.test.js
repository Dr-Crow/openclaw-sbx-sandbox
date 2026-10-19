import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildCreateArgs, buildExecArgs, createBackendFactory, createBackendManager } from "../src/backend.js";
import { buildSandboxName } from "../src/cli.js";
import { resolveConfig } from "../src/config.js";

// A fake `sbx`: records argv to $FAKE_SBX_LOG and keeps its sandbox list in $FAKE_SBX_STATE.
function fakeSbx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-sbx-"));
  const bin = path.join(dir, "sbx");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> "${dir}/log"
case "$1" in
  ls) if [ -f "${dir}/names" ]; then printf '['; sep=''; while read n; do printf '%s{"name":"%s","status":"running"}' "$sep" "$n"; sep=','; done < "${dir}/names"; printf ']\\n'; else echo '[]'; fi ;;
  create) while [ $# -gt 0 ]; do [ "$1" = "--name" ] && echo "$2" >> "${dir}/names"; shift; done ;;
  rm) ;;
  exec) shift; [ "$1" = "-i" ] && shift; [ "$1" = "-t" ] && shift; echo "exec-ok" ;;
esac
`,
    { mode: 0o755 },
  );
  return { dir, bin, log: () => (fs.existsSync(`${dir}/log`) ? fs.readFileSync(`${dir}/log`, "utf8").trim().split("\n") : []) };
}

const sdk = {
  sanitizeEnvVars: (env) => ({ allowed: { SAFE: env.SAFE ?? "1" } }),
  createRemoteShellSandboxFsBridge: ({ runtime }) => ({ bridgeFor: runtime.id }),
};

test("config: defaults, validation, unknown keys", () => {
  const c = resolveConfig(undefined);
  assert.equal(c.command, "sbx");
  assert.equal(c.agent, "shell");
  assert.equal(c.pull, "missing");
  assert.equal(c.timeoutMs, 120_000);
  assert.deepEqual(c.kits, []);
  assert.throws(() => resolveConfig({ pull: "sometimes" }), /pull must be/);
  assert.throws(() => resolveConfig({ bogus: 1 }), /unknown option "bogus"/);
  assert.throws(() => resolveConfig({ cpus: 0 }), /cpus/);
  assert.throws(() => resolveConfig({ memory: "lots" }), /memory/);
  assert.throws(() => resolveConfig({ kits: [""] }), /kits\[0\]/);
  assert.equal(resolveConfig({ timeoutSeconds: 5 }).timeoutMs, 5000);
});

test("sandbox name is stable, sbx-safe, and distinct per scope", () => {
  const a = buildSandboxName("agent:main:Session/ONE");
  assert.match(a, /^openclaw-[a-z0-9-]+-[0-9a-f]{8}$/);
  assert.equal(a, buildSandboxName("agent:main:Session/ONE"));
  assert.notEqual(a, buildSandboxName("agent:main:Session/TWO"));
  assert.match(buildSandboxName(""), /^openclaw-session-[0-9a-f]{8}$/);
  assert.ok(buildSandboxName("x".repeat(500)).length < 60);
});

test("exec args: pty, env, PATH handling", () => {
  const args = buildExecArgs({
    sandboxName: "sb", command: "echo hi", workdir: "/w", env: { A: "1", PATH: "/opt/bin" }, usePty: true,
  });
  assert.deepEqual(args.slice(0, 4), ["exec", "-i", "-t", "-w"]);
  assert.ok(args.includes("A=1"));
  assert.ok(args.includes("OPENCLAW_PREPEND_PATH=/opt/bin"));
  assert.ok(!args.some((a) => a === "PATH=/opt/bin"));
  assert.equal(args.at(-4), "sb");
  assert.match(args.at(-1), /^export PATH=.*echo hi$/);
  const plain = buildExecArgs({ sandboxName: "sb", command: "ls", workdir: "/w", env: {}, usePty: false });
  assert.deepEqual(plain, ["exec", "-i", "-w", "/w", "sb", "/bin/sh", "-lc", "ls"]);
});

test("create args: access modes, extras", () => {
  const base = { workspaceDir: "/ws", agentWorkspaceDir: "/ws" };
  const cfg = resolveConfig({ agent: "shell", cpus: 2, memory: "4g", kits: ["./k"], staticMcp: ["a", "b"], template: "img:1" });
  const rw = buildCreateArgs({ config: cfg, sandboxName: "n", ...base, workspaceAccess: "rw" });
  assert.deepEqual(rw.slice(0, 3), ["create", "shell", "/ws"]);
  for (const pair of [["--cpus", "2"], ["--memory", "4g"], ["--kit", "./k"], ["--static-mcp", "a,b"], ["--template", "img:1"], ["--pull", "missing"]]) {
    const i = rw.indexOf(pair[0]);
    assert.ok(i >= 0 && rw[i + 1] === pair[1], pair.join(" "));
  }
  const ro = buildCreateArgs({ config: resolveConfig({}), sandboxName: "n", workspaceDir: "/ws", agentWorkspaceDir: "/agent", workspaceAccess: "ro" });
  assert.deepEqual(ro.slice(2, 4), ["/ws:ro", "/agent:ro"]);
  const none = buildCreateArgs({ config: resolveConfig({}), sandboxName: "n", ...base, workspaceAccess: "none" });
  assert.equal(none[2], "--name");
});

test("factory: creates once, reuses, execs via sbx, rejects binds", async () => {
  const fake = fakeSbx();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  fs.rmSync(ws, { recursive: true }); // must be created by the backend
  const config = resolveConfig({ command: fake.bin });
  const factory = createBackendFactory({ config, sdk });
  const params = { scopeKey: "session:t1", workspaceDir: ws, agentWorkspaceDir: ws, cfg: { workspaceAccess: "rw", docker: { env: {} } } };

  await assert.rejects(factory({ ...params, cfg: { ...params.cfg, docker: { binds: ["/a:/b"] } } }), /does not support/);

  const backend = await factory(params);
  assert.equal(backend.id, "sbx");
  const spec = await backend.buildExecSpec({ command: "uname -r", env: {}, usePty: false });
  assert.equal(spec.argv[0], fake.bin);
  assert.deepEqual(spec.env, { SAFE: "1" });
  assert.equal(spec.stdinMode, "pipe-open");
  assert.ok(fs.existsSync(ws), "workspace dir created");
  await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
  const creates = fake.log().filter((l) => l.startsWith("create "));
  assert.equal(creates.length, 1, "created exactly once");
  assert.ok(creates[0].includes(`--name ${backend.runtimeId}`));

  const r = await backend.runRemoteShellScript({ script: "echo $1", args: ["x"], stdin: "in" });
  assert.equal(r.code, 0);
  assert.match(r.stdout.toString(), /exec-ok/);
  assert.deepEqual(backend.createFsBridge({ sandbox: {} }), { bridgeFor: "sbx" });
});

test("factory: concurrent first calls create once", async () => {
  const fake = fakeSbx();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const backend = await createBackendFactory({ config: resolveConfig({ command: fake.bin }), sdk })({
    scopeKey: "c", workspaceDir: ws, agentWorkspaceDir: ws, cfg: { workspaceAccess: "rw", docker: {} },
  });
  await Promise.all([1, 2, 3, 4].map(() => backend.buildExecSpec({ command: "true", env: {}, usePty: false })));
  assert.equal(fake.log().filter((l) => l.startsWith("create ")).length, 1);
});

test("factory: create failure surfaces stderr and retries next call", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fail-sbx-"));
  const bin = path.join(dir, "sbx");
  fs.writeFileSync(bin, `#!/bin/sh\ncase "$1" in ls) echo '[]';; create) echo boom >&2; exit 3;; esac\n`, { mode: 0o755 });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const backend = await createBackendFactory({ config: resolveConfig({ command: bin }), sdk })({
    scopeKey: "f", workspaceDir: ws, agentWorkspaceDir: ws, cfg: { workspaceAccess: "rw", docker: {} },
  });
  await assert.rejects(backend.buildExecSpec({ command: "x", env: {}, usePty: false }), /boom/);
  await assert.rejects(backend.buildExecSpec({ command: "x", env: {}, usePty: false }), /boom/);
});

test("missing sbx binary gives an actionable error", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const backend = await createBackendFactory({ config: resolveConfig({ command: "/nonexistent/sbx" }), sdk })({
    scopeKey: "m", workspaceDir: ws, agentWorkspaceDir: ws, cfg: { workspaceAccess: "rw", docker: {} },
  });
  await assert.rejects(backend.buildExecSpec({ command: "x", env: {}, usePty: false }), /requires the sbx CLI|ENOENT/);
});

test("manager: describeRuntime and removeRuntime", async () => {
  const fake = fakeSbx();
  fs.writeFileSync(`${fake.dir}/names`, "openclaw-x-1\n");
  const config = resolveConfig({ command: fake.bin });
  const mgr = createBackendManager({ config });
  const live = await mgr.describeRuntime({ entry: { containerName: "openclaw-x-1", image: "shell" }, config: {} });
  assert.deepEqual(live, { running: true, actualConfigLabel: "shell", configLabelMatch: true });
  const gone = await mgr.describeRuntime({ entry: { containerName: "nope", image: "claude" }, config: {} });
  assert.equal(gone.running, false);
  assert.equal(gone.configLabelMatch, false);
  await mgr.removeRuntime({ entry: { containerName: "openclaw-x-1" }, config: {} });
  assert.ok(fake.log().includes("rm --force openclaw-x-1"));
  // per-call host config overrides plugin defaults
  const viaHost = await mgr.describeRuntime({
    entry: { containerName: "openclaw-x-1", image: "claude" },
    config: { plugins: { entries: { sbx: { config: { agent: "claude", command: fake.bin } } } } },
  });
  assert.equal(viaHost.configLabelMatch, true);
});

test("removeRuntime invalidates the existence cache so the next exec recreates", async () => {
  const fake = fakeSbx();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const config = resolveConfig({ command: fake.bin });
  const backend = await createBackendFactory({ config, sdk })({
    scopeKey: "inv", workspaceDir: ws, agentWorkspaceDir: ws, cfg: { workspaceAccess: "rw", docker: {} },
  });
  await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
  assert.equal(fake.log().filter((l) => l.startsWith("create ")).length, 1);
  // The fake `rm` does not edit its list, so simulate the removal the real sbx would do.
  fs.writeFileSync(`${fake.dir}/names`, "");
  await createBackendManager({ config }).removeRuntime({ entry: { containerName: backend.runtimeId }, config: {} });
  await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
  assert.equal(fake.log().filter((l) => l.startsWith("create ")).length, 2, "recreated after removeRuntime");
});

test("config: workspaceMode validated, defaults to mount", () => {
  assert.equal(resolveConfig({}).workspaceMode, "mount");
  assert.equal(resolveConfig({ workspaceMode: "clone" }).workspaceMode, "clone");
  assert.throws(() => resolveConfig({ workspaceMode: "copy" }), /workspaceMode must be/);
});

test("create args: clone mode adds --clone and mounts the agent workspace read-only", () => {
  const cfg = resolveConfig({ workspaceMode: "clone" });
  const a = buildCreateArgs({ config: cfg, sandboxName: "n", workspaceDir: "/repo", agentWorkspaceDir: "/agent", workspaceAccess: "rw" });
  assert.deepEqual(a.slice(0, 4), ["create", "shell", "/repo", "/agent:ro"]);
  assert.ok(a.includes("--clone"));
  const same = buildCreateArgs({ config: cfg, sandboxName: "n", workspaceDir: "/repo", agentWorkspaceDir: "/repo", workspaceAccess: "rw" });
  assert.deepEqual(same.slice(0, 3), ["create", "shell", "/repo"]);
  assert.equal(same[3], "--name");
  const none = buildCreateArgs({ config: cfg, sandboxName: "n", workspaceDir: "/repo", agentWorkspaceDir: "/repo", workspaceAccess: "none" });
  assert.ok(!none.includes("--clone"), "none means no host files at all");
});

test("factory: clone mode refuses a non-git workspace instead of falling back to a mount", async () => {
  const fake = fakeSbx();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const backend = await createBackendFactory({ config: resolveConfig({ command: fake.bin, workspaceMode: "clone" }), sdk })({
    scopeKey: "clone-nogit", workspaceDir: ws, agentWorkspaceDir: ws, cfg: { workspaceAccess: "rw", docker: {} },
  });
  await assert.rejects(backend.buildExecSpec({ command: "true", env: {}, usePty: false }), /needs .* to be a git repository/);
  assert.equal(fake.log().filter((l) => l.startsWith("create ")).length, 0);
  fs.mkdirSync(path.join(ws, ".git"));
  await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
  assert.ok(fake.log().some((l) => l.startsWith("create ") && l.includes("--clone")));
});
