import { Logo } from "@/components/logo";
import Link from "next/link";
import { Button } from "@/components/ui";
import { ArrowUpRight } from "lucide-react";
export function PublicNav() {
  return (
    <header className="public-nav">
      <Logo />
      <nav className="public-links" aria-label="Main navigation">
        <Link href="/features">The studio</Link>
        <Link href="/how-it-works">How it works</Link>
        <Link href="/pricing">Pricing</Link>
      </nav>
      <div className="button-row">
        <Link href="/login" className="btn btn-ghost nav-login">
          Log in
        </Link>
        <Button href="/signup">
          Start creating <ArrowUpRight size={14} />
        </Button>
      </div>
    </header>
  );
}
export function PublicFooter() {
  return (
    <footer className="public-footer">
      <div>
        <Logo />
        <p className="mt-3">
          © {new Date().getFullYear()} Atelier AI. Made for the way you create.
        </p>
      </div>
      <div className="button-row">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/contact">Contact</Link>
        <Link href="/pricing">Pricing</Link>
      </div>
    </footer>
  );
}
export function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="landing">
      <PublicNav />
      {children}
      <PublicFooter />
    </div>
  );
}
