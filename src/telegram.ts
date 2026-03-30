const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
const chatId = process.env.TELEGRAM_CHAT_ID || "";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function sendTelegram(text: string): Promise<void> {
  if (!botToken || !chatId) {
    console.warn("Telegram not configured, skipping notification");
    return;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      }
    );
    if (!res.ok) {
      console.error("Telegram API error:", await res.text());
    }
  } catch (err) {
    console.error("Telegram notification failed:", err);
  }
}

// ── Upload lifecycle notifications ──────────────────────────────

export async function notifyUploadStarted(
  label: string,
  token: string,
  files: { name: string; size: number }[],
  userAgent?: string
): Promise<void> {
  const filenames = files
    .map((f) => `  • ${f.name} (${formatSize(f.size)})`)
    .join("\n");
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const useMultipart = files.some((f) => f.size >= 100 * 1024 * 1024);

  const text = `📤 <b>Upload started</b>

👤 Client: ${label}
🔑 Token: <code>${token.slice(0, 8)}…</code>
📦 Files:
${filenames}
💾 Total: ${formatSize(totalSize)}
⚙️ Mode: ${useMultipart ? "Multipart (chunked)" : "Direct PUT"}
🌐 UA: ${userAgent ? userAgent.slice(0, 80) : "unknown"}`;

  await sendTelegram(text);
}

export async function notifyUploadProgress(
  label: string,
  token: string,
  fileName: string,
  pct: number,
  loaded: number,
  total: number
): Promise<void> {
  const text = `📊 <b>Upload progress</b>

👤 ${label} · <code>${token.slice(0, 8)}…</code>
📄 ${fileName}
📈 ${pct}% — ${formatSize(loaded)} / ${formatSize(total)}`;

  await sendTelegram(text);
}

export async function notifyUploadRetry(
  label: string,
  token: string,
  fileName: string,
  attempt: number,
  maxRetries: number,
  error: string,
  partNum?: number,
  loaded?: number,
  total?: number
): Promise<void> {
  const partInfo = partNum ? `\n🧩 Part: ${partNum}` : "";
  const progressInfo =
    loaded !== undefined && total
      ? `\n📈 Progress before failure: ${formatSize(loaded)} / ${formatSize(total)}`
      : "";

  const text = `🔄 <b>Upload retry</b>

👤 ${label} · <code>${token.slice(0, 8)}…</code>
📄 ${fileName}${partInfo}
🔢 Attempt: ${attempt} / ${maxRetries}
❌ Error: ${error}${progressInfo}`;

  await sendTelegram(text);
}

export async function notifyUploadFailed(
  label: string,
  token: string,
  fileName: string,
  error: string,
  context?: {
    attempt?: number;
    partNum?: number;
    loaded?: number;
    total?: number;
    userAgent?: string;
    duration?: number;
  }
): Promise<void> {
  const ctx = context || {};
  let details = "";
  if (ctx.partNum) details += `\n🧩 Part: ${ctx.partNum}`;
  if (ctx.attempt) details += `\n🔢 Attempts: ${ctx.attempt}`;
  if (ctx.loaded !== undefined && ctx.total)
    details += `\n📈 Progress: ${formatSize(ctx.loaded)} / ${formatSize(ctx.total)} (${Math.round((ctx.loaded / ctx.total) * 100)}%)`;
  if (ctx.duration)
    details += `\n⏱ Duration: ${Math.round(ctx.duration / 1000)}s`;
  if (ctx.userAgent) details += `\n🌐 UA: ${ctx.userAgent.slice(0, 80)}`;

  const text = `🔴 <b>Upload FAILED</b>

👤 ${label} · <code>${token.slice(0, 8)}…</code>
📄 ${fileName}
❌ Error: ${error}${details}`;

  await sendTelegram(text);
}

export async function notifyUploadAborted(
  label: string,
  token: string,
  reason: string
): Promise<void> {
  const text = `⛔ <b>Upload aborted</b>

👤 ${label} · <code>${token.slice(0, 8)}…</code>
💬 Reason: ${reason}`;

  await sendTelegram(text);
}

// ── Original completion notification ────────────────────────────

export async function notifyUpload(
  label: string,
  token: string,
  files: { name: string; size: number }[],
  hvUrl?: string
): Promise<void> {
  const filenames = files
    .map((f) => `  • ${f.name} (${formatSize(f.size)})`)
    .join("\n");
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const s3Url = `https://console.scaleway.com/object-storage/buckets/fr-par/micalis/files/uploads/${token}/`;

  const text = `✅ <b>Upload complete!</b>

👤 Client: ${label}
📦 Files:
${filenames}
💾 Total: ${formatSize(totalSize)}

☁️ S3: ${s3Url}${hvUrl ? `\n🔬 Preview: ${hvUrl}` : ""}`;

  await sendTelegram(text);
}
