import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDb } from "./db";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeDb(): { db: LocalDb; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "munajjam-db-"));
  tempDirs.push(dir);
  const db = new LocalDb(path.join(dir, "munajjam.db"));
  return { db, dir };
}

describe("LocalDb schema reset", () => {
  it("backs up legacy db and creates fresh schema", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "munajjam-db-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "munajjam.db");

    const legacy = new Database(dbPath);
    legacy.exec("CREATE TABLE legacy (id TEXT PRIMARY KEY); INSERT INTO legacy (id) VALUES ('x');");
    legacy.close();

    const db = new LocalDb(dbPath);
    const reciters = db.listReciters();
    expect(reciters.length).toBeGreaterThan(0);

    const backups = fs.readdirSync(dir).filter((name) => name.startsWith("munajjam.db.backup-"));
    expect(backups.length).toBe(1);
  });
});

describe("LocalDb.recoverStaleJobs", () => {
  it("returns 0 when there are no running jobs", () => {
    const { db } = makeDb();
    db.createJob({ status: "completed" });
    db.createJob({ status: "queued" });
    db.createJob({ status: "canceled" });

    expect(db.recoverStaleJobs()).toBe(0);
  });

  it("marks every running job as failed and returns the count", () => {
    const { db } = makeDb();
    const j1 = db.createJob({ status: "running" });
    const j2 = db.createJob({ status: "running" });
    db.createJob({ status: "completed" });

    const count = db.recoverStaleJobs();
    expect(count).toBe(2);

    expect(db.getJob(j1.id).status).toBe("failed");
    expect(db.getJob(j2.id).status).toBe("failed");
  });

  it("stamps finished_at on recovered jobs", () => {
    const { db } = makeDb();
    const job = db.createJob({ status: "running" });

    db.recoverStaleJobs();

    expect(db.getJob(job.id).finished_at).not.toBeNull();
  });

  it("does not touch completed, queued, canceled, or failed jobs", () => {
    const { db } = makeDb();
    const statuses = ["completed", "queued", "canceled", "failed"] as const;
    const ids = statuses.map((s) => db.createJob({ status: s }).id);

    db.recoverStaleJobs();

    for (let i = 0; i < statuses.length; i++) {
      expect(db.getJob(ids[i]).status).toBe(statuses[i]);
    }
  });
});
