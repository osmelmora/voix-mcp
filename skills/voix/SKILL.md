---
name: voix
description: Speak to the user out loud through the local voix MCP server. Use when the user asks to hear something, wants a spoken update or summary, or when a short audible notification fits better than text.
---

# Speaking with voix

voix turns text into local speech. It exposes two tools: `speak` and `stop`.

## When to speak

- The user asked for something "out loud", "read to me", "tell me", or a spoken briefing.
- A long task finished and the user is likely away from the screen. Keep it to one sentence.
- Do not speak code, URLs, file paths, tables, or anything the user needs to copy. Print those.

## How to write for speech

Write the way a person talks, not the way a document reads.

- Plain prose only. No markdown, headers, bullets, emphasis, or code fences. voix strips them, but prose written for the ear sounds better.
- One to three short paragraphs. Lead with the point. A daily update is roughly 80 to 200 words.
- Spell things the way they are said: "three P M", "Q three", "API" is fine, "k8s" is not. Expand abbreviations the listener may not know.
- Prefer short sentences. Each sentence is synthesized and played in order, so the first one starts almost immediately.
- Avoid parentheses, slashes, and symbols. Say "or", "and", "percent".

## Calling the tools

`speak` returns as soon as the first sentence starts playing; it does not wait for the end. Its result tells you how many sentences were queued and whether this utterance started or is queued behind another.

- Call `speak` once with the whole message rather than once per sentence.
- To replace what is being said, call `stop` and then `speak`.
- If `speak` returns `ModelDownloading`, the speech model is still being fetched on first use. Tell the user it is downloading and try again in a minute.
- Default voice is `af_heart`. Only change `voice` or `speed` when the user asks.

## Example

User: "Give me my morning update out loud."

1. Gather calendar, tasks, and notifications with your other tools.
2. Write a spoken summary: "Good morning. You have three meetings today, the first at ten with the design team. Two pull requests are waiting for your review, and the deploy from last night succeeded. Nothing is overdue."
3. Call `speak` with that text.
4. Reply in text with the same information in brief, so the user also has it on screen.
