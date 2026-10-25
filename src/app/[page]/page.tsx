import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Camera, Film, ScanFace, FolderHeart, ArrowRight, ShieldCheck } from "lucide-react";
import { PublicShell } from "@/components/public-shell";
import { Button, Notice } from "@/components/ui";
import { Pricing } from "@/features/public/pricing";
import { editorialImages } from "@/lib/editorial";
const pages = ["features", "pricing", "how-it-works", "privacy", "terms", "contact"];
export function generateStaticParams() {
  return pages.map((page) => ({ page }));
}
export async function generateMetadata({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  return {
    title: page
      .split("-")
      .map((s) => s[0].toUpperCase() + s.slice(1))
      .join(" "),
  };
}
export default async function PublicPage({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  if (!pages.includes(page)) notFound();
  const head: Record<string, [string, string, string]> = {
    features: [
      "Your creative toolkit",
      "A studio for the whole story.",
      "Start with a garment. Give it a setting and help a customer imagine wearing it. Available tools follow your studio’s selected model.",
    ],
    pricing: [
      "Prepaid. At your pace.",
      "A little credit. A lot of possibility.",
      "No monthly subscription. Buy a bundle, see the cost before you create, and keep your collection moving.",
    ],
    "how-it-works": [
      "From garment to campaign",
      "You set the direction.",
      "A considered workflow that keeps the original garment at the centre of every creative decision.",
    ],
    privacy: [
      "Your work stays yours",
      "Privacy, with care.",
      "How we handle your garments, your account and your customers’ photographs.",
    ],
    terms: [
      "A shared understanding",
      "Terms of use.",
      "The foundations for using Atelier AI responsibly.",
    ],
    contact: [
      "Let’s make it work",
      "A little help for your studio.",
      "For product questions, privacy requests and business enquiries.",
    ],
  };
  return (
    <PublicShell>
      <main id="main-content" className="public-page">
        <header className="public-page-head">
          <span className="eyebrow">{head[page][0]}</span>
          <h1>{head[page][1]}</h1>
          <p>{head[page][2]}</p>
        </header>
        {page === "pricing" && (
          <>
            <Pricing />
            <div className="mt-8">
              <Notice>
                The default Qwen Image Edit workflow creates experimental still images. Customer
                visualization is separately enabled and does not verify fit. Video requires a
                separately configured supported provider. Generation credits cover the studio’s
                processing costs; open model weights do not make GPU hosting free.
              </Notice>
            </div>
          </>
        )}
        {page === "features" && (
          <div className="grid md:grid-cols-2 gap-6">
            {[
              {
                icon: Camera,
                title: "The photoshoot",
                text: "Upload your garment, choose your scene and guide the model’s presentation. Compare the output with the original before publishing.",
                image: editorialImages.campaign,
                route: "/app/studio",
              },
              {
                icon: Film,
                title: "The fashion film",
                text: "Qwen Image Edit creates still images. Video is available only when a separate supported provider is configured and enabled. Existing films remain in your library.",
                image: editorialImages.detail,
                route: "/app/videos",
              },
              {
                icon: ScanFace,
                title: "The personal fitting room",
                text: "Share a time-limited private link. Your customer gives explicit consent before their image is processed. Results stay within the authorized session.",
                image: editorialImages.portrait,
                route: "/app/try-on",
              },
              {
                icon: FolderHeart,
                title: "The garment library",
                text: "Keep original views separate from generated content. Search your collection and reuse the photographs you already have.",
                image: editorialImages.wardrobe,
                route: "/app/garments",
              },
            ].map(({ icon: Icon, title, text, image, route }) => (
              <article className="panel overflow-hidden" key={title}>
                <div className="relative h-64">
                  <Image
                    src={image}
                    alt={`${title} — illustrative stock photography`}
                    fill
                    sizes="(max-width:680px) 100vw, 50vw"
                    className="object-cover"
                  />
                </div>
                <div className="p-7">
                  <Icon size={21} strokeWidth={1.4} className="text-secondary mb-4" />
                  <h2 className="text-2xl mb-3">{title}</h2>
                  <p className="muted text-sm mb-5">{text}</p>
                  <Button href={route} variant="secondary" size="small">
                    Explore <ArrowRight size={13} />
                  </Button>
                  <p className="text-[9px] muted mt-4">Illustrative stock photography</p>
                </div>
              </article>
            ))}
          </div>
        )}
        {page === "how-it-works" && (
          <>
            <div className="form-stack">
              {[
                {
                  title: "Upload the real garment",
                  text: "Use a well-lit front photograph with visible edges and details. Add back, side and detail views to your library. Each workflow checks its compatible inputs.",
                },
                {
                  title: "Build your creative direction",
                  text: "Choose studio, city or natural light; describe the model and pose. These settings guide presentation. They should not redesign the garment.",
                },
                {
                  title: "Review the quote, then create",
                  text: "The server confirms a price from the current catalog. Credits are reserved atomically before a durable job is queued. You can leave the page while it processes.",
                },
                {
                  title: "Compare, approve, and share",
                  text: "Review silhouette, colour, print, embroidery and construction against your source. Download approved results. Optional motion tools appear only with a supported enabled provider.",
                },
              ].map(({ title, text }, i) => (
                <div className="panel p-7 flex gap-6" key={title}>
                  <div className="step-num shrink-0">0{i + 1}</div>
                  <div>
                    <h2 className="text-xl mb-3">{title}</h2>
                    <p className="muted text-sm leading-relaxed">{text}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-7">
              <Notice>
                <ShieldCheck size={15} className="inline mr-1" />
                Customer try-on always adds explicit consent, a photo review and a private session.
                AI cannot guarantee exact garment preservation or accurate fit.
              </Notice>
            </div>
          </>
        )}
        {page === "privacy" && (
          <div className="prose">
            <Notice tone="warning">
              Initial policy, version 2026-10-25. The operator must supply its legal identity,
              support contact, legal basis and jurisdiction-specific disclosures before launch. This
              document requires qualified legal review.
            </Notice>
            <h2>Your account and collection</h2>
            <p>
              We store your account identity, organization membership, garment photographs,
              generation settings, results, credit ledger and payment references to operate the
              workspace. Original garments and results are stored privately. Authorized access uses
              short-lived links.
            </p>
            <h2>Customer photographs and consent</h2>
            <p>
              Customers explicitly agree to fashion visualization before processing. Consent records
              include the disclosure version and session. We do not request measurements or
              unnecessary personal details. Promotional use is not included in this consent.
            </p>
            <h2>Image processing and service providers</h2>
            <p>
              The default image editor is Qwen Image Edit, hosted on a GPU service operated for the
              studio. Photographs are sent to that configured host for the requested image edit;
              they are not sent to FASHN when Qwen is selected. The operator must identify its GPU
              host, region, access controls and any infrastructure processors before launch. Qwen
              customer visualization is experimental and may change garment, body or identity
              details.
            </p>
            <p>
              Supabase handles authentication, database and private storage. Inngest orchestrates
              jobs using application identifiers. Paystack processes payments; Atelier AI does not
              store card numbers. Hosting and optional Sentry monitoring are configured by the
              operator. Customer consent identifies the actual provider pinned to that invitation.
              Existing jobs keep their original provider when a studio changes configuration.
            </p>
            <p>
              A studio may separately configure FASHN instead of Qwen. Only those FASHN jobs send
              photographs to FASHN and its subprocessors, under its{" "}
              <a
                href="https://docs.fashn.ai/api-overview/data-retention-privacy"
                target="_blank"
                rel="noreferrer"
              >
                data retention documentation
              </a>
              . A studio may instead select free open models hosted on Hugging Face Spaces. Only
              those jobs send photographs to Hugging Face and the operator of each Space, under the{" "}
              <a href="https://huggingface.co/privacy" target="_blank" rel="noreferrer">
                Hugging Face privacy policy
              </a>
              . Provider and GPU-host retention and account-specific terms must be checked before
              launch. Deletion from Atelier AI does not by itself confirm removal of every upstream
              or backup copy.
            </p>
            <h2>Retention and deletion</h2>
            <p>
              The default customer source-photo retention is 24 hours. The scheduled cleanup removes
              expired source images, expired sessions’ guest results and queued deletion requests.
              The Qwen service uses private temporary input files and expiring results; its separate
              GPU storage and backups require the operator’s retention and deletion controls.
              Workspace garment and campaign assets remain until their authorized owner deletes
              them. Financial and audit records have separate legal retention requirements, which
              the operator must define.
            </p>
            <h2>Your choices</h2>
            <p>
              Use Settings → Privacy to request an export or account deletion. Customers can request
              deletion from their private try-on page. Requests are recorded and background deletion
              is retried on failure. Never upload another person’s photograph without permission.
            </p>
            <h2>Browser storage</h2>
            <p>
              Essential session cookies authenticate your workspace. Our service worker caches only
              a public offline page and application icons. It does not cache private photographs,
              account pages, financial data or authenticated API responses.
            </p>
          </div>
        )}
        {page === "terms" && (
          <div className="prose">
            <Notice tone="warning">
              Initial terms, version 2026-10-25. Legal identity, contact, dispute process,
              applicable law and refund terms require operator completion and qualified legal review
              before public launch.
            </Notice>
            <h2>Permission to use your inputs</h2>
            <p>
              You must have the rights and permissions to upload garment images, reference images
              and customer photographs. Do not impersonate people, create non-consensual images,
              infringe others’ rights, or upload unlawful material. Customer-photo processing
              requires explicit consent.
            </p>
            <h2>Creative outputs and review</h2>
            <p>
              AI outputs can contain errors and may change details. You are responsible for
              reviewing garment fidelity, likeness and publication rights. Virtual try-on is an
              illustration, not a body-measurement service, guarantee of fit, or proof of real-world
              appearance. Video motion does not prove material behaviour.
            </p>
            <h2>Credits and payments</h2>
            <p>
              Prices appear before generation. Prepaid credits are reserved while a job runs and
              charged when results are safely stored. Failed jobs release reservations. A successful
              result is not automatically refunded because you dislike it. Duplicate verified
              payment notifications issue value only once. Statutory consumer rights take precedence
              over any operator policy.
            </p>
            <p>
              Open model weights do not include free compute. The operator may price generation
              credits to cover GPU time, storage and service operations. No free hosted inference
              entitlement is included. Qwen Image Edit does not generate video.
            </p>
            <h2>Service availability</h2>
            <p>
              Provider Preview and Experimental features may change or be disabled independently. We
              do not guarantee uninterrupted availability, exact fidelity or any sales outcome. The
              operator must define support targets and applicable liability terms before launch.
            </p>
            <h2>Account controls</h2>
            <p>
              Keep account access secure. Workspace owners manage authorized membership.
              Administrative actions and financial adjustments are audited. Privacy and account
              requests can be submitted in the application.
            </p>
          </div>
        )}
        {page === "contact" && (
          <div className="max-w-xl mx-auto panel p-8">
            <span className="mini-icon mb-5">
              <ShieldCheck size={22} strokeWidth={1.3} />
            </span>
            <h2 className="mb-4">We’re here for the work.</h2>
            <p className="muted text-sm mb-5">
              For account help, include your workspace name and the affected generation or payment
              reference. Never send passwords, payment card details or customer photographs by
              email.
            </p>
            {process.env.SUPPORT_EMAIL ? (
              <Button href={`mailto:${process.env.SUPPORT_EMAIL}`}>
                Contact support <ArrowRight size={14} />
              </Button>
            ) : (
              <Notice>
                The operator’s support address will appear here once configured. Existing users can
                submit a private request in{" "}
                <Link href="/app/settings/privacy">Settings → Privacy</Link>.
              </Notice>
            )}
          </div>
        )}
      </main>
    </PublicShell>
  );
}
