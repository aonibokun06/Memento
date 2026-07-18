# Memento — Hackathon Plan

Chrome extension that sits alongside ChatGPT/Claude and does two things:

1. **Checkpoint & restore** — extract the durable state of a conversation, verify it, and let you resume it in a fresh chat. *(the differentiator)*
2. **Live metrics** — token count, cost, context-window %, "switch soon" warning. *(the supporting act)*

The pitch is #1. #2 is table stakes that several extensions already do; it makes the demo legible but it is not why anyone should care.

---

## The one risk that can sink this

Everything downstream depends on reliably scraping an ordered `{role, text}[]` from the live DOM of chatgpt.com and claude.ai. If that doesn't work, nothing else matters.

**Do this first, before writing a single line of extraction logic.** Load the scaffold, open both sites, confirm you get clean arrays. Don't proceed until both work.

Key detail: key off stable semantic attributes (`data-message-author-role`, `data-testid`), never CSS classes — those are build-hash garbage that changes weekly.

---

## Order of operations

Times are rough effort, not a schedule. Steps 2–3 and 4 can run in parallel if you have teammates.

| # | Step | Why it's here |
|---|------|---------------|
| 0 | Setup: Chrome, editor, API key generated | 15 min, unblocks everything |
| 1 | **Scrape both sites** → ordered `{role, text}[]` | highest risk, do it first |
| 2 | Wire content script → side panel, display raw scrape | proves messaging before AI enters |
| 3 | Extraction call (background worker) on a real transcript | the core value |
| 4 | Verification call (second, independent model) | the credibility story |
| 5 | Diff/review UI | makes verification visible |
| 6 | Save checkpoint (`chrome.storage.local`) + restore into new tab | closes the loop |
| 7 | Branching (one checkpoint → two tabs) | cheap once 6 works |
| 8 | Metrics panel | lowest priority, cut first if time runs out |
| 9 | Rehearse the demo on the real account/browser | non-negotiable |

**Cut line:** if you're behind, drop 7 and 8. A working 1–6 is a complete demo. A half-working 1–8 is not.

---

## Architecture

Plain HTML/CSS/JS. No Next.js (there's no server), no bundler, no React unless the diff view genuinely hurts without it. Every minute in build config is a minute not spent on extraction.

```
memento/
  manifest.json
  background.js     # API calls, storage — no DOM access
  content.js        # the only piece that can read the page
  sidepanel.html
  sidepanel.js
```

Dev loop: edit → refresh the extension card on `chrome://extensions` → reload the target tab → retest.

Debugging: content script logs → page DevTools. Background → "Inspect views: service worker" on the extension card. Side panel → right-click → Inspect.

---

## Extraction & verification (steps 3–5)

- User's own API key, stored in `chrome.storage.local`, never leaves the browser.
- Extraction uses **structured outputs** (`output_config.format` with a JSON schema) so you get a validated object, not prose you have to parse.
- Verification is a **second call to a different model** that scores the extracted state against the original transcript. This is the thing that makes the feature trustworthy rather than a lossy summarizer — lead with it in the pitch.
- Use `claude-opus-4-8` for extraction. Verification can be a different provider entirely (that's the point of "independent") — or a different Anthropic model if you're short on time.

Design the checkpoint schema deliberately. Rough shape:

```
{ goal, decisions[], constraints[], openQuestions[], artifacts[], glossary[] }
```

Restore = render that back into a single paste-ready block and drop it into the new chat's textbox.

---

## Metrics (step 8)

Runs continuously; **never blocks on a network call for the common path.**

- `MutationObserver` on the message container; tokenize only the *new* message and add to a running total.
- **Counting:** for Claude, call `POST /v1/messages/count_tokens` — free, exact, and you already have the key. Debounce it (every N messages, not every keystroke). For a live indicator between calls, `chars/4` is a fine interpolation. **Do not use `tiktoken` or `@anthropic-ai/tokenizer` for Claude** — both undercount current models significantly.
- **Cost:** local math. Keep pricing in a config object, not inline — it changes. Read the selected model off the page; pricing *and* context window both depend on it.
- **Context %:** running total vs. a per-model context-window lookup.
- **Pace projection:** simple rate over recent turns → "~N messages until the limit."
- Content script writes totals to `chrome.storage.local`; side panel listens via `chrome.storage.onChanged`. No manual message-passing needed.

**Say the estimates are estimates.** You can't see the hidden system prompt or tool schemas the backend actually bills. Every extension in this space has this gap; naming it proactively reads as credibility.

---

## Demo script

1. Show a long, messy conversation that's visibly degrading.
2. Metrics panel: "82% of context, ~4 messages left." — the *problem*, stated in numbers.
3. Click Checkpoint. Show the extracted state.
4. Show the verification pass — a second model independently confirming nothing load-bearing was dropped. **This is the moment.** Land on it.
5. Open a fresh chat, restore, ask a question that requires deep context. It answers correctly.
6. (If built) branch the same checkpoint into two tabs, take them in different directions.

Do not open with the metrics panel. It's the setup, not the punchline.

---

## Sharing (considered, not committed)

Checkpoints are built to be portable: UUID ids, `schemaVersion` on every record,
self-contained payloads, and a single `toShareable()` seam in `storage.js` that
strips local-only fields (currently `sourceUrl`, which identifies the owner's
chat).

Two things to decide before this ships:

- **It breaks the "nothing leaves your device" story.** That's currently a real
  selling point. Cheapest version that doesn't regress it: export/import as a
  JSON file — real sharing, no backend.
- **Extracted state can contain personal content from the conversation.** No
  architecture fixes this. Sharing needs a human review step that shows exactly
  what's about to go out, before it goes out.

## Notes

- `chrome.storage.local` only. No backend — that's a feature, not a limitation, and it's the honest answer to "where does my conversation data go?"
- Test restore on a **real** long conversation before the demo, not a toy one. Toy conversations hide every interesting failure.
- Have a recorded fallback video. Live scraping against someone else's production DOM on stage is a coin flip.
