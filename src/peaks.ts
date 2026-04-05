import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { app } from "electron";
import { createLogger } from "./logger";

const log = createLogger("peaks");

/**
 * Number of peak values to produce per second of audio.
 * Higher = more waveform detail.  Matches the Munajjam-Website script.
 */
const SAMPLES_PER_SECOND = 200;

/** Sample rate used for the intermediate raw PCM extraction. */
const EXTRACT_SAMPLE_RATE = 16000;

export interface PeaksResult {
  /** Outer array = channels (always 1 for mono). Inner array = peak values 0-1. */
  peaks: number[][];
  duration?: number;
  /** Peaks per second — NOT the audio sample rate. */
  sampleRate?: number;
}

function getPeaksPath(reciterId: string, surahId: number) {
  const padded = String(surahId).padStart(3, "0");
  return path.join(app.getPath("userData"), "peaks", reciterId, `${padded}.json`);
}

export async function loadPeaks(reciterId: string, surahId: number): Promise<PeaksResult | null> {
  const peaksPath = getPeaksPath(reciterId, surahId);
  if (!fs.existsSync(peaksPath)) return null;

  try {
    const raw = fs.readFileSync(peaksPath, "utf-8");
    const data = JSON.parse(raw);
    if (!data.peaks) return null;
    return data as PeaksResult;
  } catch {
    return null;
  }
}

/**
 * Resolve the ffmpeg binary.  The managed runtime may have written a marker
 * file with the path; otherwise fall back to the bare command name (assumed
 * to be on PATH).
 */
function resolveFfmpegBin(): string {
  const marker = path.join(app.getPath("userData"), "runtime", "munajjam", "ffmpeg-path.txt");
  if (fs.existsSync(marker)) {
    const value = fs.readFileSync(marker, "utf-8").trim();
    if (value && fs.existsSync(value)) {
      return value;
    }
  }
  return "ffmpeg";
}

function resolveFfprobeBin(): string {
  const ffmpeg = resolveFfmpegBin();
  if (ffmpeg === "ffmpeg") return "ffprobe";
  // ffprobe is typically next to ffmpeg
  const dir = path.dirname(ffmpeg);
  const ext = path.extname(ffmpeg);
  const probe = path.join(dir, `ffprobe${ext}`);
  return fs.existsSync(probe) ? probe : "ffprobe";
}

/** Get audio duration in seconds via ffprobe. */
function probeDuration(audioPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const bin = resolveFfprobeBin();
    execFile(
      bin,
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "csv=p=0",
        audioPath,
      ],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) return reject(err);
        const val = parseFloat(stdout.trim());
        if (!Number.isFinite(val) || val <= 0) {
          return reject(new Error(`Invalid duration from ffprobe: ${stdout.trim()}`));
        }
        resolve(val);
      },
    );
  });
}

/** Extract raw mono s16le PCM via ffmpeg and return the Buffer. */
function extractRawPcm(audioPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const bin = resolveFfmpegBin();
    const child = execFile(
      bin,
      [
        "-i", audioPath,
        "-ac", "1",
        "-ar", String(EXTRACT_SAMPLE_RATE),
        "-f", "s16le",
        "-acodec", "pcm_s16le",
        "pipe:1",
      ],
      { maxBuffer: 100 * 1024 * 1024, encoding: "buffer", timeout: 120_000 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout as unknown as Buffer);
      },
    );

    // Suppress stderr noise (ffmpeg writes progress to stderr)
    child.stderr?.resume();
  });
}

/**
 * Compute peaks from raw s16le PCM.
 *
 * Returns a single flat array of absolute peak values normalised to [0, 1],
 * matching the format expected by WaveSurfer.js and the Munajjam-Website
 * generate-peaks script:  `peaks: [[val, val, val, ...]]`
 *
 * A post-pass normalises relative to the file's own loudest sample so the
 * waveform always fills the full height (like a DAW).
 */
function computePeaks(pcmBuffer: Buffer): number[] {
  const sampleCount = pcmBuffer.length / 2; // 16-bit = 2 bytes per sample
  if (sampleCount === 0) return [];

  const samplesPerBin = Math.floor(EXTRACT_SAMPLE_RATE / SAMPLES_PER_SECOND);
  const totalBins = Math.ceil(sampleCount / samplesPerBin);
  const raw: number[] = [];

  let globalMax = 0;

  for (let bin = 0; bin < totalBins; bin++) {
    const start = bin * samplesPerBin;
    const end = Math.min(start + samplesPerBin, sampleCount);
    let maxAbs = 0;

    for (let i = start; i < end; i++) {
      const abs = Math.abs(pcmBuffer.readInt16LE(i * 2));
      if (abs > maxAbs) maxAbs = abs;
    }

    raw.push(maxAbs);
    if (maxAbs > globalMax) globalMax = maxAbs;
  }

  // Normalise against the file's own loudest sample so the waveform fills
  // the full available height — quiet recordings look just as detailed as
  // loud ones.
  const scale = globalMax > 0 ? 1 / globalMax : 1;
  return raw.map((v) => Math.round(v * scale * 1000) / 1000);
}

export async function generatePeaks(
  audioPath: string,
  reciterId: string,
  surahId: number,
): Promise<PeaksResult> {
  log.info("Generating peaks", { audioPath, reciterId, surahId });

  const outputPath = getPeaksPath(reciterId, surahId);
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  const [duration, pcm] = await Promise.all([
    probeDuration(audioPath),
    extractRawPcm(audioPath),
  ]);

  const peaks = computePeaks(pcm);

  const result: PeaksResult = {
    peaks: [peaks],            // WaveSurfer expects [[channel0_peaks]]
    duration,
    sampleRate: SAMPLES_PER_SECOND,
  };

  fs.writeFileSync(outputPath, JSON.stringify(result), "utf-8");
  log.info("Peaks generated", { surahId, peakCount: peaks.length, duration });
  return result;
}
