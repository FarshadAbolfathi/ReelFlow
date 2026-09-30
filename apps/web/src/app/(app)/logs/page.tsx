"use client";

import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, Input, Select, Table, Tabs, Td, Th } from "@reelflow/ui";
import { PageHeader, StatusBadge } from "@/components/common";
import { api, qs } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

interface Audit {
  id: string;
  action: string;
  actorType: string;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  createdAt: string;
}

interface Job {
  id: string;
  queue: string;
  bullJobId: string | null;
  status: string;
  contentId: string | null;
  accountId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  networkMode: string | null;
  proxyStatus: string | null;
  host: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

const ACTIONS = ["", "source_created", "source_reviewed", "content_imported", "content_duplicate", "content_processed", "watermark_applied", "content_approved", "post_scheduled", "post_published", "post_failed", "post_blocked", "account_connected", "account_disconnected", "account_paused", "settings_changed", "network_command", "user_login", "user_login_failed"];
const QUEUES = ["", "content-discovery", "media-download", "media-processing", "approval", "publishing", "analytics", "cleanup", "scheduler-tick"];

export default function LogsPage() {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<"audit" | "jobs">("audit");
  const [text, setText] = useState("");
  const [action, setAction] = useState("");
  const [queue, setQueue] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const audit = useQuery({ queryKey: ["audit", text, action, page], queryFn: () => api.get<{ items: Audit[]; total: number }>(`/audit${qs({ text, action, page, pageSize: 50 })}`), enabled: tab === "audit" });
  const jobs = useQuery({ queryKey: ["jobs", queue, status, page], queryFn: () => api.get<{ items: Job[]; total: number }>(`/jobs${qs({ queue, status, page, pageSize: 50 })}`), enabled: tab === "jobs", refetchInterval: 10_000 });
  const total = tab === "audit" ? audit.data?.total : jobs.data?.total;

  return (
    <>
      <PageHeader title={t("nav.logs")} description="هر اقدام خودکار یا دستی اینجا ثبت می‌شود. رمزها، توکن‌ها و کوکی‌ها هرگز در گزارش‌ها ذخیره نمی‌شوند." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={tab} onChange={(v) => { setTab(v); setPage(1); }} items={[{ value: "audit", label: "گزارش ممیزی" }, { value: "jobs", label: "اجرای کارها و شبکه" }]} />
        {tab === "audit" ? (
          <>
            <div className="relative w-72">
              <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-muted" />
              <Input className="ps-9" placeholder="جستجو…" value={text} onChange={(e) => { setText(e.target.value); setPage(1); }} />
            </div>
            <Select className="w-56" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>
              {ACTIONS.map((a) => <option key={a} value={a}>{a || "همه رویدادها"}</option>)}
            </Select>
          </>
        ) : (
          <>
            <Select className="w-56" value={queue} onChange={(e) => { setQueue(e.target.value); setPage(1); }}>
              {QUEUES.map((q) => <option key={q} value={q}>{q || "همه صف‌ها"}</option>)}
            </Select>
            <Select className="w-40" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              {["", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"].map((s) => <option key={s} value={s}>{s || "همه وضعیت‌ها"}</option>)}
            </Select>
          </>
        )}
      </div>
      <Card>
        {tab === "audit" ? (
          <Table>
            <thead><tr><Th>زمان</Th><Th>رویداد</Th><Th>انجام‌دهنده</Th><Th>شرح</Th><Th>موجودیت</Th></tr></thead>
            <tbody>
              {audit.data?.items.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap text-xs text-muted">{formatDateTime(a.createdAt, locale)}</Td>
                  <Td><Badge className="ltr font-mono">{a.action}</Badge></Td>
                  <Td className="text-xs">{a.actorType}</Td>
                  <Td className="max-w-xl text-sm">{a.summary}</Td>
                  <Td className="ltr text-[11px] text-muted">{a.entityType ? `${a.entityType}:${a.entityId?.slice(0, 8)}` : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Table>
            <thead><tr><Th>زمان</Th><Th>صف</Th><Th>شناسه کار</Th><Th>وضعیت</Th><Th>شبکه</Th><Th>میزبان</Th><Th>مدت</Th><Th>تلاش</Th><Th>خطا</Th></tr></thead>
            <tbody>
              {jobs.data?.items.map((j) => (
                <tr key={j.id}>
                  <Td className="whitespace-nowrap text-xs text-muted">{formatDateTime(j.startedAt, locale)}</Td>
                  <Td className="ltr text-xs">{j.queue}</Td>
                  <Td className="ltr max-w-40 truncate font-mono text-[10px] text-muted">{j.bullJobId}</Td>
                  <Td><StatusBadge status={j.status} /></Td>
                  <Td>{j.networkMode ? <Badge tone={j.networkMode === "PROXY" ? "accent" : "neutral"}>{j.networkMode}{j.proxyStatus ? ` · ${j.proxyStatus}` : ""}</Badge> : "—"}</Td>
                  <Td className="ltr text-xs">{j.host ?? "—"}</Td>
                  <Td className="ltr text-xs tabular-nums">{j.durationMs !== null ? `${(j.durationMs / 1000).toFixed(1)}s` : "—"}</Td>
                  <Td className="tabular-nums">{j.retryCount}</Td>
                  <Td className="max-w-72 text-[11px] text-danger">{j.errorCode ? <span className="line-clamp-2"><b>{j.errorCode}</b> {j.errorMessage}</span> : null}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {total && total > 50 ? (
        <div className="mt-4 flex items-center justify-center gap-2 text-sm">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>قبلی</Button>
          <span className="text-muted">{page} / {Math.ceil(total / 50)}</span>
          <Button size="sm" variant="secondary" disabled={page >= Math.ceil(total / 50)} onClick={() => setPage((p) => p + 1)}>بعدی</Button>
        </div>
      ) : null}
    </>
  );
}
