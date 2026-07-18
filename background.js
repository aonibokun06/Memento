// Service worker. No DOM access. This is the only place that makes network
// calls, and the only place the API key is ever read.

import { getSettings } from "./storage.js";
import { resolveProfile } from "./profiles.js";

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[memento]", err));

// Extraction needs the LARGEST context window available: the whole point is
// long conversations, and a model that can't hold the transcript can't extract
// from it. gpt-4.1 is the large-window option; gpt-4o's 128k would truncate
// exactly the conversations this tool exists for.
const EXTRACT_MODEL = "gpt-4.1";

// Rough guard so an oversize transcript fails with an explanation instead of a
// truncated checkpoint that looks fine. ~4 chars/token, leaving room for the
// system prompt and the response.
const MAX_TRANSCRIPT_CHARS = 3_000_000;

// OpenAI strict mode requires every property to appear in `required` and every
// object to set additionalProperties:false. There are no optional fields — a
// field with nothing to say comes back as "" or [].
const CHECKPOINT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "goal",
    "resumptionPoint",
    "decisions",
    "findings",
    "constraints",
    "openQuestions",
    "artifacts",
    "glossary",
  ],
  properties: {
    title: {
      type: "string",
      description: "Short label for this checkpoint in a list. Max 8 words.",
    },
    goal: {
      type: "string",
      description:
        "What the user is ultimately trying to accomplish, and the background " +
        "needed to understand why. Include what success looks like, what has " +
        "been tried, and what situation prompted the work. Write a full " +
        "paragraph — a reader with zero prior context should finish this and " +
        "understand the whole project.",
    },
    resumptionPoint: {
      type: "string",
      description:
        "Where the conversation stands RIGHT NOW, in as much detail as it " +
        "takes: exactly what the user last asked for including every qualifier " +
        "and exclusion they attached, what they had just rejected or moved on " +
        "from, and what a good next response would need to contain. Several " +
        "sentences minimum. If the user changed direction late, that new " +
        "direction is the resumption point — but say what they moved away " +
        "from too, so the next assistant doesn't circle back to it.",
    },
    decisions: {
      type: "array",
      description:
        "Choices that were settled and should NOT be reopened in a new chat.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["decision", "rationale"],
        properties: {
          decision: { type: "string" },
          rationale: {
            type: "string",
            description: "Why it was chosen. Empty string if never stated.",
          },
        },
      },
    },
    constraints: {
      type: "array",
      description:
        "Hard requirements, limitations, preferences, deadlines the user stated.",
      items: { type: "string" },
    },
    findings: {
      type: "array",
      description:
        "Conclusions the ASSISTANT established that should carry forward: " +
        "diagnoses of why something isn't working, recommendations, and " +
        "especially things it advised AGAINST (e.g. 'X and Y don't work well " +
        "together'). These are not user decisions and not user constraints — " +
        "they are hard-won conclusions from the conversation. Omitting them " +
        "is what makes a fresh assistant contradict the previous one or " +
        "re-derive analysis that was already done.",
      items: { type: "string" },
    },
    openQuestions: {
      type: "array",
      description: "Unresolved threads the conversation had not yet settled.",
      items: { type: "string" },
    },
    artifacts: {
      type: "array",
      description:
        "EVERY concrete deliverable the assistant produced: code, drafts, " +
        "configs, tables, plans, recommendations, and any enumerated list " +
        "(e.g. a deck list, an ingredient list, a step-by-step procedure). " +
        "If the assistant offered several options or revisions, capture EACH " +
        "one as its own entry — do not keep only the latest. Reproduce " +
        "content verbatim; this is what would otherwise be lost.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "kind", "content"],
        properties: {
          name: { type: "string" },
          kind: {
            type: "string",
            description: "e.g. code, draft, config, list, data",
          },
          content: { type: "string" },
        },
      },
    },
    glossary: {
      type: "array",
      description:
        "Project-specific terms whose meaning a fresh assistant could not infer.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["term", "meaning"],
        properties: {
          term: { type: "string" },
          meaning: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You extract resumable state from a conversation between a user and an AI assistant.

Your output lets the user start a BRAND NEW chat and pick up exactly where they left off, without re-explaining anything and without the new assistant re-litigating settled decisions.

BE GENEROUS. The checkpoint is pasted into a fresh, empty context window with room to spare — there is no length budget to protect and no prize for brevity. A terse checkpoint is a FAILED checkpoint: every detail you leave out is one the user has to re-explain, which is the exact problem this exists to solve. When unsure whether something belongs, include it. The only things to leave out are pleasantries, restatements, and tangents that were explicitly abandoned.

Rules:
- The single most important field is resumptionPoint. A checkpoint that describes the whole conversation but not where it currently stands will cause the new assistant to respond to a stale request. Read the END of the conversation first: if the user changed direction late, that new direction is the resumption point.
- That recency rule governs what to DO next — never what to RETAIN. Earlier artifacts, findings, and constraints stay in the checkpoint even when the user has moved on from them; superseded work is context the user may return to, and silently dropping it is a loss.
- Capture what is load-bearing for continuing the work. Omit pleasantries, restatements, and abandoned tangents.
- Reproduce artifacts VERBATIM. Do not summarize, shorten, or "clean up" them — losing their exact content is the main failure mode.
- Artifacts must be REPRODUCED, never composed. Each artifact's content must appear as a contiguous block in the conversation — copy it out. Never assemble a summary table, merge several items into one entry, or write your own consolidated version. If you want to characterize a group of things, that belongs in findings; artifacts are quotations.
- This applies hardest to step-by-step procedures, which are the most tempting thing to consolidate. If a procedure was given once and refined later, quote the single most complete version EXACTLY as it appeared — same number of steps, same wording. Do not fold in caveats, product names, or extra steps mentioned elsewhere in the conversation, and do not renumber. A 5-step procedure quoted as a 7-step improved version is a fabrication, however helpful it looks.
- Artifacts are the highest-value part of your output and the easiest to under-capture. Anything concrete the assistant produced is an artifact: code, drafts, configs, tables, plans, and enumerated lists of any kind. When several options or successive revisions were offered, each is its own artifact — keeping only the final one silently discards the alternatives the user was still weighing.
- Being thorough here is not the same as being verbose elsewhere. Compress discussion aggressively; never compress an artifact.
- Record decisions as settled facts, with the stated rationale. If a rationale was never given, use an empty string rather than inventing one.
- ONE decision per array entry. Never combine several decisions into a single string — if you catch yourself writing "and" or a comma-separated list inside a decision, split it into separate entries.
- Never infer intent the user did not express. An empty array is correct and expected when a category genuinely has nothing in it.
- Prefer the user's own wording for constraints and terminology.`;

function formatTranscript(messages) {
  return messages
    .map((m) => `[${m.role.toUpperCase()}]\n${m.text}`)
    .join("\n\n");
}

/** Shared transport. Returns {ok, data, usage} or {ok:false, error}. */
async function callOpenAI(key, body) {
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${e.message}` };
  }

  if (!res.ok) {
    const text = await res.text();
    const detail = {
      401: "Invalid API key.",
      404: `Model "${body.model}" isn't available on this key — swap it in background.js.`,
      429: "Rate limited.",
    }[res.status];
    return {
      ok: false,
      error: detail ?? `OpenAI returned ${res.status}: ${text.slice(0, 200)}`,
    };
  }

  const json = await res.json();
  const choice = json.choices?.[0];

  // strict json_schema guarantees valid JSON *unless* the model refused or the
  // response was truncated. Both surface here rather than as a parse crash.
  if (choice?.message?.refusal) {
    return { ok: false, error: `Model refused: ${choice.message.refusal}` };
  }
  if (choice?.finish_reason === "length") {
    return { ok: false, error: "Conversation too long for one pass." };
  }

  try {
    return { ok: true, data: JSON.parse(choice.message.content), usage: json.usage };
  } catch (e) {
    return { ok: false, error: `Unparseable response: ${e.message}` };
  }
}

async function extract(messages, profileId = "general") {
  const { openaiKey } = await getSettings();
  if (!openaiKey) {
    return { ok: false, error: "No OpenAI key set. Add one in Settings." };
  }

  const transcript = formatTranscript(messages);
  const profile = resolveProfile(profileId, {
    extractModel: EXTRACT_MODEL,
    verifyModel: VERIFY_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    schema: CHECKPOINT_SCHEMA,
  });
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    return {
      ok: false,
      error:
        `Conversation is ~${Math.round(transcript.length / 4000)}k tokens, past ` +
        `what ${profile.extractModel} can hold. Checkpoint the first half separately, ` +
        `or switch to a larger-context model in background.js.`,
    };
  }

  const res = await callOpenAI(openaiKey, {
    model: profile.extractModel,
    messages: [
      { role: "system", content: profile.systemPrompt },
      {
        role: "user",
        content: `Extract resumable state from this conversation:\n\n${transcript}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "checkpoint",
        strict: true,
        schema: profile.schema,
      },
    },
  });

  if (!res.ok) return res;
  return { ok: true, state: res.data, usage: res.usage };
}

// ---------------------------------------------------------- verification
//
// The strong independence claim rests on audit.js, which checks artifacts
// against the source transcript mechanically — no model, no opinion. This
// model pass covers the softer categories: dropped constraints, invented
// claims. It is opt-in (a button), so nobody pays for it unasked.
//
// MUST differ from EXTRACT_MODEL. A model auditing its own output shares the
// blind spots that produced the error and will rubber-stamp it.
const VERIFY_MODEL = "gpt-4o";

const VERIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: {
      type: "string",
      enum: ["faithful", "minor_issues", "major_issues"],
      description:
        "major_issues if anything load-bearing was lost or invented; " +
        "minor_issues for cosmetic gaps; faithful if it would resume cleanly.",
    },
    summary: {
      type: "string",
      description: "One sentence a user can read at a glance.",
    },
    findings: {
      type: "array",
      description: "Empty array when the checkpoint is faithful.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "severity", "detail"],
        properties: {
          type: {
            type: "string",
            enum: ["omission", "fabrication", "distortion"],
          },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          detail: { type: "string" },
        },
      },
    },
  },
};

const VERIFY_PROMPT = `You audit checkpoints: compressed state extracted from a conversation so the user can resume it in a fresh chat.

You are given the ORIGINAL conversation and the EXTRACTED checkpoint, which a different model produced. Judge whether someone handed only the checkpoint could pick up the work without losing anything that mattered.

Report three kinds of problem:
- omission: something load-bearing in the conversation is missing from the checkpoint (a settled decision, a stated constraint, an artifact).
- fabrication: the checkpoint asserts something the conversation never established.
- distortion: present but altered — especially artifacts that were paraphrased, truncated, or "cleaned up" rather than reproduced verbatim.

Judge by what's load-bearing for resuming, not by completeness. Dropped pleasantries, abandoned tangents, and restatements are correct compression, not omissions — do not report them. An empty findings array is the right answer for a good checkpoint; do not invent problems to look useful.`;

async function verify(messages, state, profileId = "general") {
  const { openaiKey } = await getSettings();
  if (!openaiKey) {
    return { ok: false, error: "No OpenAI key set. Add one in Settings." };
  }

  const profile = resolveProfile(profileId, {
    extractModel: EXTRACT_MODEL,
    verifyModel: VERIFY_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    schema: CHECKPOINT_SCHEMA,
  });
  const body = {
    model: profile.verifyModel,
    messages: [
      { role: "system", content: VERIFY_PROMPT },
      {
        role: "user",
        content:
          `<original_conversation>\n${formatTranscript(messages)}\n</original_conversation>\n\n` +
          `<extracted_checkpoint>\n${JSON.stringify(state, null, 2)}\n</extracted_checkpoint>`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "verification",
        strict: true,
        schema: VERIFICATION_SCHEMA,
      },
    },
  };

  const res = await callOpenAI(openaiKey, body);
  if (!res.ok) return res;
  return { ok: true, verification: res.data, usage: res.usage };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    EXTRACT: () => extract(msg.messages, msg.profile),
    VERIFY: () => verify(msg.messages, msg.state, msg.profile),
  };
  const handler = handlers[msg.type];
  if (!handler) return;

  handler().then(sendResponse, (e) =>
    sendResponse({ ok: false, error: e.message })
  );
  return true; // keep the channel open for the async response
});
