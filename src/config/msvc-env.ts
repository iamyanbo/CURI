/**
 * Developer-toolchain environment for spawned build tools on Windows.
 *
 * `nvcc` is a driver: it needs a host C++ compiler, which on Windows is MSVC's
 * `cl.exe`. MSVC is not on the machine-wide PATH by design — Visual Studio
 * expects `vcvarsall.bat` to put it there for the current shell. The protected
 * evaluator gets away with this because it compiles through PyTorch, which runs
 * that discovery itself.
 *
 * The executor had no such help, so every direct `nvcc` call it made failed
 * with "Cannot find compiler 'cl.exe' in PATH". The executor could therefore
 * never compile-check its own kernel and wrote CUDA blind until the protected
 * evaluator graded it. Resolving the environment once and handing it to build
 * tools gives the executor the same toolchain the evaluator ultimately uses.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Tools that drive a host compiler and therefore need the MSVC environment. */
const BUILD_TOOLS = new Set(["nvcc", "cmake", "make", "cl"]);

/** Environment variables worth importing from a developer command prompt. */
const INTERESTING = /^(PATH|INCLUDE|LIB|LIBPATH|VCINSTALLDIR|VCToolsInstallDir|VCToolsVersion|WindowsSdkDir|WindowsSdkVerBinPath|WindowsSDKVersion|UCRTVersion|UniversalCRTSdkDir|VSINSTALLDIR)$/i;

let cached: Record<string, string> | null | undefined;

function vswherePath(): string | null {
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter(Boolean) as string[];
  for (const root of roots) {
    const candidate = join(root, "Microsoft Visual Studio", "Installer", "vswhere.exe");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function vcvarsallPath(): string | null {
  const vswhere = vswherePath();
  if (!vswhere) return null;
  const installPath = execFileSync(vswhere, [
    "-latest", "-products", "*",
    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property", "installationPath",
  ], { encoding: "utf8", timeout: 30_000, windowsHide: true }).trim().split(/\r?\n/)[0];
  if (!installPath) return null;
  const vcvarsall = join(installPath, "VC", "Auxiliary", "Build", "vcvarsall.bat");
  return existsSync(vcvarsall) ? vcvarsall : null;
}

/**
 * Run vcvarsall in a throwaway shell and keep the variables it sets. Discovery
 * costs a second or so, so it happens at most once per worker process and only
 * when a build tool is actually launched. A machine without Visual Studio
 * caches `null` and never pays the cost again.
 */
export function msvcEnv(): Record<string, string> | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform !== "win32") return cached;
  try {
    const vcvarsall = vcvarsallPath();
    if (!vcvarsall) return cached;
    const arch = process.env.AR_MSVC_ARCH ?? "x64";
    // execSync adds the outer quoting that `cmd /d /s /c` then strips, so the
    // command passed here quotes only the batch path itself. Supplying that
    // outer pair as well, or handing the string to execFileSync as an argv
    // element, makes cmd report "The network path was not found".
    const output = execSync(`"${vcvarsall}" ${arch} >NUL && set`, {
      encoding: "utf8", timeout: 120_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      // vcvarsall chatters on stderr about its own internals. That is discovery
      // noise, not worker output, and must not reach the campaign's logs.
      stdio: ["ignore", "pipe", "ignore"],
    });
    const resolved: Record<string, string> = {};
    for (const line of output.split(/\r?\n/)) {
      const split = line.indexOf("=");
      if (split <= 0) continue;
      const name = line.slice(0, split);
      if (INTERESTING.test(name)) resolved[name] = line.slice(split + 1);
    }
    // A developer prompt that yielded no PATH is not a usable toolchain.
    cached = resolved.PATH || resolved.Path ? resolved : null;
  } catch {
    // Discovery is best effort. A missing toolchain must surface as the
    // compiler's own error to the model, never as a worker crash.
    cached = null;
  }
  return cached;
}

/** True when this executable drives a host compiler. */
export function needsBuildEnv(executable: string): boolean {
  return BUILD_TOOLS.has(executable.toLowerCase().replace(/\.exe$/, ""));
}

/**
 * The environment to spawn `executable` with: the worker's own environment,
 * plus the MSVC variables when the tool needs them and the machine has them.
 */
export function environmentFor(executable: string): NodeJS.ProcessEnv {
  if (!needsBuildEnv(executable)) return process.env;
  const msvc = msvcEnv();
  return msvc ? { ...process.env, ...msvc } : process.env;
}

/** Test seam: forget the cached discovery. */
export function resetMsvcEnvCache(): void { cached = undefined; }
