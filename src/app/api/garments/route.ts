import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { requireTenant, requireUser, consumeRateLimit } from "@/server/auth/context";
import { assertDatabaseResult, readImageForm, route } from "@/server/services/http";
import { uploadPrivateImage } from "@/server/storage/media";

export async function POST(request: Request) {
  return route(
    request,
    async () => {
      const { user } = await requireUser();
      await consumeRateLimit(`upload-user:${user.id}`, 30, 3600);
      const { form, file } = await readImageForm(request);
      const input = z
        .object({
          organizationId: z.string().uuid().optional(),
          name: z.string().trim().min(2).max(120),
          category: z
            .enum(["dress", "top", "bottom", "outerwear", "accessory", "other"])
            .default("dress"),
          description: z.string().trim().max(1200).default(""),
          collection: z.string().trim().max(100).default(""),
          view: z
            .enum(["front", "back", "side", "detail", "mannequin", "hanger", "flat-lay"])
            .default("front"),
        })
        .parse({
          organizationId: form.get("organizationId") || undefined,
          name: form.get("name"),
          category: form.get("category") || undefined,
          description: form.get("description") || "",
          collection: form.get("collection") || "",
          view: form.get("view") || undefined,
        });
      const context = await requireTenant(input.organizationId, "create");
      await consumeRateLimit(`upload:${context.organizationId}`, 30, 3600);
      const admin = getAdminClient();
      const { data: garment, error } = await admin
        .from("garments")
        .insert({
          organization_id: context.organizationId,
          name: input.name,
          category: input.category,
          description: input.description,
          collection: input.collection,
          created_by: context.user.id,
        })
        .select()
        .single();
      assertDatabaseResult(error);
      try {
        const asset = await uploadPrivateImage({
          organizationId: context.organizationId,
          actorId: context.user.id,
          file,
          garmentId: garment.id,
          kind: "garment_original",
          view: input.view,
        });
        return { garment, asset };
      } catch (uploadError) {
        await admin
          .from("garments")
          .delete()
          .eq("id", garment.id)
          .eq("organization_id", context.organizationId);
        throw uploadError;
      }
    },
    true,
  );
}
