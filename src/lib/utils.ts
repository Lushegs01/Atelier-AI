import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export const currency = (kobo: number) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(kobo / 100);
export const dateLabel = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Africa/Lagos" }).format(
    new Date(date),
  );
