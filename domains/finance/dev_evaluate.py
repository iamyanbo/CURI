"""Visible development evaluator for the synthetic finance research domain.

This is deliberately not the protected confirmation set. Agents may inspect,
instrument, and rerun it while implementing a mechanism. Every use is therefore
development evidence and cannot by itself support a generalisation or alpha
claim. The protected evaluator uses a different deterministic series.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib
import sys

import numpy as np


SEED = 20260817
N_DAYS = 2000
N_ASSETS = 12
COST_PER_TURNOVER = 0.001
TRADING_DAYS = 252
FOLDS = {
    "dev_A": (1000, 1250),
    "dev_B": (1250, 1500),
    "dev_C": (1500, 1750),
    "dev_D": (1750, 2000),
}


def make_prices() -> np.ndarray:
    rng = np.random.default_rng(SEED)
    returns = np.zeros((N_DAYS, N_ASSETS))
    bounds = np.linspace(0, N_DAYS, 7).astype(int)
    for lo, hi in zip(bounds[:-1], bounds[1:]):
        drift = rng.normal(0.00015, 0.0005, N_ASSETS)
        vol = rng.uniform(0.007, 0.024, N_ASSETS)
        factor = rng.normal(0, 1, hi - lo)
        beta = rng.uniform(0.25, 1.25, N_ASSETS)
        idiosyncratic = rng.normal(0, 1, (hi - lo, N_ASSETS))
        returns[lo:hi] = drift + vol * (factor[:, None] * beta + 0.65 * idiosyncratic)
    return 100.0 * np.exp(np.cumsum(returns, axis=0))


def load_signal(candidate: pathlib.Path):
    path = candidate / "strategy.py"
    spec = importlib.util.spec_from_file_location("finance_dev_candidate", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["finance_dev_candidate"] = module
    spec.loader.exec_module(module)
    signal = getattr(module, "signal", None)
    if not callable(signal):
        raise RuntimeError("strategy.py must expose signal(prices)")
    return signal


def annualized_sharpe(returns: np.ndarray) -> float:
    deviation = float(np.std(returns, ddof=1))
    if not np.isfinite(deviation) or deviation < 1e-12:
        return 0.0
    return float(np.mean(returns) / deviation * np.sqrt(TRADING_DAYS))


def positions(signal, prices: np.ndarray) -> np.ndarray:
    output = np.asarray(signal(prices.copy()), dtype=float)
    if output.ndim == 1:
        output = np.repeat(output[:, None], prices.shape[1], axis=1)
    if output.shape != prices.shape or not np.all(np.isfinite(output)):
        raise RuntimeError(f"invalid positions {output.shape}; expected {prices.shape} and finite values")
    return np.clip(output, -1.0, 1.0)


def check_causality(signal, prices: np.ndarray) -> None:
    # Match development call lengths so a strategy cannot behave causally only
    # on the longer smoke-test input and peek on actual folds.
    base = prices[:450]
    reference = positions(signal, base)
    rng = np.random.default_rng(19)
    for cut in (120, 260, 390):
        perturbed = base.copy()
        perturbed[cut:] *= rng.normal(1.0, 0.04, perturbed[cut:].shape)
        changed = positions(signal, perturbed)
        delta = float(np.max(np.abs(reference[:cut] - changed[:cut])))
        if delta > 1e-9:
            raise RuntimeError(f"causality failed at {cut}: past positions changed by {delta:.3e}")


def evaluate_fold(signal, prices: np.ndarray, lo: int, hi: int) -> dict[str, float | int]:
    start = max(0, lo - 200)
    offset = lo - start
    view = prices[start:hi]
    target = positions(signal, view)
    returns = np.zeros_like(view)
    returns[1:] = view[1:] / view[:-1] - 1.0
    held = np.zeros_like(target)
    held[1:] = target[:-1]
    turnover = np.sum(np.abs(np.diff(held, axis=0, prepend=0.0)), axis=1) / N_ASSETS
    gross = np.sum(held * returns, axis=1) / N_ASSETS
    net = gross - COST_PER_TURNOVER * turnover
    return {
        "sharpe": annualized_sharpe(net[offset:]),
        "turnover": float(np.sum(turnover[offset:])),
        "trading_days": int(np.sum(turnover[offset:] > 1e-9)),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", default="domains/finance/candidate")
    parser.add_argument("--out")
    args = parser.parse_args()
    signal = load_signal(pathlib.Path(args.candidate).resolve())
    prices = make_prices()
    check_causality(signal, prices)
    folds = {name: evaluate_fold(signal, prices, lo, hi) for name, (lo, hi) in FOLDS.items()}
    sharpes = [float(item["sharpe"]) for item in folds.values()]
    result = {
        "evidence_class": "visible_development_only",
        "seed": SEED,
        "cost_per_turnover": COST_PER_TURNOVER,
        "mean_sharpe": float(np.mean(sharpes)),
        "min_sharpe": float(np.min(sharpes)),
        "folds": folds,
    }
    rendered = json.dumps(result, indent=2)
    if args.out:
        pathlib.Path(args.out).write_text(rendered + "\n", encoding="utf8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
