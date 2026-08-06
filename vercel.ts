import type { VercelConfig } from "@vercel/config/v1";

/**
 * Cron schedules.
 *
 * The intended cadence is hourly: polling every hour while individual queries
 * carry their own interval, so the sweep is a chance to poll rather than a
 * guarantee of one, with analysis on the half hour so it picks up what the
 * poll just ingested rather than racing it. That is `0 * * * *` and
 * `30 * * * *`.
 *
 * What ships below is the daily degradation of that design, because the
 * hosting account is on Vercel's Hobby plan and Hobby rejects any cron that
 * fires more than once per day — the deploy fails at config validation, not at
 * runtime. Same shape, same half-hour offset, once a day. Restore the hourly
 * expressions when the account moves to Pro; nothing else needs to change,
 * since each query's own interval already decides whether a sweep polls it.
 */
export const config: VercelConfig = {
  // Explicit because the Vercel project was created bare (`vercel project
  // add`), which left the framework preset as "Other" — a deploy under that
  // preset skips the Next.js build entirely and serves `public/` as a static
  // site, 404ing every route.
  framework: "nextjs",
  crons: [
    { path: "/api/cron/news-poll", schedule: "0 6 * * *" },
    { path: "/api/cron/analyze-mentions", schedule: "30 6 * * *" },
  ],
};
