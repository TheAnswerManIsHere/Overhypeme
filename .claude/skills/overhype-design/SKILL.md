---
name: overhype-design
description: Use when building, editing, or styling any frontend for overhype.me — React components, pages, fact cards, meme layouts, modals, or navigation. Defines brand tokens (colors, typography, spacing), component patterns, and anti-patterns to avoid.
---

# overhype.me Design System

## Brand identity

overhype.me is a personalized "impossible facts" meme platform. The aesthetic is **dark, cinematic, hyperbolic** — movie poster meets locker-room legend, not SaaS dashboard. Tagline: *"Where legends are made up."*

The visual language exists to support hyperbole. Type should feel oversized and confident. Layouts should feel composed, not utilitarian. Spacing should be generous. The interface should feel like it takes itself seriously enough to be funny.

## Design tokens

**Colors**
- `#ff6b35` — fire orange (primary accent, CTAs, key emphasis)
- `#111` — near-black (primary background)
- Pure `#000` is too flat; pure white text is too clinical — use `#f5f5f5` or similar off-white for body
- Reserve orange for moments that matter (CTAs, active states, key tokens). Overuse kills its punch.

**Typography**
- **Bebas Neue** — display only. Headlines, fact text, hero copy. All caps reads as movie-poster confidence. Tighten tracking at large sizes.
- **DM Sans** — body, UI labels, paragraph copy. Modern, comfortable, doesn't compete with Bebas.
- **JetBrains Mono** — metadata only. Timestamps, IDs, generation telemetry, debug info. Signals "system value, not editorial copy."

Never mix these roles. Body copy in Bebas reads as shouting; headlines in DM Sans read as a dashboard.

**Spacing**
- Lean generous. Mobile-first, but don't cram. A fact card should breathe — the fact is the point, not the chrome around it.

## LEGEND tier visual treatment

LEGEND is framed as **identity acquisition**, not feature unlock. Visual treatment should reflect that:
- Subtle, not gaudy. No gold gradients, no crowns, no sparkles.
- A small mark or badge near the user's name is more powerful than a colored border around their content.
- LEGEND-only affordances (e.g., higher-tier video output) should feel earned, not stamped.

## Component patterns

**Fact cards** — the atomic unit. Hierarchy: personalized fact text (Bebas, large, dominant) → attribution / personalization context → engagement row (vote, comment icon, share). Tapping the comment icon expands the card in place to show top 2–3 comments + quick reply. The detail page remains canonical for full threads.

**Meme grid** — visual-first. Image dominates; text overlay is the meme. Default sort is Wilson-score ranking; sort controls visible but secondary.

**Pronoun tokens in admin/edit views** — the five tokens (`{SUBJ}`, `{OBJ}`, `{POSS}`, `{POSS_PRO}`, `{REFL}`) and verb-conjugation pairs (`{singular|plural}`) should render as styled inline pills, not raw text. Three-pronoun preview is the confirmation pattern.

## Interaction guidelines

- Detect hover capability with `@media (hover: hover) and (pointer: fine)`, never viewport width. Touch devices should not get hover-only affordances.
- Captcha appears inline at the moment of action for unauthenticated users, not as a gate before they see content.
- Errors are short, direct, in-context. No generic "Something went wrong."

## Anti-patterns to avoid

- **Generic AI-tech aesthetic**: gradient blobs, glassmorphism, "neural" iconography, purple-to-blue gradients. None of these fit the brand.
- **Bootstrap-y card stacks**: rounded white cards with subtle drop shadows on light gray. We're the inverse.
- **Emoji as decoration** (🔥, 💯, 👑 etc.): cheapens the joke. The joke is the fact text itself.
- **Sans-serif everywhere**: collapsing Bebas/DM Sans/JetBrains Mono into one face destroys the visual hierarchy that makes the UI feel composed.

## Reference files in this repo

Before designing a new component, study the existing ones:
- `tailwind.config.js` (or `.ts`) — authoritative source for tokens
- Existing fact card component — pattern to extend, not reinvent
- Existing meme grid — for image-first layout reference

**If a token, font, or pattern in this doc conflicts with the Tailwind config or an existing shipped component, the shipped code wins — update this doc rather than the code.**
