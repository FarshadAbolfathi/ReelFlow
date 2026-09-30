"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CalendarPlus, Check, CircleCheck, CircleX, Copy, ExternalLink, RefreshCcw, X } from "lucide-react";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, Skeleton, Textarea } from "@reelflow/ui";
import { ErrorBanner, Notice, RightsBadge, StatusBadge } from "@/components/common";
import { ScheduleDialog } from "@/components/schedule-dialog";
import { useSession } from "@/components/session";
import { useToast } from "@/components/toast";
import { api, media } from "@/lib/api";
import { formatBytes, formatDateTime, formatDuration, formatSlot } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { ContentDTO, PostDTO, TemplateDTO, WatermarkPresetDTO } from "@/lib/types";

interface Preview {
  item: ContentDTO & { duplicateIngests: { id: string; url: string | null; createdAt: string; errorMessage: string | null }[]; source: { name: string; attributionText: string | null } | null };
  caption: string;
  posts: (PostDTO & { gate: { allowed: boolean; violations: { code: string; message: string }[]; retryAt: string | null } })[];
}

function MediaPane({ title, src, kind, empty }: { title: string; src: string | null; kind: "VIDEO" | "IMAGE"; empty: string }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-muted">{title}</p>
      <div className="flex aspect-[9/16] items-center justify-center overflow-hidden rounded-xl border border-line bg-black">
        {src ? (
          kind === "VIDEO" ? <video src={src} controls playsInline preload="metadata" className="size-full object-contain" /> : <img src={src} alt="" className="size-full object-contain" />
        ) : (
          <p className="p-6 text-center text-xs text-muted">{empty}</p>
        )}
      </div>
    </div>
  );
}

export default function ContentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { locale } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ["content", id, "preview"], queryFn: () => api.get<Preview>(`/content/${id}/preview`), refetchInterval: 10_000 });
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api.get<TemplateDTO[]>("/templates") });
  const watermarks = useQuery({ queryKey: ["watermarks"], queryFn: () => api.get<WatermarkPresetDTO[]>("/watermarks") });
  const [scheduling, setScheduling] = useState(false);
  const [caption, setCaption] = useState({ customCaption: "", captionTemplateId: "", hashtags: "", cta: "", attribution: "" });
  const [wmPreset, setWmPreset] = useState<string>("");
  const [preset, setPreset] = useState("INSTAGRAM_REEL");

  useEffect(() => {
    if (!data) return;
    const c = data.item;
    setCaption({ customCaption: c.customCaption ?? "", captionTemplateId: c.captionTemplateId ?? "", hashtags: c.hashtags.join(" "), cta: c.cta ?? "", attribution: c.attribution ?? "" });
  }, [data?.item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => qc.invalidateQueries({ queryKey: ["content", id] });
  const saveCaption = useMutation({
    mutationFn: () =>
      api.patch(`/content/${id}/caption`, {
        customCaption: caption.customCaption || null,
        captionTemplateId: caption.captionTemplateId || null,
        hashtags: caption.hashtags.split(/\s+/).map((h) => h.replace(/^#/, "")).filter(Boolean),
        cta: caption.cta || null,
        attribution: caption.attribution || null,
      }),
    onSuccess: () => {
      toast.success("کپشن ذخیره شد");
      refresh();
    },
    onError: toast.error,
  });
  const decide = useMutation({
    mutationFn: (decision: "APPROVED" | "REJECTED") => api.post(`/content/${id}/decision`, { decision }),
    onSuccess: refresh,
    onError: toast.error,
  });
  const reprocess = useMutation({
    mutationFn: () => api.post(`/content/${id}/process`, { presetKey: preset, watermarkPresetId: wmPreset === "none" ? null : wmPreset || undefined, force: true }),
    onSuccess: () => {
      toast.success("پردازش مجدد در صف قرار گرفت");
      refresh();
    },
    onError: toast.error,
  });

  if (isLoading) return <Skeleton className="h-[70vh]" />;
  if (!data) return <ErrorBanner error={error} />;
  const c = data.item;
  const processed = c.assets?.find((a) => a.kind === "PROCESSED");
  const previewAsset = c.assets?.find((a) => a.kind === "PREVIEW");

  return (
    <>
      <Link href="/content" className="mb-4 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ArrowRight className="size-3.5" /> کتابخانه
      </Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{c.source?.name ?? "آپلود"} {c.author ? <span className="ltr text-base text-muted">@{c.author}</span> : null}</h1>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusBadge status={c.processingStatus} />
            <StatusBadge status={c.approvalStatus} />
            <StatusBadge status={c.publishStatus} />
            <RightsBadge rights={c.rightsStatus} />
            {c.duplicateOfId ? <Badge tone="danger">تکراری</Badge> : null}
          </div>
        </div>
        {can(["OWNER", "MANAGER"]) ? (
          <div className="flex flex-wrap gap-2">
            {c.approvalStatus !== "APPROVED" && !c.duplicateOfId ? (
              <Button variant="success" onClick={() => decide.mutate("APPROVED")} loading={decide.isPending}><Check /> تأیید</Button>
            ) : null}
            {c.approvalStatus !== "REJECTED" ? <Button variant="danger" onClick={() => decide.mutate("REJECTED")}><X /> رد</Button> : null}
            <Button variant="secondary" onClick={() => setScheduling(true)} disabled={!!c.duplicateOfId}><CalendarPlus /> زمان‌بندی</Button>
          </div>
        ) : null}
      </div>
      <ErrorBanner error={error} />
      {c.duplicateOfId ? (
        <Notice tone="warning" className="mb-4">
          این مورد تکراری است و نسخه دومی ذخیره نشد. <Link className="underline" href={`/content/${c.duplicateOfId}`}>مشاهده نسخه اصلی</Link>
        </Notice>
      ) : null}
      {c.lastError ? <Notice tone="danger" className="mb-4">{c.lastError}</Notice> : null}

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>پیش‌نمایش نهایی</CardTitle>
              <CardDescription>مقایسه نسخه اصلی و نسخه پردازش‌شده (با واترمارک)</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <MediaPane title="اصلی" src={c.originalKey ? media.original(c.id) : null} kind={c.mediaType} empty="فایل اصلی طبق سیاست نگهداری حذف شده" />
              <MediaPane title="پردازش‌شده" src={processed ? media.asset((c.mediaType === "VIDEO" ? previewAsset ?? processed : processed).id) : null} kind={c.mediaType} empty="هنوز پردازش نشده" />
            </div>
            <div className="mt-5 rounded-xl border border-line bg-surface-0 p-4" id="caption-preview">
              <p className="mb-2 text-xs font-medium text-muted">کپشن نهایی (همان‌طور که منتشر می‌شود)</p>
              <p className="whitespace-pre-wrap text-sm leading-7">{data.caption || <span className="text-muted">— بدون کپشن —</span>}</p>
            </div>
            {data.posts.length ? (
              <div className="mt-5 space-y-3">
                <p className="text-xs font-medium text-muted">پست‌های برنامه‌ریزی‌شده</p>
                {data.posts.map((p) => (
                  <div key={p.id} className="rounded-xl bg-surface-2 p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>{p.account?.name} · {formatSlot(p.scheduledAt, locale)} · {p.kind}</span>
                      <StatusBadge status={p.status} />
                    </div>
                    <div className="mt-2 text-xs">
                      {p.gate.allowed ? (
                        <p className="flex items-center gap-1.5 text-success"><CircleCheck className="size-3.5" /> همه بررسی‌های سیاست انتشار قبول است</p>
                      ) : (
                        <ul className="space-y-1 text-warning">
                          {p.gate.violations.map((v, i) => <li key={i} className="flex items-start gap-1.5"><CircleX className="mt-0.5 size-3.5 shrink-0" /> {v.message}</li>)}
                        </ul>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card id="caption">
            <CardHeader><CardTitle>کپشن</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Field label="قالب">
                <Select value={caption.captionTemplateId} onChange={(e) => setCaption((x) => ({ ...x, captionTemplateId: e.target.value }))}>
                  <option value="">پیش‌فرض</option>
                  {templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              </Field>
              <Field label="کپشن سفارشی" hint="اگر پر شود، به جای قالب استفاده می‌شود">
                <Textarea value={caption.customCaption} onChange={(e) => setCaption((x) => ({ ...x, customCaption: e.target.value }))} />
              </Field>
              <Field label="هشتگ‌ها">
                <Input value={caption.hashtags} onChange={(e) => setCaption((x) => ({ ...x, hashtags: e.target.value }))} placeholder="#funny #reels" />
              </Field>
              <Field label="دعوت به اقدام (CTA)">
                <Input value={caption.cta} onChange={(e) => setCaption((x) => ({ ...x, cta: e.target.value }))} />
              </Field>
              <Field label="ذکر منبع" hint="برای محتوای دیگران همیشه در کپشن می‌آید — مالکیت محتوای دیگران ادعا نمی‌شود.">
                <Input value={caption.attribution} onChange={(e) => setCaption((x) => ({ ...x, attribution: e.target.value }))} placeholder={c.source?.attributionText ?? "🎬 @page"} />
              </Field>
              {can(["OWNER", "MANAGER"]) ? <Button className="w-full" onClick={() => saveCaption.mutate()} loading={saveCaption.isPending}>ذخیره کپشن</Button> : null}
            </CardContent>
          </Card>

          <Card id="watermark">
            <CardHeader><CardTitle>پردازش و واترمارک</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Field label="قالب خروجی">
                <Select value={preset} onChange={(e) => setPreset(e.target.value)}>
                  <option value="INSTAGRAM_REEL">Instagram Reel (9:16)</option>
                  <option value="INSTAGRAM_FEED">Instagram Feed (4:5)</option>
                  <option value="INSTAGRAM_STORY">Instagram Story (9:16)</option>
                </Select>
              </Field>
              <Field label="واترمارک">
                <Select value={wmPreset} onChange={(e) => setWmPreset(e.target.value)}>
                  <option value="">پیش‌فرض</option>
                  <option value="none">بدون واترمارک</option>
                  {watermarks.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </Select>
              </Field>
              {can(["OWNER", "MANAGER"]) ? (
                <Button variant="secondary" className="w-full" onClick={() => reprocess.mutate()} loading={reprocess.isPending} disabled={!c.originalKey}>
                  <RefreshCcw /> پردازش مجدد
                </Button>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>مشخصات</CardTitle></CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-y-2 text-xs">
                <dt className="text-muted">مدت</dt><dd className="ltr text-end">{formatDuration(c.durationSec)}</dd>
                <dt className="text-muted">ابعاد</dt><dd className="ltr text-end">{c.width}×{c.height}</dd>
                <dt className="text-muted">حجم</dt><dd className="ltr text-end">{formatBytes(c.fileSize)}</dd>
                <dt className="text-muted">ورود</dt><dd className="text-end">{formatDateTime(c.importedAt, locale)}</dd>
                <dt className="text-muted">SHA-256</dt>
                <dd className="ltr flex items-center justify-end gap-1 truncate font-mono text-[10px]">
                  {c.checksum?.slice(0, 16)}…
                  <button onClick={() => navigator.clipboard.writeText(c.checksum ?? "")} aria-label="copy"><Copy className="size-3" /></button>
                </dd>
                {c.originalUrl ? (
                  <>
                    <dt className="text-muted">لینک اصلی</dt>
                    <dd className="text-end"><a href={c.originalUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent">باز کردن <ExternalLink className="size-3" /></a></dd>
                  </>
                ) : null}
              </dl>
              {data.item.duplicateIngests.length ? (
                <div className="mt-4 border-t border-line pt-3 text-xs">
                  <p className="mb-2 text-muted">ورودهای تکراری که به این مورد پیوند شدند: {data.item.duplicateIngests.length}</p>
                  <ul className="space-y-1">
                    {data.item.duplicateIngests.slice(0, 5).map((d) => (
                      <li key={d.id} className="flex justify-between gap-2 text-[11px] text-muted">
                        <span className="truncate">{d.errorMessage?.split(" of ")[0] ?? "Duplicate"}</span>
                        <span>{formatDateTime(d.createdAt, locale)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
      {scheduling ? <ScheduleDialog item={c} onClose={() => setScheduling(false)} /> : null}
    </>
  );
}
