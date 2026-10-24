import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Atelier AI",
    short_name: "Atelier",
    description: "Your fashion campaign studio",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#f7f8fa",
    theme_color: "#183952",
    lang: "en",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
