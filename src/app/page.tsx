import Image from "next/image";
import {
  ArrowRight,
  ArrowUpRight,
  Camera,
  Film,
  ScanFace,
  Sparkles,
  Check,
  Shirt,
} from "lucide-react";
import { PublicShell } from "@/components/public-shell";
import { Button } from "@/components/ui";
import { editorialImages } from "@/lib/editorial";

export default function Home() {
  return (
    <PublicShell>
      <main id="main-content">
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">
              <span className="w-5 h-px bg-secondary" />
              The fashion designer’s creative studio
            </span>
            <h1>
              Your design.
              <br />A whole new
              <br />
              <em>perspective.</em>
            </h1>
            <p className="hero-description">
              Turn the garments you make into the campaigns you imagine. Model photography, fashion
              films and personal try-on, in one thoughtful workspace.
            </p>
            <div className="button-row">
              <Button href="/signup">
                Create your workspace <ArrowUpRight size={16} />
              </Button>
              <Button href="/app/studio" variant="secondary">
                Explore the studio <ArrowRight size={15} />
              </Button>
            </div>
            <div className="hero-footnote">
              <span className="flex items-center gap-1.5">
                <Check size={12} />
                Prepaid credits
              </span>
              <span className="h-3 w-px bg-border" />
              <span>No monthly subscription</span>
            </div>
          </div>
          <div className="hero-media">
            <div className="hero-photo">
              <Image
                src={editorialImages.campaign}
                alt="Editorial street fashion in warm neutral tones"
                fill
                priority
                sizes="(max-width:680px) 100vw, 50vw"
              />
              <div className="photo-shade" />
              <div className="photo-caption">
                <div>
                  <span>From an idea to an entire story</span>
                  <p className="serif text-3xl mt-1">Made to be seen.</p>
                </div>
                <ArrowUpRight size={24} strokeWidth={1} />
              </div>
            </div>
            <span className="hero-media-tag">EDITORIAL INSPIRATION · STOCK PHOTOGRAPHY</span>
            <div className="floating-note">
              <span className="mini-icon">
                <Shirt size={19} strokeWidth={1.4} />
              </span>
              <div>
                <strong>Your garment comes first.</strong>
                <span className="muted">Keep the details that make it yours.</span>
              </div>
            </div>
          </div>
        </section>
        <section className="feature-strip" aria-label="Studio capabilities">
          {[
            {
              icon: Camera,
              title: "A photoshoot, reimagined",
              text: "Place your real garments in a setting that tells your story.",
            },
            {
              icon: Film,
              title: "Bring your collection to life",
              text: "Turn an approved photograph into a short fashion film.",
            },
            {
              icon: ScanFace,
              title: "Make it personal",
              text: "Invite a customer to a private, consent-led virtual try-on.",
            },
          ].map(({ icon: Icon, title, text }) => (
            <div className="strip-item" key={title}>
              <span className="mini-icon">
                <Icon size={20} strokeWidth={1.4} />
              </span>
              <div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            </div>
          ))}
        </section>
        <section className="public-section">
          <div className="section-intro">
            <div>
              <span className="eyebrow">One collection. Endless possibilities.</span>
              <h2>
                A little direction.
                <br />
                <span className="serif italic">A different kind of campaign.</span>
              </h2>
            </div>
            <p>
              Choose the model, set the scene, and let your work take the spotlight. You stay in
              creative control.
            </p>
          </div>
          <div className="editorial-grid">
            {[
              {
                image: editorialImages.detail,
                title: "Set the mood",
                label: "01 / MODEL PHOTOGRAPHY",
              },
              {
                image: editorialImages.portrait,
                title: "Find your muse",
                label: "02 / PERSONAL DIRECTION",
              },
              {
                image: editorialImages.wardrobe,
                title: "Tell your story",
                label: "03 / COLLECTION BUILDING",
              },
            ].map(({ image, title, label }) => (
              <div key={title} className="editorial-card">
                <Image
                  src={image}
                  alt={`${title} — illustrative stock fashion photography`}
                  fill
                  sizes="(max-width:680px) 50vw, 33vw"
                />
                <div className="photo-shade" />
                <div className="photo-caption">
                  <div>
                    <span>{label}</span>
                    <h3 className="serif">{title}</h3>
                  </div>
                  <ArrowUpRight size={20} />
                </div>
              </div>
            ))}
          </div>
          <p className="muted text-[10px] mt-3">
            Editorial inspiration shown above is stock photography, not generated product results.
            AI results vary and require review.
          </p>
        </section>
        <section className="public-section">
          <div className="section-intro">
            <div>
              <span className="eyebrow">Less setup. More creating.</span>
              <h2>
                From your worktable
                <br />
                <span className="serif italic">to your next campaign.</span>
              </h2>
            </div>
            <Button href="/how-it-works" variant="ghost">
              See how it works <ArrowRight size={15} />
            </Button>
          </div>
          <div className="steps-grid">
            {[
              {
                title: "Start with what you made",
                text: "Upload clear photographs of your garment. Save the front, back and close-up details in your private library.",
              },
              {
                title: "Give it a direction",
                text: "Choose a model and scene. Review the settings and credit quote before you commit.",
              },
              {
                title: "Make it your campaign",
                text: "Compare the result to your original, download the approved photographs, or add a little movement.",
              },
            ].map(({ title, text }, i) => (
              <div className="step-card" key={title}>
                <div className="step-num">0{i + 1}</div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="public-section">
          <div className="callout">
            <div>
              <span className="eyebrow mb-4">
                <Sparkles size={13} />
                Your next collection starts here
              </span>
              <h2>
                Every design deserves
                <br />
                <span className="serif italic">its moment.</span>
              </h2>
              <p className="muted text-sm">
                Buy credits when you need them. Create at your own pace.
              </p>
            </div>
            <Button href="/signup">
              Make room for your ideas <ArrowUpRight size={16} />
            </Button>
          </div>
        </section>
      </main>
    </PublicShell>
  );
}
