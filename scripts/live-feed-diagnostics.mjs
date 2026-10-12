import assert from "node:assert/strict";

const debugPort = process.env.BRAVE_DEBUG_PORT || "9231";
const targetsUrl = `http://127.0.0.1:${debugPort}/json/list`;
const targets = await fetch(targetsUrl).then((response) => response.json());
const popup = targets.find(
  (target) => target.type === "page" && target.url.endsWith("/src/popup.html")
);

assert.ok(popup?.webSocketDebuggerUrl, "The trusted extension popup tab was not found.");

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
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

  await send("Runtime.enable");
  return { send, evaluate, close: () => socket.close() };
}

const popupClient = await connect(popup);
if (process.env.RELOAD_EXTENSION === "1") {
  try {
    await popupClient.evaluate(`(() => {
      chrome.runtime.reload();
      return "Extension reload requested.";
    })()`);
  } catch {
    // Reloading destroys this execution context immediately on some Chromium builds.
  }
  popupClient.close();
  console.log(JSON.stringify({ extensionReloadRequested: true }, null, 2));
  process.exit(0);
}

try {
  if (process.env.RELOAD_LINKEDIN === "1") {
    for (const target of targets.filter(
      (candidate) => candidate.type === "page" && candidate.url.startsWith("https://www.linkedin.com/")
    )) {
      const pageClient = await connect(target);
      try {
        await pageClient.send("Page.reload", { ignoreCache: true });
      } finally {
        pageClient.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 7000));
  }

  const extensionState = await popupClient.evaluate(`(async () => {
    const { jevSettings = {}, jevSlopCacheV2 = {} } = await chrome.storage.local.get([
      "jevSettings",
      "jevSlopCacheV2"
    ]);
    const classifier = await import(chrome.runtime.getURL("src/classifier.js"));
    const context = await classifier.getClassifierContext();
    const tabs = await chrome.tabs.query({ url: "https://www.linkedin.com/*" });
    const feeds = [];

    for (const tab of tabs) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: "JEV_GET_DIAGNOSTICS" });
        feeds.push({ tabId: tab.id, active: tab.active, url: tab.url, response });
      } catch (error) {
        feeds.push({
          tabId: tab.id,
          active: tab.active,
          url: tab.url,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const cacheEntries = Object.entries(jevSlopCacheV2).map(([key, entry]) => ({
      key,
      score: entry?.result?.slop_score,
      reason: entry?.result?.short_reason,
      cachedAt: entry?.cachedAt
    }));
    const extractedKeys = new Set(
      feeds.flatMap((feed) => feed.response?.diagnostics?.extractedPosts || [])
        .map((post) => post.cacheKey)
    );

    return {
      settings: {
        hasKey: typeof jevSettings.authToken === "string" && jevSettings.authToken.trim().length > 0,
        mockModeFlag: jevSettings.mockMode,
        effectiveMode: context.mode,
        model: context.model
      },
      feeds,
      cache: {
        totalEntries: cacheEntries.length,
        namespaces: cacheEntries.reduce((counts, entry) => {
          const namespace = entry.key.split("|")[0];
          counts[namespace] = (counts[namespace] || 0) + 1;
          return counts;
        }, {}),
        matchesCurrentExtractions: cacheEntries.filter((entry) =>
          extractedKeys.has(entry.key.slice(entry.key.indexOf("|") + 1))
        ),
        veryLowScores: cacheEntries.filter((entry) => entry.score <= 5).slice(-20)
      }
    };
  })()`);

  const pageBadges = [];
  for (const target of targets.filter(
    (candidate) => candidate.type === "page" && candidate.url.startsWith("https://www.linkedin.com/")
  )) {
    const pageClient = await connect(target);
    try {
      pageBadges.push({
        targetId: target.id,
        url: target.url,
        badges: await pageClient.evaluate(`Array.from(
          document.querySelectorAll(".jev-slop-badge-wrap")
        ).map((badge) => ({
          cacheKey: badge.dataset.jevPostKey,
          label: badge.querySelector(".jev-slop-badge")?.textContent?.trim(),
          reason: badge.querySelector(".jev-slop-reason")?.textContent?.trim(),
          hidden: badge.hidden
        }))`)
      });
    } finally {
      pageClient.close();
    }
  }

  console.log(JSON.stringify({ extensionState, pageBadges }, null, 2));
} finally {
  popupClient.close();
  await fetch(`http://127.0.0.1:${debugPort}/json/close/${popup.id}`).catch(() => {});
}
