# Spec — Context meter & switch warning

Status: **not built.** This is a design doc for a feature we may implement.

---

## What it is

A live readout in the side panel showing how full the current conversation's
context window is, roughly what it has cost, and a warning when it's time to
checkpoint and start a new chat.

Its real job is **not** to be a token counter. It's to state the problem that
makes checkpointing worth doing, and to put the "Checkpoint now" action in
front of the user at the moment it becomes true. A meter nobody acts on is
decoration.

---

## Honest positioning

This is the least differentiated thing we could build. Several extensions
already show token counts for ChatGPT and Claude. Nothing about the counting is
novel.

What *is* ours is the follow-through: we're the only one where "you're at 82%"
leads to a button that preserves the conversation instead of just telling you
to feel bad about it. Build it as a lead-in to checkpointing, not as a
standalone feature, and keep it visually secondary in the demo.

---

## Architecture

Everything runs **locally**. No network calls, no API key, nothing leaves the
device. That property is worth protecting — it's what lets the meter run
continuously without cost, and it keeps the privacy story intact.

```
content.js
  MutationObserver on the message container
    → new message detected
    → estimate its tokens, add to running total
    → detect current model from the page
    → chrome.storage.local.set({ meter: {...} })

sidepanel.js
  chrome.storage.onChanged listener
    → re-render meter
    → when threshold crossed, surface "Checkpoint now"

background.js
  chrome.action.setBadgeText  ← optional, see below
```

The `chrome.storage` round-trip is deliberate: it avoids hand-rolled message
passing, and it means the side panel shows the right number even if it was
closed while the conversation grew.

---

## Token counting

**Use a local estimate. Do not call an API for this.** A network round-trip per
message would be slow, would cost money to tell the user about cost, and would
break the no-network property.

Two options:

| Approach | Accuracy | Cost |
|---|---|---|
| `chars / 4` heuristic | ±15–20% | zero, no dependency |
| bundle `gpt-tokenizer` | near-exact for OpenAI | adds a build step |

**Recommendation: start with `chars / 4`.** It is enough to drive a warning
threshold, and it is what several shipping extensions use under the hood. Only
reach for a real tokenizer if the displayed number needs to be defensible —
and note that adding a bundler to this project is a bigger change than the
feature itself.

Do **not** use `tiktoken` for Claude — it's OpenAI's tokenizer and undercounts
Claude significantly. If Claude accuracy ever matters, Anthropic's
`/v1/messages/count_tokens` endpoint is free but needs a key and a network
call, so it would only make sense as an occasional reconciliation, not per
message.

### The limitation to state out loud

We cannot see:

- the platform's hidden system prompt
- tool/function schemas
- injected memory or personalization
- retrieved documents

So the number is always an **underestimate** of what the backend actually
bills. Every extension in this space has this gap. Label the readout
"estimated" and say so in the demo — naming it proactively reads as
credibility, and someone in the audience will know.

---

## Model detection

Context window and pricing both depend on which model is selected, so the meter
has to read it off the page.

- **claude.ai** — shown in the composer ("Sonnet 5")
- **chatgpt.com** — shown in the model picker

Same fragility as scraping: key off stable attributes, never CSS classes, and
degrade gracefully. If the model can't be detected, fall back to a conservative
default window rather than hiding the meter — a rough warning beats none.

---

## Config tables

Keep both in one config object, not inline. These change, and they're the thing
most likely to go stale:

```js
const MODELS = {
  "gpt-4o":       { context: 128_000, in: 2.50,  out: 10.00 },
  "claude-sonnet-5": { context: 1_000_000, in: 3.00, out: 15.00 },
  // …
};
const DEFAULT = { context: 128_000, in: 3.00, out: 15.00 };
```

Prices are per million tokens. Verify against current pricing pages before
demoing — don't trust values copied from a model's memory, including mine.

---

## What to display

In rough order of value per unit of effort:

1. **Context used** — `62% of 128k` with a bar. The core signal.
2. **Messages remaining at current pace** — average tokens per turn over the
   last ~5 turns, divided into the remaining budget. "~7 messages left" is far
   more actionable than a percentage.
3. **Estimated conversation cost** — running total. Cheap once you have counts.
4. **Cost per message** — same data, different view. Skip unless asked.

---

## Warning logic

Thresholds are a starting point, not the interesting part:

| Used | State | Behavior |
|---|---|---|
| < 60% | calm | meter only |
| 60–80% | notice | amber meter, "Checkpoint" button gains emphasis |
| > 80% | urgent | red, explicit "Checkpoint now — you're near the limit" |

**The better trigger is pace, not level.** A conversation at 55% that's adding
8k tokens per turn is in more trouble than one at 75% adding 500. Prefer
"about 3 messages left" over "75% full" wherever there's room to show one.

**Optional: badge on the extension icon.** `chrome.action.setBadgeText` puts the
percentage on the toolbar icon so the warning is visible without opening the
side panel. Cheap, and it's the difference between a meter you check and a
meter that tells you.

---

## The part that actually matters

When the warning fires, it must offer **one click that does the whole thing**:
scan → extract → verify → save → open a new chat with the checkpoint restored.
Every step the user has to perform themselves is a step where they'll shrug and
keep going in the degraded conversation.

If we build the meter and stop before that button, we've built the commodity
half and skipped ours.

---

## Conflict risk with parallel work

| File | Change | Risk |
|---|---|---|
| `content.js` | MutationObserver, model detection | **Low** — profile work doesn't touch it |
| `sidepanel.js` | meter render, threshold UI | **Medium** — shared file, keep additive |
| `sidepanel.html` | meter styles | Low |
| `background.js` | badge text only | Low |
| `storage.js` | none needed | None |

Most of the work lands in `content.js`, which is the safest file in the repo
right now. Follow the merge guidance in `HANDOFF.md`: additive changes, and
when in doubt keep both sides.

---

## Build estimate

| Piece | Time |
|---|---|
| MutationObserver + running count | 20 min |
| Model detection + config tables | 20 min |
| Meter UI + thresholds | 25 min |
| One-click checkpoint from the warning | 20 min |
| Badge text | 10 min |

Roughly **1.5 hours** for the whole thing; ~40 minutes for a demo-credible
version (count + meter + button, no badge, no pace projection).

---

## Open questions

- Does the meter count the *whole* conversation, or only what's currently in
  the model's window? On platforms that silently truncate or compact, those
  diverge — and we can't see which has happened.
- Should it warn on **degradation** rather than capacity? The original idea was
  a quality signal ("responses are getting worse"), which is more useful but
  needs a model call and is much harder to make trustworthy.
- Do we persist meter history per conversation, or recompute on each scan?
  Recomputing is simpler and always correct; persisting enables trend display.
