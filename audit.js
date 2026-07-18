// Deterministic checks that need no model and no network.
//
// The worst extraction failure is an artifact that got paraphrased, truncated,
// or "cleaned up" instead of reproduced verbatim — a checkpoint containing
// subtly-wrong code looks perfect and is worse than useless. That specific
// failure is mechanically checkable: either the content appears in the
// transcript or it doesn't. No judgment required.

/** Collapse whitespace so scraper/model formatting differences don't matter. */
function normalize(s) {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Check each extracted artifact against the raw transcript.
 *
 * Three states, because "not an exact substring" conflates two very different
 * things: a bulleted list re-joined with commas (harmless) and a renamed
 * variable (fatal). Flagging both identically trains you to ignore the check.
 *
 *   verbatim     — exact match after whitespace normalization
 *   reformatted  — every significant token is present, punctuation/layout differs
 *   altered      — content genuinely diverges from the source
 *   inconclusive — too short for a match to mean anything
 *
 * @returns {{name: string, status: string, coverage?: number}[]}
 */
export function auditArtifacts(messages, state) {
  const haystack = normalize(messages.map((m) => m.text).join("\n"));
  const haystackLower = haystack.toLowerCase();

  return (state.artifacts ?? []).map((a) => {
    const needle = normalize(a.content ?? "");
    if (needle.length < 24) return { name: a.name, status: "inconclusive" };
    if (haystack.includes(needle)) return { name: a.name, status: "verbatim" };

    // Not an exact match — is the *content* there under different formatting?
    const tokens = needle.toLowerCase().match(/[\w']{3,}/g) ?? [];
    const found = tokens.filter((t) => haystackLower.includes(t)).length;
    const coverage = tokens.length ? found / tokens.length : 0;

    return {
      name: a.name,
      status: coverage >= 0.95 ? "reformatted" : "altered",
      coverage,
    };
  });
}

// ------------------------------------------------------------ health check
//
// Aggregates every check that costs nothing into one panel. All of these run
// locally on every extraction — no model, no network, no key.

// Markers that mean the model elided content instead of reproducing it. An
// artifact ending in "..." is worse than a missing one: it looks complete.
const TRUNCATION_MARKERS = [
  /\.\.\.\s*$/,
  /\[\s*truncated\s*\]/i,
  /\[\s*\.\.\.\s*\]/,
  /\/\/\s*\.\.\./,
  /#\s*\.\.\.\s*$/m,
  /\brest of (the )?(code|file|list|deck)\b/i,
  /\b(omitted|abbreviated|shortened) for brevity\b/i,
  /<\s*snip\s*>/i,
  /\b(and )?so on\b\s*$/im,
];

// Credentials that must never end up in a checkpoint — especially one that
// might later be shared. Deliberately conservative: false positives here are
// cheap, a leaked key is not.
const SECRET_PATTERNS = [
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "OpenAI API key"],
  [/\bghp_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "GitHub fine-grained token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bBearer\s+[A-Za-z0-9._-]{24,}/, "bearer token"],
  [/\b(api[_-]?key|secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9._-]{12,}/i,
   "credential assignment"],
];

/** Every string in the checkpoint, for scanning. */
function checkpointText(state) {
  return JSON.stringify(state ?? {});
}

/**
 * Run all local checks.
 * @returns {{status, passed, warnings, blockers, checks: {level,title,detail}[]}}
 */
export function runHealthChecks(messages, state, verification, savedArtifactAudit) {
  const checks = [];
  const artifacts = state?.artifacts ?? [];

  // 1. Artifacts reproduced faithfully?
  const audit = savedArtifactAudit ?? auditArtifacts(messages, state ?? {});
  const altered = audit.filter((r) => r.status === "altered");
  if (artifacts.length === 0) {
    checks.push({
      level: "pass",
      title: "No artifacts to verify",
      detail: "This conversation produced no code, lists, or deliverables.",
    });
  } else if (altered.length) {
    checks.push({
      level: "blocker",
      title: `${altered.length} of ${artifacts.length} artifacts altered`,
      detail: `Content differs from the source: ${altered
        .map((r) => r.name)
        .join(", ")}`,
    });
  } else {
    const reformatted = audit.filter((r) => r.status === "reformatted").length;
    checks.push({
      level: "pass",
      title: `All ${artifacts.length} artifacts match the transcript`,
      detail: reformatted
        ? `${reformatted} reformatted — same content, different layout.`
        : "Reproduced verbatim.",
    });
  }

  // 2. Elided content?
  const truncated = artifacts.filter((a) =>
    TRUNCATION_MARKERS.some((re) => re.test(a.content ?? ""))
  );
  checks.push(
    truncated.length
      ? {
          level: "warning",
          title: "Possible artifact truncation",
          detail: `${truncated.length} artifact(s) contain truncation markers: ${truncated
            .map((a) => a.name)
            .join(", ")}`,
        }
      : {
          level: "pass",
          title: "No truncation markers",
          detail: "Artifacts appear complete rather than elided.",
        }
  );

  // 3. Credentials, especially relevant before sharing.
  const text = checkpointText(state);
  const found = SECRET_PATTERNS.filter(([re]) => re.test(text)).map(
    ([, label]) => label
  );
  checks.push(
    found.length
      ? {
          level: "blocker",
          title: "Possible credentials in checkpoint",
          detail: `Matched: ${found.join(", ")}. Remove before saving or sharing.`,
        }
      : {
          level: "pass",
          title: "No common secret patterns detected",
          detail: "Checkpoint content passed the local secret scan.",
        }
  );

  // 4. Has anything checked the claims themselves?
  if (!verification) {
    checks.push({
      level: "warning",
      title: "Verification has not been run",
      detail: "Claims have not yet been checked against transcript evidence.",
    });
  } else {
    checks.push({
      level: verification.verdict === "major_issues" ? "blocker" : "pass",
      title: `Independently verified: ${verification.verdict.replace("_", " ")}`,
      detail: verification.summary,
    });
    // Each finding gets its own row so it's actionable rather than buried in
    // a paragraph. Severity maps onto the same three levels as everything else.
    for (const f of verification.findings ?? []) {
      checks.push({
        level: f.severity === "high" ? "blocker" : "warning",
        title: `${f.type} (${f.severity})`,
        detail: f.detail,
      });
    }
  }

  // 5. Is there a live edge to resume from?
  checks.push(
    state?.resumptionPoint
      ? {
          level: "pass",
          title: "Resumption point captured",
          detail: "The checkpoint records where the conversation currently stands.",
        }
      : {
          level: "warning",
          title: "No resumption point",
          detail: "A new chat may respond to a stale request.",
        }
  );

  const count = (l) => checks.filter((c) => c.level === l).length;
  const blockers = count("blocker");
  const warnings = count("warning");

  return {
    status: blockers ? "BLOCKED" : warnings ? "REVIEW" : "HEALTHY",
    passed: count("pass"),
    warnings,
    blockers,
    checks,
  };
}

/** One-line summary, or null when there are no artifacts to check. */
export function summarizeArtifactAudit(results) {
  if (results.length === 0) return null;

  const by = (s) => results.filter((r) => r.status === s);
  const altered = by("altered");
  const reformatted = by("reformatted");

  if (altered.length) {
    return (
      `✗ ${altered.length} of ${results.length} artifact(s) ALTERED — content ` +
      `differs from the source: ${altered.map((r) => r.name).join(", ")}`
    );
  }
  if (reformatted.length) {
    return (
      `✓ All ${results.length} artifact(s) present. ${reformatted.length} ` +
      `reformatted (same content, different layout).`
    );
  }
  return `✓ All ${results.length} artifact(s) reproduced verbatim.`;
}
