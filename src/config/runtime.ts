export type RuntimeProfile = "local" | "cloud";
export type ModelProvider = "openrouter" | "gemini-api" | "vertex-ai";
export type ComputeBackend = "local" | "cloud-run";
export type StateBackend = "sqlite" | "firestore";

export interface RuntimeConfig {
  profile: RuntimeProfile;
  modelProvider: ModelProvider;
  compute: ComputeBackend;
  store: StateBackend;
  region: string;
  maxCostUsd: number;
}

const valueOf = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

function choice<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  const selected = (value ?? fallback) as T;
  if (!allowed.includes(selected)) throw new Error(`invalid --${name} ${selected}; expected ${allowed.join("|")}`);
  return selected;
}

export function runtimeConfig(argv = process.argv.slice(2), env = process.env): RuntimeConfig {
  const profile = choice(valueOf(argv, "profile") ?? env.AR_PROFILE,
    ["local", "cloud"] as const, "local", "profile");
  const defaults = profile === "cloud"
    ? { modelProvider: "vertex-ai" as const, compute: "cloud-run" as const, store: "firestore" as const }
    : { modelProvider: "openrouter" as const, compute: "local" as const, store: "sqlite" as const };
  const modelProvider = choice(valueOf(argv, "model-provider") ?? env.AR_MODEL_PROVIDER,
    ["openrouter", "gemini-api", "vertex-ai"] as const, defaults.modelProvider, "model-provider");
  const compute = choice(valueOf(argv, "compute") ?? env.AR_COMPUTE,
    ["local", "cloud-run"] as const, defaults.compute, "compute");
  const store = choice(valueOf(argv, "store") ?? env.AR_STORE,
    ["sqlite", "firestore"] as const, defaults.store, "store");
  const maxCostUsd = Number(valueOf(argv, "max-cost") ?? env.AR_MAX_COST_USD ?? 0);
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) throw new Error("max cost must be a finite non-negative number");
  return {
    profile,
    modelProvider,
    compute,
    store,
    region: valueOf(argv, "region") ?? env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
    maxCostUsd,
  };
}

/** Apply profile defaults before the first worker is invoked. */
export function configureRuntime(argv = process.argv.slice(2)): RuntimeConfig {
  const config = runtimeConfig(argv);
  process.env.AR_PROFILE = config.profile;
  process.env.AR_MODEL_PROVIDER = config.modelProvider;
  process.env.AR_COMPUTE = config.compute;
  process.env.AR_STORE = config.store;
  process.env.GOOGLE_CLOUD_LOCATION = config.region;
  return config;
}
