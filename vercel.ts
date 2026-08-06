import type { VercelConfig } from "@vercel/config/v1";

/**
 * Cron schedules.
 *
 * Polling is hourly while individual queries carry their own interval, so the
 * sweep is a chance to poll rather than a guarantee of one. Analysis runs on
 * the half hour so it picks up what the poll just ingested rather than racing
 * it.
 */
export const config: VercelConfig = {
  crons: [
    { path: "/api/cron/news-poll", schedule: "0 * * * *" },
    { path: "/api/cron/analyze-mentions", schedule: "30 * * * *" },
  ],
};
