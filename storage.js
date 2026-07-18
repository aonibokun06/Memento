// All persistence. Nothing here talks to the network.
//
// Everything lives in chrome.storage.local, which is sandboxed per-extension
// per-Chrome-profile: not synced, not readable by other extensions or by pages.
//
// Shape:
//   settings    -> { openaiKey }
//   checkpoints -> { [id]: Checkpoint }

export const SCHEMA_VERSION = 1;

// Fields that must never leave the device. toShareable() strips these; keeping
// the list in one place means the privacy decision is made once, not scattered
// across every future export/share path.
const LOCAL_ONLY_FIELDS = ["sourceUrl"];

/**
 * @typedef {object} Checkpoint
 * @property {string}  id             uuid — globally unique so imported
 *                                    checkpoints can never collide with local ones
 * @property {number}  schemaVersion
 * @property {string}  createdAt      ISO
 * @property {string}  title
 * @property {string}  platform       "chatgpt.com" | "claude.ai"
 * @property {string}  sourceUrl      LOCAL ONLY — identifies the owner's chat
 * @property {number}  messageCount
 * @property {object}  state          the extracted checkpoint itself
 * @property {object=} verification   null until step 4 runs
 */

// ---------------------------------------------------------------- settings

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return settings ?? { openaiKey: "" };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

// ------------------------------------------------------------- checkpoints

async function readAll() {
  const { checkpoints } = await chrome.storage.local.get("checkpoints");
  return checkpoints ?? {};
}

export async function listCheckpoints() {
  const all = await readAll();
  return Object.values(all).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
}

export async function getCheckpoint(id) {
  return (await readAll())[id] ?? null;
}

/**
 * @param {{title, platform, sourceUrl, messageCount, state, verification?}} input
 * @returns {Promise<Checkpoint>}
 */
export async function saveCheckpoint(input) {
  const all = await readAll();
  const checkpoint = {
    id: crypto.randomUUID(),
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    verification: null,
    ...input,
  };
  all[checkpoint.id] = checkpoint;
  await chrome.storage.local.set({ checkpoints: all });
  return checkpoint;
}

export async function updateCheckpoint(id, patch) {
  const all = await readAll();
  if (!all[id]) throw new Error(`No checkpoint ${id}`);
  all[id] = { ...all[id], ...patch, id, schemaVersion: SCHEMA_VERSION };
  await chrome.storage.local.set({ checkpoints: all });
  return all[id];
}

export async function deleteCheckpoint(id) {
  const all = await readAll();
  delete all[id];
  await chrome.storage.local.set({ checkpoints: all });
}

// ---------------------------------------------------------------- restore
// The side panel can't reach into a tab that hasn't loaded yet, so instead of
// racing messages we park the text here. The content script picks it up on
// init and clears it. Race-free by construction.

export async function setPendingRestore(platform, text) {
  await chrome.storage.local.set({ pendingRestore: { platform, text } });
}

export async function takePendingRestore(platform) {
  const { pendingRestore } = await chrome.storage.local.get("pendingRestore");
  if (!pendingRestore || pendingRestore.platform !== platform) return null;
  await chrome.storage.local.remove("pendingRestore");
  return pendingRestore.text;
}

// Compression is only justified where information density is low — old,
// settled, superseded turns. The last few exchanges are the densest part of
// the conversation and the cheapest to carry, so they ride along verbatim.
// This is what makes a resume start exactly where the old chat ended rather
// than approximately near it.
export const TAIL_COUNT = 6;
export const TAIL_CHAR_BUDGET = 6000;

/** Take the last few messages, newest-first, until either limit is hit. */
export function selectTail(messages, count = TAIL_COUNT, budget = TAIL_CHAR_BUDGET) {
  const tail = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0 && tail.length < count; i--) {
    const m = messages[i];
    // Always keep at least one, even if it alone blows the budget.
    if (tail.length > 0 && used + m.text.length > budget) break;
    tail.unshift(m);
    used += m.text.length;
  }
  return tail;
}

/** Render a checkpoint into a paste-ready prompt for a fresh chat. */
export function formatRestorePrompt(cp) {
  const s = cp.state;
  const out = [
    "I'm resuming earlier work. Below is the state of that conversation: a compressed record of the history, then the most recent messages verbatim.",
    "Treat the decisions as settled — don't re-litigate them or re-ask what's already answered. Acknowledge in one line, then continue.",
    "",
    `## Goal\n${s.goal}`,
  ];

  const section = (heading, items, format) => {
    if (items?.length) out.push("", `## ${heading}`, items.map(format).join("\n"));
  };

  section("Settled decisions", s.decisions, (d) =>
    d.rationale ? `- ${d.decision} (because: ${d.rationale})` : `- ${d.decision}`
  );
  section("Constraints", s.constraints, (c) => `- ${c}`);
  section(
    "Already established (do not re-derive or contradict)",
    s.findings,
    (f) => `- ${f}`
  );
  section("Open questions", s.openQuestions, (q) => `- ${q}`);
  section("Glossary", s.glossary, (g) => `- ${g.term}: ${g.meaning}`);

  if (s.artifacts?.length) {
    out.push("", "## Artifacts");
    for (const a of s.artifacts) {
      out.push(`### ${a.name} (${a.kind})`, "```", a.content, "```");
    }
  }

  if (s.resumptionPoint) {
    out.push("", "## Where we left off", s.resumptionPoint);
  }

  // Verbatim tail goes LAST: it's the live edge of the conversation, and
  // recency drives what the model actually acts on.
  if (cp.recentMessages?.length) {
    out.push("", "## The last few messages, verbatim");
    for (const m of cp.recentMessages) {
      out.push("", `[${m.role.toUpperCase()}]`, m.text);
    }
  }

  out.push("", "---", "Continue from exactly this point.");
  return out.join("\n");
}

// ------------------------------------------------------------------ share
// Not wired to any UI yet — this is the seam so that when sharing ships, the
// "what goes out" decision already has exactly one home.

/** Strip local-only fields. ALWAYS route outbound checkpoints through this. */
export function toShareable(checkpoint) {
  const copy = { ...checkpoint };
  for (const field of LOCAL_ONLY_FIELDS) delete copy[field];
  return copy;
}

/** Accept a checkpoint from elsewhere. Re-IDs it so imports never collide. */
export async function importCheckpoint(incoming) {
  if (incoming?.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported checkpoint version: ${incoming?.schemaVersion}`
    );
  }
  const { id: _discard, ...rest } = incoming;
  return saveCheckpoint({ ...rest, importedAt: new Date().toISOString() });
}
