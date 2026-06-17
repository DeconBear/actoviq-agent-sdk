---
title: Blog
---

# Blog — Agent Design Notes & Research

Thoughts on agent design, research outcomes, and experimental records from
building the **Actoviq Agent SDK**. Less "how to use the API," more "what we
tried, what we measured, and what we concluded."

## Posts

### [Model Team & Multi‑Model Agent Design — A Research Report](./model-team-agent-design)

*2026‑06‑17 · design + experiment*

Does letting an agent convene a team of models actually produce better results?
Across **48 graded runs** with multi‑dimensional scoring and 3× trials, the
autonomous expert panel proves quality‑neutral on average — with a consistent
**citation/structure edge** at a **~20% cost premium** — and the agent convenes
it on its own ~39% of the time. Includes the Model Team design, the two‑track
benchmark methodology, full results, and five design lessons (forcing
collaboration backfires; single‑run benchmarks lie; composites hide trade‑offs;
verify execution objectively; beware demand‑induced fabrication).

---

## About this blog

Posts live under `docs/blog/` as Markdown files with front‑matter:

```md
---
title: Your Post Title
date: 2026-06-17
---

# Your Post Title

*Published 2026‑06‑17 · short kicker*

…
```

To publish a new post: add the file, then link it from the **Posts** list above
and register it in the blog sidebar (`docs/.vitepress/config.mts`). English only
for now.
