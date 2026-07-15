// Admin authorization for state-changing / execution routes. For a hosted deployment
// an ADMIN_PASSWORD env var is REQUIRED — there is no weak default in production. In
// local dev it falls back to "123" so the existing UI keeps working. A CRON_SECRET
// bearer token is also accepted for scheduled jobs. Never log these values.

import crypto from "node:crypto";

export function adminPassword(): string | null {
  const p = process.env.ADMIN_PASSWORD;
  if (p) return p;
  // Dev-only convenience; production with no ADMIN_PASSWORD denies all admin actions.
  return process.env.NODE_ENV !== "production" ? "123" : null;
}

export function isAuthorized(req: Request, bodyPassword?: string): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true;
  const pw = adminPassword();
  const supplied = req.headers.get("x-admin-password") ?? bodyPassword;
  if (pw == null || supplied == null) return false;
  const expected = Buffer.from(pw);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
