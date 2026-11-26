// @ts-check
/**
 * Backup archive parsing and validation
 *
 * Reads a backup ZIP's central directory and refuses unsafe or ambiguous member
 * paths, reads and validates the configuration manifest, and decides whether an
 * archive is restorable (integrity, manifest, DCA-import journals, accounting
 * payloads). The synchronous `inspectArchivePaths` serves restore; creation,
 * listing and the schedule anchor use the async validation.
 */

const fs = require('fs');
const { BASE_SNAPSHOT_FILENAME, CONFIG_LOCK_DIR } = require('./config-base-drift');
const path = require('path');
const { jsonReadError } = require('./json-diagnostics');
const { spawnSync } = require('child_process');
const { validatePersistedPayload, classifyPayloadPath } = require('./persisted-payload-validation');
const { STAGE_PREFIX, ORIGINALS_PREFIX, JOURNAL_FILENAME, OWNER_PREFIX } = require('./restore-apply');
const { LOCK_FILENAME: LEGACY_MIGRATION_LOCK } = require('./legacy-namespace-migration');
const { legacyRootArtifactTarget } = require('./migration');
const { PER_FUND_FILES } = require('./fund-paths');
const { JOURNAL_FILENAME: DCA_IMPORT_JOURNAL_FILENAME } = require('./dca-conversion-transaction');
const {
  FUND_STATE_MANIFEST_FILENAME,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  ROOT_COMPARE_MAX_BYTES,
  ROOT_CREDENTIAL_FILES,
  SPAWN_TIMEOUT_MS,
  spawnAsync,
  unzipMember,
} = require('./backup-common');
const { collectRootFilesFromEntries } = require('./backup-layout-translation');
const { archivedDcaImportRefusal, dcaImportJournalPaths } = require('./fund-state-snapshots');

// Protected names have case-sensitive meaning to the readers and exclusions.
// A differently-cased spelling can alias them on a case-insensitive disk
// without being recognized as accounting, credentials, a journal, or a lock.
const PROTECTED_ARCHIVE_NAMES = new Set([
  ...PER_FUND_FILES, ...ROOT_CREDENTIAL_FILES,
  MANIFEST_FILENAME, FUND_STATE_MANIFEST_FILENAME, BASE_SNAPSHOT_FILENAME,
  CONFIG_LOCK_DIR, JOURNAL_FILENAME, DCA_IMPORT_JOURNAL_FILENAME,
  LEGACY_MIGRATION_LOCK, 'config.json', 'updown-state.json', 'backups',
  '.maintenance-lock',
].map((name) => name.normalize('NFC').toLowerCase()));
const PROTECTED_ARCHIVE_PREFIXES = [
  ...ROOT_CREDENTIAL_FILES.map((name) => `${name}.`),
  'placement-intents.json.lock', LEGACY_MIGRATION_LOCK,
  STAGE_PREFIX, ORIGINALS_PREFIX, OWNER_PREFIX, `${BASE_SNAPSHOT_FILENAME}.`,
].map((name) => name.normalize('NFC').toLowerCase());

/**
 * Validate member destinations before extraction. unzip collapses dot and
 * repeated-slash components, so two differently-spelled names can overwrite
 * the same staged file. Retain the original spelling for unzip -p while using
 * the normalized path for every layout, manifest and payload decision.
 *
 * Reject links (including parent-directory links), path traversal, ambiguous
 * names, and file/directory collisions before unzip can touch staging. Case
 * and Unicode-equivalent spellings are refused for portable restores on
 * case-insensitive or normalization-insensitive filesystems.
 * @returns {{ok: true, entries: string[], members: Map<string, string>} | {ok: false, code: string, error: string}}
 */
const parseArchivePaths = (records) => {
  /** @returns {{ok: false, code: string, error: string}} */
  const refuse = (detail) => ({
    ok: false,
    code: 'archive-unsafe-paths',
    error: `Archive contains unsafe or ambiguous paths: ${detail}. No files were changed.`,
  });
  const entries = [];
  const members = new Map();
  const destinations = new Map();
  for (const { name, directory } of records) {
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || /[\\\x00-\x1f\x7f\ufffd]/.test(name)) {
      return refuse(`unsafe member ${JSON.stringify(name)}`);
    }
    const parts = name.split('/');
    if (parts.includes('..')) return refuse(`unsafe member ${JSON.stringify(name)}`);
    const segments = parts.filter((part) => part && part !== '.');
    if (!segments.length) {
      if (directory) continue;
      return refuse(`unsafe member ${JSON.stringify(name)}`);
    }
    for (const segment of segments) {
      const folded = segment.normalize('NFC').toLowerCase();
      const protectedName = PROTECTED_ARCHIVE_NAMES.has(folded)
        || folded.endsWith('-keys.json') || folded.endsWith('.restore-tmp')
        || PROTECTED_ARCHIVE_PREFIXES.some((prefix) => folded.startsWith(prefix));
      if (protectedName && segment !== folded) return refuse(`ambiguous protected name ${JSON.stringify(name)}`);
    }
    const canonical = segments.join('/');
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      const key = prefix.normalize('NFC').toLowerCase();
      const kind = i < segments.length || directory ? 'directory' : 'file';
      const previous = destinations.get(key);
      if (previous && (previous.path !== prefix || previous.kind !== kind || kind === 'file')) {
        return refuse(`conflicting members ${JSON.stringify(previous.name)} and ${JSON.stringify(name)}`);
      }
      destinations.set(key, { path: prefix, kind, name });
    }
    entries.push(directory ? `${canonical}/` : canonical);
    if (!directory) members.set(canonical, name);
  }
  return { ok: true, entries, members };
};

// Info-ZIP's text listing can render valid UTF-8 names lossily on macOS.
// Parse the bounded central directory and verify each local name instead:
// the same bytes drive both collision checks and unzip's eventual extraction.
// The generator lets backup creation/preflight use async file reads while the
// existing synchronous restore/inspection APIs share exactly the same rules.
/** @returns {Generator<{position: number, length: number}, ReturnType<typeof parseArchivePaths>, Buffer>} */
function* readArchiveDirectory(size) {
  const fail = (reason) => { throw new Error(reason); };
  if (size < 22) fail('missing end-of-directory record');
  const tailStart = Math.max(0, size - 65557);
  const tail = yield { position: tailStart, length: size - tailStart };
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
  }
  if (end < 0) fail('missing end-of-directory record');
  if (tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0) fail('multi-disk ZIP is unsupported');
  let count = tail.readUInt16LE(end + 10);
  let centralSize = tail.readUInt32LE(end + 12);
  let centralOffset = tail.readUInt32LE(end + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    const locatorPos = tailStart + end - 20;
    if (locatorPos < 0) fail('missing ZIP64 locator');
    const locator = yield { position: locatorPos, length: 20 };
    if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) fail('invalid ZIP64 locator');
    const zip64Offset = Number(locator.readBigUInt64LE(8));
    if (!Number.isSafeInteger(zip64Offset) || zip64Offset + 56 > locatorPos) fail('invalid ZIP64 directory');
    const zip64 = yield { position: zip64Offset, length: 56 };
    if (zip64.readUInt32LE(0) !== 0x06064b50 || zip64.readUInt32LE(16) !== 0 || zip64.readUInt32LE(20) !== 0) fail('invalid ZIP64 directory');
    count = Number(zip64.readBigUInt64LE(32));
    centralSize = Number(zip64.readBigUInt64LE(40));
    centralOffset = Number(zip64.readBigUInt64LE(48));
  } else if (tail.readUInt16LE(end + 8) !== count) fail('multi-disk ZIP is unsupported');
  if (![count, centralSize, centralOffset].every(Number.isSafeInteger)
    || count < 1 || centralSize > ROOT_COMPARE_MAX_BYTES
    || centralOffset < 0 || centralOffset + centralSize > tailStart + end) fail('invalid central directory bounds');
  const central = yield { position: centralOffset, length: centralSize };
  // A leading UTF-8 BOM is part of a ZIP member name, not a text-file marker.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const decode = (bytes) => { try { return decoder.decode(bytes); } catch { return fail('member name is not valid UTF-8'); } };
  const checkExtras = (extra, name) => {
    for (let pos = 0; pos < extra.length;) {
      if (pos + 4 > extra.length) fail('malformed member metadata');
      const kind = extra.readUInt16LE(pos);
      const length = extra.readUInt16LE(pos + 2);
      pos += 4;
      if (pos + length > extra.length) fail('malformed member metadata');
      // Reject a competing Unicode path: unzip versions differ on which name
      // they select. Identical names are unambiguous.
      if (kind === 0x7075 && (length < 5 || extra[pos] !== 1 || decode(extra.subarray(pos + 5, pos + length)) !== name)) {
        fail('ambiguous Unicode member name');
      }
      pos += length;
    }
  };
  const records = [];
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) fail('malformed central directory');
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const endEntry = cursor + 46 + nameLength + extraLength + commentLength;
    if (endEntry > central.length) fail('malformed central directory');
    const rawName = central.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decode(rawName);
    const extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
    checkExtras(extra, name);
    const attributes = central.readUInt32LE(cursor + 38);
    const modeType = (attributes >>> 16) & 0o170000;
    const host = central.readUInt16LE(cursor + 4) >>> 8;
    if (modeType === 0o120000) fail('symbolic links are not supported');
    if (host === 3 && modeType !== 0 && modeType !== 0o100000 && modeType !== 0o040000) fail('unsupported member type');
    let localOffset = central.readUInt32LE(cursor + 42);
    if (localOffset === 0xffffffff) {
      let found = false;
      for (let pos = 0; pos < extra.length;) {
        const kind = extra.readUInt16LE(pos), length = extra.readUInt16LE(pos + 2);
        pos += 4;
        if (kind === 1) {
          let value = pos;
          if (central.readUInt32LE(cursor + 24) === 0xffffffff) value += 8;
          if (central.readUInt32LE(cursor + 20) === 0xffffffff) value += 8;
          if (value + 8 > pos + length) fail('invalid ZIP64 member offset');
          localOffset = Number(extra.readBigUInt64LE(value));
          found = true;
          break;
        }
        pos += length;
      }
      if (!found) fail('missing ZIP64 member offset');
    }
    if (!Number.isSafeInteger(localOffset) || localOffset + 30 > centralOffset) fail('invalid local member offset');
    const local = yield { position: localOffset, length: 30 };
    if (local.readUInt32LE(0) !== 0x04034b50) fail('invalid local member header');
    const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28);
    if (localOffset + 30 + localNameLength + localExtraLength > centralOffset) fail('invalid local member bounds');
    const localFields = yield { position: localOffset + 30, length: localNameLength + localExtraLength };
    if (!localFields.subarray(0, localNameLength).equals(rawName)
      || local.readUInt16LE(6) !== central.readUInt16LE(cursor + 8)) fail('local and central member names or flags differ');
    checkExtras(localFields.subarray(localNameLength), name);
    records.push({ name, directory: name.endsWith('/') });
    cursor = endEntry;
  }
  if (cursor !== central.length) fail('unexpected central directory data');
  return parseArchivePaths(records);
}

/** @returns {{ok: false, code: string, error: string}} */
const archiveReadFailure = (error) => ({
  ok: false, code: 'archive-unsafe-paths',
  error: `Archive member metadata could not be verified: ${error.message}. No files were changed.`,
});

const inspectArchivePaths = (zipPath) => {
  let fd;
  try {
    fd = fs.openSync(zipPath, 'r');
    const reader = readArchiveDirectory(fs.fstatSync(fd).size);
    let step = reader.next();
    while (step.done === false) {
      const data = Buffer.alloc(step.value.length);
      if (fs.readSync(fd, data, 0, data.length, step.value.position) !== data.length) throw new Error('truncated archive');
      step = reader.next(data);
    }
    return step.value;
  } catch (error) { return archiveReadFailure(error); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
};

const inspectArchivePathsAsync = async (zipPath) => {
  let fd;
  try {
    fd = await fs.promises.open(zipPath, 'r');
    const reader = readArchiveDirectory((await fd.stat()).size);
    let step = reader.next();
    while (step.done === false) {
      const data = Buffer.alloc(step.value.length);
      if ((await fd.read(data, 0, data.length, step.value.position)).bytesRead !== data.length) throw new Error('truncated archive');
      step = reader.next(data);
    }
    return step.value;
  } catch (error) { return archiveReadFailure(error); }
  finally { if (fd) await fd.close(); }
};

/**
 * A path may alias an existing destination even when it has no duplicate in
 * the archive. Refuse differing case/Unicode spelling at every existing
 * component on all hosts, so a restore cannot overwrite a protected file on
 * a case-insensitive disk while bypassing the reader's exact-name rules.
 */
const checkDestinationAliases = (dataDir, entries) => {
  const cached = new Map();
  for (const entry of entries) {
    const parts = entry.replace(/\/$/, '').split('/');
    let dir = dataDir;
    for (let index = 0; index < parts.length; index++) {
      let names = cached.get(dir);
      if (!names) {
        try {
          names = fs.readdirSync(dir);
        } catch (error) {
          if (error.code === 'ENOENT') break;
          return { ok: false, code: 'destination-path-unsafe', error: `Cannot inspect restore destination ${dir}: ${error.message}. No files were changed.` };
        }
        cached.set(dir, names);
      }
      const segment = parts[index];
      const folded = segment.normalize('NFC').toLowerCase();
      const matches = names.filter((name) => name.normalize('NFC').toLowerCase() === folded);
      if (matches.some((name) => name !== segment)) {
        return { ok: false, code: 'destination-path-unsafe', error: `Archive path ${entry} aliases an existing destination with different spelling (${matches.join(', ')}). No files were changed.` };
      }
      if (!matches.length) break;
      const next = path.join(dir, segment);
      if (index < parts.length - 1) {
        let stat;
        try { stat = fs.lstatSync(next); } catch (error) {
          return { ok: false, code: 'destination-path-unsafe', error: `Cannot inspect restore destination ${next}: ${error.message}. No files were changed.` };
        }
        if (!stat.isDirectory()) {
          return { ok: false, code: 'destination-path-unsafe', error: `Restore destination parent ${next} is not a directory. No files were changed.` };
        }
      }
      dir = next;
    }
  }
  return { ok: true };
};

const checkTailFailure = (result, fallback) => {
  if (!result.error && result.status === 0) return null;
  return { ok: false, error: result.error ? result.error.message : (result.stderr?.toString().trim() || fallback) };
};

/** Shared decision logic once an archive's integrity, listing and manifest reads are in hand. */
const evaluateArchive = ({ archive, readManifest, allowLegacy }) => {
  const manifestName = archive.members.get(MANIFEST_FILENAME);
  if (!manifestName && allowLegacy) return { ok: true };
  if (!manifestName) return { ok: false, error: `Archive must contain exactly one ${MANIFEST_FILENAME}` };
  const read = readManifest(manifestName);
  if (read.error || !read.present) return { ok: false, error: read.error || `Missing ${MANIFEST_FILENAME}` };
  const validated = readManifestSnapshot(read.manifest);
  if (validated.ok === false) return { ok: false, error: validated.error };
  if (!validated.snapshot || typeof validated.snapshot !== 'object' || Array.isArray(validated.snapshot)) {
    return { ok: false, error: `${MANIFEST_FILENAME} has no valid configuration snapshot` };
  }
  if (typeof read.manifest.createdAt !== 'string' || Number.isNaN(Date.parse(read.manifest.createdAt))) {
    return { ok: false, error: `${MANIFEST_FILENAME} has no valid creation time` };
  }
  return { ok: true };
};

/**
 * Pre-namespace root artifacts have no fund directory in the archive; their
 * restored location depends on the destination's pair, which is a restore-time
 * choice and not a property of the archive. Payload rules depend only on path
 * depth, so any stand-in pair yields the same verdict the real restore reaches.
 */
const INTRINSIC_LEGACY_PAIR = '_legacy';

/**
 * Accounting members of an archive paired with the path restore validates them
 * at (supported legacy root files are judged at their translated location).
 * @param {string[]} entries
 * @returns {Array<{entry: string, target: string}>}
 */
const archivePayloadMembers = (entries) => {
  const rootTargets = new Map(collectRootFilesFromEntries(entries)
    .map((name) => [name, legacyRootArtifactTarget(name, INTRINSIC_LEGACY_PAIR)]));
  return entries.flatMap((entry) => {
    const target = rootTargets.get(entry) || entry;
    return entry.endsWith('/') || !classifyPayloadPath(target) ? [] : [{ entry, target }];
  });
};

/** Restore's verdict on one accounting member read from an archive. */
const payloadMemberVerdict = (entry, target, read) => {
  if (read.error || read.status !== 0) {
    return { ok: false, code: 'archive-corrupt', error: `Unable to read ${entry} from the archive. No files were changed.` };
  }
  const checked = validatePersistedPayload(target, read.stdout);
  return checked.ok === true
    ? { ok: true }
    : { ok: false, code: 'payload-incompatible', error: `Archive accounting is not readable by this build: ${checked.error}. No files were changed.` };
};

/**
 * Archive-local restorability (#1885): the refusals restore applies that depend
 * only on the archive itself. Destination choices (fund removal, legacy base
 * configuration) are deliberately absent, so one verdict serves publication,
 * listing, retention and the schedule anchor.
 * @param {string} zipPath
 * @param {{entries: string[], members: Map<string, string>}} archive
 */
const checkArchiveRestorableAsync = async (zipPath, { entries, members }) => {
  const journals = dcaImportJournalPaths(entries);
  if (journals.length > 0) return { ok: false, ...archivedDcaImportRefusal(journals) };
  for (const { entry, target } of archivePayloadMembers(entries)) {
    const read = await spawnAsync('unzip', ['-p', zipPath, unzipMember(members.get(entry))]);
    const verdict = payloadMemberVerdict(entry, target, read);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
};

/** Validate an archive; only listing may admit the supported pre-manifest format. */
const validateBackupArchiveAsync = async (zipPath, { allowLegacy = false } = {}) => {
  const integrity = await spawnAsync('unzip', ['-tq', zipPath]);
  const integrityFailure = checkTailFailure(integrity, 'Archive integrity check failed');
  if (integrityFailure) return integrityFailure;
  const archive = await inspectArchivePathsAsync(zipPath);
  if (archive.ok === false) return archive;
  const manifestName = archive.members.get(MANIFEST_FILENAME);
  const manifestRead = manifestName ? await spawnAsync('unzip', ['-p', zipPath, unzipMember(manifestName)]) : null;
  const evaluated = evaluateArchive({ archive, allowLegacy, readManifest: () => parseManifestRead(manifestRead) });
  return evaluated.ok ? checkArchiveRestorableAsync(zipPath, archive) : evaluated;
};

/**
 * Read an archive's manifest without extracting the archive.
 * @param {string} zipPath
 * @returns {{present: boolean, manifest?: Object, error?: string}}
 */
const readArchiveManifest = (zipPath, member = MANIFEST_FILENAME) =>
  parseManifestRead(spawnSync('unzip', ['-p', zipPath, unzipMember(member)], { timeout: SPAWN_TIMEOUT_MS }));

function parseManifestRead(result) {
  if (result.error) return { present: false, error: result.error.message };
  const raw = result.stdout ? result.stdout.toString().trim() : '';
  // `unzip -p` exits non-zero (11) when the entry is absent — a legacy archive.
  if (result.status !== 0 || !raw) return { present: false };
  try {
    return { present: true, manifest: JSON.parse(raw) };
  } catch (err) {
    return { present: true, error: jsonReadError(err, MANIFEST_FILENAME).message };
  }
}

/**
 * Validate a manifest envelope and hand back its configuration snapshot.
 * @param {*} manifest
 * @returns {{ok: true, snapshot: Object, createdAt?: string} | {ok: false, error: string}}
 */
const readManifestSnapshot = (manifest) => {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, error: `${MANIFEST_FILENAME} is malformed (not an object)` };
  }
  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    return {
      ok: false,
      error: `Backup manifest version ${JSON.stringify(manifest.manifestVersion)} is not supported by this build (expected ${MANIFEST_VERSION}) — upgrade critical-mass before restoring this archive`,
    };
  }
  return {
    ok: true,
    snapshot: manifest.config,
    createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : undefined,
  };
};

module.exports = {
  inspectArchivePaths,
  inspectArchivePathsAsync,
  checkDestinationAliases,
  checkTailFailure,
  payloadMemberVerdict,
  validateBackupArchiveAsync,
  readArchiveManifest,
  readManifestSnapshot,
};
