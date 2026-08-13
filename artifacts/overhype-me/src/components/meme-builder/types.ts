/**
 * Public types for the Phase-3 universal meme builder.
 *
 * These names align with the existing app: `tier` uses the same vocabulary as
 * `useAuth().role` ("unregistered" | "registered" | "legendary"), not the
 * "anonymous" / "free" alias from the original brief.
 */

export type Mode = "stock" | "self-upload";

export type Tier = "unregistered" | "registered" | "legendary";

export type EntryFlow =
  | "cold-permalink"
  | "fact-detail"
  | "library"
  | "remix"
  | "creation";

export type AspectRatio = "landscape" | "square" | "portrait";

/**
 * Self-upload sources. The user's profile photo is now just a library entry
 * tagged `is_profile=true` — no separate `primary` discriminant. Old session
 * drafts that reference `kind:"primary"` are sanitized away by
 * `restorePendingState` before they reach the reducer.
 */
export type MyImageSource =
  | { kind: "library";    objectPath: string }
  | { kind: "fresh";      objectPath: string }
  | { kind: "ai-styling"; objectPath: string };

/**
 * Analytics discriminant for the resulting meme. Mirrors
 * `memes.image_transform` and `upload_image_metadata.transform`:
 *  - null:                  raw user upload, stock photo, or template
 *  - "pulid":               PuLID-stylized derivative (face matched)
 *  - "pulid_fallback_text": PuLID was requested but no face was detected, so
 *                           the standard text-to-image generator was used.
 */
export type ImageTransform = null | "pulid" | "pulid_fallback_text";

/**
 * Text styling options. The token-substituted fact text comes from
 * `lib/render-fact.ts` — the user does NOT edit the text directly, only the
 * styling and pronouns/name.
 */
export interface MemeTextOptions {
  topText?: string;
  bottomText?: string;
  fontFamily?: string;
  fontSize?: number;
  textColor?: string;
  outlineColor?: string;
  textEffect?: "shadow" | "outline" | "none";
  allCaps?: boolean;
  bold?: boolean;
  italic?: boolean;
  topY?: number;
  bottomY?: number;
}

export interface ViewerContext {
  /**
   * Identity-prerequisite questions only ("is this viewer signed in at all?").
   * NOT a permission: entitlements are resolved by the server and arrive as
   * `entitlements` below, so no surface re-derives them from this.
   */
  tier: Tier;
  /**
   * The server's resolved entitlements for this viewer, passed through
   * verbatim. Read gate and write gate are one expression evaluated once.
   */
  entitlements?: Readonly<Record<string, { allowed: boolean; limit: number | null }>>;
  userId?: string;
  name?: string;
  pronouns?: string;
  /** Hint to show or hide the "My library" tab without making it call the API just to know. */
  hasLibraryImages?: boolean;
}

/**
 * Captured by the builder when an unregistered user hits the signup wall.
 * The parent (route) holds it through the auth round-trip and feeds it back
 * via `Props.initialPendingState` so the user resumes exactly where they were.
 *
 * Persisted to sessionStorage with a 1h TTL — see state/pendingBuilderState.ts.
 */
export interface PendingBuilderState {
  schemaVersion: 1;
  capturedAt: number;
  factId: string;
  mode: Mode;
  entryFlow: EntryFlow;
  name?: string;
  pronouns?: string;
  source?:
    | { kind: "stock";        stockImageId: string }
    | { kind: "self-upload";
        image: MyImageSource;
        /**
         * The user's intent at the moment the wall appeared. The actual
         * generation has not happened yet — when they resume and save, the
         * server runs the dedup+stylize step.
         */
        stylizeWithAi: boolean;
      };
  textOptions?: MemeTextOptions;
  aspectRatio?: AspectRatio;
}

export type BuilderResult =
  | { kind: "saved";             memeId: string; permalinkUrl: string }
  | { kind: "downloaded" }
  | { kind: "signup-required";   pendingState: PendingBuilderState }
  | { kind: "upgrade-required";  targetTier: Tier; reason: string }
  | { kind: "cancelled" };

export interface MemeBuilderProps {
  mode: Mode;
  factId: string;
  /** The text template for the fact, with tokens like `{NAME}` / `{SUBJ}`. */
  factText: string;
  viewerContext: ViewerContext;
  entryFlow: EntryFlow;
  initialStockImageId?: string;
  initialName?: string;
  initialPronouns?: string;
  /** When set, supersedes initialName/initialPronouns/initialStockImageId. */
  initialPendingState?: PendingBuilderState;
  onComplete: (result: BuilderResult) => void;
  onCancel: () => void;
}

/* ─── Behavior cell ──────────────────────────────────────────────────────── */

/**
 * Distilled output of `resolveBehavior(mode, tier, entryFlow)`.
 * Component branching reads from this object; nested conditionals on raw
 * (mode, tier, entryFlow) tuples are not allowed elsewhere.
 */
export type Action = "download" | "save" | "share" | "signup-cta" | "try-ai-mode";

export interface BehaviorCell {
  /** When true, the matrix cell is invalid and a tier-locked panel is rendered instead of the builder. */
  invalid: boolean;
  /** Required tier to unlock the cell when invalid=true. */
  upgradeTo?: Tier;
  /** Copy shown in the locked-state panel. */
  upgradeReason?: string;
  /** Buttons to render in the action bar (in order). */
  visibleActions: Action[];
  /** Header copy key — copy.ts owns the strings. */
  headerCopyKey: HeaderCopyKey;
  /** Show the "Stylize me with AI" toggle on the source picker. */
  showStylizeToggle: boolean;
  /** When true the source area is rendered as MyImagePicker; otherwise StockImagePicker. */
  sourceArea: "stock" | "my-image";
  /** When true a "Try AI mode" upsell chip is shown next to the picker. */
  showTryAiUpsell: boolean;
  /** Default post-save behavior the parent should run. */
  postSave: "share" | "back-to-fact" | "none";
}

export type HeaderCopyKey =
  | "see-with-your-name"
  | "see-with-your-face"
  | "see-yourself-ai"
  | "make-this-your-own"
  | "build-your-meme";
