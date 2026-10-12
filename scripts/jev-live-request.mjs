import assert from "node:assert/strict";

const debugPort = process.env.BRAVE_DEBUG_PORT || "9231";
const targetsUrl = `http://127.0.0.1:${debugPort}/json/list`;
const targets = await fetch(targetsUrl).then((response) => response.json());
const popup = targets.find(
  (target) => target.type === "page" && target.url.endsWith("/src/popup.html")
);

assert.ok(popup?.webSocketDebuggerUrl, "The trusted extension popup tab was not found.");

const socket = new WebSocket(popup.webSocketDebuggerUrl);
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
  if (response.exceptionDetails) {
    const details = response.exceptionDetails.exception?.description
      || response.exceptionDetails.text
      || "Evaluation failed.";
    throw new Error(details);
  }
  return response.result.value;
}

const sampleText = [
  "🚨 DISNEY 2027 INTERNSHIPS ARE LIVE!! 🏰✨",
  "",
  "Want to work behind the scenes at Disney? Now is a great time to start looking.",
  "",
  "Disney currently has dozens of internship opportunities across the U.S., with new Spring 2027 roles continuing to be posted. Summer 2027 opportunities are also starting to appear, so getting an early start can make a big difference.",
  "",
  "Some of the areas hiring include:",
  "",
  "→ Marketing & Digital Media",
  "→ Communications",
  "→ Creative & Graphic Design",
  "→ Production & Entertainment",
  "→ Sales",
  "→ Finance & Accounting",
  "→ Technology & Data",
  "→ Engineering",
  "",
  "These internships span different parts of Disney, including Disney Entertainment, Disney Experiences, ESPN, and Corporate, with opportunities connected to teams like ABC, FX, Walt Disney Imagineering, and more.",
  "",
  "I’ve been using Runway to keep up with newly posted internships and find opportunities early.",
  "",
  "Check it out: https://lnkd.in/ebuijGwS",
  "",
  "#Disney #DisneyInternships #Spring2027 #Summer2027 #Internships #CollegeStudents #Runway"
].join("\n");

try {
  await send("Runtime.enable");
  const result = await evaluate(`(async () => {
    const sampleText = ${JSON.stringify(sampleText)};
    const { jevSettings = {} } = await chrome.storage.local.get("jevSettings");
    const authToken = typeof jevSettings.authToken === "string"
      ? jevSettings.authToken.trim()
      : "";

    if (!authToken) {
      return { configured: false };
    }

    const apiUrl = "https://api.typesafe.ai/v1/systemone";
    const classifier = await import(chrome.runtime.getURL("src/classifier.js"));
    const request = classifier.buildJevRequest(sampleText, "jev-latest");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: \`Bearer \${authToken}\`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(request),
        signal: controller.signal
      });

      const rawText = await response.text();
      let responseBody;
      try {
        responseBody = JSON.parse(rawText);
      } catch {
        responseBody = rawText;
      }

      let mappedResult = null;
      let mappingError = null;
      if (response.ok && responseBody && typeof responseBody === "object") {
        try {
          mappedResult = classifier.mapJevResponse(responseBody);
        } catch (error) {
          mappingError = error instanceof Error ? error.message : String(error);
        }
      }

      return {
        configured: true,
        request: {
          url: apiUrl,
          method: "POST",
          headers: {
            Authorization: "Bearer [stored key omitted]",
            "Content-Type": "application/json"
          },
          body: request
        },
        httpStatus: response.status,
        statusText: response.statusText,
        ok: response.ok,
        response: responseBody,
        mappedResult,
        mappingError
      };
    } catch (error) {
      return {
        configured: true,
        request: {
          url: apiUrl,
          method: "POST",
          headers: {
            Authorization: "Bearer [stored key omitted]",
            "Content-Type": "application/json"
          },
          body: request
        },
        networkError: error instanceof Error ? error.message : String(error)
      };
    } finally {
      clearTimeout(timeout);
    }
  })()`);

  console.log(JSON.stringify(result, null, 2));
} finally {
  socket.close();
  await fetch(`http://127.0.0.1:${debugPort}/json/close/${popup.id}`).catch(() => {});
}
