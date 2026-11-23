/**
 * @purpose The Terms and Privacy versions this bundle shows, which are the versions a set-up or an acceptance records (launch Phase 14, increment 4): read from the generated legal module, so they are the versions the pages render.
 * @subsystem accounts-auth
 */
import { LEGAL_VERSIONS } from "@/generated/legal";

export function shownLegalVersions(): { terms: string; privacy: string } {
  return { terms: LEGAL_VERSIONS.terms!, privacy: LEGAL_VERSIONS.privacy! };
}
