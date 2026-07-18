// Profile-specific extraction is additive. The verified General schema and
// prompt remain the base contract in background.js; profiles only extend them.

const ENGINEERING_STATE = {
  type: "object",
  additionalProperties: false,
  required: [
    "branch",
    "completed",
    "inProgress",
    "blocked",
    "files",
    "commands",
    "knownIssues",
    "nextActions",
    "definitionOfDone",
  ],
  properties: {
    branch: { type: "string", description: "Current branch, or empty when unstated." },
    completed: { type: "array", items: { type: "string" } },
    inProgress: { type: "array", items: { type: "string" } },
    blocked: { type: "array", items: { type: "string" } },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "status", "purpose"],
        properties: {
          path: { type: "string" },
          status: { type: "string" },
          purpose: { type: "string" },
        },
      },
    },
    commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "result"],
        properties: {
          command: { type: "string" },
          result: {
            type: "string",
            description: "Explicit result only; empty when the transcript does not state one.",
          },
        },
      },
    },
    knownIssues: { type: "array", items: { type: "string" } },
    nextActions: { type: "array", items: { type: "string" } },
    definitionOfDone: { type: "array", items: { type: "string" } },
  },
};

const ENGINEERING_RULES = `

Engineering profile additions:
- Capture software work state in engineeringState: branch, completed and in-progress work, blockers, files, commands and their explicit results, known issues, next actions, and definition of done.
- Never invent a branch, file, command, test result, completion claim, or blocker. Empty values are correct when the conversation did not establish them.
- Keep artifacts as contiguous verbatim quotations. Never assemble a synthetic "final file" from multiple turns; engineeringState may describe files, but artifacts remain source-faithful quotations.`;

export const PROFILE_OPTIONS = [
  { id: "general", label: "General" },
  { id: "engineering", label: "Engineering / SWE" },
];

export function resolveProfile(id, base) {
  if (id !== "engineering") {
    return { id: "general", label: "General", ...base };
  }

  const properties = {
    ...base.schema.properties,
    engineeringState: ENGINEERING_STATE,
  };
  return {
    ...base,
    id: "engineering",
    label: "Engineering / SWE",
    systemPrompt: `${base.systemPrompt}${ENGINEERING_RULES}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(properties),
      properties,
    },
  };
}
