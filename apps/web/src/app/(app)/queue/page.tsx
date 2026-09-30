"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock, ListOrdered, Pause, Play, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button, Card, Dialog, EmptyState, Field, Input, Select, Table, Td, Th } from "@reelflow/ui";
import { ErrorBanner, PageHeader, StatusBadge } from "@/components/common";
import { Thumb } from "@/components/content-card";
import { useSession } from "@/components/session";
import { useToast } from "@/components/toast";
import { api, qs } from "@/lib/api";
import { formatDateTime, formatSlot, fromLocalInput, toLocalInput } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { PostDTO } from "@/lib/types";

const STATUSES = ["", "WAITING_APPROVAL", "SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED", "PAUSED", "CANCELLED"];

export default function QueuePage() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<PostDTO | null>(null);
  const [when, setWhen] = useState("");
  const { data, error } = useQuery({ queryKey: ["queue", status], queryFn: () => api.get<PostDTO[]>(`/queue${qs({ status })}`), refetchInterval: 10_000 });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "cancel" | "pause" | "resume" | "retry" }) => api.post(`/posts/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queue"] }),
    onError: toast.error,
  });
  const approve = useMutation({
    mutationFn: (contentId: string) => api.post(`/content/${contentId}/decision`, { decision: "APPROVED" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queue"] }),
    onError: toast.error,
  });
  const reschedule = useMutation({
    mutationFn: () => api.patch(`/posts/${editing!.id}/schedule`, { scheduledAt: fromLocalInput(when) }),
    onSuccess: () => {
      toast.success("زمان جدید ثبت شد");
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["queue"] });
    },
    onError: toast.error,
  });
  const control = can(["OWNER", "MANAGER"]);

  return (
    <>
      <PageHeader
        title={t("nav.queue")}
        description="برای جابه‌جایی زمان با کشیدن و رها کردن از تقویم استفاده کنید. همه تغییرات در گزارش‌ها ثبت می‌شوند."
        actions={
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-48">
            {STATUSES.map((s) => <option key={s} value={s}>{s ? s : "همه وضعیت‌ها"}</option>)}
          </Select>
        }
      />
      <ErrorBanner error={error} />
      <Card>
        {data?.length === 0 ? (
          <div className="p-6"><EmptyState icon={<ListOrdered />} title="صف خالی است" /></div>
        ) : (
          <Table>
            <thead>
              <tr><Th>محتوا</Th><Th>منبع</Th><Th>زمان</Th><Th>حساب</Th><Th>وضعیت</Th><Th>تلاش</Th><Th /></tr>
            </thead>
            <tbody>
              {data?.map((p) => (
                <tr key={p.id} className="hover:bg-surface-2/40">
                  <Td className="w-16">
                    {p.content ? (
                      <Link href={`/content/${p.content.id}`}>
                        <Thumb item={{ id: p.content.id, thumbnailKey: p.content.thumbnailKey, mediaType: p.content.mediaType as "VIDEO", durationSec: p.content.durationSec }} className="h-14 w-9 rounded-md" />
                      </Link>
                    ) : null}
                  </Td>
                  <Td>
                    <p className="text-sm">{p.content?.source?.name ?? "آپلود"}</p>
                    <p className="text-[11px] text-muted">{p.kind}{p.autoScheduled ? " · خودکار" : ""}</p>
                  </Td>
                  <Td>
                    <p className="text-sm">{formatSlot(p.scheduledAt, locale)}</p>
                    <p className="text-[11px] text-muted">{formatDateTime(p.scheduledAt, locale)}</p>
                    {p.nextAttemptAt ? <p className="text-[11px] text-warning">تلاش بعدی: {formatDateTime(p.nextAttemptAt, locale)}</p> : null}
                  </Td>
                  <Td className="text-sm">{p.account?.name}</Td>
                  <Td>
                    <StatusBadge status={p.status} />
                    {p.lastErrorMessage ? <p className="mt-1 line-clamp-2 max-w-60 text-[11px] text-warning" title={p.lastErrorMessage}>{p.lastErrorMessage}</p> : null}
                    {p.permalink ? <a href={p.permalink} target="_blank" rel="noreferrer noopener" className="mt-1 block text-[11px] text-accent">مشاهده پست ↗</a> : null}
                  </Td>
                  <Td className="tabular-nums">{p.retryCount}</Td>
                  <Td>
                    {control ? (
                      <div className="flex justify-end gap-1">
                        {p.status === "WAITING_APPROVAL" && p.content ? <Button size="sm" variant="success" title="تأیید" onClick={() => approve.mutate(p.content!.id)}><Check /></Button> : null}
                        {["SCHEDULED", "WAITING_APPROVAL", "PAUSED", "FAILED"].includes(p.status) ? (
                          <Button size="sm" variant="ghost" title="ویرایش زمان" onClick={() => { setEditing(p); setWhen(toLocalInput(p.scheduledAt)); }}><Clock /></Button>
                        ) : null}
                        {["SCHEDULED", "WAITING_APPROVAL"].includes(p.status) ? <Button size="sm" variant="ghost" title="توقف" onClick={() => act.mutate({ id: p.id, action: "pause" })}><Pause /></Button> : null}
                        {p.status === "PAUSED" ? <Button size="sm" variant="ghost" title="ادامه" onClick={() => act.mutate({ id: p.id, action: "resume" })}><Play /></Button> : null}
                        {p.status === "FAILED" ? <Button size="sm" variant="ghost" title="تلاش دوباره" onClick={() => act.mutate({ id: p.id, action: "retry" })}><RotateCcw /></Button> : null}
                        {["SCHEDULED", "WAITING_APPROVAL", "PAUSED", "FAILED"].includes(p.status) ? <Button size="sm" variant="ghost" title="لغو" onClick={() => act.mutate({ id: p.id, action: "cancel" })}><X /></Button> : null}
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title="تغییر زمان انتشار"
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>انصراف</Button><Button onClick={() => reschedule.mutate()} loading={reschedule.isPending}>ذخیره</Button></>}
      >
        <Field label="زمان جدید (به وقت تهران)" hint="در صورت نقض سقف‌های انتشار، تغییر رد می‌شود.">
          <Input type="datetime-local" dir="ltr" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}
