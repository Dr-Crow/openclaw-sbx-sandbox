// Low-level process spawn for the sbx CLI.
// Adapted from Eric Curtin's openclaw/openclaw PR #114168 (MIT).
import { spawn } from "node:child_process";

function abortError() {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Spawn `argv[0]` with `argv.slice(1)`, capturing stdout/stderr as Buffers.
 * Resolves with { stdout, stderr, code }. Rejects on spawn error, abort, timeout,
 * or (unless allowFailure) a non-zero exit.
 * @param {string[]} argv
 * @param {{ input?: Buffer|string, signal?: AbortSignal, timeoutMs?: number, allowFailure?: boolean, env?: NodeJS.ProcessEnv }} [opts]
 */
export function spawnSbx(argv, opts = {}) {
  const [command, ...args] = argv;
  return new Promise((resolve, reject) => {
    if (!command) {
      reject(new Error("sbx command is required"));
      return;
    }
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: opts.env });
    const out = [];
    const err = [];
    let settled = false;
    let timer;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    function onAbort() {
      finish(() => {
        child.kill("SIGTERM");
        reject(abortError());
      });
    }
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        finish(() => {
          child.kill("SIGTERM");
          reject(new Error(`sbx ${args.join(" ")} timed out after ${opts.timeoutMs}ms`));
        });
      }, opts.timeoutMs);
    }
    child.stdout.on("data", (c) => out.push(Buffer.from(c)));
    child.stderr.on("data", (c) => err.push(Buffer.from(c)));
    child.on("error", (error) => {
      finish(() => {
        if (error && error.code === "ENOENT") {
          reject(
            Object.assign(
              new Error(
                `Sandbox backend "sbx" requires the sbx CLI, but "${command}" was not found in PATH. ` +
                  "Install it from https://github.com/docker/sbx-releases or set the plugin's `command` option.",
              ),
              { code: "INVALID_CONFIG", cause: error },
            ),
          );
          return;
        }
        reject(error);
      });
    });
    child.on("close", (code) => {
      finish(() => {
        const stdout = Buffer.concat(out);
        const stderr = Buffer.concat(err);
        const exitCode = code ?? 0;
        if (exitCode !== 0 && !opts.allowFailure) {
          reject(
            Object.assign(
              new Error(stderr.toString("utf8").trim() || `sbx ${args.join(" ")} failed`),
              { code: exitCode, stdout, stderr },
            ),
          );
          return;
        }
        resolve({ stdout, stderr, code: exitCode });
      });
    });
    // Ignore EPIPE if the child exits before reading stdin.
    child.stdin.on("error", () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
