"use client";

import { useQueryClient } from "@tanstack/react-query";
import { LockKeyhole, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Card, Field, Input } from "@reelflow/ui";
import { api, setCsrfToken, ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export default function LoginPage() {
  const { t } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const r = await api.post<{ csrfToken: string }>("/auth/login", { email, password });
      setCsrfToken(r.csrfToken);
      await qc.invalidateQueries({ queryKey: ["me"] });
      router.replace("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "خطا در ورود");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-sm p-8">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-info text-white shadow-lg shadow-accent/30">
            <Sparkles className="size-6" />
          </div>
          <div>
            <h1 className="text-lg font-bold">{t("app.name")}</h1>
            <p className="text-xs text-muted">{t("app.tagline")}</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <Field label={t("auth.email")}>
            <Input type="email" dir="ltr" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t("auth.password")}>
            <Input type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error ? <p className="text-xs text-danger">{error}</p> : null}
          <Button type="submit" className="w-full" loading={loading}>
            <LockKeyhole />
            {t("auth.signIn")}
          </Button>
        </form>
      </Card>
    </div>
  );
}
