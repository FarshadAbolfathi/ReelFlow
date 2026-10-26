"use client";

import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { DateTime } from "luxon";
import { useMemo, useState } from "react";
import { Button, Card, Tabs, cn } from "@reelflow/ui";
import { PageHeader, StatusBadge } from "@/components/common";
import { SchedulesPanel } from "@/components/schedule-editor";
import { useSession } from "@/components/session";
import { useToast } from "@/components/toast";
import { api, qs } from "@/lib/api";
import { DEFAULT_TZ } from "@/lib/format";
import { jalaliDayLabel, jalaliMonthTitle, jalaliParts, startOfJalaliMonth } from "@/lib/jalali";
import { useI18n } from "@/lib/i18n";
import type { PostDTO } from "@/lib/types";

type View = "month" | "week" | "day" | "agenda";
const TZ = DEFAULT_TZ;
const COLOR: Record<string, string> = {
  WAITING_APPROVAL: "border-warning/50 bg-warning/15 text-warning",
  SCHEDULED: "border-accent/50 bg-accent/15 text-accent",
  READY: "border-accent/50 bg-accent/15 text-accent",
  PUBLISHING: "border-info/50 bg-info/15 text-info",
  PUBLISHED: "border-success/50 bg-success/15 text-success",
  FAILED: "border-danger/50 bg-danger/15 text-danger",
  PAUSED: "border-line bg-surface-3 text-muted",
};
const DRAGGABLE = new Set(["SCHEDULED", "WAITING_APPROVAL", "PAUSED", "FAILED"]);

function Chip({ post, compact }: { post: PostDTO; compact?: boolean }) {
  const { t } = useI18n();
  const { can } = useSession();
  const draggable = DRAGGABLE.has(post.status) && can(["OWNER", "MANAGER"]);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: post.id, data: post, disabled: !draggable });
  const time = DateTime.fromISO(post.scheduledAt).setZone(TZ).toFormat("HH:mm");
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
      className={cn(
        "truncate rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        COLOR[post.status] ?? "border-line bg-surface-2",
        draggable && "cursor-grab active:cursor-grabbing",
        isDragging && "z-50 opacity-80 shadow-lg",
      )}
      title={`${post.content?.source?.name ?? ""} · ${post.status}`}
    >
      <span className="ltr">{time}</span>
      {!compact ? <span className="ms-1">{post.content?.source?.name ?? t("dash.upload")}</span> : null}
    </div>
  );
}

function DropCell({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <div ref={setNodeRef} className={cn(className, isOver && "bg-accent/10 ring-1 ring-accent/40")}>{children}</div>;
}

export default function CalendarPage() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState<DateTime>(() => DateTime.now().setZone(TZ).startOf("day"));
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const intl = locale === "fa" ? "fa-IR" : "en-GB";
  // Persian UI uses the Jalali calendar for month grids and labels; English uses Gregorian.
  const jalali = locale === "fa";
  const monthStart = (d: DateTime) => (jalali ? startOfJalaliMonth(d) : d.startOf("month"));
  const sameMonth = (a: DateTime, b: DateTime) => (jalali ? jalaliParts(a).month === jalaliParts(b).month : a.month === b.month);
  const dayNum = (d: DateTime) => (jalali ? jalaliDayLabel(d, { day: "numeric" }) : d.setLocale(intl).toFormat("d"));
  const dayShort = (d: DateTime) => (jalali ? jalaliDayLabel(d, { weekday: "short", day: "numeric", month: "short" }) : d.setLocale(intl).toFormat("ccc d"));

  // Weeks start on Saturday (Persian calendar convention).
  const startOfWeek = (d: DateTime) => d.minus({ days: (d.weekday + 1) % 7 }).startOf("day");
  const range = useMemo(() => {
    if (view === "day") return { from: cursor, to: cursor.plus({ days: 1 }) };
    if (view === "week") return { from: startOfWeek(cursor), to: startOfWeek(cursor).plus({ days: 7 }) };
    if (view === "agenda") return { from: cursor, to: cursor.plus({ days: 14 }) };
    const first = startOfWeek(monthStart(cursor));
    return { from: first, to: first.plus({ days: 42 }) };
  }, [view, cursor]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: posts = [] } = useQuery({
    queryKey: ["queue", "calendar", range.from.toISO()],
    queryFn: () => api.get<PostDTO[]>(`/queue${qs({ from: range.from.toUTC().toISO()!, to: range.to.toUTC().toISO()! })}`),
    refetchInterval: 20_000,
  });
  const visible = posts.filter((p) => p.status !== "CANCELLED");
  const byDay = useMemo(() => {
    const m = new Map<string, PostDTO[]>();
    for (const p of visible) {
      const k = DateTime.fromISO(p.scheduledAt).setZone(TZ).toISODate()!;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return m;
  }, [visible]);

  const move = useMutation({
    mutationFn: ({ id, at }: { id: string; at: DateTime }) => api.patch(`/posts/${id}/schedule`, { scheduledAt: at.toUTC().toISO() }),
    onSuccess: () => {
      toast.success(t("calendar.moveSuccess"));
      qc.invalidateQueries({ queryKey: ["queue"] });
    },
    onError: toast.error,
  });

  const onDragEnd = (e: DragEndEvent) => {
    const post = e.active.data.current as PostDTO | undefined;
    if (!post || !e.over) return;
    const current = DateTime.fromISO(post.scheduledAt).setZone(TZ);
    const target = String(e.over.id); // "2026-10-03" or "2026-10-03T14"
    const [date, hour] = target.split("T");
    let at = DateTime.fromISO(date!, { zone: TZ }).set({ hour: current.hour, minute: current.minute });
    if (hour) at = at.set({ hour: Number(hour), minute: current.minute });
    if (at.toMillis() !== current.toMillis()) move.mutate({ id: post.id, at });
  };

  const step = (dir: 1 | -1) =>
    setCursor((c) =>
      view === "month"
        ? dir === 1
          ? monthStart(monthStart(c).plus({ days: 32 }))
          : monthStart(monthStart(c).minus({ days: 1 }))
        : view === "week"
          ? c.plus({ weeks: dir })
          : c.plus({ days: dir * (view === "agenda" ? 14 : 1) }),
    );
  const rangeLabel = (d: DateTime) => (jalali ? jalaliDayLabel(d, { day: "numeric", month: "long" }) : d.setLocale(intl).toFormat("d LLL"));
  const title = view === "month" ? (jalali ? jalaliMonthTitle(cursor) : cursor.setLocale(intl).toFormat("LLLL yyyy")) : `${rangeLabel(range.from)} – ${rangeLabel(range.to.minus({ days: 1 }))}`;
  const weekDays = Array.from({ length: 7 }, (_, i) => range.from.plus({ days: i }));

  return (
    <>
      <PageHeader title={t("nav.calendar")} description={t("calendar.description")} />
      <Card className="mb-6 p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button size="icon" variant="ghost" onClick={() => step(-1)} aria-label="previous"><ChevronRight /></Button>
            <Button size="sm" variant="secondary" onClick={() => setCursor(DateTime.now().setZone(TZ).startOf("day"))}>{t("calendar.today")}</Button>
            <Button size="icon" variant="ghost" onClick={() => step(1)} aria-label="next"><ChevronLeft /></Button>
            <span className="ms-2 text-sm font-semibold">{title}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden gap-2 text-[11px] md:flex">
              {["WAITING_APPROVAL", "SCHEDULED", "PUBLISHED", "FAILED"].map((s) => <StatusBadge key={s} status={s} />)}
            </div>
            <Tabs value={view} onChange={setView} items={[{ value: "month", label: t("calendar.month") }, { value: "week", label: t("calendar.week") }, { value: "day", label: t("calendar.day") }, { value: "agenda", label: t("calendar.agenda") }]} />
          </div>
        </div>

        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          {view === "month" ? (
            <div className="grid grid-cols-7 overflow-hidden rounded-xl border border-line">
              {weekDays.map((d) => <div key={d.toISODate()} className="border-b border-line bg-surface-2 px-2 py-2 text-center text-[11px] text-muted">{d.setLocale(intl).toFormat("cccc")}</div>)}
              {Array.from({ length: 42 }, (_, i) => range.from.plus({ days: i })).map((d) => {
                const key = d.toISODate()!;
                const inMonth = sameMonth(d, cursor);
                const today = d.hasSame(DateTime.now().setZone(TZ), "day");
                return (
                  <DropCell key={key} id={key} className={cn("min-h-28 border-b border-e border-line/70 p-1.5 transition-colors", !inMonth && "bg-surface-0/60")}>
                    <p className={cn("mb-1 text-[11px]", today ? "inline-flex size-5 items-center justify-center rounded-full bg-accent font-bold text-white" : inMonth ? "text-fg" : "text-muted/50")}>{dayNum(d)}</p>
                    <div className="space-y-1">{byDay.get(key)?.map((p) => <Chip key={p.id} post={p} />)}</div>
                  </DropCell>
                );
              })}
            </div>
          ) : view === "agenda" ? (
            <div className="space-y-4">
              {[...byDay.entries()].sort().map(([day, list]) => (
                <div key={day}>
                  <p className="mb-2 text-xs font-semibold text-muted">{jalali ? jalaliDayLabel(DateTime.fromISO(day, { zone: TZ }), { weekday: "long", day: "numeric", month: "long" }) : DateTime.fromISO(day, { zone: TZ }).setLocale(intl).toFormat("cccc d LLLL")}</p>
                  <div className="space-y-2">
                    {list.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).map((p) => (
                      <Link key={p.id} href={p.content ? `/content/${p.content.id}` : "#"} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-4 py-2.5 text-sm hover:bg-surface-3">
                        <span className="ltr tabular-nums">{DateTime.fromISO(p.scheduledAt).setZone(TZ).toFormat("HH:mm")}</span>
                        <span className="flex-1 truncate">{p.content?.source?.name ?? t("dash.upload")} → {p.account?.name}</span>
                        <StatusBadge status={p.status} />
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
              {byDay.size === 0 ? <p className="py-10 text-center text-xs text-muted">{t("calendar.noPosts")}</p> : null}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className={cn("grid min-w-[720px]", view === "week" ? "grid-cols-[3.5rem_repeat(7,1fr)]" : "grid-cols-[3.5rem_1fr]")}>
                <div />
                {(view === "week" ? weekDays : [cursor]).map((d) => (
                  <div key={d.toISODate()} className="border-b border-line px-2 py-2 text-center text-[11px] text-muted">{dayShort(d)}</div>
                ))}
                {Array.from({ length: 18 }, (_, i) => i + 6).map((h) => (
                  <div key={h} className="contents">
                    <div className="ltr border-e border-line/60 pe-2 pt-1 text-end text-[10px] text-muted">{String(h).padStart(2, "0")}:00</div>
                    {(view === "week" ? weekDays : [cursor]).map((d) => {
                      const key = `${d.toISODate()}T${h}`;
                      const list = (byDay.get(d.toISODate()!) ?? []).filter((p) => DateTime.fromISO(p.scheduledAt).setZone(TZ).hour === h);
                      return (
                        <DropCell key={key} id={key} className="min-h-12 border-b border-e border-line/40 p-1">
                          <div className="space-y-1">{list.map((p) => <Chip key={p.id} post={p} compact={view === "week"} />)}</div>
                        </DropCell>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}
        </DndContext>
      </Card>
      <SchedulesPanel />
    </>
  );
}
