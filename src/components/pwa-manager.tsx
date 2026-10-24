"use client";
import { useEffect, useState } from "react";
import { Download, WifiOff } from "lucide-react";
import { Button, Dialog } from "@/components/ui";
type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
export function PwaManager() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    if ("serviceWorker" in navigator)
      navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return offline ? (
    <div className="offline-bar" role="status">
      <WifiOff size={13} className="inline mr-2" />
      You’re offline. Uploads, payments and generation will resume when you reconnect.
    </div>
  ) : null;
}
export function InstallButton() {
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstall(event as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);
  return (
    <>
      <Button
        variant="ghost"
        size="small"
        onClick={async () => {
          if (install) {
            await install.prompt();
            await install.userChoice;
            setInstall(null);
          } else setHelp(true);
        }}
      >
        <Download size={14} />
        Install app
      </Button>
      <Dialog
        title="Your studio, a tap away"
        description="Install Atelier AI for quick access to your workspace."
        open={help}
        onOpenChange={setHelp}
      >
        <div className="prose">
          <p>On iPhone or iPad, open this website in Safari, tap Share, then Add to Home Screen.</p>
          <p>
            On Android or desktop, open your browser menu and choose Install app or Add to Home
            Screen. Your browser shows this option when installation is supported.
          </p>
          <p>Uploads, secure media, payments and generation require an internet connection.</p>
        </div>
      </Dialog>
    </>
  );
}
