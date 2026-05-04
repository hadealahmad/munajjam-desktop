"use client";

import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { motion } from "framer-motion";
import { ChevronRight, Loader2, RefreshCw, Stethoscope } from "lucide-react";
import { useEnv } from "@/lib/env-context";
import { getElectronBridge, isDesktop } from "@/lib/electron";



function InstallCard({
  onInstallComplete,
}: {
  onInstallComplete: () => void;
}) {
  const t = useTranslations("qa.setup");
  const { runtimeStatus, setup } = useEnv();
  const [installing, setInstalling] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);

  const stage = runtimeStatus?.stage || "idle";
  const progress = runtimeStatus?.progress || 0;
  const message = runtimeStatus?.message || "";

  useEffect(() => {
    if (stage === "ready") {
      setInstalling(false);
      onInstallComplete();
    } else if (stage === "error") {
      setInstalling(false);
    }
  }, [stage, onInstallComplete]);

  const handleInstall = async () => {
    setInstalling(true);
    await setup();
  };

  return (
    <div className="mt-4 p-4 bg-white/5 rounded-xl border border-white/10">
      <h4 className="text-sm font-medium text-white/80 mb-3">{t("installRuntimeTitle")}</h4>
      <p className="text-xs text-white/50 mb-4">
        We will download and set up Python, FFmpeg, and the Munajjam engine in your workspace.
      </p>

      {installing || stage !== "idle" ? (
        <div className="space-y-4">
          <div className="flex justify-between text-xs text-white/60 mb-1">
            <span className="capitalize">{stage.replace(/_/g, " ")}</span>
            <span>{progress}%</span>
          </div>
          <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
            <motion.div
              className="bg-blue-500 h-full"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
          <div className="text-[11px] text-white/40 italic truncate">
            {message}
          </div>
          
          {stage === "error" && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
              {runtimeStatus?.error || "An unexpected error occurred during setup."}
            </div>
          )}
        </div>
      ) : (
        <button
          onClick={handleInstall}
          disabled={installing}
          className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/15 border border-white/10 rounded-lg text-sm text-white/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ChevronRight className="w-4 h-4" />
          {t("installButton")}
        </button>
      )}
    </div>
  );
}

function DoctorReport({ report }: { report: any }) {
  return (
    <div className="mt-6 p-4 bg-black/40 rounded-xl border border-white/5 font-mono text-[11px] text-white/60 overflow-x-auto">
      <div className="mb-2 text-white/40 uppercase tracking-wider font-bold text-[10px]">System Diagnostics</div>
      <pre>{JSON.stringify(report, null, 2)}</pre>
    </div>
  );
}

export default function SetupAssistantView() {
  const t = useTranslations("qa.setup");
  const params = useParams();
  const locale = (params.locale as string) || "en";
  const isRTL = locale === "ar";
  const { status, runtimeStatus, recheck, doctor } = useEnv();
  const [doctorReport, setDoctorReport] = useState<any>(null);
  const [isRunningDoctor, setIsRunningDoctor] = useState(false);

  const isLoading = status === "loading";
  const isReady = status === "ready";

  const handleInstallComplete = useCallback(() => {
    setTimeout(() => recheck(), 500);
  }, [recheck]);

  const handleRunDoctor = async () => {
    setIsRunningDoctor(true);
    const report = await doctor();
    setDoctorReport(report);
    setIsRunningDoctor(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex-1 flex flex-col items-center justify-center px-6 md:px-8 py-8"
      dir={isRTL ? "rtl" : "ltr"}
    >
      <div className="w-full max-w-lg">
        <div className="mb-6">
          <h2 className="text-xl font-semibold text-white/90 mb-1">{t("title")}</h2>
          <p className="text-sm text-white/50">{t("description")}</p>
        </div>

        {!isReady && (
          <InstallCard onInstallComplete={handleInstallComplete} />
        )}

        {doctorReport && <DoctorReport report={doctorReport} />}

        <div className={`flex items-center gap-3 mt-6 ${isRTL ? "flex-row-reverse" : ""}`}>
          <button
            onClick={recheck}
            disabled={isLoading}
            className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm text-white/60 hover:text-white/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
            {t("recheck")}
          </button>

          <button
            onClick={handleRunDoctor}
            disabled={isRunningDoctor}
            className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm text-white/60 hover:text-white/80 transition-colors disabled:opacity-50"
          >
            <Stethoscope className={`w-4 h-4 ${isRunningDoctor ? "animate-pulse" : ""}`} />
            Doctor
          </button>

          {isReady ? (
            <button
              onClick={recheck}
              className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/15 border border-white/10 rounded-lg text-sm text-white/80 transition-colors"
            >
              {t("continue")}
            </button>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
}
