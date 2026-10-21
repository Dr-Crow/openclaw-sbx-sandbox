// OpenClaw sandbox backend that executes tools inside Docker Sandboxes (sbx) microVMs.
// Adapted from Eric Curtin's openclaw/openclaw PR #114168 (MIT); updated for sbx 0.48
// (bare-array `ls --json`, kits, static MCP, sizing) and made testable via an injected SDK.
import fs from "node:fs/promises";
import path from "node:path";
import { buildSandboxName, findSandbox, runSbxCli } from "./cli.js";
import { resolveConfig } from "./config.js";
import { spawnSbx } from "./spawn.js";
import { closeSshMux, createSshTransport } from "./ssh.js";

const CREATE_TIMEOUT_FLOOR_MS = 300_000;
// How long a successful "sandbox exists" check is trusted. A sandbox can be removed
// behind our back (`sbx rm`, `openclaw sandbox recreate`, pruning), so re-check periodically
// instead of caching forever; `sbx ls` costs ~200 ms.
export const VERIFY_TTL_MS = 10_000;
// sandboxName -> { at, id } of the last successful existence check (id is sbx's sandbox id, used by the ssh transport
// to keep a re-created sandbox away from a stale multiplexed connection). Module-level so the
// manager's removeRuntime (openclaw sandbox recreate / prune) can invalidate it.
const verifiedAt = new Map();

/** Build the argv tail for `sbx exec`. Exported for tests. */
export function buildExecArgs({ sandboxName, command, workdir, env, usePty }) {
  const args = ["exec", "-i"];
  if (usePty) args.push("-t");
  args.push("-w", workdir);
  for (const [key, value] of Object.entries(env ?? {})) {
    // A host PATH (macOS/Windows paths) would poison the guest's executable lookup;
    // prepend it explicitly instead.
    if (key === "PATH") continue;
    args.push("-e", `${key}=${value}`);
  }
  const customPath = typeof env?.PATH === "string" && env.PATH.length > 0;
  if (customPath) args.push("-e", `OPENCLAW_PREPEND_PATH=${env.PATH}`);
  const prefix = customPath
    ? 'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; '
    : "";
  args.push(sandboxName, "/bin/sh", "-lc", `${prefix}${command}`);
  return args;
}

/** Build the argv tail for `sbx create`. Exported for tests. */
export function buildCreateArgs({ config, sandboxName, workspaceDir, agentWorkspaceDir, workspaceAccess }) {
  const ro = (p) => (workspaceAccess === "ro" ? `${p}:ro` : p);
  // workspaceAccess "none" => no host files at all: create without a workspace bind mount.
  const paths = [];
  const clone = config.workspaceMode === "clone" && workspaceAccess !== "none";
  if (workspaceAccess !== "none") {
    // Clone mode: the primary git repo is mounted read-only and the agent works on a private clone inside the VM.
    // Extra workspaces are always mounted directly, so the agent workspace (persona and memory files) goes in read-only.
    paths.push(clone ? workspaceDir : ro(workspaceDir));
    if (agentWorkspaceDir && agentWorkspaceDir !== workspaceDir) paths.push(clone ? `${agentWorkspaceDir}:ro` : ro(agentWorkspaceDir));
  }
  const args = ["create", config.agent, ...paths, "--name", sandboxName, "--pull", config.pull, "--no-progress"];
  if (clone) args.push("--clone");
  if (config.template) args.push("--template", config.template);
  if (config.cpus) args.push("--cpus", String(config.cpus));
  if (config.memory) args.push("--memory", config.memory);
  for (const kit of config.kits) args.push("--kit", kit);
  if (config.staticMcp.length > 0) args.push("--static-mcp", config.staticMcp.join(","));
  return args;
}

function configFromHost(hostConfig, fallback) {
  const raw = hostConfig?.plugins?.entries?.sbx?.config;
  return raw ? resolveConfig(raw) : fallback;
}

/**
 * @param {{ config: ReturnType<typeof resolveConfig>, sdk: { createRemoteShellSandboxFsBridge: Function, sanitizeEnvVars: Function } }} deps
 */
export function createBackendFactory(deps) {
  return async (createParams) => {
    if ((createParams.cfg?.docker?.binds?.length ?? 0) > 0) {
      throw new Error("sbx sandbox backend does not support sandbox.docker.binds.");
    }
    return new SbxBackend(deps, createParams).asHandle();
  };
}

export function createBackendManager({ config, sdk }) {
  return {
    async describeRuntime({ entry, config: hostConfig }) {
      const cfg = configFromHost(hostConfig, config);
      const found = await findSandbox({ config: cfg, name: entry.containerName });
      return {
        running: found !== null,
        actualConfigLabel: entry.image,
        configLabelMatch: entry.image === cfg.agent,
      };
    },
    async removeRuntime({ entry, config: hostConfig }) {
      const cfg = configFromHost(hostConfig, config);
      verifiedAt.delete(entry.containerName);
      // ssh transport: drop the multiplexed master first (it is keyed by sandbox id, so a re-created sandbox
      // never meets a stale one; this just stops the idle process early).
      if (cfg.transport === "ssh") {
        const found = await findSandbox({ config: cfg, name: entry.containerName });
        await closeSshMux({ config: cfg, sdk, sandboxName: entry.containerName, sandboxId: found?.id });
      }
      await runSbxCli({ config: cfg, args: ["rm", "--force", entry.containerName] });
    },
  };
}

class SbxBackend {
  #inflight = null;
  sandboxId = undefined;

  constructor(deps, createParams) {
    this.deps = deps;
    this.createParams = createParams;
    this.sandboxName = buildSandboxName(createParams.scopeKey);
    this.workspaceDir = path.resolve(createParams.workspaceDir);
    this.agentWorkspaceDir = path.resolve(createParams.agentWorkspaceDir);
    // transport "ssh": exec and the fs bridge go over ssh via OpenClaw's SSH helpers; lifecycle stays on the sbx CLI.
    this.ssh =
      deps.config.transport === "ssh"
        ? createSshTransport({
            config: deps.config,
            sdk: deps.sdk,
            sandboxName: this.sandboxName,
            ensureSandbox: () => this.ensureSandbox(),
            getSandboxId: () => this.sandboxId,
          })
        : null;
  }

  asHandle() {
    const { config } = this.deps;
    const handle = {
      id: "sbx",
      runtimeId: this.sandboxName,
      runtimeLabel: this.sandboxName,
      workdir: this.workspaceDir,
      env: this.createParams.cfg?.docker?.env,
      configLabel: config.agent,
      configLabelKind: "Agent",
      remoteWorkspaceDir: this.workspaceDir,
      remoteAgentWorkspaceDir: this.agentWorkspaceDir,
      buildExecSpec: async ({ command, workdir, env, usePty }) => {
        if (this.ssh) {
          const prepared = await this.ssh.prepareExec({ command, workdir: workdir ?? this.workspaceDir, env, usePty });
          return {
            argv: prepared.argv,
            env: this.deps.sdk.sanitizeEnvVars(process.env).allowed,
            stdinMode: "pipe-open",
            finalizeToken: prepared.token,
          };
        }
        await this.ensureSandbox();
        return {
          argv: [
            config.command,
            ...buildExecArgs({
              sandboxName: this.sandboxName,
              command,
              workdir: workdir ?? this.workspaceDir,
              env,
              usePty,
            }),
          ],
          env: this.deps.sdk.sanitizeEnvVars(process.env).allowed,
          stdinMode: "pipe-open",
        };
      },
      ...(this.ssh ? { finalizeExec: async ({ token }) => await this.ssh.finalizeExec(token) } : {}),
      runShellCommand: (command) => this.runRemoteShellScript(command),
      createFsBridge: ({ sandbox }) =>
        this.deps.sdk.createRemoteShellSandboxFsBridge({ sandbox, runtime: handle }),
      runRemoteShellScript: (command) => this.runRemoteShellScript(command),
    };
    return handle;
  }

  async runRemoteShellScript(params) {
    if (this.ssh) return await this.ssh.runScript(params);
    await this.ensureSandbox();
    return await spawnSbx(
      [
        this.deps.config.command,
        "exec",
        "-i",
        this.sandboxName,
        "/bin/sh",
        "-c",
        params.script,
        "openclaw-sbx-fs",
        ...(params.args ?? []),
      ],
      { input: params.stdin, allowFailure: params.allowFailure, signal: params.signal },
    );
  }

  ensureSandbox() {
    if (this.#inflight) return this.#inflight;
    const cached = verifiedAt.get(this.sandboxName);
    if (cached && Date.now() - cached.at < VERIFY_TTL_MS) {
      this.sandboxId = cached.id;
      return Promise.resolve();
    }
    this.#inflight = this.#create()
      .then((id) => {
        this.sandboxId = id;
        verifiedAt.set(this.sandboxName, { at: Date.now(), id });
      })
      .finally(() => {
        this.#inflight = null;
      });
    return this.#inflight;
  }

  async #create() {
    const { config } = this.deps;
    const existing = await findSandbox({ config, name: this.sandboxName });
    if (existing) return existing.id;
    const access = this.createParams.cfg?.workspaceAccess;
    if (access !== "none") {
      // `sbx create` refuses a missing host path when there is no terminal.
      if (config.workspaceMode === "clone") {
        try {
          await fs.stat(path.join(this.workspaceDir, ".git"));
        } catch {
          throw new Error(
            `sbx workspaceMode "clone" needs ${this.workspaceDir} to be a git repository; refusing to fall back to a direct mount.`,
          );
        }
      } else {
        await fs.mkdir(this.workspaceDir, { recursive: true });
      }
      if (this.agentWorkspaceDir !== this.workspaceDir) {
        await fs.mkdir(this.agentWorkspaceDir, { recursive: true });
      }
    }
    const result = await runSbxCli({
      config,
      args: buildCreateArgs({
        config,
        sandboxName: this.sandboxName,
        workspaceDir: this.workspaceDir,
        agentWorkspaceDir: this.agentWorkspaceDir,
        workspaceAccess: access,
      }),
      timeoutMs: Math.max(config.timeoutMs, CREATE_TIMEOUT_FLOOR_MS),
    });
    if (result.code !== 0) {
      // A concurrent creator may have won the race; accept that.
      const raced = await findSandbox({ config, name: this.sandboxName });
      if (raced) return raced.id;
      throw new Error(result.stderr.trim() || "sbx create failed");
    }
    // The ssh transport needs the id of the sandbox it just created; the other transport ignores it.
    return config.transport === "ssh" ? (await findSandbox({ config, name: this.sandboxName }))?.id : undefined;
  }
}
