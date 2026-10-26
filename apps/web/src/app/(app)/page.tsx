"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertOctagon, CheckCircle2, Clock3, Download, Hourglass, Send, ShieldAlert, Sparkles } from "lucide-react";
import Link from "next/link";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from "@reelflow/ui";
import { ErrorBanner, PageHeader, StatCard, StatusBadge } from "@/components/common";
import { api, media } from "@/lib/api";
import { formatDateTime, formatNumber, formatSlot } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { Limits } from "@/lib/types";

interface DashboardData {
  counts: { importedToday: number; processed: number; pendingApproval: number; scheduled: number; publishedToday: number; publishedTotal: number; failedPosts: number; failedJobs: number };
  nextPost: { id: string; scheduledAt: string; content: { id: string; thumbnailKey: string | null; source: { name: string } | null }; account: { name: string } } | null;
  safety: { id: string; name: string; safetyState: string; status: string; pausedUntil: string | null; pauseReason: string | null }[];
  limits: Limits;
  ceilings: Limits;
  autoPublishEnabled: boolean;
  approvalMode: string;
}

export default function DashboardPage() {
  const { t, ts, locale } = useI18n();
  const { data, error, isLoading } = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<DashboardData>("/dashboard"), refetchInterval: 30_000 });
  const activity = useQuery({ queryKey: ["activity", 14], queryFn: () => api.get<{ day: string; imported: number; published: number; failed: number }[]>("/analytics/activity?days=14") });
  const sources = useQuery({ queryKey: ["analytics-overview"], queryFn: () => api.get<{ sources: { id: string; name: string; imported: number; published: number }[] }>("/analytics/overview") });

  const c = data?.counts;
  const n = (v: number | undefined) => (v === undefined ? <Skeleton className="h-7 w-12" /> : formatNumber(v, locale));

  return (
    <>
      <PageHeader
        title={t("nav.dashboard")}
        description={data ? `${t("dash.approvalMode")}: ${ts("mode", data.approvalMode)} · ${t("shell.autoPublish")} ${data.autoPublishEnabled ? t("common.on") : t("common.off")}` : undefined}
      />
      <ErrorBanner error={error} />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label={t("dash.importedToday")} value={n(c?.importedToday)} icon={<Download />} tone="info" />
        <StatCard label={t("dash.processed")} value={n(c?.processed)} icon={<Sparkles />} tone="accent" />
        <StatCard label={t("dash.pendingApproval")} value={n(c?.pendingApproval)} icon={<Hourglass />} tone="warning" hint={<Link href="/content?approvalStatus=PENDING" className="text-accent">{t("dash.review")}</Link>} />
        <StatCard label={t("dash.scheduled")} value={n(c?.scheduled)} icon={<Clock3 />} tone="accent" />
        <StatCard label={t("dash.published")} value={n(c?.publishedToday)} icon={<Send />} tone="success" hint={c ? `${t("dash.total")}: ${formatNumber(c.publishedTotal, locale)}` : undefined} />
        <StatCard label={t("dash.failed")} value={n(c ? c.failedJobs + c.failedPosts : undefined)} icon={<AlertOctagon />} tone="danger" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>{t("dash.activity")}</CardTitle>
              <CardDescription>{t("dash.activityDesc")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="h-72" dir="ltr">
            {activity.data ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={activity.data} margin={{ left: -20, right: 8, top: 8 }}>
                  <defs>
                    <linearGradient id="gImp" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-info)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--color-info)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gPub" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-success)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--color-success)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--color-line)" vertical={false} />
                  <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} stroke="var(--color-muted)" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} stroke="var(--color-muted)" fontSize={11} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ background: "var(--color-surface-2)", border: "1px solid var(--color-line)", borderRadius: 12, fontSize: 12 }} />
                  <Area type="monotone" dataKey="imported" name={t("dash.seriesImported")} stroke="var(--color-info)" fill="url(#gImp)" strokeWidth={2} />
                  <Area type="monotone" dataKey="published" name={t("dash.seriesPublished")} stroke="var(--color-success)" fill="url(#gPub)" strokeWidth={2} />
                  <Area type="monotone" dataKey="failed" name={t("dash.seriesFailed")} stroke="var(--color-danger)" fill="transparent" strokeWidth={1.5} strokeDasharray="4 3" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <Skeleton className="h-full w-full" />
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("dash.nextPost")}</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-20" />
              ) : data?.nextPost ? (
                <Link href={`/content/${data.nextPost.content.id}`} className="flex items-center gap-4">
                  <div className="h-20 w-12 shrink-0 overflow-hidden rounded-lg bg-surface-2">
                    {data.nextPost.content.thumbnailKey ? <img src={media.thumbnail(data.nextPost.content.id)} alt="" className="size-full object-cover" /> : null}
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-semibold">{formatSlot(data.nextPost.scheduledAt, locale)}</p>
                    <p className="truncate text-xs text-muted">{data.nextPost.content.source?.name ?? t("dash.upload")} → {data.nextPost.account.name}</p>
                    <p className="text-[11px] text-muted">{formatDateTime(data.nextPost.scheduledAt, locale)}</p>
                  </div>
                </Link>
              ) : (
                <p className="text-xs text-muted">{t("dash.noScheduledPost")}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("dash.safety")}</CardTitle>
              {data?.safety.some((a) => a.safetyState !== "HEALTHY") ? <ShieldAlert className="size-4 text-warning" /> : <CheckCircle2 className="size-4 text-success" />}
            </CardHeader>
            <CardContent className="space-y-3">
              {data?.safety.length === 0 ? <p className="text-xs text-muted">{t("dash.noAccounts")}</p> : null}
              {data?.safety.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{a.name}</span>
                  <StatusBadge status={a.safetyState} />
                </div>
              ))}
              {data ? (
                <div className="mt-2 rounded-xl bg-surface-2 p-3 text-[11px] leading-6 text-muted">
                  <p className="font-medium text-fg">{t("dash.limits")}</p>
                  <p>
                    {t("dash.limits.perDay")} <b className="text-fg">{data.limits.maxPostsPerDay}</b> ({t("dash.limits.ownerCeiling")}: {data.ceilings.maxPostsPerDay}) · {t("dash.limits.perHour")} {data.limits.maxPostsPerHour} · {t("dash.limits.minInterval")} {data.limits.minPostIntervalMinutes} {t("dash.limits.minutes")} · {t("dash.limits.perSource")} {data.limits.maxPostsPerSourcePerDay} {t("dash.limits.perDaySuffix")}
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <div>
            <CardTitle>{t("dash.sourcesActivity")}</CardTitle>
            <CardDescription>{t("dash.sourcesActivityDesc")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {sources.data?.sources.length === 0 ? <p className="text-xs text-muted">{t("dash.noSources")}</p> : null}
          {sources.data?.sources.map((s) => {
            const max = Math.max(1, ...sources.data!.sources.map((x) => x.imported));
            return (
              <div key={s.id} className="grid grid-cols-[10rem_1fr_auto] items-center gap-4 text-sm">
                <span className="truncate">{s.name}</span>
                <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full bg-gradient-to-l from-accent to-info" style={{ width: `${(s.imported / max) * 100}%` }} />
                </div>
                <span className="flex gap-2 text-xs text-muted">
                  <Badge tone="info">{formatNumber(s.imported, locale)} {t("dash.seriesImported")}</Badge>
                  <Badge tone="success">{formatNumber(s.published, locale)} {t("dash.seriesPublished")}</Badge>
                </span>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </>
  );
}
