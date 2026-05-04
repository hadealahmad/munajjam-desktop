import { BrowserWindow } from "electron";
import { RuntimeManager, RuntimeStatus } from "../runtime-manager";
import type { RegisterHandler } from "./register-types";

let runtimeManager: RuntimeManager | null = null;

export function registerRuntimeHandlers(register: RegisterHandler) {
  const broadcastStatus = (status: RuntimeStatus) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("runtime:status", status);
    }
  };

  if (!runtimeManager) {
    runtimeManager = new RuntimeManager(broadcastStatus);
  }

  register("runtime:check", () => runtimeManager!.checkRuntime());
  register("runtime:setup", () => runtimeManager!.setup());
  register("runtime:getStatus", () => runtimeManager!.getStatus());
  register("runtime:doctor", () => runtimeManager!.getDoctorReport());
}
