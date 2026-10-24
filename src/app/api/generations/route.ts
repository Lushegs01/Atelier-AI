import { readJson, route } from "@/server/services/http";
import { submitDesignerGeneration } from "@/server/services/generations";
export async function POST(request: Request) {
  return route(request, async () => submitDesignerGeneration(await readJson(request)), true);
}
