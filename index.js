import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
// `plugin-sdk/sandbox` is a private-local, JavaScript-only export of the OpenClaw host
// (no .d.ts). It is the same surface @openclaw/openshell-sandbox uses. See README "Stability".
// A namespace import (not named imports) so an OpenClaw that lacks the SSH helpers still loads the
// plugin for the default `exec` transport; `transport: "ssh"` then fails with a clear message.
import * as sandboxSdk from "openclaw/plugin-sdk/sandbox";
import { createBackendFactory, createBackendManager } from "./src/backend.js";
import { resolveConfig } from "./src/config.js";

const SDK_NAMES = [
  "createRemoteShellSandboxFsBridge",
  "registerSandboxBackend",
  "sanitizeEnvVars",
  // transport: "ssh" (same helpers @openclaw/openshell-sandbox uses)
  "createSshSandboxSessionFromConfigText",
  "runSshSandboxCommand",
  "prepareSshSandboxExec",
  "disposeSshSandboxSession",
  "buildRemoteCommand",
  "buildValidatedExecRemoteCommand",
  "resolvePreferredOpenClawTmpDir",
];

export default definePluginEntry({
  id: "sbx",
  name: "Docker Sandboxes (sbx)",
  description: "Run agent exec and file tools inside Docker Sandboxes (sbx) microVMs.",
  register(api) {
    if (api.registrationMode !== "full") return;
    const config = resolveConfig(api.pluginConfig);
    const sdk = Object.fromEntries(SDK_NAMES.map((name) => [name, sandboxSdk[name]]));
    sandboxSdk.registerSandboxBackend("sbx", {
      factory: createBackendFactory({ config, sdk }),
      manager: createBackendManager({ config, sdk }),
      resolveWorkdir: ({ workspaceDir }) => workspaceDir,
    });
  },
});
