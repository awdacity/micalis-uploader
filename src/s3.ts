import { S3Client, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
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
  maxAttempts: 6, // retry up to 6 times on S3 errors
});

const bucket = process.env.S3_BUCKET || "Micalis";

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
    partSize: 16 * 1024 * 1024, // 16 MB parts — smaller = fewer bytes lost on retry
    leavePartsOnError: false,
  });

  upload.on("httpUploadProgress", (progress) => {
    if (onProgress && progress.loaded) {
      onProgress(progress.loaded);
    }
  });

  await upload.done();
}

export async function getPresignedPutUrl(key: string, contentType: string, expiresIn = 7200): Promise<string> {
  const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
  return getSignedUrl(s3, cmd, { expiresIn });
}

export async function listUploads(): Promise<{ key: string; size: number; lastModified: Date }[]> {
  const cmd = new ListObjectsV2Command({ Bucket: bucket, Prefix: "uploads/" });
  const res = await s3.send(cmd);
  return (res.Contents || []).map((o) => ({
    key: o.Key || "",
    size: o.Size || 0,
    lastModified: o.LastModified || new Date(),
  }));
}

export default s3;
