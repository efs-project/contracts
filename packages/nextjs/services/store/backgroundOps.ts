import { create } from "zustand";

export type OpStatus = "running" | "completed" | "failed";
export type LogLevel = "info" | "warn" | "error" | "success";

export type LogEntry = {
  message: string;
  level: LogLevel;
  timestamp: number;
};

export type BackgroundOp = {
  id: string;
  title: string;
  status: OpStatus;
  createdAt: number;
  completedAt?: number;
  /** Optional 0-100 progress hint for the drawer's inline bar. */
  progress?: number;
  logs: LogEntry[];
};

type Store = {
  ops: BackgroundOp[];
  start: (title: string) => string;
  log: (id: string, message: string, level?: LogLevel) => void;
  progress: (id: string, percent: number) => void;
  complete: (id: string, message?: string) => void;
  fail: (id: string, message: string) => void;
  clear: (id: string) => void;
  clearCompleted: () => void;
};

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const useBackgroundOps = create<Store>(set => ({
  ops: [],
  start: title => {
    const id = uid();
    const op: BackgroundOp = {
      id,
      title,
      status: "running",
      createdAt: Date.now(),
      logs: [],
    };
    set(state => ({ ops: [op, ...state.ops] }));
    return id;
  },
  log: (id, message, level = "info") =>
    set(state => ({
      ops: state.ops.map(o =>
        o.id === id ? { ...o, logs: [...o.logs, { message, level, timestamp: Date.now() }] } : o,
      ),
    })),
  progress: (id, percent) =>
    set(state => ({
      ops: state.ops.map(o => (o.id === id ? { ...o, progress: Math.max(0, Math.min(100, percent)) } : o)),
    })),
  complete: (id, message) =>
    set(state => ({
      ops: state.ops.map(o =>
        o.id === id
          ? {
              ...o,
              status: "completed",
              completedAt: Date.now(),
              progress: 100,
              logs: message ? [...o.logs, { message, level: "success", timestamp: Date.now() }] : o.logs,
            }
          : o,
      ),
    })),
  fail: (id, message) =>
    set(state => ({
      ops: state.ops.map(o =>
        o.id === id
          ? {
              ...o,
              status: "failed",
              completedAt: Date.now(),
              logs: [...o.logs, { message, level: "error", timestamp: Date.now() }],
            }
          : o,
      ),
    })),
  clear: id => set(state => ({ ops: state.ops.filter(o => o.id !== id) })),
  clearCompleted: () => set(state => ({ ops: state.ops.filter(o => o.status === "running") })),
}));
