"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Lock, Play, Plus, RefreshCw, Server, Square, Trash2, Wifi } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, Field, Input, Select, Switch, Table, Td, Th, cn } from "@reelflow/ui";
import { ErrorBanner, Notice, PageHeader, StatusBadge } from "@/components/common";
import { useSession } from "@/components/session";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useI18n, type MessageKey } from "@/lib/i18n";
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

const SECTIONS: [Section, MessageKey][] = [
  ["general", "settings.sections.general"],
  ["publishing", "common.publishing"],
  ["approval", "dash.approvalMode"],
  ["safety", "shell.safety"],
  ["queue", "logs.queue"],
  ["media", "settings.sections.media"],
  ["storage", "settings.sections.storage"],
  ["notifications", "shell.notifications"],
  ["network", "common.network"],
  ["security", "settings.sections.security"],
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
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useSession();
  const [v, setV] = useState(data.settings[section]);
  useEffect(() => setV(data.settings[section]), [data, section]);
  const dirty = JSON.stringify(v) !== JSON.stringify(data.settings[section]);
  const save = useMutation({
    mutationFn: () => api.patch("/settings", { section, values: v }),
    onSuccess: () => {
      toast.success(t("settings.saved"));
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
          <Button variant="ghost" disabled={!dirty} onClick={() => setV(data.settings[section])}>{t("common.reset")}</Button>
          <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>{t("common.save")}</Button>
        </div>
      ) : null}
    </>
  );
}

const num = (e: React.ChangeEvent<HTMLInputElement>) => Number(e.target.value);

interface NetworkStatus {
  mode: string;
  activeServerId: string | null;
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

interface NetworkServerDTO {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  passwordHint: string;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  lastTestLatencyMs: number | null;
}

function AddServerDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [v, setV] = useState({ name: "", host: "", port: 22, username: "", password: "" });
  const create = useMutation({
    mutationFn: () => api.post("/network/servers", v),
    onSuccess: () => {
      toast.success(t("settings.serverAdded"));
      qc.invalidateQueries({ queryKey: ["network-servers"] });
      onClose();
    },
    onError: toast.error,
  });
  const ready = v.name && v.host && v.username && v.password;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("settings.addServerTitle")}
      description={t("settings.addServerDesc")}
      footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button onClick={() => create.mutate()} loading={create.isPending} disabled={!ready}><Plus /> {t("common.add")}</Button></>}
    >
      <div className="space-y-4">
        <Field label={t("common.name")}><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder={t("settings.serverNamePlaceholder")} /></Field>
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label={t("settings.serverHostLabel")}><Input dir="ltr" value={v.host} onChange={(e) => setV({ ...v, host: e.target.value })} /></Field>
          <Field label={t("common.port")}><Input dir="ltr" type="number" className="w-20" value={v.port} onChange={(e) => setV({ ...v, port: Number(e.target.value) })} /></Field>
        </div>
        <Field label={t("common.username")}><Input dir="ltr" value={v.username} onChange={(e) => setV({ ...v, username: e.target.value })} /></Field>
        <Field label={t("auth.password")}><Input dir="ltr" type="password" autoComplete="new-password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

function NetworkSection() {
  const { t, ts, locale } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const { data } = useQuery({ queryKey: ["network"], queryFn: () => api.get<{ status: NetworkStatus | null; configuredMode: string }>("/network/status"), refetchInterval: 10_000 });
  const servers = useQuery({ queryKey: ["network-servers"], queryFn: () => api.get<NetworkServerDTO[]>("/network/servers") });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["network"] });
    qc.invalidateQueries({ queryKey: ["network-servers"] });
  };
  const cmd = useMutation({
    mutationFn: (c: "test" | "start" | "stop" | "restart") => api.post<{ ok: boolean; message: string }>(`/network/${c}`),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.message);
      else toast.error(new Error(r.message));
      refresh();
    },
    onError: toast.error,
  });
  const select = useMutation({
    mutationFn: (target: string) => api.post<{ ok: boolean; message: string }>("/network/select", { target }),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.message);
      else toast.error(new Error(r.message));
      refresh();
    },
    onError: toast.error,
  });
  const testServer = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean; message: string }>(`/network/servers/${id}/test`),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.message);
      else toast.error(new Error(r.message));
      qc.invalidateQueries({ queryKey: ["network-servers"] });
    },
    onError: toast.error,
  });
  const removeServer = useMutation({ mutationFn: (id: string) => api.del(`/network/servers/${id}`), onSuccess: refresh, onError: toast.error });

  const s = data?.status;
  const engineStale = !s?.engineHeartbeatAt || Date.now() - Date.parse(s.engineHeartbeatAt) > 90_000;
  const tone = s?.health === "HEALTHY" ? "bg-success" : s?.health === "DEGRADED" ? "bg-warning" : s?.health === "DISABLED" ? "bg-muted" : "bg-danger";
  const currentTarget = !s ? "" : s.mode === "direct" ? "direct" : (s.activeServerId ?? "builtin");

  return (
    <div className="space-y-4">
      <Notice>{t("settings.networkNotice")}</Notice>
      <Row label={t("settings.networkMode")} hint={t("settings.networkModeHint")}>
        {can(["OWNER"]) ? (
          <Select value={currentTarget} onChange={(e) => select.mutate(e.target.value)} disabled={select.isPending || !s}>
            <option value="direct">{t("settings.direct")}</option>
            <option value="builtin">{t("settings.builtinProxy")}</option>
            {servers.data?.map((srv) => <option key={srv.id} value={srv.id}>{srv.name} ({srv.host})</option>)}
          </Select>
        ) : (
          <div className="flex gap-2">
            <Badge tone={s?.mode === "direct" ? "accent" : "neutral"}><Globe className="size-3" /> {t("settings.directShort")}</Badge>
            <Badge tone={s?.mode === "proxy" ? "accent" : "neutral"}><Lock className="size-3" /> {t("settings.proxyShort")}</Badge>
          </div>
        )}
      </Row>
      <Row label={t("settings.activeProviderLabel")}><span className="text-sm">{s?.mode === "direct" ? "—" : s?.activeServerId ? (servers.data?.find((srv) => srv.id === s.activeServerId)?.name ?? t("settings.serverDeleted")) : "VPS Proxy (sing-box)"}</span></Row>
      <Row label={t("common.status")}>
        {engineStale ? (
          <span className="text-xs text-warning">{t("settings.ingestionEngineDown")} <span className="ltr font-mono">npm run dev:ingestion</span></span>
        ) : (
          <span className="flex items-center gap-2 text-sm">
            <span className={cn("size-2.5 rounded-full", tone)} />
            {ts("status", s?.processRunning ? "CONNECTED" : "DISCONNECTED")} · <StatusBadge status={s?.health === "DISABLED" ? "DISCONNECTED" : s?.health === "UNAVAILABLE" ? "ERROR" : (s?.health ?? "ERROR")} />
            {s?.ownership === "external" ? <Badge>{t("settings.externalOwnership")}</Badge> : s?.ownership === "managed" ? <Badge tone="accent">{t("settings.managedOwnership")}</Badge> : null}
          </span>
        )}
      </Row>
      <Row label={t("settings.proxyAddressLabel")}><span className="ltr font-mono text-sm">{s?.proxyAddress ?? "—"}</span></Row>
      <Row label={t("settings.lastHealthCheckLabel")}>
        <span className="text-sm">{formatRelative(s?.lastCheckAt, locale)}{s?.latencyMs ? <span className="ltr text-muted"> · {s.latencyMs} ms</span> : null}</span>
      </Row>
      <Row label={t("settings.lastErrorLabel")}><span className="text-xs text-warning">{s?.lastError ?? "—"}</span></Row>
      {s?.runtimeProblems.length ? <Notice tone="warning">{s.runtimeProblems.join(" · ")}</Notice> : null}
      {can(["OWNER"]) ? (
        <div className="flex flex-wrap gap-2 pt-2">
          <Button variant="secondary" onClick={() => cmd.mutate("test")} loading={cmd.isPending && cmd.variables === "test"}><Wifi /> {t("settings.testActiveProxy")}</Button>
          <Button variant="secondary" onClick={() => cmd.mutate("start")} loading={cmd.isPending && cmd.variables === "start"}><Play /> {t("settings.startBuiltinProxy")}</Button>
          <Button variant="secondary" onClick={() => cmd.mutate("stop")} loading={cmd.isPending && cmd.variables === "stop"}><Square /> {t("settings.stopBuiltinProxy")}</Button>
          <Button variant="secondary" onClick={() => cmd.mutate("restart")} loading={cmd.isPending && cmd.variables === "restart"}><RefreshCw /> {t("common.restart")}</Button>
        </div>
      ) : (
        <p className="text-xs text-muted">{t("settings.networkOwnerOnly")}</p>
      )}

      <div className="border-t border-line pt-5">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold">{t("settings.sshServers")}</p>
          {can(["OWNER"]) ? <Button size="sm" onClick={() => setAdding(true)}><Plus /> {t("settings.addServer")}</Button> : null}
        </div>
        {servers.data?.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted">{t("settings.noServers")}</p>
        ) : (
          <Table>
            <thead><tr><Th>{t("common.name")}</Th><Th>{t("common.address")}</Th><Th>{t("settings.serverTableUser")}</Th><Th>{t("settings.lastTest")}</Th><Th /></tr></thead>
            <tbody>
              {servers.data?.map((srv) => (
                <tr key={srv.id}>
                  <Td>
                    {srv.name}
                    {s?.activeServerId === srv.id ? <Badge tone="accent" className="me-2"><Server className="size-3" /> {t("common.active")}</Badge> : null}
                  </Td>
                  <Td className="ltr text-start font-mono text-xs">{srv.host}:{srv.port}</Td>
                  <Td className="ltr text-start text-xs">{srv.username}</Td>
                  <Td className="text-xs">
                    {srv.lastTestAt ? (
                      <span className={srv.lastTestOk ? "text-success" : "text-danger"}>
                        {ts("status", srv.lastTestOk ? "SUCCEEDED" : "FAILED")}{srv.lastTestLatencyMs ? ` · ${srv.lastTestLatencyMs}ms` : ""}
                        {" "}· {formatRelative(srv.lastTestAt, locale)}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td>
                    {can(["OWNER"]) ? (
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="secondary" onClick={() => testServer.mutate(srv.id)} loading={testServer.isPending && testServer.variables === srv.id}><Wifi /> {t("settings.testConnection")}</Button>
                        {s?.activeServerId !== srv.id ? <Button size="sm" variant="secondary" onClick={() => select.mutate(srv.id)} loading={select.isPending && select.variables === srv.id}><Play /> {t("settings.activate")}</Button> : null}
                        <Button size="sm" variant="ghost" onClick={() => removeServer.mutate(srv.id)} disabled={s?.activeServerId === srv.id}><Trash2 /></Button>
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
      {adding ? <AddServerDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function SecuritySection() {
  const { user, can, signOut } = useSession();
  const { t, ts } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<{ id: string; email: string; name: string; role: string; lastLoginAt: string | null }[]>("/users"), enabled: can(["OWNER"]) });
  const [pw, setPw] = useState({ current: "", next: "" });
  const [nu, setNu] = useState({ email: "", name: "", password: "", role: "MANAGER" });
  const change = useMutation({ mutationFn: () => api.post("/auth/password", pw), onSuccess: () => { toast.success(t("settings.passwordChanged")); void signOut(); }, onError: toast.error });
  const create = useMutation({ mutationFn: () => api.post("/users", nu), onSuccess: () => { toast.success(t("settings.userCreated")); setNu({ email: "", name: "", password: "", role: "MANAGER" }); qc.invalidateQueries({ queryKey: ["users"] }); }, onError: toast.error });
  return (
    <div className="space-y-6">
      <div>
        <p className="mb-3 text-sm font-semibold">{t("settings.changePasswordTitle")} ({user.email})</p>
        <div className="grid gap-3 md:grid-cols-3">
          <Input type="password" placeholder={t("settings.currentPassword")} value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <Input type="password" placeholder={t("settings.newPasswordMin12")} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <Button onClick={() => change.mutate()} disabled={pw.next.length < 12} loading={change.isPending}>{t("settings.changePassword")}</Button>
        </div>
      </div>
      {can(["OWNER"]) ? (
        <div>
          <p className="mb-3 text-sm font-semibold">{t("settings.usersTitle")}</p>
          <Notice className="mb-3">{t("settings.managerNotice")}</Notice>
          <Table>
            <thead><tr><Th>{t("common.name")}</Th><Th>{t("auth.email")}</Th><Th>{t("common.role")}</Th><Th>{t("settings.lastLogin")}</Th></tr></thead>
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id}><Td>{u.name}</Td><Td className="ltr text-xs">{u.email}</Td><Td><Badge>{ts("role", u.role)}</Badge></Td><Td className="text-xs text-muted">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("fa-IR") : "—"}</Td></tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-4 grid gap-3 md:grid-cols-5">
            <Input placeholder={t("common.name")} value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} />
            <Input dir="ltr" placeholder="email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} />
            <Input type="password" placeholder={t("settings.passwordMin12Short")} value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
            <Select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
              <option value="MANAGER">{ts("role", "MANAGER")}</option>
              <option value="VIEWER">{ts("role", "VIEWER")}</option>
              <option value="OWNER">{ts("role", "OWNER")}</option>
            </Select>
            <Button onClick={() => create.mutate()} loading={create.isPending}>{t("settings.addUser")}</Button>
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
          {SECTIONS.map(([k, labelKey]) => (
            <button key={k} onClick={() => setSection(k)} className={cn("w-full rounded-lg px-3 py-2 text-start text-sm", section === k ? "bg-surface-3 font-medium" : "text-muted hover:bg-surface-2 hover:text-fg")}>
              {t(labelKey)}
            </button>
          ))}
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{t(SECTIONS.find(([k]) => k === section)?.[1] ?? "settings.sections.general")}</CardTitle>
              {data ? (
                <CardDescription>
                  {t("settings.environment")}: {t("common.network")} {data.environment.networkMode} · {t("common.publishing")} {data.environment.publishingAdapterMode} · {t("settings.sections.storage")} <span className="ltr">{data.environment.storagePath}</span>
                </CardDescription>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            {!data ? null : section === "network" ? (
              <NetworkSection />
            ) : section === "security" ? (
              <SecuritySection />
            ) : section === "publishing" ? (
              <SectionForm section="publishing" data={data}>
                {(v, set) => (
                  <>
                    <Notice className="mb-2">
                      {t("settings.ownerCeilingsPrefix")} <span className="ltr">.env</span>{t("settings.ownerCeilingsMid")} <b>{c!.maxPostsPerDay}</b>{" "}
                      {t("settings.ownerCeilingsSuffix")
                        .replace("{{perHour}}", String(c!.maxPostsPerHour))
                        .replace("{{minInterval}}", String(c!.minPostIntervalMinutes))
                        .replace("{{perSource}}", String(c!.maxPostsPerSourcePerDay))}
                    </Notice>
                    <Row label={t("shell.autoPublish")} hint={t("settings.autoPublishHint")}>
                      <Switch checked={v.autoPublishEnabled} onCheckedChange={(x) => set({ autoPublishEnabled: x })} disabled={!can(["OWNER", "MANAGER"])} />
                    </Row>
                    <Row label={t("settings.maxPostsPerDay")} hint={`${t("settings.ceilingPrefix")} ${c!.maxPostsPerDay}`}>
                      <Input type="number" min={0} max={c!.maxPostsPerDay} value={v.maxPostsPerDay} onChange={(e) => set({ maxPostsPerDay: num(e) })} />
                    </Row>
                    <Row label={t("settings.maxPostsPerHour")} hint={`${t("settings.ceilingPrefix")} ${c!.maxPostsPerHour}`}>
                      <Input type="number" min={0} max={c!.maxPostsPerHour} value={v.maxPostsPerHour} onChange={(e) => set({ maxPostsPerHour: num(e) })} />
                    </Row>
                    <Row label={t("settings.minInterval")} hint={`${t("settings.minAllowedPrefix")} ${c!.minPostIntervalMinutes}`}>
                      <Input type="number" min={c!.minPostIntervalMinutes} value={v.minPostIntervalMinutes} onChange={(e) => set({ minPostIntervalMinutes: num(e) })} />
                    </Row>
                    <Row label={t("settings.maxPostsPerSource")} hint={`${t("settings.ceilingPrefix")} ${c!.maxPostsPerSourcePerDay}`}>
                      <Input type="number" min={0} max={c!.maxPostsPerSourcePerDay} value={v.maxPostsPerSourcePerDay} onChange={(e) => set({ maxPostsPerSourcePerDay: num(e) })} />
                    </Row>
                    <Row label={t("settings.requireAttribution")} hint={t("settings.requireAttributionHint")}>
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
                          {m === "AUTO" ? t("settings.approvalAutoDesc") : m === "SEMI_AUTO" ? t("settings.approvalSemiDesc") : t("settings.approvalManualDesc")}
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
                    <Row label={t("settings.blockUnknownRights")}><Switch checked={v.blockUnknownRights} onCheckedChange={(x) => set({ blockUnknownRights: x })} /></Row>
                    <Row label={t("settings.pauseOnRateLimit")} hint={t("settings.pauseOnRateLimitHint")}><Switch checked disabled onCheckedChange={() => undefined} /></Row>
                    <Row label={t("settings.baseBackoff")}><Input type="number" value={v.baseBackoffMinutes} onChange={(e) => set({ baseBackoffMinutes: num(e) })} /></Row>
                    <Row label={t("settings.maxBackoff")}><Input type="number" value={v.maxBackoffMinutes} onChange={(e) => set({ maxBackoffMinutes: num(e) })} /></Row>
                    <Row label={t("settings.maxPublishRetries")}><Input type="number" min={0} max={10} value={v.maxPublishRetries} onChange={(e) => set({ maxPublishRetries: num(e) })} /></Row>
                  </>
                )}
              </SectionForm>
            ) : section === "general" ? (
              <SectionForm section="general" data={data}>
                {(v, set) => (
                  <>
                    <Row label={t("settings.brandName")} hint={t("settings.brandNameHint")}><Input value={v.brandName} onChange={(e) => set({ brandName: e.target.value })} /></Row>
                    <Row label={t("settings.uiLanguage")}><Select value={v.locale} onChange={(e) => { set({ locale: e.target.value as "fa" | "en" }); setLocale(e.target.value as "fa" | "en"); }}><option value="fa">فارسی</option><option value="en">English</option></Select></Row>
                    <Row label={t("settings.timezoneLabel")} hint={t("settings.timezoneHint")}><Input dir="ltr" value={v.timezone} onChange={(e) => set({ timezone: e.target.value })} /></Row>
                  </>
                )}
              </SectionForm>
            ) : section === "queue" ? (
              <SectionForm section="queue" data={data}>
                {(v, set) => (
                  <Row label={t("settings.maxConcurrentJobs")} hint={t("settings.concurrentPublishLimited").replace("{{n}}", String(c!.maxConcurrentPublish))}>
                    <Input type="number" min={1} max={8} value={v.maxConcurrentJobs} onChange={(e) => set({ maxConcurrentJobs: num(e) })} />
                  </Row>
                )}
              </SectionForm>
            ) : section === "media" ? (
              <SectionForm section="media" data={data}>
                {(v, set) => (
                  <>
                    <Row label={t("settings.defaultPreset")}>
                      <Select value={v.defaultPreset} onChange={(e) => set({ defaultPreset: e.target.value })}>
                        <option value="INSTAGRAM_REEL">Instagram Reel</option>
                        <option value="INSTAGRAM_FEED">Instagram Feed</option>
                        <option value="INSTAGRAM_STORY">Instagram Story</option>
                      </Select>
                    </Row>
                    <Row label={t("settings.defaultWatermark")}>
                      <Select value={v.defaultWatermarkPresetId ?? ""} onChange={(e) => set({ defaultWatermarkPresetId: e.target.value || null })}>
                        <option value="">{t("settings.useDefaultTemplate")}</option>
                        {wm.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                      </Select>
                    </Row>
                    <Row label={t("settings.normalizeAudio")}><Switch checked={v.normalizeAudio} onCheckedChange={(x) => set({ normalizeAudio: x })} /></Row>
                  </>
                )}
              </SectionForm>
            ) : section === "storage" ? (
              <SectionForm section="storage" data={data}>
                {(v, set) => (
                  <>
                    <Notice className="mb-2">{t("settings.storageNotice")}</Notice>
                    <Row label={t("settings.originalsRetention")}><Input type="number" value={v.originalsRetentionDays} onChange={(e) => set({ originalsRetentionDays: num(e) })} /></Row>
                    <Row label={t("settings.processedRetention")}><Input type="number" value={v.processedRetentionDays} onChange={(e) => set({ processedRetentionDays: num(e) })} /></Row>
                    <Row label={t("settings.failedRetention")}><Input type="number" value={v.failedRetentionDays} onChange={(e) => set({ failedRetentionDays: num(e) })} /></Row>
                    <Row label={t("settings.warnFreeSpace")}><Input type="number" value={v.warnFreeSpaceGb} onChange={(e) => set({ warnFreeSpaceGb: num(e) })} /></Row>
                  </>
                )}
              </SectionForm>
            ) : section === "notifications" ? (
              <SectionForm section="notifications" data={data}>
                {(v, set) => (
                  <>
                    <Row label={t("settings.notifyPublishSuccess")}><Switch checked={v.onPublishSuccess} onCheckedChange={(x) => set({ onPublishSuccess: x })} /></Row>
                    <Row label={t("settings.notifyPublishFailure")}><Switch checked={v.onPublishFailure} onCheckedChange={(x) => set({ onPublishFailure: x })} /></Row>
                    <Row label={t("settings.notifyQueuePaused")}><Switch checked={v.onQueuePaused} onCheckedChange={(x) => set({ onQueuePaused: x })} /></Row>
                    <Notice className="mt-2">{t("settings.notificationChannelsNotice")}</Notice>
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
