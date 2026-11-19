/**
 * @purpose The one HTML escaper for text a person typed that the API places in HTML it renders (OG pages, emails).
 * @subsystem security
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
