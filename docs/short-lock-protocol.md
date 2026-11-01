# Short directory-lock exclusion

`src/core/atomic-write.ts` supplies the short locks used by the generic file
lock, mesh store, and actor registry/binding stores. This filesystem protocol
is outside the verified policy kernels; timeout, liveness and authority laws
are not changed by this fix.

## Protocol and safety argument

1. Acquisition still exclusively `mkdir`s the canonical lock directory and
   publishes a complete owner record (unique token) via a private temporary.
2. **After publication**, it scans the parent for `<lock>.reap-*` claims. Any
   claim, or a scan error, denies entry. It then verifies the canonical inode
   against the acquisition observation and reads back the exact owner record.
   A failed acquisition withdraws only its own token, with no retry wait.
3. Reapers and releasers move directories to unique claim paths before
   destructive operations. A mismatched/live claim is restored if possible;
   if not, it remains a barrier and its owner can release directly from it.
4. Sweeping requires both an old claim and the ordinary owner-staleness
   verdict. An old name alone cannot authorize deleting a live owner's
   barrier. The sweep never acquires another guard or recursively reaps.

In the R1/R2/A/B schedule, R2 reaps the stale inode and A acquires. If R1 then
moves A's replacement inode, A's directory is still present as a claim. B may
create and publish a provisional canonical directory, but sees that claim and
withdraws **without entering its critical section**. R1 can restore A, or A
can release the stranded claim. Failed restoration does not permit B to enter.

More generally, a still-active holder is either canonical (excluding another
`mkdir`) or in a claim (excluding a successful acquisition scan). A successor's
populated canonical directory prevents a claim from being restored over it.
If displacement races the scan, the final canonical ownership check rejects
it; if it happens after the check, the claim excludes the next successor.
Temporary claim paths are unique and are not repurposed for new holders.
Removing a released holder's claim is safe because its critical section has
already ended. This is not a claim of compare-and-rename atomicity.

## Publication and portability

Hard-link publication refuses to replace an owner. On filesystems that reject
hard links, the rename fallback first checks for an existing owner **after**
creating its unique temporary inside the directory. A restored holder before
temporary creation is therefore detected. Afterwards, the nonempty directory
cannot be overwritten by a directory rename. Moving it away also moves the
unique temporary, so fallback publication at the canonical path fails rather
than overwriting a replacement's owner. Both routes publish a complete record;
neither exposes a partially written canonical `owner`. Windows' refusal to
rename over an existing directory is stricter, not a safety dependency.

There is no extra guard file, guard owner, or guard-reaping protocol. The
uncontended path adds one parent-directory scan, two inode observations and
one owner read, without sleeps, retries, liveness probes or stale sweeps. Scan
cost is linear in parent entries, not constant in directory size. Contended
recovery retains the once-per-second sweep throttle and existing caller
attempt/deadline bounds. Abandoned claims become removable once both their
claim age and owner policy allow it; incomplete claims retain their grace
period. A live owner is not penalized just because a reaper's clock was behind.

## Assumptions and mixed versions

- Cooperating clients use unique owner tokens and claim names, move whole
  directories, and never repurpose claim paths or mutate another owner's
  temporary files. Hostile filesystem mutation is not protected against.
- The filesystem provides coherent directory enumeration/lookup, exclusive
  mkdir, atomic same-filesystem rename/link, stable device/inode identifiers,
  and refuses directory replacement when the destination is nonempty. This
  does not claim correctness on incoherent network filesystems.
- Existing liveness/clock assumptions still apply: missing/partial owners may
  be abandoned after the stale window; owners past
  `max(SHORT_LOCK_MAX_HOLD_MS, staleMs)` may be treated as leaked. A suspended
  critical section that outlives that ceiling is not fenced and can overlap a
  successor. Arbitrary clock jumps/skew and inode/token reuse are not solved.
- Ordinary mixed-version mkdir contention and owner format remain compatible.
  **Old acquirers do not check claims, and old sweepers can remove a live
  claim based only on age.** The stronger exclusion guarantee requires all
  participating acquirers/sweepers to be upgraded. This patch cannot repair
  the race inside old binaries, nor prevent an old client's unsafe fallback
  publication. Upgrade all writers sharing a store for the guarantee.

## Regression evidence

`tests/short-lock-exclusion.test.ts` interleaves real directory operations at
`fs.renameSync`: R1 pauses after judging, R2 removes the old lock, A enters,
R1 moves A, and B tries to enter. Both successful and deliberately failed
restoration schedules assert non-overlapping critical sections. Additional
checks cover abandoned/dead/partial claims, old-dated live claims, repeated
contention, unreadable scans, post-scan displacement and hard-link fallback
races. Existing atomic-write/file-lock tests cover owner release during a
claim, timeout behavior and dead-owner recovery; mesh/grants tests cover the
shared callers.
