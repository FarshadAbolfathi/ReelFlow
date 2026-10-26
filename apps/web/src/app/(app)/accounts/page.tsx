"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Link2Off, Play, Plus, RefreshCw, ShieldCheck, UserCircle2 } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, Dialog, EmptyState, Field, Input } from "@reelflow/ui";
import { ErrorBanner, Notice, PageHeader, StatusBadge } from "@/components/common";
import { useSession } from "@/components/session";
import { useToast } from "@/components/toast";
import { api, ApiError } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { AccountDTO } from "@/lib/types";

function ConnectDialog({ account, onClose }: { account: AccountDTO | "new"; onClose: () => void }) {
  const { t } = useI18n();
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
      toast.success(t("accounts.connectedValidated"));
      qc.invalidateQueries({ queryKey: ["accounts"] });
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={existing ? t("accounts.reconnectTitle") : t("accounts.connectTitle")}
      description={t("accounts.graphDesc")}
      footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button onClick={() => connect.mutate()} loading={connect.isPending} disabled={!name || !igId || token.length < 20}><KeyRound /> {t("accounts.connectValidate")}</Button></>}
    >
      <div className="space-y-4">
        <Notice>{t("accounts.graphRequirements")}</Notice>
        <Field label={t("accounts.displayName")}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("accounts.mainPagePlaceholder")} /></Field>
        <Field label="Instagram Business Account ID"><Input dir="ltr" value={igId} onChange={(e) => setIgId(e.target.value)} placeholder="17841400000000000" /></Field>
        <Field label="Access Token"><Input dir="ltr" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></Field>
        <Field label={t("accounts.tokenExpiryLabel")}><Input type="date" dir="ltr" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

/** In-app Instagram login (PUBLISHING_ADAPTER_MODE=session). */
function SessionConnectDialog({ account, onClose }: { account: AccountDTO | "new"; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const existing = account === "new" ? null : account;
  const [name, setName] = useState(existing?.name ?? "");
  const [username, setUsername] = useState(existing?.username ?? existing?.externalAccountId ?? "");
  const [method, setMethod] = useState<"password" | "sessionid">("password");
  const [password, setPassword] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const connect = useMutation({
    mutationFn: () =>
      api.post("/accounts/session", {
        name,
        username,
        ...(method === "password" ? { password } : { sessionId }),
        ...(code ? { verificationCode: code } : {}),
      }),
    onSuccess: () => {
      toast.success(t("accounts.sessionConnected"));
      qc.invalidateQueries({ queryKey: ["accounts"] });
      onClose();
    },
    onError: (e) => {
      const reason = e instanceof ApiError ? (e.details?.reason as string | undefined) : undefined;
      if (reason === "TWO_FACTOR_REQUIRED") {
        setNeedsCode(true);
        setProblem(t("accounts.twoFactorRequired"));
      } else if (reason === "CHALLENGE_REQUIRED") {
        setProblem(t("accounts.challengeRequired"));
      } else if (reason === "BAD_CREDENTIALS") {
        setProblem(t("accounts.badCredentials"));
      } else {
        setProblem(null);
        toast.error(e);
      }
    },
  });
  const ready = !!name && !!username && (method === "password" ? password.length > 0 : sessionId.length >= 30) && (!needsCode || code.length >= 6);
  return (
    <Dialog
      open
      onClose={onClose}
      title={existing ? t("accounts.reloginTitle") : t("accounts.loginTitle")}
      description={t("accounts.sessionLoginDesc")}
      footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button onClick={() => connect.mutate()} loading={connect.isPending} disabled={!ready}><KeyRound /> {t("accounts.loginAndConnect")}</Button></>}
    >
      <div className="space-y-4">
        <Notice tone="warning">{t("accounts.sessionRiskNotice")}</Notice>
        {problem ? <Notice tone="danger">{problem}</Notice> : null}
        <Field label={t("accounts.displayName")}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("accounts.mainPagePlaceholder")} /></Field>
        <Field label={t("accounts.igUsernameLabel")}><Input dir="ltr" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="mypage" autoComplete="username" /></Field>
        <div className="flex gap-2">
          <Button size="sm" variant={method === "password" ? "primary" : "secondary"} onClick={() => setMethod("password")}>{t("auth.password")}</Button>
          <Button size="sm" variant={method === "sessionid" ? "primary" : "secondary"} onClick={() => setMethod("sessionid")}>{t("accounts.sessionIdMethod")}</Button>
        </div>
        {method === "password" ? (
          <Field label={t("auth.password")}><Input dir="ltr" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        ) : (
          <Field label="sessionid" hint={t("accounts.sessionIdHint")}>
            <Input dir="ltr" type="password" autoComplete="off" value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
          </Field>
        )}
        {needsCode || method === "password" ? (
          <Field label={needsCode ? t("accounts.twoFactorCodeLabel") : t("accounts.twoFactorCodeOptionalLabel")}><Input dir="ltr" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="123456" /></Field>
        ) : null}
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
  const sessionMode = settings.data?.environment.publishingAdapterMode === "session";
  const refresh = () => qc.invalidateQueries({ queryKey: ["accounts"] });
  const validate = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean; message: string; quota?: { used: number; total: number } }>(`/accounts/${id}/validate`),
    onSuccess: (r) => {
      if (r.ok) toast.success(`${t("accounts.connectionValid")}${r.quota ? ` — ${t("accounts.apiQuota")}: ${r.quota.used}/${r.quota.total}` : ""}`);
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
      toast.success(t("accounts.limitSaved"));
      refresh();
    },
    onError: toast.error,
  });

  return (
    <>
      <PageHeader
        title={t("nav.accounts")}
        description={t("accounts.pageDescription")}
        actions={can(["OWNER", "MANAGER"]) ? <Button onClick={() => setConnecting("new")}><Plus /> {t("accounts.connectAccount")}</Button> : null}
      />
      <ErrorBanner error={error} />
      {settings.data?.environment.publishingAdapterMode === "mock" ? (
        <Notice tone="warning" className="mb-4">
          {t("accounts.mockNoticeIntro")} {t("accounts.mockNoticeConfig")} <span className="ltr">.env</span> {t("accounts.mockNoticeConfig2")} <span className="ltr font-mono">PUBLISHING_ADAPTER_MODE=session</span> {t("accounts.mockNoticeOr")} <span className="ltr font-mono">live</span> {t("accounts.mockNoticeEnd")}
        </Notice>
      ) : null}
      {data?.length === 0 ? <EmptyState icon={<UserCircle2 />} title={t("accounts.noneConnectedTitle")} description={sessionMode ? t("accounts.noneConnectedSessionDesc") : t("accounts.noneConnectedGraphDesc")} /> : null}
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
                {a.pausedUntil ? ` ${t("accounts.pausedUntilPrefix")} ${formatDateTime(a.pausedUntil, locale)}` : ` ${t("accounts.pausedManualAction")}`}
              </Notice>
            ) : null}
            <dl className="mt-4 grid grid-cols-2 gap-y-2 text-xs">
              <dt className="text-muted">{a.tokenHint === "session" ? t("accounts.connectionLabel") : t("accounts.tokenLabel")}</dt><dd className="ltr text-end font-mono">{a.tokenHint === "session" ? (a.hasToken ? "Instagram login" : "—") : a.hasToken ? `•••• ${a.tokenHint ?? ""}` : "—"}</dd>
              <dt className="text-muted">{t("accounts.tokenExpiry")}</dt><dd className="text-end">{formatDateTime(a.tokenExpiresAt, locale)}</dd>
              <dt className="text-muted">{t("accounts.lastSuccessfulPublish")}</dt><dd className="text-end">{formatRelative(a.lastSuccessAt, locale)}</dd>
              <dt className="text-muted">{t("accounts.last24hPublishes")}</dt><dd className="text-end tabular-nums">{a.dailyPublishCount}{a.dailyLimit !== null ? ` / ${a.dailyLimit}` : ""}</dd>
              <dt className="text-muted">{t("accounts.consecutiveFailures")}</dt><dd className="text-end tabular-nums">{a.consecutiveFailures}</dd>
              {a.lastError ? (<><dt className="text-muted">{t("settings.lastErrorLabel")}</dt><dd className="line-clamp-2 text-end text-warning">{a.lastError}</dd></>) : null}
            </dl>
            {can(["OWNER", "MANAGER"]) ? (
              <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
                <Button size="sm" variant="secondary" onClick={() => validate.mutate(a.id)} loading={validate.isPending}><ShieldCheck /> {t("accounts.checkConnection")}</Button>
                <Button size="sm" variant="secondary" onClick={() => setConnecting(a)}><RefreshCw /> {t("accounts.reconnect")}</Button>
                {a.safetyState === "PAUSED" && a.status === "CONNECTED" ? <Button size="sm" variant="success" onClick={() => resume.mutate(a.id)}><Play /> {t("accounts.resumePublishing")}</Button> : null}
                {a.status !== "DISCONNECTED" ? <Button size="sm" variant="ghost" onClick={() => disconnect.mutate(a.id)}><Link2Off /> {t("accounts.disconnect")}</Button> : null}
                <label className="ms-auto flex items-center gap-2 text-xs text-muted">
                  {t("accounts.dailyAccountLimit")}
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
      {connecting ? (
        sessionMode ? <SessionConnectDialog account={connecting} onClose={() => setConnecting(null)} /> : <ConnectDialog account={connecting} onClose={() => setConnecting(null)} />
      ) : null}
    </>
  );
}
