"use client";

import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, Card, cn } from "@reelflow/ui";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

const TONES: Record<string, Tone> = {
  PENDING: "neutral",
  QUEUED: "neutral",
  PROCESSING: "info",
  RUNNING: "info",
  PUBLISHING: "info",
  READY: "success",
  APPROVED: "success",
  PUBLISHED: "success",
  SUCCEEDED: "success",
  HEALTHY: "success",
  CONNECTED: "success",
  SCHEDULED: "accent",
  WAITING_APPROVAL: "warning",
  PENDING_REVIEW: "warning",
  WARNING: "warning",
  PAUSED: "warning",
  SKIPPED: "neutral",
  UNSCHEDULED: "neutral",
  FAILED: "danger",
  REJECTED: "danger",
  ERROR: "danger",
  AUTH_EXPIRED: "danger",
  DISCONNECTED: "neutral",
  CANCELLED: "neutral",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const { ts } = useI18n();
  return (
    <Badge tone={TONES[status] ?? "neutral"} dot className={className}>
      {ts("status", status)}
    </Badge>
  );
}

const RIGHTS_TONE: Record<string, Tone> = {
  UNKNOWN: "warning",
  USER_OWNS: "success",
  PERMISSION_GRANTED: "success",
  LICENSED: "success",
  PUBLIC_DOMAIN: "info",
  DO_NOT_IMPORT: "danger",
};

export function RightsBadge({ rights }: { rights: string }) {
  const { ts } = useI18n();
  return <Badge tone={RIGHTS_TONE[rights] ?? "neutral"}>{ts("rights", rights)}</Badge>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-fg">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
  return (
    <Card className="mb-4 flex items-start gap-3 border-danger/30 bg-danger/5 p-4 text-sm text-danger">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>{msg}</span>
    </Card>
  );
}

export function Notice({ tone = "info", children, className }: { tone?: "info" | "warning" | "danger"; children: ReactNode; className?: string }) {
  const color = { info: "border-info/25 bg-info/5 text-info", warning: "border-warning/25 bg-warning/5 text-warning", danger: "border-danger/25 bg-danger/5 text-danger" }[tone];
  return <div className={cn("rounded-xl border px-4 py-3 text-xs leading-relaxed", color, className)}>{children}</div>;
}

export function StatCard({ label, value, icon, hint, tone = "neutral" }: { label: string; value: ReactNode; icon: ReactNode; hint?: ReactNode; tone?: Tone }) {
  const ring = { neutral: "text-muted", info: "text-info", success: "text-success", warning: "text-warning", danger: "text-danger", accent: "text-accent" }[tone];
  return (
    <Card className="relative overflow-hidden p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted">{label}</p>
          <div className="mt-2 text-2xl font-bold tabular-nums tracking-tight text-fg">{value}</div>
        </div>
        <div className={cn("rounded-xl bg-surface-2 p-2.5 [&_svg]:size-5", ring)}>{icon}</div>
      </div>
      {hint ? <div className="mt-3 text-[11px] text-muted">{hint}</div> : null}
    </Card>
  );
}
