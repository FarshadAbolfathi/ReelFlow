"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Star, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Switch, Tabs, cn } from "@reelflow/ui";
import { PageHeader } from "@/components/common";
import { useSession } from "@/components/session";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { ContentDTO, WatermarkConfig, WatermarkPresetDTO } from "@/lib/types";

const POSITIONS: [WatermarkConfig["position"], string][] = [
  ["TOP_LEFT", "بالا چپ"],
  ["TOP_CENTER", "بالا وسط"],
  ["TOP_RIGHT", "بالا راست"],
  ["CENTER", "وسط"],
  ["BOTTOM_LEFT", "پایین چپ"],
  ["BOTTOM_CENTER", "پایین وسط"],
  ["BOTTOM_RIGHT", "پایین راست"],
];

const DEFAULT: WatermarkConfig = {
  kind: "TEXT",
  text: "@MyPage",
  fontSizeRatio: 0.035,
  color: "#FFFFFF",
  opacity: 0.65,
  scale: 0.18,
  position: "BOTTOM_RIGHT",
  marginPx: 32,
  rotationDeg: 0,
  startSec: 0,
  endSec: null,
  animation: "NONE",
  respectSafeArea: true,
};

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="ltr tabular-nums">{format ? format(value) : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" dir="ltr" />
    </div>
  );
}

export default function WatermarksPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const presets = useQuery({ queryKey: ["watermarks"], queryFn: () => api.get<WatermarkPresetDTO[]>("/watermarks") });
  const content = useQuery({ queryKey: ["content", "wm-bg"], queryFn: () => api.get<{ items: ContentDTO[] }>("/content?pageSize=12&processingStatus=READY") });
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("New preset");
  const [isDefault, setIsDefault] = useState(false);
  const [cfg, setCfg] = useState<WatermarkConfig>(DEFAULT);
  const [presetKey, setPresetKey] = useState("INSTAGRAM_REEL");
  const [bg, setBg] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof WatermarkConfig>(k: K, v: WatermarkConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));

  const load = (p: WatermarkPresetDTO | null) => {
    setSelected(p?.id ?? null);
    setName(p?.name ?? "New preset");
    setIsDefault(p?.isDefault ?? false);
    setCfg({ ...DEFAULT, ...(p?.config ?? {}) });
  };
  useEffect(() => {
    if (!selected && presets.data?.[0]) load(presets.data[0]);
  }, [presets.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced live preview rendered by the same engine the pipeline uses.
  useEffect(() => {
    const handle = setTimeout(async () => {
      try {
        const blob = await api.blob("/watermarks/preview", { config: cfg, presetKey, ...(bg ? { contentId: bg } : {}) });
        setPreview((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(blob);
        });
        setPreviewError(null);
      } catch (e) {
        setPreviewError((e as Error).message);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [cfg, presetKey, bg]);

  const save = useMutation({
    mutationFn: () => {
      const body = { name, isDefault, config: cfg };
      return selected ? api.put<WatermarkPresetDTO>(`/watermarks/${selected}`, body) : api.post<WatermarkPresetDTO>("/watermarks", body);
    },
    onSuccess: (p) => {
      toast.success("قالب واترمارک ذخیره شد");
      setSelected(p.id);
      qc.invalidateQueries({ queryKey: ["watermarks"] });
    },
    onError: toast.error,
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/watermarks/${selected}`),
    onSuccess: () => {
      load(null);
      qc.invalidateQueries({ queryKey: ["watermarks"] });
    },
    onError: toast.error,
  });
  const upload = useMutation({
    mutationFn: () => {
      const f = fileRef.current?.files?.[0];
      if (!f) throw new Error("فایلی انتخاب نشده");
      const form = new FormData();
      form.append("file", f);
      return api.upload<{ imageAssetKey: string }>("/watermarks/image", form);
    },
    onSuccess: (r) => setCfg((c) => ({ ...c, kind: "IMAGE", imageAssetKey: r.imageAssetKey })),
    onError: toast.error,
  });
  const editable = can(["OWNER", "MANAGER"]);

  return (
    <>
      <PageHeader title={t("nav.watermarks")} description="پیش‌نمایش با همان موتوری ساخته می‌شود که ویدیوها را پردازش می‌کند؛ آنچه می‌بینید همان خروجی نهایی است." />
      <div className="grid gap-6 xl:grid-cols-[240px_1fr_360px]">
        <Card className="h-fit p-3">
          <div className="space-y-1">
            {presets.data?.map((p) => (
              <button key={p.id} onClick={() => load(p)} className={cn("flex w-full items-center justify-between rounded-lg px-3 py-2 text-start text-sm", selected === p.id ? "bg-surface-3" : "hover:bg-surface-2")}>
                {p.name}
                {p.isDefault ? <Star className="size-3.5 fill-warning text-warning" /> : null}
              </button>
            ))}
          </div>
          {editable ? <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => load(null)}><Plus /> قالب جدید</Button> : null}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>پیش‌نمایش</CardTitle>
            <div className="flex gap-2">
              <Select value={presetKey} onChange={(e) => setPresetKey(e.target.value)} className="w-40">
                <option value="INSTAGRAM_REEL">Reel 9:16</option>
                <option value="INSTAGRAM_FEED">Feed 4:5</option>
                <option value="INSTAGRAM_STORY">Story 9:16</option>
              </Select>
              <Select value={bg} onChange={(e) => setBg(e.target.value)} className="w-44">
                <option value="">پس‌زمینه خنثی</option>
                {content.data?.items.map((c) => <option key={c.id} value={c.id}>{c.source?.name ?? "آپلود"} · {c.id.slice(0, 6)}</option>)}
              </Select>
            </div>
          </CardHeader>
          <CardContent className="flex justify-center">
            <div className={cn("relative overflow-hidden rounded-2xl border border-line bg-black shadow-2xl", presetKey === "INSTAGRAM_FEED" ? "aspect-[4/5] w-[380px]" : "aspect-[9/16] w-[320px]")}>
              {preview ? <img src={preview} alt="watermark preview" className="size-full object-cover" /> : null}
              {cfg.respectSafeArea && presetKey !== "INSTAGRAM_FEED" ? (
                <>
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-[13%] border-b border-dashed border-warning/40 bg-warning/5" />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[20%] border-t border-dashed border-warning/40 bg-warning/5" />
                </>
              ) : null}
              {previewError ? <p className="absolute inset-x-0 bottom-2 text-center text-xs text-danger">{previewError}</p> : null}
            </div>
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardContent className="space-y-4">
            <Field label="نام قالب"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Tabs value={cfg.kind} onChange={(v) => set("kind", v)} items={[{ value: "TEXT", label: "متن" }, { value: "IMAGE", label: "تصویر / لوگو" }]} />
            {cfg.kind === "TEXT" ? (
              <>
                <Field label="متن"><Input value={cfg.text ?? ""} onChange={(e) => set("text", e.target.value)} /></Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="رنگ"><Input type="color" value={cfg.color} onChange={(e) => set("color", e.target.value.toUpperCase())} className="h-9 p-1" /></Field>
                  <Slider label="اندازه متن" value={cfg.fontSizeRatio} min={0.015} max={0.1} step={0.005} onChange={(v) => set("fontSizeRatio", v)} format={(v) => `${(v * 100).toFixed(1)}%`} />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Input ref={fileRef} type="file" accept="image/png,image/webp,image/jpeg" className="h-auto py-1.5" />
                <Button size="sm" variant="secondary" onClick={() => upload.mutate()} loading={upload.isPending}><Upload /> آپلود لوگو</Button>
                {cfg.imageAssetKey ? <Badge tone="success">لوگو بارگذاری شد</Badge> : null}
                <Slider label="مقیاس (نسبت به عرض)" value={cfg.scale} min={0.04} max={0.6} step={0.01} onChange={(v) => set("scale", v)} format={(v) => `${Math.round(v * 100)}%`} />
              </div>
            )}
            <Slider label="شفافیت" value={cfg.opacity} min={0.05} max={1} step={0.05} onChange={(v) => set("opacity", v)} format={(v) => `${Math.round(v * 100)}%`} />
            <Field label="موقعیت">
              <div className="grid grid-cols-3 gap-1.5">
                {POSITIONS.map(([p, label]) => (
                  <button key={p} onClick={() => set("position", p)} className={cn("rounded-lg px-2 py-1.5 text-[11px]", cfg.position === p ? "bg-accent text-white" : "bg-surface-2 text-muted hover:text-fg", p === "CENTER" && "col-span-3")}>
                    {label}
                  </button>
                ))}
              </div>
            </Field>
            <Slider label="فاصله از لبه (px)" value={cfg.marginPx} min={0} max={200} step={4} onChange={(v) => set("marginPx", v)} />
            <Slider label="چرخش" value={cfg.rotationDeg} min={-45} max={45} step={1} onChange={(v) => set("rotationDeg", v)} format={(v) => `${v}°`} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="شروع (ثانیه)"><Input type="number" min={0} value={cfg.startSec} onChange={(e) => set("startSec", Number(e.target.value))} /></Field>
              <Field label="پایان (ثانیه)"><Input type="number" min={0} placeholder="تا انتها" value={cfg.endSec ?? ""} onChange={(e) => set("endSec", e.target.value ? Number(e.target.value) : null)} /></Field>
            </div>
            <Field label="انیمیشن">
              <Select value={cfg.animation} onChange={(e) => set("animation", e.target.value as WatermarkConfig["animation"])}>
                <option value="NONE">بدون</option>
                <option value="FADE_IN">ظاهر شدن تدریجی</option>
                <option value="FADE_IN_OUT">ظاهر و محو شدن</option>
              </Select>
            </Field>
            <label className="flex items-center justify-between text-sm">
              رعایت ناحیه امن (زیر رابط کاربری اینستاگرام نرود)
              <Switch checked={cfg.respectSafeArea} onCheckedChange={(v) => set("respectSafeArea", v)} />
            </label>
            <label className="flex items-center justify-between text-sm">
              قالب پیش‌فرض
              <Switch checked={isDefault} onCheckedChange={setIsDefault} />
            </label>
            {editable ? (
              <div className="flex gap-2 pt-2">
                <Button className="flex-1" onClick={() => save.mutate()} loading={save.isPending}>ذخیره</Button>
                {selected ? <Button variant="danger" size="icon" onClick={() => remove.mutate()} aria-label="delete"><Trash2 /></Button> : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
