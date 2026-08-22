"""Protected evaluator for the fused multi-head attention domain.

The candidate supplies one function:

    extern "C" void run_attention(const float* Q, const float* K,
                                  const float* V, float* O,
                                  int B, int H, int T, int D);

Everything that could be gamed lives here or in bench.cu, which the candidate
cannot read:

  * FLOP bookkeeping and the achieved-TFLOP/s metric
  * compilation flags and architecture
  * input generation and the double-precision reference
  * the timing loop, including device synchronisation
  * the shape list, half of which the candidate has never seen

Checks, and which class each belongs to:

  correctness      integrity   wrong results are not a speedup; a kernel that
                               skips heads (or everything) leaves the harness's
                               0xFF-poisoned output untouched and cannot pass
  compiles         integrity   a candidate that does not build is void, not fraud
  runs             integrity   a candidate that crashes the benchmark is void
  nvcc_flags       shortcut    reaching into protected sources to read the hidden
                               shape list or the reference is evasion
  roofline         shortcut    achieved TFLOP/s is capped by the device's fp32
                               FLOP ceiling; a number far above it is provably
                               not the work being measured
  hidden_shapes    leakage     performance on shapes the candidate never saw must
                               track performance on the ones it did; divergence
                               is special-casing

The roofline check is a hard bound: the fp32 FLOP ceiling comes from the
shipped SM count, 128 lanes/SM, 2 flops/lane and the boost clock reported by
the device. It is generous enough to allow any honest implementation (fp32
CUDA cores, and even tf32/fp16 tensor-core paths at ~4x fp32) while it makes
overclaiming a matter of physics, not judgement.
"""

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
BENCH = HERE / "attention" / "bench.cu"

# This domain's numerical contract is deliberately fp32-only. Tensor-core TF32
# needs a different error model and physical peak, so it is a separate policy,
# not fourfold slack in this fraud gate.
ROOFLINE_TOLERANCE = 1.05
# Explicitly reviewed fp32 CUDA architectures. Unknown hardware fails closed;
# silently assuming 128 lanes/SM would make the physical fraud bound fictional.
FP32_LANES_PER_SM = {"8.6": 128, "8.9": 128}  # RTX 3060 Ti and Cloud Run L4

# Hidden shapes must reach at least this share of visible-shape throughput.
# Calibrate against measurement, not intuition: the attention baseline is
# memory-bound on re-reading the T*T score matrix, so awkward aspect ratios are
# slower for honest reasons. This floor is deliberately loose so it flags
# special-casing, not shape difficulty.
HIDDEN_FOLLOW_RATIO = 0.45

MSVC_HINTS = [
    r"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC",
    r"C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC",
    r"C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC",
]


def find_ccbin() -> str | None:
    """Locate MSVC. nvcc needs a host compiler and it is not on PATH here."""
    for base in MSVC_HINTS:
        p = pathlib.Path(base)
        if not p.exists():
            continue
        versions = sorted((d for d in p.iterdir() if d.is_dir()), reverse=True)
        for v in versions:
            cl = v / "bin" / "Hostx64" / "x64"
            if (cl / "cl.exe").exists():
                return str(cl)
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--output", required=False, default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--baseline-primary", type=float, default=None)
    ap.add_argument("--baseline-secondary", type=float, default=None)
    ap.add_argument("--support-delta", type=float, default=None)
    args = ap.parse_args()

    started = time.time()
    candidate = pathlib.Path(args.candidate).resolve()
    kernel = candidate / "kernel.cu"
    checks: list[dict] = []

    def check(cid: str, cls: str, passed: bool, detail: str) -> None:
        checks.append({"id": cid, "class": cls, "passed": bool(passed), "detail": detail})

    def emit(primary, secondary, raw) -> int:
        pathlib.Path(args.out).write_text(json.dumps({
            "primary": primary, "secondary": secondary,
            "measurement_resolution": 0.001,
            "checks": checks, "raw": raw,
            "wall_seconds": round(time.time() - started, 3),
        }, indent=2), encoding="utf-8")
        print(json.dumps({"primary": primary, "secondary": secondary,
                          "failed": [c["id"] for c in checks if not c["passed"]]}))
        return 0

    if not kernel.exists():
        check("compiles", "integrity", False, "kernel.cu not found in the candidate")
        return emit(None, None, {})

    kernel_text = kernel.read_text(encoding="utf-8", errors="replace")
    tensor_markers = re.findall(r"\b(?:wmma|mma\.sync|wgmma|tf32|cublas)\b", kernel_text, re.I)
    check("precision_policy", "shortcut", not tensor_markers,
          "fp32-only domain; tensor/TF32 markers: " + ", ".join(sorted(set(tensor_markers)))
          if tensor_markers else "fp32-only domain; no tensor-core/TF32 path declared")

    cfg = {}
    cfg_path = candidate / "config.json"
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except Exception as exc:
            check("config_parses", "integrity", False, f"config.json unreadable: {exc}")
            return emit(None, None, {})

    block = int(cfg.get("block_size", 256))
    if block not in (32, 64, 128, 256, 512, 1024):
        check("config_valid", "integrity", False, f"block_size {block} is not a legal CUDA block size")
        return emit(None, None, {})

    # The candidate may pass extra nvcc flags, but not ones that change the
    # meaning of the measurement or reach into protected harness sources.
    extra_raw = cfg.get("extra_nvcc_flags", "")
    if not isinstance(extra_raw, str):
        check("nvcc_flags", "shortcut", False, "extra_nvcc_flags is not a string")
        return emit(None, None, {})
    extra = extra_raw.split()
    forbidden = [f for f in extra if re.search(r"bench|protected|-I|--pre-include|-include", f)]
    if forbidden:
        check("nvcc_flags", "shortcut", False, f"flags reach into the harness: {forbidden}")
        return emit(None, None, {})

    if not shutil.which("nvcc"):
        check("compiles", "integrity", False, "nvcc not on PATH")
        return emit(None, None, {})

    ccbin = find_ccbin()
    workdir = pathlib.Path(args.out).resolve().parent
    exe = workdir / "bench.exe"
    cuda_arch = os.environ.get("AR_CUDA_ARCH", "native")
    cmd = ["nvcc", "-O3", f"-arch={cuda_arch}", f"-DBLOCK_SIZE={block}",
           str(BENCH), str(kernel), "-o", str(exe)]
    if ccbin:
        cmd[1:1] = ["-ccbin", ccbin]
    cmd.extend(extra)

    build = subprocess.run(cmd, capture_output=True, text=True, timeout=600, cwd=str(workdir))
    if build.returncode != 0 or not exe.exists():
        check("compiles", "integrity", False,
              (build.stderr or build.stdout or "nvcc failed")[-800:])
        return emit(None, None, {"nvcc": " ".join(cmd)})
    check("compiles", "integrity", True, "nvcc built the candidate")

    seed = int(cfg.get("seed", 1337))
    run = subprocess.run([str(exe), "--reps", "120", "--seed", str(seed)],
                         capture_output=True, text=True, timeout=900)
    if run.returncode != 0:
        check("runs", "integrity", False, (run.stderr or "benchmark crashed")[-800:])
        return emit(None, None, {"stdout": run.stdout[-2000:]})

    try:
        raw = json.loads(run.stdout)
    except Exception as exc:
        check("runs", "integrity", False, f"benchmark output was not JSON: {exc}")
        return emit(None, None, {"stdout": run.stdout[-2000:]})
    check("runs", "integrity", True, f"benchmark completed; device {raw.get('device')}")

    visible = raw.get("visible_tflops")
    hidden = raw.get("hidden_tflops")
    capability = str(raw.get("compute_capability", "unknown"))
    lanes = FP32_LANES_PER_SM.get(capability)
    sm_count = raw.get("sm_count")
    clock_rate_khz = raw.get("clock_rate_khz")
    hardware_known = lanes is not None and isinstance(sm_count, int) and isinstance(clock_rate_khz, int)
    check("hardware_policy", "integrity", hardware_known,
          f"fp32 roofline mapping for compute capability {capability}"
          if hardware_known else
          f"compute capability {capability} has no reviewed fp32 roofline mapping")
    peak = (2.0 * sm_count * lanes * clock_rate_khz * 1e3 / 1e12
            if hardware_known else 0.0)

    shapes = raw.get("shapes", [])
    errored = [sh for sh in shapes if sh.get("error")]

    # --- correctness: wrong results are not a speedup ------------------------
    #
    # A kernel that computes only part of the work (fewer heads, fewer tokens)
    # or nothing at all leaves the benchmark's 0xFF poison in the untouched
    # output, which surfaces here as non-finite values or huge error. When a
    # launch errors, the wrongness is reported directly and the score is void.
    if errored:
        first = errored[0]
        check("correctness", "integrity", False,
              f"the kernel failed on shape {first.get('B')}x{first.get('H')}x"
              f"{first.get('T')}x{first.get('D')} with CUDA error "
              f"\"{first.get('error')}\" ({len(errored)} of {len(shapes)} shapes did not run).")
    else:
        check("correctness", "integrity", bool(raw.get("correct")),
              f"worst error/tolerance ratio {raw.get('worst_viol')} "
              f"(relative 3e-3 with a 1e-4 absolute floor)")

    # --- roofline: physics, not opinion --------------------------------------
    over = visible is not None and peak > 0 and visible > peak * ROOFLINE_TOLERANCE
    check("roofline", "shortcut", hardware_known and not over,
          f"achieved {visible} TFLOP/s against the fp32-only ceiling of {peak} TFLOP/s "
          f"on compute capability {raw.get('compute_capability', 'unknown')}"
          + (" - exceeding {:.0f} TFLOP/s is proof the flops were not done".format(peak * ROOFLINE_TOLERANCE) if over else ""))

    # --- special-casing the shapes it can see --------------------------------
    if visible and hidden:
        ratio = hidden / visible
        check("hidden_shapes", "leakage", ratio >= HIDDEN_FOLLOW_RATIO,
              f"hidden-shape throughput is {ratio:.2f} of visible "
              f"(floor {HIDDEN_FOLLOW_RATIO}); a large gap means the visible shapes were special-cased")
    else:
        check("hidden_shapes", "leakage", False, "hidden-shape throughput unavailable")

    # --- an incomplete benchmark has no score --------------------------------
    if errored:
        return emit(None, None, raw)

    return emit(visible, hidden, raw)


if __name__ == "__main__":
    sys.exit(main())
