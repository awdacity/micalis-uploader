import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT || "https://s3.fr-par.scw.cloud",
  region: process.env.S3_REGION || "fr-par",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
  },
  forcePathStyle: true,
  maxAttempts: 6,
});

const bucket = process.env.S3_BUCKET || "Micalis";

// ── Simple upload (server-side streaming) ───────────────────────

export async function uploadToS3(
  key: string,
  body: Readable,
  contentType: string,
  onProgress?: (loaded: number) => void
): Promise<void> {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    },
    queueSize: 2,
    partSize: 16 * 1024 * 1024,
    leavePartsOnError: false,
  });

  upload.on("httpUploadProgress", (progress) => {
    if (onProgress && progress.loaded) {
      onProgress(progress.loaded);
    }
  });

  await upload.done();
}

// ── Presigned PUT (small files, browser direct upload) ──────────

export async function getPresignedPutUrl(
  key: string,
  contentType: string,
  expiresIn = 86400 // 24h (was 2h)
): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3, cmd, { expiresIn });
}

// ── Multipart upload (large files, browser chunked upload) ──────

export const MULTIPART_PART_SIZE = 200 * 1024 * 1024; // 200 MB per part

export async function initiateMultipartUpload(
  key: string,
  contentType: string
): Promise<{ uploadId: string; key: string }> {
  const cmd = new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });
  const res = await s3.send(cmd);
  if (!res.UploadId) throw new Error("S3 did not return an UploadId");
  console.log(`[S3] Multipart initiated: key=${key} uploadId=${res.UploadId}`);
  return { uploadId: res.UploadId, key };
}

export async function getPresignedPartUrls(
  key: string,
  uploadId: string,
  totalParts: number,
  expiresIn = 86400 // 24h
): Promise<string[]> {
  const urls: string[] = [];
  for (let i = 1; i <= totalParts; i++) {
    const cmd = new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: i,
    });
    urls.push(await getSignedUrl(s3, cmd, { expiresIn }));
  }
  console.log(
    `[S3] Generated ${totalParts} presigned part URLs for key=${key}`
  );
  return urls;
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string
): Promise<void> {
  // List all uploaded parts to get ETags
  let allParts: { ETag: string; PartNumber: number }[] = [];
  let partMarker: string | undefined;

  // Paginate through ListParts (max 1000 per call)
  do {
    const listCmd = new ListPartsCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumberMarker: partMarker,
    });
    const listRes = await s3.send(listCmd);
    const parts = (listRes.Parts || []).map((p) => ({
      ETag: p.ETag!,
      PartNumber: p.PartNumber!,
    }));
    allParts = allParts.concat(parts);
    partMarker = listRes.IsTruncated
      ? String(parts[parts.length - 1]?.PartNumber)
      : undefined;
  } while (partMarker);

  if (allParts.length === 0) {
    throw new Error("No parts found for multipart upload");
  }

  // Sort by part number
  allParts.sort((a, b) => a.PartNumber - b.PartNumber);

  console.log(
    `[S3] Completing multipart: key=${key} parts=${allParts.length}`
  );

  const cmd = new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: allParts },
  });
  await s3.send(cmd);
  console.log(`[S3] Multipart completed: key=${key}`);
}

export async function abortMultipartUpload(
  key: string,
  uploadId: string
): Promise<void> {
  console.log(`[S3] Aborting multipart: key=${key} uploadId=${uploadId}`);
  const cmd = new AbortMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
  });
  await s3.send(cmd);
}

// ── List uploads ────────────────────────────────────────────────

export async function listUploads(): Promise<
  { key: string; size: number; lastModified: Date }[]
> {
  const cmd = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: "uploads/",
  });
  const res = await s3.send(cmd);
  return (res.Contents || []).map((o) => ({
    key: o.Key || "",
    size: o.Size || 0,
    lastModified: o.LastModified || new Date(),
  }));
}

export default s3;
