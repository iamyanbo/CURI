# Proposed direction: resource-adaptive transformer inference

## Purpose

Discover and implement combinations of inference mechanisms that adapt a
pretrained transformer to different workload regimes while preserving output
quality. The research object is the inference system, not a single CUDA kernel
or one throughput number.

This is a good next direction because it has separable components, meaningful
cross-component interactions, and abundant prior work to synthesize. It can
produce useful negative results even when no single global score improves.

## System boundary

- inference with small pretrained dense or mixture-of-experts models;
- hardware capacity is measured metadata, not a pipeline-wide VRAM rule;
- output quality/correctness is always a required constraint;
- optimization may change attention/KV-cache policy, precision, speculative
  decoding, batching/scheduling, or how these mechanisms compose.

## Initial program questions

1. Which attention and KV-cache policies help short interactive, long-context,
   and memory-pressure regimes, and where do they reverse?
2. When does speculative decoding overcome draft-model and verification
   overhead on limited hardware?
3. Which precision choices reduce memory or latency without crossing a
   task-specific quality boundary?
4. Do scheduling/batching policies complement or conflict with cache and
   speculative-decoding choices?
5. Can a simple regime selector choose among validated implementations better
   than any one fixed configuration?

The first studies should reproduce one known mechanism in two distinct regimes,
then test one cross-component interaction. A candidate-novel contribution should
be an evidenced adaptation, combination, or explanatory regime boundary—not an
unsupported claim that a familiar optimization is new.

The program review should ask whether the mechanism changed a system decision,
whether its effect reproduced, whether another component should now be tested,
and whether the current thesis should be revised. It should not ask which edit
has the highest scalar score. No model-authored duration estimate or automatic
time ceiling is used; actual duration remains visible in the execution trace.

## Study evaluators

The old attention evaluator is insufficient as the universal judge for this
direction. It can remain one evaluator for implementation studies, but it must
not gate literature, mechanism analysis, trace analysis, or system-integration
questions. Those use source-grounded or artifact-grounded study protocols.

A code-benchmark study in this direction should run fixed pretrained-model
workloads and emit:

- aggregate quality/correctness and environment metadata;
- per-regime time-to-first-token, inter-token latency, throughput, and peak
  memory slices;
- paired candidate-versus-reference output agreement;
- selectors for model, prompt regime, batch regime, context length, and
  mechanism configuration;
- integrity checks that ensure the candidate performed the complete workload.

There should be no weighted overall score. Each study freezes only the outcomes
needed for its question. For example, a cache study may require quality on all
regimes, lower peak memory on a long-context slice, and no latency regression on
an interactive slice. That yields scoped evidence rather than a leaderboard.

Build the benchmark evaluator only when a selected study requires those
outcomes. Literature synthesis and artifact-analysis studies can begin under
their own frozen evidence plans; they do not need to wait for a single giant
universal harness. Starting every study against the attention-only evaluator
would reproduce the exact narrowness this redesign is meant to remove.
