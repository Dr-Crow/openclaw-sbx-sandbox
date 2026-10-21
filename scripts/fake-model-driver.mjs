#!/usr/bin/env node
// A scripted, OpenAI-compatible "model" for exercising OpenClaw's real tool layer without a real model or key.
// It answers each /v1/chat/completions request with the next tool call from a script and finally a text reply,
// and records how long each tool took (reply sent -> next request received) plus each tool result.
//
//   SCRIPT=script.json PORT=18791 LOG=/tmp/driver.jsonl node scripts/fake-model-driver.mjs
//
// A step may carry {"hostWrite": {"path": "/abs/host/file", "content": "..."}}: written on the host just before the tool call.
// script.json: [{ "label": "write", "tool": "write", "args": { "path": "a.txt", "content": "x" } }, ...]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const port = Number(process.env.PORT ?? 18791);
const script = JSON.parse(fs.readFileSync(process.env.SCRIPT, "utf8").replaceAll("@WORKSPACE@", process.env.WORKSPACE ?? "."));
const logPath = process.env.LOG ?? "/tmp/fake-model-driver.jsonl";
const pending = new Map(); // session -> { step, sentAt }
let runLog = [];
const flush = () => fs.writeFileSync(logPath, runLog.map((r) => JSON.stringify(r)).join("\n") + "\n");

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p?.text ?? "").join("");
  return "";
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const now = performance.now();
    const payload = JSON.parse(body || "{}");
    const toolMsgs = (payload.messages ?? []).filter((m) => m.role === "tool");
    const step = toolMsgs.length;
    // close the previous step: its duration is (now - when we answered it)
    const prev = pending.get("s");
    if (prev && step > 0 && runLog[step - 1] && runLog[step - 1].ms === undefined) {
      const last = toolMsgs[toolMsgs.length - 1];
      runLog[step - 1].ms = Math.round(now - prev.sentAt);
      runLog[step - 1].result = textOf(last.content).replace(/\s+/g, " ").slice(0, 400);
      runLog[step - 1].isError = /error|failed|not found|escapes|denied|refus|ENOENT|unavailable/i.test(runLog[step - 1].result);
      flush();
    }
    if (step === 0) {
      runLog = [];
    }
    const stream = payload.stream === true;
    const id = `chatcmpl-fake-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const next = script[step];
    let delta, finish;
    if (next?.hostWrite) {
      // simulate an edit made on the host while the sandbox is already running
      fs.mkdirSync(path.dirname(next.hostWrite.path), { recursive: true });
      fs.writeFileSync(next.hostWrite.path, next.hostWrite.content);
    }
    if (next) {
      runLog.push({ step, label: next.label ?? next.tool, tool: next.tool });
      delta = { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${step}_${Date.now()}`, type: "function", function: { name: next.tool, arguments: JSON.stringify(next.args ?? {}) } }] };
      finish = "tool_calls";
      flush();
    } else {
      delta = { role: "assistant", content: "script finished" };
      finish = "stop";
    }
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (!stream) {
      res.setHeader("content-type", "application/json");
      const { index: _i, ...tc } = delta.tool_calls?.[0] ?? {};
      res.end(JSON.stringify({ id, object: "chat.completion", created, model: "fake-model", choices: [{ index: 0, message: { role: "assistant", content: delta.content, ...(delta.tool_calls ? { tool_calls: [tc] } : {}) }, finish_reason: finish }], usage }));
    } else {
      res.setHeader("content-type", "text/event-stream");
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ id, object: "chat.completion.chunk", created, model: "fake-model", choices: [{ index: 0, delta, finish_reason: null }] });
      send({ id, object: "chat.completion.chunk", created, model: "fake-model", choices: [{ index: 0, delta: {}, finish_reason: finish }] });
      send({ id, object: "chat.completion.chunk", created, model: "fake-model", choices: [], usage });
      res.write("data: [DONE]\n\n");
      res.end();
    }
    pending.set("s", { sentAt: performance.now() });
  });
});
server.listen(port, "127.0.0.1", () => console.error(`fake model driver on 127.0.0.1:${port}, ${script.length} steps, log ${logPath}`));
