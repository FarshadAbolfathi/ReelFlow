import type { ReactNode } from "react";
import { SessionGate } from "@/components/session";
import { AppShell } from "@/components/shell";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionGate>
      <AppShell>{children}</AppShell>
    </SessionGate>
  );
}
