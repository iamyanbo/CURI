# CANDIDATE FILE - this is what you optimise.
#
# Task: turn a price history into positions. You define ONE function:
#
#     signal(prices: np.ndarray) -> np.ndarray
#
#     prices : (T, N) float array. Row t is the close on day t for N assets.
#     returns: (T, N) float array of target positions, in [-1, 1].
#              Row t is the position you want to HOLD going into day t+1.
#
# Contract, enforced outside this file:
#
#   * Row t of your output may depend ONLY on prices[:t+1]. The evaluator tests
#     this directly: it re-runs you with the future replaced by different data
#     and checks your earlier positions did not move. Any strategy that peeks -
#     shift(-1), negative indexing, a centred rolling window, sorting the whole
#     series - changes its past output and is caught. This is not a code
#     inspection you can dodge; it is a property of the function you wrote.
#
#   * The evaluator applies the one-day holding shift itself, charges 10bps per
#     unit of turnover, and computes the Sharpe. Do not try to do any of that
#     here - your own printed numbers are trace material, not the measurement.
#
#   * You are scored on a TIME WINDOW you have never seen, and separately on
#     four other held-back windows. A strategy that works in one regime and
#     nowhere else is the failure this task exists to detect.
#
# This baseline is deliberately weak: a fixed-lookback momentum rule, equally
# weighted, rebalanced daily. It trades too much, ignores volatility, and has no
# notion of regime. There is a great deal of honest room above it.

import json
import pathlib

import numpy as np

CFG = json.loads((pathlib.Path(__file__).parent / "config.json").read_text(encoding="utf8"))


def signal(prices: np.ndarray) -> np.ndarray:
    """Long assets that rose over the lookback, short those that fell."""
    lookback = int(CFG.get("lookback", 60))
    scale = float(CFG.get("position_scale", 1.0))

    prices = np.asarray(prices, dtype=float)
    T, N = prices.shape
    pos = np.zeros((T, N))

    for t in range(lookback, T):
        # Trailing window only: everything up to and including today.
        past = prices[t - lookback:t + 1]
        momentum = past[-1] / past[0] - 1.0

        # Cross-sectional: long the winners, short the losers, market-neutral.
        centred = momentum - np.mean(momentum)
        denom = np.max(np.abs(centred))
        if denom > 1e-12:
            pos[t] = np.clip(centred / denom * scale, -1.0, 1.0)

    return pos


if __name__ == "__main__":
    # A local smoke test on synthetic data, so `python strategy.py` verifies the
    # function runs and has the right shape. The real prices, the real window
    # and the real score all live in the protected evaluator.
    rng = np.random.default_rng(0)
    demo = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, (400, 12)), axis=0))
    out = signal(demo)
    assert out.shape == demo.shape, f"expected {demo.shape}, got {out.shape}"
    pathlib.Path("out").mkdir(exist_ok=True)
    np.save("out/positions.npy", out)
    print(f"ok rows={out.shape[0]} assets={out.shape[1]} mean_abs_pos={np.mean(np.abs(out)):.4f}")
