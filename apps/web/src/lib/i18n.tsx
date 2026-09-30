"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Persian is the default UI language (RTL). English is fully wired so it can be
 * switched on later without touching components.
 */
const fa = {
  "app.name": "ریل‌فلو",
  "app.tagline": "مدیریت و انتشار محتوا",
  "nav.dashboard": "داشبورد",
  "nav.sources": "منابع",
  "nav.library": "کتابخانه محتوا",
  "nav.processing": "پردازش",
  "nav.calendar": "تقویم",
  "nav.queue": "صف انتشار",
  "nav.accounts": "حساب‌ها",
  "nav.watermarks": "واترمارک",
  "nav.templates": "قالب‌های کپشن",
  "nav.analytics": "تحلیل",
  "nav.logs": "گزارش‌ها",
  "nav.settings": "تنظیمات",
  "common.save": "ذخیره",
  "common.cancel": "انصراف",
  "common.delete": "حذف",
  "common.edit": "ویرایش",
  "common.add": "افزودن",
  "common.search": "جستجو…",
  "common.all": "همه",
  "common.loading": "در حال بارگذاری…",
  "common.retry": "تلاش دوباره",
  "common.approve": "تأیید",
  "common.reject": "رد",
  "common.preview": "پیش‌نمایش",
  "common.schedule": "زمان‌بندی",
  "common.pause": "توقف",
  "common.resume": "ادامه",
  "common.close": "بستن",
  "common.none": "هیچ",
  "common.yes": "بله",
  "common.no": "خیر",
  "auth.signIn": "ورود",
  "auth.email": "ایمیل",
  "auth.password": "رمز عبور",
  "auth.signOut": "خروج",
  "dash.importedToday": "وارد شده امروز",
  "dash.processed": "پردازش شده",
  "dash.pendingApproval": "در انتظار تأیید",
  "dash.scheduled": "زمان‌بندی شده",
  "dash.published": "منتشر شده امروز",
  "dash.failed": "خطاها (۲۴ساعت)",
  "dash.nextPost": "پست بعدی",
  "dash.activity": "فعالیت ۱۴ روز اخیر",
  "dash.safety": "پایش ایمنی",
  "dash.limits": "سقف انتشار",
  "status.PENDING": "در انتظار",
  "status.PROCESSING": "در حال پردازش",
  "status.READY": "آماده",
  "status.FAILED": "ناموفق",
  "status.APPROVED": "تأیید شده",
  "status.REJECTED": "رد شده",
  "status.PENDING_REVIEW": "در انتظار بررسی مالک",
  "status.WAITING_APPROVAL": "در انتظار تأیید",
  "status.SCHEDULED": "زمان‌بندی شده",
  "status.PUBLISHING": "در حال انتشار",
  "status.PUBLISHED": "منتشر شد",
  "status.CANCELLED": "لغو شده",
  "status.PAUSED": "متوقف",
  "status.UNSCHEDULED": "بدون زمان‌بندی",
  "status.HEALTHY": "سالم",
  "status.WARNING": "هشدار",
  "status.CONNECTED": "متصل",
  "status.DISCONNECTED": "قطع",
  "status.AUTH_EXPIRED": "مجوز منقضی شده",
  "status.ERROR": "خطا",
  "status.SUCCEEDED": "موفق",
  "status.RUNNING": "در حال اجرا",
  "status.QUEUED": "در صف",
  "status.SKIPPED": "رد شد (تکراری)",
  "rights.UNKNOWN": "نامشخص",
  "rights.USER_OWNS": "مالکیت خودم",
  "rights.PERMISSION_GRANTED": "اجازه گرفته شده",
  "rights.LICENSED": "دارای مجوز",
  "rights.PUBLIC_DOMAIN": "مالکیت عمومی",
  "rights.DO_NOT_IMPORT": "وارد نشود",
  "role.OWNER": "مالک",
  "role.MANAGER": "مدیر",
  "role.VIEWER": "بیننده",
  "mode.AUTO": "خودکار",
  "mode.SEMI_AUTO": "نیمه‌خودکار",
  "mode.MANUAL": "دستی",
} as const;

export type MessageKey = keyof typeof fa;

const en: Record<MessageKey, string> = {
  "app.name": "ReelFlow",
  "app.tagline": "Content pipeline",
  "nav.dashboard": "Dashboard",
  "nav.sources": "Sources",
  "nav.library": "Content Library",
  "nav.processing": "Processing",
  "nav.calendar": "Calendar",
  "nav.queue": "Publishing Queue",
  "nav.accounts": "Accounts",
  "nav.watermarks": "Watermarks",
  "nav.templates": "Templates",
  "nav.analytics": "Analytics",
  "nav.logs": "Logs",
  "nav.settings": "Settings",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.edit": "Edit",
  "common.add": "Add",
  "common.search": "Search…",
  "common.all": "All",
  "common.loading": "Loading…",
  "common.retry": "Retry",
  "common.approve": "Approve",
  "common.reject": "Reject",
  "common.preview": "Preview",
  "common.schedule": "Schedule",
  "common.pause": "Pause",
  "common.resume": "Resume",
  "common.close": "Close",
  "common.none": "None",
  "common.yes": "Yes",
  "common.no": "No",
  "auth.signIn": "Sign in",
  "auth.email": "Email",
  "auth.password": "Password",
  "auth.signOut": "Sign out",
  "dash.importedToday": "Imported today",
  "dash.processed": "Processed",
  "dash.pendingApproval": "Pending approval",
  "dash.scheduled": "Scheduled",
  "dash.published": "Published today",
  "dash.failed": "Failures (24h)",
  "dash.nextPost": "Next post",
  "dash.activity": "Last 14 days",
  "dash.safety": "Safety monitor",
  "dash.limits": "Publishing limits",
  "status.PENDING": "Pending",
  "status.PROCESSING": "Processing",
  "status.READY": "Ready",
  "status.FAILED": "Failed",
  "status.APPROVED": "Approved",
  "status.REJECTED": "Rejected",
  "status.PENDING_REVIEW": "Awaiting owner review",
  "status.WAITING_APPROVAL": "Waiting approval",
  "status.SCHEDULED": "Scheduled",
  "status.PUBLISHING": "Publishing",
  "status.PUBLISHED": "Published",
  "status.CANCELLED": "Cancelled",
  "status.PAUSED": "Paused",
  "status.UNSCHEDULED": "Unscheduled",
  "status.HEALTHY": "Healthy",
  "status.WARNING": "Warning",
  "status.CONNECTED": "Connected",
  "status.DISCONNECTED": "Disconnected",
  "status.AUTH_EXPIRED": "Auth expired",
  "status.ERROR": "Error",
  "status.SUCCEEDED": "Succeeded",
  "status.RUNNING": "Running",
  "status.QUEUED": "Queued",
  "status.SKIPPED": "Skipped",
  "rights.UNKNOWN": "Unknown",
  "rights.USER_OWNS": "I own it",
  "rights.PERMISSION_GRANTED": "Permission granted",
  "rights.LICENSED": "Licensed",
  "rights.PUBLIC_DOMAIN": "Public domain",
  "rights.DO_NOT_IMPORT": "Do not import",
  "role.OWNER": "Owner",
  "role.MANAGER": "Manager",
  "role.VIEWER": "Viewer",
  "mode.AUTO": "Auto",
  "mode.SEMI_AUTO": "Semi-auto",
  "mode.MANUAL": "Manual",
};

export type Locale = "fa" | "en";
const dictionaries: Record<Locale, Record<MessageKey, string>> = { fa, en };

interface I18n {
  locale: Locale;
  dir: "rtl" | "ltr";
  t: (key: MessageKey) => string;
  /** Translate a dynamic status/enum value, falling back to the raw value. */
  ts: (prefix: "status" | "rights" | "role" | "mode", value: string) => string;
  setLocale: (l: Locale) => void;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>("fa");
  useEffect(() => {
    const saved = localStorage.getItem("rf-locale");
    if (saved === "en" || saved === "fa") setLocale(saved);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "fa" ? "rtl" : "ltr";
    localStorage.setItem("rf-locale", locale);
  }, [locale]);
  const value = useMemo<I18n>(() => {
    const dict = dictionaries[locale];
    return {
      locale,
      dir: locale === "fa" ? "rtl" : "ltr",
      t: (k) => dict[k] ?? k,
      ts: (prefix, v) => (dict as Record<string, string>)[`${prefix}.${v}`] ?? v,
      setLocale,
    };
  }, [locale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}
