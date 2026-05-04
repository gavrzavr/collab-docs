"use client";

/**
 * Client-side image compression + upload helpers.
 *
 * Why compress on the client:
 *   - Vercel Hobby has a 4.5 MB request body cap. A typical phone
 *     photo is 4-8 MB straight off the camera; without compression,
 *     uploads of >4.5 MB fail at the platform level.
 *   - Compressing first means the user uploads ~200-400 KB instead of
 *     megabytes — much faster perceived UX.
 *
 * Why STILL re-compress on the server:
 *   - Client-side can be bypassed (curl, dev tools). Server-side sharp
 *     in /api/v1/uploads is the trusted gate — strips EXIF, enforces
 *     dimensions, and re-encodes to WebP regardless of what the client
 *     sent.
 *
 * The pipeline here matches the server pipeline (1920px max, WebP q82)
 * so most of the time the server's sharp pass is a no-op — the bytes
 * are already correctly sized and formatted.
 */

const ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_DIM = 1920;
const WEBP_QUALITY = 0.82;
// Hard input cap on the client. Anything larger is almost certainly
// not what the user meant to attach (multi-frame TIFF, panorama, etc.).
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

function readImageBitmap(file: File): Promise<ImageBitmap> {
  // createImageBitmap is widely supported and avoids the data-URL
  // round-trip of the older Image+canvas approach.
  return createImageBitmap(file, { imageOrientation: "from-image" });
}

async function compressToWebp(file: File): Promise<Blob> {
  const bmp = await readImageBitmap(file);
  let { width, height } = bmp;
  // Resize fit:inside, never upscaling.
  if (width > MAX_DIM || height > MAX_DIM) {
    if (width >= height) {
      height = Math.round((height * MAX_DIM) / width);
      width = MAX_DIM;
    } else {
      width = Math.round((width * MAX_DIM) / height);
      height = MAX_DIM;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't get 2D context");
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("toBlob returned null"));
      },
      "image/webp",
      WEBP_QUALITY
    );
  });
}

/**
 * Compress + upload one image. Returns the final blob URL stored in
 * Vercel Blob, ready for use as the `url` prop on a BlockNote image
 * block. Throws on validation failure or network error — the caller
 * (typically the BlockNote uploadFile callback) is responsible for
 * surfacing the error to the user (alert / toast).
 */
export async function uploadImage(file: File, docId: string): Promise<string> {
  if (!ALLOWED_MIMES.has(file.type)) {
    throw new Error(
      `Unsupported image format (${file.type || "unknown"}). Allowed: PNG, JPEG, WebP. GIFs aren't supported yet.`
    );
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error(
      `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 20 MB before compression.`
    );
  }

  let compressed: Blob;
  try {
    compressed = await compressToWebp(file);
  } catch (err) {
    throw new Error(
      `Couldn't compress image (${err instanceof Error ? err.message : String(err)}). Try a different file.`
    );
  }

  const form = new FormData();
  form.append("file", compressed, "upload.webp");
  form.append("doc_id", docId);

  const res = await fetch("/api/v1/uploads", {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { url: string };
  if (!data.url) throw new Error("Upload succeeded but server returned no URL");
  return data.url;
}
