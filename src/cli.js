// Thin wrappers over the sbx CLI.
// Adapted from Eric Curtin's openclaw/openclaw PR #114168 (MIT).
import { spawnSbx } from "./spawn.js";

/** Run the configured sbx binary, buffering output as text. Never rejects on non-zero exit. */
export async function runSbxCli({ config, args, timeoutMs }) {
  try {
    const r = await spawnSbx([config.command, ...args], {
      timeoutMs: timeoutMs ?? config.timeoutMs,
      allowFailure: true,
    });
    return { code: r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8") };
  } catch (error) {
    return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

/** Find a sandbox by name via `sbx ls --json`. Returns the entry or null. */
export async function findSandbox({ config, name }) {
  const r = await runSbxCli({ config, args: ["ls", "--json"] });
  if (r.code !== 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(r.stdout || "[]");
  } catch {
    return null;
  }
  // sbx >= 0.48 prints a bare array; tolerate { sandboxes: [...] } from other builds.
  const entries = Array.isArray(parsed) ? parsed : (parsed?.sandboxes ?? []);
  return entries.find((e) => e && e.name === name) ?? null;
}

/** Stable, sbx-name-safe sandbox name from an OpenClaw scope key. */
export function buildSandboxName(scopeKey) {
  const trimmed = String(scopeKey ?? "").trim() || "session";
  const safe = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  let hash = 5381;
  for (const ch of trimmed) hash = ((hash * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `openclaw-${safe || "session"}-${hash.toString(16).padStart(8, "0").slice(0, 8)}`;
}
