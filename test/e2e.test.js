// Real sbx (and, if OPENCLAW_SANDBOX_SDK points at openclaw's dist/plugin-sdk/sandbox.js,
// the real OpenClaw filesystem bridge). Opt in with SBX_E2E=1; needs a working `sbx` login.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBackendFactory, createBackendManager } from "../src/backend.js";
import { resolveConfig } from "../src/config.js";

const enabled = process.env.SBX_E2E === "1";
const sbxCmd = process.env.SBX_COMMAND || "sbx";

function run(argv, { input } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("error", reject);
    c.on("close", (code) => resolve({ code, out, err }));
    c.stdin.end(input);
  });
}

async function loadSdk() {
  if (process.env.OPENCLAW_SANDBOX_SDK) return await import(process.env.OPENCLAW_SANDBOX_SDK);
  return {
    sanitizeEnvVars: (env) => ({ allowed: { PATH: env.PATH } }),
    createRemoteShellSandboxFsBridge: null,
  };
}

test("real sbx: create on demand, exec, docker inside, fs bridge, remove", { skip: !enabled, timeout: 600_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sbx-e2e-"));
  const ws = path.join(root, "workspace"); // intentionally absent: backend must create it
  const sdk = await loadSdk();
  const config = resolveConfig({ command: sbxCmd, agent: "shell" });
  const backend = await createBackendFactory({ config, sdk })({
    scopeKey: `e2e:${process.pid}:${Date.now()}`,
    workspaceDir: ws,
    agentWorkspaceDir: ws,
    cfg: { workspaceAccess: "rw", docker: { env: {} } },
  });
  const exec = async (command) => {
    const spec = await backend.buildExecSpec({ command, env: {}, usePty: false });
    return run(spec.argv);
  };
  try {
    const t0 = Date.now();
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, "seed.txt"), "seed-from-host\n");
    let r = await exec("pwd && cat seed.txt && uname -r");
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(ws), "workdir is the host path");
    assert.ok(r.out.includes("seed-from-host"));
    console.log(`first exec (create+start): ${Date.now() - t0} ms; guest kernel line: ${r.out.trim().split("\n").pop()}`);

    r = await exec("echo from-guest > guest.txt");
    assert.equal(r.code, 0, r.err);
    assert.equal((await fs.readFile(path.join(ws, "guest.txt"), "utf8")).trim(), "from-guest");

    r = await exec("docker run --rm hello-world 2>&1 | head -3 || true; docker info --format '{{.ServerVersion}}'");
    assert.equal(r.code, 0, r.err);
    console.log(`docker inside sandbox: ${r.out.trim().split("\n").pop()}`);

    const t1 = Date.now();
    r = await exec("true");
    console.log(`warm exec: ${Date.now() - t1} ms`);

    if (sdk.createRemoteShellSandboxFsBridge) {
      const bridge = backend.createFsBridge({ sandbox: { backend, workspaceDir: ws, agentWorkspaceDir: ws, containerWorkdir: ws, workspaceAccess: "rw", backendId: "sbx", runtimeId: backend.runtimeId } });
      await bridge.writeFile({ filePath: "nested/bridge.txt", data: "hello-bridge\n" });
      assert.equal(await fs.readFile(path.join(ws, "nested", "bridge.txt"), "utf8"), "hello-bridge\n");
      assert.deepEqual(await bridge.readFile({ filePath: "nested/bridge.txt" }), Buffer.from("hello-bridge\n"));
    }

    const mgr = createBackendManager({ config });
    const entry = { containerName: backend.runtimeId, image: "shell" };
    assert.equal((await mgr.describeRuntime({ entry, config: {} })).running, true);
    await mgr.removeRuntime({ entry, config: {} });
    assert.equal((await mgr.describeRuntime({ entry, config: {} })).running, false);

    // after removal the next exec transparently recreates it
    r = await exec("cat seed.txt");
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("seed-from-host"));
  } finally {
    await run([sbxCmd, "rm", "--force", backend.runtimeId]);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("real sbx: clone mode keeps the host repo untouched", { skip: !enabled, timeout: 600_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sbx-e2e-clone-"));
  const ws = path.join(root, "repo");
  await fs.mkdir(ws);
  const git = (...a) => run(["git", "-C", ws, "-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...a]);
  await git("init", "-q", "-b", "main");
  await fs.writeFile(path.join(ws, "app.txt"), "v1\n");
  await git("add", "app.txt");
  await git("commit", "-q", "-m", "init", "--no-verify");
  const sdk = await loadSdk();
  const backend = await createBackendFactory({ config: resolveConfig({ command: sbxCmd, workspaceMode: "clone" }), sdk })({
    scopeKey: `e2e-clone:${process.pid}:${Date.now()}`, workspaceDir: ws, agentWorkspaceDir: ws,
    cfg: { workspaceAccess: "rw", docker: { env: {} } },
  });
  const exec = async (command) => run((await backend.buildExecSpec({ command, env: {}, usePty: false })).argv);
  try {
    let r = await exec("echo evil > app.txt && mkdir -p .git/hooks && printf '#!/bin/sh\\n' > .git/hooks/pre-commit && touch /run/sandbox/source/x 2>&1 | head -1");
    assert.match(r.out + r.err, /Read-only/);
    assert.equal(await fs.readFile(path.join(ws, "app.txt"), "utf8"), "v1\n", "host file untouched");
    await assert.rejects(fs.access(path.join(ws, ".git", "hooks", "pre-commit")), "no hook planted on host");
  } finally {
    await run([sbxCmd, "rm", "--force", backend.runtimeId]);
    await fs.rm(root, { recursive: true, force: true });
  }
});
