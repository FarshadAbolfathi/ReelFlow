"use client";

import { CheckCircle2, CircleAlert, X } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { cn } from "@reelflow/ui";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

interface Toast {
  id: number;
  tone: "success" | "error";
  message: string;
}

const Ctx = createContext<{ success: (m: string) => void; error: (e: unknown) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast["tone"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 8000 : 3500);
  }, []);
  const api = {
    success: (m: string) => push("success", m),
    error: (e: unknown) => push("error", e instanceof ApiError ? `${e.message}${e.details?.violations ? ` — ${(e.details.violations as string[]).join(t("common.listSeparator"))}` : ""}` : e instanceof Error ? e.message : String(e)),
  };
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 start-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-xl backdrop-blur",
              t.tone === "success" ? "border-success/30 bg-surface-1/95 text-fg" : "border-danger/30 bg-surface-1/95 text-fg",
            )}
          >
            {t.tone === "success" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />}
            <p className="flex-1 leading-relaxed">{t.message}</p>
            <button onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="text-muted hover:text-fg" aria-label="close">
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast outside provider");
  return v;
}
