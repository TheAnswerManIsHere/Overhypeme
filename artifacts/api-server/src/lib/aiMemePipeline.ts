/**
 * The retired legacy AI-background generator's stored shapes.
 *
 * The generator invented gendered scenes from a fact's text and drew them on
 * FLUX with no photo. It was retired by the compiler review, Phase 2 (Issue
 * #950 — every picture starts from a photo): its admin action, route, script
 * and generation path are gone, and its queue's handler starts nothing. The
 * pictures it stored stay readable, so these shapes stay for their readers.
 */

export interface AiScenePrompts {
  fact_type: "action" | "abstract";
  male:    string;
  female:  string;
  neutral: string;
}

export interface AiMemeImages {
  male:    string[];  // object storage paths, 3 per gender
  female:  string[];
  neutral: string[];
}
