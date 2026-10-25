import "server-only";
import { getQwenOutputRequest } from "@/server/ai/endpoint";
import { huggingFaceOutputRequest } from "@/server/ai/huggingface";
import { requestQwenPredictionDeletion } from "@/server/ai/cleanup";
import { getConsentVersion } from "@/server/services/try-on";
import { createHash, randomUUID } from "node:crypto";
import { getAdminClient } from "@/lib/supabase/admin";
import {
  createThumbnail,
  MediaValidationError,
  readBoundedBody,
  validateImage,
  validateProviderOutputUrl,
  validateMp4Container,
} from "./validation";

export { validateImage, createThumbnail } from "./validation";

export type AssetKind =
  | "original"
  | "garment_original"
  | "generated_image"
  | "generated_video"
  | "customer_photo"
  | "thumbnail";
export interface StoredAsset {
  id: string;
  organization_id: string;
  garment_id: string | null;
  kind: AssetKind;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  created_by: string | null;
  created_at: string;
  deleted_at?: string | null;
  view?: string;
}

const bucket = () => process.env.STORAGE_BUCKET || "private-media";

export function deterministicOutputId(jobId: string, index: number, suffix = "asset"): string {
  const hex = createHash("sha256")
    .update(`atelier:${suffix}:${jobId}:${index}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function assertOwnedPath(path: string, organizationId: string): void {
  if (!path.startsWith(`${organizationId}/`) || path.includes("..") || path.includes("\\"))
    throw new MediaValidationError("Asset storage ownership is invalid.");
}

export async function uploadPrivateImage(input: {
  organizationId: string;
  actorId?: string | null;
  userId?: string | null;
  garmentId?: string;
  jobId?: string;
  expiresAt?: string;
  buffer?: Buffer;
  file?: File;
  kind: AssetKind;
  view?: string;
  assetId?: string;
}): Promise<StoredAsset> {
  if (input.file && input.file.size > (Number(process.env.MAX_UPLOAD_BYTES) || 10 * 1024 * 1024))
    throw new MediaValidationError("This photo exceeds the upload limit.");
  const raw =
    input.buffer ?? (input.file ? Buffer.from(await input.file.arrayBuffer()) : undefined);
  if (!raw) throw new MediaValidationError("A photo is required.");
  const validated = await validateImage(
    raw,
    Number(process.env.MAX_UPLOAD_BYTES) || 10 * 1024 * 1024,
  );
  const id = input.assetId ?? randomUUID();
  const storagePath = `${input.organizationId}/${id}/original.${validated.mimeType === "image/png" ? "png" : "jpg"}`;
  const thumbnailPath = `${input.organizationId}/${id}/thumbnail.webp`;
  const admin = getAdminClient();
  // A deterministic id is used only by workers. An already committed row is reused after a worker retry.
  if (input.assetId) {
    const { data: existing } = await admin
      .from("assets")
      .select("*")
      .eq("id", id)
      .eq("organization_id", input.organizationId)
      .is("deleted_at", null)
      .maybeSingle();
    if (existing) return existing as StoredAsset;
  }
  const { error: intentError } = await admin.from("media_upload_intents").upsert(
    {
      id,
      organization_id: input.organizationId,
      storage_paths: [storagePath, thumbnailPath],
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      committed_at: null,
    },
    { onConflict: "id" },
  );
  if (intentError) throw new Error("The upload could not be prepared safely.");
  const { error: uploadError } = await admin.storage
    .from(bucket())
    .upload(storagePath, validated.buffer, {
      contentType: validated.mimeType,
      upsert: Boolean(input.assetId),
      cacheControl: "0",
    });
  if (uploadError) throw new Error("The photo could not be stored. Please retry.");
  try {
    // Verify the object is retrievable before recording it; the uploaded bytes were fully decoded above.
    const { data: persisted, error: persistedError } = await admin.storage
      .from(bucket())
      .download(storagePath);
    if (persistedError || !persisted || persisted.size !== validated.byteSize)
      throw new Error("Stored photo verification failed.");
    const thumbnail = await createThumbnail(validated.buffer);
    const { error: thumbnailError } = await admin.storage
      .from(bucket())
      .upload(thumbnailPath, thumbnail, {
        contentType: "image/webp",
        upsert: Boolean(input.assetId),
        cacheControl: "0",
      });
    if (thumbnailError) throw new Error("Photo preview could not be stored.");
    const { data: asset, error } = await admin
      .from("assets")
      .insert({
        id,
        organization_id: input.organizationId,
        garment_id: input.garmentId ?? null,
        generation_job_id: input.jobId ?? null,
        kind: input.kind,
        storage_path: storagePath,
        mime_type: validated.mimeType,
        byte_size: validated.byteSize,
        width: validated.width,
        height: validated.height,
        created_by: input.actorId ?? input.userId ?? null,
        view: input.view ?? "front",
        thumbnail_path: thumbnailPath,
        ...(input.expiresAt || input.kind === "customer_photo"
          ? {
              expires_at:
                input.expiresAt ??
                new Date(
                  Date.now() +
                    (Number(process.env.CUSTOMER_PHOTO_RETENTION_HOURS) || 24) * 3_600_000,
                ).toISOString(),
            }
          : {}),
      })
      .select("*")
      .single();
    if (error || !asset) {
      if (input.assetId) {
        const { data: committed } = await admin
          .from("assets")
          .select("*")
          .eq("id", id)
          .eq("organization_id", input.organizationId)
          .is("deleted_at", null)
          .maybeSingle();
        if (committed) {
          await admin.from("media_upload_intents").delete().eq("id", id);
          return committed as StoredAsset;
        }
      }
      throw new Error("The photo record could not be saved.");
    }
    await admin.from("media_upload_intents").delete().eq("id", id);
    return asset as StoredAsset;
  } catch (error) {
    await admin.storage.from(bucket()).remove([storagePath, thumbnailPath]);
    throw error;
  }
}

/** Caller must authorize membership or a specific guest session before invoking. No browser storage path is accepted. */
export async function signAsset(input: {
  organizationId: string;
  assetId: string;
  expiresIn?: number;
  thumbnail?: boolean;
}): Promise<string> {
  const admin = getAdminClient();
  const { data: asset, error } = await admin
    .from("assets")
    .select("storage_path,thumbnail_path,expires_at,generation_job_id,kind")
    .eq("id", input.assetId)
    .eq("organization_id", input.organizationId)
    .is("deleted_at", null)
    .single();
  if (error || !asset || (asset.expires_at && new Date(asset.expires_at).getTime() <= Date.now()))
    throw new MediaValidationError("This asset is unavailable.");
  if (asset.generation_job_id) {
    const { data: parent, error: parentError } = await admin
      .from("generation_jobs")
      .select("status,operation")
      .eq("id", asset.generation_job_id)
      .eq("organization_id", input.organizationId)
      .single();
    if (parentError || parent?.status !== "succeeded")
      throw new MediaValidationError("This generation is not ready for download.");
    if (parent.operation === "try_on")
      await assertCustomerSigningConsent(input.organizationId, "job_id", asset.generation_job_id);
  }
  if (asset.kind === "customer_photo")
    await assertCustomerSigningConsent(input.organizationId, "customer_asset_id", input.assetId);
  assertOwnedPath(asset.storage_path, input.organizationId);
  const requestedPath =
    input.thumbnail && asset.thumbnail_path ? asset.thumbnail_path : asset.storage_path;
  assertOwnedPath(requestedPath, input.organizationId);
  const ttl = Math.min(
    Math.max(input.expiresIn ?? 120, 1),
    900,
    asset.expires_at ? Math.floor((new Date(asset.expires_at).getTime() - Date.now()) / 1000) : 900,
  );
  if (ttl < 1) throw new MediaValidationError("This asset is unavailable.");
  const { data, error: signedError } = await admin.storage
    .from(bucket())
    .createSignedUrl(requestedPath, ttl);
  if (signedError || !data?.signedUrl) throw new Error("The photo could not be opened.");
  return data.signedUrl;
}

export const getAssetSignedUrl = signAsset;

async function assertCustomerSigningConsent(
  organizationId: string,
  field: "job_id" | "customer_asset_id",
  id: string,
) {
  const admin = getAdminClient();
  const { data: session, error } = await admin
    .from("try_on_sessions")
    .select("id,provider,revoked_at,deleted_at,expires_at")
    .eq(field, id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (
    error ||
    !session ||
    session.revoked_at ||
    session.deleted_at ||
    !session.expires_at ||
    new Date(session.expires_at).getTime() <= Date.now() ||
    !["qwen", "fashn", "huggingface"].includes(session.provider)
  )
    throw new MediaValidationError("Customer access has expired or been withdrawn.");
  const { data: consent, error: consentError } = await admin
    .from("consents")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("try_on_session_id", session.id)
    .eq("version", getConsentVersion(session.provider))
    .is("withdrawn_at", null)
    .limit(1)
    .maybeSingle();
  if (consentError || !consent)
    throw new MediaValidationError("Customer consent has been withdrawn.");
}

export async function deletePrivateAsset(input: {
  organizationId: string;
  assetId: string;
}): Promise<void> {
  const admin = getAdminClient();
  const { data: asset, error } = await admin
    .from("assets")
    .select("storage_path,thumbnail_path,generation_job_id")
    .eq("id", input.assetId)
    .eq("organization_id", input.organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error("The asset could not be loaded.");
  if (!asset) return;
  if (asset.generation_job_id)
    await requestQwenPredictionDeletion({
      organizationId: input.organizationId,
      jobId: asset.generation_job_id,
    });
  assertOwnedPath(asset.storage_path, input.organizationId);
  const paths = [asset.storage_path];
  if (asset.thumbnail_path) {
    assertOwnedPath(asset.thumbnail_path, input.organizationId);
    paths.push(asset.thumbnail_path);
  }
  const { error: storageError } = await admin.storage.from(bucket()).remove(paths);
  if (storageError) throw new Error("Deletion is pending. Please retry.");
  const { error: recordError } = await admin
    .from("assets")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", input.assetId)
    .eq("organization_id", input.organizationId);
  if (recordError) throw new Error("Deletion cleanup is pending.");
}

export async function downloadAssetForProvider(input: {
  organizationId: string;
  assetId: string;
  minDimension?: number;
}): Promise<string> {
  const admin = getAdminClient();
  const { data: asset, error } = await admin
    .from("assets")
    .select("width,height,mime_type")
    .eq("id", input.assetId)
    .eq("organization_id", input.organizationId)
    .is("deleted_at", null)
    .single();
  if (
    error ||
    !asset ||
    !asset.mime_type.startsWith("image/") ||
    asset.width < (input.minDimension ?? 15) ||
    asset.height < (input.minDimension ?? 15)
  )
    throw new MediaValidationError(
      "This source image is incompatible with the selected generation.",
    );
  return signAsset({ ...input, expiresIn: 900 });
}

export async function transferProviderOutput(input: {
  organizationId: string;
  jobId: string;
  index: number;
  url: string;
  isVideo: boolean;
  provider?: "fashn" | "qwen" | "huggingface";
  providerReference?: string;
  garmentId?: string;
  actorId?: string | null;
  expiresAt?: string;
}): Promise<StoredAsset> {
  const id = deterministicOutputId(input.jobId, input.index);
  const admin = getAdminClient();
  const { data: existing } = await admin
    .from("assets")
    .select("*")
    .eq("id", id)
    .eq("organization_id", input.organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (existing) return existing as StoredAsset;
  const transfer =
    input.provider === "qwen"
      ? getQwenOutputRequest(input.url, input.providerReference || "")
      : input.provider === "huggingface"
        ? huggingFaceOutputRequest(input.url)
        : { url: validateProviderOutputUrl(input.url), headers: undefined };
  if (input.provider === "qwen" && input.isVideo)
    throw new MediaValidationError("Qwen cannot return a fashion video.");
  const url = transfer.url;
  const response = await fetch(url, {
    headers: transfer.headers,
    redirect: "error",
    signal: AbortSignal.timeout(50_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Provider output transfer failed.");
  const raw = await readBoundedBody(response, input.isVideo ? 100 * 1024 * 1024 : 30 * 1024 * 1024);
  if (!input.isVideo)
    return uploadPrivateImage({
      organizationId: input.organizationId,
      garmentId: input.garmentId,
      actorId: input.actorId,
      kind: "generated_image",
      buffer: raw,
      assetId: id,
      jobId: input.jobId,
      expiresAt: input.expiresAt,
    });
  validateMp4Container(raw);
  const storagePath = `${input.organizationId}/${id}/output.mp4`;
  const { error: intentError } = await admin.from("media_upload_intents").upsert(
    {
      id,
      organization_id: input.organizationId,
      storage_paths: [storagePath],
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      committed_at: null,
    },
    { onConflict: "id" },
  );
  if (intentError) throw new Error("Video transfer could not be prepared safely.");
  const { error: uploadError } = await admin.storage
    .from(bucket())
    .upload(storagePath, raw, { contentType: "video/mp4", upsert: true, cacheControl: "0" });
  if (uploadError) throw new Error("Video storage failed.");
  const { data: stored, error: storedError } = await admin.storage
    .from(bucket())
    .download(storagePath);
  if (storedError || stored?.size !== raw.length)
    throw new Error("Stored video verification failed.");
  const { data, error } = await admin
    .from("assets")
    .insert({
      id,
      organization_id: input.organizationId,
      garment_id: input.garmentId ?? null,
      generation_job_id: input.jobId,
      kind: "generated_video",
      storage_path: storagePath,
      mime_type: "video/mp4",
      byte_size: raw.length,
      created_by: input.actorId ?? null,
    })
    .select("*")
    .single();
  if (error || !data) {
    const { data: committed } = await admin
      .from("assets")
      .select("*")
      .eq("id", id)
      .eq("organization_id", input.organizationId)
      .is("deleted_at", null)
      .maybeSingle();
    if (committed) {
      await admin.from("media_upload_intents").delete().eq("id", id);
      return committed as StoredAsset;
    }
    await admin.storage.from(bucket()).remove([storagePath]);
    throw new Error("Video asset record failed.");
  }
  await admin.from("media_upload_intents").delete().eq("id", id);
  return data as StoredAsset;
}

/** Durable intents cover a process crash between an object upload and its final database record. */
export async function cleanAbandonedUploads(limit = 50): Promise<number> {
  const admin = getAdminClient();
  const { data: intents, error } = await admin
    .from("media_upload_intents")
    .select("id,organization_id,storage_paths")
    .is("committed_at", null)
    .lt("expires_at", new Date().toISOString())
    .order("created_at")
    .limit(Math.min(limit, 100));
  if (error) throw new Error("Abandoned uploads could not be inspected.");
  for (const intent of intents ?? []) {
    const { data: committed, error: lookupError } = await admin
      .from("assets")
      .select("id")
      .eq("id", intent.id)
      .eq("organization_id", intent.organization_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (lookupError) throw new Error("Upload ownership could not be verified.");
    if (!committed) {
      const paths = intent.storage_paths as string[];
      if (
        !Array.isArray(paths) ||
        paths.length > 2 ||
        paths.some(
          (path) =>
            typeof path !== "string" || !path.startsWith(`${intent.organization_id}/${intent.id}/`),
        )
      )
        throw new MediaValidationError("Invalid abandoned upload paths.");
      for (const path of paths) assertOwnedPath(path, intent.organization_id);
      const { error: removalError } = await admin.storage.from(bucket()).remove(paths);
      if (removalError) throw new Error("Abandoned upload cleanup must be retried.");
    }
    const { error: deleteError } = await admin
      .from("media_upload_intents")
      .delete()
      .eq("id", intent.id)
      .eq("organization_id", intent.organization_id);
    if (deleteError) throw new Error("Upload cleanup completion could not be recorded.");
  }
  return intents?.length ?? 0;
}

// Exported for environments without Supabase image transforms; thumbnails retain no metadata.
export const generateSafeThumbnail = createThumbnail;
