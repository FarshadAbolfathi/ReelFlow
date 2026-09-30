"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Switch, Textarea, cn } from "@reelflow/ui";
import { Notice, PageHeader } from "@/components/common";
import { useSession } from "@/components/session";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { TemplateDTO } from "@/lib/types";

const VARS = ["{{original_caption}}", "{{attribution}}", "{{source}}", "{{cta}}", "{{hashtags}}", "{{brand}}", "{{date}}"];

export default function TemplatesPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["templates"], queryFn: () => api.get<TemplateDTO[]>("/templates") });
  const [sel, setSel] = useState<string | null>(null);
  const [f, setF] = useState({ name: "", body: "{{original_caption}}\n\n{{attribution}}\n\nFollow {{brand}} for more content.\n\n{{hashtags}}", cta: "", defaultHashtags: "", isDefault: false });
  const [rendered, setRendered] = useState("");

  const load = (tpl: TemplateDTO | null) => {
    setSel(tpl?.id ?? null);
    setF(tpl ? { name: tpl.name, body: tpl.body, cta: tpl.cta ?? "", defaultHashtags: tpl.defaultHashtags.join(" "), isDefault: tpl.isDefault } : { name: "قالب جدید", body: "{{original_caption}}\n\n{{attribution}}", cta: "", defaultHashtags: "", isDefault: false });
  };
  useEffect(() => {
    if (!sel && list.data?.[0]) load(list.data[0]);
  }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = setTimeout(() => {
      api.post<{ caption: string }>("/templates/render", { body: f.body, sample: { cta: f.cta || "Follow {{brand}} for more", hashtags: f.defaultHashtags || "funny reels" } }).then((r) => setRendered(r.caption)).catch(() => undefined);
    }, 300);
    return () => clearTimeout(h);
  }, [f.body, f.cta, f.defaultHashtags]);

  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name, body: f.body, cta: f.cta || null, defaultHashtags: f.defaultHashtags.split(/\s+/).map((x) => x.replace(/^#/, "")).filter(Boolean), isDefault: f.isDefault };
      return sel ? api.put<TemplateDTO>(`/templates/${sel}`, body) : api.post<TemplateDTO>("/templates", body);
    },
    onSuccess: (r) => {
      toast.success("قالب ذخیره شد");
      setSel(r.id);
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: toast.error,
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/templates/${sel}`),
    onSuccess: () => {
      load(null);
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: toast.error,
  });

  return (
    <>
      <PageHeader title={t("nav.templates")} description="قالب کپشن برای محتوای وارد شده. متغیرها هنگام انتشار جایگزین می‌شوند." />
      <div className="grid gap-6 xl:grid-cols-[240px_1fr_1fr]">
        <Card className="h-fit p-3">
          {list.data?.map((tpl) => (
            <button key={tpl.id} onClick={() => load(tpl)} className={cn("flex w-full items-center justify-between rounded-lg px-3 py-2 text-start text-sm", sel === tpl.id ? "bg-surface-3" : "hover:bg-surface-2")}>
              {tpl.name}
              {tpl.isDefault ? <Star className="size-3.5 fill-warning text-warning" /> : null}
            </button>
          ))}
          {can(["OWNER", "MANAGER"]) ? <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => load(null)}><Plus /> قالب جدید</Button> : null}
        </Card>
        <Card>
          <CardContent className="space-y-4">
            <Field label="نام"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="متن قالب">
              <Textarea className="min-h-48 font-mono text-xs" dir="auto" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
            </Field>
            <div className="flex flex-wrap gap-1.5">
              {VARS.map((v) => (
                <button key={v} onClick={() => setF({ ...f, body: `${f.body}${v}` })} className="ltr rounded-md bg-surface-2 px-2 py-1 font-mono text-[11px] text-muted hover:text-fg">{v}</button>
              ))}
            </div>
            <Field label="CTA پیش‌فرض" hint="می‌تواند {{brand}} داشته باشد"><Input value={f.cta} onChange={(e) => setF({ ...f, cta: e.target.value })} /></Field>
            <Field label="هشتگ‌های پیش‌فرض"><Input value={f.defaultHashtags} onChange={(e) => setF({ ...f, defaultHashtags: e.target.value })} placeholder="#funny #reels" /></Field>
            <label className="flex items-center justify-between text-sm">قالب پیش‌فرض<Switch checked={f.isDefault} onCheckedChange={(v) => setF({ ...f, isDefault: v })} /></label>
            <Notice>برای محتوای دیگران، اگر قالب شامل {"{{attribution}}"} نباشد، ذکر منبع به‌صورت خودکار به انتهای کپشن اضافه می‌شود.</Notice>
            {can(["OWNER", "MANAGER"]) ? (
              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => save.mutate()} loading={save.isPending}>ذخیره</Button>
                {sel ? <Button size="icon" variant="danger" onClick={() => remove.mutate()} aria-label="delete"><Trash2 /></Button> : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader><CardTitle>پیش‌نمایش با داده نمونه</CardTitle></CardHeader>
          <CardContent>
            <div className="whitespace-pre-wrap rounded-xl bg-surface-0 p-4 text-sm leading-7" dir="auto">{rendered}</div>
            <p className="mt-2 text-[11px] text-muted">{[...rendered].length} / 2200 نویسه</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
