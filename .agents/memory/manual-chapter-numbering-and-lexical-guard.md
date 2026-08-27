---
name: Manual chapter numbering and lexical guard
description: Numbered chapter filenames can resemble configuration values after Markdown link markup is stripped.
---

When renaming manual chapters to include their chapter number, update the manual tuning-language guard to normalize numbered chapter-link labels before applying config-value rules.

**Why:** A link label such as `Related: 2-content-lifecycle.md` becomes `Related: 2` during lexical scanning and can be falsely reported as a configuration key/value pair.

**How to apply:** Keep chapter numbering in the filenames and navigation, but make the checker recognize both backtick-wrapped and plain local numbered chapter links; add a regression test using the real Markdown syntax.