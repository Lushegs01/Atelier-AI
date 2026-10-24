"use client";
import { useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  LayoutGrid,
  Sparkles,
  Shirt,
  Camera,
  Film,
  ScanFace,
  Images,
  Users,
  Wallet,
  CreditCard,
  Settings,
  CircleHelp,
  ChevronDown,
  ChevronRight,
  Search,
  Bell,
  Plus,
  Menu,
  LogOut,
  X,
  ArrowUpRight,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { Button, Dialog, Notice, Tooltip, useToast } from "@/components/ui";
import { InstallButton } from "@/components/pwa-manager";
import { WorkspaceProvider, useWorkspace, apiRequest } from "@/features/workspace/context";

const navigation = [
  { href: "/app", label: "Overview", icon: LayoutGrid },
  { href: "/app/studio", label: "Creative studio", icon: Sparkles },
  { href: "/app/garments", label: "Garment library", icon: Shirt },
  { href: "/app/photos", label: "Model photography", icon: Camera },
  { href: "/app/videos", label: "Fashion films", icon: Film },
  { href: "/app/try-on", label: "Virtual try-on", icon: ScanFace },
  { href: "/app/gallery", label: "Content gallery", icon: Images },
  { href: "/app/customers", label: "Customers", icon: Users },
];
function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const notify = useToast();
  const { data, error, page, setPage } = useWorkspace();
  const [mobile, setMobile] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [search, setSearch] = useState("");
  const current = navigation.find((n) =>
    n.href === "/app" ? pathname === "/app" : pathname.startsWith(n.href),
  );
  return (
    <div className="workspace-shell">
      <aside className={`sidebar ${mobile ? "mobile-open" : ""}`} aria-label="Workspace navigation">
        <div className="flex items-center justify-between">
          <Logo href="/app" />
          {mobile && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobile(false)}
              aria-label="Close navigation"
            >
              <X size={17} />
            </Button>
          )}
        </div>
        <Link href="/app/settings/organization" className="workspace-picker">
          <span className="workspace-avatar">{data.organization?.name?.[0] || "A"}</span>
          <div className="flex-1 min-w-0">
            <div className="workspace-name">{data.organization?.name || "Your creative space"}</div>
            <div className="workspace-label">Designer workspace</div>
          </div>
          <ChevronDown size={12} className="muted" />
        </Link>
        <p className="nav-section-label">WORKSPACE</p>
        <nav>
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setMobile(false)}
              className={`nav-link ${(href === "/app" ? pathname === href : pathname.startsWith(href)) ? "active" : ""}`}
            >
              <Icon size={16} strokeWidth={1.6} />
              {label}
              {href === "/app/studio" && (
                <span className="ml-auto text-[8px] tracking-wide">NEW</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <nav>
            <Link
              href="/app/credits"
              className={`nav-link ${pathname === "/app/credits" ? "active" : ""}`}
            >
              <Wallet size={16} strokeWidth={1.6} />
              Credits & usage
            </Link>
            <Link href="/app/billing" className="nav-link">
              <CreditCard size={16} strokeWidth={1.6} />
              Billing
            </Link>
            <Link href="/app/settings/profile" className="nav-link">
              <Settings size={16} strokeWidth={1.6} />
              Settings
            </Link>
            <Link href="/how-it-works" className="nav-link">
              <CircleHelp size={16} strokeWidth={1.6} />A little guidance{" "}
              <ArrowUpRight size={12} className="ml-auto" />
            </Link>
          </nav>
          <div className="credit-widget">
            <div className="credit-widget-title">
              <span>YOUR CREATIVE CREDITS</span>
              <Sparkles size={11} />
            </div>
            <div className="credit-widget-value">
              {data.balance.available.toLocaleString()}
              <small>available</small>
            </div>
            <Button href="/app/credits" variant="secondary" size="small" className="w-full">
              Top up credits <Plus size={12} />
            </Button>
          </div>
          <div className="sidebar-profile">
            <span className="workspace-avatar">{data.user?.fullName?.[0] || "A"}</span>
            <div className="flex-1">
              <div className="workspace-name">{data.user?.fullName || "Your account"}</div>
              <div className="workspace-label">{data.role || "Designer"}</div>
            </div>
            <Tooltip text="Sign out of your account">
              <button
                className="btn btn-ghost p-1.5"
                aria-label="Sign out"
                onClick={async () => {
                  try {
                    await apiRequest("/api/auth/logout");
                    router.replace("/login");
                    router.refresh();
                  } catch (cause) {
                    notify(cause instanceof Error ? cause.message : "Sign out failed", true);
                  }
                }}
              >
                <LogOut size={14} />
              </button>
            </Tooltip>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="mobile-menu-button"
              onClick={() => setMobile(true)}
              aria-label="Open navigation"
            >
              <Menu size={19} />
            </Button>
            <span className="mobile-menu-button mobile-brand">
              atelier <span className="text-xs text-secondary ml-1">AI</span>
            </span>
            <div className="breadcrumbs">
              Workspace <ChevronRight size={11} />
              <strong>
                {current?.label || pathname.split("/").filter(Boolean).at(-1)?.replaceAll("-", " ")}
              </strong>
            </div>
          </div>
          <div className="topbar-actions">
            <form
              className="topbar-search"
              onSubmit={(e) => {
                e.preventDefault();
                router.push(`/app/garments?q=${encodeURIComponent(search)}`);
              }}
            >
              <Search size={13} />
              <input
                aria-label="Search your garments"
                placeholder="Search your collection"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd>↵</kbd>
            </form>
            <InstallButton />
            <Tooltip text="Generation activity">
              <Button
                variant="ghost"
                size="icon"
                aria-label="View generation activity"
                onClick={() => setNotifications(true)}
              >
                <Bell size={17} strokeWidth={1.5} />
              </Button>
            </Tooltip>
            <Button href="/app/studio" size="small">
              <Plus size={14} />
              Create new
            </Button>
          </div>
        </header>
        <main id="main-content" className="workspace-content">
          {error && (
            <div className="workspace-banner">
              <Notice tone="error">
                {error}{" "}
                <button onClick={() => window.location.reload()} className="underline ml-2">
                  Reconnect
                </button>
              </Notice>
            </div>
          )}
          {children}
          {data.configured &&
            !/\/settings\//.test(pathname) &&
            (page > 1 || data.pagination?.hasMore) && (
              <div className="button-row justify-end mt-6">
                <Button
                  variant="secondary"
                  size="small"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <span className="text-xs muted">Page {page}</span>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={!data.pagination?.hasMore}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            )}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Quick navigation">
        {[
          { href: "/app", label: "Home", icon: LayoutGrid },
          { href: "/app/garments", label: "Garments", icon: Shirt },
          { href: "/app/studio", label: "Create", icon: Plus },
          { href: "/app/gallery", label: "Gallery", icon: Images },
          { href: "/app/settings/profile", label: "Account", icon: Settings },
        ].map(({ href, label, icon: Icon }) => (
          <Link
            href={href}
            key={href}
            className={`${pathname === href ? "active" : ""} ${label === "Create" ? "create-tab" : ""}`}
          >
            <Icon size={20} strokeWidth={1.6} />
            {label !== "Create" && <span>{label}</span>}
          </Link>
        ))}
      </nav>
      <Dialog
        open={notifications}
        onOpenChange={setNotifications}
        title="Your studio activity"
        description="Updates from your recent generation jobs."
      >
        {data.jobs.length ? (
          data.jobs.slice(0, 6).map((job) => (
            <Link
              className="job-item"
              key={job.id}
              href={`/app/generations/${job.id}`}
              onClick={() => setNotifications(false)}
            >
              <span className="mini-icon">
                <Sparkles size={16} />
              </span>
              <div>
                <h3>{job.operation.replaceAll("_", " ")}</h3>
                <p>{job.status.replaceAll("_", " ")}</p>
              </div>
              <ChevronRight size={15} className="ml-auto" />
            </Link>
          ))
        ) : (
          <p className="muted text-sm">
            No activity yet. Your first campaign starts in the creative studio.
          </p>
        )}
      </Dialog>
    </div>
  );
}
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <Shell>{children}</Shell>
    </WorkspaceProvider>
  );
}
