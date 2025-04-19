// File: frontend_app/lib/utils.ts
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (!+bytes) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
  if (bytes > 0 && bytes < 1) return `${bytes.toFixed(dm)} Bytes`;
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const index = Math.min(i, sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, index)).toFixed(dm))} ${sizes[index]}`
}

// --- ADD THIS EXPORTED FUNCTION ---
export function formatDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || seconds < 0 || isNaN(seconds)) return 'N/A'; // Added NaN check
    if (seconds < 1) return "< 1s";

    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    let str = "";
    if (h > 0) str += `${h}h `;
    if (m > 0 || h > 0) str += `${m.toString().padStart(h > 0 ? 2 : 1, '0')}m `;
    // Pad seconds only if minutes or hours are present
    str += `${s.toString().padStart(str ? 2 : 1, '0')}s`;

    return str.trim() || '0s'; // Handle case where duration is exactly 0
}
// --- END ADDED FUNCTION ---
