"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Dialog, Field, Input, Select } from "@reelflow/ui";
import { api } from "@/lib/api";
import { fromLocalInput } from "@/lib/format";
import type { AccountDTO, ContentDTO } from "@/lib/types";
import { Notice } from "./common";
import { useToast } from "./toast";

export function ScheduleDialog({ item, onClose }: { item: ContentDTO | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<AccountDTO[]>("/accounts"), enabled: !!item });
  const connected = accounts.data?.filter((a) => a.status === "CONNECTED") ?? [];
  const [accountId, setAccountId] = useState("");
  const [kind, setKind] = useState("REEL");
  const [when, setWhen] = useState("");
  const schedule = useMutation({
    mutationFn: () =>
      api.post("/posts", { contentId: item!.id, accountId: accountId || connected[0]?.id, kind, ...(when ? { scheduledAt: fromLocalInput(when) } : {}) }),
    onSuccess: () => {
      toast.success("زمان‌بندی شد");
      qc.invalidateQueries({ queryKey: ["content"] });
      qc.invalidateQueries({ queryKey: ["queue"] });
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={!!item}
      onClose={onClose}
      title="زمان‌بندی انتشار"
      description="اگر زمانی انتخاب نکنید، اولین جای خالی برنامه انتشار حساب استفاده می‌شود."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>انصراف</Button>
          <Button onClick={() => schedule.mutate()} loading={schedule.isPending} disabled={connected.length === 0}>زمان‌بندی</Button>
        </>
      }
    >
      <div className="space-y-4">
        {connected.length === 0 ? <Notice tone="warning">ابتدا یک حساب اینستاگرام را در بخش حساب‌ها متصل کنید.</Notice> : null}
        {item && item.approvalStatus !== "APPROVED" ? <Notice>این محتوا هنوز تأیید نشده؛ پست تا زمان تأیید در وضعیت «در انتظار تأیید» می‌ماند.</Notice> : null}
        <Field label="حساب">
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {connected.map((a) => <option key={a.id} value={a.id}>{a.name}{a.username ? ` (@${a.username})` : ""}</option>)}
          </Select>
        </Field>
        <Field label="نوع پست">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="REEL">Reel</option>
            <option value="STORY">Story</option>
            <option value="FEED">Feed</option>
          </Select>
        </Field>
        <Field label="زمان (به وقت تهران)" hint="سقف‌های روزانه، ساعتی و فاصله حداقل روی زمان‌بندی دستی هم اعمال می‌شوند.">
          <Input type="datetime-local" dir="ltr" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
