import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/ui";
import { PwaManager } from "@/components/pwa-manager";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"),
  title: { default: "Atelier AI — Every design deserves a campaign", template: "%s · Atelier AI" },
  description:
    "A creative workspace for fashion designers. Turn real garment photography into model images, motion, and private customer try-on experiences.",
  applicationName: "Atelier AI",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Atelier AI" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#183952",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <ToastProvider>
          <PwaManager />
          {children}
        </ToastProvider>
      </body>
    </html>
  );
}
