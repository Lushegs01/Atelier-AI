import { z } from "zod";
import { requireUser, consumeRateLimit } from "@/server/auth/context";
import { assertDatabaseResult, readJson, route } from "@/server/services/http";

export async function POST(request: Request) {
  return route(
    request,
    async () => {
      const { user, client } = await requireUser();
      await consumeRateLimit(`organization:${user.id}`, 3, 86400);
      const { name } = z
        .object({ name: z.string().trim().min(2).max(80) })
        .parse(await readJson(request));
      const { data, error } = await client.rpc("create_organization", { p_name: name });
      assertDatabaseResult(error);
      return { organization: data };
    },
    true,
  );
}
