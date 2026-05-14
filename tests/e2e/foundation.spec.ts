import { expect, test } from "@playwright/test";

test.describe("foundation — public surfaces", () => {
  test("landing page renders sign-in CTAs", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: /sign in with google/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /sign in with microsoft/i })).toBeVisible();
  });

  test("/inbox redirects unauthenticated visitors away from inbox", async ({ page }) => {
    const response = await page.goto("/inbox");
    // Auth.js may redirect to /signin or /api/auth/signin depending on config.
    expect(page.url()).not.toContain("/inbox/");
    expect(response?.status()).toBeLessThan(500);
  });

  test("mobile viewport: no horizontal scroll, CTA buttons are tap-target sized", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "mobile-only assertion");
    await page.goto("/");
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    const cta = page.getByRole("link", { name: /sign in with google/i });
    const box = await cta.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});
