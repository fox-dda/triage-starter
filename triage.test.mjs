import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createApp } from "./server.mjs";

const manual = { status: "manual_review", topic: null, draft: null };

async function serve(t, options) {
  const server = createApp(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(base, body) {
  const response = await fetch(`${base}/api/triage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
  return { status: response.status, body: await response.json() };
}

test("invalid JSON and invalid text return 400 without calling model", async (t) => {
  const base = await serve(t, { model: () => assert.fail("Model must not be called") });
  for (const body of ["", "{", "null", "[]", "{}", '"text"', '{"text":null}',
    '{"text":42}', '{"text":false}', '{"text":[]}', '{"text":{}}', '{"text":""}', '{"text":"  \\n "}']) {
    assert.deepEqual(await post(base, body), { status: 400, body: { status: "invalid_input" } });
  }
});

test("ordinary requests return all supported topics and nonempty drafts", async (t) => {
  const base = await serve(t);
  for (const [text, topic] of [["Доставка заказа", "delivery"], ["Уточните цену", "pricing"], ["Здравствуйте", "other"]]) {
    const response = await post(base, JSON.stringify({ text }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      status: "ready", topic, draft: "Спасибо за обращение. Уточним детали заявки.",
    });
  }
});

test("every mock failure returns manual_review; server recovers", async (t) => {
  const base = await serve(t);
  for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    const start = performance.now();
    assert.deepEqual(await post(base, JSON.stringify({ text: marker })), { status: 200, body: manual });
    if (marker === "[timeout]") assert.ok(performance.now() - start < 1000, "Must not wait for the 1200 ms provider");
  }
  assert.equal((await post(base, '{"text":"Здравствуйте"}')).body.status, "ready");
});

test("deadline also handles a provider ignoring AbortSignal", async (t) => {
  let signal;
  const base = await serve(t, { model: (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  const start = performance.now();
  assert.deepEqual(await post(base, '{"text":"test"}'), { status: 200, body: manual });
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 280 && elapsed < 1000, `Unexpected deadline: ${elapsed} ms`);
  assert.equal(signal.aborted, true);
});

test("invalid model shapes are rejected and extra fields cannot override status", async (t) => {
  let output;
  const base = await serve(t, { model: () => JSON.stringify(output) });
  for (output of [null, [], {}, { topic: "delivery", draft: 1 }, { topic: "pricing", draft: " \n " }]) {
    assert.deepEqual(await post(base, '{"text":"test"}'), { status: 200, body: manual });
  }
  output = { topic: "other", draft: "Ответ", status: "spoofed", extra: true };
  assert.deepEqual((await post(base, '{"text":"test"}')).body, { status: "ready", topic: "other", draft: "Ответ" });
});

test("page clears previous draft on manual review and network failure", async () => {
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const elements = Object.fromEntries(["#result", "#status", "#topic", "#draft", "#message", "button"].map((key) => [key, { textContent: "", value: "test", disabled: false }]));
  let submit;
  const form = { querySelector: (key) => elements[key], addEventListener: (_, handler) => { submit = handler; } };
  let response = { status: "ready", topic: "delivery", draft: "Предыдущий черновик" };
  runInNewContext(script, {
    document: { querySelector: (key) => key === "form" ? form : elements[key] },
    fetch: async () => {
      if (response instanceof Error) throw response;
      return { ok: true, json: async () => response };
    },
  });
  await submit({ preventDefault() {} });
  assert.equal(elements["#draft"].textContent, "Предыдущий черновик");
  assert.equal(elements["#topic"].textContent, "Доставка");
  assert.equal(elements["#result"].hidden, false);
  response = manual;
  await submit({ preventDefault() {} });
  assert.equal(elements["#draft"].textContent, "");
  assert.equal(elements["#topic"].textContent, "");
  assert.equal(elements["#result"].hidden, true);
  assert.match(elements["#status"].textContent, /вручную/);
  response = new Error("Offline");
  await submit({ preventDefault() {} });
  assert.match(elements["#status"].textContent, /сервером/);
  assert.equal(elements.button.disabled, false);
});
