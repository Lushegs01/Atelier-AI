import { beforeEach, describe, expect, it, vi } from "vitest";

const { admin, query, storage, responses } = vi.hoisted(() => {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    single: vi.fn(),
    maybeSingle: vi.fn(),
    delete: vi.fn(),
    lt: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    then: vi.fn(),
  };
  const storage = { createSignedUrl: vi.fn(), remove: vi.fn() };
  const responses: { data: unknown; error: null }[] = [];
  return {
    query,
    storage,
    admin: { from: vi.fn(() => query), storage: { from: vi.fn(() => storage) } },
    responses,
  };
});
vi.mock("@/lib/supabase/admin", () => ({ getAdminClient: () => admin }));
import { cleanAbandonedUploads, signAsset } from "@/server/storage/media";

describe("private signing authorization boundary (storage test double)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.is.mockReturnValue(query);
    query.lt.mockReturnValue(query);
    query.order.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    query.delete.mockReturnValue(query);
    responses.length = 0;
    query.then.mockImplementation((resolve: (value: { data: unknown; error: null }) => unknown) =>
      Promise.resolve(responses.shift() ?? { data: null, error: null }).then(resolve),
    );
    storage.remove.mockResolvedValue({ error: null });
    storage.createSignedUrl.mockResolvedValue({
      data: { signedUrl: "https://storage.test/short-lived" },
      error: null,
    });
  });
  it("resolves asset ids under the authorized tenant and caps signed URL lifetime", async () => {
    query.single.mockResolvedValue({
      data: {
        storage_path: "tenant-a/random/original.jpg",
        thumbnail_path: "tenant-a/random/thumbnail.webp",
        expires_at: null,
      },
      error: null,
    });
    await expect(
      signAsset({
        organizationId: "tenant-a",
        assetId: "asset-id",
        expiresIn: 99999,
        thumbnail: true,
      }),
    ).resolves.toBe("https://storage.test/short-lived");
    expect(query.eq).toHaveBeenCalledWith("organization_id", "tenant-a");
    expect(query.eq).toHaveBeenCalledWith("id", "asset-id");
    expect(storage.createSignedUrl).toHaveBeenCalledWith("tenant-a/random/thumbnail.webp", 900);
  });
  it("refuses an object outside the authorized organization even if a corrupted record is returned", async () => {
    query.single.mockResolvedValue({
      data: { storage_path: "tenant-b/random/private.jpg" },
      error: null,
    });
    await expect(
      signAsset({ organizationId: "tenant-a", assetId: "foreign-asset" }),
    ).rejects.toThrow("ownership");
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });
  it("refuses expired or deleted/missing media before asking storage to sign", async () => {
    query.single
      .mockResolvedValueOnce({
        data: { storage_path: "tenant-a/random/private.jpg", expires_at: "2000-01-01T00:00:00Z" },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: { code: "not-found" } });
    await expect(signAsset({ organizationId: "tenant-a", assetId: "expired" })).rejects.toThrow(
      "unavailable",
    );
    await expect(signAsset({ organizationId: "tenant-a", assetId: "missing" })).rejects.toThrow(
      "unavailable",
    );
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });
  it("does not expose a copied output until its parent job has settled successfully", async () => {
    query.single
      .mockResolvedValueOnce({
        data: { storage_path: "tenant-a/random/output.jpg", generation_job_id: "unsettled-job" },
        error: null,
      })
      .mockResolvedValueOnce({ data: { status: "processing" }, error: null });
    await expect(
      signAsset({ organizationId: "tenant-a", assetId: "unsettled-output" }),
    ).rejects.toThrow("not ready");
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });
  it("preserves a committed asset if a worker died before deleting its upload intent", async () => {
    responses.push({
      data: [
        {
          id: "asset",
          organization_id: "tenant-a",
          storage_paths: ["tenant-a/asset/original.jpg"],
        },
      ],
      error: null,
    });
    query.maybeSingle.mockResolvedValue({ data: { id: "asset" }, error: null });
    await expect(cleanAbandonedUploads()).resolves.toBe(1);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(query.delete).toHaveBeenCalled();
  });
  it("deletes abandoned files only beneath the intent's organization and asset prefix", async () => {
    responses.push({
      data: [
        {
          id: "asset",
          organization_id: "tenant-a",
          storage_paths: ["tenant-a/asset/original.jpg", "tenant-a/asset/thumbnail.webp"],
        },
      ],
      error: null,
    });
    query.maybeSingle.mockResolvedValue({ data: null, error: null });
    await cleanAbandonedUploads();
    expect(storage.remove).toHaveBeenCalledWith([
      "tenant-a/asset/original.jpg",
      "tenant-a/asset/thumbnail.webp",
    ]);
  });
  it("refuses a corrupted cleanup intent targeting unrelated media", async () => {
    responses.push({
      data: [
        {
          id: "asset",
          organization_id: "tenant-a",
          storage_paths: ["tenant-b/private/customer.jpg"],
        },
      ],
      error: null,
    });
    query.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(cleanAbandonedUploads()).rejects.toThrow("Invalid abandoned upload paths");
    expect(storage.remove).not.toHaveBeenCalled();
  });
});
