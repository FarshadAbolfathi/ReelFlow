/**
 * Caption template engine.
 *
 * Variables: {{source}} {{original_caption}} {{date}} {{hashtags}} {{cta}} {{brand}} {{attribution}}
 * Unknown variables render as empty. No code execution, no nested templates
 * beyond one pass over the CTA (which may itself contain {{brand}}).
 */
import { DateTime } from "luxon";

export const CAPTION_VARIABLES = ["source", "original_caption", "date", "hashtags", "cta", "brand", "attribution"] as const;
export type CaptionVariable = (typeof CAPTION_VARIABLES)[number];

export interface CaptionInputs {
  source?: string | null;
  originalCaption?: string | null;
  hashtags?: string[];
  cta?: string | null;
  brand?: string | null;
  attribution?: string | null;
  date?: Date;
  timezone?: string;
  locale?: "fa" | "en";
}

const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

export function formatHashtags(tags: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.replace(/^#+/, "").trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(`#${t}`);
  }
  return out.slice(0, 30).join(" ");
}

export function renderTemplate(template: string, vars: Partial<Record<CaptionVariable, string>>): string {
  // Only whitelisted, own properties — never the prototype chain ({{constructor}}, {{__proto__}}).
  return template.replace(VAR_RE, (_m, name: string) =>
    (CAPTION_VARIABLES as readonly string[]).includes(name) && Object.hasOwn(vars, name) ? (vars[name as CaptionVariable] ?? "") : "",
  );
}

/** Collapses blank lines left by empty variables and trims whitespace. */
export function tidyCaption(s: string): string {
  return s
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Drops hashtags that already appear in the given text, so {{hashtags}} never repeats them. */
export function hashtagsNotIn(tags: string[], text: string | null | undefined): string[] {
  const present = new Set((text ?? "").match(/#[\p{L}\p{N}_]+/gu)?.map((t) => t.slice(1).toLowerCase()) ?? []);
  return tags.filter((t) => !present.has(t.replace(/^#+/, "").toLowerCase()));
}

export function renderCaption(template: string, i: CaptionInputs): string {
  const brand = i.brand ?? "";
  const cta = i.cta ? renderTemplate(i.cta, { brand }) : "";
  const date = DateTime.fromJSDate(i.date ?? new Date())
    .setZone(i.timezone ?? "Asia/Tehran")
    .setLocale(i.locale === "en" ? "en" : "fa-IR")
    .toLocaleString(DateTime.DATE_MED);
  return tidyCaption(
    renderTemplate(template, {
      source: i.source ?? "",
      original_caption: i.originalCaption ?? "",
      date,
      hashtags: template.includes("original_caption") ? formatHashtags(hashtagsNotIn(i.hashtags ?? [], i.originalCaption)) : formatHashtags(i.hashtags ?? []),
      cta,
      brand,
      attribution: i.attribution ?? "",
    }),
  );
}

/**
 * Final caption for a post. Precedence: custom caption → template → original caption.
 * Third-party content always carries attribution (appended if the template omitted it);
 * the caption never claims ownership of someone else's work.
 */
export function buildFinalCaption(p: {
  customCaption?: string | null;
  template?: { body: string; cta?: string | null; defaultHashtags?: string[] } | null;
  inputs: CaptionInputs;
  thirdParty: boolean;
}): string {
  const hashtags = [...(p.inputs.hashtags ?? []), ...(p.template?.defaultHashtags ?? [])];
  const inputs = { ...p.inputs, hashtags, cta: p.inputs.cta ?? p.template?.cta ?? null };
  let caption: string;
  if (p.customCaption?.trim()) caption = tidyCaption(p.customCaption);
  else if (p.template) caption = renderCaption(p.template.body, inputs);
  else caption = tidyCaption(p.inputs.originalCaption ?? "");

  const attribution = p.inputs.attribution?.trim();
  if (p.thirdParty && attribution && !caption.includes(attribution)) caption = `${caption}\n\n${attribution}`.trim();
  return caption;
}
