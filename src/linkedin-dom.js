/**
 * LinkedIn DOM adapter.
 *
 * LinkedIn changes its markup often. Keep every LinkedIn-specific selector and
 * extraction rule in this file so the rest of the extension stays stable.
 */
(function exposeLinkedInDom(global) {
  "use strict";

  const SELECTORS = Object.freeze({
    post: [
      "[data-testid='mainFeed'] [role='listitem']",
      "[data-testid='main-feed'] [role='listitem']",
      ".occludable-update",
      ".feed-shared-update-v2",
      "div[data-view-name='feed-full-update']",
      "article[data-urn^='urn:li:activity:']",
      "article[data-urn^='urn:li:ugcPost:']",
      "div[data-urn^='urn:li:activity:']",
      "div[data-urn^='urn:li:ugcPost:']"
    ],
    text: [
      "[data-testid='expandable-text-box']",
      "[data-testid='main-feed-activity-card__commentary']",
      "[data-testid*='activity-card'][data-testid*='commentary']",
      "[data-testid*='commentary']",
      "[data-view-name='feed-commentary']",
      ".feed-shared-update-v2__description-wrapper .update-components-text",
      ".feed-shared-update-v2__description .update-components-text",
      ".feed-shared-update-v2__commentary",
      ".update-components-text"
    ]
  });

  const POST_SELECTOR = SELECTORS.post.join(",");

  function normalizeText(text) {
    return (text || "")
      .replace(/\u00ad/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function looksLikePost(element) {
    if (!(element instanceof Element) || !element.matches(POST_SELECTOR)) {
      return false;
    }

    const isModernListItem = element.matches(
      "[data-testid='mainFeed'] [role='listitem'], [data-testid='main-feed'] [role='listitem']"
    );
    if (
      isModernListItem
      && !element.querySelector("button[aria-label^='Reaction button state:'], [data-testid='expandable-text-box']")
    ) {
      return false;
    }

    // A matching element nested in another matching element is an internal
    // post component, not a second post.
    const parentPost = element.parentElement?.closest(POST_SELECTOR);
    return !parentPost;
  }

  function findPosts(root = document) {
    const posts = [];

    if (root instanceof Element && looksLikePost(root)) {
      posts.push(root);
    }

    if (typeof root.querySelectorAll !== "function") {
      return posts;
    }

    for (const candidate of root.querySelectorAll(POST_SELECTOR)) {
      if (looksLikePost(candidate)) {
        posts.push(candidate);
      }
    }

    return posts;
  }

  function findContainingPost(element) {
    const candidate = element instanceof Element ? element.closest(POST_SELECTOR) : null;
    if (!candidate) {
      return null;
    }

    // Walk to the outermost matching container. Some LinkedIn layouts place
    // a data-urn node inside the visual feed card.
    let post = candidate;
    let parentPost = post.parentElement?.closest(POST_SELECTOR);
    while (parentPost) {
      post = parentPost;
      parentPost = post.parentElement?.closest(POST_SELECTOR);
    }
    return post;
  }

  function getPostText(post) {
    for (const selector of SELECTORS.text) {
      const nodes = post.querySelectorAll(selector);
      if (!nodes.length) {
        continue;
      }

      // LinkedIn line-clamps collapsed posts visually but keeps the complete
      // post in the node's textContent. Prefer textContent so classification
      // never depends on whether the user clicked "more".
      const parts = Array.from(nodes, (node) => normalizeText(node.textContent || node.innerText));
      const text = normalizeText(parts.filter(Boolean).join(" "));
      if (text) {
        return text;
      }
    }

    return "";
  }

  function getPostTextElement(post) {
    for (const selector of SELECTORS.text) {
      const element = post.querySelector(selector);
      if (element) return element;
    }
    return null;
  }

  function getPostId(post) {
    const idNode = post.matches("[data-urn],[data-id],[data-activity-urn]")
      ? post
      : post.querySelector("[data-urn],[data-id],[data-activity-urn]");
    const rawId = idNode?.getAttribute("data-urn")
      || idNode?.getAttribute("data-id")
      || idNode?.getAttribute("data-activity-urn");
    if (rawId && /(?:activity|ugcPost|share|update)/i.test(rawId)) {
      return rawId;
    }

    const permalink = post.querySelector(
      "a[href*='/feed/update/'], a[href*='urn:li:activity:'], a[href*='urn:li:ugcPost:']"
    );
    const href = permalink?.getAttribute("href") || "";
    const decodedHref = decodeURIComponent(href);
    const urnMatch = decodedHref.match(/urn:li:(?:activity|ugcPost):\d+/i);
    if (urnMatch) return urnMatch[0];

    const slugMatch = decodedHref.match(/(?:activity|ugcPost)[-:](\d{10,})/i);
    return slugMatch ? `urn:li:activity:${slugMatch[1]}` : null;
  }

  global.JevLinkedInDom = Object.freeze({
    findPosts,
    findContainingPost,
    getPostText,
    getPostTextElement,
    getPostId,
    normalizeText
  });
})(globalThis);
