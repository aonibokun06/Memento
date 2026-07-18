import {
  listCheckpoints,
  getCheckpoint,
  deleteCheckpoint,
  saveCheckpoint,
  getSettings,
  saveSettings,
  formatRestorePrompt,
  setPendingRestore,
} from "./storage.js";

const statusEl = document.getElementById("status");
const viewEl = document.getElementById("view");

let currentView = "checkpoints";
let scraped = null; // last scan result, held in memory only
let extracted = null; // last extraction result, held in memory only
let selectedId = null; // checkpoint open in the detail view

function setStatus(text = "", isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

// ------------------------------------------------------------------ views

async function renderCheckpoints() {
  const checkpoints = await listCheckpoints();
  viewEl.replaceChildren();

  if (checkpoints.length === 0) {
    viewEl.append(
      el("div", {
        className: "empty",
        textContent: "No checkpoints yet. Open Capture to make one.",
      })
    );
    return;
  }

  for (const cp of checkpoints) {
    const when = new Date(cp.createdAt).toLocaleString();

    const open = el("div", { className: "grow" });
    open.style.cursor = "pointer";
    open.append(
      el("div", { className: "title", textContent: cp.title }),
      el("div", {
        className: "meta",
        textContent: `${cp.platform} · ${cp.messageCount} messages · ${when}`,
      })
    );
    open.addEventListener("click", () => {
      selectedId = cp.id;
      show("detail");
    });

    const restore = el("button", { textContent: "Restore" });
    restore.addEventListener("click", () => doRestore(cp));

    viewEl.append(el("div", { className: "row" }, open, restore));
  }
}

async function renderDetail() {
  const cp = selectedId ? await getCheckpoint(selectedId) : null;
  viewEl.replaceChildren();
  if (!cp) return show("checkpoints");

  const back = el("button", { className: "link", textContent: "← Back" });
  back.addEventListener("click", () => show("checkpoints"));

  const restore = el(
    "button",
    { className: "primary" },
    el("span", { textContent: "Restore in new chat" })
  );
  restore.addEventListener("click", () => doRestore(cp));

  const copy = el("button", { textContent: "Copy prompt" });
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(formatRestorePrompt(cp));
    setStatus("Copied to clipboard.");
  });

  const del = el("button", { className: "link", textContent: "Delete" });
  del.addEventListener("click", async () => {
    await deleteCheckpoint(cp.id);
    selectedId = null;
    setStatus("Deleted.");
    show("checkpoints");
  });

  for (const b of [restore, copy, del]) b.style.marginRight = "6px";
  viewEl.append(back, el("div", {}, restore, copy, del));
  if (cp.state) viewEl.append(renderState(cp.state));
}

async function renderCapture() {
  viewEl.replaceChildren();

  const scan = el(
    "button",
    { className: "primary" },
    el("span", { textContent: "Scan conversation" })
  );
  scan.addEventListener("click", doScan);
  viewEl.append(scan);

  if (!scraped) return;

  const extract = el("button", { textContent: "Extract checkpoint" });
  extract.style.marginLeft = "6px";
  extract.addEventListener("click", doExtract);
  viewEl.append(extract);

  if (extracted) {
    const save = el("button", { textContent: "Save" });
    save.style.marginLeft = "6px";
    save.addEventListener("click", doSave);
    viewEl.append(save);
    viewEl.append(renderState(extracted));
    return;
  }

  for (const m of scraped.messages) {
    viewEl.append(
      el(
        "div",
        { className: "msg" },
        el("div", { className: "role", textContent: m.role }),
        el("div", { className: "text", textContent: m.text })
      )
    );
  }
}

/** Render an extracted checkpoint as readable sections, not raw JSON. */
function renderState(state) {
  const frag = document.createDocumentFragment();

  const section = (heading, body) => {
    if (!body) return;
    frag.append(
      el(
        "div",
        { className: "msg" },
        el("div", { className: "role", textContent: heading }),
        body
      )
    );
  };

  const lines = (items, format) =>
    items?.length
      ? el("div", { className: "text", textContent: items.map(format).join("\n") })
      : null;

  section("Goal", state.goal && el("div", { className: "text", textContent: state.goal }));
  section("Decisions", lines(state.decisions, (d) =>
    d.rationale ? `• ${d.decision} — ${d.rationale}` : `• ${d.decision}`));
  section("Constraints", lines(state.constraints, (c) => `• ${c}`));
  section("Open questions", lines(state.openQuestions, (q) => `• ${q}`));
  section("Artifacts", lines(state.artifacts, (a) =>
    `${a.name} (${a.kind})\n${a.content}`));
  section("Glossary", lines(state.glossary, (g) => `${g.term}: ${g.meaning}`));

  return frag;
}

async function renderSettings() {
  const settings = await getSettings();
  viewEl.replaceChildren();

  const openai = el("input", {
    type: "password",
    value: settings.openaiKey,
    placeholder: "sk-...",
  });
  const anthropic = el("input", {
    type: "password",
    value: settings.anthropicKey,
    placeholder: "sk-ant-...",
  });

  const save = el(
    "button",
    { className: "primary" },
    el("span", { textContent: "Save keys" })
  );
  save.style.marginTop = "14px";
  save.addEventListener("click", async () => {
    await saveSettings({
      openaiKey: openai.value.trim(),
      anthropicKey: anthropic.value.trim(),
    });
    setStatus("Saved.");
  });

  viewEl.append(
    el("label", { textContent: "OpenAI key (extraction)" }),
    openai,
    el("label", { textContent: "Anthropic key (verification)" }),
    anthropic,
    save,
    el("div", {
      className: "hint",
      textContent:
        "Stored in chrome.storage.local on this device only. Sent as an " +
        "Authorization header on requests you trigger, and nowhere else.",
    })
  );
}

const VIEWS = {
  checkpoints: renderCheckpoints,
  detail: renderDetail,
  capture: renderCapture,
  settings: renderSettings,
};

function show(view) {
  currentView = view;
  for (const btn of document.querySelectorAll("nav button")) {
    btn.setAttribute("aria-current", String(btn.dataset.view === view));
  }
  VIEWS[view]();
}

// ---------------------------------------------------------------- actions

async function doScan() {
  setStatus("Scanning… (the page will scroll — that's how it reaches messages Chrome unloaded)");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return setStatus("No active tab.", true);

  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE" });
  } catch {
    return setStatus(
      "Content script not attached. Reload the chatgpt.com / claude.ai tab.",
      true
    );
  }
  if (!res?.ok) return setStatus(res?.error ?? "Unknown error.", true);

  scraped = { ...res, sourceUrl: tab.url, title: tab.title };
  extracted = null;
  const chars = res.messages.reduce((n, m) => n + m.text.length, 0);
  setStatus(
    `${res.messages.length} messages · ~${Math.round(chars / 4)} tokens (rough)`
  );
  renderCapture();
}

async function doExtract() {
  if (!scraped) return;
  setStatus("Extracting… (this takes a few seconds)");

  const res = await chrome.runtime.sendMessage({
    type: "EXTRACT",
    messages: scraped.messages,
  });

  if (!res?.ok) return setStatus(res?.error ?? "Extraction failed.", true);

  extracted = res.state;
  const used = res.usage?.total_tokens;
  setStatus(`Extracted.${used ? ` ${used} tokens used.` : ""}`);
  renderCapture();
}

const NEW_CHAT_URL = {
  "chatgpt.com": "https://chatgpt.com/",
  "claude.ai": "https://claude.ai/new",
};

async function doRestore(cp) {
  if (!cp.state) return setStatus("This checkpoint has no extracted state.", true);

  const prompt = formatRestorePrompt(cp);

  // Clipboard first, unconditionally. If auto-fill fails for any reason —
  // composer markup changed, page slow to load — a paste still works.
  try {
    await navigator.clipboard.writeText(prompt);
  } catch {
    /* non-fatal */
  }

  const url = NEW_CHAT_URL[cp.platform];
  if (!url) return setStatus(`Don't know how to open ${cp.platform}.`, true);

  await setPendingRestore(cp.platform, prompt);
  await chrome.tabs.create({ url });
  setStatus("Opening a new chat… (also copied to clipboard)");
}

async function doSave() {
  if (!scraped || !extracted) return;
  await saveCheckpoint({
    title: extracted.title || scraped.title || "Untitled conversation",
    platform: scraped.host,
    sourceUrl: scraped.sourceUrl,
    messageCount: scraped.messages.length,
    state: extracted,
  });
  setStatus("Checkpoint saved.");
  extracted = null;
  show("checkpoints");
}

// ------------------------------------------------------------------- boot

for (const btn of document.querySelectorAll("nav button")) {
  btn.addEventListener("click", () => {
    setStatus();
    show(btn.dataset.view);
  });
}
show(currentView);
