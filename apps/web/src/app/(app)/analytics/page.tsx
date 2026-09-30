"use client";

import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Table, Td, Th } from "@reelflow/ui";
import { Notice, PageHeader, StatCard } from "@/components/common";
import { api } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { Activity, Percent, Send, XCircle } from "lucide-react";

interface Overview {
  sources: { id: string; name: string; imported: number; published: number }[];
  success: { succeeded: number; failed: number; rate: number | null };
  activity: { day: string; imported: number; published: number; failed: number }[];
}

export default function AnalyticsPage() {
  const { t, locale } = useI18n();
  const { data } = useQuery({ queryKey: ["analytics-overview"], queryFn: () => api.get<Overview>("/analytics/overview") });
  const totalPublished = data?.activity.reduce((a, d) => a + d.published, 0) ?? 0;
  const totalImported = data?.activity.reduce((a, d) => a + d.imported, 0) ?? 0;
  const activeDays = data?.activity.filter((d) => d.published > 0).length ?? 0;

  return (
    <>
      <PageHeader title={t("nav.analytics")} description="آمار ۳۰ روز اخیر بر اساس رویدادهای ثبت‌شده در ReelFlow." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="وارد شده" value={formatNumber(totalImported, locale)} icon={<Activity />} tone="info" />
        <StatCard label="منتشر شده" value={formatNumber(totalPublished, locale)} icon={<Send />} tone="success" hint={`میانگین ${activeDays ? (totalPublished / activeDays).toFixed(1) : 0} پست در روزهای فعال`} />
        <StatCard label="نرخ موفقیت انتشار" value={data?.success.rate === null || !data ? "—" : `${Math.round(data.success.rate * 100)}%`} icon={<Percent />} tone="accent" />
        <StatCard label="تلاش‌های ناموفق" value={formatNumber(data?.success.failed, locale)} icon={<XCircle />} tone="danger" />
      </div>
      <Card className="mt-6">
        <CardHeader>
          <div>
            <CardTitle>تناوب انتشار</CardTitle>
            <CardDescription>پست‌های منتشرشده و تلاش‌های ناموفق در هر روز</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="h-72" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data?.activity ?? []} margin={{ left: -20 }}>
              <CartesianGrid stroke="var(--color-line)" vertical={false} />
              <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} stroke="var(--color-muted)" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} stroke="var(--color-muted)" fontSize={11} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={{ background: "var(--color-surface-2)", border: "1px solid var(--color-line)", borderRadius: 12, fontSize: 12 }} cursor={{ fill: "var(--color-surface-2)" }} />
              <Bar dataKey="published" name="انتشار" fill="var(--color-success)" radius={[6, 6, 0, 0]} />
              <Bar dataKey="failed" name="خطا" fill="var(--color-danger)" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
      <Card className="mt-6">
        <CardHeader><CardTitle>سهم منابع</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <thead><tr><Th>منبع</Th><Th>وارد شده</Th><Th>منتشر شده</Th><Th>نرخ انتشار</Th></tr></thead>
            <tbody>
              {data?.sources.map((s) => (
                <tr key={s.id}>
                  <Td>{s.name}</Td>
                  <Td className="tabular-nums">{formatNumber(s.imported, locale)}</Td>
                  <Td className="tabular-nums">{formatNumber(s.published, locale)}</Td>
                  <Td className="tabular-nums">{s.imported ? `${Math.round((s.published / s.imported) * 100)}%` : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardContent>
      </Card>
      <Notice className="mt-6">
        معیارهای تعامل (بازدید، لایک، ذخیره و…) فقط وقتی نمایش داده می‌شوند که API رسمی اینستاگرام آن‌ها را برگرداند؛ هیچ عددی تخمین زده یا ساخته نمی‌شود.
      </Notice>
    </>
  );
}
