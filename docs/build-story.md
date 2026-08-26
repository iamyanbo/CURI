# Building an autonomous research system that is allowed to fail

*I created this piece of content for the purposes of entering the Google Cloud hackathon.*

---

I spent a few days building an autonomous research system called CURI — Cumulative Research &
Inquiry. It runs Gemini 3.7 Flash agents through Genkit, keeps its record in Firestore, and serves
a public read-only mirror from Cloud Run. It ran for about twenty hours on one consumer GPU, spent
$13.44, and produced six recorded findings.

Three of those findings reproduce results that are already in the literature. I want to lead with
that, because the interesting part of this project is not what it found. It is what it was built
*not* to do.

## The thing I was trying to avoid

Most autonomous research harnesses are score maximizers. Propose a change, run the evaluator, keep
the change if the number improves, repeat. That is a perfectly good engineering loop when the
benchmark *is* the specification. As a model of research it is poor, and it invites Goodhart's law:
once a measure becomes a target, it stops being a good measure. In practice these pipelines drift
into hyperparameter search — and we have well-established algorithms for hyperparameter search that
do not require a language model.

The deeper problem is structural. If the system's unit of progress is "the number went up", then a
result where the number goes *down* has nowhere to live. But a method that fails to work, with a
clear account of why, is frequently the most valuable output an experiment has. A system that
cannot record a negative result cannot do research.

So CURI's unit of progress is an investigation. It begins from a question and competing
explanations, picks a method that can answer it — reproduction, a controlled comparison, an
activation trace, a boundary test, a correctness suite, sometimes a benchmark — and records what
the evidence supports or rules out, bounded by the conditions actually tested. There is no global
score. There is no incumbent implementation to beat.

## Three mechanisms, because a prompt is not a guarantee

You cannot get this behaviour by telling a model to "do real research". The instruction survives
until the first turn where hill climbing is the locally obvious move. Three mechanisms do the work
instead.

**A delegation gate.** Before an experiment brief reaches the executor, the runtime checks two
things mechanically. Does the brief cite any existing identifier — a component, an outcome, a
source, a synthesis — once the direction holds any evidence at all? And is it a near-duplicate of
an experiment already run, by content-word similarity, without citing that earlier task and saying
which explanation the difference discriminates? A brief that fails either check is refused, and the
refusal is surfaced in the orchestrator's next context rather than written somewhere nobody reads.
An untethered "let me try a slightly different configuration" cannot get through.

**Syntheses that accumulate and are superseded.** Experiments are not the research product.
Findings are scoped outcomes; the evolving understanding lives in syntheses attached to research
threads, each citing the exact outcomes and sources it rests on. When new evidence contradicts an
earlier synthesis, the agent records a corrected one that says what changed and why. The old one
stays. Superseding your own account is ordinary research, not an admission of failure.

**Permission to stop.** The orchestrator can pause a direction when it judges a milestone reached.
This turned out to be the mechanism with the most annoying second-order consequences, which I will
come back to.

## What it actually found

The headline result: heuristic KV-cache eviction is causally blind to questions that have not been
asked yet. The agent tested H2O-style cumulative-attention retention on non-local needle retrieval
and got **0% at 50% cache budget — statistically indistinguishable from evicting at random**. The
mechanism is straightforward once stated: during prefill, filler tokens do not attend to an
isolated fact, so attention mass never marks it as worth keeping.

Two things about that result matter more than the number. First, it refuted the study's *own*
leading hypothesis — the agent had expected the policy to degrade gracefully. Second, it is only a
meaningful claim because the experimental design included a random-eviction control, without which
"0%" would say more about the task than about the policy. And it was recorded as `bounded` rather
than `supported`, because n=3 on a 0.5B model observes something; it does not establish it.

The other findings: speculative decoding lost wall-clock time at a healthy 38–54% acceptance rate,
because per-token latency tracks transformer *layer depth* rather than parameter count (0.5B/24
layers at 39.4 ms/tok versus 1.5B/28 layers at 43.9). And K and V quantization errors differ in
kind rather than degree — value error is additive through a row-stochastic attention matrix while
key error passes through a softmax and disperses attention, so asymmetric K-INT8/V-INT4 holds
retrieval at 4-bit value precision.

If you know this literature, you recognise all three. The eviction failure is what StreamingLLM and
later needle-retrieval work describe. The decoding result is the standard acceptance-rate/latency
crossover inequality, reached by measurement instead of algebra. The K/V asymmetry is what KIVI
reports and builds per-channel key quantization on.

That is the honest result of a system with a consumer GPU and a few days. What is not replication
is *how* they were reached: independently re-derived on hardware I control, with controls, and with
the failures kept in the record instead of discarded.

## Four things that broke, and what they taught me

**Measuring cost is not the same as billing it.** My first accounting recorded the final model call
of each agent turn. Google's console showed roughly 2M input tokens against my 100k. The
undercount was **20× on input and 90× on output**, for two compounding reasons: a tool loop re-sends
the entire conversation on every turn, and reasoning tokens arrive in a separate field that a naive
sum ignores. The fix was a Genkit model middleware that meters *every* model call and counts
thought tokens as output. If you are building agents with a spend ceiling, measure at the
middleware, not at the call site — otherwise your ceiling is fiction. Current true totals: 15.9M
input, 424k output, $13.44.

**An error that says nothing is worse than a crash.** For a while every provider failure was
recorded as "Provider returned error". The cause was one line: `JSON.stringify(error.cause)` returns
`{}`, because an `Error`'s properties are not enumerable. Every upstream reason — moderation, 5xx,
context overflow, pool exhaustion — was being discarded at the moment it mattered. Walking the cause
chain explicitly turned a week of opaque failures into a classified list I could act on.

**Silent truncation looks exactly like a hang.** A trace step limit of 400 was reached by a single
long executor attempt, after which the trace simply stopped. The run appeared idle for an hour while
it was working. I initially misdiagnosed this as a recording-time bug. Any limit that discards data
should be loud: the ceiling is now 20,000 and truncation is written into the trace as a visible
marker.

**"Run continuously" is a scheduling problem, not a prompting one.** Giving the agent permission to
stop created a new failure: continuous mode resumed a paused direction every 15 seconds, at roughly
$0.15 per turn, to ask a question whose context had not changed. The fix was to treat a pause and an
idle turn as the same signal — nothing is worth doing right now — and back both off on one curve
from one minute to thirty, resetting the moment *anything* happens in the direction: a source
admitted, a task returned, a synthesis written. In practice the literature watcher becomes the
metronome. Research resumes because evidence arrived, not because a timer fired. Ten quiet hours
now cost about two dozen turns instead of a paid poll every few seconds.

## Publishing a trace without publishing your machine

The mirror originally showed each run's timing but not its transcript, on the grounds that traces
contain prompts, paths and command output. That withheld the most interesting part of the record to
protect against a risk concentrated in one part of it.

The obvious fix — redact harder — is the wrong shape. A redactor is a guess about what a leak looks
like, and it fails *silently* when the guess is wrong. So publishing now runs in two stages. Text is
redacted. Then the assembled record is walked field by field and checked against identifiers taken
from the running environment: the real username, hostname, home directory, and the value of every
credential-shaped variable. **A field that still matches stops the publish.** Nothing is written.

The difference matters. Because the check runs on the assembled record rather than trusting each
producer to have remembered, a pattern I failed to anticipate costs a refused publish rather than a
leak. Within a trace, a single failing step becomes a visible withheld marker instead of failing the
whole record, so the gap is legible. Tool output stays withheld by default — it is unbounded machine
output rather than research.

Writing that gate caught a bug of exactly the kind it exists for. My drive-letter pattern had no
lookbehind, so the `s:` in `https:` and the `e:` in `file:` parsed as drive letters. Every cited
source URL would have been replaced by a path marker. A test asserting that arXiv links survive
redaction now guards it.

## Why the experiments run locally

Everything except the published record runs on a local machine with one RTX 3060 Ti. That was a cost
decision, not a missing feature. The measured bottleneck is model latency, not device throughput —
3,442 seconds of tool time against 5,695 seconds waiting on the model, with the GPU at 33%
utilisation. Renting an accelerator would have spent a limited credit grant keeping a faster card
idle for two thirds of the run. The credits went to the model calls that were actually the
constraint.

Nothing in the design prevents it. The executor runs ordinary Python in a git worktree, the
environment preflight measures whatever devices it finds, and the orchestrator fixes experiment
scale against that measured sheet rather than against a guess. A larger card widens the model sizes
and context lengths a direction can reach — which is precisely the limitation the findings are
bounded by.

## What I would tell someone starting this

Build the honesty mechanisms before the capability ones. The delegation gate, the envelope
requirement on every finding, the cost middleware and the publish gate are what make the output
worth reading; without them you have an expensive way to generate plausible text about experiments.

And be careful what you count as done. The system re-derived published results. It has not found
anything new. Whether this process *can* produce a finding that is not already in the literature is
an open question about scale — and saying so plainly is more useful to the next person than a
claim that would not survive checking.

---

CURI is open source under the MIT license. It runs locally with your own API key in a `.env` —
Gemini API, Vertex AI or OpenRouter — and the Google Cloud pieces are optional.
