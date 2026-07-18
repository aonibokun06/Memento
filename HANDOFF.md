# Handoff — `feature/verification` → profile work

For whoever is building the **normal / engineering profile split**. Read this
before touching `background.js`, `audit.js`, or `storage.js`. It documents the
invariants that the extraction and verification pipeline depends on, why they
are shaped the way they are, and where to add profile-specific behavior without
breaking anything.

**Repo state at handoff:** branch `feature/verification`, uncommitted.
Modified: `PLAN.md`, `background.js`, `sidepanel.html`, `sidepanel.js`,
`storage.js`. New untracked file: `audit.js`.

---

## 1. What this branch built

A four-stage pipeline in the side panel: **Scan › Extract › Verify › Save**,
plus **Restore**.

| File | Role | Conflict risk with profile work |
|---|---|---|
| `content.js` | DOM scraping, scroll-harvest, composer fill | **None** — profile-agnostic |
| `background.js` | Schema, prompts, OpenAI calls | **HIGH** — this is where profiles live |
| `audit.js` | Deterministic checks + health panel | **Medium** — may want per-profile checks |
| `storage.js` | Persistence, restore prompt, share seam | **Medium** — new fields need rendering |
| `sidepanel.js` | All UI | **Medium** — new sections need rendering |
| `manifest.json`, `sidepanel.html` | Config, styles | Low |

The current pipeline is effectively the **normal profile**. Treat it as the base
case rather than as something to rewrite.

---

## 2. Invariants — breaking these breaks the product

These are not style preferences. Each one exists because something failed
without it.

### I1. Artifacts are quotations, never compositions

`audit.js` verifies every artifact by checking whether its content appears in
the raw transcript. That check is the strongest claim the product makes — "we
don't just ask a model to grade a model; artifacts are matched against the
source." It only works if the extractor **quotes** rather than **composes**.

The system prompt says so explicitly:

> Artifacts must be REPRODUCED, never composed. Each artifact's content must
> appear as a contiguous block in the conversation.

An engineering profile will be tempted to let the model assemble a
"consolidated final version" of code across several turns. **Do not.** That
silently defeats the artifact check and is exactly how a subtly-broken file
ships looking authoritative. If you need a synthesized view, add a *separate*
field with a different name — do not put it in `artifacts[]`.

### I2. The `artifacts[]` shape is a contract

`audit.js` reads `a.content` and `a.name`. `storage.js` renders
`a.name`, `a.kind`, `a.content` into the restore prompt. Adding fields is safe.
Renaming or removing those three breaks the audit and the restore silently —
no exception, just a checkpoint that verifies nothing.

### I3. OpenAI strict mode: every property must be in `required`

`response_format: {type: "json_schema", strict: true}` rejects any schema where
a property is absent from `required`, and rejects any object without
`additionalProperties: false`. There are **no optional fields**. A field with
nothing to say returns `""` or `[]`.

If you add a field to a profile schema and forget `required`, the API returns
400 at runtime — not at build time. Check both lists when editing.

### I4. `resumptionPoint` must exist in every profile schema

`audit.js` → `runHealthChecks()` warns when it is missing, and
`storage.js` → `formatRestorePrompt()` renders it. More importantly it is the
field that makes a resume land on the *current* request rather than a stale
one. Removing it regresses the core behavior.

### I5. No brevity caps

The schema descriptions used to say things like "one or two sentences." That
was wrong and was removed deliberately. The checkpoint is pasted into a *fresh,
empty* context window — there is no length budget to protect. The system prompt
now opens with `BE GENEROUS`. Do not reintroduce terseness instructions into a
profile prompt; a short checkpoint is a failed checkpoint.

### I6. Recency governs what to DO, never what to RETAIN

The prompt tells the model to read the end of the conversation first so
`resumptionPoint` reflects the live request. An earlier version over-applied
this and the model started **dropping earlier artifacts** — a real regression
caught by the verifier. The prompt now says explicitly:

> That recency rule governs what to DO next — never what to RETAIN.

Keep that clause in any profile prompt that inherits the recency instruction.

### I7. Extractor and verifier must be different models

`EXTRACT_MODEL` (`gpt-4.1`) and `VERIFY_MODEL` (`gpt-4o`) differ on purpose. A
model auditing its own output shares the blind spots that produced the error
and will rubber-stamp it. If a profile overrides one, check it doesn't collide
with the other.

Also: extraction uses `gpt-4.1` for its **context window**, not its quality.
Under a 128k model, long conversations — the entire point of this tool — get
truncated on the way in and produce a confident checkpoint missing half the
conversation. Don't "optimize" extraction onto a smaller model.

---

## 3. Recommended architecture for profiles

**Do not add `if (profile === "engineering")` branches inside `background.js`.**
That maximizes merge conflicts, because both of us edit the same lines.

Instead, create a new file — **`profiles.js`** — that `background.js` imports.
New profiles are then additive, in a file only you touch:

```js
// profiles.js
export const PROFILES = {
  normal: {
    id: "normal",
    label: "General",
    extractModel: "gpt-4.1",
    verifyModel: "gpt-4o",
    systemPrompt: NORMAL_PROMPT,
    schema: NORMAL_SCHEMA,
    // extra render sections, keyed by state field
    sections: [["Established findings", "findings"]],
  },
  engineering: {
    id: "engineering",
    label: "Engineering",
    // ...same shape, code-aware prompt + schema
  },
};
```

Then `background.js` shrinks to a lookup:

```js
const profile = PROFILES[msg.profile ?? "normal"];
const res = await callOpenAI(openaiKey, {
  model: profile.extractModel,
  messages: [{ role: "system", content: profile.systemPrompt }, ...],
  response_format: { type: "json_schema",
    json_schema: { name: "checkpoint", strict: true, schema: profile.schema } },
});
```

Suggested split of the current schema: keep `title`, `goal`, `resumptionPoint`,
`decisions`, `constraints`, `openQuestions`, `artifacts`, `glossary`,
`findings` as a **shared base**, and have each profile spread it and add its
own fields. The engineering profile plausibly wants things like
`filesTouched`, `commands`, `testStatus`, `blockers`, `nextActions` — the
screenshot from the parallel work suggests exactly that.

```js
const BASE = { /* the 9 shared properties */ };
const ENGINEERING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...Object.keys(BASE), "filesTouched", "commands", "testStatus"],
  properties: { ...BASE, filesTouched: {...}, commands: {...}, testStatus: {...} },
};
```

Note `required` is derived from `properties` — that pattern makes I3 hard to
violate.

---

## 4. Where each layer needs touching for a new profile

1. **`profiles.js`** (new) — prompt + schema. Most of the work.
2. **`background.js`** — accept `profile` in the `EXTRACT`/`VERIFY` messages and
   look it up. Should be a handful of lines once `profiles.js` exists.
3. **`storage.js`** → `saveCheckpoint` — store `profile: "engineering"` on the
   checkpoint. Needed so restore knows how to render it, and so mixed lists
   display correctly.
4. **`storage.js`** → `formatRestorePrompt` — render profile-specific sections.
   Currently a hardcoded sequence of `section(...)` calls; driving it from
   `profile.sections` would let both profiles share one function.
5. **`sidepanel.js`** → `renderState` — same, currently hardcoded sections.
6. **`sidepanel.js`** — a profile picker in the Capture view, defaulting to
   `normal`.

---

## 5. Merge conflict guide

Likely collisions and how to resolve them:

| Location | Why it collides | Resolution |
|---|---|---|
| `background.js` `CHECKPOINT_SCHEMA` | Both add fields | Take **both** sets of properties; make sure every added key is also in `required` (I3) |
| `background.js` `SYSTEM_PROMPT` | Both edit rules | Take **both** rule lines. They are additive bullets. Do not drop the `BE GENEROUS` opener (I5) or the recency clause (I6) |
| `sidepanel.js` `renderState` | Both add sections | Take both `section(...)` calls; order matters only for readability |
| `storage.js` `formatRestorePrompt` | Both add sections | Take both, but keep the **verbatim tail last** — recency drives what the model acts on |
| `audit.js` `runHealthChecks` | Both add checks | Take both; the tally is computed from `checks[]` so it self-adjusts |
| `sidepanel.js` state vars | Both add module-level `let` | Take both — but check for a duplicate `let` of the same name, which is a hard parse error |

**If a conflict is ambiguous, prefer keeping both sides.** Every field here is
additive; the failure mode of taking both is a slightly verbose checkpoint,
while the failure mode of dropping one is silent data loss.

**After any merge, run this** — it catches the two errors that don't surface
until runtime:

```bash
for f in *.js; do node --check "$f" || echo "SYNTAX FAIL $f"; done
```

Then extract once against a real conversation and confirm the health panel
shows no unexpected blockers. A schema/`required` mismatch shows up as a 400
from OpenAI, not as a parse error.

---

## 6. Things that look like bugs but aren't

- **`document.execCommand` in `content.js`** is deprecated and intentional.
  Both composers are contenteditable ProseMirror behind React; setting
  `.innerText` updates the DOM but not framework state, leaving the send button
  disabled. `execCommand` fires the real input events.
- **Scan visibly scrolls the page.** Both platforms virtualize long
  conversations — messages scrolled out of view leave the DOM. The harvest
  scrolls top→bottom collecting as it renders. Removing it silently caps you at
  one viewport of messages.
- **Restore always copies to the clipboard**, even when auto-fill succeeds.
  That is deliberate demo insurance; if the composer selector breaks, paste
  still works. Don't remove it.
- **Empty arrays in a checkpoint are correct**, not a failure. The prompt says
  so. A conversation with no code genuinely has no artifacts.
- **Artifact status `reformatted`** is a pass, not a warning. A comma-joined
  list is not a paraphrase; conflating them trains users to ignore the check.

---

## 7. Open items not addressed on this branch

- **Verification is capped by `gpt-4o`'s context window** (~128k). Extraction
  handles longer conversations than verification can check. Chunked
  verification is unbuilt.
- **`toShareable()` in `storage.js`** strips local-only fields (`sourceUrl`)
  and is the single seam for the future sharing feature. Nothing calls it yet.
  If a profile adds an identifying field, add it to `LOCAL_ONLY_FIELDS`.
- **`importCheckpoint()`** rejects mismatched `schemaVersion`. If profiles
  change the shape of stored checkpoints, bump `SCHEMA_VERSION` in
  `storage.js` and decide what to do with existing records.
- **The `kind` field on artifacts is free text.** An engineering profile might
  want it constrained to an enum (`code`, `config`, `test`, `diff`) — that's a
  reasonable profile-level tightening.

---

## 8. How to evaluate whether a profile change is good

The north star, from `PLAN.md`:

> The new conversation starts exactly where the old one ended, losing nothing
> that matters. The success test is not "is this a good summary." It is: *the
> new assistant's next reply should be as good as if the entire conversation
> were still in its context.*

The actual test, not a proxy: restore a checkpoint into a fresh chat and ask a
follow-up that only makes sense with full context — a pronoun reference, a
"give me the other one." If the new assistant asks something already answered,
a field is thin. Verdicts and health panels are proxies; this is the measurement.
