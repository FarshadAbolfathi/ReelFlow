"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FolderInput, Globe, Pencil, Plus, RefreshCw, ShieldQuestion, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Switch, Table, Td, Textarea, Th } from "@reelflow/ui";
import { ErrorBanner, Notice, PageHeader, RightsBadge, StatusBadge } from "@/components/common";
import { useSession } from "@/components/session";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useI18n, type MessageKey } from "@/lib/i18n";
import type { SourceDTO } from "@/lib/types";

const PLATFORMS: { value: string; labelKey: MessageKey }[] = [
  { value: "LOCAL", labelKey: "sources.platform.local" },
  { value: "GENERIC_FEED", labelKey: "sources.platform.feed" },
  { value: "INSTAGRAM", labelKey: "sources.platform.instagram" },
  { value: "DIRECT_URL", labelKey: "sources.platform.directUrl" },
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
  const { t, ts } = useI18n();
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
      toast.success(user.role === "OWNER" ? t("sources.saved") : t("sources.savedPendingApproval"));
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
      title={source === "new" ? t("sources.addTitle") : t("sources.editTitle")}
      description={t("sources.dialogDesc")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.name || (needsUrl && !f.url)}>{t("common.save")}</Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t("sources.nameLabel")}>
          <Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Fitness Page 1" />
        </Field>
        <Field label={t("sources.platformLabel")}>
          <Select value={f.platform} onChange={(e) => set("platform", e.target.value)}>
            {PLATFORMS.map((p) => <option key={p.value} value={p.value}>{t(p.labelKey)}</option>)}
          </Select>
        </Field>
        {needsUrl ? (
          <Field label={t("sources.urlLabel")} className="md:col-span-2" hint={t("sources.urlHint")}>
            <Input dir="ltr" value={f.url} onChange={(e) => set("url", e.target.value)} placeholder="https://example.com/feed.xml" />
          </Field>
        ) : (
          <Notice className="md:col-span-2">
            {t("sources.inboxNoticePrefix")} <span className="ltr font-mono">storage/inbox/{(f.name || "source").toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}/</span> {t("sources.inboxNoticeMid")} <span className="ltr">.txt</span> {t("sources.inboxNoticeSuffix")}
          </Notice>
        )}
        {f.platform === "INSTAGRAM" ? (
          <Notice tone="warning" className="md:col-span-2">
            {t("sources.instagramNoticePrefix")} <span className="ltr font-mono">https://www.instagram.com/pagename/</span>{t("sources.instagramNoticeSuffix")}
          </Notice>
        ) : null}

        <Field label={t("sources.rightsStatusLabel")} hint={t("sources.rightsStatusHint")}>
          <Select value={f.rightsStatus} onChange={(e) => set("rightsStatus", e.target.value)}>
            {RIGHTS.map((r) => <option key={r} value={r}>{ts("rights", r)}</option>)}
          </Select>
        </Field>
        <Field label={t("sources.permissionEvidenceLabel")} hint={t("sources.permissionEvidenceHint")}>
          <Input value={f.rightsEvidence} onChange={(e) => set("rightsEvidence", e.target.value)} />
        </Field>

        <Field label={t("sources.attributionTextLabel")} hint={t("sources.attributionTextHint")}>
          <Input value={f.attributionText} onChange={(e) => set("attributionText", e.target.value)} placeholder="🎬 via @funnypage" />
        </Field>
        <Field label={t("sources.allowedMediaLabel")}>
          <div className="flex h-9 items-center gap-4 text-sm">
            {["VIDEO", "IMAGE"].map((m) => (
              <label key={m} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={f.allowedMediaTypes.includes(m)}
                  onChange={(e) => set("allowedMediaTypes", e.target.checked ? [...f.allowedMediaTypes, m] : f.allowedMediaTypes.filter((x) => x !== m))}
                />
                {m === "VIDEO" ? t("common.video") : t("common.image")}
              </label>
            ))}
          </div>
        </Field>
        <Field label={t("sources.checkIntervalLabel")}>
          <Input type="number" min={15} value={f.importFrequencyMinutes} onChange={(e) => set("importFrequencyMinutes", Number(e.target.value))} />
        </Field>
        <Field label={t("sources.maxItemsLabel")}>
          <Input type="number" min={1} max={50} value={f.maxItemsPerInterval} onChange={(e) => set("maxItemsPerInterval", Number(e.target.value))} />
        </Field>
        <div className="flex flex-col gap-3 md:col-span-2">
          {(
            [
              ["active", t("common.active")],
              ["approvalRequired", t("sources.approvalRequiredLabel")],
              ["attributionRequired", t("sources.attributionRequiredLabel")],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center justify-between rounded-xl bg-surface-2 px-4 py-2.5 text-sm">
              {label}
              <Switch checked={f[k as "active"] as boolean} onCheckedChange={(v) => set(k as "active", v)} />
            </label>
          ))}
        </div>
        <Field label={t("sources.notesLabel")} className="md:col-span-2">
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
      toast.success(t("sources.reviewSaved"));
      qc.invalidateQueries({ queryKey: ["sources"] });
    },
    onError: toast.error,
  });
  const discover = useMutation({
    mutationFn: (id: string) => api.post(`/sources/${id}/discover`),
    onSuccess: () => toast.success(t("sources.discoveryQueued")),
    onError: toast.error,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/sources/${id}`),
    onSuccess: () => {
      toast.success(t("sources.deleted"));
      qc.invalidateQueries({ queryKey: ["sources"] });
    },
    onError: toast.error,
  });
  const pending = data?.filter((s) => s.vettingStatus === "PENDING_REVIEW").length ?? 0;

  return (
    <>
      <PageHeader
        title={t("nav.sources")}
        description={t("sources.pageDescription")}
        actions={
          can(["OWNER", "MANAGER"]) ? (
            <Button onClick={() => setEditing("new")}>
              <Plus /> {t("sources.addTitle")}
            </Button>
          ) : null
        }
      />
      <ErrorBanner error={error} />
      {pending > 0 && can(["OWNER"]) ? (
        <Notice tone="warning" className="mb-4">
          {pending} {t("sources.pendingReviewNotice")}
        </Notice>
      ) : null}
      <div className="mb-4 flex gap-2">
        {["", "PENDING_REVIEW", "APPROVED", "REJECTED"].map((v) => (
          <Button key={v} size="sm" variant={filter === v ? "secondary" : "ghost"} onClick={() => setFilter(v)}>
            {v ? <StatusBadge status={v} /> : t("common.all")}
          </Button>
        ))}
      </div>
      <Card>
        {data?.length === 0 ? (
          <div className="p-6">
            <EmptyState icon={<Globe />} title={t("sources.noneTitle")} description={t("sources.noneDesc")} />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("common.source")}</Th>
                <Th>{t("sources.reviewStatusHeader")}</Th>
                <Th>{t("sources.rightsHeader")}</Th>
                <Th>{t("common.content")}</Th>
                <Th>{t("sources.lastCheckHeader")}</Th>
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
                        <p className="font-medium">{s.name} {!s.active ? <Badge className="ms-1">{t("sources.inactive")}</Badge> : null}</p>
                        <p className="ltr truncate text-[11px] text-muted">{s.url ?? s.platform}</p>
                        {s.lastError ? <p className="mt-1 max-w-md text-[11px] text-warning">{s.lastError}</p> : null}
                      </div>
                    </div>
                  </Td>
                  <Td><StatusBadge status={s.vettingStatus} /></Td>
                  <Td>
                    <div className="flex items-center gap-1.5">
                      <RightsBadge rights={s.rightsStatus} />
                      {s.rightsStatus === "UNKNOWN" ? <ShieldQuestion className="size-4 text-warning" aria-label={t("sources.unknownRightsAria")} /> : null}
                    </div>
                  </Td>
                  <Td className="tabular-nums">{s.contentCount ?? 0}</Td>
                  <Td className="text-xs text-muted">{formatRelative(s.lastDiscoveryAt, locale)}</Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      {can(["OWNER"]) && s.vettingStatus !== "APPROVED" ? (
                        <Button size="sm" variant="success" onClick={() => review.mutate({ id: s.id, decision: "APPROVED" })}>
                          <Check /> {t("common.approve")}
                        </Button>
                      ) : null}
                      {can(["OWNER"]) && s.vettingStatus !== "REJECTED" ? (
                        <Button size="sm" variant="ghost" onClick={() => review.mutate({ id: s.id, decision: "REJECTED" })} aria-label={t("common.reject")}>
                          <X />
                        </Button>
                      ) : null}
                      {s.vettingStatus === "APPROVED" && can(["OWNER", "MANAGER"]) ? (
                        <Button size="sm" variant="ghost" onClick={() => discover.mutate(s.id)} aria-label={t("sources.discoverNowAria")}>
                          <RefreshCw />
                        </Button>
                      ) : null}
                      {can(["OWNER", "MANAGER"]) ? (
                        <Button size="sm" variant="ghost" onClick={() => setEditing(s)} aria-label={t("common.edit")}>
                          <Pencil />
                        </Button>
                      ) : null}
                      {can(["OWNER"]) ? (
                        <Button size="sm" variant="ghost" onClick={() => remove.mutate(s.id)} aria-label={t("common.delete")} loading={remove.isPending && remove.variables === s.id}>
                          <Trash2 />
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
