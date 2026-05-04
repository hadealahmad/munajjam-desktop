"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { isDesktop, getElectronBridge } from "@/lib/electron";
import type { RuntimeStatus } from "@/types/munajjam";

type EnvStatus = "loading" | "ready" | "failed";

interface EnvContextValue {
  status: EnvStatus;
  runtimeStatus: RuntimeStatus | null;
  recheck: () => void;
  setup: () => Promise<void>;
  doctor: () => Promise<any>;
}

const EnvContext = createContext<EnvContextValue>({
  status: "ready",
  runtimeStatus: null,
  recheck: () => {},
  setup: async () => {},
  doctor: async () => ({}),
});

export function useEnv() {
  return useContext(EnvContext);
}

export function EnvProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<EnvStatus>("loading");
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);

  const runCheck = useCallback(async () => {
    if (!isDesktop()) {
      setStatus("ready");
      return;
    }

    setStatus("loading");
    try {
      const bridge = getElectronBridge();
      const isReady = await bridge.runtime.check();
      const currentStatus = await bridge.runtime.getStatus();
      setRuntimeStatus(currentStatus);
      setStatus(isReady ? "ready" : "failed");
    } catch (err) {
      console.error("Environment check failed:", err);
      setStatus("failed");
    }
  }, []);

  const runSetup = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      const bridge = getElectronBridge();
      await bridge.runtime.setup();
    } catch (err) {
      console.error("Setup failed:", err);
    }
  }, []);

  const runDoctor = useCallback(async () => {
    if (!isDesktop()) return null;
    try {
      return await getElectronBridge().runtime.doctor();
    } catch (err) {
      console.error("Doctor report failed:", err);
      return null;
    }
  }, []);

  useEffect(() => {
    runCheck();

    if (isDesktop()) {
      const bridge = getElectronBridge();
      return bridge.runtime.subscribe((newStatus) => {
        setRuntimeStatus(newStatus);
        if (newStatus.stage === "ready") {
          setStatus("ready");
        } else if (newStatus.stage === "error") {
          setStatus("failed");
        }
      });
    }
  }, [runCheck]);

  return (
    <EnvContext.Provider value={{ status, runtimeStatus, recheck: runCheck, setup: runSetup, doctor: runDoctor }}>
      {children}
    </EnvContext.Provider>
  );
}
