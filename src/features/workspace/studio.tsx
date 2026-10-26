"use client";
import { useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Camera,
  Film,
  ScanFace,
  Check,
  ArrowRight,
  ArrowUpRight,
  ImagePlus,
  Sun,
  Building2,
  Leaf,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge, Button, Dialog, Empty, Select, Input, Notice, useToast } from "@/components/ui";
import { PageHeading, SetupNotice, Onboarding, AiDisclosure } from "./common";
import { useWorkspace, apiRequest } from "./context";
import { GarmentUpload } from "./garments";
import { jobStatusLabel, operationAvailability } from "./provider";
type Quote = {
  quote: { credits: number; available: number; sufficient: boolean; lifecycle: string };
  quoteToken: string;
};
/** Prompt presets for the same model; they are not separate model capabilities. */
const directions = [
  {
    id: "faithful",
    name: "Faithful visualization",
    description: "Plain studio, front view. Closest to the original garment.",
  },
  {
    id: "editorial",
    name: "Editorial",
    description: "Magazine-style photograph in your chosen setting.",
  },
  {
    id: "lifestyle",
    name: "Lifestyle campaign",
    description: "Relaxed, natural imagery for campaigns and social.",
  },
  {
    id: "product",
    name: "Product image",
    description: "Ghost-mannequin product shot, no model.",
  },
] as const;
const motionPresets = [
  {
    id: "subtle",
    name: "Subtle movement",
    description: "Slight weight shift and breathing. Steady camera.",
  },
  {
    id: "fabric",
    name: "Fabric in motion",
    description: "A light breeze moves the fabric. Steady camera.",
  },
  {
    id: "camera",
    name: "Slow push-in",
    description: "The model holds still while the camera moves in slowly.",
  },
] as const;
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] % 2_147_483_647;
const ACTIVE = ["queued", "submitting", "processing", "retry_wait"];
const scenes = [
  {
    name: "Daylight studio",
    icon: Sun,
    style: "studio",
    prompt: "A minimal daylight studio, pale neutral seamless background and soft window light",
  },
  {
    name: "City editorial",
    icon: Building2,
    style: "city",
    prompt: "An elegant city street, restrained editorial architecture and soft natural light",
  },
  {
    name: "Natural light",
    icon: Leaf,
    style: "nature",
    prompt: "A serene outdoor garden, natural green backdrop and warm diffused daylight",
  },
];
export default function Studio({ video = false }: { video?: boolean }) {
  const { data } = useWorkspace();
  const router = useRouter();
  const params = useSearchParams();
  const notify = useToast();
  const [garmentId, setGarmentId] = useState(params.get("garment") || "");
  const [sourceId, setSourceId] = useState(params.get("source") || "");
  const [upload, setUpload] = useState(false);
  const [scene, setScene] = useState(0);
  const [model, setModel] = useState("Adult woman, editorial fashion model");
  const [pose, setPose] = useState("Relaxed standing pose");
  const [ratio, setRatio] = useState("3:4");
  const [durationChoice, setDuration] = useState("5");
  const [resolutionChoice, setResolution] = useState("1080p");
  const [motion, setMotion] = useState("");
  const [direction, setDirection] = useState<(typeof directions)[number]["id"]>("editorial");
  const [motionPreset, setMotionPreset] = useState<(typeof motionPresets)[number]["id"]>("subtle");
  const [seed, setSeed] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false);
  const submitting = useRef(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const availability = operationAvailability(
    video ? "video" : "photo",
    data.capabilities,
    data.provider,
  );
  // Offer only the video options the selected provider can honour.
  const durations = availability.capability?.supportedDurations ?? [5, 10];
  const resolutions = availability.capability?.supportedResolutions ?? ["480p", "720p", "1080p"];
  const duration = durations.includes(Number(durationChoice))
    ? durationChoice
    : String(durations[0]);
  const resolution = resolutions.includes(resolutionChoice)
    ? resolutionChoice
    : resolutions[resolutions.length - 1];
  const presetMotion = availability.capability?.freeTextMotion === false;
  const acknowledgement = data.provider?.processingDisclosureVersion;
  const garment = data.garments.find((g) => g.id === garmentId);
  const source = data.outputs.find((o) => o.asset_id === sourceId);
  const sourceGarment = data.garments.find((g) => g.assets?.some((a) => a.id === sourceId));
  const sourceAsset = source?.asset || sourceGarment?.assets?.find((a) => a.id === sourceId);
  const preview = video ? source?.url || sourceGarment?.imageUrl : garment?.imageUrl;
  const sourceWarning = video && sourceAsset ? shapeWarning(sourceAsset) : "";
  const running = data.jobs.find(
    (j) =>
      ACTIVE.includes(j.status) &&
      j.operation === (video ? "video" : "photo") &&
      (video ? j.source_asset_id === sourceId : j.garment_id === garmentId),
  );
  function shapeWarning(asset: { width?: number; height?: number }) {
    const capability = availability.capability;
    if (!capability || !asset.width || !asset.height) return "";
    const ratio = asset.width / asset.height;
    if (
      asset.width < (capability.minInputDimension ?? 0) ||
      asset.height < (capability.minInputDimension ?? 0)
    )
      return `This image is smaller than ${capability.minInputDimension} px on one side. Choose a larger photograph.`;
    if (
      (capability.minAspectRatio !== undefined && ratio < capability.minAspectRatio - 1e-6) ||
      (capability.maxAspectRatio !== undefined && ratio > capability.maxAspectRatio + 1e-6)
    )
      return "This image is too tall or wide for the video model, which would crop part of the garment. Choose a portrait, square or landscape image no narrower than about 9:16.";
    return "";
  }
  const buildPayload = (requestSeed: number) => ({
    organizationId: data.organization?.id,
    operation: video ? "video" : "photo",
    ...(video ? { sourceAssetId: sourceId } : { garmentId }),
    options: video
      ? {
          duration: Number(duration),
          resolution,
          ...(presetMotion ? { motionPreset } : { motion }),
          seed: requestSeed,
        }
      : {
          direction,
          scene:
            direction === "faithful"
              ? "A plain light-grey photography studio"
              : direction === "product"
                ? "A seamless warm-white studio background"
                : scenes[scene].prompt,
          model,
          pose,
          aspectRatio: ratio,
          resolution: "1k",
          quality: "balanced",
          numImages: 1,
          outputFormat: "png",
          // A new seed per confirmed request, so "create another version" is a new image.
          seed: requestSeed,
        },
  });
  async function getQuote() {
    setError("");
    if (!availability.enabled) return notify(availability.reason, true);
    if (!data.organization)
      return notify("Connect your account and create a workspace first.", true);
    if (video ? !sourceId : !garmentId)
      return notify(
        video
          ? "Choose a photograph to animate."
          : "Select a garment from your library, or upload a new piece.",
        true,
      );
    if (sourceWarning) return notify(sourceWarning, true);
    setBusy(true);
    try {
      const nextSeed = randomSeed();
      const result = await apiRequest<Quote>(
        "/api/generations/quote",
        "POST",
        buildPayload(nextSeed),
      );
      setQuote(result);
      setSeed(nextSeed);
      // One identifier per reviewed quote: retries and double clicks reuse it, so the server
      // returns the same job instead of spending free GPU quota twice.
      setKey(crypto.randomUUID());
      setAcknowledged(false);
      setReview(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not fetch a quote.");
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (!quote || submitting.current) return;
    if (acknowledgement && !acknowledged)
      return setError("Review and accept the third-party processing notice first.");
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest<{ job: { id: string } }>("/api/generations", "POST", {
        ...buildPayload(seed),
        idempotencyKey: key,
        quoteToken: quote.quoteToken,
        ...(acknowledgement ? { processingAcknowledgement: acknowledgement } : {}),
      });
      notify("Your generation is queued. You can leave this page.");
      router.push(`/app/generations/${result.job.id}`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Submission interrupted. Retry this confirmation to use the same request identifier.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  if (video && !availability.enabled) {
    return (
      <>
        <PageHeading
          title="Your collection, in motion."
          description="Video availability depends on your studio’s selected generation model."
          action={<Badge>{data.provider?.label || "Video"} · unavailable</Badge>}
        />
        <SetupNotice />
        <section className="panel panel-padded">
          <Empty
            icon={<Film size={25} strokeWidth={1.3} />}
            title={
              data.provider?.id === "qwen"
                ? "Still images, with a new perspective."
                : "Fashion video is currently unavailable"
            }
            description={`${availability.reason} Existing films remain in your gallery. No video credits can be reserved here.`}
            action={
              <Button href="/app/studio">
                Create a model photograph <ArrowUpRight size={14} />
              </Button>
            }
          />
          <div className="button-row justify-center">
            <Button href="/app/gallery?type=video" variant="secondary">
              Review existing films
            </Button>
          </div>
        </section>
        <div className="mt-6">
          <Notice>
            {data.provider?.id === "qwen"
              ? "Qwen Image Edit is an experimental still-image workflow. It has no video engine. A studio may enable a separate supported provider after reviewing its costs and privacy terms."
              : "Video generation is disabled for this studio. Your studio operator can review availability, privacy terms and costs before enabling it."}
          </Notice>
        </div>
      </>
    );
  }
  return (
    <>
      <PageHeading
        title={video ? "A little movement. A new story." : "Let’s create a new perspective."}
        description={
          video
            ? "Turn an approved photograph into a short fashion film."
            : "Your garment is the starting point. You set the creative direction."
        }
        action={
          <Badge>
            {data.provider?.label || "AI"} · {availability.capability?.lifecycle || "Experimental"}
          </Badge>
        }
      />
      <SetupNotice />
      <Onboarding />
      <div className="mb-5">
        <Notice tone={availability.enabled ? undefined : "warning"}>
          {availability.enabled
            ? data.provider?.id === "qwen"
              ? "Qwen Image Edit uses your garment photo to create an experimental edited photograph. Review garment details carefully; this is not a specialized garment-fidelity guarantee."
              : data.provider?.id === "huggingface"
                ? video
                  ? "Free Hugging Face Space (Wan 2.2 image-to-video). Motion is AI-generated from your approved image and can alter garment details between frames; review the clip before using it."
                  : "Free Hugging Face Space (Qwen Image Edit). Your direction guides a general image-editing model; it cannot guarantee exact reproduction of construction, print or embellishment. Compare the result with your original before approving it."
                : "Your selected provider is enabled. Review the original garment, generation settings and price before submitting."
            : availability.reason}
        </Notice>
      </div>
      <div className="mode-tabs max-w-xl" aria-label="Choose a creative workflow">
        <Link className={!video ? "active" : ""} href="/app/studio">
          <Camera size={14} className="inline mr-2" />
          Model photo
        </Link>
        <Link className={video ? "active" : ""} href="/app/videos">
          <Film size={14} className="inline mr-2" />
          Fashion film
        </Link>
        <Link href="/app/try-on">
          <ScanFace size={14} className="inline mr-2" />
          Virtual try-on
        </Link>
      </div>
      <div className="studio-layout">
        <div className="studio-form">
          <section className="panel studio-step">
            <div className="step-heading">
              <span className="step-num">01</span>
              <h2>{video ? "Choose your starting image" : "Start with your garment"}</h2>
              <small>PRIVATE SOURCE</small>
            </div>
            {video ? (
              <>
                <Select
                  label="Image to animate"
                  value={sourceId}
                  onChange={(e) => setSourceId(e.target.value)}
                >
                  <option value="">Choose an approved photograph</option>
                  {data.outputs
                    .filter(
                      (o) =>
                        o.operation !== "try_on" &&
                        o.approved_at &&
                        !o.rejected_at &&
                        (o.asset?.mime_type?.startsWith("image/") ||
                          o.asset?.kind === "generated_image"),
                    )
                    .map((o, i) => (
                      <option key={o.id} value={o.asset_id}>
                        Approved photo {i + 1}
                      </option>
                    ))}
                  {data.garments.flatMap((g) =>
                    (g.assets || [])
                      .filter((a) => ["original", "garment_original"].includes(a.kind))
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {g.name} · original {a.view || "front"}
                        </option>
                      )),
                  )}
                </Select>
                <div className="field-hint mt-3">
                  Only photographs you approved after review are listed, plus your original garment
                  photos. Minimum {availability.capability?.minInputDimension ?? 301} px per side
                  {availability.capability?.minAspectRatio !== undefined
                    ? "; very tall or very wide images are rejected rather than cropped"
                    : ""}
                  .
                </div>
                {sourceWarning && (
                  <div className="mt-3">
                    <Notice tone="warning">{sourceWarning}</Notice>
                  </div>
                )}
              </>
            ) : (
              <>
                <Select
                  label="From your garment library"
                  value={garmentId}
                  onChange={(e) => setGarmentId(e.target.value)}
                >
                  <option value="">Choose a piece from your collection</option>
                  {data.garments
                    .filter((g) => !g.archived_at)
                    .map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                </Select>
                <div className="flex items-center gap-3 my-4">
                  <div className="h-px bg-border flex-1" />
                  <span className="muted text-[9px]">OR START WITH SOMETHING NEW</span>
                  <div className="h-px bg-border flex-1" />
                </div>
                <button className="upload-zone w-full" onClick={() => setUpload(true)}>
                  <ImagePlus size={26} strokeWidth={1.2} />
                  <strong>Give your next piece a place</strong>
                  <small>Upload a garment photo · JPG, PNG or WebP</small>
                  <span className="text-[10px] mt-1 underline underline-offset-4">
                    Browse files
                  </span>
                </button>
              </>
            )}
          </section>
          <section className="panel studio-step">
            <div className="step-heading">
              <span className="step-num">02</span>
              <h2>{video ? "Find the right movement" : "Set the scene"}</h2>
              <small>CREATIVE DIRECTION</small>
            </div>
            {video ? (
              <div className="form-stack">
                <div className="form-grid">
                  <Select
                    label="Film duration"
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                  >
                    {durations.map((d) => (
                      <option key={d} value={d}>
                        {d} seconds
                      </option>
                    ))}
                  </Select>
                  <Select
                    label="Resolution"
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                  >
                    {resolutions.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </Select>
                </div>
                {presetMotion ? (
                  <div>
                    <p className="option-label">MOTION</p>
                    <div className="chip-list" role="group" aria-label="Motion preset">
                      {motionPresets.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          className="chip"
                          aria-pressed={motionPreset === preset.id}
                          onClick={() => setMotionPreset(preset.id)}
                        >
                          {preset.name}
                        </button>
                      ))}
                    </div>
                    <div className="field-hint mt-2">
                      {motionPresets.find((preset) => preset.id === motionPreset)?.description}{" "}
                      Movement is kept restrained to reduce changes to the garment; it is not
                      eliminated.
                    </div>
                  </div>
                ) : (
                  <Input
                    label="Motion direction (optional)"
                    value={motion}
                    onChange={(e) => setMotion(e.target.value)}
                    placeholder="e.g. A gentle turn toward the camera"
                    maxLength={180}
                    hint="Keep it short. Leave blank to let the provider plan natural motion."
                  />
                )}
                <AiDisclosure video />
              </div>
            ) : (
              <>
                <p className="option-label">CREATIVE DIRECTION</p>
                <div className="chip-list" role="group" aria-label="Creative direction">
                  {directions.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="chip"
                      aria-pressed={direction === item.id}
                      onClick={() => setDirection(item.id)}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
                <div className="field-hint mt-2 mb-4">
                  {directions.find((item) => item.id === direction)?.description} These are written
                  directions for the same image model, not different models.
                </div>
                {direction !== "faithful" && direction !== "product" && (
                  <>
                    <p className="field-hint mb-3">
                      Choose the surroundings. Your original garment stays the source of truth.
                    </p>
                    <div className="scene-grid">
                      {scenes.map(({ name, icon: Icon, style }, i) => (
                        <button
                          key={name}
                          className="scene-option"
                          aria-pressed={scene === i}
                          onClick={() => setScene(i)}
                        >
                          <div className={`scene-swatch swatch-${style}`}>
                            <Icon size={28} />
                          </div>
                          {scene === i && <Check size={15} className="selection-check" />}
                          <span>{name}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {direction !== "product" && (
                  <>
                    <p className="option-label">MODEL DIRECTION</p>
                    <div className="chip-list">
                      {[
                        "Adult woman, editorial fashion model",
                        "Adult man, editorial fashion model",
                        "Adult androgynous fashion model",
                      ].map((v, i) => (
                        <button
                          key={v}
                          className="chip"
                          aria-pressed={model === v}
                          onClick={() => setModel(v)}
                        >
                          {["Feminine", "Masculine", "Androgynous"][i]}
                        </button>
                      ))}
                    </div>
                    <p className="option-label">POSE & PRESENTATION</p>
                    <div className="chip-list">
                      {[
                        "Relaxed standing pose",
                        "Three-quarter editorial pose",
                        "Walking naturally",
                      ].map((v) => (
                        <button
                          key={v}
                          className="chip"
                          aria-pressed={pose === v}
                          onClick={() => setPose(v)}
                        >
                          {v.replace(" pose", "")}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <div className="mt-5">
                  <Notice>
                    These settings guide the model and scene. Colour, print and construction should
                    follow your uploaded garment.
                  </Notice>
                </div>
              </>
            )}
          </section>
          {!video && (
            <section className="panel studio-step">
              <div className="step-heading">
                <span className="step-num">03</span>
                <h2>Frame your photograph</h2>
              </div>
              <div className="form-grid">
                {data.provider?.id === "huggingface" ? (
                  <label className="field">
                    Composition
                    <div className="input flex items-center justify-between">
                      <span>Follows your garment photo</span>
                      <Check size={13} className="text-secondary" />
                    </div>
                    <span className="field-hint">
                      The image-editing model keeps the shape of the source photograph
                    </span>
                  </label>
                ) : (
                  <Select
                    label="Composition"
                    value={ratio}
                    onChange={(e) => setRatio(e.target.value)}
                  >
                    <option value="3:4">Portrait · 3:4</option>
                    <option value="4:5">Social portrait · 4:5</option>
                    <option value="1:1">Square · 1:1</option>
                    <option value="9:16">Story · 9:16</option>
                    <option value="16:9">Landscape · 16:9</option>
                  </Select>
                )}
                <label className="field">
                  Image quality
                  <div className="input flex items-center justify-between">
                    <span>
                      {data.provider?.id === "qwen" ? "Image edit · 1K target" : "Balanced · 1K"}
                    </span>
                    <Check size={13} className="text-secondary" />
                  </div>
                  <span className="field-hint">One image per request</span>
                </label>
              </div>
            </section>
          )}
        </div>
        <aside className="studio-preview panel panel-padded">
          <div className="panel-heading">
            <h2>Your creative canvas</h2>
            <span className="text-[9px] muted">{video ? "START FRAME" : "ORIGINAL GARMENT"}</span>
          </div>
          <div className="preview-canvas">
            <div className="preview-topline">
              <span>ATELIER AI / CREATIVE STUDIO</span>
              <span>{video ? `${duration}s` : `${ratio} FRAME`}</span>
            </div>
            {preview ? (
              <img
                src={preview}
                alt={
                  video ? "Selected source photograph" : "Original garment — generation has not run"
                }
              />
            ) : (
              <div className="preview-placeholder">
                <div className="empty-icon">
                  <Camera size={26} strokeWidth={1.2} />
                </div>
                <h3>
                  A world of possibility.
                  <br />
                  <em>One piece to begin.</em>
                </h3>
                <p>
                  {video
                    ? "Choose a photograph and imagine what a little motion could do."
                    : "Choose a garment to preview your source image here. Generated results appear after processing."}
                </p>
              </div>
            )}
          </div>
          <div className="cost-summary">
            <div>
              <span className="text-xs">A clear quote. Before you create.</span>
              <p className="mt-1">
                {data.balance.available} credits available · {data.balance.reserved} reserved
              </p>
            </div>
            <span className="mini-icon">
              <Sparkles size={17} strokeWidth={1.3} />
            </span>
          </div>
          {error && (
            <div className="mb-4">
              <Notice tone="error">{error}</Notice>
            </div>
          )}
          {running && (
            <div className="mb-4">
              <Notice tone="warning">
                A {video ? "film" : "photograph"} from this source is still being generated.{" "}
                <Link href={`/app/generations/${running.id}`}>Follow its progress</Link> before
                starting another, so free GPU quota isn’t spent twice.
              </Notice>
            </div>
          )}
          <Button
            className="w-full"
            busy={busy}
            disabled={!availability.enabled || Boolean(running) || Boolean(sourceWarning)}
            onClick={getQuote}
          >
            Review cost & create <ArrowRight size={15} />
          </Button>
          <div className="mt-4">
            <AiDisclosure video={video} />
          </div>
          <p className="text-[9px] muted text-center mt-4 flex items-center justify-center gap-1.5">
            <ShieldCheck size={11} />
            Your source images stay in private storage.
          </p>
        </aside>
      </div>
      {video && (
        <section className="panel panel-padded mt-7">
          <div className="panel-heading">
            <div>
              <h2>Your fashion films</h2>
              <p>A little movement, saved to your collection.</p>
            </div>
            <Button href="/app/gallery?type=video" size="small" variant="ghost">
              View gallery <ArrowUpRight size={13} />
            </Button>
          </div>
          {data.jobs.filter((j) => j.operation === "video").length ? (
            data.jobs
              .filter((j) => j.operation === "video")
              .map((j) => (
                <Link key={j.id} className="job-item" href={`/app/generations/${j.id}`}>
                  <Film size={16} />
                  <span>Fashion film</span>
                  <Badge>{jobStatusLabel(j)}</Badge>
                  <ArrowUpRight size={13} />
                </Link>
              ))
          ) : (
            <Empty
              title="Your collection in motion"
              description="Choose a photograph above to start your first fashion film."
              icon={<Film size={22} strokeWidth={1.3} />}
            />
          )}
        </section>
      )}
      <GarmentUpload open={upload} onOpenChange={setUpload} onCreated={(g) => setGarmentId(g.id)} />
      <Dialog
        open={review}
        onOpenChange={setReview}
        title={video ? "Let’s bring it to life." : "Ready for a new perspective?"}
        description="Review your creative direction and the charge before starting. This quote expires after ten minutes."
      >
        {quote && (
          <div className="form-stack">
            <div className="panel panel-padded bg-background">
              <div className="flex justify-between mb-3">
                <span className="muted text-xs">Source</span>
                <span className="text-xs">{video ? "Selected photograph" : garment?.name}</span>
              </div>
              <div className="flex justify-between mb-3">
                <span className="muted text-xs">Direction</span>
                <span className="text-xs">
                  {video
                    ? `${duration}s · ${resolution}${presetMotion ? ` · ${motionPresets.find((preset) => preset.id === motionPreset)?.name}` : ""}`
                    : directions.find((item) => item.id === direction)?.name}
                </span>
              </div>
              <div className="flex justify-between border-t border-border pt-4">
                <span>Reserved now</span>
                <strong>{quote.quote.credits} credits</strong>
              </div>
            </div>
            <Notice>
              Credits are reserved before the job starts, charged after the output is stored, and
              released for a failed job. You can close the browser while it processes.
            </Notice>
            {!quote.quote.sufficient && (
              <Notice tone="warning">
                You have {quote.quote.available} credits. Add credits before starting this request.
              </Notice>
            )}
            {acknowledgement && (
              <div className="panel panel-padded bg-background">
                <div className="text-xs mb-3">{data.provider?.disclosure}</div>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                  />
                  <span>
                    I understand that this photograph is processed by a third-party Hugging Face
                    Space and I have the rights to send it there.
                  </span>
                </label>
              </div>
            )}
            {error && <Notice tone="error">{error}</Notice>}
            <Button
              busy={busy}
              disabled={!quote.quote.sufficient || Boolean(acknowledgement && !acknowledged)}
              onClick={submit}
            >
              {video ? "Create fashion film" : "Create model photograph"}
              <Sparkles size={15} />
            </Button>
          </div>
        )}
      </Dialog>
    </>
  );
}
