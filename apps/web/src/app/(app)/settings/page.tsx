"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Lock, Play, RefreshCw, Square, Wifi } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Select, Switch, Table, Td, Th, cn } from "@reelflow/ui";
import { ErrorBanner, Notice, PageHeader, StatusBadge } from "@/components/common";
import { useSession } from "@/components/session";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { Limits, WatermarkPresetDTO } from "@/lib/types";

interface SettingsData {
  settings: {
    general: { brandName: string; locale: "fa" | "en"; timezone: string };
    approval: { mode: "AUTO" | "SEMI_AUTO" | "MANUAL" };
    publishing: Limits & { autoPublishEnabled: boolean; requireAttributionForThirdParty: boolean };
    safety: { blockUnknownRights: boolean; pauseOnRateLimit: boolean; baseBackoffMinutes: number; maxBackoffMinutes: number; maxPublishRetries: number };
    queue: { maxConcurrentJobs: number };
    media: { defaultPreset: string; normalizeAudio: boolean; defaultWatermarkPresetId: string | null };
    storage: { originalsRetentionDays: number; processedRetentionDays: number; failedRetentionDays: number; warnFreeSpaceGb: number };
    notifications: { onPublishSuccess: boolean; onPublishFailure: boolean; onQueuePaused: boolean };
  };
  ceilings: Limits & { maxConcurrentPublish: number; sourcesRequireOwnerApproval: boolean };
  effectiveLimits: Limits;
  environment: { networkMode: string; publishingAdapterMode: string; storagePath: string; timezone: string };
}

type Section = keyof SettingsData["settings"] | "network" | "security";

const SECTIONS: [Section, string][] = [
  ["general", "عمومی و منطقه زمانی"],
  ["publishing", "انتشار"],
  ["approval", "حالت تأیید"],
  ["safety", "ایمنی"],
  ["queue", "صف"],
  ["media", "پردازش رسانه و واترمارک"],
  ["storage", "ذخیره‌سازی"],
  ["notifications", "اعلان‌ها"],
  ["network", "شبکه"],
  ["security", "امنیت و کاربران"],
];

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line/60 py-4 last:border-0">
      <div className="max-w-xl">
        <p className="text-sm font-medium">{label}</p>
        {hint ? <p className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</p> : null}
      </div>
      <div className="min-w-48">{children}</div>
    </div>
  );
}

function SectionForm<K extends keyof SettingsData["settings"]>({ section, data, children }: { section: K; data: SettingsData; children: (v: SettingsData["settings"][K], set: (patch: Partial<SettingsData["settings"][K]>) => void) => ReactNode }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useSession();
  const [v, setV] = useState(data.settings[section]);
  useEffect(() => setV(data.settings[section]), [data, section]);
  const dirty = JSON.stringify(v) !== JSON.stringify(data.settings[section]);
  const save = useMutation({
    mutationFn: () => api.patch("/settings", { section, values: v }),
    onSuccess: () => {
      toast.success("تنظیمات ذخیره شد");
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: toast.error,
  });
  return (
    <>
      {children(v, (patch) => setV((x) => ({ ...x, ...patch })))}
      {can(["OWNER", "MANAGER"]) ? (
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" disabled={!dirty} onClick={() => setV(data.settings[section])}>بازنشانی</Button>
          <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>ذخیره</Button>
        </div>
      ) : null}
    </>
  );
}

const num = (e: React.ChangeEvent<HTMLInputElement>) => Number(e.target.value);

interface NetworkStatus {
  mode: string;
  provider: string;
  proxyAddress: string | null;
  ownership: string;
  processRunning: boolean;
  health: string;
  lastCheckAt: string | null;
  latencyMs: number | null;
  lastError: string | null;
  runtimeValid: boolean;
  runtimeProblems: string[];
  engineHeartbeatAt: string | null;
}

function NetworkSection({ configuredMode }: { configuredMode: string }) {
  const { locale } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["network"], queryFn: () => api.get<{ status: NetworkStatus | null; configuredMode: string }>("/network/status"), refetchInterval: 10_000 });
  const cmd = useMutation({
    mutationFn: (c: "test" | "start" | "stop" | "restart") => api.post<{ ok: boolean; message: string }>(`/network/${c}`),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.message);
      else toast.error(new Error(r.message));
      qc.invalidateQueries({ queryKey: ["network"] });
    },
    onError: toast.error,
  });
  const s = data?.status;
  const engineStale = !s?.engineHeartbeatAt || Date.now() - Date.parse(s.engineHeartbeatAt) > 90_000;
  const tone = s?.health === "HEALTHY" ? "bg-success" : s?.health === "DEGRADED" ? "bg-warning" : s?.health === "DISABLED" ? "bg-muted" : "bg-danger";

  return (
    <div className="space-y-4">
      <Notice>
        ReelFlow هرگز تنظیمات شبکه سیستم (پروکسی سیستم، DNS، مسیرها یا VPN کل سیستم) را تغییر نمی‌دهد. پروکسی فقط برای پردازش‌های خود ReelFlow استفاده می‌شود و اگر در حالت پروکسی در دسترس نباشد، درخواست‌ها متوقف می‌شوند و هرگز بی‌صدا به اتصال مستقیم برنمی‌گردند.
      </Notice>
      <Row label="حالت شبکه" hint={<>با متغیر <span className="ltr font-mono">NETWORK_MODE</span> در فایل <span className="ltr">.env</span> تنظیم می‌شود (نیاز به راه‌اندازی مجدد).</>}>
        <div className="flex gap-2">
          <Badge tone={configuredMode === "direct" ? "accent" : "neutral"}><Globe className="size-3" /> مستقیم</Badge>
          <Badge tone={configuredMode === "proxy" ? "accent" : "neutral"}><Lock className="size-3" /> پروکسی</Badge>
        </div>
      </Row>
      <Row label="ارائه‌دهنده پروکسی"><span className="text-sm">VPS Proxy (sing-box)</span></Row>
      <Row label="وضعیت">
        {engineStale ? (
          <span className="text-xs text-warning">موتور ورود محتوا (Python) در حال اجرا نیست — <span className="ltr font-mono">npm run dev:ingestion</span></span>
        ) : (
          <span className="flex items-center gap-2 text-sm">
            <span className={cn("size-2.5 rounded-full", tone)} />
            {s?.processRunning ? "متصل" : "قطع"} · <StatusBadge status={s?.health === "DISABLED" ? "DISCONNECTED" : s?.health === "UNAVAILABLE" ? "ERROR" : (s?.health ?? "ERROR")} />
            {s?.ownership === "external" ? <Badge>اجرا شده بیرون از ReelFlow</Badge> : s?.ownership === "managed" ? <Badge tone="accent">اجرا شده توسط ReelFlow</Badge> : null}
          </span>
        )}
      </Row>
      <Row label="آدرس پروکسی"><span className="ltr font-mono text-sm">{s?.proxyAddress ?? "—"}</span></Row>
      <Row label="آخرین بررسی سلامت">
        <span className="text-sm">{formatRelative(s?.lastCheckAt, locale)}{s?.latencyMs ? <span className="ltr text-muted"> · {s.latencyMs} ms</span> : null}</span>
      </Row>
      <Row label="آخرین خطا"><span className="text-xs text-warning">{s?.lastError ?? "—"}</span></Row>
      {s?.runtimeProblems.length ? <Notice tone="warning">{s.runtimeProblems.join(" · ")}</Notice> : null}
      {can(["OWNER"]) ? (
        <div className="flex flex-wrap gap-2 pt-2">
          <Button variant="secondary" onClick={() => cmd.mutate("test")} loading={cmd.isPending && cmd.variables === "test"}><Wifi /> تست اتصال</Button>
          <Button variant="secondary" onClick={() => cmd.mutate("start")} loading={cmd.isPending && cmd.variables === "start"}><Play /> شروع پروکسی</Button>
          <Button variant="secondary" onClick={() => cmd.mutate("stop")} loading={cmd.isPending && cmd.variables === "stop"}><Square /> توقف پروکسی</Button>
          <Button variant="secondary" onClick={() => cmd.mutate("restart")} loading={cmd.isPending && cmd.variables === "restart"}><RefreshCw /> راه‌اندازی مجدد</Button>
        </div>
      ) : (
        <p className="text-xs text-muted">کنترل پروکسی فقط برای مالک سیستم فعال است.</p>
      )}
    </div>
  );
}

function SecuritySection() {
  const { user, can, signOut } = useSession();
  const { ts } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<{ id: string; email: string; name: string; role: string; lastLoginAt: string | null }[]>("/users"), enabled: can(["OWNER"]) });
  const [pw, setPw] = useState({ current: "", next: "" });
  const [nu, setNu] = useState({ email: "", name: "", password: "", role: "MANAGER" });
  const change = useMutation({ mutationFn: () => api.post("/auth/password", pw), onSuccess: () => { toast.success("رمز تغییر کرد؛ دوباره وارد شوید"); void signOut(); }, onError: toast.error });
  const create = useMutation({ mutationFn: () => api.post("/users", nu), onSuccess: () => { toast.success("کاربر ساخته شد"); setNu({ email: "", name: "", password: "", role: "MANAGER" }); qc.invalidateQueries({ queryKey: ["users"] }); }, onError: toast.error });
  return (
    <div className="space-y-6">
      <div>
        <p className="mb-3 text-sm font-semibold">تغییر رمز عبور ({user.email})</p>
        <div className="grid gap-3 md:grid-cols-3">
          <Input type="password" placeholder="رمز فعلی" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <Input type="password" placeholder="رمز جدید (حداقل ۱۲ نویسه)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <Button onClick={() => change.mutate()} disabled={pw.next.length < 12} loading={change.isPending}>تغییر رمز</Button>
        </div>
      </div>
      {can(["OWNER"]) ? (
        <div>
          <p className="mb-3 text-sm font-semibold">کاربران</p>
          <Notice className="mb-3">«مدیر» (کارفرما) می‌تواند محتوا، کپشن، زمان‌بندی و تنظیمات را در محدوده سقف‌ها مدیریت کند و منبع پیشنهاد دهد؛ تأیید منابع و کنترل شبکه فقط با «مالک» است.</Notice>
          <Table>
            <thead><tr><Th>نام</Th><Th>ایمیل</Th><Th>نقش</Th><Th>آخرین ورود</Th></tr></thead>
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id}><Td>{u.name}</Td><Td className="ltr text-xs">{u.email}</Td><Td><Badge>{ts("role", u.role)}</Badge></Td><Td className="text-xs text-muted">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("fa-IR") : "—"}</Td></tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-4 grid gap-3 md:grid-cols-5">
            <Input placeholder="نام" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} />
            <Input dir="ltr" placeholder="email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} />
            <Input type="password" placeholder="رمز (۱۲+)" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
            <Select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
              <option value="MANAGER">{ts("role", "MANAGER")}</option>
              <option value="VIEWER">{ts("role", "VIEWER")}</option>
              <option value="OWNER">{ts("role", "OWNER")}</option>
            </Select>
            <Button onClick={() => create.mutate()} loading={create.isPending}>افزودن کاربر</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function SettingsPage() {
  const { t, ts, setLocale } = useI18n();
  const { can } = useSession();
  const [section, setSection] = useState<Section>("publishing");
  const { data, error } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsData>("/settings") });
  const wm = useQuery({ queryKey: ["watermarks"], queryFn: () => api.get<WatermarkPresetDTO[]>("/watermarks") });
  const c = data?.ceilings;

  return (
    <>
      <PageHeader title={t("nav.settings")} />
      <ErrorBanner error={error} />
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <Card className="h-fit p-2">
          {SECTIONS.map(([k, label]) => (
            <button key={k} onClick={() => setSection(k)} className={cn("w-full rounded-lg px-3 py-2 text-start text-sm", section === k ? "bg-surface-3 font-medium" : "text-muted hover:bg-surface-2 hover:text-fg")}>
              {label}
            </button>
          ))}
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{SECTIONS.find(([k]) => k === section)?.[1]}</CardTitle>
              {data ? <CardDescription>محیط: شبکه {data.environment.networkMode} · انتشار {data.environment.publishingAdapterMode} · ذخیره‌سازی <span className="ltr">{data.environment.storagePath}</span></CardDescription> : null}
            </div>
          </CardHeader>
          <CardContent>
            {!data ? null : section === "network" ? (
              <NetworkSection configuredMode={data.environment.networkMode} />
            ) : section === "security" ? (
              <SecuritySection />
            ) : section === "publishing" ? (
              <SectionForm section="publishing" data={data}>
                {(v, set) => (
                  <>
                    <Notice className="mb-2">
                      سقف‌های مالک سیستم (قابل تغییر فقط از طریق فایل <span className="ltr">.env</span>): حداکثر <b>{c!.maxPostsPerDay}</b> پست در روز، {c!.maxPostsPerHour} در ساعت، فاصله حداقل {c!.minPostIntervalMinutes} دقیقه، {c!.maxPostsPerSourcePerDay} پست از هر منبع در روز. مقادیر بیشتر از این سقف‌ها پذیرفته نمی‌شوند.
                    </Notice>
                    <Row label="انتشار خودکار" hint="وقتی روشن باشد، برنامه‌های انتشار جاهای خالی را با محتوای تأییدشده پر می‌کنند و در زمان مقرر منتشر می‌کنند. محتوای با حقوق نامشخص هرگز خودکار منتشر نمی‌شود.">
                      <Switch checked={v.autoPublishEnabled} onCheckedChange={(x) => set({ autoPublishEnabled: x })} disabled={!can(["OWNER", "MANAGER"])} />
                    </Row>
                    <Row label="حداکثر پست در روز" hint={`سقف: ${c!.maxPostsPerDay}`}>
                      <Input type="number" min={0} max={c!.maxPostsPerDay} value={v.maxPostsPerDay} onChange={(e) => set({ maxPostsPerDay: num(e) })} />
                    </Row>
                    <Row label="حداکثر پست در ساعت" hint={`سقف: ${c!.maxPostsPerHour}`}>
                      <Input type="number" min={0} max={c!.maxPostsPerHour} value={v.maxPostsPerHour} onChange={(e) => set({ maxPostsPerHour: num(e) })} />
                    </Row>
                    <Row label="حداقل فاصله بین پست‌ها (دقیقه)" hint={`حداقل مجاز: ${c!.minPostIntervalMinutes}`}>
                      <Input type="number" min={c!.minPostIntervalMinutes} value={v.minPostIntervalMinutes} onChange={(e) => set({ minPostIntervalMinutes: num(e) })} />
                    </Row>
                    <Row label="حداکثر پست از هر منبع در روز" hint={`سقف: ${c!.maxPostsPerSourcePerDay}`}>
                      <Input type="number" min={0} max={c!.maxPostsPerSourcePerDay} value={v.maxPostsPerSourcePerDay} onChange={(e) => set({ maxPostsPerSourcePerDay: num(e) })} />
                    </Row>
                    <Row label="ذکر منبع برای محتوای دیگران الزامی" hint="پست بدون ذکر منبع منتشر نمی‌شود">
                      <Switch checked={v.requireAttributionForThirdParty} onCheckedChange={(x) => set({ requireAttributionForThirdParty: x })} />
                    </Row>
                  </>
                )}
              </SectionForm>
            ) : section === "approval" ? (
              <SectionForm section="approval" data={data}>
                {(v, set) => (
                  <div className="grid gap-3 md:grid-cols-3">
                    {(["AUTO", "SEMI_AUTO", "MANUAL"] as const).map((m) => (
                      <button key={m} onClick={() => set({ mode: m })} className={cn("rounded-2xl border p-4 text-start", v.mode === m ? "border-accent bg-accent/10" : "border-line hover:bg-surface-2")}>
                        <p className="font-semibold">{ts("mode", m)}</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted">
                          {m === "AUTO" ? "محتوای منابع تأییدشده با حقوق مشخص، پس از پردازش خودکار تأیید می‌شود." : m === "SEMI_AUTO" ? "هر محتوای واردشده منتظر تأیید شما می‌ماند (پیش‌فرض)." : "هیچ چیز بدون تأیید صریح منتشر نمی‌شود؛ پست‌های خودکار هم متوقف می‌شوند."}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </SectionForm>
            ) : section === "safety" ? (
              <SectionForm section="safety" data={data}>
                {(v, set) => (
                  <>
                    <Row label="مسدود کردن انتشار محتوای با حقوق نامشخص"><Switch checked={v.blockUnknownRights} onCheckedChange={(x) => set({ blockUnknownRights: x })} /></Row>
                    <Row label="توقف انتشار هنگام محدودیت نرخ (429)" hint="همیشه فعال است؛ سامانه محدودیت‌های پلتفرم را دور نمی‌زند."><Switch checked disabled onCheckedChange={() => undefined} /></Row>
                    <Row label="تأخیر پایه برای تلاش مجدد (دقیقه)"><Input type="number" value={v.baseBackoffMinutes} onChange={(e) => set({ baseBackoffMinutes: num(e) })} /></Row>
                    <Row label="حداکثر تأخیر (دقیقه)"><Input type="number" value={v.maxBackoffMinutes} onChange={(e) => set({ maxBackoffMinutes: num(e) })} /></Row>
                    <Row label="حداکثر تلاش مجدد انتشار"><Input type="number" min={0} max={10} value={v.maxPublishRetries} onChange={(e) => set({ maxPublishRetries: num(e) })} /></Row>
                  </>
                )}
              </SectionForm>
            ) : section === "general" ? (
              <SectionForm section="general" data={data}>
                {(v, set) => (
                  <>
                    <Row label="نام برند" hint="در متغیر {{brand}} کپشن‌ها"><Input value={v.brandName} onChange={(e) => set({ brandName: e.target.value })} /></Row>
                    <Row label="زبان رابط"><Select value={v.locale} onChange={(e) => { set({ locale: e.target.value as "fa" | "en" }); setLocale(e.target.value as "fa" | "en"); }}><option value="fa">فارسی</option><option value="en">English</option></Select></Row>
                    <Row label="منطقه زمانی" hint="پیش‌فرض: Asia/Tehran"><Input dir="ltr" value={v.timezone} onChange={(e) => set({ timezone: e.target.value })} /></Row>
                  </>
                )}
              </SectionForm>
            ) : section === "queue" ? (
              <SectionForm section="queue" data={data}>
                {(v, set) => (
                  <Row label="حداکثر کارهای پردازش هم‌زمان" hint={`انتشار هم‌زمان توسط مالک محدود شده: ${c!.maxConcurrentPublish}`}>
                    <Input type="number" min={1} max={8} value={v.maxConcurrentJobs} onChange={(e) => set({ maxConcurrentJobs: num(e) })} />
                  </Row>
                )}
              </SectionForm>
            ) : section === "media" ? (
              <SectionForm section="media" data={data}>
                {(v, set) => (
                  <>
                    <Row label="قالب خروجی پیش‌فرض">
                      <Select value={v.defaultPreset} onChange={(e) => set({ defaultPreset: e.target.value })}>
                        <option value="INSTAGRAM_REEL">Instagram Reel</option>
                        <option value="INSTAGRAM_FEED">Instagram Feed</option>
                        <option value="INSTAGRAM_STORY">Instagram Story</option>
                      </Select>
                    </Row>
                    <Row label="واترمارک پیش‌فرض">
                      <Select value={v.defaultWatermarkPresetId ?? ""} onChange={(e) => set({ defaultWatermarkPresetId: e.target.value || null })}>
                        <option value="">قالب پیش‌فرض</option>
                        {wm.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                      </Select>
                    </Row>
                    <Row label="یکسان‌سازی بلندی صدا (loudnorm)"><Switch checked={v.normalizeAudio} onCheckedChange={(x) => set({ normalizeAudio: x })} /></Row>
                  </>
                )}
              </SectionForm>
            ) : section === "storage" ? (
              <SectionForm section="storage" data={data}>
                {(v, set) => (
                  <>
                    <Notice className="mb-2">فایل‌هایی که به پست‌های فعال (زمان‌بندی‌شده یا در انتظار) مربوط هستند هرگز حذف نمی‌شوند.</Notice>
                    <Row label="نگهداری فایل‌های اصلی (روز)"><Input type="number" value={v.originalsRetentionDays} onChange={(e) => set({ originalsRetentionDays: num(e) })} /></Row>
                    <Row label="نگهداری فایل‌های پردازش‌شده (روز)"><Input type="number" value={v.processedRetentionDays} onChange={(e) => set({ processedRetentionDays: num(e) })} /></Row>
                    <Row label="نگهداری سوابق کارهای ناموفق (روز)"><Input type="number" value={v.failedRetentionDays} onChange={(e) => set({ failedRetentionDays: num(e) })} /></Row>
                    <Row label="هشدار فضای خالی کمتر از (GB)"><Input type="number" value={v.warnFreeSpaceGb} onChange={(e) => set({ warnFreeSpaceGb: num(e) })} /></Row>
                  </>
                )}
              </SectionForm>
            ) : section === "notifications" ? (
              <SectionForm section="notifications" data={data}>
                {(v, set) => (
                  <>
                    <Row label="انتشار موفق"><Switch checked={v.onPublishSuccess} onCheckedChange={(x) => set({ onPublishSuccess: x })} /></Row>
                    <Row label="انتشار ناموفق"><Switch checked={v.onPublishFailure} onCheckedChange={(x) => set({ onPublishFailure: x })} /></Row>
                    <Row label="توقف صف / انقضای مجوز"><Switch checked={v.onQueuePaused} onCheckedChange={(x) => set({ onQueuePaused: x })} /></Row>
                    <Notice className="mt-2">کانال‌های ایمیل، تلگرام، دیسکورد و وب‌هوک از طریق رابط NotificationChannel قابل افزودن هستند.</Notice>
                  </>
                )}
              </SectionForm>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
