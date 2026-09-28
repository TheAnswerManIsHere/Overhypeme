<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->
# The Worth rule: is this intervention worthwhile?

**This file is the only statement of the rule.** Astra's brief and the Fable
assessor's brief quote it verbatim into every dispatch; `claude-core.md` and
`pr-watch` point at it rather than restating it. A second copy is a second
thing to drift.

**Who applies it and who decides are not here.** That is the workflow: the
review-proxy section of `claude-core.md` for the authority split, the focused
follow-up, and David's reserved decisions. This file answers one question, the
same way for whoever is asking it.

---

The question for every reviewer finding is not whether it is correct but
whether acting on it serves the agreed outcome at a cost proportionate to what
it prevents. A technically valid observation does not by itself justify a
change. A worthwhile correction may require substantial work. There is no
target rate of accepting or declining.

**1. Identify the bounded failure class.** Before recommending a correction or
accepting a real imperfection, identify the bounded failure class. Scale
investigation to the uncertainty and consequences; an established duplicate or
clearly disproven finding does not require a new class-wide audit. Where
investigation is warranted: name the rule being violated, the conditions that
produce it, and the paths, consumers or documents where the same rule must
hold. Define the class by mechanism or meaning, never by wording, file or line,
and bound it to reachable uses. Search with the instance's terms and with the
concept's. When a search is intended to find the known example, confirm that it
does before drawing conclusions from its results. Assess completeness against
the relevant paths, consumers and documents, rather than the absence of further
text matches. This discipline binds fixes and declines alike.

**2. Establish what is actually wrong.** A reachable failure, an incorrect
assumption, a duplicate, or behaviour already handled. A defect is distinct
from an optional improvement. An existing check matters only to the extent that
it demonstrates the required behaviour in the implementation being assessed.
Detecting a defect does not resolve it; a failing required check remains
unresolved. Distinguish completed corrections from planned work.

**3. Understand the source.** Who produces the value, who consumes it, what can
vary. For a value fixed by the operating model, consider expressing the
constant directly. A value derivable from an existing source of truth may lose
its redundant copy. A genuine choice stays an input, validated in proportion to
credible mistakes. Where we control the producer, first consider whether
correcting its output or simplifying the interface eliminates the need for
consumer-side protection. Each proposed change still needs to pass the Worth
assessment: internal ownership does not guarantee correct output, and
deterministic construction differs from model-generated content, manual choices
and coordination between agents. Where a model's output feeds a script, the
script extends no latitude, and exactness at that boundary is the standard.
Protection needs a credible remaining failure and a consequence that justifies
its cost.

**4. Identify a credible failure path and its consequence.** What could happen,
under what conditions, affecting whom. Weigh frequency, reach, detectability,
recoverability and cumulative disruption. Where the consumer is a model reading
prose, recoverability is decided by whether the error survives the model that
actually consumes it — never assumed from the assessor's own reading: a
contradiction, a mislabel or an instruction the rest of the package makes
impossible is one that reader reconciles from what it has, and is not a
credible failure path however real the imperfection. What does not survive is
information the reader cannot recover — absent from the package, wrong in a way
it cannot check, or destroyed on disk. That is the real failure class, and
neither half of this sets a rate. For an adversarial scenario, name an
actual actor with the necessary access; a channel that could theoretically
carry hostile content is not an actor. Do not invent probabilities. Missing
evidence that could change the answer calls for a targeted investigation, not
an assumption either way.

**5. Compare responses.** Leave it, correct the producer, remove a mechanism,
make a bounded repair, or replace the approach. Weigh credible consequences
against the full cost: implementation, verification, further review,
maintenance, complexity, new failure risk. Easy recovery and limited impact
reduce the value of prevention; frequent interruption can justify correction
even when each incident is reversible; severe or irreversible consequences can
justify protection against rarer failures, provided the protection addresses a
credible failure effectively and proportionately. Internal tooling is judged by
its effect on David's ability to build software; application changes by their
effect on users. Neither category predetermines the answer.

**6. Assess the round as a whole.** Group findings sharing a cause. Distinguish
an original defect, an incomplete correction, and a problem an earlier fix
introduced. When repeated fixes suggest a poorly chosen mechanism, compare
continuing to patch with simplifying or removing it. Several fixes made
together do not require separate review rounds; assess the batch's actual
review burden and the complexity it adds.

**7. Explain accepted consequences.** A decline states what remains possible
and why intervention is unwarranted. If it would knowingly accept a
user-facing shortfall from agreed behaviour, including David's own use of the
software factory, the decision is his. A previously declined class that returns
is re-examined on its new evidence and scope; repetition alone does not decide.
