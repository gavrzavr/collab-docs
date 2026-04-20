/**
 * Admin access control.
 *
 * Single source of truth for "is this user allowed to see /admin pages?".
 * Keep this file tiny — any logic that touches it should be easy to audit.
 *
 * ADMIN_EMAILS env: comma-separated list of emails that get admin access.
 * Leave empty to disable admin entirely (safer than accidentally exposing it).
 */

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env.ADMIN_EMAILS || "";
  if (!raw.trim()) return false;
  const allowed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.toLowerCase());
}
