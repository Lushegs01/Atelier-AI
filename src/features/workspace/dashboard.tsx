"use client";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowUpRight,
  ArrowRight,
  Camera,
  Film,
  ScanFace,
  Plus,
  Sparkles,
  Clock3,
  Shirt,
} from "lucide-react";
import { Badge, Button, Empty } from "@/components/ui";
import { PageHeading, Onboarding, SetupNotice } from "./common";
import { useWorkspace } from "./context";
import { editorialImages } from "@/lib/editorial";
import { dateLabel } from "@/lib/utils";
export default function Dashboard() {
  const { data, loading } = useWorkspace();
  const first = data.user?.fullName?.split(" ")[0];
  return (
    <>
      <PageHeading
        title={first ? `A little inspiration, ${first}.` : "A little space for big ideas."}
        description="Welcome to your studio. Let’s make something worth seeing."
        action={
          <Badge>
            <span className="w-1.5 h-1.5 rounded-full bg-secondary" />
            Your creative workspace
          </Badge>
        }
      />
      <SetupNotice />
      <Onboarding />
      <section className="dashboard-hero">
        <div className="dashboard-hero-copy">
          <span className="eyebrow">
            <Sparkles size={12} />
            Your next campaign starts here
          </span>
          <h2>
            Made by you.
            <br />
            <span className="serif italic">Seen in a new light.</span>
          </h2>
          <p>Take the piece you’ve poured yourself into and give it a setting all its own.</p>
          <Button href="/app/studio">
            Create a photoshoot <ArrowUpRight size={14} />
          </Button>
        </div>
        <div className="dashboard-hero-image">
          <Image
            src={editorialImages.campaign}
            alt="Editorial fashion inspiration — stock photograph"
            fill
            sizes="(max-width:680px) 45vw, 40vw"
            priority
          />
          <span className="image-label">ILLUSTRATIVE STOCK PHOTOGRAPHY</span>
        </div>
      </section>
      <div className="quick-grid">
        {[
          {
            href: "/app/studio",
            icon: Camera,
            title: "Create a photoshoot",
            description: "Your garment. A fresh perspective.",
          },
          {
            href: "/app/videos",
            icon: Film,
            title: "Make a fashion film",
            description: "Give your imagery a little motion.",
          },
          {
            href: "/app/try-on",
            icon: ScanFace,
            title: "Invite a customer",
            description: "A personal, private try-on.",
          },
        ].map(({ href, icon: Icon, title, description }) => (
          <Link href={href} key={href} className="quick-card panel">
            <span className="mini-icon">
              <Icon size={18} strokeWidth={1.5} />
            </span>
            <div>
              <h3>{title}</h3>
              <p>{description}</p>
            </div>
            <ArrowUpRight size={14} />
          </Link>
        ))}
      </div>
      <div className="dashboard-grid">
        <section className="panel panel-padded">
          <div className="panel-heading">
            <div>
              <h2>Your garment collection</h2>
              <p>The starting point for everything you create.</p>
            </div>
            <Button href="/app/garments" variant="ghost" size="small">
              View all <ArrowRight size={12} />
            </Button>
          </div>
          {loading ? (
            <div className="skeleton h-48" />
          ) : data.garments.length ? (
            <div className="asset-grid !grid-cols-2">
              {data.garments.slice(0, 2).map((g) => (
                <Link href={`/app/garments/${g.id}`} key={g.id}>
                  <div className="asset-image rounded-xl !aspect-[4/3]">
                    {g.imageUrl ? <img src={g.imageUrl} alt={g.name} /> : <Shirt size={25} />}
                  </div>
                  <h3 className="text-xs mt-3">{g.name}</h3>
                  <p className="muted text-[10px] mt-1 capitalize">{g.category}</p>
                </Link>
              ))}
            </div>
          ) : (
            <Empty
              title="Meet your next campaign"
              description="Upload a garment you love. We’ll keep the original safe and ready for your next idea."
              icon={<Shirt size={22} strokeWidth={1.4} />}
              action={
                <Button href="/app/garments" variant="secondary" size="small">
                  <Plus size={13} />
                  Add your first garment
                </Button>
              }
            />
          )}
        </section>
        <section className="panel panel-padded">
          <div className="panel-heading">
            <div>
              <h2>In the making</h2>
              <p>Your latest creative activity.</p>
            </div>
            <Clock3 size={16} strokeWidth={1.3} className="muted" />
          </div>
          {data.jobs.length ? (
            data.jobs.slice(0, 4).map((job) => (
              <Link className="job-item" href={`/app/generations/${job.id}`} key={job.id}>
                <span className="mini-icon">
                  <Sparkles size={15} />
                </span>
                <div>
                  <h3 className="capitalize">{job.operation.replaceAll("_", " ")}</h3>
                  <p>{dateLabel(job.created_at)}</p>
                </div>
                <Badge
                  tone={
                    job.status === "succeeded"
                      ? "success"
                      : job.status === "failed"
                        ? "error"
                        : "default"
                  }
                >
                  {job.status.replaceAll("_", " ")}
                </Badge>
              </Link>
            ))
          ) : (
            <Empty
              title="Something good takes shape here"
              description="Your generation progress and finished work will appear here. Start whenever inspiration strikes."
              icon={<Clock3 size={22} strokeWidth={1.4} />}
            />
          )}
        </section>
      </div>
      <div className="section-spaced flex items-center gap-3 text-[10px] text-muted">
        <span className="mini-icon !w-8 !h-8">
          <ScanFace size={15} strokeWidth={1.3} />
        </span>
        <p>Your customers’ photos stay private. Try-on always starts with their consent.</p>
        <Link className="ml-auto text-secondary whitespace-nowrap" href="/privacy">
          Our approach to privacy <ArrowUpRight size={11} className="inline" />
        </Link>
      </div>
    </>
  );
}
