"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Shirt, Plus, Search, ArrowUpRight, Archive, Trash2, Camera, Check } from "lucide-react";
import {
  Button,
  Dialog,
  Empty,
  Input,
  Select,
  FileUpload,
  Notice,
  Badge,
  useToast,
} from "@/components/ui";
import { PageHeading, Onboarding, SetupNotice } from "./common";
import { apiRequest, useWorkspace, type Garment, type Asset } from "./context";
import { dateLabel } from "@/lib/utils";
export function GarmentUpload({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (garment: Garment) => void;
}) {
  const { data, refresh } = useWorkspace();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const notify = useToast();
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);
  function chooseFile(nextFile: File) {
    setFile(nextFile);
    setPreview(URL.createObjectURL(nextFile));
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!file) return setError("Choose a photograph of your garment.");
    if (!data.organization)
      return setError("Create your workspace and connect storage before uploading.");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    form.set("file", file);
    form.set("organizationId", data.organization.id);
    try {
      const result = await apiRequest<{ garment: Garment }>("/api/garments", "POST", form);
      await refresh();
      onCreated?.(result.garment);
      onOpenChange(false);
      setFile(null);
      setPreview("");
      notify("Your garment is safely in your library.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Make room for a new piece"
      description="Start with a clear photograph. Your original stays private and separate from generated content."
    >
      <form className="form-stack" onSubmit={save}>
        <FileUpload onFile={chooseFile} preview={preview} />
        <Notice>
          For the most faithful results: photograph the whole garment, evenly lit, against a plain
          background, with its edges clearly visible and nothing covering it. Front, mannequin,
          hanger and flat-lay views are used for generation; back, side and detail views stay as
          references. JPEG, PNG or WebP, at least 256 px per side. Photos are never cropped to fit a
          model; unsuitable shapes are refused with an explanation instead.
        </Notice>
        <Input
          label="Garment name"
          name="name"
          placeholder="e.g. The Sunday dress"
          required
          minLength={2}
          maxLength={120}
        />
        <div className="form-grid">
          <Select label="Category" name="category">
            <option value="dress">Dress</option>
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
            <option value="outerwear">Outerwear</option>
            <option value="accessory">Accessory</option>
            <option value="other">Other</option>
          </Select>
          <Select label="Photograph view" name="view">
            <option value="front">Front</option>
            <option value="back">Back</option>
            <option value="side">Side</option>
            <option value="detail">Detail / embroidery</option>
            <option value="mannequin">Mannequin</option>
            <option value="hanger">Hanger</option>
            <option value="flat-lay">Flat lay</option>
          </Select>
        </div>
        <label className="field">
          A little about this piece <span className="muted font-normal">(optional)</span>
          <textarea
            name="description"
            maxLength={1200}
            className="input min-h-20"
            placeholder="Fabric, silhouette, details worth preserving…"
          />
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" busy={busy}>
          <Plus size={15} />
          Save to garment library
        </Button>
      </form>
    </Dialog>
  );
}
export function GarmentsPage() {
  const { data, loading } = useWorkspace();
  const params = useSearchParams();
  const [search, setSearch] = useState(params.get("q") || "");
  const [category, setCategory] = useState("all");
  const [upload, setUpload] = useState(false);
  const garments = data.garments.filter(
    (g) =>
      (!search ||
        `${g.name} ${g.description || ""} ${g.collection || ""}`
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (category === "all" || g.category === category),
  );
  return (
    <>
      <PageHeading
        title="Your garment library"
        description="The pieces you make. The details that make them yours."
        action={
          <Button onClick={() => setUpload(true)}>
            <Plus size={15} />
            Add a garment
          </Button>
        }
      />
      <SetupNotice />
      <Onboarding />
      <div className="toolbar">
        <label className="search-box">
          <Search size={15} />
          <input
            aria-label="Search garments"
            placeholder="Find a piece in your collection…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="chip-list" aria-label="Filter by category">
          {["all", "dress", "top", "outerwear"].map((c) => (
            <button
              key={c}
              className="chip capitalize"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
            >
              {c === "all" ? "All garments" : c === "dress" ? "Dresses" : c}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="asset-grid">
          {[1, 2, 3].map((i) => (
            <div className="skeleton skeleton-card" key={i} />
          ))}
        </div>
      ) : garments.length ? (
        <div className="asset-grid">
          {garments.map((g) => (
            <Link key={g.id} href={`/app/garments/${g.id}`} className="asset-card panel">
              <div className="asset-image">
                {g.imageUrl ? (
                  <img src={g.imageUrl} alt={g.name} loading="lazy" />
                ) : (
                  <Shirt size={30} strokeWidth={1} />
                )}
                {g.archived_at && (
                  <span className="absolute top-3 left-3">
                    <Badge>Archived</Badge>
                  </span>
                )}
              </div>
              <div className="asset-info">
                <h3>{g.name}</h3>
                <div className="flex items-center justify-between">
                  <small className="capitalize">
                    {g.category}
                    {g.collection ? ` · ${g.collection}` : ""}
                  </small>
                  <ArrowUpRight size={14} className="muted" />
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            title={search ? "No pieces found" : "Your next campaign starts with one piece"}
            description={
              search
                ? "Try a different name or category."
                : "Add a clear photograph of a garment you’ve made. Build your collection one piece at a time."
            }
            icon={<Shirt size={24} strokeWidth={1.3} />}
            action={
              <Button
                onClick={() => (search ? (setSearch(""), setCategory("all")) : setUpload(true))}
                variant="secondary"
              >
                <Plus size={14} />
                {search ? "Clear filters" : "Add your first garment"}
              </Button>
            }
          />
        </div>
      )}
      <GarmentUpload open={upload} onOpenChange={setUpload} />
    </>
  );
}
export function GarmentDetail({ id }: { id: string }) {
  const router = useRouter();
  const { data, refresh } = useWorkspace();
  const garment = data.garments.find((g) => g.id === id);
  const [remote, setRemote] = useState<Garment | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState(false);
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newFile, setNewFile] = useState<File | null>(null);
  const notify = useToast();
  useEffect(() => {
    fetch(`/api/garments/${id}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        const first = (j.assets || []).find((asset: Asset) =>
          ["original", "garment_original"].includes(asset.kind),
        );
        if (first) {
          const mediaResponse = await fetch(`/api/assets/${first.id}`, { cache: "no-store" });
          if (mediaResponse.ok) j.garment.imageUrl = (await mediaResponse.json()).url;
        }
        setRemote(j.garment);
        setAssets(j.assets || []);
      })
      .catch((c) => setError(c.message));
  }, [id]);
  const g = remote || garment;
  if (!g)
    return (
      <>
        <PageHeading title="Garment details" description="Every detail, kept together." />
        {error ? <Notice tone="error">{error}</Notice> : <div className="skeleton h-96" />}
      </>
    );
  return (
    <>
      <PageHeading
        title={g.name}
        description={`${g.category} · Added ${dateLabel(g.created_at)}`}
        action={
          <Button href={`/app/studio?garment=${g.id}`}>
            <Camera size={15} />
            Create a photoshoot
          </Button>
        }
      />
      <div className="studio-layout">
        <div className="panel overflow-hidden">
          <div className="asset-image !aspect-[4/5]">
            {g.imageUrl ? <img src={g.imageUrl} alt={`Original ${g.name}`} /> : <Shirt size={40} />}
          </div>
          <p className="p-4 text-[10px] muted">ORIGINAL GARMENT · PRIVATE SOURCE IMAGE</p>
        </div>
        <div className="form-stack">
          <div className="panel panel-padded">
            <h2 className="text-xl mb-4">A closer look</h2>
            <p className="muted text-sm mb-5">
              {g.description ||
                "Add a description to keep track of this garment’s construction, fabric and details."}
            </p>
            <dl className="text-xs space-y-3 mb-6">
              <div className="flex justify-between">
                <dt className="muted">Collection</dt>
                <dd>{g.collection || "Unassigned"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="muted">Source views</dt>
                <dd>{assets.length || g.assets?.length || 0}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="muted">Status</dt>
                <dd>{g.archived_at ? "Archived" : "Active"}</dd>
              </div>
            </dl>
            <div className="button-row">
              <Button variant="secondary" onClick={() => setEdit(true)} size="small">
                Edit details
              </Button>
              <Button
                variant="ghost"
                size="small"
                onClick={async () => {
                  try {
                    await apiRequest(`/api/garments/${id}`, "PATCH", { archived: !g.archived_at });
                    await refresh();
                    notify(g.archived_at ? "Garment restored." : "Garment archived.");
                  } catch (c) {
                    notify(c instanceof Error ? c.message : "Update failed", true);
                  }
                }}
              >
                <Archive size={14} />
                {g.archived_at ? "Restore" : "Archive"}
              </Button>
              <Button
                variant="danger"
                size="small"
                onClick={() => setRemove(true)}
                aria-label="Delete garment"
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
          <div className="panel panel-padded">
            <h2 className="text-lg mb-3">Build a fuller picture</h2>
            <p className="muted text-xs mb-5">
              Add back, side or embroidery views. The studio uses only views supported by the
              selected workflow.
            </p>
            <form
              className="form-stack"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newFile) return notify("Choose an image first.", true);
                setBusy(true);
                const form = new FormData(e.currentTarget);
                form.set("file", newFile);
                try {
                  await apiRequest(`/api/garments/${id}`, "POST", form);
                  await refresh();
                  notify("New view added.");
                  setNewFile(null);
                } catch (c) {
                  notify(c instanceof Error ? c.message : "Upload failed", true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <FileUpload onFile={setNewFile} />
              <Select label="View" name="view">
                {["front", "back", "side", "detail", "mannequin", "hanger", "flat-lay"].map((v) => (
                  <option value={v} key={v}>
                    {v}
                  </option>
                ))}
              </Select>
              <Button variant="secondary" busy={busy} type="submit">
                <Plus size={14} />
                Add this view
              </Button>
            </form>
          </div>
        </div>
      </div>
      <section className="panel panel-padded mt-6">
        <h2 className="text-xl mb-4">Created with this piece</h2>
        {data.jobs.some((j) => j.garment_id === id) ? (
          data.jobs
            .filter((j) => j.garment_id === id)
            .map((j) => (
              <Link key={j.id} href={`/app/generations/${j.id}`} className="job-item">
                <Camera size={16} />
                <span className="capitalize">{j.operation}</span>
                <Badge>{j.status}</Badge>
                <ArrowUpRight size={13} />
              </Link>
            ))
        ) : (
          <Empty
            title="A story waiting to happen"
            description="Create a photoshoot to see this piece in a new setting."
            action={
              <Button href={`/app/studio?garment=${id}`} variant="secondary">
                Open creative studio
              </Button>
            }
          />
        )}
      </section>
      <Dialog
        open={edit}
        onOpenChange={setEdit}
        title="The details of your piece"
        description="These details describe your original garment; they don’t modify its appearance."
      >
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const form = new FormData(e.currentTarget);
            try {
              await apiRequest(`/api/garments/${id}`, "PATCH", Object.fromEntries(form));
              await refresh();
              setEdit(false);
              notify("Garment details updated.");
            } catch (c) {
              notify(c instanceof Error ? c.message : "Update failed", true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input label="Name" name="name" defaultValue={g.name} required />
          <Input label="Collection" name="collection" defaultValue={g.collection} maxLength={100} />
          <label className="field">
            Description
            <textarea
              className="input"
              name="description"
              defaultValue={g.description}
              maxLength={1200}
            />
          </label>
          <Button busy={busy} type="submit">
            Save details <Check size={14} />
          </Button>
        </form>
      </Dialog>
      <Dialog
        open={remove}
        onOpenChange={setRemove}
        title="Delete this garment?"
        description="Its original photographs will be removed from private storage. Existing generation and financial records remain for accounting. This cannot be undone."
      >
        <Button
          variant="danger"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await apiRequest(`/api/garments/${id}`, "DELETE");
              await refresh();
              router.push("/app/garments");
            } catch (c) {
              notify(c instanceof Error ? c.message : "Delete failed", true);
              setBusy(false);
            }
          }}
        >
          Delete garment and source photos
        </Button>
      </Dialog>
    </>
  );
}
