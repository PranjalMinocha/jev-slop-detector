import assert from "node:assert/strict";

const debugPort = process.env.BRAVE_DEBUG_PORT || "9223";
const targetsUrl = `http://127.0.0.1:${debugPort}/json/list`;

class CdpClient {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
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
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }

      for (const listener of this.listeners.get(message.method) || []) {
        listener(message.params);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, 15000);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  waitFor(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const listener = (params) => {
        clearTimeout(timer);
        const listeners = this.listeners.get(method) || [];
        this.listeners.set(method, listeners.filter((item) => item !== listener));
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "Browser evaluation failed.");
  }
  return response.result.value;
}

const targets = await fetch(targetsUrl).then((response) => response.json());
const page = targets.find((target) => target.type === "page");
assert.ok(page?.webSocketDebuggerUrl, "No debuggable Brave page was found.");

const client = new CdpClient(page.webSocketDebuggerUrl);
await client.connect();
await client.send("Page.enable");
await client.send("Runtime.enable");

const consoleMessages = [];
const runtimeErrors = [];
client.on("Runtime.consoleAPICalled", ({ args }) => {
  consoleMessages.push(args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
});
client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
  runtimeErrors.push(exceptionDetails.exception?.description || exceptionDetails.text);
});

const loaded = client.waitFor("Page.loadEventFired", 30000);
await client.send("Page.navigate", {
  url: `https://www.linkedin.com/feed/?jev_extension_e2e=${Date.now()}`
});
await loaded.catch(() => undefined);
await sleep(1500);

const pageLocation = await evaluate(client, "location.href");
assert.match(pageLocation, /^https:\/\/(?:[a-z]+\.)?linkedin\.com\//, "Brave did not reach LinkedIn.");

await evaluate(client, `(() => {
  const makePost = (id, text) => {
    const post = document.createElement("div");
    post.className = "feed-shared-update-v2";
    post.dataset.urn = id;
    post.style.minHeight = "320px";
    const topBar = document.createElement("div");
    topBar.className = "feed-shared-update-v2__top-bar";
    const wrapper = document.createElement("div");
    wrapper.className = "feed-shared-update-v2__description-wrapper";
    const content = document.createElement("div");
    content.className = "update-components-text";
    content.textContent = text;
    wrapper.append(content);
    post.append(topBar, wrapper);
    return post;
  };
  const feed = document.createElement("main");
  feed.id = "fixture-feed";
  feed.dataset.testid = "mainFeed";
  feed.style.minHeight = "2200px";
  feed.append(makePost(
    "urn:li:activity:10001",
    "Here's the truth. This groundbreaking game-changer will unlock your potential. Agree? Comment below. Repost if this resonates."
  ));
  document.body.replaceChildren(feed);
})()`);
await sleep(1000);

const firstPost = await evaluate(client, `(() => {
  const post = document.querySelector("[data-urn='urn:li:activity:10001']");
  const wrapper = Array.from(document.querySelectorAll(".jev-slop-badge-wrap"))
    .find((element) => element.dataset.jevPostKey === "post:urn:li:activity:10001");
  const badge = wrapper?.querySelector(".jev-slop-badge");
  return {
    status: wrapper ? "complete" : undefined,
    rect: post ? Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, post.getBoundingClientRect()[key]])) : null,
    badgeCount: Array.from(document.querySelectorAll(".jev-slop-badge-wrap"))
      .filter((element) => element.dataset.jevPostKey === "post:urn:li:activity:10001").length,
    badgeText: badge?.textContent.trim() || "",
    reason: wrapper?.querySelector(".jev-slop-reason")?.textContent.trim() || "",
    relativeTop: wrapper && post ? wrapper.getBoundingClientRect().top - post.getBoundingClientRect().top : null,
    centerOffset: badge && post
      ? (badge.getBoundingClientRect().left + badge.getBoundingClientRect().width / 2)
        - (post.getBoundingClientRect().left + post.getBoundingClientRect().width / 2)
      : null,
    linkedInDomUntouched: !post?.querySelector(".jev-slop-badge-wrap") && !post?.hasAttribute("data-jev-slop-status")
  };
})()`);

if (firstPost.status !== "complete") {
  console.error(JSON.stringify({
    diagnostic: "First post was not classified",
    pageLocation,
    firstPost,
    consoleMessages,
    runtimeErrors
  }, null, 2));
}

assert.equal(firstPost.status, "complete", `First post status was ${firstPost.status || "missing"}.`);
assert.equal(firstPost.badgeCount, 1, "The first post must have exactly one badge.");
assert.equal(firstPost.linkedInDomUntouched, true, "The badge must not mutate LinkedIn's React-owned post DOM.");
assert.match(firstPost.badgeText, /^AI SLOP \(\d{1,3}\)$/);
assert.ok(firstPost.reason.length > 0, "The first badge must include a reason.");
assert.ok(Math.abs(firstPost.relativeTop) <= 1, "The score banner is not attached to the post's top edge.");
assert.ok(Math.abs(firstPost.centerOffset) <= 1, "The score tab is not centered on the post.");

await evaluate(client, "window.scrollBy({ top: 100, behavior: 'instant' })");
await sleep(100);
const scrolledAlignment = await evaluate(client, `(() => {
  const post = document.querySelector("[data-urn='urn:li:activity:10001']");
  const wrapper = Array.from(document.querySelectorAll(".jev-slop-badge-wrap"))
    .find((element) => element.dataset.jevPostKey === "post:urn:li:activity:10001");
  return {
    relativeTop: wrapper.getBoundingClientRect().top - post.getBoundingClientRect().top,
    postTop: post.getBoundingClientRect().top,
    bannerTop: wrapper.getBoundingClientRect().top
  };
})()`);
assert.ok(Math.abs(scrolledAlignment.relativeTop) <= 1, "The score banner detached from the post while scrolling.");
assert.ok(scrolledAlignment.postTop < firstPost.rect.y, "The fixture did not scroll as expected.");

const firstScore = Number(firstPost.badgeText.match(/\d+/)[0]);
assert.ok(firstScore >= 70, `Expected obvious engagement bait to score high; received ${firstScore}.`);

await evaluate(client, `(() => {
  const firstWrapper = Array.from(document.querySelectorAll(".jev-slop-badge-wrap"))
    .find((element) => element.dataset.jevPostKey === "post:urn:li:activity:10001");
  firstWrapper.querySelector(".jev-slop-badge").click();
  const feed = document.querySelector("#fixture-feed");
  const second = document.createElement("div");
  second.setAttribute("role", "listitem");
  second.dataset.urn = "urn:li:activity:10002";
  const topBar = document.createElement("div");
  topBar.className = "feed-shared-update-v2__top-bar";
  const wrapper = document.createElement("div");
  wrapper.className = "feed-shared-update-v2__description-wrapper";
  const content = document.createElement("div");
  content.dataset.testid = "expandable-text-box";
  content.textContent = "We reduced request latency by 37% in 2026 after profiling three database queries.";
  wrapper.append(content);
  second.append(topBar, wrapper);
  feed.append(second);

  const collapsed = document.createElement("div");
  collapsed.setAttribute("role", "listitem");
  const collapsedTopBar = document.createElement("div");
  collapsedTopBar.className = "feed-shared-update-v2__top-bar";
  const collapsedContent = document.createElement("div");
  collapsedContent.dataset.testid = "expandable-text-box";
  collapsedContent.append("Visible opening. ");
  const clippedContinuation = document.createElement("span");
  clippedContinuation.hidden = true;
  clippedContinuation.textContent = "Here's the truth. This groundbreaking game-changer will unlock your potential. Agree? Comment below. Repost if this resonates.";
  collapsedContent.append(clippedContinuation);
  collapsed.append(collapsedTopBar, collapsedContent);
  feed.append(collapsed);
})()`);
await sleep(1000);

const dynamicPosts = await evaluate(client, `(() => {
  const wrappers = Array.from(document.querySelectorAll(".jev-slop-badge-wrap"));
  const first = wrappers.find((element) => element.dataset.jevPostKey === "post:urn:li:activity:10001");
  const second = wrappers.find((element) => element.dataset.jevPostKey === "post:urn:li:activity:10002");
  const collapsed = wrappers.find((element) => element.dataset.jevPostKey?.startsWith("text:"));
  return {
    tooltipOpened: first.classList.contains("jev-slop-open"),
    secondStatus: second ? "complete" : undefined,
    secondBadges: wrappers.filter((element) => element.dataset.jevPostKey === "post:urn:li:activity:10002").length,
    secondText: second.querySelector(".jev-slop-badge")?.textContent.trim() || "",
    collapsedCacheKey: collapsed?.dataset.jevPostKey || "",
    collapsedText: collapsed?.querySelector(".jev-slop-badge")?.textContent.trim() || ""
  };
})()`);

assert.equal(dynamicPosts.tooltipOpened, true, "Clicking the first badge did not open its tooltip.");
assert.equal(dynamicPosts.secondStatus, "complete", "The dynamically inserted post was not classified.");
assert.equal(dynamicPosts.secondBadges, 1, "The dynamically inserted post must have exactly one badge.");
const secondScore = Number(dynamicPosts.secondText.match(/\d+/)[0]);
assert.ok(secondScore < firstScore, "Concrete writing should score below obvious engagement bait.");
const collapsedFullText = "Visible opening. Here's the truth. This groundbreaking game-changer will unlock your potential. Agree? Comment below. Repost if this resonates.";
assert.match(
  dynamicPosts.collapsedCacheKey,
  new RegExp(`:${collapsedFullText.length}$`),
  "Collapsed extraction did not include the complete textContent."
);
const collapsedScore = Number(dynamicPosts.collapsedText.match(/\d+/)[0]);
assert.ok(
  collapsedScore > secondScore,
  "The slop-heavy collapsed continuation did not affect the classifier score."
);

await evaluate(client, `(() => {
  const original = document.querySelector("[data-urn='urn:li:activity:10001']");
  original.remove();
  const recycled = document.createElement("div");
  recycled.className = "feed-shared-update-v2";
  recycled.dataset.urn = "urn:li:activity:10001";
  const topBar = document.createElement("div");
  topBar.className = "feed-shared-update-v2__top-bar";
  const wrapper = document.createElement("div");
  wrapper.className = "feed-shared-update-v2__description-wrapper";
  const content = document.createElement("div");
  content.className = "update-components-text";
  content.textContent = "Here's the truth. This groundbreaking game-changer will unlock your potential. Agree? Comment below. Repost if this resonates.";
  wrapper.append(content);
  recycled.append(topBar, wrapper);
  document.querySelector("#fixture-feed").prepend(recycled);
})()`);
await sleep(800);

const recycledPost = await evaluate(client, `(() => {
  const wrappers = Array.from(document.querySelectorAll(".jev-slop-badge-wrap"))
    .filter((element) => element.dataset.jevPostKey === "post:urn:li:activity:10001");
  const wrapper = wrappers[0];
  return {
    status: wrapper ? "complete" : undefined,
    badges: wrappers.length,
    text: wrapper?.querySelector(".jev-slop-badge")?.textContent.trim() || ""
  };
})()`);

assert.equal(recycledPost.status, "complete", "A recycled feed card was not classified.");
assert.equal(recycledPost.badges, 1, "A recycled feed card received duplicate badges.");
assert.equal(Number(recycledPost.text.match(/\d+/)[0]), firstScore, "Cached score changed for the same post ID.");
assert.equal(runtimeErrors.length, 0, `Browser runtime errors:\n${runtimeErrors.join("\n")}`);
assert.ok(
  consoleMessages.some((message) => message.includes("[Jev Slop Detector]") && message.includes("started in React-safe overlay mode")),
  "The extension startup log was not observed."
);

console.log(JSON.stringify({
  bravePage: pageLocation,
  firstScore,
  secondScore,
  collapsedScore,
  recycledScore: firstScore,
  jevLogs: consoleMessages.filter((message) => message.includes("[Jev Slop Detector]"))
}, null, 2));

client.close();
