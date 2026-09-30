import { describe, expect, it } from "vitest";
import { buildFinalCaption, formatHashtags, renderCaption, renderTemplate } from "../src/services/captions";
import { attributionFor } from "../src/services/content";

describe("caption templates", () => {
  it("replaces all supported variables", () => {
    const out = renderCaption("{{original_caption}}\n\n{{attribution}}\n{{cta}}\n{{hashtags}}\n{{source}}", {
      originalCaption: "Funny cat",
      attribution: "🎬 @catpage",
      cta: "Follow {{brand}} for more",
      brand: "@mybrand",
      hashtags: ["cats", "#funny", "cats"],
      source: "Cat Page",
    });
    expect(out).toBe("Funny cat\n\n🎬 @catpage\nFollow @mybrand for more\n#cats #funny\nCat Page");
  });

  it("renders the date in the configured timezone", () => {
    const out = renderCaption("{{date}}", { date: new Date("2026-10-03T22:00:00Z"), timezone: "Asia/Tehran", locale: "en" });
    expect(out).toBe("Oct 4, 2026");
  });

  it("drops unknown variables and collapses blank lines", () => {
    expect(renderCaption("a\n\n{{nope}}\n\n\n\nb", {})).toBe("a\n\nb");
  });

  it("does not evaluate anything", () => {
    expect(renderTemplate("{{constructor}} {{__proto__}} ${process.env.X}", {})).toBe("  ${process.env.X}");
  });

  it("does not repeat hashtags already in the original caption", () => {
    const out = renderCaption("{{original_caption}}\n\n{{hashtags}}", { originalCaption: "Clip #funny #e2e", hashtags: ["funny", "e2e", "new"] });
    expect(out).toBe("Clip #funny #e2e\n\n#new");
  });

  it("dedupes and caps hashtags at 30", () => {
    const tags = Array.from({ length: 40 }, (_, i) => `t${i}`);
    expect(formatHashtags(tags).split(" ")).toHaveLength(30);
    expect(formatHashtags(["A", "a", "#a"])).toBe("#A");
  });
});

describe("final caption", () => {
  const inputs = { originalCaption: "Original text", attribution: "🎬 @owner", hashtags: [] };

  it("prefers custom caption and appends attribution for third-party content", () => {
    expect(buildFinalCaption({ customCaption: "My words", template: null, inputs, thirdParty: true })).toBe("My words\n\n🎬 @owner");
  });

  it("uses the template when there is no custom caption", () => {
    const out = buildFinalCaption({ customCaption: null, template: { body: "{{original_caption}} — {{attribution}}" }, inputs, thirdParty: true });
    expect(out).toBe("Original text — 🎬 @owner");
  });

  it("does not add attribution to owned content", () => {
    expect(buildFinalCaption({ customCaption: "Mine", template: null, inputs, thirdParty: false })).toBe("Mine");
  });

  it("derives attribution from the author when none is configured", () => {
    expect(attributionFor({ attribution: null, author: "funnypage", source: null })).toBe("🎬 @funnypage");
    expect(attributionFor({ attribution: null, author: null, source: { attributionText: "via X", name: "X" } })).toBe("via X");
    expect(attributionFor({ attribution: null, author: null, source: null })).toBeNull();
  });
});
