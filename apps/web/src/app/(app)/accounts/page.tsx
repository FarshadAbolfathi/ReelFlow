"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Link2Off, Play, Plus, RefreshCw, ShieldCheck, UserCircle2 } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, Dialog, EmptyState, Field, Input } from "@reelflow/ui";
import { ErrorBanner, Notice, PageHeader, StatusBadge } from "@/components/common";
import { useSession } from "@/components/session";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { AccountDTO } from "@/lib/types";

function ConnectDialog({ account, onClose }: { account: AccountDTO | "new"; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const existing = account === "new" ? null : account;
  const [name, setName] = useState(existing?.name ?? "");
  const [igId, setIgId] = useState(existing?.externalAccountId ?? "");
  const [token, setToken] = useState("");
  const [expires, setExpires] = useState("");
  const connect = useMutation({
    mutationFn: () => api.post("/accounts", { name, platform: "INSTAGRAM", externalAccountId: igId, accessToken: token, ...(expires ? { tokenExpiresAt: new Date(expires).toISOString() } : {}) }),
    onSuccess: () => {
      toast.success("حساب متصل و اعتبارسنجی شد");
      qc.invalidateQueries({ queryKey: ["accounts"] });
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={existing ? "اتصال مجدد حساب" : "اتصال حساب اینستاگرام"}
      description="اتصال فقط با توکن رسمی Instagram Graph API (از طریق OAuth متا) انجام می‌شود. ReelFlow هرگز رمز عبور اینستاگرام را نمی‌خواهد."
      footer={<><Button variant="secondary" onClick={onClose}>انصراف</Button><Button onClick={() => connect.mutate()} loading={connect.isPending} disabled={!name || !igId || token.length < 20}><KeyRound /> اتصال و اعتبارسنجی</Button></>}
    >
      <div className="space-y-4">
        <Notice>
          نیازمندی‌ها: حساب حرفه‌ای (Business/Creator) اینستاگرام، یک اپ در Meta for Developers با مجوز انتشار محتوا، و توکن کاربر که از جریان OAuth رسمی گرفته‌اید. توکن رمزنگاری‌شده ذخیره می‌شود و هرگز در رابط کاربری یا گزارش‌ها نمایش داده نمی‌شود.
        </Notice>
        <Field label="نام نمایشی"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="پیج اصلی" /></Field>
        <Field label="Instagram Business Account ID"><Input dir="ltr" value={igId} onChange={(e) => setIgId(e.target.value)} placeholder="17841400000000000" /></Field>
        <Field label="Access Token"><Input dir="ltr" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></Field>
        <Field label="تاریخ انقضای توکن (اختیاری)"><Input type="date" dir="ltr" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

export default function AccountsPage() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [connecting, setConnecting] = useState<AccountDTO | "new" | null>(null);
  const { data, error } = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<AccountDTO[]>("/accounts"), refetchInterval: 20_000 });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ environment: { publishingAdapterMode: string } }>("/settings") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["accounts"] });
  const validate = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean; message: string; quota?: { used: number; total: number } }>(`/accounts/${id}/validate`),
    onSuccess: (r) => {
      if (r.ok) toast.success(`اتصال معتبر است${r.quota ? ` — سهمیه API: ${r.quota.used}/${r.quota.total}` : ""}`);
      else toast.error(new Error(r.message));
      refresh();
    },
    onError: toast.error,
  });
  const disconnect = useMutation({ mutationFn: (id: string) => api.post(`/accounts/${id}/disconnect`), onSuccess: refresh, onError: toast.error });
  const resume = useMutation({ mutationFn: (id: string) => api.post(`/accounts/${id}/resume`), onSuccess: refresh, onError: toast.error });
  const setLimit = useMutation({
    mutationFn: ({ id, dailyLimit }: { id: string; dailyLimit: number | null }) => api.patch(`/accounts/${id}/limit`, { dailyLimit }),
    onSuccess: () => {
      toast.success("سقف حساب ذخیره شد");
      refresh();
    },
    onError: toast.error,
  });

  return (
    <>
      <PageHeader
        title={t("nav.accounts")}
        description="حساب‌های مقصد انتشار. در صورت خطای محدودیت نرخ (429) یا انقضای مجوز، انتشار روی آن حساب خودکار متوقف می‌شود."
        actions={can(["OWNER", "MANAGER"]) ? <Button onClick={() => setConnecting("new")}><Plus /> اتصال حساب</Button> : null}
      />
      <ErrorBanner error={error} />
      {settings.data?.environment.publishingAdapterMode === "mock" ? (
        <Notice tone="warning" className="mb-4">
          حالت آزمایشی (mock) فعال است: هیچ پستی واقعاً در اینستاگرام منتشر نمی‌شود. برای انتشار واقعی در <span className="ltr">.env</span> مقدار <span className="ltr font-mono">PUBLISHING_ADAPTER_MODE=live</span> را تنظیم کنید.
        </Notice>
      ) : null}
      {data?.length === 0 ? <EmptyState icon={<UserCircle2 />} title="حسابی متصل نشده" description="برای انتشار، یک حساب حرفه‌ای اینستاگرام را با توکن رسمی متصل کنید." /> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.map((a) => (
          <Card key={a.id} className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold">{a.name}</p>
                <p className="ltr text-start text-xs text-muted">{a.username ? `@${a.username}` : a.externalAccountId} · {a.platform}</p>
              </div>
              <div className="flex gap-1.5">
                <StatusBadge status={a.status} />
                <StatusBadge status={a.safetyState} />
              </div>
            </div>
            {a.safetyState === "PAUSED" ? (
              <Notice tone="danger" className="mt-4">
                {a.pauseReason}
                {a.pausedUntil ? ` — تا ${formatDateTime(a.pausedUntil, locale)}` : " — نیاز به اقدام دستی"}
              </Notice>
            ) : null}
            <dl className="mt-4 grid grid-cols-2 gap-y-2 text-xs">
              <dt className="text-muted">توکن</dt><dd className="ltr text-end font-mono">{a.hasToken ? `•••• ${a.tokenHint ?? ""}` : "—"}</dd>
              <dt className="text-muted">انقضای توکن</dt><dd className="text-end">{formatDateTime(a.tokenExpiresAt, locale)}</dd>
              <dt className="text-muted">آخرین انتشار موفق</dt><dd className="text-end">{formatRelative(a.lastSuccessAt, locale)}</dd>
              <dt className="text-muted">انتشار ۲۴ ساعت اخیر</dt><dd className="text-end tabular-nums">{a.dailyPublishCount}{a.dailyLimit !== null ? ` / ${a.dailyLimit}` : ""}</dd>
              <dt className="text-muted">خطاهای پیاپی</dt><dd className="text-end tabular-nums">{a.consecutiveFailures}</dd>
              {a.lastError ? (<><dt className="text-muted">آخرین خطا</dt><dd className="line-clamp-2 text-end text-warning">{a.lastError}</dd></>) : null}
            </dl>
            {can(["OWNER", "MANAGER"]) ? (
              <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
                <Button size="sm" variant="secondary" onClick={() => validate.mutate(a.id)} loading={validate.isPending}><ShieldCheck /> بررسی اتصال</Button>
                <Button size="sm" variant="secondary" onClick={() => setConnecting(a)}><RefreshCw /> اتصال مجدد</Button>
                {a.safetyState === "PAUSED" && a.status === "CONNECTED" ? <Button size="sm" variant="success" onClick={() => resume.mutate(a.id)}><Play /> ادامه انتشار</Button> : null}
                {a.status !== "DISCONNECTED" ? <Button size="sm" variant="ghost" onClick={() => disconnect.mutate(a.id)}><Link2Off /> قطع</Button> : null}
                <label className="ms-auto flex items-center gap-2 text-xs text-muted">
                  سقف روزانه این حساب
                  <input
                    type="number"
                    min={0}
                    defaultValue={a.dailyLimit ?? ""}
                    placeholder="—"
                    className="w-16 rounded-md border border-line bg-surface-0 px-2 py-1 text-fg"
                    onBlur={(e) => {
                      const v = e.target.value === "" ? null : Number(e.target.value);
                      if (v !== a.dailyLimit) setLimit.mutate({ id: a.id, dailyLimit: v });
                    }}
                  />
                </label>
              </div>
            ) : null}
            <div className="mt-3"><Badge>ID: <span className="ltr">{a.externalAccountId}</span></Badge></div>
          </Card>
        ))}
      </div>
      {connecting ? <ConnectDialog account={connecting} onClose={() => setConnecting(null)} /> : null}
    </>
  );
}
