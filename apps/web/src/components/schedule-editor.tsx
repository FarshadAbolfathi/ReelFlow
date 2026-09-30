"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Wand2 } from "lucide-react";
import { useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Dialog, Field, Input, Select, Switch } from "@reelflow/ui";
import { api } from "@/lib/api";
import type { AccountDTO, Limits, SourceDTO } from "@/lib/types";
import { Notice } from "./common";
import { useSession } from "./session";
import { useToast } from "./toast";

const DAYS: [string, string][] = [
  ["SAT", "شنبه"],
  ["SUN", "یکشنبه"],
  ["MON", "دوشنبه"],
  ["TUE", "سه‌شنبه"],
  ["WED", "چهارشنبه"],
  ["THU", "پنجشنبه"],
  ["FRI", "جمعه"],
];

interface DayPlan {
  times: string[];
  windows: { start: string; end: string }[];
  postsInWindows: number;
}

interface ScheduleDTO {
  id: string;
  name: string;
  accountId: string;
  timezone: string;
  active: boolean;
  postsPerDay: number;
  minIntervalMinutes: number;
  maxIntervalMinutes: number | null;
  config: { days: Record<string, DayPlan>; sourceWeights: Record<string, number> };
  account: { name: string };
}

type Draft = Omit<ScheduleDTO, "id" | "account" | "config"> & { days: Record<string, DayPlan>; sourceWeights: Record<string, number> };

const blankDay = (): DayPlan => ({ times: [], windows: [], postsInWindows: 0 });

function Editor({ initial, id, onClose, limits }: { initial: Draft; id: string | null; onClose: () => void; limits: Limits | undefined }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(initial);
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<AccountDTO[]>("/accounts") });
  const sources = useQuery({ queryKey: ["sources"], queryFn: () => api.get<SourceDTO[]>("/sources") });
  const setDay = (day: string, plan: DayPlan) => setD((x) => ({ ...x, days: { ...x.days, [day]: plan } }));
  const save = useMutation({
    mutationFn: () => {
      const days = Object.fromEntries(Object.entries(d.days).filter(([, p]) => p.times.length || (p.windows.length && p.postsInWindows)));
      const body = { ...d, days, contentKindWeights: {} };
      return id ? api.put(`/schedules/${id}`, body) : api.post("/schedules", body);
    },
    onSuccess: () => {
      toast.success("برنامه انتشار ذخیره شد");
      qc.invalidateQueries({ queryKey: ["schedules"] });
      onClose();
    },
    onError: toast.error,
  });

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={id ? "ویرایش برنامه انتشار" : "برنامه انتشار جدید"}
      description="زمان‌ها به وقت منطقه زمانی برنامه هستند. سقف‌های مالک همیشه اعمال می‌شوند."
      footer={<><Button variant="secondary" onClick={onClose}>انصراف</Button><Button onClick={() => save.mutate()} loading={save.isPending}>ذخیره</Button></>}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="نام"><Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
        <Field label="حساب">
          <Select value={d.accountId} onChange={(e) => setD({ ...d, accountId: e.target.value })}>
            <option value="">انتخاب کنید</option>
            {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <Field label="منطقه زمانی"><Input dir="ltr" value={d.timezone} onChange={(e) => setD({ ...d, timezone: e.target.value })} /></Field>
        <Field label="پست در روز" hint={limits ? `حداکثر مجاز: ${limits.maxPostsPerDay}` : undefined}>
          <Input type="number" min={1} max={limits?.maxPostsPerDay} value={d.postsPerDay} onChange={(e) => setD({ ...d, postsPerDay: Number(e.target.value) })} />
        </Field>
        <Field label="حداقل فاصله (دقیقه)" hint={limits ? `حداقل مجاز: ${limits.minPostIntervalMinutes}` : undefined}>
          <Input type="number" min={limits?.minPostIntervalMinutes} value={d.minIntervalMinutes} onChange={(e) => setD({ ...d, minIntervalMinutes: Number(e.target.value) })} />
        </Field>
        <Field label="حداکثر فاصله (دقیقه، اختیاری)">
          <Input type="number" value={d.maxIntervalMinutes ?? ""} onChange={(e) => setD({ ...d, maxIntervalMinutes: e.target.value ? Number(e.target.value) : null })} />
        </Field>
      </div>

      <div className="mt-6 space-y-2">
        <p className="text-xs font-medium text-muted">روزها و ساعت‌ها</p>
        {DAYS.map(([key, label]) => {
          const plan = d.days[key] ?? blankDay();
          return (
            <div key={key} className="grid items-start gap-3 rounded-xl bg-surface-2 p-3 md:grid-cols-[6rem_1fr_1fr]">
              <p className="pt-2 text-sm font-medium">{label}</p>
              <div>
                <div className="flex flex-wrap gap-2">
                  {plan.times.map((t, i) => (
                    <span key={i} className="flex items-center gap-1 rounded-lg bg-surface-0 px-2 py-1">
                      <input type="time" dir="ltr" value={t} onChange={(e) => setDay(key, { ...plan, times: plan.times.map((x, j) => (j === i ? e.target.value : x)).sort() })} className="bg-transparent text-xs" />
                      <button onClick={() => setDay(key, { ...plan, times: plan.times.filter((_, j) => j !== i) })} className="text-muted hover:text-danger" aria-label="remove"><Trash2 className="size-3" /></button>
                    </span>
                  ))}
                  <Button size="sm" variant="ghost" onClick={() => setDay(key, { ...plan, times: [...plan.times, "12:00"].sort() })}><Plus /> ساعت</Button>
                </div>
              </div>
              <div className="text-xs">
                {plan.times.length === 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted">یا بازه:</span>
                    <input type="time" dir="ltr" className="rounded bg-surface-0 px-2 py-1" value={plan.windows[0]?.start ?? ""} onChange={(e) => setDay(key, { ...plan, windows: [{ start: e.target.value, end: plan.windows[0]?.end ?? "22:00" }] })} />
                    <span>تا</span>
                    <input type="time" dir="ltr" className="rounded bg-surface-0 px-2 py-1" value={plan.windows[0]?.end ?? ""} onChange={(e) => setDay(key, { ...plan, windows: [{ start: plan.windows[0]?.start ?? "10:00", end: e.target.value }] })} />
                    <input type="number" min={0} max={10} className="w-14 rounded bg-surface-0 px-2 py-1" value={plan.postsInWindows} onChange={(e) => setDay(key, { ...plan, postsInWindows: Number(e.target.value) })} aria-label="posts in window" />
                    <span className="text-muted">پست</span>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6">
        <p className="mb-2 text-xs font-medium text-muted">سهم منابع (وزن نسبی؛ ۰ = هرگز)</p>
        <div className="grid gap-2 md:grid-cols-3">
          {sources.data?.filter((s) => s.vettingStatus === "APPROVED").map((s) => (
            <label key={s.id} className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs">
              <span className="truncate">{s.name}</span>
              <input type="number" min={0} max={100} className="w-16 rounded bg-surface-0 px-2 py-1" value={d.sourceWeights[s.id] ?? 1} onChange={(e) => setD({ ...d, sourceWeights: { ...d.sourceWeights, [s.id]: Number(e.target.value) } })} />
            </label>
          ))}
        </div>
      </div>
      <label className="mt-6 flex items-center justify-between rounded-xl bg-surface-2 px-4 py-3 text-sm">
        فعال
        <Switch checked={d.active} onCheckedChange={(v) => setD({ ...d, active: v })} />
      </label>
    </Dialog>
  );
}

export function SchedulesPanel() {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: () => api.get<ScheduleDTO[]>("/schedules") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ effectiveLimits: Limits; settings: { publishing: { autoPublishEnabled: boolean } } }>("/settings") });
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const fill = useMutation({
    mutationFn: (id: string) => api.post<{ created: number }>(`/schedules/${id}/fill`, { horizonDays: 3 }),
    onSuccess: (r) => {
      toast.success(`${r.created} پست در جاهای خالی ۳ روز آینده قرار گرفت`);
      qc.invalidateQueries({ queryKey: ["queue"] });
    },
    onError: toast.error,
  });
  const newDraft = (): Draft => ({
    name: "برنامه اصلی",
    accountId: "",
    timezone: "Asia/Tehran",
    active: true,
    postsPerDay: Math.min(3, settings.data?.effectiveLimits.maxPostsPerDay ?? 3),
    minIntervalMinutes: settings.data?.effectiveLimits.minPostIntervalMinutes ?? 90,
    maxIntervalMinutes: null,
    days: Object.fromEntries(DAYS.map(([k]) => [k, { times: ["10:00", "16:00", "21:00"], windows: [], postsInWindows: 0 }])),
    sourceWeights: {},
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>برنامه‌های انتشار</CardTitle>
        {can(["OWNER", "MANAGER"]) ? <Button size="sm" onClick={() => setEditing({ id: null, draft: newDraft() })}><Plus /> برنامه جدید</Button> : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {settings.data && !settings.data.settings.publishing.autoPublishEnabled ? (
          <Notice>انتشار خودکار خاموش است: برنامه‌ها فقط وقتی دکمه «پر کردن» را بزنید پست می‌سازند. برای پر شدن خودکار، آن را در تنظیمات روشن کنید.</Notice>
        ) : null}
        {schedules.data?.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface-2 px-4 py-3 text-sm">
            <div>
              <p className="font-medium">{s.name} {!s.active ? <span className="text-xs text-muted">(غیرفعال)</span> : null}</p>
              <p className="text-xs text-muted">{s.account.name} · {s.postsPerDay} پست در روز · فاصله حداقل {s.minIntervalMinutes} دقیقه · <span className="ltr">{s.timezone}</span></p>
            </div>
            {can(["OWNER", "MANAGER"]) ? (
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => fill.mutate(s.id)} loading={fill.isPending}><Wand2 /> پر کردن ۳ روز آینده</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ id: s.id, draft: { ...s, days: s.config.days ?? {}, sourceWeights: s.config.sourceWeights ?? {} } })}>ویرایش</Button>
              </div>
            ) : null}
          </div>
        ))}
        {schedules.data?.length === 0 ? <p className="text-xs text-muted">هنوز برنامه‌ای ساخته نشده است.</p> : null}
      </CardContent>
      {editing ? <Editor initial={editing.draft} id={editing.id} onClose={() => setEditing(null)} limits={settings.data?.effectiveLimits} /> : null}
    </Card>
  );
}
