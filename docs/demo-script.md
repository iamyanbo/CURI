
# CURI — Cumulative Research & Inquiry — 4-minute demo script

Covers the four required beats: the problem, the value proposition, the app in action, and visible
proof that the backend runs on Google Cloud. Timings are targets, not a stopwatch; the whole thing
lands at roughly 3:50 spoken at a normal pace.

This is a production script, not a README to read aloud. Keep the dashboard, trace and cloud
consoles moving while you speak; each section says what to show and what the viewer should notice.

**Before recording**

- Run `research publish --project $PROJECT` for the attention direction first: the mirror only
  updates while a supervisor is running, so a stopped pipeline leaves it stale.
- Supervisor, watcher and dashboard running; a direction active with work in flight.
- Local dashboard open at `http://127.0.0.1:7331`, the **Execution** view selected.
- The finance direction's dashboard forwarded from the second machine:
  `ssh -i ~/.ssh/<key> -N -L 7332:127.0.0.1:7332 <user>@<host>`, then `http://127.0.0.1:7332`.
- Keep the finance direction local-only. Show it through the forwarded dashboard; do not publish it
  to Firestore or include it in the Cloud Run mirror.
- The public mirror open in a second tab: `https://research-mirror-qdqttyl3jq-uc.a.run.app`.
- A third tab on the Cloud Run service page for `research-mirror`, and a fourth on the Firestore
  data browser showing `directions/resource-adaptive-inference`.
- Close anything containing credentials. The dashboard shows no keys, but a terminal might.

---

## 0:00 – 0:35 — The problem

> Most autonomous research harnesses are score maximizers. Propose a change, run the benchmark,
> keep it if the number goes up, repeat. That is a reasonable engineering loop when the benchmark
> *is* the specification — but as research it invites Goodhart's law, and in practice these
> pipelines collapse into hyperparameter search. We already have good algorithms for
> hyperparameter search. Using a language model for it is a waste of what the model can do.
>
The problem with these pipelines is structural. When progress is defined as a number going up,
failures are discarded rather than saved as evidence. A research system should preserve negative
results, because learning what does not work is just as valuable as a positive outcome of an
experiment.

> I made this demo for the purposes of entering the Google Cloud hackathon. The question I wanted
> to explore was whether an autonomous system could do research without turning every question into
> a score-improvement contest.

*On screen:* the README's "Research vs Benchmark Chasing" table.

---

## 0:35 – 1:05 — The value proposition

> CURI's unit of progress is an investigation, not a score. It starts from a question and competing
> explanations, chooses a method that can actually answer it, and records what the evidence
> supports or rules out — bounded by the conditions actually tested. There is no global score and
> no incumbent implementation to beat.

> CURI is organized as a pipeline with separate research roles. The watcher gathers relevant prior
> work. The orchestrator uses that work to choose an open question and write an experiment brief. It
> delegates the experiment to an executor, which runs it in an isolated worktree. When the result
> returns, the orchestrator interprets it and records an outcome or synthesis.

*On screen:* the Understanding view — components, syntheses, and the relations graph.

> I started the first run with a broad question about how language-model systems behave when memory
> and time are limited. CURI turned that question into four research threads and ran controlled
> experiments across them. The run recorded seventeen outcomes, including supported findings,
> bounded results, a refutation and an inconclusive result.

---

## 1:05 – 2:25 — The run in the dashboard

Move through these views in order: direction, execution timeline, trace and outcome.

**Direction and threads** (~10s)

*On screen:* the direction card and its four research threads.

> This is the first direction I gave the system. It asks how language-model systems behave when
> memory and time are limited. The run developed four threads and recorded seventeen outcomes over
> roughly forty-three hours.

**Execution view** (~15s)

*On screen:* switch to **Execution** and let the timeline remain visible while the run summary is
shown.

> This timeline shows where that time went: reasoning, tool calls, model and provider time while
> responses were generated and returned, idle periods and errors. It makes the run inspectable as a
> process rather than just a final score.

**Trace** (~15s)

*On screen:* open one attempt from the timeline and scroll through its trace.

> I can select a task and see its original brief and recorded outcome. I can then open one of its
> attempts and inspect the trace: the model's reasoning and the tools it called. The task view also
> lists the verified checks. Together, these views show how a proposed experiment led to the result
> that was recorded.

**Outcome** (~20s)

*On screen:* open the corresponding outcome and show its evidence and status.

> One of these experiments tested whether an inference method continued to work when memory was
> constrained. It did not. Under the tested conditions, it performed no better than a random
> baseline. CURI preserved that result as bounded evidence instead of discarding it as a failed run.

---

## 2:25 – 3:35 — Showing it running locally and in the cloud

> That is the basic idea. Now let me show where I ran it.

**Local run** (~25s)

*On screen:* the forwarded dashboard on the DGX Spark. Keep this local view separate from the public
mirror.

> The pipeline itself is domain-blind. It does not know whether the research is about model
> inference or finance; the domain supplies the question and evaluator. The model layer is plug and
> play as well. Here it is a locally hosted model on a DGX Spark, but the same pipeline can connect
> to any supported provider through its API. This run stays local and is not part of the published
> Firestore record.

**Google Cloud proof** (~60s)

*On screen:* cut from the local dashboard to the public mirror and open the attention direction.
Then show the `.run.app` URL, the Cloud Run service and the Firestore record.

> For this demo, I published the attention direction to Firestore and served it through Cloud Run.
> This is the public record of the run: its threads, findings, traces and costs. The pipeline itself
> stayed on the machine that ran it; only this redacted research record is exposed here. I chose that
> split deliberately. The bottleneck was model latency rather than GPU throughput, so renting a
> cloud GPU would have added cost without addressing the main constraint.
>
> The mirror is read-only, has no control endpoints and scales to zero. Here is the Cloud Run service
> itself: the revision, region and request traffic from the page I just loaded. And behind it is the
> Firestore record — one document per finding, run and trace chunk. The agents are Gemini 3.7 Flash
> through Genkit, with usage metered per model call.

*On screen:* Cloud Run → `research-mirror` → Revisions and Metrics, then Firestore on
`directions/resource-adaptive-inference`, expanding `outcomes` and `traceSteps`.

---

## 3:35 – 3:50 — Close

> The traces are published without publishing my machine. Text is redacted, and then the assembled
> record is checked against identifiers taken from the running environment — username, hostname,
> home directory, credential values. Anything that still matches stops the publish. It is a gate,
> not a filter.
>
> It is open source under MIT, and it runs locally on your own API key. Cloud is optional.
>
> And the last thing: the finance direction has never seen 2016 onward. Let's find out.

*On screen (if time allows):* the holdout evaluation running against the withheld decade.

---

## Notes for the recording

- **Do not fabricate a live run.** If the pipeline is mid-attempt, say so and show the in-flight
  trace; a system that takes 96 minutes on one experiment is more honest than a staged loop.
- **The strongest 20 seconds** are the finding preview and the local-to-cloud transition. If you
  cut for time, cut a dashboard view, not those proof points.
- **Say the numbers you can defend.** Across both directions: 214 runs, $60.13, 71.3M input tokens,
  21 recorded outcomes. The attention direction alone: 125 runs, $39.60, 17 outcomes — 12 supported,
  3 bounded, 1 refuted, 1 inconclusive.
- **Do not quote the finance CPCV or PBO figures.** That table disagrees with the search-intensity
  table on out-of-sample Sharpe and reports an implausibly low probability of backtest overfitting.
  The search-intensity numbers are solid; those are not, and the contradiction is unresolved.
- **The strongest possible ending is the holdout, run live.** Ten years the agent has never seen,
  evaluated on camera. It costs nothing — local Python against local files — and whichever way it
  lands it is a real result. Do not do it off camera and report the outcome.
- Do not claim novelty. The findings largely re-derive published work, and the video is stronger
  for saying so before anyone else does.
