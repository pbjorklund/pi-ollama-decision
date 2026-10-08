import { classify } from "@earendil-works/pi-ai/api/typesafe-system-one";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const origin = "http://127.0.0.1:11435";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function discoverNimble(): Promise<{ id: string; contextWindow: number } | undefined> {
  try {
    const signal = AbortSignal.timeout(1500);
    const tagsResponse = await fetch(`${origin}/api/tags`, { signal, redirect: "error" });
    if (!tagsResponse.ok) return;
    const tags: unknown = await tagsResponse.json();
    if (!isRecord(tags) || !Array.isArray(tags.models)) return;
    const matches = tags.models.filter((model) =>
      isRecord(model) && (model.name === "nimble" || model.name === "nimble:latest"),
    );
    if (matches.length !== 1) return;
    const id = matches[0].name as string;
    const showResponse = await fetch(`${origin}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: id }),
      signal,
      redirect: "error",
    });
    if (!showResponse.ok) return;
    const show: unknown = await showResponse.json();
    if (!isRecord(show) || !Array.isArray(show.capabilities) || !show.capabilities.includes("decision")) return;
    if (!isRecord(show.model_info)) return;
    const architecture = show.model_info["general.architecture"];
    if (typeof architecture !== "string") return;
    const contextWindow = show.model_info[`${architecture}.context_length`];
    if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return;
    return { id, contextWindow };
  } catch {
    return;
  }
}

export default async function (pi: ExtensionAPI) {
  const model = await discoverNimble();
  if (!model) return;
  pi.registerProvider("ollama-decision", {
    baseUrl: `${origin}/v1`,
    apiKey: "ollama",
    models: [{
      type: "classifier",
      id: model.id,
      name: "Nimble (local Ollama)",
      api: "typesafe-system-one",
      baseUrl: `${origin}/v1`,
      input: ["text"],
      contextWindow: model.contextWindow,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    classifiers: { "typesafe-system-one": { classify } },
  });
}
