/**
 * There is deliberately no evaluator registry. Executable checks are captured
 * through run_check and independently rerun; source and artifact evidence is
 * preserved for the orchestrator's task-specific interpretation.
 */
export const NO_UNIVERSAL_EVALUATOR = "Not every study should use the same evaluator.";
