const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
const chatId = process.env.TELEGRAM_CHAT_ID || "";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function notifyUpload(
  label: string,
  token: string,
  files: { name: string; size: number }[]
): Promise<void> {
  if (!botToken || !chatId) {
    console.warn("Telegram not configured, skipping notification");
    return;
  }

  const filenames = files.map((f) => f.name).join("\n  ");
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  const text = `🆕 Upload complete!

Client: ${label}
Files:
  ${filenames}
Total size: ${formatSize(totalSize)}
Token: ${token}`;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
        }),
      }
    );
    if (!res.ok) {
      console.error("Telegram API error:", await res.text());
    }
  } catch (err) {
    console.error("Telegram notification failed:", err);
  }
}
