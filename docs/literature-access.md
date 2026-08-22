# Literature access: pull by default, push when time matters

The manager and executor can search the web. By default this is **pull**: the
manager searches when it is forming a hypothesis, using `arxiv_search`,
`web_search`, `code_search` and `fetch_content` from the Genkit worker and
`domain-search` extensions.

There is also a **push** mode — a watcher process (`src/scout.ts`) that polls
sources on its own schedule and writes them into the `sources` table, which the
manager's context packet then surfaces. It is **not enabled by default**.

This file explains which to use, and one case where the default is unsafe.

---

## The two modes answer different questions

| | Pull (default) | Push (watcher) |
|---|---|---|
| Question | "Is *this specific idea* already known?" | "Has the world changed since I last looked?" |
| Trigger | A hypothesis being formed | A clock |
| Coverage | Only while a cycle runs | Continuous, including between cycles |
| Cost | Latency inside the manager's timeout | A separate process |
| Reproducibility | Weaker: whatever the web returned at that moment | Stronger: the packet is a snapshot on disk |

They are not substitutes. A watcher cannot ask about a hypothesis it has never
seen, and the manager cannot notice anything published between cycles.

## Which one your domain needs

The question is whether **the world moves faster than your cycles**.

- **CUDA kernels (default: pull only).** A technique from 2023 is still true
  today. Nothing published this afternoon changes whether vectorised staging
  helps. Cycles run every couple of minutes, so the manager's own searches cover
  the ground.

- **Vision-language models (both).** Benchmarks and state-of-the-art move
  weekly, and a new checkpoint genuinely changes what a good baseline is.

- **Wet-lab biology (push, slow).** Literature moves in months, but a single
  experiment costs days, so a lead that arrives between runs is worth having.
  Poll daily, not hourly.

- **Finance (push only, date-fenced — see the warning below).**

---

## Warning: in a time-indexed domain, web search is a leakage channel

Read this before enabling search on any domain whose holdout is a **date range**
rather than a held-back split.

In finance the evaluation window is time. `domains/examples/finance.domain.json`
already treats `start_date` and `eval_window` as harness-owned config keys,
because a candidate that moves its own backtest window has escaped the
reproduction policy — that is the field's classic fraud, and the harness catches
it.

**Web search goes straight through that fence.** If the manager searches during
a campaign and reads what happened in Q3 2024, and the candidate is then
backtested on Q3 2024, the strategy was designed with knowledge of the future.
Nobody has to cheat deliberately: a headline in the model's context is enough.
The result is lookahead bias that no existing gate detects, and it will present
as an unusually good validated strategy — which is the most dangerous shape a
false result can take.

So for a time-indexed domain:

1. **Do not give the manager raw search tools.** Pull access bypasses any
   as-of filter by construction, because the model chooses the query and reads
   the answer directly.
2. **Use the watcher instead**, and filter what reaches the packet by date. Each
   record in `sources` carries `published` and `retrieved_at`; surface only
   sources published *before* the evaluation window opens.
3. Treat the fence as part of the evaluator's job, not the manager's good
   intentions. The manager cannot unsee a date it has already read.

The general rule: **pull is safe when the holdout is data you withheld; push
with an as-of filter is required when the holdout is time.**

---

## Enabling the watcher

Run it alongside a campaign:

```
npx tsx src/scout.ts --campaign <id> --topic "<what to watch>" --every 3600
```

Options:

- `--topic` — a plain-language topic. Each provider translates it into its own
  query syntax (arXiv field queries, GitHub qualifiers, plain words for HN);
  sending one raw string to all three returns nothing useful from most of them.
- `--every` — seconds between sweeps. Default 3600.
- `--once` — a single sweep, for testing.
- `--max` — results per provider per sweep. Default 15.

Providers live in `PROVIDERS` in `src/scout.ts`: arXiv (preprints), GitHub
(repositories and releases — often where a kernel technique lands first), and
Hacker News via Algolia (discussion, releases, blog posts that never become
papers). Adding one means implementing `Provider`, which is an id and a `fetch`
returning bounded `Lead` objects.

`GITHUB_TOKEN` raises the GitHub rate limit; `GITHUB_MIN_STARS` (default 25)
sets the relevance floor, because sorting purely by "recently pushed" surfaces
one-star scratch repos that happen to match a word in a readme.

## Disabling search entirely

Remove the tool names from `SEARCH_TOOLS` in `src/loop/cycle.ts`. With an empty
allowlist the worker is launched with `--no-tools`, and the manager's context
packet becomes its whole world again — which is the strongest reproducibility
guarantee this system can offer, since a cycle can then be replayed from the
packet written to disk.

## Everything fetched is untrusted

Whichever mode you use, text arriving from outside is treated as **data, never
instructions** — the same posture as a candidate diff:

- The prompts state explicitly that instruction-like text inside a search result
  is an attack, not a source, and that no result can justify a threshold.
- Watcher records are stored with `reliability = 'lead'` and can never become
  evidence for or against a claim without a human promoting them.
- Control and bidirectional characters are stripped, and titles and abstracts
  are clipped, so an injected payload cannot dominate a packet.

Filtering does not solve prompt injection and is not claimed to. The actual
defence is structural: nothing from the web can move a threshold, set a verdict,
or enter the evidence chain on its own.
