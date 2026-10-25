import { expect, test } from "@playwright/test";

const provider = {
  id: "qwen",
  label: "Qwen Image Edit",
  model: "Qwen/Qwen-Image-Edit-2511",
  lifecycle: "Experimental",
  disclosure:
    "Your photograph is processed on this studio’s private operator-hosted Qwen GPU service. This is experimental image editing, not a validated fitting system.",
};
const workspace = {
  configured: true,
  organization: { id: "10000000-0000-4000-8000-000000000001", name: "Synthetic test studio" },
  role: "owner",
  provider,
  capabilities: [
    { operation: "photo", provider: "qwen", enabled: true, lifecycle: "Experimental" },
    { operation: "try_on", provider: "qwen", enabled: false, lifecycle: "Experimental" },
    { operation: "video", provider: "qwen", enabled: false, lifecycle: "Experimental" },
  ],
  garments: [],
  jobs: [],
  outputs: [],
  balance: { available: 0, reserved: 0 },
  ledger: [],
  payments: [],
  customers: [],
  tryOnSessions: [],
  packages: [],
};

test("synthetic Qwen capability response shows no video generation form", async ({ page }) => {
  await page.route("**/api/workspace**", (route) => route.fulfill({ json: workspace }));
  await page.goto("/app/videos");
  await expect(page.getByRole("heading", { name: "Your collection, in motion." })).toBeVisible();
  await expect(
    page.getByText("Qwen Image Edit creates still images and does not generate video.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Review cost & create" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Create a model photograph" })).toBeVisible();
  await page.goto("/app/studio");
  await expect(page.getByText("Qwen Image Edit · Experimental", { exact: true })).toBeVisible();
});

test("synthetic guest contract discloses pinned Qwen processing before consent", async ({
  page,
}) => {
  const token = "a".repeat(43);
  const session = {
    session: { id: "synthetic-session", expiresAt: "2027-01-01T00:00:00Z", completed: false },
    brand: { name: "Synthetic test studio" },
    garment: { name: "Synthetic test garment" },
    job: null,
    outputs: [],
    available: true,
    provider,
    retentionHours: 24,
    consentVersion: "2026-10-25-qwen-v1",
  };
  await page.route(`**/api/try-on/${token}`, (route) => route.fulfill({ json: session }));
  await page.goto(`/try/${token}`);
  await expect(page.getByText(provider.disclosure, { exact: false })).toBeVisible();
  await expect(page.getByRole("checkbox")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Review my photograph" })).toBeDisabled();
  await expect(page.getByText("Your permission comes first.")).toBeVisible();
  await page.getByRole("checkbox").check();
  await expect(page.getByText("Choose your photograph", { exact: true })).toBeVisible();
});

test("synthetic guest without a provider disclosure cannot consent or upload", async ({ page }) => {
  const token = "b".repeat(43);
  await page.route(`**/api/try-on/${token}`, (route) =>
    route.fulfill({
      json: {
        session: {
          id: "synthetic-missing-provider",
          expiresAt: "2027-01-01T00:00:00Z",
          completed: false,
        },
        brand: { name: "Synthetic test studio" },
        garment: { name: "Test garment" },
        outputs: [],
        available: true,
        consentVersion: "2026-10-25-qwen-v1",
      },
    }),
  );
  await page.goto(`/try/${token}`);
  await expect(page.getByRole("checkbox")).toBeDisabled();
  await expect(
    page.getByText("The processing provider has not been disclosed", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Review my photograph" })).toBeDisabled();
});
