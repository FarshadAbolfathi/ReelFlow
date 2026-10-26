"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  Bell,
  CalendarDays,
  Clapperboard,
  Cog,
  Droplets,
  FileText,
  Globe,
  LayoutDashboard,
  ListOrdered,
  LogOut,
  Menu,
  Moon,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Sun,
  UserCircle2,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Button, cn } from "@reelflow/ui";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { useSession } from "./session";

const NAV: { href: string; key: MessageKey; icon: ReactNode }[] = [
  { href: "/", key: "nav.dashboard", icon: <LayoutDashboard /> },
  { href: "/sources", key: "nav.sources", icon: <Globe /> },
  { href: "/content", key: "nav.library", icon: <Clapperboard /> },
  { href: "/processing", key: "nav.processing", icon: <Workflow /> },
  { href: "/calendar", key: "nav.calendar", icon: <CalendarDays /> },
  { href: "/queue", key: "nav.queue", icon: <ListOrdered /> },
  { href: "/accounts", key: "nav.accounts", icon: <UserCircle2 /> },
  { href: "/watermarks", key: "nav.watermarks", icon: <Droplets /> },
  { href: "/templates", key: "nav.templates", icon: <FileText /> },
  { href: "/analytics", key: "nav.analytics", icon: <BarChart3 /> },
  { href: "/logs", key: "nav.logs", icon: <ScrollText /> },
  { href: "/settings", key: "nav.settings", icon: <Cog /> },
];

interface Dashboard {
  safety: { id: string; name: string; safetyState: string }[];
  autoPublishEnabled: boolean;
}

function ThemeToggle() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const saved = localStorage.getItem("rf-theme");
    const isDark = saved !== "light";
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("rf-theme", next ? "dark" : "light");
  };
  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="theme">
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

function LocaleToggle() {
  const { locale, setLocale } = useI18n();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setLocale(locale === "fa" ? "en" : "fa")}
      aria-label="language"
      title={locale === "fa" ? "English" : "فارسی"}
    >
      <span className="text-xs font-semibold">{locale === "fa" ? "EN" : "فا"}</span>
    </Button>
  );
}

function Notifications() {
  const { locale, t } = useI18n();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<{ items: { id: string; level: string; title: string; body: string; createdAt: string; readAt: string | null }[]; unreadCount: number }>("/notifications"),
    refetchInterval: 30_000,
  });
  const markAll = useMutation({ mutationFn: () => api.post("/notifications/read", { ids: "all" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }) });
  return (
    <div className="relative">
      <Button variant="ghost" size="icon" onClick={() => setOpen((o) => !o)} aria-label="notifications">
        <Bell />
        {data?.unreadCount ? <span className="absolute end-1.5 top-1.5 size-2 rounded-full bg-danger" /> : null}
      </Button>
      {open ? (
        <div className="absolute end-0 top-11 z-40 w-96 max-w-[90vw] overflow-hidden rounded-2xl border border-line bg-surface-1 shadow-2xl">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-sm font-semibold">{t("shell.notifications")}</span>
            <button className="text-xs text-accent" onClick={() => markAll.mutate()}>
              {t("shell.markAllRead")}
            </button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {(data?.items ?? []).length === 0 ? <p className="p-6 text-center text-xs text-muted">{t("shell.noNotifications")}</p> : null}
            {data?.items.map((n) => (
              <div key={n.id} className={cn("border-b border-line/60 px-4 py-3", !n.readAt && "bg-accent/5")}>
                <div className="flex items-center justify-between gap-2">
                  <p className={cn("text-xs font-semibold", n.level === "ERROR" ? "text-danger" : n.level === "WARNING" ? "text-warning" : n.level === "SUCCESS" ? "text-success" : "text-fg")}>{n.title}</p>
                  <span className="text-[10px] text-muted">{formatRelative(n.createdAt, locale)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted">{n.body}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SafetyPill() {
  const { t, ts } = useI18n();
  const { data } = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<Dashboard>("/dashboard"), refetchInterval: 30_000 });
  const states = data?.safety.map((a) => a.safetyState) ?? [];
  const worst = states.includes("PAUSED") ? "PAUSED" : states.includes("WARNING") ? "WARNING" : "HEALTHY";
  const color = { HEALTHY: "text-success bg-success/10 ring-success/25", WARNING: "text-warning bg-warning/10 ring-warning/25", PAUSED: "text-danger bg-danger/10 ring-danger/25" }[worst];
  return (
    <Link href="/accounts" className={cn("hidden items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 sm:inline-flex", color)}>
      <ShieldCheck className="size-3.5" />
      {t("shell.safety")}: {ts("status", worst)}
      {data ? <span className="text-muted">· {t("shell.autoPublish")} {data.autoPublishEnabled ? t("common.on") : t("common.off")}</span> : null}
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { t, ts } = useI18n();
  const { user, signOut } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => setMobileOpen(false), [pathname]);

  const nav = (
    <nav className="flex flex-col gap-0.5 px-3">
      {NAV.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors [&_svg]:size-[18px]",
              active ? "bg-surface-3 font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            <span className={active ? "text-accent" : ""}>{item.icon}</span>
            {t(item.key)}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className={cn("fixed inset-y-0 start-0 z-40 w-64 flex-col border-e border-line bg-surface-1/90 backdrop-blur-xl lg:flex", mobileOpen ? "flex" : "hidden")}>
        <div className="flex h-16 items-center gap-3 px-6">
          <div className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-info text-white">
            <Sparkles className="size-4" />
          </div>
          <div>
            <p className="text-sm font-bold">{t("app.name")}</p>
            <p className="text-[10px] text-muted">{t("app.tagline")}</p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-2">{nav}</div>
        <div className="border-t border-line p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-[11px] text-muted">{ts("role", user.role)} · <span className="ltr">{user.email}</span></p>
            </div>
            <Button variant="ghost" size="icon" onClick={signOut} aria-label={t("auth.signOut")}>
              <LogOut />
            </Button>
          </div>
        </div>
      </aside>
      {mobileOpen ? <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setMobileOpen(false)} /> : null}
      <div className="flex min-w-0 flex-1 flex-col lg:ps-64">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-line bg-surface-0/70 px-4 backdrop-blur-xl sm:px-8">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="menu">
              <Menu />
            </Button>
            <SafetyPill />
          </div>
          <div className="flex items-center gap-1">
            <Notifications />
            <LocaleToggle />
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-8 sm:px-8">{children}</main>
      </div>
    </div>
  );
}
