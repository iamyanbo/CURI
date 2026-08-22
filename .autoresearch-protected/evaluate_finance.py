"""PROTECTED evaluator for the finance-backtest domain.

The candidate never sees this file, and never sees the evaluation window.

What this owns, and why each piece cannot be left to the candidate:

  * the price series          - generated here from a fixed seed, so the
                                candidate cannot choose favourable data
  * the train / eval split    - a TIME split. The candidate is given prices up
                                to the split and nothing after it
  * the causality test        - the decisive check in this field, see below
  * transaction costs         - a strategy is only profitable net of what it
                                costs to trade, and a candidate that sets its
                                own costs will set them to zero
  * the Sharpe computation    - recomputed here, never trusted from the
                                candidate's own printout

## How lookahead is caught

Backtest overfitting has one irreducible signature: a strategy that uses
information it could not have had at the time. Static analysis of the code is a
losing game - `shift(-1)`, negative indexing, a reversed sort, a rolling window
centred instead of trailing all express it, and a determined candidate can hide
it.

So this does not read the code. It PERTURBS THE FUTURE and checks the past:

    positions_a = signal(prices)
    prices_b    = prices with every value AFTER index t replaced by noise
    positions_b = signal(prices_b)
    assert positions_a[:t] == positions_b[:t]

A causal strategy cannot notice the change, because it never looked. Any
strategy that does look produces different positions before t, and is caught
regardless of how the lookahead was written. This is the finance analogue of
the CUDA domain's roofline check: a property that physics (here, causality)
guarantees, so violating it is proof rather than suspicion.

Contract with the harness:

    evaluate_finance.py --candidate DIR --output PATH --out RESULT.json
                        --baseline-primary N [--baseline-secondary N]
                        --support-delta N
"""

import argparse
import importlib.util
import json
import pathlib
import sys

import numpy as np

# ---------------------------------------------------------------- constants

# The series is generated here, deterministically. `determinism: bitwise` in the
# domain config is a promise this makes good on: same inputs, same numbers.
SERIES_SEED = 20260822
N_DAYS = 3200
N_ASSETS = 12

# The split is a DATE, not a random partition. Everything at or after this index
# is held back and never written into the candidate's worktree.
TRAIN_END = 2200

# Named windows the harness rotates through for temporal-fold replication. Each
# is a slice of the held-back region: a strategy that only works in one regime
# is exactly what this domain exists to catch.
EVAL_WINDOWS = {
    "2019H1": (2200, 2400),
    "2020H2": (2400, 2600),
    "2022H1": (2600, 2800),
    "2023H2": (2800, 3000),
    "2024H1": (3000, 3200),
}
DEFAULT_WINDOW = "2019H1"

# Realistic round-trip cost. A strategy that trades every day must beat this.
COST_PER_TURNOVER = 0.0010          # 10 bps
TRADING_DAYS = 252

# Below this many trades the Sharpe is an artifact of a handful of days.
MIN_TRADES = 20


def make_prices(seed: int = SERIES_SEED) -> np.ndarray:
    """A multi-regime synthetic market: (N_DAYS, N_ASSETS) of prices.

    Regimes matter. A single stationary process would let any half-reasonable
    momentum rule work everywhere, and the temporal-fold replication would have
    nothing to discriminate. Volatility and drift shift at fixed breakpoints, so
    a strategy tuned to one window can genuinely fail in another - which is the
    honest failure this domain is built to surface.
    """
    rng = np.random.default_rng(seed)
    n_regimes = 8
    bounds = np.linspace(0, N_DAYS, n_regimes + 1).astype(int)

    rets = np.zeros((N_DAYS, N_ASSETS))
    for r in range(n_regimes):
        lo, hi = bounds[r], bounds[r + 1]
        drift = rng.normal(0.0002, 0.0004, N_ASSETS)
        vol = rng.uniform(0.006, 0.022, N_ASSETS)
        # A shared market factor, so assets are correlated the way real ones are.
        factor = rng.normal(0, 1, hi - lo)
        beta = rng.uniform(0.3, 1.2, N_ASSETS)
        idio = rng.normal(0, 1, (hi - lo, N_ASSETS))
        rets[lo:hi] = drift + vol * (factor[:, None] * beta + idio * 0.6)

    return 100.0 * np.exp(np.cumsum(rets, axis=0))


def load_signal(candidate: pathlib.Path):
    """Import `signal` from the candidate's strategy.py."""
    path = candidate / "strategy.py"
    if not path.exists():
        return None, "strategy.py is missing"
    spec = importlib.util.spec_from_file_location("candidate_strategy", path)
    if spec is None or spec.loader is None:
        return None, "strategy.py could not be loaded"
    mod = importlib.util.module_from_spec(spec)
    sys.modules["candidate_strategy"] = mod
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:                                # noqa: BLE001
        return None, f"strategy.py raised on import: {exc}"
    fn = getattr(mod, "signal", None)
    if not callable(fn):
        return None, "strategy.py defines no callable `signal(prices)`"
    return fn, None


def sharpe(returns: np.ndarray) -> float:
    """Annualised Sharpe. Zero variance is zero information, not infinity."""
    sd = float(np.std(returns, ddof=1))
    if not np.isfinite(sd) or sd < 1e-12:
        return 0.0
    return float(np.mean(returns) / sd * np.sqrt(TRADING_DAYS))


def run_window(fn, prices: np.ndarray, lo: int, hi: int, warmup: int = 200):
    """Score the candidate over one window, net of costs.

    The strategy sees history up to each decision point and nothing beyond it;
    that is enforced by construction here AND verified by the causality test.
    """
    view = prices[max(0, lo - warmup):hi]
    offset = lo - max(0, lo - warmup)

    pos = np.asarray(fn(view.copy()), dtype=float)
    if pos.ndim == 1:
        pos = np.repeat(pos[:, None], view.shape[1], axis=1)
    if pos.shape != view.shape:
        raise ValueError(f"signal returned {pos.shape}, expected {view.shape}")
    if not np.all(np.isfinite(pos)):
        raise ValueError("signal returned non-finite positions")

    # Positions are capped: leverage is not alpha.
    pos = np.clip(pos, -1.0, 1.0)

    rets = np.zeros_like(view)
    rets[1:] = view[1:] / view[:-1] - 1.0

    # Yesterday's decision earns today's return. This is where lookahead would
    # otherwise sneak in, so the shift is applied HERE, not by the candidate.
    held = np.zeros_like(pos)
    held[1:] = pos[:-1]

    gross = np.sum(held * rets, axis=1) / max(1, pos.shape[1])
    turnover = np.sum(np.abs(np.diff(held, axis=0, prepend=0.0)), axis=1) / max(1, pos.shape[1])
    net = gross - turnover * COST_PER_TURNOVER

    net_w = net[offset:]
    trades = int(np.sum(turnover[offset:] > 1e-9))
    return sharpe(net_w), trades, float(np.sum(turnover[offset:]))


def causality_violation(fn, prices: np.ndarray) -> str | None:
    """Return a description if the strategy reacts to data it cannot have seen.

    Three probes at different cut points, because a strategy might peek only one
    step ahead or only in one region. Any difference before the cut is decisive:
    the past cannot depend on the future.
    """
    base = prices[:1400].copy()
    ref = np.asarray(fn(base.copy()), dtype=float)
    if ref.ndim == 1:
        ref = np.repeat(ref[:, None], base.shape[1], axis=1)

    rng = np.random.default_rng(7)
    for cut in (700, 1000, 1300):
        perturbed = base.copy()
        # Replace the future with a different but plausible path.
        shock = rng.normal(1.0, 0.05, perturbed[cut:].shape)
        perturbed[cut:] = perturbed[cut:] * shock

        out = np.asarray(fn(perturbed.copy()), dtype=float)
        if out.ndim == 1:
            out = np.repeat(out[:, None], base.shape[1], axis=1)
        if out.shape != ref.shape:
            return f"signal changed shape when future data changed ({out.shape} vs {ref.shape})"

        diff = np.nanmax(np.abs(out[:cut] - ref[:cut]))
        if np.isfinite(diff) and diff > 1e-9:
            return (f"positions BEFORE index {cut} changed by up to {diff:.3e} when only data "
                    f"AFTER {cut} was altered - the strategy is reading the future")
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--output", default=None)
    ap.add_argument("--out", required=True)
    ap.add_argument("--baseline-primary", type=float, default=0.0)
    ap.add_argument("--baseline-secondary", type=float, default=None)
    ap.add_argument("--support-delta", type=float, default=None)
    args = ap.parse_args()

    candidate = pathlib.Path(args.candidate)
    checks: list[dict] = []

    def check(cid, cls, passed, detail):
        checks.append({"id": cid, "class": cls, "passed": bool(passed), "detail": detail})

    def emit(primary, secondary, raw):
        pathlib.Path(args.out).write_text(
            json.dumps({"primary": primary, "secondary": secondary,
                        "measurement_resolution": 1e-12,
                        "checks": checks, **raw}, indent=1), encoding="utf8")
        return 0

    # Which window are we scoring? The harness owns this key; a candidate that
    # sets it has escaped the reproduction policy and is caught upstream.
    cfg = {}
    cfg_path = candidate / "config.json"
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf8"))
        except Exception as exc:                            # noqa: BLE001
            check("config_parses", "integrity", False, f"config.json is not valid JSON: {exc}")
            return emit(None, None, {})

    window = str(cfg.get("eval_window", DEFAULT_WINDOW))
    if window not in EVAL_WINDOWS:
        check("eval_window", "integrity", False,
              f"unknown eval_window {window!r}; expected one of {sorted(EVAL_WINDOWS)}")
        return emit(None, None, {})

    fn, err = load_signal(candidate)
    if fn is None:
        check("loads", "integrity", False, err or "unknown load failure")
        return emit(None, None, {})
    check("loads", "integrity", True, "strategy.py exposes signal(prices)")

    prices = make_prices()

    # --- causality: the decisive check in this field -----------------------
    try:
        violation = causality_violation(fn, prices)
    except Exception as exc:                                # noqa: BLE001
        check("causality", "shortcut", False, f"causality probe raised: {exc}")
        return emit(None, None, {})
    check("causality", "shortcut", violation is None,
          violation or "positions are unchanged when only future data changes; the strategy is causal")
    if violation is not None:
        # A strategy that reads the future has no meaningful Sharpe to report.
        return emit(None, None, {"window": window})

    # --- score the held-back window ----------------------------------------
    lo, hi = EVAL_WINDOWS[window]
    try:
        primary, trades, turnover = run_window(fn, prices, lo, hi)
    except Exception as exc:                                # noqa: BLE001
        check("runs", "integrity", False, f"signal raised while scoring: {exc}")
        return emit(None, None, {"window": window})
    check("runs", "integrity", True, f"scored {hi - lo} held-back days in window {window}")

    # --- did it actually trade? --------------------------------------------
    check("trades", "integrity", trades >= MIN_TRADES,
          f"{trades} trading days with turnover (floor {MIN_TRADES}); "
          "a Sharpe from a handful of days is an artifact, not a strategy")

    # --- generalisation: the OTHER windows it was not scored on ------------
    others = [w for w in EVAL_WINDOWS if w != window]
    other_sharpes = []
    for w in others:
        a, b = EVAL_WINDOWS[w]
        try:
            sh, _, _ = run_window(fn, prices, a, b)
            other_sharpes.append(sh)
        except Exception:                                   # noqa: BLE001
            other_sharpes.append(float("nan"))
    secondary = float(np.nanmean(other_sharpes)) if other_sharpes else None

    # A strategy that works only in its scored window is curve-fitted. This is
    # the finance analogue of the CUDA domain's hidden-shape check.
    if secondary is not None and np.isfinite(secondary) and primary > 0:
        ratio = secondary / primary
        check("other_windows", "leakage", ratio >= 0.25,
              f"mean Sharpe on the {len(others)} unscored windows is {secondary:.3f}, "
              f"{ratio:.2f} of the scored {primary:.3f} (floor 0.25); a large gap means the "
              "strategy is fitted to one regime")
    else:
        check("other_windows", "leakage", True,
              f"mean Sharpe on unscored windows: {secondary if secondary is None else round(secondary, 3)}")

    # --- plausibility ceiling ----------------------------------------------
    # Not physics, but a Sharpe above this on costed daily data with a simple
    # rule means something is wrong with the measurement, not that alpha was
    # found. Deliberately loose: this is a fraud tripwire, not a performance bar.
    check("plausible", "shortcut", primary < 6.0,
          f"annualised Sharpe {primary:.3f} against a plausibility ceiling of 6.0"
          + ("" if primary < 6.0 else " - a costed daily strategy does not do this honestly"))

    return emit(float(primary), secondary, {
        "window": window, "trades": trades, "turnover": round(turnover, 3),
        "other_windows": {w: (None if not np.isfinite(s) else round(s, 4))
                          for w, s in zip(others, other_sharpes)},
        "cost_per_turnover": COST_PER_TURNOVER,
    })


if __name__ == "__main__":
    sys.exit(main())
