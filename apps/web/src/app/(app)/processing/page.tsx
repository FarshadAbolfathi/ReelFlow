"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Badge, Card, CardContent, CardHeader, CardTitle, Table, Td, Th } from "@reelflow/ui";
import { ErrorBanner, PageHeader, StatusBadge } from "@/components/common";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

interface Ingestion {
  id: string;
  kind: string;
  url: string | null;
  status: string;
  outcome: string | null;
  contentId: string | null;
  duplicateOfId: string | null;
  networkMode: string;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
  source: { name: string } | null;
}

interface Job {
  id: string;
  queue: string;
  status: string;
  contentId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  networkMode: string | null;
  createdAt: string;
}

const STAGES = ["content-discovery", "media-download", "media-processing", "approval", "publishing"];

export default function ProcessingPage() {
  const { t, locale } = useI18n();
  const counts = useQuery({ queryKey: ["queues"], queryFn: () => api.get<Record<string, Record<string, number>>>("/queues"), refetchInterval: 5000 });
  const ingests = useQuery({ queryKey: ["ingestion"], queryFn: () => api.get<Ingestion[]>("/ingestion"), refetchInterval: 5000 });
  const jobs = useQuery({ queryKey: ["jobs", "processing"], queryFn: () => api.get<{ items: Job[] }>("/jobs?queue=media-processing&pageSize=30"), refetchInterval: 5000 });

  return (
    <>
      <PageHeader title={t("nav.processing")} description="هر مرحله خط تولید جداگانه قابل مشاهده است: کشف ← ورود ← پردازش ← تأیید ← انتشار." />
      <ErrorBanner error={counts.error ?? ingests.error} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        {STAGES.map((q) => {
          const c = counts.data?.[q] ?? {};
          const active = (c.active ?? 0) + (c.pending ?? 0);
          const waiting = (c.waiting ?? 0) + (c.delayed ?? 0) + (c.stream ?? 0);
          return (
            <Card key={q} className="p-4">
              <p className="ltr text-start text-[11px] font-medium text-muted">{q}</p>
              <div className="mt-2 flex items-baseline gap-3 text-sm">
                <span><b className="text-lg tabular-nums">{active}</b> فعال</span>
                <span className="text-muted">{waiting} در صف</span>
              </div>
              {c.failed ? <Badge tone="danger" className="mt-2">{c.failed} ناموفق</Badge> : null}
            </Card>
          );
        })}
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>ورود محتوا (دانلود / آپلود)</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <thead><tr><Th>منبع</Th><Th>نوع</Th><Th>وضعیت</Th><Th>نتیجه</Th><Th>شبکه</Th><Th>زمان</Th></tr></thead>
              <tbody>
                {ingests.data?.map((r) => (
                  <tr key={r.id}>
                    <Td className="max-w-48">
                      <p className="truncate">{r.source?.name ?? "—"}</p>
                      {r.errorMessage ? <p className="line-clamp-2 text-[11px] text-warning">{r.errorMessage}</p> : null}
                    </Td>
                    <Td className="text-xs">{r.kind}</Td>
                    <Td><StatusBadge status={r.status} /></Td>
                    <Td>
                      {r.outcome === "IMPORTED" && r.contentId ? <Link href={`/content/${r.contentId}`}><Badge tone="success">وارد شد</Badge></Link> : null}
                      {r.outcome === "DUPLICATE" && r.duplicateOfId ? <Link href={`/content/${r.duplicateOfId}`}><Badge tone="warning">تکراری ←</Badge></Link> : null}
                      {r.outcome === "REJECTED" || r.outcome === "FAILED" ? <Badge tone="danger">{r.errorCode}</Badge> : null}
                    </Td>
                    <Td><Badge tone={r.networkMode === "PROXY" ? "accent" : "neutral"}>{r.networkMode}</Badge></Td>
                    <Td className="text-xs text-muted">{formatDateTime(r.createdAt, locale)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>پردازش رسانه (FFmpeg)</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <thead><tr><Th>محتوا</Th><Th>وضعیت</Th><Th>مدت</Th><Th>خطا</Th><Th>زمان</Th></tr></thead>
              <tbody>
                {jobs.data?.items.map((j) => (
                  <tr key={j.id}>
                    <Td>{j.contentId ? <Link className="text-accent" href={`/content/${j.contentId}`}>مشاهده</Link> : "—"}</Td>
                    <Td><StatusBadge status={j.status} /></Td>
                    <Td className="ltr text-xs tabular-nums">{j.durationMs ? `${(j.durationMs / 1000).toFixed(1)}s` : "—"}</Td>
                    <Td className="max-w-56 text-[11px] text-danger"><span className="line-clamp-2">{j.errorMessage}</span></Td>
                    <Td className="text-xs text-muted">{formatDateTime(j.createdAt, locale)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
