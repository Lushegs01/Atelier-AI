"use client";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface Garment {
  id: string;
  name: string;
  category: string;
  description?: string;
  collection?: string;
  created_at: string;
  imageUrl?: string;
  assets?: Asset[];
  archived_at?: string;
}
export interface Asset {
  id: string;
  kind: string;
  garment_id?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  url?: string;
  imageUrl?: string;
  view?: string;
}
export interface Job {
  id: string;
  operation: string;
  status: string;
  created_at: string;
  garment_id?: string;
  estimated_credits?: number;
  reserved_credits?: number;
  error_message?: string;
  options?: Record<string, unknown>;
  provider_model?: string;
}
export interface Output {
  id: string;
  job_id?: string;
  asset_id?: string;
  url?: string;
  asset?: Asset;
  created_at?: string;
}
export interface LedgerEntry {
  id: string;
  kind?: string;
  entry_type?: string;
  amount?: number;
  available_delta?: number;
  reserved_delta?: number;
  credits?: number;
  created_at: string;
  description?: string;
}
export interface Payment {
  id: string;
  reference: string;
  amount_kobo: number;
  credits: number;
  status: string;
  created_at: string;
}
export interface Customer {
  id: string;
  name: string;
  email?: string;
  created_at: string;
}
export interface TryOnSession {
  id: string;
  garment_id: string;
  expires_at: string;
  revoked_at?: string;
  use_count?: number;
  uses?: number;
  max_uses?: number;
  created_at: string;
}
export interface Package {
  id: string;
  name: string;
  credits: number;
  amount_kobo: number;
}
export interface WorkspaceData {
  configured: boolean;
  organization: {
    id: string;
    name: string;
    brand_name?: string;
    brand_color?: string;
    daily_spending_limit?: number;
  } | null;
  user?: { id?: string; email?: string; fullName?: string; name?: string };
  role?: string;
  garments: Garment[];
  jobs: Job[];
  outputs: Output[];
  balance: { available: number; reserved: number };
  ledger: LedgerEntry[];
  payments: Payment[];
  customers: Customer[];
  tryOnSessions: TryOnSession[];
  packages: Package[];
  pagination?: { page: number; pageSize: number; hasMore: boolean };
  ai?: {
    provider: string;
    capabilities: {
      operation: string;
      enabled: boolean;
      lifecycle: string;
      supportedResolutions?: string[];
      supportedDurations?: number[];
    }[];
  };
}
const initial: WorkspaceData = {
  configured: false,
  organization: null,
  garments: [],
  jobs: [],
  outputs: [],
  balance: { available: 0, reserved: 0 },
  ledger: [],
  payments: [],
  customers: [],
  tryOnSessions: [],
  packages: [],
};
const WorkspaceContext = createContext<{
  data: WorkspaceData;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  page: number;
  setPage: (page: number) => void;
}>({
  data: initial,
  loading: true,
  error: "",
  refresh: async () => {},
  page: 1,
  setPage: () => {},
});
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const router = useRouter();
  const [page, setPage] = useState(1);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspace?page=${page}`, { cache: "no-store" });
      const next = await res.json();
      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      if (!res.ok) throw new Error(next.error || "Unable to load your workspace.");
      if (mounted.current) {
        setData({ ...initial, ...next, balance: next.balance || initial.balance });
        setError("");
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Unable to connect.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [page, router]);
  useEffect(() => {
    mounted.current = true;
    const bootstrap = setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      mounted.current = false;
      clearTimeout(bootstrap);
    };
  }, [refresh]);
  useEffect(() => {
    if (
      !data.jobs.some((j) =>
        ["queued", "submitting", "processing", "retry_wait"].includes(j.status),
      )
    )
      return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 8000);
    return () => clearInterval(timer);
  }, [data.jobs, refresh]);
  return (
    <WorkspaceContext.Provider value={{ data, loading, error, refresh, page, setPage }}>
      {children}
    </WorkspaceContext.Provider>
  );
}
export const useWorkspace = () => useContext(WorkspaceContext);

export async function apiRequest<T = Record<string, unknown>>(
  url: string,
  method = "POST",
  body?: unknown,
): Promise<T> {
  const multipart = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: multipart ? undefined : { "Content-Type": "application/json" },
    body: body ? (multipart ? body : JSON.stringify(body)) : undefined,
  });
  const data = await res.json();
  if (!res.ok)
    throw new Error(data.error || "We couldn’t complete that request. Please try again.");
  return data as T;
}
