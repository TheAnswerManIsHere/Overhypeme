/**
 * @purpose The one object-storage client every storage call goes through: the Replit-sidecar GCS client, or the local double when STORAGE_BACKEND=local-double names it.
 * @subsystem storage
 */
import { Storage } from "@google-cloud/storage";
import { selectedBackend } from "./doubleSelection";
import { LocalObjectStorage, type BucketClient } from "./localObjectStorage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

/**
 * The sidecar GCS client, or the local double when `STORAGE_BACKEND=local-double`
 * names it (`doubleSelection.ts` refuses that in a production boot, and
 * re-checks here). `objectStorageClient` stays exported for the maintenance
 * scripts, which only ever run against the real bucket.
 */
export function storageClient(): BucketClient {
  if (selectedBackend("STORAGE_BACKEND") !== "local-double") return objectStorageClient as unknown as BucketClient;
  // Cheap (no I/O); selectedBackend has already refused a missing or relative dir.
  return new LocalObjectStorage(process.env.STORAGE_DOUBLE_DIR ?? "");
}
