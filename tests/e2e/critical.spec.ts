import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const OWNER = { email: env.BOOTSTRAP_OWNER_EMAIL!, password: env.BOOTSTRAP_OWNER_PASSWORD! };
const MANAGER = { email: `manager-${Date.now()}@test.local`, password: "manager-e2e-password" };
const SHOTS = process.env.E2E_SCREENSHOTS;

/** Fails the test on any uncaught page error (hydration or render crashes). */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && /hydration|cannot be a descendant|cannot contain/i.test(m.text())) errors.push(m.text().slice(0, 200));
  });
  return errors;
}

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(who.email);
  await page.locator('input[type="password"]').fill(who.password);
  await page.getByRole("button", { name: "ورود" }).click();
  await expect(page.getByRole("heading", { name: "داشبورد" })).toBeVisible();
}

async function apiAs(request: APIRequestContext, who: { email: string; password: string }) {
  const r = await request.post("/api/auth/login", { data: who });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).csrfToken as string;
}

test.beforeAll(async ({ request }) => {
  const csrf = await apiAs(request, OWNER);
  const r = await request.post("/api/users", { data: { ...MANAGER, name: "E2E Manager", role: "MANAGER" }, headers: { "x-csrf-token": csrf } });
  expect(r.status()).toBe(200);
});

test("unauthenticated users are sent to the login page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});

test("wrong password is rejected", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(OWNER.email);
  await page.locator('input[type="password"]').fill("definitely-not-the-password");
  await page.getByRole("button", { name: "ورود" }).click();
  await expect(page.getByText("Invalid email or password")).toBeVisible();
});

test("dashboard renders in Persian RTL with all sections in the sidebar", async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  for (const item of ["داشبورد", "منابع", "کتابخانه محتوا", "پردازش", "تقویم", "صف انتشار", "حساب‌ها", "واترمارک", "قالب‌های کپشن", "تحلیل", "گزارش‌ها", "تنظیمات"]) {
    await expect(page.getByRole("link", { name: item, exact: true })).toBeVisible();
  }
  await expect(page.getByText("وارد شده امروز")).toBeVisible();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "dashboard.png"), fullPage: true });
});

test("a manager's source waits for owner approval; the owner approves it", async ({ page, browser }) => {
  const name = `Manager page ${Date.now()}`;
  await signIn(page, MANAGER);
  await page.getByRole("link", { name: "منابع", exact: true }).click();
  await page.getByRole("button", { name: "افزودن منبع" }).click();
  await page.getByRole("dialog").locator("input").first().fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "ذخیره", exact: true }).click();
  await expect(page.getByText("منتظر تأیید مالک")).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row.getByText("در انتظار بررسی مالک")).toBeVisible();
  await expect(row.getByRole("button", { name: "تأیید" })).toHaveCount(0); // managers cannot approve

  const ownerPage = await (await browser.newContext()).newPage();
  await signIn(ownerPage, OWNER);
  await ownerPage.goto("/sources");
  const ownerRow = ownerPage.getByRole("row").filter({ hasText: name });
  await ownerRow.getByRole("button", { name: "تأیید" }).click();
  await expect(ownerRow.getByText("تأیید شده")).toBeVisible();
  if (SHOTS) await ownerPage.screenshot({ path: path.join(SHOTS, "sources.png"), fullPage: true });
});

test("publishing limits cannot exceed the owner's ceiling, auto-publish can be toggled", async ({ page }) => {
  await signIn(page, MANAGER);
  await page.goto("/settings");
  await expect(page.getByText("سقف‌های مالک سیستم")).toBeVisible();
  const perDay = page.getByText("حداکثر پست در روز", { exact: true }).locator("xpath=ancestor::div[contains(@class,'justify-between')][1]").locator("input");
  await perDay.fill("20");
  await page.getByRole("button", { name: "ذخیره", exact: true }).click();
  await expect(page.getByText(/exceed the operator policy ceilings/)).toBeVisible();
  await page.getByRole("button", { name: "بازنشانی" }).click();

  const toggle = page.getByRole("switch").first();
  const before = await toggle.getAttribute("aria-checked");
  await toggle.click();
  await page.getByRole("button", { name: "ذخیره", exact: true }).click();
  await expect(page.getByText("تنظیمات ذخیره شد")).toBeVisible();
  await toggle.click(); // restore
  await page.getByRole("button", { name: "ذخیره", exact: true }).click();
  expect(before).not.toBeNull();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "settings.png"), fullPage: true });
});

test("network settings show process-scoped proxy status; controls are owner-only", async ({ page }) => {
  await signIn(page, MANAGER);
  await page.goto("/settings");
  await page.getByRole("button", { name: "شبکه" }).click();
  await expect(page.getByText("هرگز تنظیمات شبکه سیستم")).toBeVisible();
  await expect(page.getByText("کنترل پروکسی فقط برای مالک سیستم فعال است.")).toBeVisible();
});

test("every page renders without runtime or hydration errors", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  for (const [href, heading] of [
    ["/", "داشبورد"],
    ["/content", "کتابخانه محتوا"],
    ["/sources", "منابع"],
    ["/settings", "تنظیمات"],
    ["/calendar", "تقویم"],
    ["/queue", "صف انتشار"],
    ["/watermarks", "واترمارک"],
    ["/templates", "قالب‌های کپشن"],
    ["/logs", "گزارش‌ها"],
    ["/analytics", "تحلیل"],
    ["/accounts", "حساب‌ها"],
    ["/processing", "پردازش"],
  ] as const) {
    await page.goto(href);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await page.waitForTimeout(1500); // let data load and client components settle
    await expect(page.getByText("This page couldn’t load")).toHaveCount(0);
    expect(errors, `errors on ${href}`).toEqual([]);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${href.slice(1)}.png`), fullPage: true });
  }
  await page.goto("/watermarks");
  await expect(page.getByAltText("watermark preview")).toBeVisible({ timeout: 15_000 });
});
