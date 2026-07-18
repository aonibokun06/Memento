import {
  listCheckpoints,
  getCheckpoint,
  deleteCheckpoint,
  saveCheckpoint,
  getSettings,
  saveSettings,
  formatRestorePrompt,
  setPendingRestore,
  toShareable,
  importCheckpoint,
} from "./storage.js";
import { analyzeCheckpointHealth } from "./health.js";

const statusEl = document.getElementById("status");
const viewEl = document.getElementById("view");

let currentView = "checkpoints";
let scraped = null; // last scan result, held in memory only
let extracted = null; // last extraction result, held in memory only
let captureProfile = "general";
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

  const importInput = el("input", {
    type: "file",
    accept: ".json,.checkpoint.json,application/json",
  });
  importInput.style.display = "none";
  importInput.addEventListener("change", () => doImport(importInput));
  const importButton = el("button", { textContent: "Import checkpoint" });
  importButton.addEventListener("click", () => importInput.click());
  viewEl.append(el("div", { className: "share-toolbar" }, importButton, importInput));

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

  const exportFull = el("button", { textContent: "Export full" });
  exportFull.addEventListener("click", () => doExport(cp, "full"));
  const exportCompact = el("button", { textContent: "Export compact" });
  exportCompact.addEventListener("click", () => doExport(cp, "compact"));

  for (const b of [restore, copy, exportFull, exportCompact, del]) b.style.marginRight = "6px";
  viewEl.append(
    back,
    el("div", { className: "detail-actions" }, restore, copy, exportFull, exportCompact, del)
  );
  viewEl.append(el("div", {
    className: "profile-badge",
    textContent: cp.profile === "engineering" ? "Engineering profile" : "Business / General profile",
  }));
  viewEl.append(renderHealth(cp));
  if (cp.state) viewEl.append(renderState(cp.state, cp.profile));
}

async function renderCapture() {
  viewEl.replaceChildren();

  const profile = el("select");
  profile.append(
    el("option", { value: "general", textContent: "Business / General" }),
    el("option", { value: "engineering", textContent: "Engineering / SWE" })
  );
  profile.value = captureProfile;
  profile.addEventListener("change", () => {
    captureProfile = profile.value;
    extracted = null;
    setStatus("Profile changed. Extract again to apply it.");
    renderCapture();
  });
  const profileHint = el("div", {
    className: "profile-description",
    textContent: captureProfile === "engineering"
      ? "Includes the general checkpoint plus files, commands, work status, blockers, tests, and next actions."
      : "Captures goals, decisions, constraints, questions, artifacts, and evidence for any kind of conversation.",
  });
  viewEl.append(el("label", { textContent: "Checkpoint profile" }), profile, profileHint);

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
    viewEl.append(renderHealth({ state: extracted, verification: null }));
    viewEl.append(renderState(extracted, captureProfile));
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

function renderHealth(checkpoint) {
  const report = analyzeCheckpointHealth(checkpoint);
  const card = el("section", { className: `health health-${report.status}` });
  card.append(
    el("div", { className: "health-title", textContent: `Health: ${report.status.toUpperCase()}` }),
    el("div", {
      className: "meta",
      textContent: `${report.counts.passed} passed · ${report.counts.warnings} warnings · ${report.counts.blockers} blockers`,
    })
  );

  for (const finding of report.findings) {
    const icon = { pass: "✓", warning: "⚠", error: "✕" }[finding.severity];
    card.append(
      el(
        "div",
        { className: `health-finding ${finding.severity}` },
        el("div", { className: "title", textContent: `${icon} ${finding.label}` }),
        el("div", { className: "meta", textContent: finding.detail })
      )
    );
  }
  return card;
}

/** Render an extracted checkpoint as readable sections, not raw JSON. */
function renderState(state, profile = "general") {
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

  const eng = state.engineeringState;
  if (profile === "engineering" || (eng && [eng.branch, ...(eng.completed ?? []), ...(eng.inProgress ?? []),
    ...(eng.blocked ?? []), ...(eng.files ?? []), ...(eng.commands ?? []),
    ...(eng.knownIssues ?? []), ...(eng.nextActions ?? []), ...(eng.definitionOfDone ?? [])].some(Boolean))) {
    const engineeringLines = [];
    if (!eng) engineeringLines.push("No engineering state was extracted.");
    if (eng?.branch) engineeringLines.push(`Branch: ${eng.branch}`);
    if (eng?.completed?.length) engineeringLines.push(`Completed:\n${eng.completed.map((x) => `✓ ${x}`).join("\n")}`);
    if (eng?.inProgress?.length) engineeringLines.push(`In progress:\n${eng.inProgress.map((x) => `• ${x}`).join("\n")}`);
    if (eng?.blocked?.length) engineeringLines.push(`Blocked:\n${eng.blocked.map((x) => `! ${x}`).join("\n")}`);
    if (eng?.files?.length) engineeringLines.push(`Files:\n${eng.files.map((f) => `• ${f.path} — ${f.status}: ${f.purpose}`).join("\n")}`);
    if (eng?.commands?.length) engineeringLines.push(`Commands:\n${eng.commands.map((c) => `• ${c.command} — ${c.result}`).join("\n")}`);
    if (eng?.knownIssues?.length) engineeringLines.push(`Known issues:\n${eng.knownIssues.map((x) => `• ${x}`).join("\n")}`);
    if (eng?.nextActions?.length) engineeringLines.push(`Next actions:\n${eng.nextActions.map((x) => `• ${x}`).join("\n")}`);
    if (eng?.definitionOfDone?.length) engineeringLines.push(`Definition of done:\n${eng.definitionOfDone.map((x) => `• ${x}`).join("\n")}`);
    if (eng && engineeringLines.length === 0) engineeringLines.push("No explicit SWE work state was found in this conversation.");
    section("Engineering handoff", el("div", { className: "text", textContent: engineeringLines.join("\n\n") }));
  }

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

function safeFilename(title) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "checkpoint";
  return `${base}.checkpoint.json`;
}

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = el("a", { href: url, download: filename });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function doExport(cp, mode) {
  const report = analyzeCheckpointHealth(cp);
  const hasSecret = report.findings.some(
    (finding) => finding.category === "Security" && finding.severity === "error"
  );
  if (hasSecret) {
    return setStatus("Export blocked: remove or redact the detected secret first.", true);
  }
  if (report.status === "blocked" && !window.confirm(
    "This checkpoint has blocking health issues. Export it anyway?"
  )) return;

  const payload = toShareable(cp, mode);
  downloadJson(safeFilename(cp.title), payload);
  setStatus(`${mode === "compact" ? "Compact handoff" : "Full checkpoint"} exported.`);
}

async function doImport(input) {
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    return setStatus("Import failed: checkpoint files must be smaller than 10 MB.", true);
  }

  setStatus("Importing checkpoint…");
  try {
    const parsed = JSON.parse(await file.text());
    const imported = await importCheckpoint(parsed);
    selectedId = imported.id;
    setStatus("Checkpoint imported. Health was recomputed from its contents.");
    show("detail");
  } catch (error) {
    setStatus(`Import failed: ${error.message}`, true);
  }
}

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
    profile: captureProfile,
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
    profile: captureProfile,
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
