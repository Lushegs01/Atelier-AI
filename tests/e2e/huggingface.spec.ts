import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Drives the real studio, review and guest pages with intercepted API responses. No request
 * reaches Hugging Face; these tests prove wiring and honest states, not model output.
 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const ids = {
  org: "10000000-0000-4000-8000-000000000001",
  garment: "30000000-0000-4000-8000-000000000001",
  garmentAsset: "40000000-0000-4000-8000-000000000001",
  approved: "40000000-0000-4000-8000-000000000002",
  unapproved: "40000000-0000-4000-8000-000000000003",
  tall: "40000000-0000-4000-8000-000000000004",
  job: "50000000-0000-4000-8000-000000000001",
};
const ack = "2026-10-26-hf-spaces-v1";
const provider = {
  id: "huggingface",
  label: "Hugging Face",
  model: "Qwen/Qwen-Image-Edit",
  lifecycle: "Experimental",
  disclosure:
    "Photographs you submit are sent to Hugging Face Spaces run on Hugging Face’s shared GPU service. These Spaces are public and operated by third parties.",
  processingDisclosureVersion: ack,
};
const capabilities = [
  {
    operation: "photo",
    provider: "huggingface",
    enabled: true,
    lifecycle: "Experimental",
    minInputDimension: 256,
    supportedResolutions: ["1k"],
  },
  { operation: "try_on", provider: "huggingface", enabled: true, lifecycle: "Experimental" },
  {
    operation: "video",
    provider: "huggingface",
    enabled: true,
    lifecycle: "Experimental",
    minInputDimension: 480,
    minAspectRatio: 480 / 832,
    maxAspectRatio: 832 / 480,
    freeTextMotion: false,
    supportedResolutions: ["480p"],
    supportedDurations: [5],
  },
];
const image = (id: string, width: number, height: number) => ({
  id,
  kind: "generated_image",
  mime_type: "image/png",
  width,
  height,
});
function workspace(jobs: Record<string, unknown>[] = []) {
  return {
    configured: true,
    organization: { id: ids.org, name: "Synthetic test studio" },
    role: "owner",
    provider,
    capabilities,
    garments: [
      {
        id: ids.garment,
        name: "Synthetic linen dress",
        category: "dress",
        imageUrl: "/__synthetic/garment.png",
        assets: [
          {
            id: ids.garmentAsset,
            kind: "garment_original",
            view: "front",
            width: 900,
            height: 1200,
          },
        ],
      },
    ],
    jobs,
    outputs: [
      {
        id: "o1",
        job_id: "j1",
        asset_id: ids.approved,
        operation: "photo",
        approved_at: "2026-10-26T10:00:00Z",
        url: "/__synthetic/approved.png",
        asset: image(ids.approved, 864, 1152),
      },
      {
        id: "o2",
        job_id: "j2",
        asset_id: ids.unapproved,
        operation: "photo",
        url: "/__synthetic/unapproved.png",
        asset: image(ids.unapproved, 864, 1152),
      },
      {
        id: "o3",
        job_id: "j3",
        asset_id: ids.tall,
        operation: "photo",
        approved_at: "2026-10-26T10:00:00Z",
        url: "/__synthetic/tall.png",
        asset: image(ids.tall, 720, 1440),
      },
    ],
    balance: { available: 40, reserved: 0 },
    ledger: [],
    payments: [],
    customers: [],
    tryOnSessions: [],
    packages: [],
  };
}
const quote = (operation: string) => ({
  quote: {
    credits: 12,
    available: 40,
    reserved: 0,
    sufficient: true,
    operation,
    lifecycle: "Experimental",
    provider: "huggingface",
  },
  quoteToken: "synthetic.quote",
});

async function serveWorkspace(page: Page, jobs: Record<string, unknown>[] = []) {
  await page.route("**/__synthetic/**", (route) =>
    route.fulfill({ body: PNG, contentType: "image/png" }),
  );
  await page.route("**/api/workspace**", (route) => route.fulfill({ json: workspace(jobs) }));
}
async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}

test("photo flow is wired to the real quote and generation routes with acknowledgement", async ({
  page,
}) => {
  await serveWorkspace(page);
  const quotes: Record<string, unknown>[] = [];
  const submissions: Record<string, unknown>[] = [];
  await page.route("**/api/generations/quote", async (route: Route) => {
    quotes.push(route.request().postDataJSON());
    await route.fulfill({ json: quote("photo") });
  });
  await page.route("**/api/generations", async (route: Route) => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({ json: { job: { id: ids.job, status: "queued" } } });
  });
  await page.route(`**/api/generations/${ids.job}`, (route) =>
    route.fulfill({
      json: {
        job: { id: ids.job, operation: "photo", status: "queued", created_at: "2026-10-26" },
        source: { url: "/__synthetic/garment.png" },
        outputs: [],
      },
    }),
  );
  await page.goto(`/app/studio?garment=${ids.garment}`);
  await expect(page.getByText("Hugging Face · Experimental", { exact: true })).toBeVisible();
  await expect(
    page.getByText("cannot guarantee exact reproduction", { exact: false }),
  ).toBeVisible();
  const faithful = page.getByRole("button", { name: "Faithful visualization" });
  await faithful.focus();
  await page.keyboard.press("Enter");
  await expect(faithful).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Follows your garment photo")).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByRole("button", { name: "Review cost & create" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("public and operated by third parties", { exact: false }),
  ).toBeVisible();
  const create = dialog.getByRole("button", { name: "Create model photograph" });
  await expect(create).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await create.dblclick();
  await expect(page).toHaveURL(new RegExp(`/app/generations/${ids.job}$`));
  expect(submissions).toHaveLength(1);
  const [submitted] = submissions as {
    processingAcknowledgement: string;
    idempotencyKey: string;
    options: { direction: string; seed: number };
  }[];
  expect(submitted.processingAcknowledgement).toBe(ack);
  expect(submitted.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(submitted.options).toMatchObject({ direction: "faithful" });
  expect((quotes[0] as { options: { seed: number } }).options.seed).toBe(submitted.options.seed);
  await expect(page.getByText("Waiting to start").first()).toBeVisible();
  await expect(page.getByAltText(/AI generated result/)).toHaveCount(0);
});

test("a provider refusal is shown without navigating or inventing a result", async ({ page }) => {
  await serveWorkspace(page);
  await page.route("**/api/generations/quote", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error:
          "The free AI provider’s daily GPU quota is used up. No credits were reserved. Please try again later.",
        code: "PROVIDER_QUOTA_EXHAUSTED",
      },
    }),
  );
  await page.goto(`/app/studio?garment=${ids.garment}`);
  await page.getByRole("button", { name: "Review cost & create" }).click();
  await expect(page.getByText("daily GPU quota is used up", { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/studio/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a running job blocks a duplicate request for the same garment", async ({ page }) => {
  await serveWorkspace(page, [
    {
      id: ids.job,
      operation: "photo",
      status: "processing",
      garment_id: ids.garment,
      created_at: "2026-10-26",
    },
  ]);
  await page.goto(`/app/studio?garment=${ids.garment}`);
  await expect(page.getByText("is still being generated", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review cost & create" })).toBeDisabled();
});

test("video offers only approved sources, preset motion and refuses cropping shapes", async ({
  page,
}) => {
  await serveWorkspace(page);
  await page.goto("/app/videos");
  const select = page.getByLabel("Image to animate");
  await expect(select.locator("option", { hasText: /^Approved photo \d$/ })).toHaveCount(2);
  await expect(select.locator(`option[value="${ids.unapproved}"]`)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Subtle movement" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("Motion direction (optional)")).toHaveCount(0);
  await select.selectOption(ids.tall);
  await expect(page.getByText("would crop part of the garment", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review cost & create" })).toBeDisabled();
  await select.selectOption(ids.approved);
  await expect(page.getByRole("button", { name: "Review cost & create" })).toBeEnabled();
  await noHorizontalOverflow(page);
});

test("failed generations explain quota exhaustion and offer a manual retry", async ({ page }) => {
  await serveWorkspace(page);
  await page.route(`**/api/generations/${ids.job}`, (route) =>
    route.fulfill({
      json: {
        job: {
          id: ids.job,
          operation: "photo",
          status: "failed",
          error_code: "provider_quota_exceeded",
          garment_id: ids.garment,
          created_at: "2026-10-26",
        },
        source: { url: "/__synthetic/garment.png" },
        outputs: [],
      },
    }),
  );
  await page.goto(`/app/generations/${ids.job}`);
  await expect(page.getByText("Quota exhausted", { exact: true })).toBeVisible();
  await expect(page.getByText("Free AI quota exhausted", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Try again with a new request" })).toHaveAttribute(
    "href",
    `/app/studio?garment=${ids.garment}`,
  );
  await expect(page.getByAltText(/AI generated result/)).toHaveCount(0);
});

test("completed results are shown beside the exact source and require review", async ({ page }) => {
  await serveWorkspace(page);
  const reviews: unknown[] = [];
  await page.route(`**/api/generations/${ids.job}`, async (route) => {
    if (route.request().method() === "PATCH") {
      reviews.push(route.request().postDataJSON());
      return route.fulfill({
        json: { output: { id: "out", approved_at: "2026-10-26T11:00:00Z", rejected_at: null } },
      });
    }
    return route.fulfill({
      json: {
        job: {
          id: ids.job,
          operation: "photo",
          status: "succeeded",
          garment_id: ids.garment,
          provider: "huggingface",
          created_at: "2026-10-26",
        },
        source: { url: "/__synthetic/source.png" },
        outputs: [{ id: "out", asset_id: ids.approved, url: "/__synthetic/result.png" }],
      },
    });
  });
  await page.goto(`/app/generations/${ids.job}`);
  await expect(
    page.getByAltText("Original garment used for this generation, for comparison"),
  ).toBeVisible();
  await expect(page.getByAltText("AI generated result to compare with original")).toBeVisible();
  await expect(page.getByText("Requires your review", { exact: true })).toBeVisible();
  await expect(page.getByText("Generated · awaiting your review")).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  expect(reviews).toEqual([{ outputId: "out", approved: true }]);
  await noHorizontalOverflow(page);
});

test("guest try-on discloses the public Space before consent and explains a busy failure", async ({
  page,
}) => {
  const token = "h".repeat(43);
  const guestDisclosure =
    "Your photograph and the selected garment will be sent to the Hugging Face Space “franciszzj/Leffa”. It is not a private or isolated environment.";
  const session = (job: Record<string, unknown> | null) => ({
    session: { id: "synthetic-session", expiresAt: "2027-01-01T00:00:00Z", completed: !!job },
    brand: { name: "Synthetic test studio" },
    garment: { name: "Synthetic test garment" },
    job,
    outputs: [],
    available: true,
    provider: { ...provider, disclosure: guestDisclosure, processingDisclosureVersion: undefined },
    retentionHours: 24,
    consentVersion: "2026-10-26-huggingface-v2",
  });
  await page.route(`**/api/try-on/${token}`, (route) => route.fulfill({ json: session(null) }));
  await page.goto(`/try/${token}`);
  await expect(
    page.getByText("not a private or isolated environment", { exact: false }).first(),
  ).toBeVisible();
  await expect(page.getByText("portrait orientation", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review my photograph" })).toBeDisabled();
  await page.unroute(`**/api/try-on/${token}`);
  await page.route(`**/api/try-on/${token}`, (route) =>
    route.fulfill({
      json: session({ id: ids.job, status: "failed", error_code: "provider_busy" }),
    }),
  );
  await page.reload();
  await expect(page.getByText("free AI service was busy", { exact: false })).toBeVisible();
  await expect(page.getByAltText("Your private AI virtual try-on result")).toHaveCount(0);
});
