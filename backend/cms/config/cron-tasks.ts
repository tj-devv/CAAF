// Recurring job that polls the client's Substack feed and imports any post
// that isn't already in the "Blog Link" content type, so new posts show up on
// the website without anyone re-running the manual import script.
//
// Each entry's `postDate` is the post's actual Substack publish date, and the
// frontend sorts by postDate:desc — so a freshly imported post always sorts
// first without any renumbering of existing rows.
//
// After every run, a Telegram message is sent summarizing the result (set
// TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID to enable; silently skipped otherwise).
//
// The schedule defaults to every 6 hours (UTC). Override per-environment with
// SUBSTACK_CRON_RULE / SUBSTACK_CRON_TZ — e.g. staging runs once daily instead
// of every 6 hours, to avoid duplicate notifications alongside production.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const DEFAULT_FEED_URL =
  "https://tochukwuezeukwu.substack.com/api/v1/posts?sort=new&limit=50";

async function fetchWithRetry(url: string, retries = 3, delayMs = 5000): Promise<Response> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = new Error("Feed fetch failed: " + res.status);
    } catch (err: any) {
      lastErr = err;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs * attempt));
  }
  throw lastErr;
}

async function notifyTelegram(message: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
  } catch {
    // A failed notification should never break the import job.
  }
}

export default {
  importSubstackPosts: {
    task: async ({ strapi }: { strapi: any }) => {
      const feedUrl = process.env.SUBSTACK_FEED_URL || DEFAULT_FEED_URL;

      let posts: any[];
      try {
        const res = await fetchWithRetry(feedUrl);
        posts = (await res.json()) as any[];
      } catch (err: any) {
        strapi.log.error("[substack-import] Failed to fetch feed: " + err.message);
        await notifyTelegram(
          "[substack-import] Run failed: could not fetch feed (" + err.message + ")"
        );
        return;
      }

      const existing = await strapi
        .documents("api::blog-link.blog-link")
        .findMany({ fields: ["url"], limit: -1 });

      const existingUrls = new Set(existing.map((e: any) => e.url));

      const newPosts = posts
        .filter((p) => !existingUrls.has(p.canonical_url))
        .sort(
          (a, b) => new Date(a.post_date).getTime() - new Date(b.post_date).getTime()
        );

      if (!newPosts.length) {
        strapi.log.info("[substack-import] No new posts found.");
        await notifyTelegram("[substack-import] Run complete: no new posts found.");
        return;
      }

      const imported: string[] = [];
      const importedNoImage: string[] = [];
      const failed: { title: string; error: string }[] = [];

      for (const p of newPosts) {
        try {
          const slug = p.canonical_url.split("/").pop() || "cover";

          // Upload cover image by writing to a temp file so Strapi's upload
          // service can resolve a valid path (passing only a stream leaves
          // file.path undefined and throws inside the provider).
          // If image upload fails, the post is still imported without an image.
          let coverImageId: number | undefined;
          let coverImageUrl: string | undefined;
          if (p.cover_image) {
            let tmpPath: string | undefined;
            try {
              const imageRes = await fetch(p.cover_image);
              if (!imageRes.ok)
                throw new Error("Image download failed: " + imageRes.status);
              const buf = Buffer.from(await imageRes.arrayBuffer());

              tmpPath = path.join(os.tmpdir(), slug + "-" + Date.now() + ".jpg");
              fs.writeFileSync(tmpPath, buf);

              const [uploaded] = await strapi
                .plugin("upload")
                .service("upload")
                .upload({
                  data: {},
                  files: {
                    path: tmpPath,
                    name: slug + ".jpg",
                    type: "image/jpeg",
                    size: buf.length,
                  },
                });

              coverImageId = uploaded.id;
            } catch (imgErr: any) {
              // Upload failed — fall back to storing the original URL directly.
              // The frontend uses coverImageUrl when coverImage is null.
              coverImageUrl = p.cover_image;
              strapi.log.warn(
                "[substack-import] Cover image upload failed for \"" +
                  p.title +
                  "\", using fallback URL: " +
                  imgErr.message
              );
              importedNoImage.push(p.title + " (used fallback URL, upload error: " + imgErr.message + ")");
            } finally {
              if (tmpPath) {
                try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
              }
            }
          }

          await strapi.documents("api::blog-link.blog-link").create({
            data: {
              title: p.title,
              url: p.canonical_url,
              description: p.subtitle || "",
              ...(coverImageId !== undefined ? { coverImage: coverImageId } : {}),
              ...(coverImageUrl !== undefined ? { coverImageUrl } : {}),
              postDate: p.post_date,
            },
          });

          strapi.log.info("[substack-import] Imported: " + p.title);
          if (coverImageId !== undefined) {
            imported.push(p.title);
          }
        } catch (err: any) {
          strapi.log.error(
            "[substack-import] Failed to import \"" + p.title + "\": " + err.message
          );
          failed.push({ title: p.title, error: err.message });
        }
      }

      const lines = ["[substack-import] Run complete."];
      if (imported.length) {
        lines.push("Imported (" + imported.length + "):");
        imported.forEach((title) => lines.push("  ✓ " + title));
      }
      if (importedNoImage.length) {
        lines.push("Imported without image (" + importedNoImage.length + "):");
        importedNoImage.forEach((msg) => lines.push("  ⚠ " + msg));
      }
      if (failed.length) {
        lines.push("Failed (" + failed.length + "):");
        failed.forEach((f) => lines.push("  ✗ " + f.title + " — " + f.error));
      }
      await notifyTelegram(lines.join("\n"));
    },
    options: {
      rule: process.env.SUBSTACK_CRON_RULE || "0 */6 * * *",
      tz: process.env.SUBSTACK_CRON_TZ || "UTC",
    },
  },
};
