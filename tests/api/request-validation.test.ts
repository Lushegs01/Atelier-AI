import { describe, expect, it } from "vitest";
import { readBoundedRequest, readImageForm, readJson, route } from "@/server/services/http";

describe("HTTP boundary validation (unit)", () => {
  it("rejects malformed JSON and oversized bodies without trusting content-length", async () => {
    await expect(
      readJson(new Request("https://atelier.test/api", { method: "POST", body: "{" })),
    ).rejects.toMatchObject({ status: 400 });
    const streamed = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(40000));
        controller.enqueue(new Uint8Array(40000));
        controller.close();
      },
    });
    const request = new Request("https://atelier.test/api", {
      method: "POST",
      body: streamed,
      duplex: "half",
    } as RequestInit);
    await expect(readBoundedRequest(request, 65536)).rejects.toMatchObject({ status: 413 });
  });
  it("accepts a bounded multipart image but rejects missing files", async () => {
    const form = new FormData();
    form.append("file", new File(["not-yet-decoded"], "source.jpg", { type: "image/jpeg" }));
    const result = await readImageForm(
      new Request("https://atelier.test/api", { method: "POST", body: form }),
    );
    expect(result.file.name).toBe("source.jpg");
    await expect(
      readImageForm(
        new Request("https://atelier.test/api", { method: "POST", body: new FormData() }),
      ),
    ).rejects.toMatchObject({ code: "FILE_REQUIRED" });
  });
  it("rejects cross-origin mutation before executing any domain side effect", async () => {
    let invoked = false;
    const response = await route(
      new Request("https://atelier.test/api", {
        method: "POST",
        headers: { origin: "https://attacker.test" },
      }),
      async () => {
        invoked = true;
        return { ok: true };
      },
      true,
    );
    expect(response.status).toBe(403);
    expect(invoked).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
