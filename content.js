// Runs inside chatgpt.com / claude.ai. The ONLY piece that can read the page DOM.
//
// Both platforms virtualize long conversations: messages scrolled out of view
// are removed from the DOM. A single querySelectorAll therefore only ever sees
// the current viewport. To get the whole thread we scroll top -> bottom and
// harvest at each step, deduping by a stable key.
//
// Selectors are keyed off semantic attributes (data-message-author-role,
// data-testid), never CSS classes — those are build hashes and rotate weekly.

const SCRAPERS = {
  "chatgpt.com": scrapeChatGPT,
  "claude.ai": scrapeClaude,
};

// Chrome that lives inside a message subtree but isn't part of the message:
// copy/retry buttons, code-block language labels, and screen-reader-only
// duplicates. innerText includes sr-only text (it's clipped, not hidden), which
// is why Claude's thinking summary was showing up twice.
const NOISE = [
  "button",
  '[aria-hidden="true"]',
  ".sr-only",
  '[class*="sr-only"]',
  "svg",
].join(",");

function cleanText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll(NOISE).forEach((n) => n.remove());

  const lines = clone.innerText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Belt-and-suspenders: drop consecutive identical lines that survived the
  // noise strip (Claude renders some labels twice in separate subtrees).
  return lines.filter((l, i) => l !== lines[i - 1]).join("\n");
}

// Stable-ish identity for dedupe across scroll passes. Prefer a real id from
// the platform; fall back to hashing the text.
function keyFor(el, text) {
  const id =
    el.getAttribute("data-message-id") ??
    el.closest("[data-message-id]")?.getAttribute("data-message-id");
  if (id) return id;
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `h${h}:${text.length}`;
}

function scrapeChatGPT() {
  return [...document.querySelectorAll("[data-message-author-role]")].map(
    (el) => {
      const text = cleanText(el);
      return {
        role: el.getAttribute("data-message-author-role"),
        text,
        key: keyFor(el, text),
      };
    }
  );
}

function scrapeClaude() {
  return [...document.querySelectorAll('[data-testid="user-message"], .font-claude-response')]
    .filter((el) => !el.parentElement?.closest(".font-claude-response"))
    .map((el) => {
      const text = cleanText(el);
      return {
        role: el.matches('[data-testid="user-message"]') ? "user" : "assistant",
        text,
        key: keyFor(el, text),
      };
    });
}

// ------------------------------------------------------------- harvesting

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Double rAF guarantees the browser has laid out and painted the newly
// virtualized rows. Waiting on paint rather than on a fixed timeout is what
// lets the delays below be short.
const nextFrame = () =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

const settle = async (ms) => {
  await nextFrame();
  await sleep(ms);
};

/** Nearest scrollable ancestor — the virtualized list's viewport. */
function findScrollContainer(el) {
  let node = el?.parentElement;
  while (node && node !== document.body) {
    const { overflowY } = getComputedStyle(node);
    if (
      /(auto|scroll)/.test(overflowY) &&
      node.scrollHeight > node.clientHeight + 50
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

/**
 * Scroll top -> bottom, collecting messages as they render. Because we only
 * ever move downward, first-seen order is document order.
 */
async function harvest(scraper) {
  const probe = document.querySelector(
    '[data-message-author-role], [data-testid="user-message"], .font-claude-response'
  );
  if (!probe) return [];

  const box = findScrollContainer(probe);
  const restore = box.scrollTop;
  const seen = new Map();

  const collect = () => {
    for (const m of scraper()) {
      if (m.text && !seen.has(m.key)) seen.set(m.key, m);
    }
  };

  // Short conversation that already fits on screen — nothing is virtualized,
  // so skip the whole scroll dance.
  if (box.scrollHeight <= box.clientHeight + 10) {
    collect();
    return [...seen.values()].map(({ role, text }) => ({ role, text }));
  }

  // Scrolling to the top can trigger lazy-loading of older messages, which
  // grows scrollHeight. Poll until the height stops changing twice in a row,
  // rather than sleeping a fixed amount per pass.
  let stable = 0;
  for (let i = 0; i < 60 && stable < 2; i++) {
    const before = box.scrollHeight;
    box.scrollTop = 0;
    await settle(90);
    collect();
    stable = box.scrollHeight === before ? stable + 1 : 0;
  }

  // Walk down, harvesting each viewport. Dedupe makes overlap free, so the
  // step is nearly a full screen — 15% is enough cushion for rows that render
  // slightly outside the visible band.
  const step = Math.max(box.clientHeight * 0.85, 400);
  for (let i = 0; i < 500; i++) {
    collect();
    const atBottom =
      box.scrollTop + box.clientHeight >= box.scrollHeight - 10;
    if (atBottom) break;
    box.scrollTop += step;
    await settle(45);
  }
  collect();

  box.scrollTop = restore;
  return [...seen.values()].map(({ role, text }) => ({ role, text }));
}

async function scrape() {
  const host = location.hostname.replace(/^www\./, "");
  const scraper = SCRAPERS[host];
  if (!scraper) return { ok: false, error: `No scraper for ${host}` };

  const messages = await harvest(scraper);
  if (messages.length === 0) {
    return {
      ok: false,
      error: `Scraped 0 messages on ${host}. Selectors are probably stale — run __memento.debug() in this console (switch the console context to Memento first).`,
    };
  }
  return { ok: true, host, messages, scrapedAt: Date.now() };
}

// Fix-it helper. When a scraper returns nothing, select a message element in
// the Elements panel and run __memento.debug() from the Memento console
// context: it prints candidate stable attributes up the ancestor chain.
function debug() {
  const el = $0; // eslint-disable-line no-undef
  if (!el) return console.log("Select a message element in Elements first.");
  let node = el;
  while (node && node !== document.body) {
    const attrs = [...node.attributes]
      .filter((a) => a.name.startsWith("data-") || a.name === "role")
      .map((a) => `${a.name}="${a.value}"`);
    if (attrs.length) console.log(node.tagName.toLowerCase(), attrs.join(" "));
    node = node.parentElement;
  }
}

// -------------------------------------------------------------- restoring

const COMPOSER = [
  "#prompt-textarea",                        // chatgpt.com
  'div[contenteditable="true"].ProseMirror', // claude.ai
  'div[contenteditable="true"]',             // fallback
].join(",");

/**
 * Both composers are contenteditable ProseMirror instances behind React.
 * Assigning .innerText updates the DOM but not the framework's state, so the
 * send button stays disabled. execCommand is deprecated but still fires the
 * real input events both editors listen for, which is what makes this stick.
 */
function fillComposer(text) {
  const el = document.querySelector(COMPOSER);
  if (!el) return false;
  el.focus();
  document.execCommand("selectAll", false, null);
  document.execCommand("insertText", false, text);
  return true;
}

/** The composer isn't in the DOM the instant the page loads — poll for it. */
async function applyPendingRestore() {
  const host = location.hostname.replace(/^www\./, "");
  const { pendingRestore } = await chrome.storage.local.get("pendingRestore");
  if (!pendingRestore || pendingRestore.platform !== host) return;
  await chrome.storage.local.remove("pendingRestore");

  for (let i = 0; i < 40; i++) {
    if (fillComposer(pendingRestore.text)) {
      console.log("[memento] restored checkpoint into composer");
      return;
    }
    await sleep(250);
  }
  console.warn("[memento] composer never appeared; restore text is on your clipboard");
}

applyPendingRestore();

globalThis.__memento = { scrape, debug, harvest, fillComposer };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SCRAPE") {
    scrape().then(sendResponse, (e) =>
      sendResponse({ ok: false, error: e.message })
    );
    return true; // async response
  }
});

console.log("[memento] content script attached on", location.hostname);
