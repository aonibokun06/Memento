// Deterministic checkpoint preflight. This module never calls a model and never
// trusts a stored overall score: the report is derived from the checkpoint's
// current state and its individual verification results every time it is shown.

const SECRET_PATTERNS = [
  { label: "OpenAI API key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { label: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { label: "Private key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
];

function checkpointText(checkpoint) {
  // sourceUrl is intentionally excluded: health inspects portable content, not
  // local metadata that will be stripped when the checkpoint is shared.
  const { sourceUrl: _local, ...portable } = checkpoint ?? {};
  return JSON.stringify(portable);
}

function add(findings, severity, category, label, detail, count = 1) {
  findings.push({ severity, category, label, detail, count });
}

/**
 * Derive a health report from checkpoint state and granular verification data.
 * Expected future verification shape:
 *   { claims: [{ status, type?, introducedBy?, approvedByUser? }],
 *     conflicts: [], artifacts: [{ status }] }
 * Missing verification is reported honestly as REVIEW, never treated as passed.
 */
export function analyzeCheckpointHealth(checkpoint) {
  const findings = [];
  const state = checkpoint?.state;

  if (!state) {
    add(findings, "error", "Completeness", "Missing checkpoint state",
      "Run extraction again before restoring or sharing this checkpoint.");
  } else {
    if (!state.goal?.trim()) {
      add(findings, "error", "Completeness", "Missing goal",
        "The recipient will not know what the conversation is trying to accomplish.");
    }

    const artifacts = state.artifacts ?? [];
    const emptyArtifacts = artifacts.filter((a) => !a.content?.trim());
    if (emptyArtifacts.length) {
      add(findings, "error", "Artifacts", "Empty artifacts",
        `${emptyArtifacts.length} artifact(s) have no preserved content.`, emptyArtifacts.length);
    }
    const suspiciousArtifacts = artifacts.filter((a) =>
      /(?:\.\.\.|\[truncated\]|content omitted|rest of (?:code|file))/i.test(a.content ?? "")
    );
    if (suspiciousArtifacts.length) {
      add(findings, "warning", "Artifacts", "Possible artifact truncation",
        `${suspiciousArtifacts.length} artifact(s) contain truncation markers.`, suspiciousArtifacts.length);
    }
    if (artifacts.length && !emptyArtifacts.length && !suspiciousArtifacts.length) {
      add(findings, "pass", "Artifacts", "Artifacts contain preserved content",
        `${artifacts.length} artifact(s) passed basic integrity checks.`, artifacts.length);
    }
  }

  const secrets = SECRET_PATTERNS.flatMap(({ label, re }) => {
    re.lastIndex = 0;
    return [...checkpointText(checkpoint).matchAll(re)].map(() => label);
  });
  if (secrets.length) {
    add(findings, "error", "Security", "Possible secrets detected",
      `${secrets.length} sensitive value(s) must be reviewed before sharing.`, secrets.length);
  } else {
    add(findings, "pass", "Security", "No common secret patterns detected",
      "Portable checkpoint content passed the local secret scan.");
  }

  const verification = checkpoint?.verification;
  const claims = verification?.claims;
  if (!Array.isArray(claims) || claims.length === 0) {
    add(findings, "warning", "Evidence", "Verification has not been run",
      "Claims have not yet been checked against transcript evidence.");
  } else {
    const verified = claims.filter((c) => c.status === "verified").length;
    const unsupported = claims.filter((c) => c.status === "unsupported").length;
    const conflicting = claims.filter((c) => c.status === "conflicting").length;
    const unapproved = claims.filter((c) =>
      c.type === "decision" && c.introducedBy === "assistant" && c.approvedByUser !== true
    ).length;

    if (verified) add(findings, "pass", "Evidence", "Verified claims",
      `${verified} claim(s) are supported by transcript evidence.`, verified);
    if (unsupported) add(findings, "warning", "Evidence", "Unsupported claims",
      `${unsupported} claim(s) need evidence or removal.`, unsupported);
    if (conflicting) add(findings, "error", "Conflicts", "Unresolved conflicts",
      `${conflicting} contradictory claim(s) require a decision.`, conflicting);
    if (unapproved) add(findings, "warning", "Decisions", "Unapproved assistant decisions",
      `${unapproved} assistant suggestion(s) are recorded as decisions without user approval.`, unapproved);
  }

  const explicitConflicts = verification?.conflicts?.filter(
    (conflict) => conflict.status !== "resolved"
  ).length ?? 0;
  if (explicitConflicts) {
    add(findings, "error", "Conflicts", "Unresolved verification conflicts",
      `${explicitConflicts} conflict(s) must be resolved.`, explicitConflicts);
  }

  const artifactChecks = verification?.artifacts;
  const corrupt = Array.isArray(artifactChecks)
    ? artifactChecks.filter((a) => ["changed", "corrupt", "mismatch"].includes(a.status)).length
    : 0;
  if (corrupt) {
    add(findings, "error", "Artifacts", "Artifact verification failed",
      `${corrupt} artifact(s) no longer match their verified content.`, corrupt);
  }
  const unknownArtifacts = Array.isArray(artifactChecks)
    ? artifactChecks.filter((a) => a.status === "unknown").length
    : 0;
  if (unknownArtifacts) {
    add(findings, "warning", "Artifacts", "Artifacts could not be verified",
      `${unknownArtifacts} artifact(s) need manual review.`, unknownArtifacts);
  }

  const status = findings.some((f) => f.severity === "error")
    ? "blocked"
    : findings.some((f) => f.severity === "warning")
      ? "review"
      : "ready";

  return {
    status,
    findings,
    counts: {
      passed: findings.filter((f) => f.severity === "pass").length,
      warnings: findings.filter((f) => f.severity === "warning").length,
      blockers: findings.filter((f) => f.severity === "error").length,
    },
  };
}
