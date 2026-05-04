import type {
  MunajjamBridge,
  AudioFileScanResult,
  RuntimeStatus,
  RuntimeStage,
  AlignmentRow,
  AudioFileRow,
  ReciterRow,
  RecitationVersion,
  JobRow,
  JobConfig,
  JobEvent,
  JobLogEntry,
} from "../../src/ipc-types";

export type {
  MunajjamBridge,
  AudioFileScanResult,
  RuntimeStatus,
  RuntimeStage,
  AlignmentRow,
  AudioFileRow,
  ReciterRow,
  RecitationVersion,
  JobRow,
  JobConfig,
  JobEvent,
  JobLogEntry,
};

declare global {
  interface Window {
    munajjam?: MunajjamBridge;
  }
}
