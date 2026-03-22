import { Router, Request, Response } from "express";
import Busboy from "busboy";
import path from "path";
import { getToken, isTokenValid, markTokenUsed } from "../db";
import { uploadToS3, getPresignedPutUrl } from "../s3";
import { notifyUpload } from "../telegram";

const router = Router();

// Serve upload page for valid tokens, expired page otherwise
router.get("/u/:token", (req: Request, res: Response) => {
  const row = getToken(req.params.token as string);
  if (!row || !isTokenValid(row)) {
    res.sendFile(path.join(__dirname, "..", "public", "expired.html"));
    return;
  }
  res.sendFile(path.join(__dirname, "..", "public", "upload.html"));
});

// Return token metadata (label) for the upload page to display
router.get("/api/token-info/:token", (req: Request, res: Response) => {
  const row = getToken(req.params.token as string);
  if (!row || !isTokenValid(row)) {
    res.status(403).json({ error: "Token expired or invalid" });
    return;
  }
  res.json({ label: row.label });
});

// Handle file upload via streaming multipart
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
    limits: { fileSize: 1024 * 1024 * 1024 * 1024 }, // 1 TB
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

    const promise = uploadToS3(s3Key, fileStream, mimeType)
      .then(() => {
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

      // Mark token as used and notify
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

// Generate presigned PUT URLs — browser uploads directly to S3
router.post("/api/prepare-upload/:token", async (req: Request, res: Response) => {
  const t = req.params.token as string;
  const row = getToken(t);
  if (!row || !isTokenValid(row)) {
    res.status(403).json({ error: "Token expired or invalid" });
    return;
  }
  const { files } = req.body as { files: { name: string; type: string; size: number }[] };
  if (!files?.length) {
    res.status(400).json({ error: "files required" });
    return;
  }
  const urls = await Promise.all(files.map(async (f) => {
    const key = `uploads/${t}/${f.name}`;
    const url = await getPresignedPutUrl(key, f.type || "application/octet-stream");
    return { name: f.name, size: f.size, key, url };
  }));
  res.json({ uploads: urls });
});

// Generate preview link for a specific file
router.get("/preview/:token/:filename", async (req: Request, res: Response) => {
  const t = req.params.token as string;
  const filename = decodeURIComponent(req.params.filename as string);
  const row = getToken(t);
  
  if (!row || row.used_at === null) {
    res.status(403).json({ error: "Token not found or not used" });
    return;
  }

  const hvApiUrl = process.env.HV_URL ? `${process.env.HV_URL}/api/internal/preview` : null;
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
        "X-Internal-Secret": hvSecret
      },
      body: JSON.stringify({
        label: row.label,
        file_paths: [`s3://micalis/uploads/${t}/${filename}`]
      })
    });

    if (!hvRes.ok) {
      console.error("Histoview API error:", await hvRes.text());
      res.status(500).json({ error: "Failed to generate preview" });
      return;
    }

    const data = await hvRes.json() as { url: string };
    res.redirect(data.url);
  } catch (err) {
    console.error("Preview generation error:", err);
    res.status(500).json({ error: "Preview generation failed" });
  }
});

// Called by browser after direct S3 upload completes
router.post("/api/complete-upload/:token", async (req: Request, res: Response) => {
  const t = req.params.token as string;
  const row = getToken(t);
  if (!row || !isTokenValid(row)) {
    res.status(403).json({ error: "Token expired or invalid" });
    return;
  }
  const { files } = req.body as { files: { name: string; size: number }[] };
  if (!files?.length) {
    res.status(400).json({ error: "files required" });
    return;
  }

  let hvUrl: string | undefined;
  const hvApiUrl = process.env.HV_URL ? `${process.env.HV_URL}/api/internal/preview` : null;
  const hvSecret = process.env.HV_INTERNAL_SECRET;

  if (hvApiUrl && hvSecret) {
    try {
      // Check if any of the files are viewable (e.g. .czi, .tif, .ndpi)
      const viewableExts = [".czi", ".tif", ".tiff", ".ndpi", ".mrxs"];
      const viewableFiles = files.filter(f => viewableExts.some(ext => f.name.toLowerCase().endsWith(ext)));

      if (viewableFiles.length > 0) {
        const hvRes = await fetch(hvApiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Secret": hvSecret
          },
          body: JSON.stringify({
            label: row.label,
            file_paths: viewableFiles.map(f => `s3://micalis/uploads/${t}/${f.name}`)
          })
        });
        if (hvRes.ok) {
          const data = await hvRes.json() as { url: string };
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
  res.json({ ok: true, hvUrl });
});

export default router;
