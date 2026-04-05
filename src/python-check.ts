import { spawn, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { BrowserWindow } from "electron";
import { inspectPythonRuntime } from "./python-runtime";
import {
  installerScriptPath,
  managedLogsDir,
  managedPythonPath,
  managedRepoRoot,
  managedPackageDir,
  managedRuntimeRoot,
} from "./paths";
import { createLogger } from "./logger";
import type { EnvCheckResult, EnvInstallProgress } from "./ipc-types";

const log = createLogger("python-check");

const MUNAJJAM_REPO_URL = "https://github.com/Itqan-community/Munajjam.git";
const MUNAJJAM_REPO_REF = "main";
const PYTHON_VERSION = "3.12";

export interface InstallerInvocation {
  command: string;
  args: string[];
}

export function resolveInstallerInvocation(
  platform: NodeJS.Platform,
  scriptPath: string,
  rootPath: string,
): InstallerInvocation | null {
  const posixArgs = [
    "--root",
    rootPath,
    "--repo-url",
    MUNAJJAM_REPO_URL,
    "--repo-ref",
    MUNAJJAM_REPO_REF,
    "--python-version",
    PYTHON_VERSION,
  ];

  if (platform === "darwin") {
    return {
      command: "bash",
      args: [scriptPath, ...posixArgs],
    };
  }

  if (platform === "win32") {
    const windowsArgs = [
      "-Root",
      rootPath,
      "-RepoUrl",
      MUNAJJAM_REPO_URL,
      "-RepoRef",
      MUNAJJAM_REPO_REF,
      "-PythonVersion",
      PYTHON_VERSION,
    ];

    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        ...windowsArgs,
      ],
    };
  }

  return null;
}

/**
 * If a managed runtime is already installed (repo cloned + venv created),
 * pull the latest code from the repo and reinstall the package so the user
 * always has the most recent version without needing to click "Install" again.
 *
 * This runs silently during the environment check.  Failures are logged but
 * never block the check itself — a stale‑but‑working runtime is better than
 * a broken startup.
 */
export async function updateManagedRuntime(): Promise<void> {
  const repoDir = managedRepoRoot();
  const packageDir = managedPackageDir();
  const pythonBin = managedPythonPath();

  // Only attempt an update when a full managed install already exists.
  if (
    !fs.existsSync(path.join(repoDir, ".git")) ||
    !fs.existsSync(pythonBin)
  ) {
    log.debug("Managed runtime not fully installed — skipping auto-update");
    return;
  }

  log.info("Updating managed Munajjam runtime...");

  try {
    // 1. Pull latest code
    execFileSync("git", ["-C", repoDir, "fetch", "origin", MUNAJJAM_REPO_REF, "--depth", "1"], {
      timeout: 30_000,
      stdio: "pipe",
    });
    execFileSync("git", ["-C", repoDir, "checkout", MUNAJJAM_REPO_REF], {
      timeout: 10_000,
      stdio: "pipe",
    });
    execFileSync("git", ["-C", repoDir, "reset", "--hard", `origin/${MUNAJJAM_REPO_REF}`], {
      timeout: 10_000,
      stdio: "pipe",
    });
    log.info("Git pull completed");
  } catch (err) {
    log.warn("Git pull failed during auto-update (continuing with existing code)", {
      error: String(err),
    });
    // Don't abort — the existing code may still work fine.
  }

  try {
    // 2. Reinstall the package
    execFileSync(pythonBin, ["-m", "pip", "install", "--quiet", `${packageDir}[faster-whisper]`], {
      timeout: 120_000,
      stdio: "pipe",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    log.info("pip install completed");
  } catch (err) {
    log.warn("pip install failed during auto-update", { error: String(err) });
  }
}

export async function checkEnvironment(): Promise<EnvCheckResult> {
  log.info("Starting environment check", { platform: process.platform });

  // Silently update the managed runtime before inspecting it
  await updateManagedRuntime();

  const runtime = await inspectPythonRuntime();

  const result: EnvCheckResult = {
    python: !!runtime.command,
    pythonVersion: runtime.pythonVersion,
    pythonPath: runtime.pythonPath,
    pip: runtime.pipAvailable,
    ffmpeg: runtime.ffmpegAvailable,
    ffmpegPath: runtime.ffmpegPath,
    munajjam: runtime.munajjamAvailable,
    munajjamVersion: runtime.munajjamVersion,
    platform: process.platform,
    platformSupported: runtime.platformSupported,
    packageManagerAvailable: runtime.packageManagerAvailable,
    packageManagerName: runtime.packageManagerName,
    managedInstallPath: runtime.managedInstallPath,
    localPackageAvailable: runtime.localPackageAvailable,
    localPackagePath: runtime.localPackagePath,
  };

  log.info("Environment check completed", {
    python: result.python,
    pythonVersion: result.pythonVersion,
    ffmpeg: result.ffmpeg,
    munajjam: result.munajjam,
    munajjamVersion: result.munajjamVersion,
  });

  return result;
}

function broadcastInstallProgress(progress: EnvInstallProgress) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("env:installProgress", progress);
  }
}

export async function installRuntime(): Promise<number> {
  const scriptPath = installerScriptPath();
  const rootPath = managedRuntimeRoot();
  const invocation = resolveInstallerInvocation(process.platform, scriptPath, rootPath);

  log.info("installRuntime called", { scriptPath, rootPath, platform: process.platform });

  if (!invocation) {
    const msg = `Automated runtime installation is not supported on ${process.platform}`;
    log.error(msg);
    broadcastInstallProgress({ type: "stderr", data: msg + "\n" });
    broadcastInstallProgress({ type: "exit", data: "", exitCode: 1 });
    return 1;
  }

  if (!fs.existsSync(scriptPath)) {
    const msg = `Installer script not found: ${scriptPath}`;
    log.error(msg);
    broadcastInstallProgress({ type: "stderr", data: msg + "\n" });
    broadcastInstallProgress({ type: "exit", data: "", exitCode: 1 });
    return 1;
  }

  fs.mkdirSync(rootPath, { recursive: true });
  fs.mkdirSync(managedLogsDir(), { recursive: true });

  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      log.debug("installer stdout", text.trimEnd());
      broadcastInstallProgress({ type: "stdout", data: text });
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      log.warn("installer stderr", text.trimEnd());
      broadcastInstallProgress({ type: "stderr", data: text });
    });

    child.on("error", (error) => {
      log.error("Installer failed to start", { error: String(error) });
      broadcastInstallProgress({
        type: "stderr",
        data: `Installer failed to start: ${String(error)}\n`,
      });
      broadcastInstallProgress({ type: "exit", data: "", exitCode: 1 });
      resolve(1);
    });

    child.on("close", (code) => {
      const exitCode = code ?? 1;
      log.info("Installer exited", { exitCode });
      broadcastInstallProgress({ type: "exit", data: "", exitCode });
      resolve(exitCode);
    });
  });
}
