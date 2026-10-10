# Checkpoint recovery

Little records private checkpoints for accepted file edits, creations, and regular
file deletions, including notebook and document changes. Original file bytes,
including binary content, UTF-8 BOMs and line endings, stay outside the project.
New files are recorded with an absent original; deletions record an absent result.
A checkpoint belongs to the exact project
directory identity; another project cannot restore it.

Use **Little: Restore Checkpoint** from the command palette, or **Saved checkpoints**
in the Agent panel. Save affected text editors and notebooks and stop the current run first.
Choose the checkpoint and confirm the native restore dialog. The picker also finds
interrupted transactions after Little Code restarts; opening the picker only reads
checkpoint metadata.

Each file mutation has a write-ahead record. Little flushes the candidate bytes and
a manifest containing the expected file fingerprint, candidate fingerprint, and
owned recovery directory before moving the original. It records the installation
phase before creating the new file name exclusively, then records the committed
inode before cleaning up the displaced original. Restore operations use the same
journal, so an interrupted restore can be reopened.

Recovery checks file hashes, inode identity, size, modification time, and mode.
It rechecks the current ignore policy and rejects links, junctions, unrelated
hard-link aliases, changed recovery directories, and corrupt private originals.
Later edits are preserved as conflicts, including identical content saved on a new
inode. A missing file after installation might represent a later user deletion;
Little preserves that ambiguity instead of recreating the file. The private
checkpoint and any displaced recovery bytes remain available for manual review.
Restoration of unaffected files can continue when another file conflicts.

The service supports legacy checkpoint manifests and the current version 2 journal.
Checkpoint discovery reads at most 2,000 storage entries and returns at most 200
validated records. Each proposal remains limited to eight files and 1 MiB of total
original plus proposed bytes for ordinary text changes. Format adapters and
deletions allow 16 MiB per file and 32 MiB of aggregate original plus proposed bytes.
Format review shows bounded source-derived text summaries with byte counts and
SHA-256 hashes. Generic text edits refuse notebook, DOCX, PPTX and PDF creation or
replacement; their dedicated tools preserve format structure. Recreated deleted
paths are preserved as conflicts during restore.

File handles are flushed and manifests use atomic rename. On POSIX systems the
service also flushes relevant directories. Node does not expose portable directory
flushing on Windows, so the implementation does not promise survival of every power
loss or storage-device failure. Abrupt process crashes at the move, link, unlink,
manifest, and cleanup boundaries are covered by actual child-process tests on
Windows. Portable Node cannot lock another application's open file handles or
mutable parent directories. Exclusive installation and identity checks prevent
ordinary overwrite races; this is not an operating-system sandbox.

Checkpoints currently recover the files changed by Little's accepted proposals.
They do not undo terminal commands, package installations, Git changes, or external
effects, and they do not yet store complete agent plans or Git state.

Run the focused regressions with:

```powershell
node --import tsx --test tests/edit-proposals.test.ts tests/file-mutations.test.ts tests/checkpoint-recovery.test.ts
```

The actual Windows app passed all 13 native recovery assertions: a genuine abrupt
worker exit, interrupted-record discovery, dirty-editor rejection, changed ignore
policy, Cancel without mutation, confirmed BOM/CRLF byte restoration, durable
rollback state, and removal of completed records from the picker. The isolated app
was cleaned up. Reproduce with `node scripts/smoke-checkpoints.mjs`; see the
[native report](../desktop/logs/native-checkpoint-recovery-smoke.json).
