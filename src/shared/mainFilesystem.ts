/**
 * Root ("main") filesystem lookup for metrics views.
 *
 * NOTE: reconstructed locally — upstream/main (2.77.0) imports this module from
 * SparkCard but the file is missing from their tree, so their tip does not
 * compile. Shape inferred from the only call site
 * (`mainFilesystem(spark.metrics.storage, metricsView)` → the disk entry shown
 * as Storage). Replace with the upstream file when they ship it.
 */
import type { SparkSnapshot } from "../api/types";

/** The view the metrics cards want: the filesystem the OS runs on. */
export const metricsView = "metrics" as const;

export type StorageEntry = SparkSnapshot["metrics"]["storage"][number];

/**
 * The unit's main filesystem, or null when storage has not been collected.
 * Preference order: the mount labelled "/" (the collector maps the host root
 * mount to that label), the GB10 boot partition, then the largest disk.
 */
export function mainFilesystem(
  storage: readonly StorageEntry[] | undefined,
  _view?: string
): StorageEntry | null {
  if (!Array.isArray(storage) || storage.length === 0) return null;
  return (
    storage.find((d) => d?.label === "/") ??
    storage.find((d) => d?.device === "nvme0n1p2") ??
    storage.reduce<StorageEntry>((best, d) => ((d?.total ?? 0) > (best?.total ?? 0) ? d : best), storage[0]) ??
    null
  );
}
