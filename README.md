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
| `staticMcp` | `[]` | sbx MCP gateway servers fixed at create time (`--static-mcp`) |
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

## Stability

OpenClaw's `openclaw/plugin-sdk/sandbox` subpath is marked "private-local" (JavaScript-only export, no typings, documented for
official plugins). `@openclaw/openshell-sandbox` uses the same one. `clawhub package validate` reports no findings for this package
today, but the surface can change; CI should run `npm test` and `npm run test:e2e` against each OpenClaw release.

## Tests

`npm test` runs the unit tests against a fake `sbx`. `SBX_E2E=1 OPENCLAW_SANDBOX_SDK=<openclaw>/dist/plugin-sdk/sandbox.js npm run test:e2e`
runs create, exec, Docker-in-sandbox, the real OpenClaw filesystem bridge, remove and re-create against a real sbx.
