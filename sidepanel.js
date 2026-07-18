import {
  listCheckpoints,
  getCheckpoint,
  deleteCheckpoint,
  saveCheckpoint,
  getSettings,
  saveSettings,
  formatRestorePrompt,
  setPendingRestore,
  selectTail,
  toShareable,
  importCheckpoint,
} from "./storage.js";
import { auditArtifacts, runHealthChecks } from "./audit.js";
import { PROFILE_OPTIONS } from "./profiles.js";

const statusEl = document.getElementById("status");
const viewEl = document.getElementById("view");

let currentView = "checkpoints";
let scraped = null; // last scan result, held in memory only
let extracted = null; // last extraction result, held in memory only
let verification = null; // independent model's audit of `extracted`
let artifactAudit = null; // deterministic verbatim check, no model involved
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

  const exportBtn = el("button", { textContent: "Export" });
  exportBtn.addEventListener("click", () => doExport(cp, "full"));

  viewEl.append(
    back,
    el("div", { className: "actions" }, restore, copy, exportBtn, del),
    el("div", {
      className: "profile-badge",
      textContent: cp.profile === "engineering" ? "Engineering profile" : "General profile",
    })
  );
  if (cp.state) {
    viewEl.append(renderHealth(runHealthChecks(
      cp.recentMessages ?? [], cp.state, cp.verification, cp.artifactAudit
    )));
    viewEl.append(renderState(cp.state, cp.profile));
  }
}

async function renderCapture() {
  viewEl.replaceChildren();

  const profile = el("select");
  for (const option of PROFILE_OPTIONS) {
    profile.append(el("option", { value: option.id, textContent: option.label }));
  }
  profile.value = captureProfile;
  profile.addEventListener("change", () => {
    captureProfile = profile.value;
    extracted = null;
    verification = null;
    artifactAudit = null;
    setStatus("Profile changed. Extract again to apply it.");
    renderCapture();
  });
  viewEl.append(
    el("label", { textContent: "Checkpoint profile" }),
    profile,
    el("div", {
      className: "profile-description",
      textContent: captureProfile === "engineering"
        ? "Adds files, commands, work status, blockers, tests, and next actions to the verified general checkpoint."
        : "Goals, decisions, findings, constraints, questions, artifacts, and current resumption point.",
    })
  );

  // Every step is always visible, in order, disabled until reachable — so the
  // pipeline reads as Scan › Extract › Verify › Save at a glance.
  const steps = [
    ["Scan", doScan, true, true],
    ["Extract", doExtract, !!scraped, false],
    ["Verify", doVerify, !!extracted, false],
    ["Save", doSave, !!extracted, false],
  ];

  const actions = el("div", { className: "actions" });
  for (const [label, handler, enabled, primary] of steps) {
    const btn = primary
      ? el("button", { className: "primary" }, el("span", { textContent: label }))
      : el("button", { textContent: label });
    btn.disabled = !enabled;
    btn.addEventListener("click", handler);
    actions.append(el("div", { className: "step" }, btn));
  }
  viewEl.append(actions);

  if (!scraped) return;

  if (extracted) {
    viewEl.append(
      renderHealth(runHealthChecks(scraped.messages, extracted, verification))
    );
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

const CHECK_ICON = { pass: "✓", warning: "⚠", blocker: "✗" };

/** The health panel: every local check plus verification status, in one card. */
function renderHealth(health) {
  const card = el("div", { className: `health ${health.status.toLowerCase()}` });
  card.append(
    el("h3", { textContent: `Health: ${health.status}` }),
    el("div", {
      className: "tally",
      textContent:
        `${health.passed} passed · ${health.warnings} warning` +
        `${health.warnings === 1 ? "" : "s"} · ${health.blockers} blocker` +
        `${health.blockers === 1 ? "" : "s"}`,
    })
  );

  for (const c of health.checks) {
    card.append(
      el(
        "div",
        { className: `check ${c.level}` },
        el("div", { className: "icon", textContent: CHECK_ICON[c.level] }),
        el(
          "div",
          { className: "body" },
          el("div", { className: "t", textContent: c.title }),
          el("div", { className: "d", textContent: c.detail })
        )
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
  section("Picking up from", state.resumptionPoint &&
    el("div", { className: "text", textContent: state.resumptionPoint }));
  section("Decisions", lines(state.decisions, (d) =>
    d.rationale ? `• ${d.decision} — ${d.rationale}` : `• ${d.decision}`));
  section("Constraints", lines(state.constraints, (c) => `• ${c}`));
  section("Established findings", lines(state.findings, (f) => `• ${f}`));
  section("Open questions", lines(state.openQuestions, (q) => `• ${q}`));
  section("Artifacts", lines(state.artifacts, (a) =>
    `${a.name} (${a.kind})\n${a.content}`));
  section("Glossary", lines(state.glossary, (g) => `${g.term}: ${g.meaning}`));

  if (profile === "engineering") {
    const e = state.engineeringState;
    const engineering = [];
    if (e?.branch) engineering.push(`Branch: ${e.branch}`);
    if (e?.completed?.length) engineering.push(`Completed:\n${e.completed.map((x) => `✓ ${x}`).join("\n")}`);
    if (e?.inProgress?.length) engineering.push(`In progress:\n${e.inProgress.map((x) => `• ${x}`).join("\n")}`);
    if (e?.blocked?.length) engineering.push(`Blocked:\n${e.blocked.map((x) => `! ${x}`).join("\n")}`);
    if (e?.files?.length) engineering.push(`Files:\n${e.files.map((f) => `• ${f.path} — ${f.status}: ${f.purpose}`).join("\n")}`);
    if (e?.commands?.length) engineering.push(`Commands:\n${e.commands.map((c) => `• ${c.command} — ${c.result || "result unknown"}`).join("\n")}`);
    if (e?.knownIssues?.length) engineering.push(`Known issues:\n${e.knownIssues.map((x) => `• ${x}`).join("\n")}`);
    if (e?.nextActions?.length) engineering.push(`Next actions:\n${e.nextActions.map((x) => `• ${x}`).join("\n")}`);
    if (e?.definitionOfDone?.length) engineering.push(`Definition of done:\n${e.definitionOfDone.map((x) => `• ${x}`).join("\n")}`);
    section("Engineering handoff", el("div", {
      className: "text",
      textContent: engineering.length
        ? engineering.join("\n\n")
        : "No explicit SWE work state was found in this conversation.",
    }));
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

  const save = el(
    "button",
    { className: "primary" },
    el("span", { textContent: "Save key" })
  );
  save.style.marginTop = "14px";
  save.addEventListener("click", async () => {
    await saveSettings({ openaiKey: openai.value.trim() });
    setStatus("Saved.");
  });

  viewEl.append(
    el("label", { textContent: "OpenAI key" }),
    openai,
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
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 60) || "checkpoint";
  return `${base}.checkpoint.json`;
}

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = el("a", { href: url, download: filename });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function doExport(cp, mode) {
  const health = runHealthChecks(
    cp.recentMessages ?? [], cp.state, cp.verification, cp.artifactAudit
  );
  const hasSecret = health.checks.some(
    (check) => check.level === "blocker" && /credential|secret/i.test(`${check.title} ${check.detail}`)
  );
  if (hasSecret) return setStatus("Export blocked: remove or redact the detected secret first.", true);
  if (health.status === "BLOCKED" && !window.confirm(
    "This checkpoint has blocking health issues. Export it anyway?"
  )) return;

  downloadJson(safeFilename(cp.title), toShareable(cp, mode));
  setStatus("Checkpoint exported.");
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
    const imported = await importCheckpoint(JSON.parse(await file.text()));
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
  verification = null;
  artifactAudit = null;
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
  verification = null;
  // Free, instant, no model opinion involved — always run it.
  artifactAudit = auditArtifacts(scraped.messages, extracted);

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

async function doVerify() {
  if (!scraped || !extracted) return;
  setStatus("Verifying with an independent model…");

  const res = await chrome.runtime.sendMessage({
    type: "VERIFY",
    messages: scraped.messages,
    state: extracted,
    profile: captureProfile,
  });

  if (!res?.ok) return setStatus(res?.error ?? "Verification failed.", true);

  verification = res.verification;
  setStatus(`Verdict: ${verification.verdict.replace("_", " ")}.`);
  renderCapture();
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
    verification,
    artifactAudit,
    // The verbatim live edge. Stored on the checkpoint so restore doesn't
    // depend on the source conversation still existing.
    recentMessages: selectTail(scraped.messages),
  });
  setStatus("Checkpoint saved.");
  extracted = null;
  verification = null;
  artifactAudit = null;
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
