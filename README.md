# openclaw-sbx-sandbox

An [OpenClaw](https://docs.openclaw.ai) **sandbox backend** for [Docker Sandboxes (`sbx`)](https://docs.docker.com/ai/sandboxes/).
OpenClaw's `exec`, `read`, `write`, `edit` and `apply_patch` tools run inside an `sbx` microVM: its own kernel, its own Docker
engine (so the agent can run containers without a Docker socket), and sbx's host-side network policy and credential injection.
The workspace is bind-mounted at the same path, so there is no upload or sync step.

Based on Eric Curtin's [openclaw/openclaw#114168](https://github.com/openclaw/openclaw/pull/114168) (MIT), updated for sbx 0.48 and
OpenClaw 2026.10, with on-demand create, re-create after removal, sizing, kits and static MCP options, and tests.

## Install and configure

```bash
openclaw plugins install ./openclaw-sbx-sandbox   # or a packed tarball
```

```json5
{
  plugins: { entries: { sbx: { enabled: true, config: { agent: "shell" } } } },
  agents: { defaults: { sandbox: { mode: "all", backend: "sbx", scope: "session", workspaceAccess: "rw" } } },
}
```

| Option | Default | Meaning |
|---|---|---|
| `command` | `sbx` | sbx binary |
| `agent` | `shell` | agent or kit reference for `sbx create` (`shell` is a plain exec sandbox) |
| `template` | | `--template` image |
| `pull` | `missing` | `--pull` policy |
| `cpus`, `memory` | sbx default | `--cpus`, `--memory` |
| `kits` | `[]` | extra mixin kits (`--kit`) |
| `workspaceMode` | `mount` | `clone`: the agent works on a private git clone inside the VM and the host repo is read-only (`sbx create --clone`); fetch results with `git fetch sandbox-<name>`. Refuses non-git workspaces rather than falling back to a mount |
| `staticMcp` | `[]` | sbx MCP gateway servers fixed at create time (`--static-mcp`) |
| `transport` | `exec` | `exec`: commands and file operations go through `sbx exec`. `ssh`: they go over SSH through the sbx SSH endpoint using OpenClaw's own SSH sandbox helpers (see [SSH transport](#ssh-transport-option-c)) |
| `sshCommand` | `ssh` | ssh client for `transport: "ssh"` |
| `sshControlPersistSeconds` | 60 | `transport: "ssh"`: keep one multiplexed ssh connection per sandbox open this long after last use (`0` = off, about 2x slower) |
| `timeoutSeconds` | 120 | timeout for sbx management calls (create has a 300 s floor) |

Requires `sbx` on `PATH` and `sbx login` done by the user that runs the gateway.

## Behaviour

- One sandbox per OpenClaw sandbox scope (`openclaw-<scope>-<hash>`), created on first use (about 4 s), restarted if sbx stopped it
  when idle, and re-created if it was removed. Existence is re-checked at most every 10 s, and immediately after
  `openclaw sandbox recreate`.
- `openclaw sandbox list` / `recreate` work through the plugin's manager.
- The workspace path inside the sandbox equals the host path. If the gateway itself runs in a container, mount the workspace at the
  same path on the host and in the gateway container, because the sbx daemon resolves host paths.
- `sandbox.docker.binds` is not supported.

## SSH transport (Option C)

`transport: "ssh"` keeps the lifecycle on the sbx CLI (`sbx create`, `sbx ls`, `sbx rm`, same names, same mounts, same
`workspaceMode`) and moves everything else onto the official remote-shell machinery that `@openclaw/openshell-sandbox` also uses in
its `remote` mode: exec is staged with `prepareSshSandboxExec` (environment written to a private script, cleaned up in
`finalizeExec`), one-shot scripts run with `runSshSandboxCommand`, and the file tools use the SDK's
`createRemoteShellSandboxFsBridge`. The endpoint is the stock `<sandbox-name>.sbx` one (`ProxyCommand sbx ssh proxy %n`,
`KnownHostsCommand sbx ssh known-hosts %H`, no keys: the daemon authenticates by local socket plus Docker login).

```json5
{
  plugins: { entries: { sbx: { enabled: true, config: { agent: "shell", transport: "ssh" } } } },
  agents: { defaults: { sandbox: { mode: "all", backend: "sbx", scope: "agent", workspaceAccess: "rw" } } },
}
```

Why not just `backend: "ssh"` with `ssh.target: "<name>.sbx"`? OpenClaw's SSH helpers run `ssh -F <private generated config>`,
so `~/.ssh/config` and the `Host *.sbx` block written by `sbx setup ssh` are never read (`ssh: Could not resolve hostname
p1.sbx`), the generated config never sets a ProxyCommand, and the stock backend seeds a *copy* of the workspace into the sandbox
instead of using the mounted one. This transport generates the `Host <name>.sbx` block itself (so `sbx setup ssh` is not needed),
enables connection multiplexing, and uses the mounted workspace at its host path.

What you get compared with `transport: "exec"`: file operations are about 1.3-2x faster (fewer, cheaper round trips over one shared
connection), each `exec` is about 0.3 s slower (stage, run and clean up are three ssh round trips), and the ssh path is the one
OpenClaw maintains for remote sandboxes, so a future official sbx backend or an upstream `sbx` option can replace this file with
little change. Requirements: an `ssh` client with `KnownHostsCommand` (OpenSSH 8.5+) on the gateway host, `sbx` with
`sbx ssh proxy` (tested: 0.49.1, the command is marked experimental), and in the sandbox `/bin/sh`, `python3` and `stat -c` /
`readlink -f -n` in non-interactive ssh commands (all present in the stock `shell` image; its `stat` and `readlink` are uutils
coreutils). `sbx` is resolved to an absolute path for the ssh config because `KnownHostsCommand` requires one.

Details: the ssh control socket is keyed by sandbox id, so a sandbox removed and re-created under the same name never meets a
stale multiplexed connection; `openclaw sandbox recreate` also stops the master. Waking a stopped sandbox through ssh takes
about 25-30 s (the connection waits for it, `ConnectTimeout` is 120 s).

## Stability

OpenClaw's `openclaw/plugin-sdk/sandbox` subpath is marked "private-local" (JavaScript-only export, no typings, documented for
official plugins). `@openclaw/openshell-sandbox` uses the same one. `clawhub package validate` reports no findings for this package
today, but the surface can change; CI should run `npm test` and `npm run test:e2e` against each OpenClaw release.

## Tests

`npm test` runs the unit tests against a fake `sbx` (and a fake `ssh` for the ssh transport). `SBX_E2E=1 OPENCLAW_SANDBOX_SDK=<openclaw>/dist/plugin-sdk/sandbox.js npm run test:e2e`
runs create, exec, Docker-in-sandbox, the real OpenClaw filesystem bridge, remove, re-create, parallel execs, pty and an external `sbx rm`
against a real sbx; add `SBX_E2E_TRANSPORT=ssh` for the ssh transport.

`scripts/` holds the comparison tooling: `fake-model-driver.mjs` (a scripted OpenAI-compatible "model" that makes OpenClaw call
`exec`/`write`/`read`/`edit`/`apply_patch` for real, no key needed), `abc-script.json`, `abc-run.sh` (runs it through
`openclaw agent --local` and prints per-tool latency) and `latency-bench.mjs` (plugin-level exec and fs-bridge latency).
