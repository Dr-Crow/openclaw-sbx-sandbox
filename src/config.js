// Plugin config resolution. The manifest JSON schema is the contract the host enforces;
// this re-validates so the module is safe to use (and test) on its own.

export const DEFAULTS = Object.freeze({
  command: "sbx",
  agent: "shell",
  pull: "missing",
  timeoutMs: 120_000,
});

const MAX_TIMEOUT_SECONDS = 2_147_000;
const PULL = new Set(["always", "missing", "never"]);
const KEYS = new Set([
  "command",
  "agent",
  "template",
  "pull",
  "cpus",
  "memory",
  "kits",
  "staticMcp",
  "timeoutSeconds",
]);

function str(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid sbx plugin config: ${name} must be a non-empty string`);
  }
  return value.trim();
}

function strList(name, value) {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid sbx plugin config: ${name} must be an array of strings`);
  }
  return value.map((v, i) => str(`${name}[${i}]`, v));
}

/**
 * @param {unknown} raw plugins.entries.sbx.config
 * @returns {{command:string, agent:string, template?:string, pull:string, cpus?:number, memory?:string, kits:string[], staticMcp:string[], timeoutMs:number}}
 */
export function resolveConfig(raw) {
  const cfg = raw ?? {};
  if (typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error("Invalid sbx plugin config: expected an object");
  }
  for (const key of Object.keys(cfg)) {
    if (!KEYS.has(key)) throw new Error(`Invalid sbx plugin config: unknown option "${key}"`);
  }
  if (cfg.pull !== undefined && !PULL.has(cfg.pull)) {
    throw new Error("Invalid sbx plugin config: pull must be one of always, missing, never");
  }
  if (cfg.cpus !== undefined && !(Number.isInteger(cfg.cpus) && cfg.cpus >= 1)) {
    throw new Error("Invalid sbx plugin config: cpus must be an integer >= 1");
  }
  if (cfg.memory !== undefined && !/^\d+[kmgKMG]?[bB]?$/.test(String(cfg.memory).trim())) {
    throw new Error('Invalid sbx plugin config: memory must look like "512m" or "8g"');
  }
  if (
    cfg.timeoutSeconds !== undefined &&
    !(typeof cfg.timeoutSeconds === "number" && cfg.timeoutSeconds >= 1 && cfg.timeoutSeconds <= MAX_TIMEOUT_SECONDS)
  ) {
    throw new Error(
      `Invalid sbx plugin config: timeoutSeconds must be a number between 1 and ${MAX_TIMEOUT_SECONDS}`,
    );
  }
  return {
    command: cfg.command === undefined ? DEFAULTS.command : str("command", cfg.command),
    agent: cfg.agent === undefined ? DEFAULTS.agent : str("agent", cfg.agent),
    template: cfg.template === undefined ? undefined : str("template", cfg.template),
    pull: cfg.pull ?? DEFAULTS.pull,
    cpus: cfg.cpus,
    memory: cfg.memory === undefined ? undefined : String(cfg.memory).trim(),
    kits: cfg.kits === undefined ? [] : strList("kits", cfg.kits),
    staticMcp: cfg.staticMcp === undefined ? [] : strList("staticMcp", cfg.staticMcp),
    timeoutMs:
      cfg.timeoutSeconds === undefined ? DEFAULTS.timeoutMs : Math.floor(cfg.timeoutSeconds * 1000),
  };
}
