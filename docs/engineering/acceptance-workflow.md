# The acceptance workflow and the live check — a contract for any product

**What this is.** The shape of an on-demand acceptance run and of a live
check, written so a second product in this fleet can adopt it unchanged and
supply only its own journeys, doubles and harness. Overhype.me is the first
consumer (Launch Phase 2, increment 6, #631; plan
`docs/plans/PLAN_PHASE2_INC6_ACCEPTANCE.md`); it appears below only as the
worked example. Moving this file into the handbook is the next step after the
increment merges (David, 2026-10-14). Where this repository's implementation
lives: [`docs/tests/TESTING.md`](../tests/TESTING.md), *The acceptance run*.

## 1. What an acceptance run is

A named baseline of user journeys, each with an observable outcome, run on
demand against deterministic stand-ins for every external vendor, **never** a
required check on a pull request. It is green only when every journey ran and
passed. A journey that was not reached is reported `not-run`, never omitted,
so an aborted chain stays visibly incomplete; a deferred clause is reported as
deferred, never as a pass. A recorded call to a double is never a journey's
outcome: the outcome is what a user would observe (a page, a stored object
read back by its owner, a refusal with the product's own message).

**Every artefact a journey reads back is checked for what it claims to be.**
For an image that means a full decode, not a header read: a header survives
truncation. A product whose journeys produce audio or video owns the
equivalent probe.

## 2. The launcher pattern: a constructed environment, refused on any other key

Every process a journey launches boots from an environment the launcher
**constructs from a named allowlist**, and the launched process refuses —
before it imports the application — when any variable outside that list is
present, naming it. An allowlist excludes a new vendor's credential without
anyone listing it; a blanklist ("unset the keys we know about") does not, and
has been the shape that failed. A launch that holds no credential has a list
that names none. Each launch has its own list: the acceptance server, the
recorder, the live check, a production-mode harness.

The pattern applies to a **set of processes**, not one: a product with a web
process and a worker gives each a constructed environment from its own list.

*Example:* `src/testing/launchEnvironment.ts` holds four lists; the
production-mode launcher for the sign-up journey refuses anything outside its
own, beside its older Resend-specific refusal.

## 3. The outbound-request detector

**Requirement.** Any unexpected outbound request fails the run, even when the
application catches the error and falls back — detected outside the
application, never by the doubles' own records and never by a hook inside the
process.

**Boundary.** The whole run — every process the product starts, its
background workers, the journey driver, anything they spawn — executes
inside a private network namespace whose only interface is loopback, with the
default routes pointed at it. That is **containment**: no packet can leave.
It is not the evidence. DNS configuration is made private to a mount
namespace as well, so no lookup takes a host-side path (a resolver daemon's
unix socket) out of the boundary.

**Two observers, because one is not enough.**

1. A **sink**, inside the namespace, to which NAT sends every DNS query
   (whatever its destination) and every TCP connection and UDP datagram not
   addressed to loopback, for both address families. It records the name each
   carried: the DNS question, the TLS server name, the HTTP Host. It answers
   an address query with a non-routable address, so a caller proceeds to the
   connect and fails fast rather than waiting out a timeout.
2. A **syscall record** (`strace -f --seccomp-bpf` on the socket calls),
   which records every attempt to reach a non-local address **whether or not a
   packet followed** — a connect the kernel refused, a datagram with no route.

Permitted: loopback traffic other than DNS, and unix and netlink sockets. There
is no allowlist of remote hosts; an acceptance run has no legitimate one. The
database is reached through a unix-socket relay started outside the
namespace, because a socket path crosses the boundary and a TCP address does
not.

**Self-test, every run.** Before anything else runs, a helper makes one
deliberate attempt of each shape the observers claim to see — a hostname, an
IPv4 literal, an IPv6 literal, a non-DNS datagram — and both observers must
record each, matched by its destination. A kernel without IPv6 reports that
attempt as not observable there, never as covered. Anything either observer
records after the self-test ends is a violation, with no grace period at that
boundary. Observers stay attached until the last process exits, so a request
made at shutdown counts.

**Privilege.** Create the namespace unprivileged where the kernel allows it;
where unprivileged user namespaces are restricted, create it with `sudo` and
drop back to the invoking user for the payload. Never edit the host's firewall.
A host that can do neither is an **environment failure**, a distinct exit,
never a run with less coverage.

## 4. Negative controls

A run that cannot go red proves nothing. For each reason the run can be red,
a control makes it red for exactly that reason, and the control's own result
is whether it failed in exactly the expected way:

- a caught vendor request after the self-test (both observers name it);
- a recorded vendor error carried through the real job to its failed state;
- a stored source replaced by bytes of the wrong kind (the journey that reads
  the derived artefact fails);
- a vendor call the application swallows (the journey completes on its
  fallback; the evidence evaluator below marks the operation missing).

## 5. Evidence per operation, not the absence of errors

An application that falls back on a vendor failure lets a journey complete
without the vendor ever answering usefully. So the run reads one record per
vendor call — the recorder's ledger, or the double's call log in the same
shape — finds the response each call produced, applies the **product's own
reader** to it, and reports every expected operation as satisfied or missing.
Which operations are expected is declared per mode and per database variant,
never derived from the calls that happened.

## 6. The evidence report

Each run writes a report that outlives it, red or green, including a run
whose setup failed before any journey: the commit; the identity of the
recordings the run was judged against (for a live check, the answers it
captured itself) and of any fixture loaded; each journey's outcome and
evidence; each expected operation's evidence; the detector's self-test, its
windows, and every line either observer recorded (for the syscall trace,
every line that addressed a non-local destination, with a count of the
permitted local ones); any configuration the run pinned; the deferrals; and,
when red, the tail of the server's log. Nothing else the run
captured — scratch storage, captured mail, logs from a green run — leaves the
runner.

## 7. The live check

The same driver, the same journeys, against the **real** vendors with test
credentials, so its requests are the acceptance run's requests. It is the only
evidence that the vendors still accept the recorded shapes.

- On the product's own host, on demand, **never in CI**: before each launch
  stage, and whenever a vendor client library is upgraded.
- Credentials are passed to the server explicitly, each on the live launch's
  allowlist.
- **A per-run spending cap, enforced before each vendor call**, reserving each
  call's worst case; a call that does not fit is refused, and a refused call
  is a red run, not a larger bill. Raising the cap is the owner's decision,
  recorded on the run.
- No recorded response stands in for a current one: reuse of earlier answers,
  committed or from the same run, is off.
- Green only when every expected operation shows a usable current answer.

## 8. What a product supplies

The journeys and their driver; one double per vendor at the seam the code
already crosses, selected by an explicit value and refused in production;
recordings taken from the real vendor; the per-operation expectations and
readers; its launch lists; and, where its architecture needs them, its own
harness pieces.

*Overhype.me:* one web process; doubles for storage, AI and Stripe; journeys
2–7 over a fresh database and over a scrubbed legacy fixture.

*A two-process product (DojoOS, read 2026-10-14 against its `architecture.md`):*
§2 and §3 serve it unchanged — a namespace wraps a supervisor's whole process
tree, and a constructed environment is per process. Left to its own harness
increment: the two-process async harness itself, media probes and generated
fixtures for §1's artefact check, and voice and transcription doubles.
