"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clapperboard, LayoutGrid, List, Search, SquareKanban, Upload } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { Button, Card, Dialog, EmptyState, Field, Input, Select, Skeleton, Table, Tabs, Td, Textarea, Th } from "@reelflow/ui";
import { ErrorBanner, Notice, PageHeader, RightsBadge, StatusBadge } from "@/components/common";
import { ContentCard, Thumb } from "@/components/content-card";
import { ScheduleDialog } from "@/components/schedule-dialog";
import { useSession } from "@/components/session";
import { useToast } from "@/components/toast";
import { api, qs } from "@/lib/api";
import { formatDateTime, formatDuration } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { ContentDTO, SourceDTO } from "@/lib/types";

type View = "grid" | "list" | "kanban";
const RIGHTS = ["USER_OWNS", "PERMISSION_GRANTED", "LICENSED", "PUBLIC_DOMAIN", "UNKNOWN"];

function UploadDialog({ open, onClose, sources }: { open: boolean; onClose: () => void; sources: SourceDTO[] }) {
  const { t, ts } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"file" | "url">("file");
  const [rights, setRights] = useState("USER_OWNS");
  const [sourceId, setSourceId] = useState("");
  const [attribution, setAttribution] = useState("");
  const [caption, setCaption] = useState("");
  const [url, setUrl] = useState("");
  const submit = useMutation({
    mutationFn: async () => {
      if (mode === "url") return api.post("/content/import-url", { url, rightsStatus: rights, sourceId: sourceId || null, attribution: attribution || undefined, caption: caption || undefined });
      const file = fileRef.current?.files?.[0];
      if (!file) throw new Error(t("content.noFileSelected"));
      const form = new FormData();
      form.append("rightsStatus", rights);
      if (sourceId) form.append("sourceId", sourceId);
      if (attribution) form.append("attribution", attribution);
      if (caption) form.append("caption", caption);
      form.append("file", file);
      return api.upload("/content/upload", form);
    },
    onSuccess: () => {
      toast.success(t("content.importQueued"));
      qc.invalidateQueries({ queryKey: ["content"] });
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("content.addTitle")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button onClick={() => submit.mutate()} loading={submit.isPending}>{mode === "file" ? t("dash.upload") : t("content.import")}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Tabs value={mode} onChange={setMode} items={[{ value: "file", label: t("content.uploadFileTab") }, { value: "url", label: t("sources.platform.directUrl") }]} />
        {mode === "file" ? (
          <Field label={t("content.fileFieldLabel")} hint={t("content.fileFieldHint")}>
            <Input ref={fileRef} type="file" accept="video/*,image/*" className="h-auto py-1.5" />
          </Field>
        ) : (
          <>
            <Field label={t("content.mediaUrlLabel")}>
              <Input dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://cdn.example.com/clip.mp4" />
            </Field>
            <Notice>{t("content.urlNotice")}</Notice>
          </>
        )}
        <Field label={t("content.rightsLabel")}>
          <Select value={rights} onChange={(e) => setRights(e.target.value)}>
            {RIGHTS.filter((r) => mode === "file" || r !== "UNKNOWN").map((r) => <option key={r} value={r}>{ts("rights", r)}</option>)}
          </Select>
        </Field>
        <Field label={t("content.sourceOptionalLabel")}>
          <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">{t("content.noSourceOption")}</option>
            {sources.filter((s) => s.vettingStatus === "APPROVED").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        {rights !== "USER_OWNS" ? (
          <Field label={t("content.attributionLabel")} hint={t("content.attributionHint")}>
            <Input value={attribution} onChange={(e) => setAttribution(e.target.value)} placeholder="🎬 via @page" />
          </Field>
        ) : null}
        <Field label={t("content.originalCaptionLabel")}>
          <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function Kanban() {
  const { t, ts } = useI18n();
  const { data } = useQuery({ queryKey: ["content", "kanban"], queryFn: () => api.get<Record<string, (ContentDTO & { source: { name: string } | null })[]>>("/content/kanban") });
  const cols: [string, string][] = [
    ["processing", ts("status", "PROCESSING")],
    ["waiting", ts("status", "WAITING_APPROVAL")],
    ["approved", t("content.kanban.approved")],
    ["scheduled", t("content.kanban.scheduled")],
    ["published", t("content.kanban.published")],
    ["failed", ts("status", "FAILED")],
  ];
  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {cols.map(([key, label]) => (
        <div key={key} className="w-64 shrink-0 rounded-2xl border border-line bg-surface-1/60 p-3">
          <div className="mb-3 flex items-center justify-between px-1 text-xs font-semibold">
            {label}
            <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] text-muted">{data?.[key]?.length ?? 0}</span>
          </div>
          <div className="space-y-2">
            {data?.[key]?.map((c) => (
              <Link key={c.id} href={`/content/${c.id}`} className="flex gap-3 rounded-xl bg-surface-2/70 p-2 hover:bg-surface-3">
                <Thumb item={c} className="h-16 w-10 shrink-0 rounded-md" />
                <div className="min-w-0 text-xs">
                  <p className="truncate font-medium">{c.source?.name ?? t("dash.upload")}</p>
                  <p className="line-clamp-2 text-muted">{c.originalCaption ?? "—"}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function LibraryInner() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const params = useSearchParams();
  const [view, setView] = useState<View>("grid");
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState({
    sourceId: "",
    mediaType: "",
    processingStatus: "",
    approvalStatus: params.get("approvalStatus") ?? "",
    publishStatus: "",
    rightsStatus: "",
    from: "",
  });
  const [page, setPage] = useState(1);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [scheduling, setScheduling] = useState<ContentDTO | null>(null);
  const sources = useQuery({ queryKey: ["sources"], queryFn: () => api.get<SourceDTO[]>("/sources") });
  const query = qs({ ...filters, from: filters.from ? new Date(filters.from).toISOString() : undefined, q, page, pageSize: 24 });
  const { data, error, isLoading } = useQuery({
    queryKey: ["content", query],
    queryFn: () => api.get<{ items: ContentDTO[]; total: number }>(`/content${query}`),
    enabled: view !== "kanban",
    refetchInterval: 15_000,
  });
  const set = (k: keyof typeof filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / 24)) : 1;

  return (
    <>
      <PageHeader
        title={t("nav.library")}
        description={t("content.pageDescription")}
        actions={
          <>
            <Tabs
              value={view}
              onChange={setView}
              items={[
                { value: "grid", label: <LayoutGrid className="size-4" /> },
                { value: "list", label: <List className="size-4" /> },
                { value: "kanban", label: <SquareKanban className="size-4" /> },
              ]}
            />
            {can(["OWNER", "MANAGER"]) ? (
              <Button onClick={() => setUploadOpen(true)}>
                <Upload /> {t("content.addTitle")}
              </Button>
            ) : null}
          </>
        }
      />
      <ErrorBanner error={error} />
      {view !== "kanban" ? (
        <Card className="mb-6 grid gap-3 p-4 md:grid-cols-4 xl:grid-cols-9">
          <div className="relative md:col-span-2">
            <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-muted" />
            <Input className="ps-9" placeholder={t("content.searchPlaceholder")} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          </div>
          <Select value={filters.sourceId} onChange={(e) => set("sourceId", e.target.value)}>
            <option value="">{t("content.allSourcesOption")}</option>
            {sources.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Select value={filters.mediaType} onChange={(e) => set("mediaType", e.target.value)}>
            <option value="">{t("content.allMediaOption")}</option>
            <option value="VIDEO">{t("common.video")}</option>
            <option value="IMAGE">{t("common.image")}</option>
          </Select>
          <Select value={filters.processingStatus} onChange={(e) => set("processingStatus", e.target.value)}>
            <option value="">{t("content.processingStatusOption")}</option>
            {["PENDING", "PROCESSING", "READY", "FAILED"].map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Select value={filters.approvalStatus} onChange={(e) => set("approvalStatus", e.target.value)}>
            <option value="">{t("content.approvalStatusOption")}</option>
            {["PENDING", "APPROVED", "REJECTED"].map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Select value={filters.publishStatus} onChange={(e) => set("publishStatus", e.target.value)}>
            <option value="">{t("content.publishStatusOption")}</option>
            {["UNSCHEDULED", "SCHEDULED", "PUBLISHED", "FAILED"].map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Select value={filters.rightsStatus} onChange={(e) => set("rightsStatus", e.target.value)}>
            <option value="">{t("content.rightsLabel")}</option>
            {RIGHTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Input type="date" dir="ltr" aria-label={t("content.importedFromAria")} value={filters.from} onChange={(e) => set("from", e.target.value)} className="md:col-span-2 xl:col-span-1" />
        </Card>
      ) : null}

      {view === "kanban" ? (
        <Kanban />
      ) : isLoading ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6">{Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="aspect-[9/16]" />)}</div>
      ) : data?.items.length === 0 ? (
        <EmptyState icon={<Clapperboard />} title={t("content.emptyTitle")} description={t("content.emptyDesc")} />
      ) : view === "grid" ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {data?.items.map((c) => <ContentCard key={c.id} item={c} onSchedule={setScheduling} />)}
        </div>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr><Th /><Th>{t("common.source")}</Th><Th>{t("common.duration")}</Th><Th>{t("content.processingHeader")}</Th><Th>{t("common.approve")}</Th><Th>{t("common.publishing")}</Th><Th>{t("sources.rightsHeader")}</Th><Th>{t("content.import")}</Th></tr>
            </thead>
            <tbody>
              {data?.items.map((c) => (
                <tr key={c.id} className="hover:bg-surface-2/40">
                  <Td className="w-14"><Link href={`/content/${c.id}`}><Thumb item={c} className="h-14 w-9 rounded-md" /></Link></Td>
                  <Td><Link href={`/content/${c.id}`} className="font-medium hover:text-accent">{c.source?.name ?? t("dash.upload")}</Link><p className="line-clamp-1 max-w-xs text-[11px] text-muted">{c.originalCaption}</p></Td>
                  <Td className="ltr tabular-nums">{formatDuration(c.durationSec)}</Td>
                  <Td><StatusBadge status={c.processingStatus} /></Td>
                  <Td><StatusBadge status={c.approvalStatus} /></Td>
                  <Td><StatusBadge status={c.publishStatus} /></Td>
                  <Td><RightsBadge rights={c.rightsStatus} /></Td>
                  <Td className="text-xs text-muted">{formatDateTime(c.importedAt, locale)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {view !== "kanban" && pages > 1 ? (
        <div className="mt-6 flex items-center justify-center gap-2 text-sm">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t("common.previous")}</Button>
          <span className="text-muted">{page} / {pages}</span>
          <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>{t("common.next")}</Button>
        </div>
      ) : null}

      <UploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} sources={sources.data ?? []} />
      <ScheduleDialog item={scheduling} onClose={() => setScheduling(null)} />
    </>
  );
}

export default function LibraryPage() {
  return (
    <Suspense>
      <LibraryInner />
    </Suspense>
  );
}
