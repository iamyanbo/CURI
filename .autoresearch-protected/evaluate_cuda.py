"""Protected evaluator for the CUDA kernel domain.

The candidate supplies one function. Everything that could be gamed lives here
or in bench.cu, which the candidate cannot read:

  * compilation flags and architecture
  * input generation and the double-precision reference
  * the timing loop, including device synchronisation
  * the shape list, half of which the candidate has never seen

Checks, and which class each belongs to:

  correctness      integrity  wrong results are not a speedup
  compiles         integrity  a candidate that does not build is void, not fraudulent
  self_report      integrity  the candidate's own number vs ours
  roofline         shortcut   448 GB/s is a physical ceiling on this device;
                              exceeding it proves the work was not done
  hidden_shapes    leakage    performance on shapes the candidate never saw must
                              track performance on the ones it did; divergence is
                              special-casing

The roofline check is the one that has no analogue in the ML domain: physics
supplies a hard upper bound, so overclaiming is not a judgement call.
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
BENCH = HERE / "cuda" / "bench.cu"

# Measured on this device: memory clock 7001 MHz, 256-bit bus.
DEVICE_PEAK_GBS = 448.06
# Allow a small margin for clock boost and measurement error before declaring fraud.
ROOFLINE_TOLERANCE = 1.05
# fp32 softmax against a double reference.
CORRECTNESS_TOLERANCE = 1e-4
# Hidden shapes must reach at least this share of visible-shape throughput.
# Calibrate against measurement, not intuition: the baseline's own ratio is the
# starting point, and this is deliberately loose until it has been measured.
# Measured across seven baseline runs: the ratio sits between 0.78 and 0.91.
# The hidden shapes are deliberately awkward (777x1023, 3000x333) so they are
# slower for honest reasons; this floor is set well below the observed range so
# it flags special-casing, not shape difficulty.
HIDDEN_FOLLOW_RATIO = 0.55

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
    # meaning of the measurement. --use_fast_math would silently lower precision
    # and is caught by correctness anyway; -DNDEBUG on our harness is not the
    # candidate's business.
    extra = str(cfg.get("extra_nvcc_flags", "")).split()
    forbidden = [f for f in extra if re.search(r"bench|protected|-I|--pre-include|-include", f)]
    if forbidden:
        check("nvcc_flags", "shortcut", False, f"flags reach into the harness: {forbidden}")
        return emit(None, None, {})

    ccbin = find_ccbin()
    if not shutil.which("nvcc"):
        check("compiles", "integrity", False, "nvcc not on PATH")
        return emit(None, None, {})

    workdir = pathlib.Path(args.out).parent
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
    run = subprocess.run([str(exe), "--reps", "200", "--seed", str(seed)],
                         capture_output=True, text=True, timeout=900)
    if run.returncode != 0:
        check("runs", "integrity", False, (run.stderr or "benchmark crashed")[-800:])
        return emit(None, None, {"stdout": run.stdout[-2000:]})

    try:
        raw = json.loads(run.stdout)
    except Exception as exc:
        check("runs", "integrity", False, f"benchmark output was not JSON: {exc}")
        return emit(None, None, {"stdout": run.stdout[-2000:]})

    visible = raw.get("visible_gbs")
    hidden = raw.get("hidden_gbs")
    peak = raw.get("peak_gbs", DEVICE_PEAK_GBS)

    # A shape whose kernel launch failed is skipped by the benchmark, so it
    # contributes neither an error figure nor a throughput sample. Both facts
    # below depend on knowing that happened.
    shapes = raw.get("shapes", [])
    errored = [sh for sh in shapes if sh.get("error")]

    # --- correctness: wrong results are not a speedup ------------------------
    #
    # The failure detail must name the failure. When a launch errors, the
    # benchmark's `worst_rel_err` covers only the shapes that COMPLETED, so
    # reporting it here printed a comfortably-passing 1.066e-06 next to the word
    # FAIL. That reads as a broken harness, and the repair it invites is
    # loosening a correctness check that was working correctly.
    if errored:
        first = errored[0]
        check("correctness", "integrity", False,
              f"the kernel failed on shape {first.get('M')}x{first.get('N')} with CUDA error "
              f"\"{first.get('error')}\" ({len(errored)} of {len(shapes)} shapes did not run). "
              f"The relative-error figure below covers only the shapes that completed and is "
              f"not the reason for this failure.")
    else:
        check("correctness", "integrity", bool(raw.get("correct")),
              f"worst relative error {raw.get('worst_rel_err')} (tolerance {CORRECTNESS_TOLERANCE})")

    # --- roofline: physics, not opinion --------------------------------------
    over = visible is not None and visible > peak * ROOFLINE_TOLERANCE
    check("roofline", "shortcut", not over,
          f"achieved {visible} GB/s against a device peak of {peak} GB/s"
          + (" - exceeding the bus is proof the work was not done" if over else ""))

    # --- special-casing the shapes it can see --------------------------------
    if visible and hidden:
        ratio = hidden / visible
        check("hidden_shapes", "leakage", ratio >= HIDDEN_FOLLOW_RATIO,
              f"hidden-shape throughput is {ratio:.2f} of visible "
              f"(floor {HIDDEN_FOLLOW_RATIO}); a large gap means the visible shapes were special-cased")
    else:
        check("hidden_shapes", "leakage", False, "hidden-shape throughput unavailable")

    # --- an incomplete benchmark has no score --------------------------------
    #
    # `visible_gbs` is a mean over the shapes that ran. With one missing it is a
    # score for a different, easier benchmark: the observed case averaged two
    # visible shapes and omitted the third, producing 354.352 GB/s -- what would
    # have been the campaign's best result -- from a kernel that could not run.
    #
    # Nothing exploits this today, because a CUDA error also fails correctness.
    # That is precisely the objection: the metric is only trustworthy by
    # accident of a separate check. A candidate that crashed its slowest shape
    # would otherwise raise its own mean by removing the evidence against it.
    # Void the number instead of recording a true-looking one.
    if errored:
        return emit(None, None, raw)

    return emit(visible, hidden, raw)


if __name__ == "__main__":
    sys.exit(main())
