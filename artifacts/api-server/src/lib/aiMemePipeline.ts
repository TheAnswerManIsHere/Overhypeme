/**
 * The retired legacy AI-background generator's stored shape.
 *
 * The generator invented gendered scenes from a fact's text and drew them on
 * FLUX with no photo. It was retired by the compiler review, Phase 2 (Issue
 * #950 — every picture starts from a photo): its admin action, route, script,
 * generation path and queue are gone (the queue with fact lifecycle 3.2d). The
 * pictures it stored stay readable, so their shape stays for its readers. Its
 * scene prompts were dropped by migration 0169 (fact lifecycle 3.2e).
 */

export interface AiMemeImages {
  male:    string[];  // object storage paths, 3 per gender
  female:  string[];
  neutral: string[];
}
