"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { BackgroundOp, LogLevel, useBackgroundOps } from "~~/services/store/backgroundOps";

const AUTO_COLLAPSE_MS = 4000;

const statusDot = (op: BackgroundOp) => {
  if (op.status === "running") return <span className="loading loading-spinner loading-xs text-primary" />;
  if (op.status === "completed") return <span className="w-2 h-2 rounded-full bg-success inline-block" />;
  return <span className="w-2 h-2 rounded-full bg-error inline-block" />;
};

const levelColor = (level: LogLevel) => {
  switch (level) {
    case "error":
      return "text-error";
    case "warn":
      return "text-warning";
    case "success":
      return "text-success";
    default:
      return "text-base-content/70";
  }
};

const formatTime = (ts: number) => new Date(ts).toLocaleTimeString();

const OpRow = ({ op, onClear }: { op: BackgroundOp; onClear: (id: string) => void }) => {
  const [expanded, setExpanded] = useState(op.status === "running");
  return (
    <div className="border-b border-base-300/50 last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-2">
        {statusDot(op)}
        <button
          type="button"
          className="flex-grow text-left text-sm truncate hover:opacity-80"
          onClick={() => setExpanded(v => !v)}
          title={op.title}
        >
          {op.title}
        </button>
        <span className="text-[10px] opacity-50 font-mono">{formatTime(op.createdAt)}</span>
        {op.status !== "running" && (
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-circle"
            onClick={() => onClear(op.id)}
            title="Dismiss"
          >
            <XMarkIcon className="w-3 h-3" />
          </button>
        )}
      </div>
      {op.status === "running" && typeof op.progress === "number" && (
        <div className="px-3 pb-2">
          <progress className="progress progress-primary w-full h-1" value={op.progress} max={100} />
        </div>
      )}
      {expanded && op.logs.length > 0 && (
        <div className="px-3 pb-2 max-h-40 overflow-y-auto bg-base-300/30 rounded-b-md">
          <ul className="text-xs font-mono leading-relaxed space-y-0.5">
            {op.logs.map((log, i) => (
              <li key={i} className={`flex gap-2 ${levelColor(log.level)}`}>
                <span className="opacity-40 shrink-0">{formatTime(log.timestamp)}</span>
                <span className="break-all">{log.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export const BackgroundOpsDrawer = () => {
  const ops = useBackgroundOps(s => s.ops);
  const clear = useBackgroundOps(s => s.clear);
  const clearCompleted = useBackgroundOps(s => s.clearCompleted);

  const [forceOpen, setForceOpen] = useState(false); // user-opened via click
  const [autoOpen, setAutoOpen] = useState(false); // opened because an op is running
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runningCount = useMemo(() => ops.filter(o => o.status === "running").length, [ops]);
  const latestRunning = useMemo(() => ops.find(o => o.status === "running"), [ops]);
  const hasAnyOps = ops.length > 0;

  // Slide out whenever there's a running op; schedule auto-collapse after
  // completion. User-opened state persists until they close it.
  useEffect(() => {
    if (runningCount > 0) {
      setAutoOpen(true);
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
      return;
    }
    if (autoOpen && !forceOpen) {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = setTimeout(() => setAutoOpen(false), AUTO_COLLAPSE_MS);
    }
    return () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, [runningCount, autoOpen, forceOpen]);

  const open = forceOpen || autoOpen;

  return (
    <div className="fixed bottom-2 right-2 z-40 pointer-events-none">
      <div className="pointer-events-auto flex flex-col items-end gap-1">
        {open && hasAnyOps && (
          <div className="w-[360px] max-w-[calc(100vw-1rem)] bg-base-200 border border-base-300 rounded-lg shadow-xl overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-base-300 bg-base-300/40">
              <span className="text-xs font-bold tracking-wider uppercase opacity-70">Background Ops</span>
              {runningCount > 0 && (
                <span className="badge badge-primary badge-xs font-mono">{runningCount} running</span>
              )}
              <div className="flex-grow" />
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={clearCompleted}
                disabled={!ops.some(o => o.status !== "running")}
                title="Clear completed"
              >
                Clear
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-xs btn-circle"
                onClick={() => {
                  setForceOpen(false);
                  setAutoOpen(false);
                }}
                title="Collapse"
              >
                <ChevronDownIcon className="w-4 h-4" />
              </button>
            </div>
            <div className="max-h-[50vh] overflow-y-auto">
              {ops.map(op => (
                <OpRow key={op.id} op={op} onClear={clear} />
              ))}
            </div>
          </div>
        )}

        {/* Handle: always present. Subtle when idle, active when running. */}
        <button
          type="button"
          className={`pointer-events-auto flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-mono transition-colors ${
            runningCount > 0
              ? "bg-base-200 border-primary/60 text-primary"
              : hasAnyOps
                ? "bg-base-200/80 border-base-300 text-base-content/70 hover:border-primary/40"
                : "bg-base-200/40 border-base-300/50 text-base-content/40 hover:text-base-content/70 hover:border-base-300"
          }`}
          onClick={() => setForceOpen(v => !v)}
          title={
            runningCount > 0
              ? `${runningCount} background op${runningCount === 1 ? "" : "s"} running`
              : hasAnyOps
                ? "Background operations"
                : "No background operations"
          }
        >
          {runningCount > 0 ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />
          )}
          <span>
            {runningCount > 0
              ? `${runningCount} running${latestRunning ? ` — ${latestRunning.title.slice(0, 28)}` : ""}`
              : hasAnyOps
                ? `${ops.length} recent`
                : "ops"}
          </span>
        </button>
      </div>
    </div>
  );
};
