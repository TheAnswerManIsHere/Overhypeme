/**
 * @purpose A member's own photo, made fetchable by the photo check and the image engine (launch Phase 7, increment 2): read from object storage and handed to the shared reference upload (`uploadReferenceBytes`), at the 1024-pixel edge the engines' edit prices assume. Tests replace the upload with `__setReferenceFalUploadForTest`.
 * @subsystem visual-pipeline
 */
import { ObjectStorageService } from "../objectStorage";
import { uploadReferenceBytes } from "../defaultReferenceResolver";

const MEMBER_REFERENCE_MAX_EDGE_PX = 1024;
const storage = new ObjectStorageService();

export async function uploadMemberReference(uploadKey: string): Promise<string> {
  const file = await storage.getObjectEntityFile(uploadKey);
  const res = await storage.downloadObject(file);
  return uploadReferenceBytes(Buffer.from(await res.arrayBuffer()), MEMBER_REFERENCE_MAX_EDGE_PX);
}
