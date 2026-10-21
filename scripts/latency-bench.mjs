#!/usr/bin/env node
// Plugin-level latency microbenchmark (no gateway, no model): per-exec and per-fs-bridge-call latency for one
// transport against a real sbx and the real OpenClaw SDK.
//   OPENCLAW_SANDBOX_SDK=<openclaw>/dist/plugin-sdk/sandbox.js TRANSPORT=exec|ssh [N=15] node scripts/latency-bench.mjs
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBackendFactory, createBackendManager } from "../src/backend.js";
import { resolveConfig } from "../src/config.js";

const sdk = await import(process.env.OPENCLAW_SANDBOX_SDK);
const transport = process.env.TRANSPORT ?? "exec";
const N = Number(process.env.N ?? 15);
const sbxCmd = process.env.SBX_COMMAND ?? "sbx";
const ws = await fs.mkdtemp(path.join(os.tmpdir(), `lat-${transport}-`));
const config = resolveConfig({ command: sbxCmd, transport, ...(process.env.CONTROL_PERSIST ? { sshControlPersistSeconds: Number(process.env.CONTROL_PERSIST) } : {}) });
const backend = await createBackendFactory({ config, sdk })({
  scopeKey: `lat:${transport}:${process.pid}`, workspaceDir: ws, agentWorkspaceDir: ws, cfg: { workspaceAccess: "rw", docker: { env: {} } },
});
const run = (argv) => new Promise((resolve) => {
  const c = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
  c.on("close", (code) => resolve({ code, out })); c.stdin.end();
});
const exec = async (command, extra = {}) => {
  const spec = await backend.buildExecSpec({ command, env: {}, usePty: false, ...extra });
  try { return await run(spec.argv); } finally { await backend.finalizeExec?.({ token: spec.finalizeToken }); }
};
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const timeIt = async (fn) => { const t = performance.now(); await fn(); return Math.round(performance.now() - t); };
const sandbox = { backend, workspaceDir: ws, agentWorkspaceDir: ws, containerWorkdir: ws, workspaceAccess: "rw", backendId: "sbx", runtimeId: backend.runtimeId };
const result = { transport, N };
try {
  result.firstExecMs = await timeIt(() => exec("true"));
  const ex = []; for (let i = 0; i < N; i++) ex.push(await timeIt(() => exec("true")));
  result.execMedianMs = median(ex); result.execMinMs = Math.min(...ex); result.execAll = ex;
  const bridge = backend.createFsBridge({ sandbox });
  const wr = [], rd = [], st = [];
  for (let i = 0; i < Math.min(N, 8); i++) {
    wr.push(await timeIt(() => bridge.writeFile({ filePath: `f${i}.txt`, data: "hello\n" })));
    rd.push(await timeIt(() => bridge.readFile({ filePath: `f${i}.txt` })));
    st.push(await timeIt(() => bridge.stat({ filePath: `f${i}.txt` })));
  }
  result.bridgeWriteMedianMs = median(wr); result.bridgeReadMedianMs = median(rd); result.bridgeStatMedianMs = median(st);
  // an idle->stale-mux check: remove, re-create, exec again
  const mgr = createBackendManager({ config, sdk });
  const entry = { containerName: backend.runtimeId, image: "shell" };
  result.removeMs = await timeIt(() => mgr.removeRuntime({ entry, config: {} }));
  const re = await timeIt(async () => { const r = await exec("cat f0.txt"); result.recreateOk = r.code === 0 && r.out.includes("hello"); });
  result.recreateMs = re;
} finally {
  await createBackendManager({ config, sdk }).removeRuntime({ entry: { containerName: backend.runtimeId }, config: {} }).catch(() => {});
  await fs.rm(ws, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
