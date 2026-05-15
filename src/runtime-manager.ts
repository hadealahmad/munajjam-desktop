import { app } from "electron";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { 
  managedRuntimeRoot, 
  managedPythonPath, 
  managedFfmpegPathFile, 
  managedVenvDir,
  managedRepoRoot
} from "./paths";
import { createLogger } from "./logger";

const log = createLogger("runtime-manager");

import { RuntimeStage, RuntimeStatus } from "./ipc-types";
export { RuntimeStage, RuntimeStatus };

export class RuntimeManager {
  private status: RuntimeStatus = {
    stage: "idle",
    progress: 0,
    message: "Ready to start",
  };

  private onStatusUpdate: (status: RuntimeStatus) => void;

  constructor(onStatusUpdate: (status: RuntimeStatus) => void) {
    this.onStatusUpdate = onStatusUpdate;
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }

  private updateStatus(updates: Partial<RuntimeStatus>) {
    this.status = { ...this.status, ...updates };
    this.onStatusUpdate(this.status);
    log.info("Status update", this.status);
  }

  private getBinaryLinks() {
    const { platform, arch } = process;
    
    // Default links (can be overridden by user provided links)
    const links: { python: string; ffmpeg: string } = {
      python: "",
      ffmpeg: "",
    };

    if (platform === "linux" && arch === "x64") {
      links.python = "https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-3.12.3+20240415-x86_64-unknown-linux-gnu-install_only.tar.gz";
      links.ffmpeg = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz";
    } else if (platform === "win32" && arch === "x64") {
      links.python = "https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-3.12.3+20240415-x86_64-pc-windows-msvc-shared-install_only.tar.gz";
      links.ffmpeg = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
    } else if (platform === "darwin") {
      links.python = arch === "arm64" 
        ? "https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-3.12.3+20240415-aarch64-apple-darwin-install_only.tar.gz"
        : "https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-3.12.3+20240415-x86_64-apple-darwin-install_only.tar.gz";
      links.ffmpeg = "https://evermeet.cx/ffmpeg/get/zip"; // Placeholder for macOS ffmpeg
    }

    return links;
  }

  private async downloadFile(url: string, dest: string, stage: RuntimeStage) {
    this.updateStatus({ stage, progress: 0, message: `Downloading ${path.basename(url)}...` });
    
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
    if (!response.body) throw new Error("Response body is empty");

    const total = parseInt(response.headers.get("content-length") || "0", 10);
    let loaded = 0;
    
    const reader = response.body.getReader();
    const stream = fs.createWriteStream(dest);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stream.write(value);
      loaded += value.length;
      if (total > 0) {
        const progress = Math.round((loaded / total) * 100);
        this.updateStatus({ progress });
      }
    }
    stream.end();
    return new Promise((resolve, reject) => {
      stream.on("finish", () => resolve(undefined));
      stream.on("error", reject);
    });
  }


  private async runCommand(command: string, args: string[], stage: RuntimeStage, message: string): Promise<void> {
    this.updateStatus({ stage, progress: 0, message });
    return new Promise((resolve, reject) => {
      log.info(`Running command: ${command} ${args.join(" ")}`);
      const child = spawn(command, args, { shell: true });
      
      child.stdout?.on("data", (data) => {
        const line = data.toString().trim();
        if (line) this.updateStatus({ message: line });
      });

      child.stderr?.on("data", (data) => {
        const line = data.toString().trim();
        if (line) log.warn(`${command} stderr: ${line}`);
      });

      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} failed with code ${code}`));
      });
      child.on("error", reject);
    });
  }

  private async extractArchive(archivePath: string, destDir: string) {
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    
    const isWin = process.platform === "win32";
    const isZip = archivePath.endsWith(".zip");
    
    let command = "";
    let args: string[] = [];

    if (isZip && isWin) {
      command = "powershell.exe";
      args = ["-Command", `Expand-Archive -Path "${archivePath}" -DestinationPath "${destDir}" -Force`];
    } else {
      // Use tar for everything else (tar.gz, tar.xz)
      command = "tar";
      args = ["-xf", archivePath, "-C", destDir];
    }

    log.info("Extracting archive", { command, args, archivePath, destDir });
    
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, args);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Extraction failed with code ${code}`));
      });
      child.on("error", reject);
    });
  }

  private async createVenv(pythonBin: string, venvDir: string) {
    log.info("Creating virtual environment", { pythonBin, venvDir });
    
    const isWin = process.platform === "win32";
    const args = ["-m", "venv"];
    if (isWin) args.push("--copies");
    args.push(venvDir);

    return new Promise<void>((resolve, reject) => {
      let stderr = "";
      const child = spawn(pythonBin, args, {
        cwd: path.dirname(pythonBin)
      });

      child.stderr.on("data", (data) => {
        const msg = data.toString();
        stderr += msg;
        log.warn("venv stderr", msg);
      });

      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Venv creation failed with code ${code}. Error: ${stderr}`));
      });
      child.on("error", (err) => {
        reject(new Error(`Failed to start venv creation: ${err.message}. ${stderr}`));
      });
    });
  }

  private async installRequirements(venvPython: string, repoDir: string) {
    log.info("Installing requirements", { venvPython, repoDir });
    
    let extra = "faster-whisper";
    // Future: Detect AMD GPU
    
    // Install from local directory
    const args = ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel", `${repoDir}[${extra}]`];
    
    return new Promise<void>((resolve, reject) => {
      let stderr = "";
      const child = spawn(venvPython, args, {
        env: { ...process.env, PYTHONUNBUFFERED: "1" }
      });
      
      child.stdout.on("data", (data) => {
        const line = data.toString().trim();
        if (line) this.updateStatus({ message: line });
      });

      child.stderr.on("data", (data) => {
        const line = data.toString().trim();
        if (line) {
          stderr += line + "\n";
          log.warn("pip stderr", line);
          this.updateStatus({ message: line });
        }
      });

      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Pip install failed with code ${code}. Error: ${stderr}`));
      });
      child.on("error", (err) => {
        reject(new Error(`Failed to start pip install: ${err.message}. ${stderr}`));
      });
    });
  }

  private async findExecutable(dir: string, name: string): Promise<string | null> {
    const isWin = process.platform === "win32";
    const fullName = isWin ? `${name}.exe` : name;

    const search = async (currentDir: string): Promise<string | null> => {
      const files = fs.readdirSync(currentDir);
      for (const file of files) {
        const fullPath = path.join(currentDir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          const found = await search(fullPath);
          if (found) return found;
        } else if (file === fullName) {
          // On non-windows, make sure it's executable
          if (!isWin) {
            try {
              fs.accessSync(fullPath, fs.constants.X_OK);
            } catch {
              log.info(`Making binary executable: ${fullPath}`);
              try {
                fs.chmodSync(fullPath, 0o755);
              } catch (e) {
                log.warn(`Failed to chmod binary: ${fullPath}`, e);
                continue;
              }
            }
          }
          return fullPath;
        }
      }
      return null;
    };

    return search(dir);
  }

  private getSitePackagesPath(venvDir: string): string | null {
    const isWin = process.platform === "win32";
    if (isWin) {
      const p = path.join(venvDir, "Lib", "site-packages");
      return fs.existsSync(p) ? p : null;
    }
    
    const libDir = path.join(venvDir, "lib");
    if (!fs.existsSync(libDir)) return null;
    
    const pyDirs = fs.readdirSync(libDir).filter(d => d.startsWith("python"));
    for (const pyDir of pyDirs) {
      const p = path.join(libDir, pyDir, "site-packages");
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  async setup(): Promise<void> {
    try {
      const root = managedRuntimeRoot();
      if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

      // 0. Optional: External dependencies (winget on Windows)
      let standalonePython: string | null = null;
      let ffmpegBinPath: string | null = null;

      if (process.platform === "win32") {
        const hasWinget = await new Promise<boolean>((resolve) => {
          const child = spawn("winget", ["--version"]);
          child.on("close", (code) => resolve(code === 0));
          child.on("error", () => resolve(false));
        });

        if (hasWinget) {
          try {
            await this.runCommand(
              "winget", 
              ["install", "--exact", "--id", "Python.Python.3.12", "--accept-package-agreements", "--accept-source-agreements"], 
              "installing_dependencies", 
              "Installing Python 3.12 via winget..."
            );
            await this.runCommand(
              "winget", 
              ["install", "--exact", "--id", "Gyan.FFmpeg", "--accept-package-agreements", "--accept-source-agreements"], 
              "installing_dependencies", 
              "Installing FFmpeg via winget..."
            );
            
            // Try to find them after winget install in common locations
            const wingetPythonPath = path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python312");
            const wingetPackagePath = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
            
            standalonePython = (await this.findExecutable(wingetPythonPath, "python.exe")) || 
                               (await this.findExecutable(wingetPackagePath, "python.exe"));
            
            if (!standalonePython) {
              standalonePython = await this.findExecutable(process.env.LOCALAPPDATA || "", "python.exe"); 
            }
            // Note: winget usually puts things in PATH, but finding them explicitly is safer
            // or we just trust that 'python' or 'py -3.12' will work now.
            // For now, we'll still prefer the standalone download if we can't find the winget one easily,
            // or just use 'python' if it works.
          } catch (e) {
            log.warn("Winget installation failed, falling back to standalone download", e);
          }
        }
      }

      const links = this.getBinaryLinks();
      if (!links.python || !links.ffmpeg) {
        throw new Error(`Platform ${process.platform} ${process.arch} is not yet supported for automated setup.`);
      }

      // 1. Python
      const pythonDir = path.join(root, "python_standalone");
      if (!standalonePython && !fs.existsSync(pythonDir)) {
        const pythonArchive = path.join(root, "python.tar.gz");
        await this.downloadFile(links.python, pythonArchive, "downloading_python");
        
        this.updateStatus({ stage: "extracting_python", progress: 0, message: "Extracting Python..." });
        await this.extractArchive(pythonArchive, pythonDir);
        fs.unlinkSync(pythonArchive);
      }
      
      if (!standalonePython) {
        standalonePython = await this.findExecutable(pythonDir, "python3") || await this.findExecutable(pythonDir, "python");
      }
      
      if (!standalonePython) {
        // Final fallback: try system python if winget/standalone failed
        standalonePython = await new Promise<string | null>((resolve) => {
          const child = spawn("python", ["-c", "import sys; print(sys.executable)"]);
          let output = "";
          child.stdout.on("data", (data) => output += data.toString());
          child.on("close", (code) => resolve(code === 0 ? output.trim() : null));
          child.on("error", () => resolve(null));
        });
      }

      if (!standalonePython) throw new Error("Could not find Python executable");

      // 2. FFmpeg
      const ffmpegDir = path.join(root, "ffmpeg_standalone");
      const ffmpegPathFile = managedFfmpegPathFile();
      if (!fs.existsSync(ffmpegPathFile)) {
        // Try to find system ffmpeg first (e.g. from winget)
        ffmpegBinPath = await new Promise<string | null>((resolve) => {
          const locator = process.platform === "win32" ? "where" : "which";
          const child = spawn(locator, ["ffmpeg"]);
          let output = "";
          child.stdout.on("data", (data) => output += data.toString());
          child.on("close", (code) => {
            if (code === 0) {
              const lines = output.split(/\r?\n/).filter(l => l.trim().length > 0);
              resolve(lines[0]);
            } else resolve(null);
          });
          child.on("error", () => resolve(null));
        });

        if (!ffmpegBinPath) {
          const ffmpegArchive = path.join(root, "ffmpeg.archive");
          await this.downloadFile(links.ffmpeg, ffmpegArchive, "downloading_ffmpeg");
          
          this.updateStatus({ stage: "extracting_ffmpeg", progress: 0, message: "Extracting FFmpeg..." });
          await this.extractArchive(ffmpegArchive, ffmpegDir);
          
          ffmpegBinPath = await this.findExecutable(ffmpegDir, "ffmpeg");
          fs.unlinkSync(ffmpegArchive);
        }

        if (!ffmpegBinPath) throw new Error("Could not find FFmpeg executable");
        fs.writeFileSync(ffmpegPathFile, ffmpegBinPath);
      }

      // 3. Repository
      const repoDir = managedRepoRoot();
      const repoArchive = path.join(root, "repo.tar.gz");
      
      let needsRepo = !fs.existsSync(repoDir);
      if (!needsRepo) {
        const subdirs = fs.readdirSync(repoDir);
        if (!subdirs.find(d => d.startsWith("Munajjam-"))) {
          log.warn("Repository directory exists but is invalid, re-downloading...");
          fs.rmSync(repoDir, { recursive: true, force: true });
          needsRepo = true;
        }
      }

      if (needsRepo) {
        const repoUrl = "https://github.com/Itqan-community/Munajjam/archive/refs/heads/main.tar.gz";
        await this.downloadFile(repoUrl, repoArchive, "downloading_repo");
        
        this.updateStatus({ stage: "extracting_repo", progress: 0, message: "Extracting repository..." });
        await this.extractArchive(repoArchive, repoDir);
        fs.unlinkSync(repoArchive);
      }

      // 4. Venv & Requirements
      const venvDir = managedVenvDir();
      const venvPython = managedPythonPath();
      
      if (!fs.existsSync(venvPython)) {
        this.updateStatus({ stage: "creating_venv", progress: 0, message: "Creating virtual environment..." });
        await this.createVenv(standalonePython, venvDir);
      }
      
      this.updateStatus({ stage: "installing_requirements", progress: 0, message: "Installing Munajjam engine..." });
      
      // Find the actual package dir (it will be repo/Munajjam-main/munajjam)
      // or just repo/Munajjam-main
      const subdirs = fs.readdirSync(repoDir);
      const mainDirName = subdirs.find(d => d.startsWith("Munajjam-"));
      if (!mainDirName) throw new Error("Could not find repository content after extraction");
      const packagePath = path.join(repoDir, mainDirName, "munajjam"); // Adjusted for repo structure

      await this.installRequirements(venvPython, packagePath);

      // Manual fix: site-packages might miss the CSV data files
      try {
        const repoDataDir = path.join(packagePath, "munajjam", "data");
        const sitePackagesBase = this.getSitePackagesPath(venvDir);
        
        if (repoDataDir && sitePackagesBase && fs.existsSync(repoDataDir)) {
          const targetDir = path.join(sitePackagesBase, "munajjam", "data");
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }
          const dataFiles = fs.readdirSync(repoDataDir);
          for (const file of dataFiles) {
            if (file.endsWith(".csv")) {
              fs.copyFileSync(path.join(repoDataDir, file), path.join(targetDir, file));
              log.info(`Manually synced data file: ${file}`);
            }
          }
        }
      } catch (e) {
        log.warn("Failed to manually sync data files, the engine might fail to load Quran text", { error: String(e) });
      }

      this.updateStatus({ stage: "ready", progress: 100, message: "Setup complete!" });
    } catch (err) {
      this.updateStatus({ stage: "error", message: "Setup failed", error: String(err) });
      log.error("Runtime setup failed", { error: String(err) });
    }
  }

  async checkRuntime(): Promise<boolean> {
    this.updateStatus({ stage: "checking", message: "Checking environment..." });
    
    const venvPython = managedPythonPath();
    const pythonOk = fs.existsSync(venvPython);
    
    const ffmpegPathFile = managedFfmpegPathFile();
    let ffmpegOk = false;
    let ffmpegPath = "";
    if (fs.existsSync(ffmpegPathFile)) {
      ffmpegPath = fs.readFileSync(ffmpegPathFile, "utf-8").trim();
      ffmpegOk = fs.existsSync(ffmpegPath);
    }

    let munajjamOk = false;
    let dataOk = false;
    if (pythonOk) {
      munajjamOk = await new Promise<boolean>((resolve) => {
        const child = spawn(venvPython, ["-c", "import munajjam; print(munajjam.__version__)"]);
        child.on("close", (code) => resolve(code === 0));
        child.on("error", () => resolve(false));
      });

      if (munajjamOk) {
        const sitePackages = this.getSitePackagesPath(managedVenvDir());
        const dataPath = sitePackages ? path.join(sitePackages, "munajjam", "data", "quran_ayat.csv") : null;
        dataOk = !!dataPath && fs.existsSync(dataPath);
      }
    }

    if (pythonOk && ffmpegOk && munajjamOk && dataOk) {
      this.updateStatus({ stage: "ready", progress: 100, message: "Runtime is ready" });
      return true;
    }

    this.updateStatus({ stage: "idle", progress: 0, message: "Runtime setup required" });
    return false;
  }

  async getDoctorReport() {
    const venvPython = managedPythonPath();
    const ffmpegPathFile = managedFfmpegPathFile();
    const pythonDir = path.join(managedRuntimeRoot(), "python_standalone");
    const standalonePython = await this.findExecutable(pythonDir, "python3") || await this.findExecutable(pythonDir, "python");
    
    const report: any = {
      platform: process.platform,
      arch: process.arch,
      python: {
        path: venvPython,
        exists: fs.existsSync(venvPython),
        version: null,
      },
      standalonePython: {
        path: standalonePython,
        exists: !!standalonePython && fs.existsSync(standalonePython),
        version: null,
      },
      ffmpeg: {
        path: null,
        exists: false,
      },
      munajjam: {
        installed: false,
        version: null,
      }
    };

    if (report.python.exists) {
      try {
        const version = await new Promise<string>((resolve) => {
          const child = spawn(venvPython, ["--version"]);
          child.stdout.on("data", (data) => resolve(data.toString().trim()));
          child.on("close", () => resolve("unknown"));
        });
        report.python.version = version;
      } catch {}
    }

    if (report.standalonePython.exists) {
      try {
        const version = await new Promise<string>((resolve) => {
          const child = spawn(report.standalonePython.path, ["--version"]);
          child.stdout.on("data", (data) => resolve(data.toString().trim()));
          child.on("close", () => resolve("unknown"));
        });
        report.standalonePython.version = version;
      } catch {}
    }

    if (fs.existsSync(ffmpegPathFile)) {
      const p = fs.readFileSync(ffmpegPathFile, "utf-8").trim();
      report.ffmpeg.path = p;
      report.ffmpeg.exists = fs.existsSync(p);
    }

    if (report.python.exists) {
      try {
        const info = await new Promise<{installed: boolean, version: string | null}>((resolve) => {
          const child = spawn(venvPython, ["-c", "import munajjam; print(munajjam.__version__)"]);
          let output = "";
          child.stdout.on("data", (data) => output += data.toString());
          child.on("close", (code) => resolve({
            installed: code === 0,
            version: code === 0 ? output.trim() : null
          }));
        });
        report.munajjam = info;
      } catch {}
    }

    return report;
  }
}
