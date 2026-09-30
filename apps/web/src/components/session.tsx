"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { api, setCsrfToken, ApiError } from "@/lib/api";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: "OWNER" | "MANAGER" | "VIEWER";
}

const Ctx = createContext<{ user: SessionUser; can: (roles: SessionUser["role"][]) => boolean; signOut: () => Promise<void> } | null>(null);

export function SessionGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<{ user: SessionUser; csrfToken: string }>("/auth/me"),
    retry: false,
    staleTime: 60_000,
  });
  useEffect(() => {
    if (data) setCsrfToken(data.csrfToken);
  }, [data]);
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace("/login");
  }, [error, router]);

  if (isLoading || !data) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="size-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }
  const signOut = async () => {
    await api.post("/auth/logout");
    setCsrfToken(null);
    qc.clear();
    router.replace("/login");
  };
  return <Ctx.Provider value={{ user: data.user, can: (roles) => roles.includes(data.user.role), signOut }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionGate");
  return v;
}
