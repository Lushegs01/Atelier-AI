"use client";
import { useEffect, useState } from "react";
import { Check, ArrowUpRight } from "lucide-react";
import { Button, Empty } from "@/components/ui";
import { currency } from "@/lib/utils";
export interface CreditPackage { id: string; name: string; credits: number; amount_kobo: number; active?: boolean }
export function Pricing({ packages: provided, onBuy }: { packages?: CreditPackage[]; onBuy?: (id: string) => void }) {
  const [packages, setPackages] = useState<CreditPackage[]>(provided || []);
  const [loading, setLoading] = useState(!provided);
  useEffect(() => {
    if (provided) return;
    fetch("/api/pricing").then((res) => res.json()).then((data) => setPackages(data.packages || [])).catch(() => {}).finally(() => setLoading(false));
  }, [provided]);
  if (loading) return <div className="price-grid" aria-label="Loading credit bundles">{[1,2,3].map(i=><div key={i} className="skeleton h-72" />)}</div>;
  if (!packages.length) return <div className="panel"><Empty title="A little preparation before your first campaign" description="Credit bundles appear here once the workspace’s billing catalog is configured. Create your account and explore the studio in the meantime." action={<Button href={onBuy ? "/app/studio" : "/signup"}>{onBuy ? "Go to the studio" : "Create your workspace"}<ArrowUpRight size={15} /></Button>} /></div>;
  return <><div className="price-grid">{packages.map((pack,i)=><div key={pack.id} className={`price-card panel ${i===1?"featured":""}`}><span className="eyebrow">{i===1?"Room for a collection":"Create at your pace"}</span><h3>{pack.name}</h3><p className="muted text-xs">{pack.credits.toLocaleString()} prepaid credits</p><p className="price-amount">{currency(pack.amount_kobo)}</p><ul><li><Check size={13} />One secure workspace</li><li><Check size={13} />Pay only for completed generations</li><li><Check size={13} />Private garment and content library</li></ul>{onBuy ? <Button onClick={()=>onBuy(pack.id)} className="w-full">Buy credits <ArrowUpRight size={14} /></Button> : <Button href="/signup" className="w-full">Start your collection <ArrowUpRight size={14} /></Button>}</div>)}</div><p className="muted text-xs mt-5">Generation prices are quoted in the studio before each request. Credits are reserved during processing; failed jobs release the reservation. AI capabilities are enabled separately after provider verification.</p></>;
}
