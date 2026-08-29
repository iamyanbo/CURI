# CURI — Cumulative Research & Inquiry — long-form YouTube script

Target: **22–25 minutes**. This is written as A-roll: read the spoken sections as a connected story,
but keep the wording natural when you record. The production cues tell you where to cut, what to
show as B-roll and where a punch-in or screen recording should carry the explanation.

If you record only part of it, chapters 5, 6 and 7 are the ones that carry the video: what the
runtime generalises to, what broke, and how a trace is published safely.

Every chapter should have a visible action or artefact on screen. Do not leave the viewer looking at
a static dashboard while a paragraph of architecture is narrated. If a screen takes time to load,
use a J-cut: start the next piece of narration over the previous shot and cut to the new screen when
it is ready.

**Required disclosure — say this in the first 30 seconds and put it in the description:**

> I made this video for the purposes of entering the Google Cloud hackathon.

**Suggested title:** *I built an autonomous research agent that's allowed to fail*
**Chapters for the description:**
`0:00 The problem · 2:30 What it does differently · 5:00 Architecture · 9:00 A real finding ·
12:30 Three instances, one runtime · 15:30 What broke · 20:00 Publishing traces safely ·
23:00 What it can't do yet`

---

## Chapter 1 — The problem (0:00–2:30)

**Show:** Open on the README's “Research vs Benchmark Chasing” table. Start with a clean screen
recording and bring in the camera only after the first line, if you are using one.

**Say:**

> I made this video for the purposes of entering the Google Cloud hackathon. I wanted to build an
> autonomous research process whose output was not just a better number. That seemed like a low bar,
> but apparently it is a surprisingly difficult one to clear.

> Almost every autonomous research harness I've seen is a score maximizer. It proposes a change,
> runs the evaluator, keeps the change if the number improved, and repeats. And I want to be fair
> to that design: when the benchmark *is* the specification — you're shipping a model and MMLU is
> the contract — that loop is exactly right.
>
> But as a model of research, it is poor. It invites Goodhart's law: the moment a measure becomes a
> target, it stops being a good measure. And in practice the pipeline starts looking like
> hyperparameter search with a very expensive intern doing the clicking. We already have good
> algorithms for hyperparameter search. Using an LLM for it is, I think, a pretty irresponsible use
> of the capability.

Keep the README on screen for the first paragraph, then cut to the dashboard for the structural
point:

**Say:**

> Here's the part that convinced me this isn't a prompting problem. If the unit of progress is "the
> number went up", then a result where the number goes *down* has nowhere to live. It gets thrown
> away as a failed run. But a method that does not work — with a clear account of why — is often the
> most useful thing an experiment produces. A system that cannot record a negative result cannot do
> research, no matter how carefully I word the prompt.

---

## Chapter 2 — What it does differently (2:30–5:00)

**Show:** Cut to the Understanding view. Punch in on a synthesis, then the relations graph.

> So I built CURI around a different unit of progress: an investigation, not a score. It starts with
> a question and competing explanations, picks a method that might actually answer the question, and
> records what the evidence supports or rules out. The result is always tied to the conditions that
> were actually tested. No magical leap from "this worked once" to "we solved the field".

Take these one at a time. Use a short code or dashboard cutaway for each, then return to the
Understanding view:

**Say:**

> **First, a delegation gate.** Before a brief reaches the executor, the runtime checks two things.
> Does it point to any existing evidence? And is it secretly the same experiment as something that
> already ran? If it fails either check, it gets refused, and the refusal is shown to the orchestrator
> on its next turn. So "let me try the same thing with one different number" is not a research plan.
>
> **Second, syntheses that accumulate.** The experiments are not the product. Findings are scoped
> outcomes, and the understanding lives in syntheses that cite the outcomes and sources behind them.
> When new evidence contradicts a synthesis, the agent writes a new version explaining what changed.
> The old version stays. History is useful, even when it makes you look wrong.
>
> **Third — and this is the one I would defend hardest — it is allowed to stop.** The orchestrator
> can pause a direction when it thinks the next experiment is not worth doing yet. A score-maximizing
> loop cannot really do that. There is always one more configuration to try, and apparently there is
> always one more configuration to try after that.

---

## Chapter 3 — Architecture (5:00–9:00)

**Show:** Start on the README architecture diagram, then cut to the corresponding code and the live
dashboard. Keep the diagram visible as an orientation map; do not try to explain every arrow.

**A-roll:** Walk through the roles while the architecture diagram stays visible:

> There are four jobs here. The orchestrator decides what is worth investigating and interprets every
> result before anything else is delegated. The executor gets an already-decided experiment — model,
> scale, regime and evaluator — and implements, runs and reports it. The watcher pulls from arXiv,
> GitHub and Hacker News and decides what is worth bringing in. And the supervisor keeps the whole
> thing moving when I am not sitting here clicking buttons.
>
> There is one deliberately annoying constraint: the executor has no literature role. It cannot
> choose between candidate experiments and it cannot quietly fill in a missing design decision. If
> prior work is needed, the orchestrator requests a watch and ends its turn. The sources come back,
> the orchestrator synthesises them, and only then does it choose the experiment. Decisions that
> change what a result *means* stay in one place.

**Transition:** Hold on the environment sheet for about 30 seconds. This is unusual enough to show:

> Before any of this, a preflight measures the actual machine. It checks real interpreters, real
> devices and real installed packages by running them, rather than asking the model what it thinks
> is installed. The orchestrator fixes the experiment scale against that sheet. So the agent writes
> code for the card I actually have, not the imaginary A100 it would like to have.

**Transition:** Cut from the environment sheet to a quick stack overview:

> The stack is fairly ordinary. Gemini 3.7 Flash through Genkit for the agents, with middleware to
> meter usage. SQLite locally, because the loop needs a persistent filesystem and git worktrees.
> Firestore holds the published record and Cloud Run serves the public mirror. Each experiment gets
> its own worktree, so an interrupted attempt can be resumed instead of started from scratch.

> The attention direction is the published example. The strategy-generalization run stays local on
> the DGX Spark; it is shown through a forwarded dashboard and is not part of the Firestore record.

> The run I am showing has four research threads and seventeen recorded outcomes. There is a second
> direction on other hardware with five more threads. Those numbers are a summary of the record,
> not twenty-one claims of new scientific discovery.

---

## Chapter 4 — A real finding (9:00–12:30)

**Show:** Open the outcome in the dashboard, then the agent trace that produced it. Let the viewer
see the question before you reveal the result.

**Say:**

> The question was simple to state: does heuristic KV-cache eviction keep the tokens that a later
> question is going to need? H2O-style policies keep tokens according to cumulative attention mass —
> keep what has been attended to, drop the rest. It sounds reasonable. It is also about to run into
> a problem.
>
> The result: **zero percent on non-local needle retrieval at fifty percent cache budget.**
> Statistically indistinguishable from evicting at random.
>
> Later in the run it recorded something a score-maximizing loop usually cannot: a refutation.
> Randomized-Hadamard rotation does not prevent key quantization damage. Twelve supported, three
> bounded, one refuted, one inconclusive. Four categories, not one leaderboard number.

Cut to the experiment or trace for the mechanism, then return to the outcome for the caveats:

**Say:**

> The mechanism is pretty clean once you see it. During prefill, the filler tokens do not attend to
> an isolated fact. So the attention mass never marks that fact as important enough to keep. The
> policy is causally blind to questions that have not been asked yet. It is trying to predict the
> future using only the past, which is generally a risky strategy.
>
> Two things matter more than the number. First, it refuted the study's own leading hypothesis — the
> agent expected graceful degradation. Second, the result is only meaningful because the design
> included a random-eviction control. Without that control, zero percent tells you the task is hard,
> not that the policy is the problem. It was recorded as `bounded`, not `supported`, because n=3 on
> a 0.5B model tells us something, but it does not establish a universal law of attention.

End this chapter by saying plainly what the result is not:

**Say:**

> Now, if you know this literature, you recognise the result. It is the failure mode described by
> StreamingLLM and later needle-retrieval work. The other findings are similar: the speculative
> decoding result is the standard acceptance-rate versus latency crossover, and the K/V quantization
> asymmetry is what KIVI reports. Three of the four headline attention results reproduce published
> work.
>
> I would rather say that myself than have you notice it in the comments. I am not claiming novelty.
> I am claiming that the results were independently re-derived, with controls, on hardware I
> control, and that the failures stayed in the record.

---

## Chapter 5 — Three instances, one runtime (12:30–15:30)

**Show:** Start with the Cloud Run mirror, cut to the forwarded Spark dashboard, then cut to the
private local instance. If the layout allows it, finish with all three views side by side.

**Direction:** This chapter tests whether the runtime generalises. The point will land faster if the
viewer can see the three instances rather than hearing a list of environments.

> Everything so far came from one direction on one machine. That proves very little. A system that
> works on the problem it was built for usually does. That is not exactly a hostile test.
>
> So here is the same runtime in three places: the published attention run, a different domain on a
> different machine, and one private instance I actually use.

**The published one — about 30 seconds**
> First, the published one. This is the attention and KV-cache direction, running on a consumer GPU
> with Gemini through Vertex, published to Firestore and served from Cloud Run. Forty-three hours,
> seventeen outcomes and about forty dollars. So, not free. But at least it produced a record.

**A different field, different hardware — about 45 seconds**
> Next, the different domain. This is a DGX Spark asking when a trading strategy found in historical
> data keeps its edge outside the window in which it was found. Different domain, different machine,
> same runtime — and a decade of later data deliberately kept off that box. I am not showing you a
> trading system that has already peeked at the answer.

**And one I actually use — about 60 seconds**
> And this third one is not in the public repository, because it is mine. It is a private finance
> pipeline I run on real market data. This is the one I would point at if you asked whether CURI is a
> demo or a tool. A demo runs once. A tool has to survive being used.
>
> And look at the spend: zero. Not “cheap” — zero. There is no hosted API bill because I am running
> DeepSeek on the Spark and talking to it through an OpenAI-compatible endpoint. From CURI's point
> of view, it does not care whether the model is in the cloud or sitting in the next room.

**Why that is more than a cost trick — about 45 seconds**
> When I added that, I found a slightly embarrassing bug. The cost estimator saw an unknown model,
> assumed it was a hosted one, and started charging list price for free local inference. The system
> was preparing to hit a spending limit against money nobody was paying. Self-hosted inference is
> recorded as zero now.
>
> The provider is one line of configuration: Gemini, Vertex, OpenRouter or any OpenAI-compatible
> server on your own network. The cloud parts are genuinely optional. The research loop, the gates,
> the record and the dashboard all work without a cloud account.

**Show:** Cut to the `.env` showing `AR_MODEL_PROVIDER=openai-compatible` and `AR_MAX_COST_USD=0`,
then cut back to the running dashboard with its spend at $0.00.

---

## Chapter 6 — What broke (15:30–20:00)

This is the most valuable chapter for a technical audience. Keep each story short and use the same
visual rhythm: show the failure or misleading output, cut to the code or trace that explains it,
then show the fix. The three scheduling stories are one thread, so let those cuts flow into each
other.

**Cost accounting was off by 20×.**
> My first accounting recorded the final model call of each turn. The console said 2M input tokens;
> I said 100k. Twenty times off on input, ninety times on output. Not ideal when the whole point is
> to enforce a budget.
>
> There were two reasons. A tool loop resends the whole conversation every turn, and reasoning
> tokens come back in a separate field. The fix was middleware that meters every model call and
> counts thoughts as output. If you enforce a spend ceiling, measure it at the middleware. Otherwise
> the ceiling is just a decorative number.

**An error that said nothing.**
> Every provider failure logged as “Provider returned error.” Very useful. One line caused it:
> `JSON.stringify(error.cause)` returns `{}`, because an Error's properties are not enumerable. So
> moderation, 5xxs and context overflows all disappeared at the exact moment I needed to know what
> happened.

**Silent truncation looks identical to a hang.**
> A 400-step trace limit was hit by one long attempt, and the trace just stopped. The run looked
> idle for an hour while it was working. I blamed the wrong thing at first. Any limit that discards
> data has to be loud, so it is now 20,000 steps and truncation is written into the trace as a marker.

**An agent given a turn will use it.**
> This is the one I would most want another builder to hear. The orchestrator can pause when there
> is nothing worth doing. Continuous mode then resumed it on a timer, handed it the same context,
> and asked the same question. And given a turn, the agent will use it. It wrote a restated synthesis,
> then a re-described map of its own threads. I fixed the syntheses; it moved to relationships. I
> fixed those; it reworded them to slip past the check. Three loops, one cause.
>
> Roughly half of one direction's budget went to pausing and resuming. The fix was not a cleverer
> duplicate check. It was to stop waking the agent on a clock. A pause now stands until evidence
> arrives. An hour of quiet went from about two dollars to seventeen cents, and the recorded
> findings went up.

**A scheduler must not mistake its own bookkeeping for progress.**
> The backoff reset on any new event — including the pause the orchestrator writes and the resume the
> supervisor writes a moment later. So the loop was persuading itself that research had happened by
> writing about its own scheduling. It was busy, technically. It was not learning.

**"Run forever" is a scheduling problem.**
> Giving the agent permission to stop created a new bug. Continuous mode woke the paused direction
> every 15 seconds, at about 15 cents a turn, to ask the same question with the same context. The fix
> was to treat a pause and an idle turn as the same signal, and back both off on one curve from one
> minute to thirty — resetting only when something actually happens. In practice, the literature
> watcher becomes the metronome. Research resumes because evidence arrived, not because a timer
> fired.

---

## Chapter 7 — Publishing traces without publishing your machine (20:00–23:00)

**Show:** Start on the mirror's agent trace, cut to `trace-publish.ts`, then show a withheld step.

> Originally the mirror showed timing but not transcripts, because traces contain prompts, paths and
> command output. Which means the most interesting part was also the part most likely to contain
> something I should not publish.
>
> The obvious fix is to redact harder. I think that is the wrong shape. A redactor is a guess about
> what a leak looks like. When the guess is wrong, it fails *silently*. That is a terrible property
> for a privacy mechanism.

Now explain the design. This is the transferable idea:

> So publishing runs in two stages: redact, then verify. The assembled record gets walked field by
> field and checked against identifiers from the running environment — username, hostname, home
> directory and the value of every credential-shaped variable. If something still matches, the
> publish stops. Nothing gets written. The safest output is sometimes no output.
>
> The important part is that the check runs on the *assembled* record. I do not have to trust every
> part of the system to remember to redact. If I miss a pattern, the result is a refused publish
> instead of a leak.

Close on the bug the check caught. Hold the source URL on screen while you say this:

> And it immediately caught a bug of exactly the kind it exists for. My drive-letter pattern had no
> lookbehind, so the `s:` in `https:` got parsed as a drive letter. Every cited source URL would have
> been replaced with a path marker. Not a great look for a literature system. There is now a test
> asserting that arXiv links survive redaction.

---

## Chapter 8 — What it can't do yet (23:00–25:00)

**Show:** Bring up the README's “Limits of the current evidence.” Let this be a slower section and
end on the limitations rather than a call to action.

> Now for the part where I put the brakes on. The attention results are bounded to 0.5B–1.5B models
> at 4K context on one consumer GPU. That is *simulated* memory pressure, not the long-context regime
> the attention direction ultimately targets. The strategy direction ran on a DGX Spark, but those
> results are still provisional and the withheld decade has not been evaluated.
>
> The sample sizes are small. The eviction study measures the symptom, not the mechanism. It does
> not record whether the needle token was evicted or survived but could not be used. Those are still
> two different explanations, and this run does not separate them.
>
> So the honest summary is the one I started with. The attention run re-derived published results,
> and the strategy run is not a validated trading result. Whether this process *can* produce
> something new is still an open question about scale. I would rather leave it as a question than
> dress it up as an answer.
>
> It is MIT licensed, it runs locally on your own API key, and the cloud parts are optional. The link
> is in the description. If you try it, tell me what it gets wrong.

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
- **The private instance is the strongest thing you have and the easiest to undersell.** Say out
  loud that it is not in the public repository and that you use it for your own work: a tool
  someone actually runs is a different claim from a demo that runs once.
- **Do not claim novelty anywhere**, including the title and thumbnail. The video's credibility is
  the whole asset.
