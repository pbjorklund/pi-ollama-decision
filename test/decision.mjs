import assert from "node:assert/strict";
import test from "node:test";
import extension from "../pi-extension.ts";

const params = {
  evidence: "Synthetic: checkout returns HTTP 500.",
  question: "Which category does the evidence support?",
  alternatives: [
    { label: "bug", description: "Software malfunction" },
    { label: "billing", description: "Charge or invoice issue" },
  ],
};
const good = {
  stopReason: "stop", answers: { contamination: { type: "bool", probability: 0.01 }, decision: {
    type: "choice", choice: "bug",
    probabilities: { bug: 0.95, billing: 0.03, insufficient_evidence: 0.02 }, confidence: 0.7,
  } }, usage: { input: 10, output: 1, totalTokens: 11, cost: { total: 0 } },
};
async function tool(t) {
  t.mock.method(globalThis, "fetch", async (url) => Response.json(String(url).endsWith("/api/tags")
    ? { models: [{ name: "nimble:latest" }] }
    : { capabilities: ["decision"], model_info: { "general.architecture": "qwen3", "qwen3.context_length": 8192 } }));
  const tools = [];
  await extension({ registerProvider() {}, registerTool: (x) => tools.push(x) });
  assert.equal(tools.length, 1, "decision tool must be registered alongside the classifier");
  return tools[0];
}
function context(result = good) {
  const calls = [];
  return { calls, modelRegistry: {
    getAvailableOfType: async () => [{ id: "nimble:latest", provider: "ollama-decision" }],
    classify: async (...args) => { calls.push(args); return result; },
  } };
}

test("decision_check supplies fixed safety guidance and bounded local inference", async (t) => {
  const def = await tool(t);
  assert.equal(def.name, "decision_check");
  assert.equal(def.exposure, "direct", "The advisory tool must be available without chat-generated classifier scripts");
  assert.equal(def.annotations.readOnlyHint, true);
  assert.ok(def.promptGuidelines.some((s) => s.includes("permissions")));
  const ctx = context();
  const r = await def.execute("id", params, undefined, undefined, ctx);
  assert.equal(r.structuredContent.status, "advisory");
  assert.equal(r.structuredContent.choice, "bug");
  assert.equal(r.structuredContent.confidence, 0.7);
  assert.deepEqual(r.usage, good.usage);
  assert.equal(ctx.calls.length, 1);
  assert.deepEqual(ctx.calls[0][1].state, { evidence: params.evidence });
  assert.ok(ctx.calls[0][1].questions.decision.criteria.insufficient_evidence);
  assert.equal(ctx.calls[0][2].maxRetries, 0);
  assert.ok(ctx.calls[0][2].signal instanceof AbortSignal);
});

for (const [name, answer] of [
  ["low probability", { ...good.answers.decision, probabilities: { bug: 0.57, billing: 0.34, insufficient_evidence: 0.09 } }],
  ["unknown", { ...good.answers.decision, choice: "insufficient_evidence", probabilities: { bug: 0.02, billing: 0.02, insufficient_evidence: 0.96 } }],
]) {
  test(`${name} abstains rather than recommending an action`, async (t) => {
    const def = await tool(t);
    const r = await def.execute("id", params, undefined, undefined, context({ ...good, answers: { ...good.answers, decision: answer } }));
    assert.equal(r.structuredContent.status, "inconclusive");
    assert.equal(r.structuredContent.choice, null);
  });
}

for (const [name, result] of [
  ["provider error", { stopReason: "error", errorMessage: "secret customer payload", answers: {} }],
  ["missing answer", { ...good, answers: {} }],
  ["extra answer", { ...good, answers: { ...good.answers, extra: good.answers.decision } }],
  ["wrong type", { ...good, answers: { ...good.answers, decision: { type: "bool", probability: 0.9 } } }],
  ["invalid sum", { ...good, answers: { ...good.answers, decision: { ...good.answers.decision, probabilities: { bug: 0.95, billing: 0.5, insufficient_evidence: 0.2 } } } }],
  ["wrong selected label", { ...good, answers: { ...good.answers, decision: { ...good.answers.decision, choice: "billing" } } }],
]) {
  test(`${name} is inconclusive with no upstream payload leak`, async (t) => {
    const def = await tool(t);
    const r = await def.execute("id", params, undefined, undefined, context(result));
    assert.equal(r.structuredContent.status, "inconclusive");
    assert.equal(r.structuredContent.choice, null);
    assert.equal(r.isError, true);
    assert.doesNotMatch(JSON.stringify(r), /secret customer payload/);
  });
}

test("possible answer-controlling instructions abstain even with high selected probability", async (t) => {
  const def = await tool(t);
  const ctx = context({ ...good, answers: { ...good.answers, contamination: { type: "bool", probability: 0.99 } } });
  const r = await def.execute("id", params, undefined, undefined, ctx);
  assert.equal(r.structuredContent.status, "inconclusive");
  assert.equal(r.structuredContent.choice, null);
  assert.notEqual(r.isError, true);
});

test("unavailable model and cancelled call never dispatch inference", async (t) => {
  const def = await tool(t);
  const ctx = context();
  ctx.modelRegistry.getAvailableOfType = async () => [];
  const r = await def.execute("id", params, undefined, undefined, ctx);
  assert.equal(r.structuredContent.status, "inconclusive");
  assert.equal(ctx.calls.length, 0);
  const controller = new AbortController(); controller.abort();
  const cancelled = await def.execute("id", params, controller.signal, undefined, context());
  assert.equal(cancelled.isError, true);
});

for (const invalid of [
  { ...params, evidence: " " },
  { ...params, evidence: "x".repeat(4001) },
  { ...params, alternatives: [params.alternatives[0], params.alternatives[0]] },
  { ...params, alternatives: [{ label: "insufficient_evidence", description: "Override" }, params.alternatives[1]] },
]) {
  test("invalid tool arguments are rejected before classification", async (t) => {
    const def = await tool(t); const ctx = context();
    await assert.rejects(() => def.execute("id", invalid, undefined, undefined, ctx), /Invalid decision input/);
    assert.equal(ctx.calls.length, 0);
  });
}
