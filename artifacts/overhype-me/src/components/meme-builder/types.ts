/**
 * Public types for the Phase-3 universal meme builder.
 *
 * These names align with the existing app: `tier` uses the same vocabulary as
 * `useAuth().role` ("unregistered" | "registered" | "legendary"), not the
 * "anonymous" / "free" alias from the original brief.
 */

/**
 * The builder's image-source mode. "self-upload" is the only one: stock photos
 * went with Pexels (launch Phase 4, removal 6; `docs/retired/README.md`). A
 * saved draft that still says "stock" is normalised on restore.
 */
export type Mode = "self-upload";

export type Tier = "unregistered" | "registered" | "legendary";

export type EntryFlow =
  | "fact-detail"
  | "library"
  | "remix"
  | "creation";

export type AspectRatio = "landscape" | "square" | "portrait";

/**
 * Self-upload sources. The user's profile photo is now just a library entry
 * tagged `is_profile=true` — no separate `primary` discriminant.
 */
export type MyImageSource =
  | { kind: "library"; objectPath: string }
  | { kind: "fresh";   objectPath: string };

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

export type BuilderResult =
  | { kind: "saved";             memeId: string; permalinkUrl: string }
  | { kind: "downloaded" }
  | { kind: "upgrade-required";  targetTier: Tier; reason: string }
  | { kind: "cancelled" };

export interface MemeBuilderProps {
  mode: Mode;
  factId: string;
  /** The text template for the fact, with tokens like `{NAME}` / `{SUBJ}`. */
  factText: string;
  viewerContext: ViewerContext;
  entryFlow: EntryFlow;
  initialName?: string;
  initialPronouns?: string;
  onComplete: (result: BuilderResult) => void;
  onCancel: () => void;
}

/* ─── Behavior cell ──────────────────────────────────────────────────────── */

/**
 * Distilled output of `resolveBehavior(mode, tier, entryFlow, entitlements)`.
 * Component branching reads from this object; nested conditionals on raw
 * (mode, tier, entryFlow) tuples are not allowed elsewhere.
 */
export type Action = "download" | "save" | "share";

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
  /** The source area is always MyImagePicker (the stock picker went with Pexels). */
  sourceArea: "my-image";
  /** Default post-save behavior the parent should run. */
  postSave: "back-to-fact" | "none";
}

export type HeaderCopyKey =
  | "make-this-your-own"
  | "build-your-meme";
