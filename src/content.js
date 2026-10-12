(function runJevSlopDetector() {
  "use strict";

  const LOG_PREFIX = "[Jev Slop Detector]";
  const MIN_TEXT_LENGTH = 12;
  const dom = globalThis.JevLinkedInDom;

  if (!dom) {
    console.error(LOG_PREFIX, "LinkedIn DOM adapter did not load.");
    return;
  }

  const observedPosts = new WeakSet();
  const postState = new WeakMap();
  const pendingRoots = new Set();
  const activeBadges = new Set();
  const extractedPosts = [];
  let scanScheduled = false;
  let layoutScheduled = false;
  let badgeRoot = null;
  const diagnostics = {
    version: chrome.runtime.getManifest().version,
    started: false,
    scans: 0,
    candidatesFound: 0,
    observed: 0,
    classified: 0,
    skipped: 0,
    errors: 0,
    lastError: null,
    classificationSource: null
  };

  const visibilityObserver = new IntersectionObserver(onVisibilityChange, {
    root: null,
    rootMargin: "100px 0px 200px",
    threshold: 0.08
  });
  const postResizeObserver = new ResizeObserver(scheduleBadgeLayout);

  function debug(...args) {
    console.debug(LOG_PREFIX, ...args);
  }

  function hashText(text) {
    // FNV-1a, represented as unsigned hex. Fast and deterministic; this is a
    // cache key, not a security primitive.
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function makeCacheKey(postId, text) {
    return postId ? `post:${postId}` : `text:${hashText(text)}:${text.length}`;
  }

  function registerPost(post) {
    const existingState = postState.get(post);
    if (existingState?.result && !existingState.badge?.isConnected) {
      injectBadge(post, existingState.result, existingState.cacheKey);
      return;
    }

    if (observedPosts.has(post)) {
      return;
    }

    observedPosts.add(post);
    diagnostics.observed += 1;
    visibilityObserver.observe(post);
  }

  function scheduleScan(root) {
    if (root instanceof Element || root instanceof Document) {
      pendingRoots.add(root);
    }
    if (scanScheduled) {
      return;
    }

    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      const roots = Array.from(pendingRoots);
      pendingRoots.clear();
      diagnostics.scans += 1;

      for (const scanRoot of roots) {
        const posts = dom.findPosts(scanRoot);
        for (const post of posts) {
          registerPost(post);
        }

        if (scanRoot instanceof Element) {
          const containingPost = dom.findContainingPost(scanRoot);
          if (containingPost) {
            registerPost(containingPost);
          }
        }
      }
    });
  }

  function onVisibilityChange(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }

      visibilityObserver.unobserve(entry.target);
      void processPost(entry.target);
    }
  }

  async function processPost(post) {
    if (!post.isConnected || postState.get(post)?.status === "processing") {
      return;
    }

    const text = dom.getPostText(post);
    const postId = dom.getPostId(post);
    const cacheKey = text ? makeCacheKey(postId, text) : null;
    if (text) recordExtraction(cacheKey, text);
    if (text.length < MIN_TEXT_LENGTH) {
      postState.set(post, { status: "skipped" });
      diagnostics.skipped += 1;
      debug("Skipped an empty, image-only, or very short post.");
      return;
    }

    postState.set(post, { status: "processing", cacheKey });

    try {
      const response = await sendMessage({
        type: "JEV_CLASSIFY_POST",
        payload: { text, cacheKey, postId }
      });

      if (!response?.ok || !isValidResult(response.result)) {
        throw new Error(response?.error || "Classifier returned an invalid response.");
      }

      const result = response.result;
      diagnostics.classificationSource = response.source || diagnostics.classificationSource;
      if (post.isConnected) {
        injectBadge(post, result, cacheKey);
      }
      diagnostics.classified += 1;
      debug(`Scored ${postId || cacheKey}: ${result.slop_score}`, response.cached ? "(cached)" : "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      postState.set(post, { status: "error", cacheKey });
      diagnostics.errors += 1;
      diagnostics.lastError = message;
      console.warn(LOG_PREFIX, "Could not classify post:", message);
      if (post.isConnected) {
        injectErrorBadge(post, message, cacheKey);
      }
    }
  }

  function recordExtraction(cacheKey, text) {
    const previousIndex = extractedPosts.findIndex((entry) => entry.cacheKey === cacheKey);
    if (previousIndex >= 0) extractedPosts.splice(previousIndex, 1);
    extractedPosts.unshift({ cacheKey, text, textLength: text.length });
    if (extractedPosts.length > 5) extractedPosts.length = 5;
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function isValidResult(result) {
    return (
      Number.isInteger(result?.slop_score) &&
      result.slop_score >= 0 &&
      result.slop_score <= 100 &&
      typeof result.short_reason === "string" &&
      result.short_reason.length > 0
    );
  }

  function scoreLevel(score) {
    if (score >= 70) return "high";
    if (score >= 35) return "medium";
    return "low";
  }

  function injectBadge(post, result, cacheKey) {
    const existingState = postState.get(post);
    if (existingState?.badge?.isConnected) {
      return;
    }

    const level = scoreLevel(result.slop_score);
    const wrapper = document.createElement("span");
    wrapper.className = "jev-slop-badge-wrap";
    wrapper.dataset.level = level;
    wrapper.dataset.jevPostKey = cacheKey;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "jev-slop-badge";
    button.setAttribute("aria-label", `AI slop score ${result.slop_score}. ${result.short_reason}`);
    button.setAttribute("aria-expanded", "false");
    button.title = result.short_reason;

    const dot = document.createElement("span");
    dot.className = "jev-slop-dot";
    dot.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.textContent = level === "low"
      ? `NOT SLOP · ${result.slop_score}`
      : level === "medium"
        ? `SLOP · ${result.slop_score}`
        : `AI SLOP (${result.slop_score})`;

    const reason = document.createElement("span");
    reason.className = "jev-slop-reason";
    reason.setAttribute("role", "tooltip");
    reason.textContent = result.short_reason;

    button.append(dot, label);
    wrapper.append(button, reason);

    if (level === "high") {
      const revealButton = document.createElement("button");
      revealButton.type = "button";
      revealButton.className = "jev-slop-reveal";
      revealButton.textContent = "Show post anyway";
      revealButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        wrapper.classList.add("jev-slop-revealed");
        button.setAttribute("aria-label", `AI slop score ${result.slop_score}. Hide this post again.`);
        scheduleBadgeLayout();
      });
      wrapper.append(revealButton);

      button.addEventListener("click", () => {
        if (wrapper.classList.contains("jev-slop-revealed")) {
          wrapper.classList.remove("jev-slop-revealed");
          button.setAttribute("aria-label", `AI slop score ${result.slop_score}. ${result.short_reason}`);
          scheduleBadgeLayout();
        }
      });
    }

    bindBadgeInteractions(wrapper, button);
    mountBadge(post, wrapper);
    postState.set(post, { status: "complete", cacheKey, result, badge: wrapper });
  }

  function injectErrorBadge(post, errorMessage, cacheKey) {
    const existingState = postState.get(post);
    if (existingState?.badge?.isConnected) {
      return;
    }

    const wrapper = document.createElement("span");
    wrapper.className = "jev-slop-badge-wrap";
    wrapper.dataset.level = "error";
    wrapper.dataset.jevPostKey = cacheKey;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "jev-slop-badge";
    button.textContent = "SLOP —";
    button.setAttribute("aria-expanded", "false");

    const reason = document.createElement("span");
    reason.className = "jev-slop-reason";
    reason.setAttribute("role", "tooltip");
    reason.textContent = `Unable to score this post. ${errorMessage}`;

    wrapper.append(button, reason);
    bindBadgeInteractions(wrapper, button);
    mountBadge(post, wrapper);
    postState.set(post, { status: "error", cacheKey, badge: wrapper });
  }

  function bindBadgeInteractions(wrapper, button) {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = wrapper.classList.toggle("jev-slop-open");
      button.setAttribute("aria-expanded", String(open));
    });

    button.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        wrapper.classList.remove("jev-slop-open");
        button.setAttribute("aria-expanded", "false");
        button.blur();
      }
    });
  }

  function mountBadge(post, wrapper) {
    ensureBadgeRoot().append(wrapper);
    activeBadges.add({ post, element: wrapper });
    postResizeObserver.observe(post);
    scheduleBadgeLayout();
  }

  function ensureBadgeRoot() {
    if (badgeRoot?.isConnected) {
      return badgeRoot;
    }

    badgeRoot = document.createElement("div");
    badgeRoot.className = "jev-slop-overlay-root";
    badgeRoot.setAttribute("aria-label", "Jev Slop Detector scores");
    document.documentElement.append(badgeRoot);
    return badgeRoot;
  }

  function scheduleBadgeLayout() {
    if (layoutScheduled) return;
    layoutScheduled = true;
    requestAnimationFrame(() => {
      layoutScheduled = false;
      positionBadges();
    });
  }

  function positionBadges() {
    for (const entry of Array.from(activeBadges)) {
      const { post, element } = entry;
      if (!post.isConnected || !element.isConnected) {
        postResizeObserver.unobserve(post);
        element.remove();
        activeBadges.delete(entry);
        continue;
      }

      const rect = post.getBoundingClientRect();
      const visible = rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0 && rect.height > 0;
      element.hidden = !visible;
      if (!visible) continue;

      // Anchor the banner to document coordinates. Unlike a fixed viewport
      // badge, it now moves with the post natively during scrolling, without
      // waiting for JavaScript to handle the scroll event.
      const left = rect.left + window.scrollX;
      const top = rect.top + window.scrollY;
      const textRect = dom.getPostTextElement(post)?.getBoundingClientRect();
      const textTop = textRect ? textRect.top - rect.top : 64;
      const textBottom = textRect ? textRect.bottom - rect.top : 96;
      const compactTop = Math.max(44, Math.min(rect.height - 32, textBottom + 6));
      const stampTop = Math.max(76, Math.min(rect.height - 68, textTop + Math.min((textRect?.height || 120) / 2, 120)));
      element.style.width = `${Math.round(rect.width)}px`;
      element.style.height = `${Math.round(rect.height)}px`;
      element.style.setProperty("--jev-compact-top", `${Math.round(compactTop)}px`);
      element.style.setProperty("--jev-stamp-top", `${Math.round(stampTop)}px`);
      element.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    }
  }

  document.addEventListener("click", (event) => {
    for (const openBadge of badgeRoot?.querySelectorAll(".jev-slop-badge-wrap.jev-slop-open") || []) {
      if (!openBadge.contains(event.target)) {
        openBadge.classList.remove("jev-slop-open");
        openBadge.querySelector(".jev-slop-badge")?.setAttribute("aria-expanded", "false");
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "JEV_GET_DIAGNOSTICS") {
      sendResponse({
        ok: true,
        diagnostics: {
          ...diagnostics,
          url: location.href,
          candidatesFound: dom.findPosts(document).length,
          badges: activeBadges.size,
          visibleBadges: badgeRoot?.querySelectorAll(".jev-slop-badge-wrap:not([hidden])").length || 0,
          extractedPosts
        }
      });
      return false;
    }

    if (message?.type === "JEV_RESCAN") {
      scheduleScan(document);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  const mutationObserver = new MutationObserver((mutations) => {
    scheduleBadgeLayout();
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) {
          scheduleScan(node);
        }
      }
    }
  });

  function start() {
    ensureBadgeRoot();
    diagnostics.started = true;
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    // LinkedIn currently scrolls the feed inside an element (for example
    // MAIN#workspace) instead of the window in some layouts. Scroll events do
    // not bubble, so listen during capture to follow any nested scroll root.
    document.addEventListener("scroll", scheduleBadgeLayout, { capture: true, passive: true });
    window.addEventListener("scroll", scheduleBadgeLayout, { passive: true });
    window.addEventListener("resize", scheduleBadgeLayout, { passive: true });
    window.visualViewport?.addEventListener("scroll", scheduleBadgeLayout, { passive: true });
    window.visualViewport?.addEventListener("resize", scheduleBadgeLayout, { passive: true });
    scheduleScan(document);
    console.info(LOG_PREFIX, `v${diagnostics.version} started in React-safe overlay mode.`);
  }

  function startAfterHydration() {
    // LinkedIn hydrates server-rendered React markup. Waiting for load plus a
    // short idle window prevents the extension from changing the DOM while
    // React is comparing its client tree to the server HTML.
    const begin = () => setTimeout(start, 1200);
    if (document.readyState === "complete") begin();
    else window.addEventListener("load", begin, { once: true });
  }

  startAfterHydration();
})();
