import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createBackendFactory, createBackendManager } from "../src/backend.js";
import { resolveConfig } from "../src/config.js";
import { buildSshConfigText, ensureControlDir, PREPEND_PATH_PREFIX, resolveExecutablePath, sshHostFor } from "../src/ssh.js";

// Fake sbx (lifecycle only, like unit.test.js) and a fake ssh that logs its argv and runs the remote command locally.
function fakes() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-sbxssh-"));
  const sbx = path.join(dir, "sbx");
  fs.writeFileSync(
    sbx,
    `#!/bin/sh
echo "$*" >> "${dir}/sbxlog"
case "$1" in
  ls) if [ -s "${dir}/names" ]; then printf '['; sep=''; while read n id; do printf '%s{"name":"%s","id":"%s","status":"running"}' "$sep" "$n" "\${id:-none}"; sep=','; done < "${dir}/names"; printf ']\\n'; else echo '[]'; fi ;;
  create) while [ $# -gt 0 ]; do if [ "$1" = "--name" ]; then c=$(cat "${dir}/counter" 2>/dev/null || echo 0); c=$((c+1)); echo $c > "${dir}/counter"; echo "$2 \${c}aaa-bbbb-cccc-dddd-eeeeeeeeeeee" >> "${dir}/names"; fi; shift; done ;;
  rm) : > "${dir}/names" ;;
esac
`,
    { mode: 0o755 },
  );
  const ssh = path.join(dir, "ssh");
  // usage: ssh -F cfg [-tt|-T -o RequestTTY=..] host remoteCommand  |  ssh -F cfg -O exit host
  fs.writeFileSync(
    ssh,
    `#!/bin/sh
echo "$*" >> "${dir}/sshlog"
[ "$3" = "-O" ] && exit 0
shift 2
while [ $# -gt 1 ]; do case "$1" in -o) shift 2;; -T|-tt) shift;; *) break;; esac; done
shift
exec /bin/sh -c "$1"
`,
    { mode: 0o755 },
  );
  const read = (f) => (fs.existsSync(`${dir}/${f}`) ? fs.readFileSync(`${dir}/${f}`, "utf8").trim().split("\n").filter(Boolean) : []);
  return { dir, sbx, ssh, sbxLog: () => read("sbxlog"), sshLog: () => read("sshlog") };
}

const shellEscape = (v) => `'${v.replaceAll("'", `'"'"'`)}'`;
function fakeSdk(sshBin) {
  const sessions = [];
  return {
    sessions,
    sanitizeEnvVars: (env) => ({ allowed: { PATH: env.PATH } }),
    createRemoteShellSandboxFsBridge: ({ runtime }) => ({ bridgeFor: runtime.id, runtime }),
    resolvePreferredOpenClawTmpDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "oc-tmp-")),
    buildRemoteCommand: (argv) => argv.map(shellEscape).join(" "),
    buildValidatedExecRemoteCommand: ({ command, workdir }) => `/bin/sh -c ${shellEscape(workdir ? `cd ${shellEscape(workdir)} && ${command}` : command)}`,
    async createSshSandboxSessionFromConfigText({ configText, host, command }) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "sshsess-"));
      const configPath = path.join(d, "config");
      fs.writeFileSync(configPath, configText, { mode: 0o600 });
      const s = { command: command === "ssh" ? sshBin : command, configPath, host, configText, disposed: false };
      sessions.push(s);
      return s;
    },
    async disposeSshSandboxSession(s) {
      s.disposed = true;
      fs.rmSync(path.dirname(s.configPath), { recursive: true, force: true });
    },
    async runSshSandboxCommand({ session, remoteCommand, stdin, allowFailure }) {
      const r = spawnSync(session.command, ["-F", session.configPath, "-T", session.host, remoteCommand], { input: stdin ?? "" });
      if (r.status !== 0 && !allowFailure) throw Object.assign(new Error(String(r.stderr)), { code: r.status });
      return { stdout: r.stdout, stderr: r.stderr, code: r.status };
    },
    async prepareSshSandboxExec({ session, remoteCommand, env, tty }) {
      const envPrefix = Object.entries(env).map(([k, v]) => `export ${k}=${shellEscape(v)};`).join(" ");
      return {
        argv: [session.command, "-F", session.configPath, tty ? "-tt" : "-T", session.host, `${envPrefix} exec ${remoteCommand}`],
        cleanup: async () => {},
      };
    },
  };
}

const params = (ws, extra = {}) => ({
  scopeKey: "session:ssh1", workspaceDir: ws, agentWorkspaceDir: ws, cfg: { workspaceAccess: "rw", docker: { env: {} } }, ...extra,
});

test("config: transport and ssh options validated, default exec", () => {
  const c = resolveConfig({});
  assert.equal(c.transport, "exec");
  assert.equal(c.sshCommand, "ssh");
  assert.equal(c.sshControlPersistSeconds, 60);
  assert.equal(resolveConfig({ transport: "ssh", sshControlPersistSeconds: 0 }).sshControlPersistSeconds, 0);
  assert.throws(() => resolveConfig({ transport: "telnet" }), /transport must be/);
  assert.throws(() => resolveConfig({ sshControlPersistSeconds: -1 }), /sshControlPersistSeconds/);
  assert.throws(() => resolveConfig({ sshControlPersistSeconds: 1.5 }), /sshControlPersistSeconds/);
  assert.throws(() => resolveConfig({ sshCommand: "" }), /sshCommand/);
});

test("ssh config text mirrors the stock sbx block and is injection-safe", () => {
  const t = buildSshConfigText({ sandboxName: "openclaw-x-1a2b3c4d", sbxCommand: "/usr/bin/sbx", controlDir: "/run/u/mux", controlPersistSeconds: 30 });
  assert.match(t, /^Host openclaw-x-1a2b3c4d\.sbx\n/, "Host first: the SDK parses the first Host line");
  assert.match(t, /ProxyCommand "\/usr\/bin\/sbx" ssh proxy %n/);
  assert.match(t, /KnownHostsCommand "\/usr\/bin\/sbx" ssh known-hosts %H/);
  assert.match(t, /User _default_user_/);
  assert.match(t, /StrictHostKeyChecking yes/);
  assert.match(t, /IdentityFile \/dev\/null/);
  assert.match(t, /ControlMaster auto\n  ControlPath "\/run\/u\/mux\/noid00000000-%C"\n  ControlPersist 30/);
  const withId = buildSshConfigText({ sandboxName: "n", sbxCommand: "sbx", controlDir: "/run/u/mux", controlPersistSeconds: 30, sandboxId: "78ac2524-acb5-42e0-93b3-e1fa2112c09e" });
  assert.match(withId, /ControlPath "\/run\/u\/mux\/78ac2524acb5-%C"/, "sandbox id (12 alnum chars) is part of the socket name");
  const off = buildSshConfigText({ sandboxName: "n", sbxCommand: "sbx", controlPersistSeconds: 0 });
  assert.match(off, /ControlMaster no\n  ControlPath none/);
  // % in the sbx path must be escaped for ssh token expansion
  assert.match(buildSshConfigText({ sandboxName: "n", sbxCommand: "/opt/100%/sbx" }), /ProxyCommand "\/opt\/100%%\/sbx" ssh proxy %n/);
  assert.throws(() => buildSshConfigText({ sandboxName: "n", sbxCommand: 'sbx"\nProxyCommand evil' }), /must not contain/);
  assert.throws(() => buildSshConfigText({ sandboxName: "a b\nHost *", sbxCommand: "sbx" }), /Unsafe sandbox name/);
  assert.equal(sshHostFor("p1"), "p1.sbx");
});

test("control dir is private, owned by us, and short enough for a unix socket", async () => {
  const sdk = fakeSdk("ssh");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "oc-tmp-"));
  sdk.resolvePreferredOpenClawTmpDir = () => base;
  const dir = await ensureControlDir(sdk);
  assert.ok(dir);
  const st = fs.lstatSync(dir);
  assert.equal(st.mode & 0o777, 0o700);
  assert.ok(dir.length + 1 + 40 + 17 < 108);
  // a pre-existing, too-open directory is tightened
  fs.chmodSync(dir, 0o755);
  await ensureControlDir(sdk);
  assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);
  // an over-long preferred base falls back to os.tmpdir()
  const long = await ensureControlDir({ resolvePreferredOpenClawTmpDir: () => "/tmp/" + "x".repeat(80) });
  assert.ok(long && long.startsWith(os.tmpdir()));
});

test("ssh transport: lifecycle through sbx, exec through the SDK ssh helpers", async () => {
  const f = fakes();
  const sdk = fakeSdk(f.ssh);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const config = resolveConfig({ command: f.sbx, transport: "ssh" });
  const backend = await createBackendFactory({ config, sdk })(params(ws));

  const spec = await backend.buildExecSpec({ command: "echo hi && pwd", env: { FOO: "a b" }, usePty: false });
  assert.equal(spec.stdinMode, "pipe-open");
  assert.deepEqual(spec.env, { PATH: process.env.PATH });
  assert.ok(spec.finalizeToken, "finalizeToken carries the cleanup");
  assert.equal(spec.argv[0], f.ssh);
  assert.ok(spec.argv.includes(`${backend.runtimeId}.sbx`));
  assert.equal(f.sbxLog().filter((l) => l.startsWith("create ")).length, 1);
  assert.ok(f.sbxLog().some((l) => l.startsWith("create shell ") && l.includes(ws)), "workspace is mounted by sbx create");
  assert.ok(!f.sbxLog().some((l) => l.startsWith("exec ")), "no sbx exec on the ssh transport");

  // run what OpenClaw would spawn: argv executes the staged command (fake ssh runs it locally)
  const r = spawnSync(spec.argv[0], spec.argv.slice(1), { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^hi\n/);
  assert.ok(r.stdout.includes(fs.realpathSync(ws)), "ran in the workspace workdir");

  const disposedBefore = sdk.sessions.filter((s) => s.disposed).length;
  await backend.finalizeExec({ token: spec.finalizeToken });
  assert.equal(sdk.sessions.filter((s) => s.disposed).length, disposedBefore + 1, "session disposed on finalize");

  // second exec does not create again
  const spec2 = await backend.buildExecSpec({ command: "true", env: {}, usePty: true });
  assert.ok(spec2.argv.includes("-tt"));
  assert.equal(f.sbxLog().filter((l) => l.startsWith("create ")).length, 1);
  await backend.finalizeExec({ token: spec2.finalizeToken });
});

test("ssh transport: host PATH is prepended, never replaces the guest PATH", async () => {
  const f = fakes();
  const sdk = fakeSdk(f.ssh);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const backend = await createBackendFactory({ config: resolveConfig({ command: f.sbx, transport: "ssh" }), sdk })(params(ws));
  const spec = await backend.buildExecSpec({ command: 'echo "$PATH"', env: { PATH: "/opt/gw/bin" }, usePty: false });
  const last = spec.argv.at(-1);
  assert.ok(!/export PATH='\/opt\/gw\/bin'/.test(last), "PATH itself not exported");
  assert.ok(last.includes("export OPENCLAW_PREPEND_PATH='/opt/gw/bin'"));
  assert.ok(last.includes(PREPEND_PATH_PREFIX.trim().slice(0, 40)));
  const r = spawnSync(spec.argv[0], spec.argv.slice(1), { encoding: "utf8" });
  assert.equal(r.stdout.trim(), `/opt/gw/bin:${process.env.PATH}`);
});

test("ssh transport: runRemoteShellScript passes script, args and stdin over ssh", async () => {
  const f = fakes();
  const sdk = fakeSdk(f.ssh);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const backend = await createBackendFactory({ config: resolveConfig({ command: f.sbx, transport: "ssh" }), sdk })(params(ws));
  const r = await backend.runRemoteShellScript({ script: 'cat; echo "[$1][$2]"', args: ["a b", "it's"], stdin: "in\n" });
  assert.equal(r.code, 0);
  assert.equal(String(r.stdout), "in\n[a b][it's]\n");
  assert.ok(sdk.sessions.every((s) => s.disposed), "every session disposed");
  const bad = await backend.runRemoteShellScript({ script: "exit 3", allowFailure: true });
  assert.equal(bad.code, 3);
  await assert.rejects(backend.runRemoteShellScript({ script: "exit 4" }), (e) => e.code === 4);
  assert.ok(!f.sbxLog().some((l) => l.startsWith("exec ")));
  // the fs bridge is the SDK's, bound to this runtime handle
  const bridge = backend.createFsBridge({ sandbox: {} });
  assert.equal(bridge.runtime.runRemoteShellScript, backend.runRemoteShellScript);
});

test("ssh transport: concurrent first calls create once; sessions are disposed on failure", async () => {
  const f = fakes();
  const sdk = fakeSdk(f.ssh);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const backend = await createBackendFactory({ config: resolveConfig({ command: f.sbx, transport: "ssh" }), sdk })(params(ws, { scopeKey: "conc" }));
  const specs = await Promise.all([1, 2, 3].map(() => backend.buildExecSpec({ command: "true", env: {}, usePty: false })));
  assert.equal(f.sbxLog().filter((l) => l.startsWith("create ")).length, 1);
  for (const s of specs) await backend.finalizeExec({ token: s.finalizeToken });
  const before = sdk.sessions.length;
  sdk.prepareSshSandboxExec = async () => { throw new Error("stage failed"); };
  await assert.rejects(backend.buildExecSpec({ command: "true", env: {}, usePty: false }), /stage failed/);
  assert.ok(sdk.sessions.slice(before).every((s) => s.disposed), "session disposed after failed staging");
  // malformed commands are rejected by the SDK validator before any session exists
  sdk.buildValidatedExecRemoteCommand = () => { throw new Error("Malformed"); };
  const n = sdk.sessions.length;
  await assert.rejects(backend.buildExecSpec({ command: "echo 'x", env: {}, usePty: false }), /Malformed/);
  assert.equal(sdk.sessions.length, n);
});

test("ssh transport: clone mode and exec-transport behaviour are unchanged", async () => {
  const f = fakes();
  const sdk = fakeSdk(f.ssh);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const exec = await createBackendFactory({ config: resolveConfig({ command: f.sbx }), sdk })(params(ws, { scopeKey: "e" }));
  assert.equal(exec.finalizeExec, undefined, "exec transport has no finalizeExec");
  const spec = await exec.buildExecSpec({ command: "x", env: {}, usePty: false });
  assert.equal(spec.argv[0], f.sbx);
  assert.equal(spec.argv[1], "exec");
  await assert.rejects(
    createBackendFactory({ config: resolveConfig({ command: f.sbx, transport: "ssh" }), sdk: { ...sdk, runSshSandboxCommand: undefined } })(params(ws, { scopeKey: "e2" })),
    /needs openclaw\/plugin-sdk\/sandbox exports.*runSshSandboxCommand/,
  );
});

test("manager: removeRuntime stops the ssh master before sbx rm; exec transport does not touch ssh", async () => {
  const f = fakes();
  const sdk = fakeSdk(f.ssh);
  fs.writeFileSync(`${f.dir}/names`, "openclaw-x-1\n");
  await createBackendManager({ config: resolveConfig({ command: f.sbx, transport: "ssh" }), sdk }).removeRuntime({ entry: { containerName: "openclaw-x-1" }, config: {} });
  assert.ok(f.sshLog().some((l) => l.includes("-O exit openclaw-x-1.sbx")), "ssh -O exit sent");
  assert.ok(f.sbxLog().includes("rm --force openclaw-x-1"));
  assert.ok(sdk.sessions.every((s) => s.disposed));

  const f2 = fakes();
  await createBackendManager({ config: resolveConfig({ command: f2.sbx }), sdk: fakeSdk(f2.ssh) }).removeRuntime({ entry: { containerName: "a" }, config: {} });
  assert.equal(f2.sshLog().length, 0);
  // no sdk at all (older callers) must still work
  await createBackendManager({ config: resolveConfig({ command: f2.sbx }) }).removeRuntime({ entry: { containerName: "a" }, config: {} });
  // ssh failures never block removal
  const f3 = fakes();
  fs.writeFileSync(f3.ssh, "#!/bin/sh\nexit 255\n", { mode: 0o755 });
  await createBackendManager({ config: resolveConfig({ command: f3.sbx, transport: "ssh" }), sdk: fakeSdk(f3.ssh) }).removeRuntime({ entry: { containerName: "a" }, config: {} });
  assert.ok(f3.sbxLog().includes("rm --force a"));
});

test("re-create after sbx rm: next ssh exec creates the sandbox again", async () => {
  const f = fakes();
  const sdk = fakeSdk(f.ssh);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const config = resolveConfig({ command: f.sbx, transport: "ssh" });
  const backend = await createBackendFactory({ config, sdk })(params(ws, { scopeKey: "re" }));
  await backend.finalizeExec({ token: (await backend.buildExecSpec({ command: "true", env: {}, usePty: false })).finalizeToken });
  await createBackendManager({ config, sdk }).removeRuntime({ entry: { containerName: backend.runtimeId }, config: {} });
  await backend.finalizeExec({ token: (await backend.buildExecSpec({ command: "true", env: {}, usePty: false })).finalizeToken });
  assert.equal(f.sbxLog().filter((l) => l.startsWith("create ")).length, 2);
});

test("a bare sbx command is resolved to an absolute path for the ssh config (KnownHostsCommand needs one)", async () => {
  const f = fakes();
  assert.equal(resolveExecutablePath(f.sbx), f.sbx);
  assert.equal(resolveExecutablePath("sbx", { PATH: `/nonexistent:${f.dir}` }), f.sbx);
  assert.equal(resolveExecutablePath("nope-sbx", { PATH: f.dir }), "nope-sbx");
  const sdk = fakeSdk(f.ssh);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const old = process.env.PATH;
  process.env.PATH = `${f.dir}:${old}`;
  try {
    const backend = await createBackendFactory({ config: resolveConfig({ command: "sbx", transport: "ssh" }), sdk })(params(ws, { scopeKey: "abs" }));
    await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
    assert.match(sdk.sessions.at(-1).configText, new RegExp(`KnownHostsCommand "${f.sbx}" ssh known-hosts %H`));
  } finally {
    process.env.PATH = old;
  }
});

test("a re-created sandbox gets its own ssh control socket (stale multiplexed connection is never reused)", async () => {
  const f = fakes();
  const sdk = fakeSdk(f.ssh);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const config = resolveConfig({ command: f.sbx, transport: "ssh" });
  const backend = await createBackendFactory({ config, sdk })(params(ws, { scopeKey: "mux-id" }));
  const controlPath = (s) => s.configText.match(/ControlPath "([^"]+)"/)[1];
  await backend.finalizeExec({ token: (await backend.buildExecSpec({ command: "true", env: {}, usePty: false })).finalizeToken });
  const first = controlPath(sdk.sessions.at(-1));
  assert.match(first, /\/1aaabbbbcccc-%C$/);
  // removed behind our back (not through the manager), then the existence cache expires
  fs.writeFileSync(`${f.dir}/names`, "");
  const { VERIFY_TTL_MS } = await import("../src/backend.js");
  const realNow = Date.now;
  Date.now = () => realNow() + VERIFY_TTL_MS + 1000;
  try {
    await backend.finalizeExec({ token: (await backend.buildExecSpec({ command: "true", env: {}, usePty: false })).finalizeToken });
  } finally {
    Date.now = realNow;
  }
  assert.equal(f.sbxLog().filter((l) => l.startsWith("create ")).length, 2);
  const second = controlPath(sdk.sessions.at(-1));
  assert.match(second, /\/2aaabbbbcccc-%C$/);
  assert.notEqual(second, first);
});
