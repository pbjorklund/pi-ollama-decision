import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

for (const available of [true, false]) {
  test(`standalone Pi loads a dependency-free package with service ${available ? "available" : "absent"}`, async (t) => {
    const dir = await mkdtemp(join("/tmp", "ollama-binary-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await copyFile(new URL("../pi-extension.ts", import.meta.url), join(dir, "pi-extension.ts"));
    await copyFile(new URL("../package.json", import.meta.url), join(dir, "package.json"));
    const report = join(dir, "report.json");
    await writeFile(join(dir, "probe.ts"), `
import { writeFileSync } from "node:fs";
import extension from "./pi-extension.ts";
export default async function (pi) {
  let decisionTool;
  const registerTool = pi.registerTool.bind(pi);
  pi.registerTool = (tool) => { if (tool.name === "decision_check") decisionTool = tool; registerTool(tool); };
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (!path.startsWith("http://127.0.0.1:11435/")) throw new Error("Unexpected network request");
    if (!${available}) throw new TypeError("fetch failed");
    if (path.endsWith("/api/tags")) return Response.json({ models: [{ name: "nimble:latest" }] });
    if (path.endsWith("/api/show")) return Response.json({ capabilities: ["decision"], model_info: { "general.architecture": "qwen35", "qwen35.context_length": 262144 } });
    if (path.endsWith("/v1/systemone")) return Response.json({ answers: {
      ok: { type: "noul", noul: 0.9 },
      contamination: { type: "noul", noul: 0.01 },
      decision: { type: "choice", choice: "bug", probabilities: { bug: 0.95, billing: 0.03, insufficient_evidence: 0.02 }, confidence: 0.7 },
    }, usage: { input_tokens: 10, output_tokens: 1 } });
    throw new Error("Unexpected local request");
  };
  await extension(pi);
  pi.registerCommand("provider-regression", {
    handler: async (_args, ctx) => {
      const models = await ctx.modelRegistry.getAvailableOfType("classifier", "ollama-decision");
      const result = models.length ? await ctx.modelRegistry.classify(models[0], {
        state: { message: "Synthetic test" },
        questions: { ok: { type: "bool", instructions: "OK?", criteria: { true: "Yes", false: "No" } } },
      }) : undefined;
      const toolResult = decisionTool ? await decisionTool.execute("probe", {
        evidence: "Synthetic checkout HTTP 500", question: "Which category?",
        alternatives: [{ label: "bug", description: "Software failure" }, { label: "billing", description: "Charge issue" }],
      }, undefined, undefined, ctx) : undefined;
      writeFileSync(${JSON.stringify(report)}, JSON.stringify({ models, result, toolResult, toolRegistered: !!decisionTool, activeTool: pi.getActiveTools().includes("decision_check") }));
    },
  });
}
`);
    const child = spawn("pi", [
      "--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-mcp", "--no-session",
      "-e", join(dir, "probe.ts"), "--mode", "rpc",
    ], { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), JITI_FS_CACHE: "0", JITI_MODULE_CACHE: "0" }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    t.after(() => child.kill("SIGTERM"));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Pi RPC timed out: ${stderr} ${stdout}`)); }, 15000);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Pi exited ${code}: ${stderr} ${stdout}`)); });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const lines = stdout.split("\n").filter(Boolean);
        for (const line of lines) {
          let response;
          try { response = JSON.parse(line); } catch { continue; }
          if (response.id !== "probe" || response.type !== "response") continue;
          clearTimeout(timer);
          if (!response.success) reject(new Error(line));
          else resolve();
        }
      });
      child.stdin.write(`${JSON.stringify({ id: "probe", type: "prompt", message: "/provider-regression" })}\n`);
    });
    const data = JSON.parse(await readFile(report, "utf8"));
    assert.equal(data.models.length, available ? 1 : 0);
    assert.equal(data.toolRegistered, available);
    assert.equal(data.activeTool, available);
    if (available) {
      assert.equal(data.toolResult.structuredContent.status, "advisory");
      assert.equal(data.toolResult.structuredContent.choice, "bug");
      assert.equal(data.toolResult.usage.totalTokens, 11);
      assert.equal(data.models[0].contextWindow, 8192);
      assert.equal(data.result.stopReason, "stop", data.result.errorMessage);
      assert.deepEqual(data.result.answers.ok, { type: "bool", probability: 0.9 });
    }
    assert.doesNotMatch(stderr + stdout, /Failed to load extension|Cannot find module|Extension package .*warning/);
  });
}
