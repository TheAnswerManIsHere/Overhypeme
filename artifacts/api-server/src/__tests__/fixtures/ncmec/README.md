# NCMEC ISPWS test fixtures

Pinned artifacts. Every test that touches the CyberTipline client runs against these files
with `fetchImpl` stubbed and **no network access at all** — that is what makes phase 2 of
the NCMEC plan independently verifiable, and it is why CI never reaches NCMEC.

A change to any file here is a deliberate re-fetch and a visible diff, never a silent
change in test behaviour.

## Provenance

| | |
|---|---|
| Source | <https://report.cybertip.org/ispws/documentation/> |
| Fetched | 2026-07-30 |
| Auth required to read that page | No — the documentation is public |
| Documented API version | CyberTipline Reporting API (ISPWS) |

The response documents below are transcribed from the worked example in §6 of that
documentation ("Example (using curl)") and from Appendix D.1 ("Report Response"). The
report id `4564654`, file id `b0754af766b426f2928a02c651ed4b99` and hash
`fafa5efeaf3cbe3b23b2748d13e629a1` are NCMEC's own example values, not ours.

No NCMEC credentials were used to produce anything in this directory, and none appear in
it.

## Success responses

| File | Endpoint | Notes |
|---|---|---|
| `status-ok.xml` | `GET /status` | Carries only a code and a description — no `reportId`. |
| `submit-ok.xml` | `POST /submit` | The `reportId` every later call is keyed on. |
| `upload-ok.xml` | `POST /upload` | Adds `fileId` and `hash` (MD5 of the uploaded bytes). |
| `fileinfo-ok.xml` | `POST /fileinfo` | Same shape as submit. |
| `retract-ok.xml` | `POST /retract` | Same shape as submit. |
| `finish-ok.xml` | `POST /finish` | **Different root** — `<reportDoneResponse>`, with a `<files>` list. |
| `finish-ok-multifile.xml` | `POST /finish` | Two `<fileId>` children, so the parser is exercised on the array case a single-element list hides. |

## Error responses

One per code in the plan's classification table: `err-1000`, `err-2000`, `err-3000`,
`err-4100`, `err-5001`, `err-5102`. Each is a real `<reportResponse>` document rather than
a hand-typed string, so the classification table is asserted against the shape ISPWS
actually returns.

**NCMEC's published list is explicitly non-exhaustive**, and it contains codes the plan's
table does not name: `1100`, `1110`, `1111`, `1210`, `1300`, `3100`, `3300`, `4000`,
`4110`, `4200`, `5002`, `5101`. The client therefore classifies by code *family* with the
named codes taking precedence — see `ncmecClient.ts`. No fixture is committed for the
unnamed codes because the classification is derived, not enumerated; the tests construct
them inline.

## Hostile responses

We parse documents from a remote host, so a malformed or hostile one must not become an
availability or memory problem.

| File | What it proves |
|---|---|
| `hostile-doctype-entity.xml` | A DOCTYPE carrying an entity declaration is rejected **before** the parser sees it. |
| `hostile-doctype-harmless.xml` | A DOCTYPE with *no* entity declaration is rejected too. This is the important one: without it, the entity test could pass merely because expansion happened to be disabled, while the gate it is supposed to prove does not exist. |
| `hostile-deep-nesting.xml` | 120 levels of nesting, past the parser's `maxNestedTags` cap of 50. |

The **oversized-body** case is generated in the test rather than committed: it needs to
exceed 1 MiB, and a 1 MiB file of filler in version control costs more than the line of
test code that produces it. The test builds it as a stream so the cap is exercised during
the read, which is the only place it can work — `response.text()` and `arrayBuffer()`
buffer the whole remote body before any size check could run.

## The XSD is not here, and that is a known gap

The plan calls for `GET /xsd` to be fetched by hand and committed as `ispws.xsd`, so
generated documents can be validated against NCMEC's schema offline.

**That endpoint requires credentials.** Verified 2026-07-30: `GET
https://report.cybertip.org/ispws/xsd` and the `exttest` equivalent both return `401`
without authentication, while the documentation page they are linked from is public. So
the schema could not be retrieved here, and two questions have to be answered before it
can land:

1. Someone with ESP credentials has to fetch it.
2. Whether a credential-gated NCMEC artifact may be committed to a **public** repository
   is a judgement call for David, not one to make by default.

Until then, the builders are asserted against exact expected documents and against the
structural rules stated in the public documentation (element order, the `0|1` form of
`<fileAnnotations>` children, the batched-mode exclusions), which is weaker than schema
validation but is not nothing. The gap is tracked as **G12** on the implementation PR.
