"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FolderInput, Globe, Pencil, Plus, RefreshCw, ShieldQuestion, X } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Switch, Table, Td, Textarea, Th } from "@reelflow/ui";
import { ErrorBanner, Notice, PageHeader, RightsBadge, StatusBadge } from "@/components/common";
import { useSession } from "@/components/session";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { SourceDTO } from "@/lib/types";

const PLATFORMS = [
  { value: "LOCAL", label: "پوشه ورودی (فایل‌های ارسالی صاحب پیج)" },
  { value: "GENERIC_FEED", label: "فید RSS / Atom / JSON" },
  { value: "INSTAGRAM", label: "اینستاگرام (فقط ثبت منبع — دانلود خودکار پشتیبانی نمی‌شود)" },
  { value: "DIRECT_URL", label: "لینک مستقیم" },
];
const RIGHTS = ["UNKNOWN", "USER_OWNS", "PERMISSION_GRANTED", "LICENSED", "PUBLIC_DOMAIN", "DO_NOT_IMPORT"];

type Form = {
  name: string;
  url: string;
  platform: string;
  active: boolean;
  allowedMediaTypes: string[];
  importFrequencyMinutes: number;
  maxItemsPerInterval: number;
  approvalRequired: boolean;
  attributionRequired: boolean;
  attributionText: string;
  rightsStatus: string;
  rightsEvidence: string;
  notes: string;
};

const empty: Form = {
  name: "",
  url: "",
  platform: "LOCAL",
  active: true,
  allowedMediaTypes: ["VIDEO"],
  importFrequencyMinutes: 360,
  maxItemsPerInterval: 5,
  approvalRequired: true,
  attributionRequired: true,
  attributionText: "",
  rightsStatus: "UNKNOWN",
  rightsEvidence: "",
  notes: "",
};

function SourceDialog({ source, onClose }: { source: SourceDTO | null | "new"; onClose: () => void }) {
  const { ts } = useI18n();
  const { user } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const initial: Form =
    source && source !== "new"
      ? {
          name: source.name,
          url: source.url ?? "",
          platform: source.platform,
          active: source.active,
          allowedMediaTypes: source.config?.allowedMediaTypes ?? ["VIDEO"],
          importFrequencyMinutes: source.config?.importFrequencyMinutes ?? 360,
          maxItemsPerInterval: source.config?.maxItemsPerInterval ?? 5,
          approvalRequired: source.approvalRequired,
          attributionRequired: source.attributionRequired,
          attributionText: source.attributionText ?? "",
          rightsStatus: source.rightsStatus,
          rightsEvidence: source.rightsEvidence ?? "",
          notes: source.notes ?? "",
        }
      : empty;
  const [f, setF] = useState<Form>(initial);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, url: f.url.trim() || null, attributionText: f.attributionText || null, rightsEvidence: f.rightsEvidence || null, notes: f.notes || null };
      return source && source !== "new" ? api.put(`/sources/${source.id}`, body) : api.post("/sources", body);
    },
    onSuccess: () => {
      toast.success(user.role === "OWNER" ? "منبع ذخیره شد" : "منبع ثبت شد و منتظر تأیید مالک است");
      qc.invalidateQueries({ queryKey: ["sources"] });
      onClose();
    },
    onError: toast.error,
  });
  const needsUrl = f.platform !== "LOCAL";

  return (
    <Dialog
      open={!!source}
      onClose={onClose}
      wide
      title={source === "new" ? "افزودن منبع" : "ویرایش منبع"}
      description="هر منبع قبل از هرگونه ورود محتوا باید توسط مالک سیستم تأیید شود."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>انصراف</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.name || (needsUrl && !f.url)}>ذخیره</Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="نام منبع">
          <Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Fitness Page 1" />
        </Field>
        <Field label="نوع منبع">
          <Select value={f.platform} onChange={(e) => set("platform", e.target.value)}>
            {PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
        </Field>
        {needsUrl ? (
          <Field label="آدرس منبع" className="md:col-span-2" hint="فقط آدرس‌های عمومی http/https مجازند. آدرس‌های داخلی شبکه مسدود می‌شوند.">
            <Input dir="ltr" value={f.url} onChange={(e) => set("url", e.target.value)} placeholder="https://example.com/feed.xml" />
          </Field>
        ) : (
          <Notice className="md:col-span-2">
            فایل‌هایی را که صاحب پیج با اجازه برایتان فرستاده در پوشه <span className="ltr font-mono">storage/inbox/{(f.name || "source").toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}/</span> قرار دهید. یک فایل <span className="ltr">.txt</span> هم‌نام، کپشن را مشخص می‌کند.
          </Notice>
        )}
        {f.platform === "INSTAGRAM" ? (
          <Notice tone="warning" className="md:col-span-2">
            API رسمی اینستاگرام اجازه دانلود محتوای پیج‌هایی را که مدیریت نمی‌کنید نمی‌دهد و قوانین اینستاگرام جمع‌آوری خودکار را ممنوع کرده است. ReelFlow برای این کار راه دور زدن نمی‌سازد: فایل‌ها را از صاحب پیج بگیرید و آپلود کنید یا در پوشه ورودی بگذارید.
          </Notice>
        ) : null}

        <Field label="وضعیت حقوق محتوا (الزامی)" hint="لینک عمومی به معنای اجازه بازنشر نیست.">
          <Select value={f.rightsStatus} onChange={(e) => set("rightsStatus", e.target.value)}>
            {RIGHTS.map((r) => <option key={r} value={r}>{ts("rights", r)}</option>)}
          </Select>
        </Field>
        <Field label="مدرک اجازه" hint="مثلاً: پیام دایرکت ۱۴۰۵/۰۷/۰۱ که اجازه بازنشر با ذکر منبع داده">
          <Input value={f.rightsEvidence} onChange={(e) => set("rightsEvidence", e.target.value)} />
        </Field>

        <Field label="متن ذکر منبع" hint="در کپشن محتوای این منبع درج می‌شود">
          <Input value={f.attributionText} onChange={(e) => set("attributionText", e.target.value)} placeholder="🎬 via @funnypage" />
        </Field>
        <Field label="نوع محتوای مجاز">
          <div className="flex h-9 items-center gap-4 text-sm">
            {["VIDEO", "IMAGE"].map((m) => (
              <label key={m} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={f.allowedMediaTypes.includes(m)}
                  onChange={(e) => set("allowedMediaTypes", e.target.checked ? [...f.allowedMediaTypes, m] : f.allowedMediaTypes.filter((x) => x !== m))}
                />
                {m === "VIDEO" ? "ویدیو" : "تصویر"}
              </label>
            ))}
          </div>
        </Field>
        <Field label="فاصله بررسی (دقیقه)">
          <Input type="number" min={15} value={f.importFrequencyMinutes} onChange={(e) => set("importFrequencyMinutes", Number(e.target.value))} />
        </Field>
        <Field label="حداکثر آیتم در هر بررسی">
          <Input type="number" min={1} max={50} value={f.maxItemsPerInterval} onChange={(e) => set("maxItemsPerInterval", Number(e.target.value))} />
        </Field>
        <div className="flex flex-col gap-3 md:col-span-2">
          {[
            ["active", "فعال"],
            ["approvalRequired", "هر محتوا نیاز به تأیید دستی دارد"],
            ["attributionRequired", "ذکر منبع در کپشن الزامی است"],
          ].map(([k, label]) => (
            <label key={k} className="flex items-center justify-between rounded-xl bg-surface-2 px-4 py-2.5 text-sm">
              {label}
              <Switch checked={f[k as "active"] as boolean} onCheckedChange={(v) => set(k as "active", v)} />
            </label>
          ))}
        </div>
        <Field label="یادداشت" className="md:col-span-2">
          <Textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

export default function SourcesPage() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<SourceDTO | null | "new">(null);
  const [filter, setFilter] = useState("");
  const { data, error } = useQuery({ queryKey: ["sources", filter], queryFn: () => api.get<SourceDTO[]>(`/sources${filter ? `?vettingStatus=${filter}` : ""}`) });

  const review = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "APPROVED" | "REJECTED" }) => api.post(`/sources/${id}/review`, { decision }),
    onSuccess: () => {
      toast.success("بررسی ثبت شد");
      qc.invalidateQueries({ queryKey: ["sources"] });
    },
    onError: toast.error,
  });
  const discover = useMutation({
    mutationFn: (id: string) => api.post(`/sources/${id}/discover`),
    onSuccess: () => toast.success("بررسی منبع در صف قرار گرفت"),
    onError: toast.error,
  });
  const pending = data?.filter((s) => s.vettingStatus === "PENDING_REVIEW").length ?? 0;

  return (
    <>
      <PageHeader
        title={t("nav.sources")}
        description="پیج‌ها و منابعی که محتوا از آن‌ها وارد می‌شود. مدیر می‌تواند منبع پیشنهاد دهد؛ فقط مالک سیستم آن را تأیید می‌کند."
        actions={
          can(["OWNER", "MANAGER"]) ? (
            <Button onClick={() => setEditing("new")}>
              <Plus /> افزودن منبع
            </Button>
          ) : null
        }
      />
      <ErrorBanner error={error} />
      {pending > 0 && can(["OWNER"]) ? (
        <Notice tone="warning" className="mb-4">
          {pending} منبع در انتظار بررسی شماست. تا تأیید نکنید، هیچ محتوایی از آن‌ها وارد یا منتشر نمی‌شود.
        </Notice>
      ) : null}
      <div className="mb-4 flex gap-2">
        {["", "PENDING_REVIEW", "APPROVED", "REJECTED"].map((v) => (
          <Button key={v} size="sm" variant={filter === v ? "secondary" : "ghost"} onClick={() => setFilter(v)}>
            {v ? <StatusBadge status={v} /> : "همه"}
          </Button>
        ))}
      </div>
      <Card>
        {data?.length === 0 ? (
          <div className="p-6">
            <EmptyState icon={<Globe />} title="منبعی ثبت نشده" description="با افزودن یک پوشه ورودی یا فید شروع کنید." />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>منبع</Th>
                <Th>وضعیت بررسی</Th>
                <Th>حقوق</Th>
                <Th>محتوا</Th>
                <Th>آخرین بررسی</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {data?.map((s) => (
                <tr key={s.id} className="hover:bg-surface-2/40">
                  <Td>
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg bg-surface-2 p-2 text-muted">{s.platform === "LOCAL" ? <FolderInput className="size-4" /> : <Globe className="size-4" />}</div>
                      <div className="min-w-0">
                        <p className="font-medium">{s.name} {!s.active ? <Badge className="ms-1">غیرفعال</Badge> : null}</p>
                        <p className="ltr truncate text-[11px] text-muted">{s.url ?? s.platform}</p>
                        {s.lastError ? <p className="mt-1 max-w-md text-[11px] text-warning">{s.lastError}</p> : null}
                      </div>
                    </div>
                  </Td>
                  <Td><StatusBadge status={s.vettingStatus} /></Td>
                  <Td>
                    <div className="flex items-center gap-1.5">
                      <RightsBadge rights={s.rightsStatus} />
                      {s.rightsStatus === "UNKNOWN" ? <ShieldQuestion className="size-4 text-warning" aria-label="حقوق نامشخص — انتشار خودکار مسدود است" /> : null}
                    </div>
                  </Td>
                  <Td className="tabular-nums">{s.contentCount ?? 0}</Td>
                  <Td className="text-xs text-muted">{formatRelative(s.lastDiscoveryAt, locale)}</Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      {can(["OWNER"]) && s.vettingStatus !== "APPROVED" ? (
                        <Button size="sm" variant="success" onClick={() => review.mutate({ id: s.id, decision: "APPROVED" })}>
                          <Check /> تأیید
                        </Button>
                      ) : null}
                      {can(["OWNER"]) && s.vettingStatus !== "REJECTED" ? (
                        <Button size="sm" variant="ghost" onClick={() => review.mutate({ id: s.id, decision: "REJECTED" })} aria-label="رد">
                          <X />
                        </Button>
                      ) : null}
                      {s.vettingStatus === "APPROVED" && can(["OWNER", "MANAGER"]) ? (
                        <Button size="sm" variant="ghost" onClick={() => discover.mutate(s.id)} aria-label="بررسی اکنون">
                          <RefreshCw />
                        </Button>
                      ) : null}
                      {can(["OWNER", "MANAGER"]) ? (
                        <Button size="sm" variant="ghost" onClick={() => setEditing(s)} aria-label="ویرایش">
                          <Pencil />
                        </Button>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {editing ? <SourceDialog source={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}
