import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins conditional classes and lets the last Tailwind utility touching the same property win. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
