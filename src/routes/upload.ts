import { Router, Request, Response } from "express";
import Busboy from "busboy";
import path from "path";
import { getToken, isTokenValid, markTokenUsed } from "../db";
import {
  uploadToS3,
  getPresignedPutUrl,
  initiateMultipartUpload,
  getPresignedPartUrls,
  completeMultipartUpload,
  abortMultipartUpload,
  MULTIPART_PART_SIZE,
} from "../s3";
import {
  notifyUpload,
  notifyUploadStarted,
  notifyUploadProgress,
  notifyUploadRetry,
  notifyUploadFailed,
  notifyUploadAborted,
} from "../telegram";

const router = Router();

// ── Progress throttle (avoid Telegram spam) ─────────────────────
// Only notify at 10%, 25%, 50%, 75%, 90% milestones
const notifiedMilestones = new Map<string, Set<number>>();
const MILESTONES = [10, 25, 50, 75, 90];

function shouldNotifyProgress(token: string, fileName: string, pct: number): boolean {
  const key = `${token}:${fileName}`;
  if (!notifiedMilestones.has(key)) notifiedMilestones.set(key, new Set());
  const seen = notifiedMilestones.get(key)!;
  for (const m of MILESTONES) {
    if (pct >= m && !seen.has(m)) {
      seen.add(m);
      return true;
    }
  }
  return false;
}

// ── Serve upload page ───────────────────────────────────────────

router.get("/u/:token", (req: Request, res: Response) => {
  const row = getToken(req.params.token as string);
  if (!row || !isTokenValid(row)) {
    res.sendFile(path.join(__dirname, "..", "public", "expired.html"));
    return;
  }
  res.sendFile(path.join(__dirname, "..", "public", "upload.html"));
});

// ── Token info ──────────────────────────────────────────────────

router.get("/api/token-info/:token", (req: Request, res: Response) => {
  const row = getToken(req.params.token as string);
  if (!row || !isTokenValid(row)) {
    res.status(403).json({ error: "Token expired or invalid" });
    return;
  }
  res.json({ label: row.label });
});

// ── Client event logging → Telegram ─────────────────────────────

router.post("/api/log-event/:token", async (req: Request, res: Response) => {
  const t = req.params.token as string;
  const row = getToken(t);
  if (!row) {
    res.status(404).json({ error: "Token not found" });
    return;
  }

  const { event, data } = req.body as {
    event: string;
    data: Record<string, any>;
  };
  const label = row.label;
  const ua = req.headers["user-agent"] || "unknown";

  console.log(`[LOG] token=${t.slice(0, 8)} event=${event}`, JSON.stringify(data));

  try {
    switch (event) {
      case "upload-started":
        await notifyUploadStarted(label, t, data.files || [], ua);
        break;

      case "progress": {
        const pct = data.pct || 0;
        if (shouldNotifyProgress(t, data.fileName || "", pct)) {
          await notifyUploadProgress(
            label, t, data.fileName || "unknown",
            pct, data.loaded || 0, data.total || 0
          );
        }
        break;
      }

      case "retry":
        await notifyUploadRetry(
          label, t, data.fileName || "unknown",
          data.attempt || 0, data.maxRetries || 20,
          data.error || "unknown error",
          data.partNum, data.loaded, data.total
        );
        break;

      case "failed":
        await notifyUploadFailed(label, t, data.fileName || "unknown", data.error || "unknown", {
          attempt: data.attempt,
          partNum: data.partNum,
          loaded: data.loaded,
          total: data.total,
          userAgent: ua,
          duration: data.duration,
        });
        break;

      case "aborted":
        await notifyUploadAborted(label, t, data.reason || "User aborted");
        break;

      default:
        console.log(`[LOG] Unknown event: ${event}`);
    }
  } catch (err) {
    console.error("[LOG] Failed to process event:", err);
  }

  res.json({ ok: true });
});

// ── Streaming multipart upload (server-side, legacy) ────────────

router.post("/api/upload/:token", (req: Request, res: Response) => {
  const t = req.params.token as string;
  const row = getToken(t);
  if (!row) {
    res.status(404).json({ error: "Token not found" });
    return;
  }
  if (!isTokenValid(row)) {
    res.status(403).json({ error: "Token expired or already used" });
    return;
  }

  const busboy = Busboy({
    headers: req.headers,
    limits: { fileSize: 1024 * 1024 * 1024 * 1024 },
  });

  const uploadedFiles: { name: string; size: number }[] = [];
  const uploadPromises: Promise<void>[] = [];

  busboy.on("file", (_fieldname, fileStream, info) => {
    const filename = info.filename;
    const mimeType = info.mimeType || "application/octet-stream";
    const s3Key = `uploads/${t}/${filename}`;
    let fileSize = 0;

    fileStream.on("data", (chunk: Buffer) => {
      fileSize += chunk.length;
    });

    const promise = uploadToS3(s3Key, fileStream, mimeType).then(() => {
      uploadedFiles.push({ name: filename, size: fileSize });
    });

    uploadPromises.push(promise);
  });

  busboy.on("finish", async () => {
    try {
      await Promise.all(uploadPromises);

      if (uploadedFiles.length === 0) {
        res.status(400).json({ error: "No files uploaded" });
        return;
      }

      markTokenUsed(t, uploadedFiles);
      await notifyUpload(row.label, t, uploadedFiles);

      res.json({ ok: true, files: uploadedFiles });
    } catch (err) {
      console.error("Upload error:", err);
      res.status(500).json({ error: "Upload failed" });
    }
  });

  busboy.on("error", (err: Error) => {
    console.error("Busboy error:", err);
    res.status(500).json({ error: "Upload processing failed" });
  });

  req.pipe(busboy);
});

// ── Presigned PUT URLs (small files, browser direct) ────────────

router.post(
  "/api/prepare-upload/:token",
  async (req: Request, res: Response) => {
    const t = req.params.token as string;
    const row = getToken(t);
    if (!row || !isTokenValid(row)) {
      res.status(403).json({ error: "Token expired or invalid" });
      return;
    }
    const { files } = req.body as {
      files: { name: string; type: string; size: number }[];
    };
    if (!files?.length) {
      res.status(400).json({ error: "files required" });
      return;
    }

    console.log(
      `[UPLOAD] Preparing direct PUT for ${files.length} files, token=${t.slice(0, 8)}, label=${row.label}`
    );

    const urls = await Promise.all(
      files.map(async (f) => {
        const key = `uploads/${t}/${f.name}`;
        const url = await getPresignedPutUrl(
          key,
          f.type || "application/octet-stream"
        );
        return { name: f.name, size: f.size, key, url };
      })
    );
    res.json({ uploads: urls });
  }
);

// ── S3 Multipart Upload (large files, browser chunked) ──────────

router.post(
  "/api/init-multipart/:token",
  async (req: Request, res: Response) => {
    const t = req.params.token as string;
    const row = getToken(t);
    if (!row || !isTokenValid(row)) {
      res.status(403).json({ error: "Token expired or invalid" });
      return;
    }

    const { name, type, size } = req.body as {
      name: string;
      type: string;
      size: number;
    };
    if (!name || !size) {
      res.status(400).json({ error: "name and size required" });
      return;
    }

    const key = `uploads/${t}/${name}`;
    const contentType = type || "application/octet-stream";
    const totalParts = Math.ceil(size / MULTIPART_PART_SIZE);

    console.log(
      `[UPLOAD] Initiating multipart: file=${name} size=${size} parts=${totalParts} token=${t.slice(0, 8)} label=${row.label}`
    );

    try {
      const { uploadId } = await initiateMultipartUpload(key, contentType);
      const partUrls = await getPresignedPartUrls(key, uploadId, totalParts);

      res.json({
        uploadId,
        key,
        totalParts,
        partSize: MULTIPART_PART_SIZE,
        partUrls,
      });
    } catch (err) {
      console.error("[UPLOAD] Multipart init failed:", err);
      res.status(500).json({ error: "Failed to initiate multipart upload" });
    }
  }
);

router.post(
  "/api/complete-multipart/:token",
  async (req: Request, res: Response) => {
    const t = req.params.token as string;
    const row = getToken(t);
    if (!row || !isTokenValid(row)) {
      res.status(403).json({ error: "Token expired or invalid" });
      return;
    }

    const { key, uploadId } = req.body as {
      key: string;
      uploadId: string;
    };
    if (!key || !uploadId) {
      res.status(400).json({ error: "key and uploadId required" });
      return;
    }

    console.log(
      `[UPLOAD] Completing multipart: key=${key} uploadId=${uploadId} token=${t.slice(0, 8)}`
    );

    try {
      await completeMultipartUpload(key, uploadId);
      res.json({ ok: true });
    } catch (err) {
      console.error("[UPLOAD] Multipart complete failed:", err);
      res.status(500).json({ error: "Failed to complete multipart upload" });
    }
  }
);

router.post(
  "/api/abort-multipart/:token",
  async (req: Request, res: Response) => {
    const t = req.params.token as string;
    const row = getToken(t);
    if (!row) {
      res.status(404).json({ error: "Token not found" });
      return;
    }

    const { key, uploadId, reason } = req.body as {
      key: string;
      uploadId: string;
      reason?: string;
    };
    if (!key || !uploadId) {
      res.status(400).json({ error: "key and uploadId required" });
      return;
    }

    console.log(
      `[UPLOAD] Aborting multipart: key=${key} reason=${reason || "unknown"}`
    );

    try {
      await abortMultipartUpload(key, uploadId);
      await notifyUploadAborted(row.label, t, reason || "Client aborted");
      res.json({ ok: true });
    } catch (err) {
      console.error("[UPLOAD] Multipart abort failed:", err);
      res.status(500).json({ error: "Failed to abort multipart upload" });
    }
  }
);

// ── Preview link ────────────────────────────────────────────────

router.get("/preview/:token/:filename", async (req: Request, res: Response) => {
  const t = req.params.token as string;
  const filename = decodeURIComponent(req.params.filename as string);
  const row = getToken(t);

  if (!row || row.used_at === null) {
    res.status(403).json({ error: "Token not found or not used" });
    return;
  }

  const hvApiUrl = process.env.HV_URL
    ? `${process.env.HV_URL}/api/internal/preview`
    : null;
  const hvSecret = process.env.HV_INTERNAL_SECRET;

  if (!hvApiUrl || !hvSecret) {
    res.status(500).json({ error: "Preview service not configured" });
    return;
  }

  try {
    const hvRes = await fetch(hvApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": hvSecret,
      },
      body: JSON.stringify({
        label: row.label,
        file_paths: [`s3://micalis/uploads/${t}/${filename}`],
      }),
    });

    if (!hvRes.ok) {
      console.error("Histoview API error:", await hvRes.text());
      res.status(500).json({ error: "Failed to generate preview" });
      return;
    }

    const data = (await hvRes.json()) as { url: string };
    res.redirect(data.url);
  } catch (err) {
    console.error("Preview generation error:", err);
    res.status(500).json({ error: "Preview generation failed" });
  }
});

// ── Complete upload (called after browser finishes S3 upload) ───

router.post(
  "/api/complete-upload/:token",
  async (req: Request, res: Response) => {
    const t = req.params.token as string;
    const row = getToken(t);
    if (!row || !isTokenValid(row)) {
      res.status(403).json({ error: "Token expired or invalid" });
      return;
    }
    const { files } = req.body as {
      files: { name: string; size: number }[];
    };
    if (!files?.length) {
      res.status(400).json({ error: "files required" });
      return;
    }

    console.log(
      `[UPLOAD] Complete: ${files.length} files, token=${t.slice(0, 8)}, label=${row.label}`
    );

    let hvUrl: string | undefined;
    const hvApiUrl = process.env.HV_URL
      ? `${process.env.HV_URL}/api/internal/preview`
      : null;
    const hvSecret = process.env.HV_INTERNAL_SECRET;

    if (hvApiUrl && hvSecret) {
      try {
        const viewableExts = [".czi", ".tif", ".tiff", ".ndpi", ".mrxs"];
        const viewableFiles = files.filter((f) =>
          viewableExts.some((ext) => f.name.toLowerCase().endsWith(ext))
        );

        if (viewableFiles.length > 0) {
          const hvRes = await fetch(hvApiUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Internal-Secret": hvSecret,
            },
            body: JSON.stringify({
              label: row.label,
              file_paths: viewableFiles.map(
                (f) => `s3://micalis/uploads/${t}/${f.name}`
              ),
            }),
          });
          if (hvRes.ok) {
            const data = (await hvRes.json()) as { url: string };
            hvUrl = data.url;
          } else {
            console.error("Histoview API error:", await hvRes.text());
          }
        }
      } catch (err) {
        console.error("Failed to generate Histoview preview:", err);
      }
    }

    markTokenUsed(t, files, hvUrl);
    await notifyUpload(row.label, t, files, hvUrl);

    // Clean up milestone tracking
    for (const f of files) {
      notifiedMilestones.delete(`${t}:${f.name}`);
    }

    res.json({ ok: true, hvUrl });
  }
);

export default router;
