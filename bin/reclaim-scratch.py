#!/usr/bin/env python3
# ==============================================================================
# Dynamic transcode scratch buffer reclaimer
# ------------------------------------------------------------------------------
# Monitors ${DOCKER_VOLUME_CACHE}/tdarr scratch space and purges abandoned
# transcode artifacts older than 6 hours when free disk headroom dips below 25%.
# ==============================================================================

import os
import shutil
import sys
import time

CACHE = os.environ.get("DOCKER_VOLUME_CACHE", "/var/home-server/cache")
TDARR_SCRATCH = os.path.join(CACHE, "tdarr")


def reclaim(scratch_dir=TDARR_SCRATCH, max_age_seconds=21600, min_free_ratio=0.25):
    """Purge old scratch files when disk headroom is below min_free_ratio."""
    if not os.path.exists(scratch_dir):
        return 0, 0, 1.0

    total, used, free = shutil.disk_usage(scratch_dir)
    free_ratio = free / float(total) if total > 0 else 1.0
    cutoff = time.time() - max_age_seconds
    reclaimed_bytes = 0
    removed_files = 0

    if free_ratio < min_free_ratio:
        for root, dirs, files in os.walk(scratch_dir):
            for f in files:
                fpath = os.path.join(root, f)
                try:
                    st = os.stat(fpath)
                    if st.st_mtime < cutoff:
                        reclaimed_bytes += st.st_size
                        os.remove(fpath)
                        removed_files += 1
                except OSError:
                    continue

    return free, reclaimed_bytes, free_ratio


def main():
    free, reclaimed, free_ratio = reclaim()
    if "--print" in sys.argv:
        print(f"scratch-reclaim: free={free} bytes ({free_ratio * 100:.1f}%), reclaimed={reclaimed} bytes")


if __name__ == "__main__":
    main()
