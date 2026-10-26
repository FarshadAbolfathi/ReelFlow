"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Check, Droplets, Eye, FileText, ImageIcon, Pencil, Play, X } from "lucide-react";
import Link from "next/link";
import { Badge, Button, Card, cn } from "@reelflow/ui";
import { api, media } from "@/lib/api";
import { formatDuration, formatSlot } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { ContentDTO } from "@/lib/types";
import { RightsBadge, StatusBadge } from "./common";
import { useSession } from "./session";
import { useToast } from "./toast";

export function Thumb({ item, className }: { item: Pick<ContentDTO, "id" | "thumbnailKey" | "mediaType" | "durationSec">; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden bg-surface-2", className)}>
      {item.thumbnailKey ? (
        <img src={media.thumbnail(item.id)} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
      ) : (
        <div className="flex size-full items-center justify-center text-muted">{item.mediaType === "VIDEO" ? <Play className="size-6" /> : <ImageIcon className="size-6" />}</div>
      )}
      {item.mediaType === "VIDEO" ? (
        <span className="ltr absolute bottom-2 end-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">{formatDuration(item.durationSec)}</span>
      ) : null}
    </div>
  );
}

/** The media card: thumbnail, source, type, duration, status, next slot, and actions. */
export function ContentCard({ item, onSchedule }: { item: ContentDTO; onSchedule: (item: ContentDTO) => void }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const post = item.scheduledPosts?.[0];
  const decide = useMutation({
    mutationFn: (decision: "APPROVED" | "REJECTED") => api.post(`/content/${item.id}/decision`, { decision }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["content"] }),
    onError: toast.error,
  });
  const cancel = useMutation({
    mutationFn: () => api.post(`/posts/${post!.id}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["content"] }),
    onError: toast.error,
  });
  const status = post?.status ?? (item.processingStatus !== "READY" ? item.processingStatus : item.approvalStatus === "APPROVED" ? item.publishStatus : item.approvalStatus);

  return (
    <Card className="group flex flex-col overflow-hidden transition-colors hover:border-accent/40">
      <Link href={`/content/${item.id}`} className="block">
        <Thumb item={item} className="aspect-[9/14]" />
      </Link>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted">
            {item.source?.name ?? t("dash.upload")}
            {item.author ? <span className="ltr"> · @{item.author}</span> : null}
          </p>
          <Badge>{item.mediaType === "VIDEO" ? "Reel" : "Image"}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={status} />
          <RightsBadge rights={item.rightsStatus} />
        </div>
        {post ? <p className="text-xs text-fg">🗓 {formatSlot(post.scheduledAt, locale)}</p> : null}
        {item.originalCaption ? <p className="line-clamp-2 text-xs leading-relaxed text-muted">{item.originalCaption}</p> : null}
        <div className="mt-auto flex flex-wrap gap-1 pt-1">
          <Button asChild size="sm" variant="ghost" title={t("common.preview")}>
            <Link href={`/content/${item.id}`}><Eye /></Link>
          </Button>
          <Button asChild size="sm" variant="ghost" title={t("common.edit")}>
            <Link href={`/content/${item.id}#edit`}><Pencil /></Link>
          </Button>
          <Button asChild size="sm" variant="ghost" title={t("nav.watermarks")}>
            <Link href={`/content/${item.id}#watermark`}><Droplets /></Link>
          </Button>
          <Button asChild size="sm" variant="ghost" title={t("card.caption")}>
            <Link href={`/content/${item.id}#caption`}><FileText /></Link>
          </Button>
          {can(["OWNER", "MANAGER"]) ? (
            <>
              <Button size="sm" variant="ghost" title={t("common.schedule")} onClick={() => onSchedule(item)} disabled={!!item.duplicateOfId}>
                <CalendarPlus />
              </Button>
              {item.approvalStatus === "PENDING" && item.processingStatus === "READY" ? (
                <Button size="sm" variant="success" title={t("common.approve")} onClick={() => decide.mutate("APPROVED")} loading={decide.isPending}>
                  <Check />
                </Button>
              ) : null}
              {post && ["SCHEDULED", "WAITING_APPROVAL", "PAUSED"].includes(post.status) ? (
                <Button size="sm" variant="ghost" title={t("card.cancel")} onClick={() => cancel.mutate()}>
                  <X />
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
