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
  markTokenUsed(t, files);
  await notifyUpload(row.label, t, files);
  res.json({ ok: true });
});

export default router;
