"use client";

import Link from "next/link";
import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  type ReactNode,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
} from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { X, Check, AlertCircle, Loader2, ImagePlus, UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "small" | "icon";
  href?: string;
  busy?: boolean;
};
export function Button({
  variant = "primary",
  size,
  href,
  children,
  className,
  busy,
  ...props
}: ButtonProps) {
  const styles = cn("btn", `btn-${variant}`, size && `btn-${size}`, className);
  if (href)
    return (
      <Link className={styles} href={href}>
        {children}
      </Link>
    );
  return (
    <button className={styles} disabled={busy || props.disabled} {...props}>
      {busy && <Loader2 size={15} className="animate-spin" />}
      {children}
    </button>
  );
}
export function Input({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="field">
      {label}
      <input {...props} className={cn("input", props.className)} />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
export function Select({
  label,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <label className="field">
      {label}
      <select {...props} className={cn("input", props.className)}>
        {children}
      </select>
    </label>
  );
}
export function Badge({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "success" | "warning" | "error";
}) {
  return <span className={cn("badge", tone !== "default" && `badge-${tone}`)}>{children}</span>;
}
export function Notice({ children, tone }: { children: ReactNode; tone?: "warning" | "error" }) {
  return (
    <div
      className={cn("notice", tone && `notice-${tone}`)}
      role={tone === "error" ? "alert" : "status"}
    >
      <AlertCircle size={15} />
      <div>{children}</div>
    </div>
  );
}
export function Empty({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon || <ImagePlus size={22} strokeWidth={1.5} />}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content className="dialog-content">
          <DialogPrimitive.Title className="dialog-title">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="dialog-description">
            {description}
          </DialogPrimitive.Description>
          <DialogPrimitive.Close className="dialog-close" aria-label="Close dialog">
            <X size={16} />
          </DialogPrimitive.Close>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
export function Tooltip({ children, text }: { children: ReactNode; text: string }) {
  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content className="tooltip" sideOffset={6}>
            {text}
            <TooltipPrimitive.Arrow />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
const ToastContext = createContext<(message: string, error?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function notify(message: string, error?: boolean) {
    if (timer.current) clearTimeout(timer.current);
    setToast({ message, error });
    timer.current = setTimeout(() => setToast(null), 6000);
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <ToastContext.Provider value={notify}>
      {children}
      {toast && (
        <div className={cn("toast", toast.error && "toast-error")} role="status">
          {toast.error ? <AlertCircle size={18} /> : <Check size={18} />}
          <span>{toast.message}</span>
          <button
            className="btn btn-ghost btn-icon"
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);

export function FileUpload({
  onFile,
  preview,
  accept = "image/jpeg,image/png,image/webp",
  label = "Drop your garment photo here",
}: {
  onFile: (file: File) => void;
  preview?: string;
  accept?: string;
  label?: string;
}) {
  const [drag, setDrag] = useState(false);
  const notify = useToast();
  function choose(file?: File) {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      return notify("Choose a JPEG, PNG or WebP image.", true);
    if (file.size > 4194304) return notify("This image is too large. The limit is 4 MB.", true);
    onFile(file);
  }
  return (
    <div>
      {preview && (
        <div className="upload-preview mb-3">
          {/* Local blob and authorized signed URLs must not pass through a public optimizer. */}
          <img src={preview} alt="Selected image preview" />
        </div>
      )}
      <label
        className={cn("upload-zone", drag && "dragging")}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          choose(e.dataTransfer.files[0]);
        }}
      >
        <UploadCloud size={26} strokeWidth={1.3} />
        <strong>{preview ? "Choose a different photograph" : label}</strong>
        <small>or browse files · JPG, PNG, WebP · up to 4 MB</small>
        <input
          type="file"
          aria-label="Upload photograph"
          accept={accept}
          onChange={(e) => choose(e.target.files?.[0])}
        />
      </label>
    </div>
  );
}
