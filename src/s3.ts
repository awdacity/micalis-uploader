import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "stream";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT || "https://s3.fr-par.scw.cloud",
  region: process.env.S3_REGION || "fr-par",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
  },
  forcePathStyle: true,
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
    queueSize: 4,
    partSize: 64 * 1024 * 1024, // 64 MB parts
    leavePartsOnError: false,
  });

  upload.on("httpUploadProgress", (progress) => {
    if (onProgress && progress.loaded) {
      onProgress(progress.loaded);
    }
  });

  await upload.done();
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
