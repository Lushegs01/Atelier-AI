import { z } from "zod";
import { route } from "@/server/services/http";
import { getWorkspace } from "@/server/services/workspace";

export async function GET(request: Request) {
  return route(request, async () => {
    const url = new URL(request.url);
    const organizationId = z
      .string()
      .uuid()
      .optional()
      .parse(url.searchParams.get("organizationId") || undefined);
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(10000)
      .parse(url.searchParams.get("page") || 1);
    return getWorkspace(organizationId, page);
  });
}
