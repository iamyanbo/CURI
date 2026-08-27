# CURI — Cumulative Research & Inquiry — long-form YouTube script

Target: **18–22 minutes**. Structure is seven chapters; each opens with what is on screen, then the
spoken line. Talking points are written as prose you can read aloud or paraphrase — they are meant
to sound like someone explaining their own work, not a narrated feature list.

If you record only part of it, chapters 3, 5 and 6 are the ones that carry the video.

This is a production script: every chapter should have a visible action or artefact on screen. Do
not leave the viewer looking at a static dashboard while a paragraph of architecture is narrated.

**Required disclosure** — say it in the first 30 seconds and put it in the description:

> I made this video for the purposes of entering the Google Cloud hackathon.

**Suggested title:** *I built an autonomous research agent that's allowed to fail*
**Chapters for the description:**
`0:00 The problem · 2:30 What it does differently · 5:00 Architecture · 9:00 A real finding ·
12:30 What broke · 17:00 Publishing traces safely · 20:00 What it can't do yet`

---

## Chapter 1 — The problem (0:00 – 2:30)

*On screen: the README's Research vs Benchmark Chasing table.*

Open cold, no intro music:

> I made this video for the purposes of entering the Google Cloud hackathon. I wanted to build an
> autonomous research process whose output was not just a better number.

> Almost every autonomous research harness I've seen is a score maximizer. It proposes a change,
> runs the evaluator, keeps the change if the number improved, and repeats. And I want to be fair
> to that design: when the benchmark *is* the specification — you're shipping a model and MMLU is
> the contract — that loop is exactly right.
>
> As a model of research, it's poor. It invites Goodhart's law: the moment a measure becomes a
> target it stops being a good measure. In practice these pipelines drift into hyperparameter
> search. And we have well-established algorithms for hyperparameter search that don't need a
> language model at all. Using an LLM for it is, I think, an irresponsible use of the capability.

Then the structural point, which is the real argument:

> Here's the part that convinced me it isn't a prompting problem. If the unit of progress is "the
> number went up", a result where the number goes *down* has nowhere to live in the system. It gets
> discarded as a failed run. But a method that doesn't work, with a clear account of why, is
> routinely the most valuable thing an experiment produces. A system that can't record a negative
> result can't do research — no matter how you word the prompt.

---

## Chapter 2 — What it does differently (2:30 – 5:00)

*On screen: the Understanding view — components, syntheses, relations graph.*

> So the unit of progress here is an investigation, not a score. It starts from a question and
> competing explanations, picks a method that can actually answer that question, and records what
> the evidence supports or rules out — bounded by the conditions actually tested.

Three mechanisms, one at a time. Show the code or the artefact for each:

> **First, a delegation gate.** Before a brief reaches the executor, the runtime checks two things
> mechanically. Does it cite any existing evidence — a component, an outcome, a source — once the
> direction holds any? And is it a near-duplicate of something already run, without citing that
> earlier task and saying which explanation the difference discriminates? Fail either and it's
> refused, and the refusal goes into the orchestrator's next context. "Let me try a slightly
> different configuration" cannot get through this.
>
> **Second, syntheses that accumulate.** Experiments aren't the product. Findings are scoped
> outcomes; the understanding lives in syntheses that cite the exact outcomes and sources they rest
> on. When new evidence contradicts one, the agent writes a corrected synthesis saying what changed
> — and the old one stays. Superseding your own account is ordinary research.
>
> **Third — and this is the one I'd defend hardest — it's allowed to stop.** The orchestrator can
> pause a direction when it judges a milestone reached. A score-maximizing loop structurally cannot
> do that, because there is always another configuration to try.

---

## Chapter 3 — Architecture (5:00 – 9:00)

*On screen: the README architecture diagram, then real code.*

Walk the roles:

> There's an orchestrator that decides what's worth investigating and interprets every result
> before anything else is delegated. An executor that receives an already-decided experiment —
> model, scale, regime, evaluator all fixed by the orchestrator — and implements, runs and reports
> it. A watcher that pulls from arXiv, GitHub and Hacker News and judges each source for relevance
> before admission. And a supervisor that keeps the whole thing running.
>
> A deliberate constraint: the executor has no literature role at all. It never chooses among
> candidate experiments and never fills in a missing design decision. If prior work is needed, the
> orchestrator requests a watch and ends its turn — then synthesises the returned sources and picks
> the experiment itself on a later turn. Every decision that changes what a result *means* stays
> with the orchestrator.

The environment sheet is worth 30 seconds because it is unusual:

> Before any of this, a preflight measures the actual machine — real interpreters, real devices,
> real installed packages, by running them, not by asking the model what it thinks is installed.
> The orchestrator fixes experiment scale against that measured sheet. It's the difference between
> an agent that writes code for an imaginary A100 and one that writes code for the card you have.

Then the stack, briefly:

> Gemini 3.7 Flash through Genkit for the agents, with a model middleware for usage metering.
> SQLite locally, because the research loop needs a persistent filesystem and git worktrees.
> Firestore for the published record and Cloud Run for the public mirror. Each experiment runs in
> its own git worktree, so an attempt can be resumed rather than restarted.

> The run I am showing has four research threads and seventeen recorded outcomes, and there is a
> second direction on other hardware with five more threads. The headline findings are a compact
> summary of those outcomes, not twenty-one claims of new scientific discovery.

---

## Chapter 4 — A real finding (9:00 – 12:30)

*On screen: the outcome in the dashboard, then the agent trace that produced it.*

Set the question before the answer:

> The question was whether heuristic KV-cache eviction keeps the tokens a later question is going to
> need. H2O-style policies retain tokens by cumulative attention mass — keep what's been attended
> to, drop the rest.
>
> The result: **zero percent on non-local needle retrieval at fifty percent cache budget.**
> Statistically indistinguishable from evicting at random.
>
> And later in the run it recorded something a score-maximizing loop structurally cannot: a
> refutation. Randomized-Hadamard rotation does not prevent key quantization damage. Twelve
> supported, three bounded, one refuted, one inconclusive — four categories, not one.

Then the mechanism, then — importantly — the caveats:

> The mechanism is clean once you see it. During prefill, filler tokens don't attend to an isolated
> fact. So attention mass never marks that fact as worth keeping. The policy is causally blind to
> questions that haven't been asked yet.
>
> Two things matter more than the number. It refuted the study's *own* leading hypothesis — the
> agent expected graceful degradation. And it's only a meaningful claim because the design included
> a random-eviction control; without that, zero percent tells you about the task, not the policy.
> It was recorded as `bounded`, not `supported`, because n=3 on a 0.5B model observes something —
> it doesn't establish it.

Be first to say it isn't new:

> Now — if you know this literature, you recognise this. It's the failure mode StreamingLLM and
> later needle-retrieval work describe. Same for the other findings: the speculative decoding result
> is the standard acceptance-rate/latency crossover, and the K/V quantization asymmetry is what KIVI
> reports. Three of four reproduce published work.
>
> I'd rather say that myself than have you notice it. The claim I'm making isn't novelty. It's that
> these were independently re-derived, with controls, on hardware I control, and that the failures
> stayed in the record.

---

## Chapter 5 — What broke (12:30 – 17:00)

The most valuable chapter for a technical audience. Four stories, ~60 seconds each.

*On screen: show the failure or misleading output first, then the code or trace that explains it,
and finally the fix.*

**Cost accounting was off by 20×.**
> My first accounting recorded the final model call of each turn. The console said 2M input tokens;
> I said 100k. Twenty times off on input, ninety times on output. Two compounding reasons: a tool
> loop re-sends the whole conversation every turn, and reasoning tokens come back in a separate
> field. The fix was a Genkit middleware that meters every model call and counts thoughts as output.
> If you're enforcing a spend ceiling, measure at the middleware — otherwise your ceiling is
> fiction.

**An error that said nothing.**
> Every provider failure logged as "Provider returned error". One line caused it:
> `JSON.stringify(error.cause)` returns `{}`, because an Error's properties aren't enumerable. Every
> upstream reason — moderation, 5xx, context overflow — was thrown away at the exact moment it
> mattered.

**Silent truncation looks identical to a hang.**
> A 400-step trace limit was hit by one long attempt, and the trace just stopped. The run looked
> idle for an hour while it was working. I misdiagnosed it at first. Any limit that discards data
> has to be loud — it's now 20,000 steps and truncation is written into the trace as a marker.

**An agent given a turn will use it.**
> This is the one I'd most want another builder to hear. The orchestrator can pause when there's
> nothing worth doing — and continuous mode resumed it on a timer, which hands it the same context
> and asks the same question. Given a turn, it records *something* rather than nothing: a restated
> synthesis, a re-described map of its own threads. I fixed the restated syntheses; it moved to
> relationships. I fixed those; it reworded them to slip past the check. Three loops, one cause.
>
> Roughly half of one direction's budget went to pausing and resuming. The fix wasn't a better
> duplicate check, it was to stop resuming on a clock — a pause now stands until evidence arrives.
> An hour of quiet went from about two dollars to seventeen cents, and recorded findings went up.

**A scheduler must not mistake its own bookkeeping for progress.**
> The backoff reset on any new event — including the pause the orchestrator writes and the resume
> the supervisor writes a moment later. The loop was persuading itself that research had happened
> by writing about its own scheduling.

**"Run forever" is a scheduling problem.**
> Giving the agent permission to stop created a new bug: continuous mode woke the paused direction
> every 15 seconds, at about 15 cents a turn, to re-ask a question whose context hadn't changed. The
> fix was to treat a pause and an idle turn as the same signal, and back both off on one curve from
> one minute to thirty — resetting the moment anything actually happens. In practice the literature
> watcher becomes the metronome: research resumes because evidence arrived, not because a timer
> fired.

---

## Chapter 6 — Publishing traces without publishing your machine (17:00 – 20:00)

*On screen: the mirror's agent trace, then `trace-publish.ts`, then a withheld step.*

> Originally the mirror showed timing but not transcripts, because traces contain prompts, paths and
> command output. That withholds the most interesting part of the record to protect against a risk
> concentrated in one part of it.
>
> The obvious fix is to redact harder. I think that's the wrong shape. A redactor is a guess about
> what a leak looks like, and when the guess is wrong it fails *silently* — which is the worst
> property a privacy mechanism can have.

The design, which is the transferable idea:

> So publishing runs in two stages. Redact — then verify. The assembled record gets walked field by
> field and checked against identifiers read from the running environment: the real username,
> hostname, home directory, and the value of every credential-shaped variable. If a field still
> matches, the publish stops. Nothing gets written.
>
> The key property: because the check runs on the *assembled* record, no part of the system has to
> be trusted to have remembered to redact. A pattern I failed to anticipate costs a refused publish
> instead of a leak.

Close with the bug it caught — this lands well:

> And it immediately caught a bug of exactly the kind it exists for. My drive-letter pattern had no
> lookbehind, so the `s:` in `https:` parsed as a drive letter. Every cited source URL in the
> published record would have been replaced with a path marker. There's now a test asserting arXiv
> links survive redaction.

---

## Chapter 7 — What it can't do yet (20:00 – 22:00)

*On screen: the README's "Limits of the current evidence".*

End on the limitations, not a call to action:

> Everything here is bounded to 0.5B–1.5B models at 4K context on one consumer GPU. That's
> *simulated* memory pressure, not the long-context regime this direction ultimately targets.
> Sample sizes are small. The eviction study measures the symptom, not the mechanism — it doesn't
> record whether the needle token survived eviction, so "evicted it" and "kept it but couldn't use
> it" are still undistinguished.
>
> And the honest summary is the one I started with: it re-derived published results. It hasn't found
> anything new. Whether this process *can* is an open question about scale, and I'd rather leave it
> as a question than dress it up.
>
> It's MIT licensed, it runs locally on your own API key, and the cloud parts are optional. Link's
> in the description.

---

## Production notes

- **Screen recording over slides.** The dashboard, the trace, the Cloud Run console and the
  Firestore browser carry this. Slides make it look like a pitch.
- **Show one failure live.** A refused delegation or a real provider error does more for
  credibility than any amount of narration about robustness.
- **Don't stage a fast loop.** One executor attempt took 96 minutes. Say that. A demo that implies
  experiments finish in seconds invites the obvious question about how real they are.
- **Numbers you can defend:** across two directions, 214 runs, $60.13, 71.3M input tokens, 21
  recorded outcomes. Attention: 125 runs, $39.60, 17 outcomes (12 supported, 3 bounded, 1 refuted,
  1 inconclusive), 28 syntheses, 41 sources, 4 threads. Finance: 89 runs, $20.53, 4 outcomes,
  21 syntheses, 5 threads.
- **Do not quote the finance CPCV or PBO figures.** That table disagrees with the search-intensity
  table on out-of-sample Sharpe and the contradiction is unresolved.
- **Do not claim novelty anywhere**, including the title and thumbnail. The video's credibility is
  the whole asset.
