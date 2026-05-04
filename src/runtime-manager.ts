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

export type RuntimeStage = 
  | "idle"
  | "checking"
  | "downloading_python"
  | "extracting_python"
  | "downloading_ffmpeg"
  | "extracting_ffmpeg"
  | "creating_venv"
  | "downloading_repo"
  | "extracting_repo"
  | "installing_requirements"
  | "verifying"
  | "ready"
  | "doctor"
  | "error";

export interface RuntimeStatus {
  stage: RuntimeStage;
  progress: number; // 0 to 100
  message: string;
  error?: string;
}

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
      stream.on("finish", resolve);
      stream.on("error", reject);
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
    return new Promise<void>((resolve, reject) => {
      const child = spawn(pythonBin, ["-m", "venv", venvDir]);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Venv creation failed with code ${code}`));
      });
      child.on("error", reject);
    });
  }

  private async installRequirements(venvPython: string, repoDir: string) {
    log.info("Installing requirements", { venvPython, repoDir });
    
    let extra = "faster-whisper";
    // Future: Detect AMD GPU
    
    // Install from local directory
    const args = ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel", `${repoDir}[${extra}]`];
    
    return new Promise<void>((resolve, reject) => {
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
          log.warn("pip stderr", line);
          this.updateStatus({ message: line });
        }
      });

      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Pip install failed with code ${code}`));
      });
      child.on("error", reject);
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
              continue;
            }
          }
          return fullPath;
        }
      }
      return null;
    };

    return search(dir);
  }

  async setup(): Promise<void> {
    try {
      const root = managedRuntimeRoot();
      if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

      const links = this.getBinaryLinks();
      if (!links.python || !links.ffmpeg) {
        throw new Error(`Platform ${process.platform} ${process.arch} is not yet supported for automated setup.`);
      }

      // 1. Python
      const pythonDir = path.join(root, "python_standalone");
      if (!fs.existsSync(pythonDir)) {
        const pythonArchive = path.join(root, "python.tar.gz");
        await this.downloadFile(links.python, pythonArchive, "downloading_python");
        
        this.updateStatus({ stage: "extracting_python", progress: 0, message: "Extracting Python..." });
        await this.extractArchive(pythonArchive, pythonDir);
        fs.unlinkSync(pythonArchive);
      }
      
      const standalonePython = await this.findExecutable(pythonDir, "python3") || await this.findExecutable(pythonDir, "python");
      if (!standalonePython) throw new Error("Could not find Python executable in extracted archive");

      // 2. FFmpeg
      const ffmpegDir = path.join(root, "ffmpeg_standalone");
      const ffmpegPathFile = managedFfmpegPathFile();
      if (!fs.existsSync(ffmpegPathFile)) {
        const ffmpegArchive = path.join(root, "ffmpeg.archive");
        await this.downloadFile(links.ffmpeg, ffmpegArchive, "downloading_ffmpeg");
        
        this.updateStatus({ stage: "extracting_ffmpeg", progress: 0, message: "Extracting FFmpeg..." });
        await this.extractArchive(ffmpegArchive, ffmpegDir);
        
        const ffmpegBinPath = await this.findExecutable(ffmpegDir, "ffmpeg");
        if (!ffmpegBinPath) throw new Error("Could not find FFmpeg executable in extracted archive");
        
        fs.writeFileSync(ffmpegPathFile, ffmpegBinPath);
        fs.unlinkSync(ffmpegArchive);
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
        const sitePackagesBase = path.join(venvDir, "lib", "python3.12", "site-packages", "munajjam", "data");
        
        if (fs.existsSync(repoDataDir)) {
          if (!fs.existsSync(sitePackagesBase)) {
            fs.mkdirSync(sitePackagesBase, { recursive: true });
          }
          const dataFiles = fs.readdirSync(repoDataDir);
          for (const file of dataFiles) {
            if (file.endsWith(".csv")) {
              fs.copyFileSync(path.join(repoDataDir, file), path.join(sitePackagesBase, file));
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
        const dataPath = path.join(managedVenvDir(), "lib", "python3.12", "site-packages", "munajjam", "data", "quran_ayat.csv");
        dataOk = fs.existsSync(dataPath);
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
    
    const report: any = {
      platform: process.platform,
      arch: process.arch,
      python: {
        path: venvPython,
        exists: fs.existsSync(venvPython),
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
