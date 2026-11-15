/** MVP limits. Mirrored in protocol/SPEC.md and MeshSitesCore. */
export const LIMITS = {
  /** Fixed chunk size for file data (raw leaves). */
  chunkSize: 16 * 1024,
  /** Largest block a receiver accepts: 16 KiB of data plus generous dag-pb room. */
  maxBlockBytes: 32 * 1024,
  /** Sum of all block bytes in one site. */
  maxSiteBytes: 1024 * 1024,
  /**
   * Expanded size of all files, counting a block once per reference. Stops a
   * small CAR that reuses one block thousands of times from rendering huge.
   */
  maxLogicalBytes: 4 * 1024 * 1024,
  /** Max links in one file node of the balanced layout. */
  maxChildrenPerNode: 174,
  /** A record's ts may be at most this far in the future (clock skew). */
  maxFutureSkewSec: 300,
} as const;

/**
 * Box tier: sites a Wi-Fi box (`meshsites serve`) stores and serves over
 * HTTP. Same packaging and per-block rules as the mesh; only the whole-site
 * caps are larger. A site over the mesh caps never travels over Bluetooth.
 */
export const BOX_LIMITS = {
  maxSiteBytes: 64 * 1024 * 1024,
  maxLogicalBytes: 256 * 1024 * 1024,
} as const;

export const CODEC_RAW = 0x55;
export const CODEC_DAG_PB = 0x70;
export const HASH_SHA2_256 = 0x12;
