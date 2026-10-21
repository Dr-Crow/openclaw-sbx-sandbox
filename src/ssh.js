// SSH transport for the sbx backend ("Option C").
//
// Lifecycle (create / ls / rm) stays with the sbx CLI (see backend.js). Command execution and the
// filesystem bridge go over SSH through OpenClaw's own SSH sandbox helpers, exactly like the official
// `@openclaw/openshell-sandbox` plugin does in its "remote" mode:
//   - an ssh config text is handed to `createSshSandboxSessionFromConfigText`,
//   - exec is staged with `prepareSshSandboxExec` (secure env staging, cleanup after the run),
//   - one-shot scripts (the fs bridge) go through `runSshSandboxCommand`.
//
// The ssh endpoint is the stock sbx one: `ssh <sandbox-name>.sbx` with
// `ProxyCommand sbx ssh proxy %n` and `KnownHostsCommand sbx ssh known-hosts %H` (what `sbx setup ssh`
// writes into ~/.config/sandboxes/sandboxes/ssh/config). OpenClaw's SSH helpers run `ssh -F <generated
// config>`, which ignores ~/.ssh/config, so the Host block is generated here instead of relying on the
// user having run `sbx setup ssh`. The generated block mirrors the stock one except that it enables
// connection multiplexing (the stock block sets `ControlMaster no`), because every exec costs three
// ssh round trips (stage, run, cleanup).
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSbx } from "./spawn.js";

export const SBX_HOST_SUFFIX = ".sbx";
// `ssh` creates the control socket as "<ControlPath>.<16 random chars>" before renaming; sun_path is 108 bytes.
const MAX_CONTROL_DIR_LENGTH = 108 - 1 - 40 - 17 - 1;
// Same prefix trick as the exec transport: a host PATH must not replace the guest PATH.
export const PREPEND_PATH_PREFIX = 'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; ';

/**
 * ssh's KnownHostsCommand (and a ProxyCommand run from another cwd) needs an absolute program path
 * ("KnownHostsCommand-ORDER path is not absolute"), so resolve a bare `sbx` through PATH.
 */
export function resolveExecutablePath(command, env = process.env) {
  if (path.isAbsolute(command) || command.includes("/")) return path.resolve(command);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        fsSync.accessSync(candidate, fsSync.constants.X_OK);
        if (fsSync.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return command;
}

export function sshHostFor(sandboxName) {
  return `${sandboxName}${SBX_HOST_SUFFIX}`;
}

/** Quote a value for an ssh_config line (also escapes `%` tokens). Refuses values that cannot be quoted safely. */
function quoteSshConfig(field, value) {
  if (/[\r\n"\0]/.test(value)) throw new Error(`ssh config ${field} must not contain line breaks, quotes or NUL: ${JSON.stringify(value)}`);
  return `"${value.replaceAll("%", "%%")}"`;
}

/**
 * ssh_config text for one sandbox. Mirrors the block `sbx setup ssh` generates for `*.sbx`, plus
 * optional connection multiplexing. `Host` must be the first directive (the SDK parses it).
 * @param {{ sandboxName: string, sbxCommand: string, controlDir?: string, controlPersistSeconds?: number }} p
 */
export function buildSshConfigText({ sandboxName, sbxCommand, controlDir, controlPersistSeconds = 0 }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sandboxName)) throw new Error(`Unsafe sandbox name for ssh host: ${sandboxName}`);
  const sbx = quoteSshConfig("sbx command", sbxCommand);
  const lines = [
    `Host ${sshHostFor(sandboxName)}`,
    "  User _default_user_",
    `  ProxyCommand ${sbx} ssh proxy %n`,
    `  KnownHostsCommand ${sbx} ssh known-hosts %H`,
    "  UserKnownHostsFile /dev/null",
    "  StrictHostKeyChecking yes",
    "  IdentityAgent none",
    "  IdentityFile /dev/null",
    "  IdentitiesOnly yes",
    "  BatchMode yes",
    "  ConnectTimeout 120",
    "  ServerAliveInterval 15",
    "  ServerAliveCountMax 3",
  ];
  if (controlPersistSeconds > 0 && controlDir) {
    lines.push(
      "  ControlMaster auto",
      // quoteSshConfig returns "<dir>" with `%` escaped; append the real %C token (hash of host/user/port) inside the quotes.
      `  ControlPath ${quoteSshConfig("ControlPath", controlDir).slice(0, -1)}/%C"`,
      `  ControlPersist ${controlPersistSeconds}`,
    );
  } else {
    lines.push("  ControlMaster no", "  ControlPath none");
  }
  return `${lines.join("\n")}\n`;
}

/** Private (0700, owned by us) directory for ssh control sockets. Returns undefined when none is usable. */
export async function ensureControlDir(sdk) {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) return undefined; // no unix sockets worth trusting on Windows
  const bases = [];
  try {
    if (sdk?.resolvePreferredOpenClawTmpDir) bases.push(path.resolve(sdk.resolvePreferredOpenClawTmpDir()));
  } catch {
    /* fall through */
  }
  bases.push(os.tmpdir());
  for (const base of bases) {
    const dir = path.join(base, `sbx-ssh-mux-${uid}`);
    if (dir.length > MAX_CONTROL_DIR_LENGTH) continue;
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const st = await fs.lstat(dir);
      if (!st.isDirectory() || st.uid !== uid) continue;
      if ((st.mode & 0o077) !== 0) await fs.chmod(dir, 0o700);
      return dir;
    } catch {
      /* try the next base */
    }
  }
  return undefined;
}

const REQUIRED_SDK = [
  "createSshSandboxSessionFromConfigText",
  "runSshSandboxCommand",
  "prepareSshSandboxExec",
  "disposeSshSandboxSession",
  "buildRemoteCommand",
  "buildValidatedExecRemoteCommand",
];

export function assertSshSdk(sdk) {
  const missing = REQUIRED_SDK.filter((name) => typeof sdk?.[name] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `sbx transport "ssh" needs openclaw/plugin-sdk/sandbox exports that this OpenClaw does not provide: ${missing.join(", ")}.`,
    );
  }
}

async function openSession({ config, sdk, sandboxName }) {
  const controlDir = config.sshControlPersistSeconds > 0 ? await ensureControlDir(sdk) : undefined;
  return await sdk.createSshSandboxSessionFromConfigText({
    configText: buildSshConfigText({
      sandboxName,
      sbxCommand: resolveExecutablePath(config.command),
      controlDir,
      controlPersistSeconds: controlDir ? config.sshControlPersistSeconds : 0,
    }),
    host: sshHostFor(sandboxName),
    command: config.sshCommand,
  });
}

/** Stop the multiplexed master for a sandbox, if any. Never throws. */
export async function closeSshMux({ config, sdk, sandboxName }) {
  if (config.transport !== "ssh" || config.sshControlPersistSeconds <= 0) return;
  let session;
  try {
    session = await openSession({ config, sdk, sandboxName });
    await spawnSbx([session.command ?? config.sshCommand, "-F", session.configPath, "-O", "exit", session.host], {
      allowFailure: true,
      timeoutMs: 10_000,
    });
  } catch {
    /* best effort: the master also exits by itself once its connection is gone */
  } finally {
    if (session) await sdk.disposeSshSandboxSession(session).catch(() => {});
  }
}

/**
 * Exec and one-shot script transport over ssh. `ensureSandbox` is the lifecycle hook (sbx create on demand).
 * @param {{ config: any, sdk: any, sandboxName: string, ensureSandbox: () => Promise<void> }} deps
 */
export function createSshTransport({ config, sdk, sandboxName, ensureSandbox }) {
  assertSshSdk(sdk);
  const newSession = () => openSession({ config, sdk, sandboxName });
  const dispose = (session) => sdk.disposeSshSandboxSession(session);

  return {
    /** Stage an exec and return what OpenClaw needs to spawn it plus a token for `finalizeExec`. */
    async prepareExec({ command, workdir, env, usePty }) {
      await ensureSandbox();
      const { PATH: hostPath, ...rest } = env ?? {};
      const customPath = typeof hostPath === "string" && hostPath.length > 0;
      const remoteCommand = sdk.buildValidatedExecRemoteCommand({
        command: customPath ? `${PREPEND_PATH_PREFIX}${command}` : command,
        workdir,
        env: {},
      });
      const session = await newSession();
      try {
        const prepared = await sdk.prepareSshSandboxExec({
          session,
          remoteCommand,
          env: customPath ? { ...rest, OPENCLAW_PREPEND_PATH: hostPath } : rest,
          tty: usePty,
        });
        return {
          argv: prepared.argv,
          token: {
            cleanup: async () => {
              try {
                await prepared.cleanup();
              } finally {
                await dispose(session);
              }
            },
          },
        };
      } catch (error) {
        await dispose(session);
        throw error;
      }
    },

    async finalizeExec(token) {
      await token?.cleanup?.();
    },

    /** Run `/bin/sh -c script -- args` in the sandbox (the fs bridge's primitive). */
    async runScript(params) {
      await ensureSandbox();
      const session = await newSession();
      try {
        return await sdk.runSshSandboxCommand({
          session,
          remoteCommand: sdk.buildRemoteCommand(["/bin/sh", "-c", params.script, "openclaw-sbx-fs", ...(params.args ?? [])]),
          stdin: params.stdin,
          allowFailure: params.allowFailure,
          signal: params.signal,
        });
      } finally {
        await dispose(session);
      }
    },
  };
}
