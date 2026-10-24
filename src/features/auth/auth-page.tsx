"use client";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ArrowRight, LockKeyhole, Mail } from "lucide-react";
import { Logo } from "@/components/logo";
import { Button, Input, Notice, useToast } from "@/components/ui";
import { editorialImages } from "@/lib/editorial";

export function AuthPage({
  mode,
}: {
  mode: "login" | "signup" | "forgot-password" | "reset-password";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const notify = useToast();
  const router = useRouter();
  const signup = mode === "signup";
  const reset = mode === "forgot-password" || mode === "reset-password";
  const title = {
    login: "Welcome back to your studio.",
    signup: "A home for your next big idea.",
    "forgot-password": "Let’s get you back in.",
    "reset-password": "A fresh start.",
  }[mode];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "We couldn’t complete that request.");
      if (mode === "login" || mode === "reset-password") {
        notify("You’re signed in. Opening your workspace.");
        router.replace("/app");
        router.refresh();
      } else setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <div className="auth-form-wrap">
        <Logo />
        <main id="main-content" className="auth-form">
          <span className="eyebrow">Your creative workspace</span>
          <h1>{title}</h1>
          <p>
            {signup
              ? "Make a little space for your collection. Start with your email, then make it yours."
              : reset
                ? "We’ll help you securely restore access to your account."
                : "Your collection, your campaigns, your creative direction. Right where you left them."}
          </p>
          {done ? (
            <Notice>
              Check your inbox.{" "}
              {signup
                ? "Confirm your email address to finish setting up your workspace."
                : "If an account exists, you’ll receive a password reset link shortly."}
            </Notice>
          ) : (
            <form className="form-stack" onSubmit={submit}>
              {signup && (
                <Input
                  label="Your name"
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={100}
                  placeholder="How should we call you?"
                />
              )}
              {mode !== "reset-password" && (
                <Input
                  label="Email address"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@yourstudio.com"
                  required
                  maxLength={254}
                />
              )}
              {mode !== "forgot-password" && (
                <Input
                  label={mode === "reset-password" ? "New password" : "Password"}
                  name="password"
                  type="password"
                  autoComplete={signup || reset ? "new-password" : "current-password"}
                  minLength={12}
                  maxLength={128}
                  required
                  placeholder={signup ? "At least 12 characters" : "Enter your password"}
                  hint={signup ? "Use a unique password with at least 12 characters." : undefined}
                />
              )}
              {mode === "login" && (
                <Link href="/forgot-password" className="text-xs text-secondary text-right -mt-2">
                  Forgot password?
                </Link>
              )}
              {signup && (
                <label className="check-label">
                  <input type="checkbox" required name="termsAccepted" />
                  <span>
                    I agree to the{" "}
                    <Link href="/terms" className="underline">
                      Terms
                    </Link>{" "}
                    and have read the{" "}
                    <Link href="/privacy" className="underline">
                      Privacy disclosure
                    </Link>
                    .
                  </span>
                </label>
              )}
              {error && <Notice tone="error">{error}</Notice>}
              <Button type="submit" busy={busy} className="w-full">
                {signup
                  ? "Create your account"
                  : mode === "forgot-password"
                    ? "Send reset link"
                    : mode === "reset-password"
                      ? "Update password"
                      : "Enter your studio"}
                {mode === "forgot-password" ? <Mail size={15} /> : <ArrowRight size={15} />}
              </Button>
            </form>
          )}
          <div className="auth-links">
            {signup ? (
              <>
                Already have a workspace? <Link href="/login">Log in</Link>
              </>
            ) : mode === "login" ? (
              <>
                New around here? <Link href="/signup">Create an account</Link>
              </>
            ) : (
              <Link href="/login">Back to login</Link>
            )}
          </div>
          <p className="muted text-[10px] flex items-center justify-center gap-1.5 mt-8">
            <LockKeyhole size={11} />
            Private by design. Made for your work.
          </p>
        </main>
        <p className="muted text-[10px] text-center">
          Atelier AI · Turn every design into a fashion campaign.
        </p>
      </div>
      <aside className="auth-art">
        <Image
          src={editorialImages.campaign}
          alt="Illustrative editorial fashion photography"
          fill
          priority
          sizes="50vw"
        />
        <div className="photo-shade" />
        <div className="auth-art-copy">
          <span className="eyebrow !text-white/80 mb-4">
            For the designers. The dreamers. The makers.
          </span>
          <h2>
            You make the piece.
            <br />
            Give it a world.
          </h2>
          <p>A thoughtful space to see your work in a new light.</p>
          <p className="!text-[9px] mt-7">ILLUSTRATIVE STOCK PHOTOGRAPHY</p>
        </div>
      </aside>
    </div>
  );
}
