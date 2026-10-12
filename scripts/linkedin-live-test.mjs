import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const debugPort = process.env.BRAVE_DEBUG_PORT || "9231";

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) listener(message.params);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, 20000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  waitFor(method, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const listener = (params) => {
        clearTimeout(timer);
        this.listeners.set(method, (this.listeners.get(method) || []).filter((item) => item !== listener));
        resolve(params);
      };
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
      this.on(method, listener);
    });
  }

  close() {
    this.socket.close();
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "Evaluation failed.");
  return response.result.value;
}

const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
const page = targets.find((target) => target.type === "page" && target.url.startsWith("https://www.linkedin.com/feed"));
assert.ok(page?.webSocketDebuggerUrl, "The authenticated LinkedIn feed tab was not found.");

const client = new CdpClient(page.webSocketDebuggerUrl);
await client.connect();
await client.send("Page.enable");
await client.send("Runtime.enable");

const jevLogs = [];
const runtimeErrors = [];
client.on("Runtime.consoleAPICalled", ({ args }) => {
  const message = args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
  if (message.includes("[Jev Slop Detector]")) jevLogs.push(message);
});
client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
  runtimeErrors.push(exceptionDetails.exception?.description || exceptionDetails.text);
});

const loaded = client.waitFor("Page.loadEventFired", 30000);
await client.send("Page.reload", { ignoreCache: true });
await loaded.catch(() => undefined);
await sleep(5000);

for (let index = 0; index < 3; index += 1) {
  await evaluate(client, "window.scrollBy({ top: Math.round(window.innerHeight * 0.78), behavior: 'instant' })");
  await sleep(1800);
}

const report = await evaluate(client, `(() => {
  const selectors = [
    "[data-testid='mainFeed'] [role='listitem']",
    "[data-testid='main-feed'] [role='listitem']",
    ".occludable-update",
    ".feed-shared-update-v2",
    "div[data-view-name='feed-full-update']",
    "div[data-urn^='urn:li:activity:']",
    "div[data-urn^='urn:li:ugcPost:']"
  ];
  const allTestIds = Array.from(new Set(
    Array.from(document.querySelectorAll("[data-testid]"), (element) => element.getAttribute("data-testid"))
  )).filter(Boolean);
  const allViewNames = Array.from(new Set(
    Array.from(document.querySelectorAll("[data-view-name]"), (element) => element.getAttribute("data-view-name"))
  )).filter(Boolean);
  const listItems = Array.from(document.querySelectorAll("[role='listitem']"));
  const sampleListItems = listItems.slice(0, 12).map((element) => ({
    tag: element.tagName,
    classes: Array.from(element.classList).slice(0, 8),
    testid: element.getAttribute("data-testid"),
    parentTestid: element.parentElement?.getAttribute("data-testid"),
    parentRole: element.parentElement?.getAttribute("role"),
    textLength: (element.innerText || "").trim().length,
    hasCommentary: Boolean(element.querySelector("[data-testid*='commentary'], [data-view-name='feed-commentary'], .update-components-text")),
    hasReactionButton: Boolean(element.querySelector("button[aria-label*='Like'], button[aria-label*='Reaction']")),
    rect: {
      top: Math.round(element.getBoundingClientRect().top),
      width: Math.round(element.getBoundingClientRect().width),
      height: Math.round(element.getBoundingClientRect().height)
    }
  }));
  const postStructures = listItems
    .filter((element) => element.querySelector("button[aria-label*='Like'], button[aria-label*='Reaction']"))
    .slice(0, 2)
    .map((post) => Array.from(post.querySelectorAll("*"))
      .map((element) => {
        const directText = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent.trim())
          .filter(Boolean)
          .join(" ");
        return {
          tag: element.tagName,
          role: element.getAttribute("role"),
          aria: element.getAttribute("aria-label"),
          testid: element.getAttribute("data-testid"),
          viewName: element.getAttribute("data-view-name"),
          dir: element.getAttribute("dir"),
          directText: directText.slice(0, 160),
          top: Math.round(element.getBoundingClientRect().top),
          height: Math.round(element.getBoundingClientRect().height)
        };
      })
      .filter((item) => item.directText || item.role || item.aria || item.testid || item.viewName)
      .slice(0, 160));
  const badgeControlOverlaps = Array.from(document.querySelectorAll(".jev-slop-badge:not([hidden])"))
    .map((badge) => {
      const badgeRect = badge.getBoundingClientRect();
      const wrapperRect = badge.closest(".jev-slop-badge-wrap")?.getBoundingClientRect();
      const post = listItems.find((item) => {
        const rect = item.getBoundingClientRect();
        return wrapperRect && Math.abs(wrapperRect.left - rect.left) < 4
          && Math.abs(wrapperRect.top - rect.top) < 4
          && Math.abs(wrapperRect.width - rect.width) < 4;
      });
      const overlappingControls = post
        ? Array.from(post.querySelectorAll("button, a"))
          .filter((control) => {
            const rect = control.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0
              && badgeRect.left < rect.right && badgeRect.right > rect.left
              && badgeRect.top < rect.bottom && badgeRect.bottom > rect.top;
          })
          .map((control) => control.getAttribute("aria-label") || control.textContent.trim())
          .filter(Boolean)
        : ["Could not associate banner with a post"];
      return overlappingControls;
    });
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    selectorCounts: Object.fromEntries(selectors.map((selector) => [selector, document.querySelectorAll(selector).length])),
    roleListItems: listItems.length,
    allTestIds: allTestIds.slice(0, 100),
    allViewNames: allViewNames.slice(0, 150),
    textExtractionSamples: Array.from(document.querySelectorAll("[data-testid='expandable-text-box']"))
      .slice(0, 4)
      .map((element) => ({
        innerTextLength: (element.innerText || "").replace(/\\s+/g, " ").trim().length,
        textContentLength: (element.textContent || "").replace(/\\s+/g, " ").trim().length,
        sameText: (element.innerText || "").replace(/\\s+/g, " ").trim()
          === (element.textContent || "").replace(/\\s+/g, " ").trim(),
        hasMoreButton: Boolean(element.parentElement?.querySelector("[data-testid='expandable-text-button']")),
        ending: (element.textContent || "").replace(/\\s+/g, " ").trim().slice(-120)
      })),
    sampleListItems,
    postStructures,
    overlayRoots: document.querySelectorAll(".jev-slop-overlay-root").length,
    badges: document.querySelectorAll(".jev-slop-badge").length,
    visibleBadges: Array.from(document.querySelectorAll(".jev-slop-badge-wrap")).filter((element) => !element.hidden).length,
    badgeControlOverlaps
  };
})()`);

const interaction = await evaluate(client, `(() => {
  const wrapper = Array.from(document.querySelectorAll(".jev-slop-badge-wrap:not([hidden])"))[0];
  const button = wrapper?.querySelector(".jev-slop-badge");
  if (!wrapper || !button) return { available: false };
  button.click();
  const result = {
    available: true,
    badgeText: button.textContent.trim(),
    tooltipOpened: wrapper.classList.contains("jev-slop-open"),
    reason: wrapper.querySelector(".jev-slop-reason")?.textContent.trim() || ""
  };
  button.click();
  return result;
})()`);

const screenshot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
await writeFile("/tmp/jev-linkedin-live.png", Buffer.from(screenshot.data, "base64"));

const outputReport = { ...report };
if (process.env.LIVE_VERBOSE !== "1") {
  delete outputReport.sampleListItems;
  delete outputReport.postStructures;
}
console.log(JSON.stringify({ report: outputReport, interaction, jevLogs, runtimeErrors: runtimeErrors.slice(0, 10) }, null, 2));
client.close();
