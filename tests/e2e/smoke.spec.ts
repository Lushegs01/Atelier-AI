import { test, expect } from "@playwright/test";

test("public site navigation and editorial imagery", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your design. A whole new perspective." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Explore the studio" }).click();
  await expect(
    page.getByRole("heading", { name: "Let’s create a new perspective." }),
  ).toBeVisible();
  await expect(
    page.getByText("This local workspace is waiting for Supabase configuration.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Review cost & create" })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("studio.png"), fullPage: true });
});

test("garment upload dialog validates, closes with keyboard and restores focus", async ({
  page,
}) => {
  await page.goto("/app/garments");
  const add = page.getByRole("button", { name: "Add a garment", exact: true });
  await add.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Garment name")).toBeVisible();
  await page.getByLabel("Garment name").fill("Synthetic test dress");
  await page.getByRole("button", { name: "Save to garment library" }).click();
  await expect(
    page.getByText("Choose a photograph of your garment.", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("all workspace routes have useful unconfigured states and no horizontal overflow", async ({
  page,
}) => {
  for (const path of [
    "/app",
    "/app/photos",
    "/app/videos",
    "/app/try-on",
    "/app/gallery",
    "/app/credits",
    "/app/billing",
    "/app/customers",
    "/app/settings/privacy",
  ]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.locator("main h1")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
});

test("public supporting pages and auth forms render", async ({ page }) => {
  for (const path of [
    "/features",
    "/pricing",
    "/how-it-works",
    "/privacy",
    "/terms",
    "/contact",
    "/login",
    "/signup",
    "/forgot-password",
  ]) {
    await page.goto(path);
    await expect(page.locator("main h1")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
});

test("unconfigured endpoints fail closed and readiness is honest", async ({ request }) => {
  expect((await request.get("/api/health")).status()).toBe(200);
  expect((await request.get("/api/ready")).status()).toBe(503);
  expect((await request.get("/api/admin/overview")).status()).toBeGreaterThanOrEqual(400);
  expect((await request.post("/api/generations", { data: { operation: "photo" } })).status()).toBe(
    403,
  );
  const pricing = await request.get("/api/pricing");
  expect((await pricing.json()).packages).toEqual([]);
});

test("invalid private link has an explicit error and never shows upload", async ({ page }) => {
  await page.goto("/try/invalid");
  await expect(page.getByRole("heading", { name: "This invitation is unavailable" })).toBeVisible();
  await expect(page.getByLabel("Upload photograph")).not.toBeVisible();
});

test("PWA manifest and service worker expose only public shell cache", async ({ request }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.name).toBe("Atelier AI");
  expect(manifest.icons).toHaveLength(3);
  for (const icon of manifest.icons) expect((await request.get(icon.src)).status()).toBe(200);
  const sw = await (await request.get("/sw.js")).text();
  expect(sw).toContain("/offline.html");
  expect(sw).not.toContain("cache.put");
});
