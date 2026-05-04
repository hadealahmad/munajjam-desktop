import fs from "fs";
import path from "path";
import { app } from "electron";
import { setManagedRuntimeRoot } from "./paths";

export interface AppSettings {
  workspaceRoot?: string;
}

const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");

export function loadSettings(): AppSettings {
  if (!fs.existsSync(SETTINGS_FILE)) {
    return {};
  }
  try {
    const content = fs.readFileSync(SETTINGS_FILE, "utf-8");
    const settings = JSON.parse(content) as AppSettings;
    
    if (settings.workspaceRoot) {
      setManagedRuntimeRoot(settings.workspaceRoot);
    }
    
    return settings;
  } catch (err) {
    console.error("Failed to load settings:", err);
    return {};
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
    if (settings.workspaceRoot) {
      setManagedRuntimeRoot(settings.workspaceRoot);
    }
  } catch (err) {
    console.error("Failed to save settings:", err);
  }
}
