import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
// `plugin-sdk/sandbox` is a private-local, JavaScript-only export of the OpenClaw host
// (no .d.ts). It is the same surface @openclaw/openshell-sandbox uses. See README "Stability".
import {
  createRemoteShellSandboxFsBridge,
  registerSandboxBackend,
  sanitizeEnvVars,
} from "openclaw/plugin-sdk/sandbox";
import { createBackendFactory, createBackendManager } from "./src/backend.js";
import { resolveConfig } from "./src/config.js";

export default definePluginEntry({
  id: "sbx",
  name: "Docker Sandboxes (sbx)",
  description: "Run agent exec and file tools inside Docker Sandboxes (sbx) microVMs.",
  register(api) {
    if (api.registrationMode !== "full") return;
    const config = resolveConfig(api.pluginConfig);
    registerSandboxBackend("sbx", {
      factory: createBackendFactory({ config, sdk: { createRemoteShellSandboxFsBridge, sanitizeEnvVars } }),
      manager: createBackendManager({ config }),
      resolveWorkdir: ({ workspaceDir }) => workspaceDir,
    });
  },
});
