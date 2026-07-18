// Service worker. No DOM access. This is the only place that makes network
// calls, and the only place the API key is ever read.

import { getSettings } from "./storage.js";

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[memento]", err));

// Swap freely — needs to be a model that supports json_schema response_format.
const EXTRACT_MODEL = "gpt-4o";

// OpenAI strict mode requires every property to appear in `required` and every
// object to set additionalProperties:false. There are no optional fields — a
// field with nothing to say comes back as "" or [].
const CHECKPOINT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "goal",
    "decisions",
    "constraints",
    "openQuestions",
    "artifacts",
    "glossary",
  ],
  properties: {
    title: {
      type: "string",
      description: "Short descriptive title for this conversation, max 8 words.",
    },
    goal: {
      type: "string",
      description:
        "What the user is ultimately trying to accomplish. One or two sentences.",
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
    openQuestions: {
      type: "array",
      description: "Unresolved threads the conversation had not yet settled.",
      items: { type: "string" },
    },
    artifacts: {
      type: "array",
      description:
        "Concrete things produced: code, drafts, configs, structured data. " +
        "Reproduce content verbatim — this is what would otherwise be lost.",
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

Rules:
- Capture what is load-bearing for continuing the work. Omit pleasantries, restatements, and abandoned tangents.
- Reproduce artifacts (code, drafts, configs) VERBATIM. Do not summarize, shorten, or "clean up" them — losing their exact content is the main failure mode.
- Record decisions as settled facts, with the stated rationale. If a rationale was never given, use an empty string rather than inventing one.
- Never infer intent the user did not express. An empty array is correct and expected when a category genuinely has nothing in it.
- Prefer the user's own wording for constraints and terminology.`;

function formatTranscript(messages) {
  return messages
    .map((m) => `[${m.role.toUpperCase()}]\n${m.text}`)
    .join("\n\n");
}

async function extract(messages) {
  const { openaiKey } = await getSettings();
  if (!openaiKey) {
    return { ok: false, error: "No OpenAI key set. Add one in Settings." };
  }

  let res;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Extract resumable state from this conversation:\n\n${formatTranscript(messages)}`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "checkpoint",
            strict: true,
            schema: CHECKPOINT_SCHEMA,
          },
        },
      }),
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${e.message}` };
  }

  if (!res.ok) {
    const body = await res.text();
    const detail = { 401: "Invalid API key.", 429: "Rate limited." }[res.status];
    return {
      ok: false,
      error: detail ?? `OpenAI returned ${res.status}: ${body.slice(0, 200)}`,
    };
  }

  const data = await res.json();
  const choice = data.choices?.[0];

  // strict json_schema guarantees valid JSON *unless* the model refused or the
  // response was truncated. Both surface here rather than as a parse crash.
  if (choice?.message?.refusal) {
    return { ok: false, error: `Model refused: ${choice.message.refusal}` };
  }
  if (choice?.finish_reason === "length") {
    return {
      ok: false,
      error: "Conversation too long for one extraction pass.",
    };
  }

  try {
    return {
      ok: true,
      state: JSON.parse(choice.message.content),
      usage: data.usage,
    };
  } catch (e) {
    return { ok: false, error: `Unparseable response: ${e.message}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "EXTRACT") {
    extract(msg.messages).then(sendResponse, (e) =>
      sendResponse({ ok: false, error: e.message })
    );
    return true; // keep the channel open for the async response
  }
});
