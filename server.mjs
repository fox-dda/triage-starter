import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";
import { pathToFileURL } from "node:url";

const html = await readFile(new URL("./index.html", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function handleTriage(request, response, model) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }
  if (typeof input?.text !== "string" || !input.text.trim()) {
    return json(response, 400, { status: "invalid_input" });
  }

  const controller = new AbortController();
  let timer;
  try {
    // Race enforces the deadline even if a provider ignores cancellation.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Model timeout"));
        controller.abort();
      }, 300);
    });
    const raw = await Promise.race([
      Promise.resolve().then(() => model(input.text, { signal: controller.signal })),
      deadline,
    ]);
    const result = JSON.parse(raw);
    if (
      !result || typeof result !== "object" || Array.isArray(result) ||
      !["delivery", "pricing", "other"].includes(result.topic) ||
      typeof result.draft !== "string" || !result.draft.trim()
    ) {
      throw new Error("Invalid model response");
    }
    return json(response, 200, { status: "ready", topic: result.topic, draft: result.draft });
  } catch {
    return json(response, 200, { status: "manual_review", topic: null, draft: null });
  } finally {
    clearTimeout(timer);
  }
}

export function createApp({ model = classify } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, model);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
