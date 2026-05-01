import { createHash, randomUUID } from "node:crypto";

export function resolveCheckoutRequestKey(input: {
  userId: string;
  priceId: string;
  clientRequestId?: string | null;
  now?: Date;
  bucketMinutes?: number;
}): string {
  const { userId, priceId, clientRequestId } = input;
  if (clientRequestId && clientRequestId.trim().length > 0) {
    return `checkout:client:${clientRequestId.trim()}`;
  }

  const now = input.now ?? new Date();
  const bucketMinutes = input.bucketMinutes ?? 10;
  const bucket = Math.floor(now.getTime() / (bucketMinutes * 60_000));
  const digest = createHash("sha256")
    .update(`${userId}:${priceId}:${bucket}`)
    .digest("hex")
    .slice(0, 32);
  return `checkout:bucket:${digest}`;
}

export function newClientCheckoutRequestId(): string {
  return randomUUID();
}
