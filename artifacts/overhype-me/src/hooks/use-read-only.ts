/**
 * @purpose Whether this page knows the site is read-only, as React state (#1109): one subscription to the client's read-only store, re-rendering when the switch flips.
 * @subsystem operations
 */
import { useSyncExternalStore } from "react";
import { isReadOnlyNow, onReadOnlyChange } from "@/lib/readOnlyNotice";

const subscribe = (notify: () => void) => onReadOnlyChange(() => notify());

export function useReadOnly(): boolean {
  return useSyncExternalStore(subscribe, isReadOnlyNow);
}
