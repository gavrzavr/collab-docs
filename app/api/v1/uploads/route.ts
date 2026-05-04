import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { put } from "@vercel/blob";
import sharp from "sharp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// 30s should be plenty for sharp on a single 1-2MB image.
export const maxDuration = 30;

const WS_API_URL =
  process.env.WS_API_URL ||
  process.env.NEXT_PUBLIC_WS_URL?.replace("wss://", "https://").replace("ws://", "http://") ||
  "http://localhost:1234";

// Server-side cap. Client is expected to compress before upload (canvas
// API → ~200-500KB), but we accept up to 4MB as a defense buffer in
// case client compression fails or is bypassed. Vercel Hobby plan's
// 4.5MB body cap is the hard ceiling here; staying under is essential.
const MAX_INPUT_BYTES = 4 * 1024 * 1024;

// Output cap after sharp re-compression. Anything larger means input
// was a strange edge case (huge transparent PNG?) — bail rather than
// store something abnormally big.
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

// Magic byte signatures for whitelisted formats. We don't trust the
// browser-supplied Content-Type; checking the bytes themselves prevents
// "rename .exe to .png" tricks.
function detectMime(buf: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  )
    return "image/png";
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return "image/webp";
  return null;
}

/**
 * POST /api/v1/uploads — image upload.
 *
 * Pipeline:
 *   1. Auth via NextAuth session (anonymous = 401)
 *   2. Read multipart form-data: file + doc_id
 *   3. Magic-byte validation: PNG / JPEG / WebP only (no GIF, no SVG)
 *   4. Size cap: 4MB input (client should already have compressed)
 *   5. sharp pipeline (defense-in-depth even if client compressed):
 *        rotate (auto, from EXIF) → resize fit:inside 1920×1920 →
 *        WebP q82 → strip EXIF
 *   6. Output cap: 2MB
 *   7. Upload to Vercel Blob via put()
 *   8. Forward (blob_url, doc_id, user_email, size, mime) to ws-server
 *      for SQLite tracking (orphan-GC, abuse observability)
 *   9. Return { url } to client; BlockNote stores it on the image block
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return Response.json({ error: "Sign in to upload images." }, { status: 401 });
  }
  const internalSecret = process.env.INTERNAL_SECRET;
  if (!internalSecret) {
    return Response.json({ error: "Server is not configured to track uploads" }, { status: 500 });
  }
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    return Response.json(
      { error: "Image storage is not configured (BLOB_READ_WRITE_TOKEN missing)" },
      { status: 503 }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  const docId = form.get("doc_id");
  if (!(file instanceof File)) {
    return Response.json({ error: "Missing 'file' field" }, { status: 400 });
  }
  if (typeof docId !== "string" || !docId) {
    return Response.json({ error: "Missing 'doc_id' field" }, { status: 400 });
  }
  if (file.size > MAX_INPUT_BYTES) {
    return Response.json(
      { error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 4MB after client compression.` },
      { status: 413 }
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const inputBuf = Buffer.from(arrayBuffer);
  const detectedMime = detectMime(inputBuf);
  if (!detectedMime) {
    return Response.json(
      { error: "Unsupported image format. Allowed: PNG, JPEG, WebP." },
      { status: 415 }
    );
  }

  // sharp pipeline. .rotate() before .resize() applies the EXIF
  // orientation tag, then strips it (default behaviour). Fit "inside"
  // preserves aspect ratio and never upscales.
  let outputBuf: Buffer;
  let outWidth = 0;
  let outHeight = 0;
  try {
    const result = await sharp(inputBuf)
      .rotate()
      .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    outputBuf = result.data;
    outWidth = result.info.width;
    outHeight = result.info.height;
  } catch (err) {
    console.error("[uploads] sharp failed:", err);
    return Response.json(
      { error: "Couldn't process image — file may be corrupt." },
      { status: 422 }
    );
  }
  if (outputBuf.length > MAX_OUTPUT_BYTES) {
    return Response.json(
      { error: "Image is too complex to compress under our limit. Try a simpler image or a screenshot." },
      { status: 413 }
    );
  }

  // Upload to Vercel Blob. addRandomSuffix gives us collision-free
  // filenames without leaking the user's chosen name.
  let blobUrl: string;
  try {
    // Convention: organize blobs under doc_id/ for human-readable
    // diagnostics in the Vercel dashboard. Path doesn't affect access.
    const blobPath = `uploads/${docId}/${Date.now()}.webp`;
    const result = await put(blobPath, outputBuf, {
      access: "public",
      contentType: "image/webp",
      addRandomSuffix: true,
      token: blobToken,
    });
    blobUrl = result.url;
  } catch (err) {
    console.error("[uploads] vercel blob put failed:", err);
    return Response.json(
      { error: "Couldn't store image. Please try again." },
      { status: 502 }
    );
  }

  // Track in SQLite via ws-server. Failure here doesn't fail the
  // upload (the blob is stored), but we log it because the image
  // becomes invisible to orphan-GC.
  try {
    await fetch(`${WS_API_URL}/api/uploads/track`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": internalSecret,
      },
      body: JSON.stringify({
        blob_url: blobUrl,
        doc_id: docId,
        user_email: email,
        size: outputBuf.length,
        mime: "image/webp",
      }),
    });
  } catch (err) {
    console.error("[uploads] ws-server track failed (blob still stored):", err);
  }

  return Response.json({
    url: blobUrl,
    width: outWidth,
    height: outHeight,
    size: outputBuf.length,
  });
}
