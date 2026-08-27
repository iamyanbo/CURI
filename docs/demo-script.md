# CURI — Cumulative Research & Inquiry — 4-minute demo script

Covers the four required beats: the problem, the value proposition, the app in action, and visible
proof that the backend runs on Google Cloud. Timings are targets, not a stopwatch; the whole thing
lands at roughly 3:50 spoken at a normal pace.

This is a production script, not a README to read aloud. Keep the dashboard, trace and cloud
consoles moving while you speak; each section says what to show and what the viewer should notice.

**Before recording**

- Run `research publish --project $PROJECT` first: the mirror only updates while a supervisor is
  running, so a stopped pipeline leaves it stale.
- Supervisor, watcher and dashboard running; a direction active with work in flight.
- Local dashboard open at `http://127.0.0.1:7331`, the **Execution** view selected.
- The finance direction's dashboard forwarded from the second machine:
  `ssh -i ~/.ssh/<key> -N -L 7332:127.0.0.1:7332 <user>@<host>`, then `http://127.0.0.1:7332`.
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
> The failure is structural, not a matter of prompting. If the system's unit of progress is "the
> number improved", it can never record that a method *failed*, and a negative result is often the
> most useful thing an experiment produces.

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
>
> Three things make that more than a prompt. A delegation gate mechanically refuses a brief that
> cites no prior evidence or repeats an earlier experiment. Findings accumulate as syntheses that
> can be superseded rather than overwritten. And the agent is allowed to stop when it has nothing
> worth asking — which is the part a score-maximizing loop structurally cannot do.

*On screen:* the Understanding view — components, syntheses, and the relations graph.

---

## 1:05 – 2:35 — The app in action

Move through the dashboard, narrating what is on screen. Do not describe features; show the run.

**Direction and threads** (~15s)
> This direction asks how transformer inference mechanisms adapt across memory-pressure and
> long-context regimes. Four research threads, each carrying its own evolving understanding, and
> seventeen recorded outcomes across forty-three hours.

**The piano roll** (~25s)
> This is the actual execution, on a real time axis: reasoning in one colour, tool calls in
> another, model wait, idle, errors. You can see where the time went — and it is mostly not the
> GPU. Measured across this run: about an hour of tool time against an hour and a half waiting on
> the model, with the GPU at a third utilisation.

**The agent trace** (~25s)
> Clicking a run opens the transcript: the model's reasoning, the experiment code it wrote, the
> checks it ran. A hundred and twenty-two of the hundred and twenty-five runs carry one, published
> without publishing my machine — I'll come back to how.

**A finding, with its envelope** (~25s)
> Here is the result I would point at. The agent tested whether attention-mass KV-cache eviction
> keeps the tokens a later question needs. It scored zero percent on non-local retrieval at half
> cache budget — indistinguishable from evicting at random. That refuted the study's *own* leading
> hypothesis, and it was recorded as `bounded`, not rewritten into a success. Every finding ends
> with the envelope its evidence covers and what would not follow from it.

**A refutation** (~15s)
> And here it recorded a refutation: randomized-Hadamard rotation does not prevent key quantization
> damage. Twelve supported, three bounded, one refuted, one inconclusive. A loop that keeps whatever
> improved the number has nowhere to put that fourth category.

**The agent stopping** (~10s)
> And here the orchestrator paused the direction itself, judging nothing worth doing yet. It then
> sat at zero cost until new evidence arrived. Not a timer — evidence.

**A second domain, on a second machine** (~20s)
> This is the same runtime on a DGX Spark, studying something completely different: when a trading
> strategy found in historical data keeps its edge outside the window it was found in. Its first
> experiment swept search intensity from one to five thousand strategy variants.
>
> Best in-sample Sharpe climbs from 0.78 to 4.11 as you search harder. Out of sample it *falls*. And
> once you charge ten basis points of trading cost, the best-looking strategy of five thousand
> returns minus 0.89. That is the project's whole thesis, measured in a domain it was not built for.
>
> A decade of later data — 2016 to 2026 — sits outside that machine entirely. The agent has never
> seen it.

*On screen:* the finance dashboard, then the search-intensity table.

---

## 2:35 – 3:35 — Running on Google Cloud

This is the required proof beat. Show, do not assert.

**The live URL** (~20s)
> The public record is served from Cloud Run. This is the deployed mirror — read-only, no control
> endpoints, scales to zero.

*On screen:* the `.run.app` URL visible in the address bar; scroll to the published traces.

**Cloud Run console** (~20s)
> Here is the service itself in the Cloud Run console: the revision, the region, the request
> traffic from the page I just loaded.

*On screen:* Cloud Run → `research-mirror` → Revisions and Metrics.

**Firestore** (~20s)
> And the record behind it lives in Firestore — one document per finding, run and trace chunk,
> written by the supervisor as the research proceeds. The agents themselves are Gemini 3.7 Flash
> through Genkit, with usage metered per model call.

*On screen:* Firestore data browser on `directions/resource-adaptive-inference`, expanding
`outcomes` and `traceSteps`.

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
- **The strongest 20 seconds** are the refuted hypothesis and the recorded pause. Both are things a
  score-maximizing loop cannot produce. If you cut for time, cut a dashboard view, not those.
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
