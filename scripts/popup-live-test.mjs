import assert from "node:assert/strict";

const debugPort = process.env.BRAVE_DEBUG_PORT || "9231";
const targetsUrl = `http://127.0.0.1:${debugPort}/json/list`;
const targets = await fetch(targetsUrl).then((response) => response.json());
const page = targets.find((target) => target.type === "page" && target.url.endsWith("/src/popup.html"));
assert.ok(page?.webSocketDebuggerUrl, "The extension popup test tab was not found.");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  message.error ? reject(new Error(message.error.message)) : resolve(message.result);
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "Evaluation failed.");
  return response.result.value;
}

await send("Runtime.enable");
await new Promise((resolve) => setTimeout(resolve, 300));

const initial = await evaluate(`({
  apiHeading: document.querySelector("#api-settings-title")?.textContent,
  hasPasswordInput: document.querySelector("#api-key")?.type === "password",
  mode: document.querySelector("#api-mode")?.textContent
})`);
assert.equal(initial.apiHeading, "Jev API");
assert.equal(initial.hasPasswordInput, true);

await evaluate(`(() => {
  document.querySelector("#api-key").value = "popup-test-key";
  document.querySelector("#api-key-form").requestSubmit();
})()`);
await new Promise((resolve) => setTimeout(resolve, 250));

const saved = await evaluate(`(async () => {
  const { jevSettings = {} } = await chrome.storage.local.get("jevSettings");
  return {
    hasKey: jevSettings.authToken === "popup-test-key",
    mockMode: jevSettings.mockMode,
    modeText: document.querySelector("#api-mode")?.textContent,
    removeVisible: !document.querySelector("#use-mock")?.hidden
  };
})()`);
assert.equal(saved.hasKey, true);
assert.equal(saved.mockMode, false);
assert.equal(saved.removeVisible, true);

await evaluate(`document.querySelector("#use-mock").click()`);
await new Promise((resolve) => setTimeout(resolve, 250));

const cleared = await evaluate(`(async () => {
  const { jevSettings = {} } = await chrome.storage.local.get("jevSettings");
  return {
    hasKey: typeof jevSettings.authToken === "string",
    mockMode: jevSettings.mockMode,
    modeText: document.querySelector("#api-mode")?.textContent
  };
})()`);
assert.equal(cleared.hasKey, false);
assert.equal(cleared.mockMode, true);

console.log(JSON.stringify({ initial, saved: { ...saved, hasKey: true }, cleared }, null, 2));
socket.close();
await fetch(`http://127.0.0.1:${debugPort}/json/close/${page.id}`);
