/**
 * MCP Server — registers tools and resources for CODESYS automation.
 * Supports persistent (watcher-based) and headless (spawn-per-command) modes.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ServerConfig, IpcResult, ScriptExecutor, ExecutionMode } from './types';
import { CodesysLauncher } from './launcher';
import { HeadlessExecutor } from './headless';
import { ScriptManager } from './script-manager';
import { serverLog, setLogLevel } from './logger';
import { readRunningVersionSsh, formatSshVersionResult } from './ssh-version';
import {
  restartCodesysRuntime,
  formatRestartRuntimeResult,
} from './ssh-restart-runtime';
import { resolveMirrorRoot } from './mirror-paths';
import { IdeBridgeClient, bridgeSchemaToZodShape, killOrphanedBridges } from './ide-bridge';
import { inspectProjectFile } from './inspect';
import { parseProfileName } from './detect';
import { decideOpenProjectPreflight } from './preflight';
import { resolveVersionPin, decideVersionPin } from './version-pin';
import { uncPathError } from './path-guard';
import { readSelection } from './state-read';
import { writeLiveValues } from './live-values-write';
import { LiveValuesPump } from './live-values-pump';

/**
 * Executor used in persistent mode whenever the launcher isn't running yet:
 * --no-auto-launch before the first tool call, after shutdown_codesys, or
 * after a failed/conflicted launch. Launches the full VISIBLE instance on
 * demand and delegates to it.
 *
 * It NEVER falls back to --noUI. Headless spawns pop modal dialogs nobody
 * can see (calls just "abort"), hold .project locks, and leave orphaned
 * CODESYS.exe processes behind. Headless execution is only allowed when the
 * user explicitly registers the server with --mode headless.
 */
class LazyPersistentExecutor implements ScriptExecutor {
  constructor(private launcher: CodesysLauncher) {}

  async executeScript(content: string, timeoutMs?: number): Promise<IpcResult> {
    const state = this.launcher.getStatus().state;
    if (state === 'launching') {
      // Another call is mid-launch; wait for it instead of double-launching.
      await this.waitForReady(120_000);
    } else if (state !== 'ready') {
      // 'stopped' or 'error': (re)launch the UI instance. Conflict and
      // watcher-timeout errors propagate to the tool caller verbatim.
      await this.launcher.launch();
    }
    return this.launcher.executeScript(content, timeoutMs);
  }

  private async waitForReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = this.launcher.getStatus().state;
      if (state === 'ready') return;
      if (state !== 'launching') {
        throw new Error(
          `CODESYS launch did not complete: launcher state is '${state}'` +
          (this.launcher.getStatus().lastError ? ` (${this.launcher.getStatus().lastError})` : '')
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('Timed out waiting for a concurrent CODESYS launch to become ready.');
  }
}

/**
 * Classifier for `bump_project_version --level=auto`.
 *
 * Diffs the project's mcp-mirror/ folder against the latest v* git tag in
 * the project's parent directory (assumed to be a git repo) and decides
 * which version part to bump:
 *
 *   D (delete) or R (rename)   -> major  (public symbol gone or renamed)
 *   A (add)                    -> minor  (new public symbol)
 *   M (modify)                 -> revision (internal change)
 *   no changes / no v* tag     -> build  (also triggers the seed-at-1.0.0.0
 *                                          first-run path on the Python side
 *                                          when version is unset)
 *
 * v1 keeps the heuristic at file granularity. A future iteration could
 * split each modified .st file into its decl block (before
 * `(* === IMPLEMENTATION === *)`) and impl block (after) to distinguish
 * decl-changed minor (signature add/change) from impl-only revision.
 */
type ClassifyResult =
  | { kind: 'bump'; level: 'major' | 'minor' | 'revision' | 'build'; evidence: string[] }
  | { kind: 'no-changes'; evidence: string[] }
  | { kind: 'first-run'; evidence: string[] };

/**
 * Result of computing (not yet writing) a Changelog update. Pure function --
 * no I/O -- so it can be unit tested against string fixtures directly.
 */
export interface ChangelogUpdateResult {
  status: 'written' | 'skipped';
  content?: string;
  style?: 'ours' | 'keepachangelog';
  reason?: string;
}

// Recognized heading conventions. 'ours' is what this tool itself writes;
// 'keepachangelog' is the https://keepachangelog.com/ convention some
// projects (e.g. Lib001) hand-maintain.
const OURS_HEADING_RE = /^##\s*v\d+\.\d+\.\d+\.\d+\s*-{1,2}\s/m;
const KAC_HEADING_RE = /^##\s*\[\d+\.\d+\.\d+\.\d+\]\s*-\s*\d{4}-\d{2}-\d{2}/m;
const KAC_UNRELEASED_RE = /^##\s*\[Unreleased\]/im;

/**
 * Builds the new Changelog.md content for a version bump, or reports why it
 * cannot be written.
 *
 * BUG (2026-07-23, Lib001 + SeaLeopard): the previous implementation's
 * "ownership guard" checked `existing.includes('Auto-generated by
 * \`bump_project_version\`')` to decide whether a file was safe to write
 * into -- but the text this same tool had been seeding into new files was
 * 'Auto-appended by `bump_project_version` on release.' (see the intro
 * constant below and SeaLeopard's Changelog.md since its v1.0.0.0 seed
 * commit). "Auto-generated" never matched "Auto-appended", so the guard
 * treated even the tool's OWN previously-created file as foreign and
 * skipped writing -- silently, because the skip only went to
 * `serverLog.warn` (stderr) while the caller printed a fixed
 * "Changelog.md: appended vX" success line regardless of what this
 * function did. Confirmed via SeaLeopard commits 3c87d18 / c98c264
 * ("The release pipeline reported appending a v1.3.0.0 changelog entry but
 * wrote nothing ... Both fixed by hand.").
 *
 * Separately, Lib001's CHANGELOG.md is a genuinely hand-maintained
 * Keep-a-Changelog file (`## [Unreleased]`, `## [x.y.z.w] - date`) that the
 * old appender could not understand at all -- it only knew its own
 * `## vX.Y.Z.W - date` heading style (older files use ` -- `; both are accepted).
 *
 * Fix: detect which of the two known heading styles (if either) the
 * existing file already uses from its own headings -- not from intro
 * wording -- and emit a new entry matching that style:
 *   - 'ours'          : `## vX.Y.Z.W - YYYY-MM-DD (level)` - inserted
 *                       directly after the intro/header, before the first
 *                       existing `## v...` heading.
 *   - 'keepachangelog': `## [X.Y.Z.W] - YYYY-MM-DD` - inserted immediately
 *                       after the `## [Unreleased]` section if one exists
 *                       (i.e. after its content, before the next heading),
 *                       otherwise before the first existing `## [...]`
 *                       heading.
 *   - neither recognized (some other hand-maintained format) -> status
 *     'skipped' with a clear reason; the file is left untouched rather than
 *     guessed at.
 * An empty/missing file seeds a fresh one in 'ours' style, as before.
 */
export function buildChangelogUpdate(
  existing: string | null,
  toVersion: string,
  fromVersion: string | null,
  levelLabel: string,
  evidence: string[],
  now: Date = new Date()
): ChangelogUpdateResult {
  const pad = (n: number) => String(n).padStart(2, '0');
  // YYYY-MM-DD (date only, no time) -- matches the convention already
  // established across every project's Changelog.md observed in the wild.
  const dateStamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const bullets =
    evidence.length > 0
      ? evidence.map((e) => `- ${e}`).join('\n')
      : '- (no classification evidence - manual bump)';

  if (existing === null || !existing.trim()) {
    const fromTo = fromVersion && fromVersion !== toVersion ? ` (from \`${fromVersion}\`)` : '';
    const intro =
      `# Changelog\n\n` +
      `Auto-appended by \`bump_project_version\` on release. Newest entries at the top. ` +
      `Versions match the value written to \`Project Information.Version\` and the runtime ` +
      `anchor \`_MCP_PROJECT_VERSION.sVersion\`, so an entry here corresponds 1:1 to a value ` +
      `the running PLC will report back via \`read_running_version_online\`.\n\n`;
    const entry = `## v${toVersion} - ${dateStamp} (${levelLabel})${fromTo}\n\n${bullets}\n`;
    return { status: 'written', content: intro + entry, style: 'ours' };
  }

  const unreleasedMatch = KAC_UNRELEASED_RE.exec(existing);
  if (unreleasedMatch || KAC_HEADING_RE.test(existing)) {
    const entry = `## [${toVersion}] - ${dateStamp}\n\n${bullets}\n`;
    let insertAt: number;
    if (unreleasedMatch) {
      const headingLineEnd = existing.indexOf('\n', unreleasedMatch.index);
      const afterHeading = headingLineEnd === -1 ? existing.length : headingLineEnd + 1;
      const nextHeadingRel = /^##\s/m.exec(existing.slice(afterHeading));
      insertAt = nextHeadingRel ? afterHeading + nextHeadingRel.index : existing.length;
    } else {
      const m = KAC_HEADING_RE.exec(existing)!;
      insertAt = m.index;
    }
    const before = existing.slice(0, insertAt);
    const after = existing.slice(insertAt);
    const sep = before.endsWith('\n\n') || before === '' ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const content = before + sep + entry + (after ? '\n' + after : '');
    return { status: 'written', content, style: 'keepachangelog' };
  }

  if (OURS_HEADING_RE.test(existing)) {
    const fromTo = fromVersion && fromVersion !== toVersion ? ` (from \`${fromVersion}\`)` : '';
    const entry = `## v${toVersion} - ${dateStamp} (${levelLabel})${fromTo}\n\n${bullets}\n`;
    const m = OURS_HEADING_RE.exec(existing)!;
    const insertAt = m.index;
    const before = existing.slice(0, insertAt);
    const after = existing.slice(insertAt);
    const content = before + entry + '\n' + after;
    return { status: 'written', content, style: 'ours' };
  }

  return {
    status: 'skipped',
    reason:
      'existing Changelog.md does not match a recognized heading style ' +
      '(no "## [Unreleased]" / "## [x.y.z.w] - date" Keep-a-Changelog heading, ' +
      'and no "## vX.Y.Z.W -" heading) - treating as hand-maintained; entry NOT written',
  };
}

/**
 * Appends a new entry to <projectDir>/Changelog.md describing the version
 * bump (I/O wrapper around the pure `buildChangelogUpdate`). Newest entries
 * at the top, under a one-time intro header for fresh files.
 *
 * Verifies the write by re-reading the file and confirming the new entry's
 * heading is actually present before reporting success -- a write that
 * silently didn't happen must never be reported as if it did (see the bug
 * writeup on `buildChangelogUpdate`).
 *
 * Soft-fail: any I/O error is returned as status 'skipped' (and logged to
 * stderr) rather than thrown -- the bump itself has already succeeded by
 * the time this runs, and the Changelog is documentation, not
 * state-of-truth. Callers that care about the outcome (release_project_version)
 * inspect the returned result; callers that don't (bump_project_version)
 * may ignore it, same as before.
 */
/**
 * Resolve the changelog's ACTUAL on-disk filename (Changelog.md vs CHANGELOG.md).
 * Windows' case-insensitive filesystem makes fs writes land in either, but
 * `git add "Changelog.md"` does NOT reliably update an index entry tracked as
 * CHANGELOG.md -- the release pipeline then commits a STALE changelog and
 * Lib001's pre-commit version-match hook rejects the commit (observed
 * 2026-07-24, Lib001 v0.22.0.0).
 */
export function resolveChangelogName(projectDir: string): string {
  try {
    const hit = fs.readdirSync(projectDir).find((f) => f.toLowerCase() === 'changelog.md');
    if (hit) return hit;
  } catch {
    /* fall through */
  }
  return 'Changelog.md';
}

export function appendChangelogEntry(
  projectDir: string,
  fromVersion: string | null,
  toVersion: string,
  levelLabel: string,
  evidence: string[]
): ChangelogUpdateResult {
  const changelogPath = path.join(projectDir, resolveChangelogName(projectDir));
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(changelogPath, 'utf-8');
  } catch {
    existing = null; // file doesn't exist yet
  }

  const update = buildChangelogUpdate(existing, toVersion, fromVersion, levelLabel, evidence);
  if (update.status === 'skipped') {
    serverLog.warn(`Changelog append skipped: ${changelogPath} -- ${update.reason}`);
    return update;
  }

  try {
    fs.writeFileSync(changelogPath, update.content!, 'utf-8');
    // Verify: re-read from disk and confirm the new heading is actually there.
    const verify = fs.readFileSync(changelogPath, 'utf-8');
    const needle = update.style === 'keepachangelog' ? `[${toVersion}] -` : `v${toVersion} -`;
    if (!verify.includes(needle)) {
      const reason = `write completed but re-read did not find "${needle}" in ${changelogPath}`;
      serverLog.warn(`Changelog append failed: ${reason}`);
      return { status: 'skipped', reason };
    }
    return update;
  } catch (e) {
    const reason = `I/O error writing ${changelogPath}: ${e instanceof Error ? e.message : String(e)}`;
    serverLog.warn(`Changelog append failed (bump itself was OK): ${reason}`);
    return { status: 'skipped', reason };
  }
}

/**
 * Result of attempting to update the version reference in a project
 * README.md. Pure function -- no I/O -- so it can be unit tested against
 * string fixtures directly.
 */
export interface ReadmeVersionUpdateResult {
  changed: boolean;
  content: string;
  detail: string;
}

/**
 * Updates the single version reference in a project's README.md.
 *
 * BUG (2026-07-23, SeaLeopard v1.3.0.0 -> v1.3.1.0): the previous
 * implementation was `content.replace(/v\d+\.\d+\.\d+\.\d+/g, ...)` -- a
 * blanket sweep over the whole file. It rewrote every version-looking
 * string, including historical bug-fix landmarks
 * ("power-cycle-verify the FB_Can K-bus cold-boot fix (v1.2.1.0)"),
 * build-archive snapshot versions, and even a DIFFERENT project's version
 * (the synced Lib001 library reference, "nmea2000-mr-library (Lib001)
 * v0.21.0.0"). See SeaLeopard commit c98c264 for the hand-repair this
 * caused.
 *
 * Fix: only ever touch one recognized, anchored line, never a global sweep:
 *   1. The first line of the file, if it is a top-level `# ` heading AND
 *      carries a `vX.Y.Z.W` token (the title-badge convention, e.g.
 *      "# Sea Leopard -- ... -- v1.3.1.0").
 *   2. Otherwise, if there is exactly one `**Version:** X.Y.Z.W` line (the
 *      Lib001 convention -- bare number, no `v` prefix).
 * If neither anchor is found (or anchor 2 is ambiguous, i.e. more than one
 * candidate line), nothing is changed and the reason is reported in
 * `detail` -- there is no global-replace fallback.
 */
export function updateReadmeVersion(content: string, newVersion: string): ReadmeVersionUpdateResult {
  const titleVersionToken = /v\d+\.\d+\.\d+\.\d+/;

  // Anchor 1: first line is a top-level heading carrying a vX.Y.Z.W token.
  const firstLineEnd = content.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? content : content.slice(0, firstLineEnd);
  if (/^#\s/.test(firstLine) && titleVersionToken.test(firstLine)) {
    const newFirstLine = firstLine.replace(titleVersionToken, `v${newVersion}`);
    if (newFirstLine === firstLine) {
      return { changed: false, content, detail: `title heading (line 1) already at v${newVersion}` };
    }
    const rest = firstLineEnd === -1 ? '' : content.slice(firstLineEnd);
    return { changed: true, content: newFirstLine + rest, detail: 'replaced the version token on the title heading (line 1) only' };
  }

  // Anchor 2: a single "**Version:** X.Y.Z.W" line (bare number, Lib001 convention).
  const versionLabelRe = /^(\*\*Version:\*\*\s*`?)(\d+\.\d+\.\d+\.\d+)(`?\s*)$/gm;
  const matches = [...content.matchAll(versionLabelRe)];
  if (matches.length === 1) {
    const m = matches[0];
    if (m[2] === newVersion) {
      return { changed: false, content, detail: `"**Version:**" line already at ${newVersion}` };
    }
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const newLineText = `${m[1]}${newVersion}${m[3]}`;
    return {
      changed: true,
      content: content.slice(0, start) + newLineText + content.slice(end),
      detail: 'replaced the version token on the "**Version:**" line only',
    };
  }
  if (matches.length > 1) {
    return {
      changed: false,
      content,
      detail: `left unchanged: found ${matches.length} "**Version:**" lines (ambiguous anchor) -- expected exactly 1`,
    };
  }

  return {
    changed: false,
    content,
    detail:
      'left unchanged: no recognized version anchor found ' +
      '(expected a vX.Y.Z.W token on the first "# " heading line, or a single "**Version:** X.Y.Z.W" line)',
  };
}

function parseBumpedVersion(output: string): { from: string | null; to: string | null } {
  // Python script prints one of:
  //   "Project Information.Version: <before> -> <after>"
  //   "Project Information.Version: (skipped -- node missing) -> <after>"
  // Use a non-greedy capture so the "skipped" parenthetical isn't mis-parsed
  // as the from-version. Also fall back to the runtime anchor line on the
  // off chance the metadata line ever changes shape again.
  const m = /Project Information\.Version:\s*(.+?)\s*->\s*(\S+)/.exec(output);
  if (m) {
    const fromRaw = m[1].trim();
    const isSkipped = fromRaw.startsWith('(') || fromRaw.toLowerCase() === 'none';
    return { from: isSkipped ? null : fromRaw, to: m[2] };
  }
  // Last-ditch: take the runtime anchor's value -- always reflects the post-bump version.
  const a = /Runtime anchor:\s*_MCP_PROJECT_VERSION\.sVersion\s*:=\s*'([^']+)'/.exec(output);
  if (a) return { from: null, to: a[1] };
  return { from: null, to: null };
}

/**
 * Compute SHA-256 of a single file's contents. Returns the lowercase hex
 * digest. Used to detect "did the .project binary change?" between releases
 * -- catches changes that don't show up in the textual mirror_export output
 * (device tree, library refs, task config, visualizations, etc.).
 */
function sha256OfFile(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/**
 * Compute a deterministic SHA-256 over a directory tree. Walks all regular
 * files in sorted order, hashing each (relative-path, content) pair so the
 * output is stable across machines and depends only on the tree's logical
 * content.
 *
 * Used to detect "did the user edit the mcp-mirror tree directly?" between
 * release calls. The mirror is normally a one-way export from the .project
 * binary, but a curious user can edit a .st file with a text editor; we
 * want to surface that case rather than silently overwriting their work
 * on the next mirror_export.
 *
 * Returns empty string if the directory doesn't exist.
 */
function sha256OfDirectory(dirPath: string): string {
  if (!fs.existsSync(dirPath)) return '';
  const hash = crypto.createHash('sha256');
  const baseLen = dirPath.length + 1;
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        const rel = full.slice(baseLen).replace(/\\/g, '/');
        hash.update(rel);
        hash.update('\0');
        try {
          hash.update(fs.readFileSync(full));
        } catch {
          // skip unreadable files; their absence still alters the hash
          // because subsequent entries continue to feed it
        }
        hash.update('\0');
      }
    }
  }
  walk(dirPath);
  return hash.digest('hex');
}

/**
 * Read the SHA-256 fingerprints stored in an annotated git tag's body.
 * release_project_version writes both `project-sha256:` and `mirror-sha256:`
 * lines into each release tag, so the next release can compare against
 * them and detect even non-textual changes.
 *
 * Returns undefined for either field if the tag body doesn't carry it
 * (older tags, lightweight tags, missing-tag failure).
 */
function readTagShas(projectDir: string, tagName: string): { project?: string; mirror?: string } {
  if (!tagName) return {};
  let body = '';
  try {
    body = execSync(`git -C "${projectDir}" cat-file -p ${tagName}`, {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return {};
  }
  // Some early SHA-tracking tags (v1.3.2.0 onward) were written via
  // `git tag -m` with JSON.stringify(body) which escaped newlines as
  // literal "\n" two-char sequences instead of real LF bytes -- the
  // regex below requires real line starts (multiline mode), so handle
  // both forms by normalising the literal sequence to a real newline
  // before matching. Future tags written via `git tag -F <tempfile>`
  // preserve real newlines and need no normalisation; this fallback
  // is just for backward compatibility with the early tags.
  const normalized = body.replace(/\\n/g, '\n');
  const projMatch = normalized.match(/^project-sha256:\s*([0-9a-f]{64})\s*$/m);
  const mirMatch = normalized.match(/^mirror-sha256:\s*([0-9a-f]{64})\s*$/m);
  return {
    project: projMatch ? projMatch[1] : undefined,
    mirror: mirMatch ? mirMatch[1] : undefined,
  };
}

/**
 * GitLab-Flavored Markdown anchor generator: lowercase, spaces -> hyphens,
 * drop everything not alphanumeric/underscore/hyphen. Matches GitLab's
 * lib/banzai/filter/table_of_contents_filter.rb so TOC links jump to the
 * right headings on the GitLab UI.
 */
function gfmSlug(s: string): string {
  return s.toLowerCase().replace(/ /g, '-').replace(/[^a-z0-9_-]/g, '');
}

interface LibRefData {
  id?: string; name?: string; namespace?: string;
  is_placeholder?: boolean; is_managed?: boolean; system_library?: boolean;
  qualified_only?: boolean; optional?: boolean; placeholder_name?: string;
  effective_resolution?: string; default_resolution?: string;
  is_redirected?: boolean; resolution_info?: string;
}
interface DeviceData {
  path: string; name?: string;
  device_id_type?: string; device_id_id?: string; device_id_version?: string;
}
interface ContainerData {
  container_name: string; libman_name: string; references: LibRefData[];
}
interface LibrariesData {
  project?: string;
  project_info?: { version?: string | null; title?: string | null; company?: string | null; author?: string | null };
  ide_version?: string; compiler_version?: string | null; devices?: DeviceData[]; containers: ContainerData[]; total_references: number;
}
interface PouEntry { path: string; type?: string; declaration?: string; implementation?: string; }

/** Headers renderLibraryMd itself emits. Anything else in an existing library.md
 * is a hand-maintained section (e.g. a per-FB "## Function Versions" registry)
 * and must survive regeneration -- a release must never silently delete it. */
const GENERATED_LIBRARY_MD_HEADERS = /^(# Library inventory|## Versions$|## Devices$|## Container: )/;

/** Extract every non-generated "## " section (header line through the line before
 * the next header) from an existing library.md so regeneration can re-append them. */
export function extractCustomLibraryMdSections(existing: string): string {
  const lines = existing.split(/\r?\n/);
  const kept: string[] = [];
  let keeping = false;
  for (const line of lines) {
    if (/^#{1,2} /.test(line)) {
      keeping = !GENERATED_LIBRARY_MD_HEADERS.test(line);
    }
    if (keeping) kept.push(line);
  }
  // Trim leading/trailing blank lines of the preserved block.
  while (kept.length > 0 && kept[0].trim() === '') kept.shift();
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return kept.join('\n');
}

function renderLibraryMd(libs: LibrariesData, runtimeAnchorVersion?: string): string {
  const L: string[] = [];
  L.push('# Library inventory - ' + (libs.project ?? '?'));
  L.push('');
  L.push('Auto-generated by `list_project_libraries` from the [`phobicdotno/Codesys-MCP-SP21-plus`](https://github.com/phobicdotno/Codesys-MCP-SP21-plus) fork.');
  L.push('');
  L.push('## Versions');
  L.push('');
  L.push('| Field | Value |');
  L.push('|---|---|');
  const pi = libs.project_info ?? {};
  if (pi.version) L.push(`| Project Information.Version | \`${pi.version}\` |`);
  if (pi.title) L.push(`| Project Information.Title | ${pi.title} |`);
  if (pi.company) L.push(`| Project Information.Company | ${pi.company} |`);
  if (pi.author) L.push(`| Project Information.Author | ${pi.author} |`);
  if (libs.ide_version) L.push(`| CODESYS Development System | \`${libs.ide_version.replace(/\s+/g, ' ').trim()}\` |`);
  if (libs.compiler_version) L.push(`| Project compiler version | \`${libs.compiler_version}\` |`);
  if (runtimeAnchorVersion) L.push(`| Runtime anchor | \`_MCP_PROJECT_VERSION.sVersion := "${runtimeAnchorVersion}"\` |`);
  L.push('');
  if (libs.devices && libs.devices.length > 0) {
    L.push('## Devices');
    L.push('');
    L.push('| Path | Type | ID | Version |');
    L.push('|---|---|---|---|');
    for (const d of libs.devices) {
      L.push(`| \`${d.path}\` | \`${d.device_id_type ?? ''}\` | \`${d.device_id_id ?? ''}\` | **\`${d.device_id_version ?? ''}\`** |`);
    }
    L.push('');
  }
  L.push(`**Total:** ${libs.total_references} library references across ${libs.containers.length} library managers.`);
  L.push('');
  for (const c of libs.containers) {
    L.push(`## Container: \`${c.container_name}\` (libman: ${c.libman_name}) - ${c.references.length} refs`);
    L.push('');
    L.push('| name | namespace | kind | sys | effective |');
    L.push('|---|---|---|---|---|');
    for (const r of c.references) {
      const kindParts = [r.is_managed && 'managed', r.is_placeholder && 'placeholder', r.is_redirected && 'redir', r.optional && 'opt'].filter(Boolean) as string[];
      const kind = kindParts.join('+') || '-';
      const eff = r.effective_resolution ?? r.default_resolution ?? '';
      const esc = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|');
      L.push(`| \`${esc(r.name)}\` | \`${esc(r.namespace)}\` | ${kind} | ${r.system_library ? 'yes' : 'no'} | ${esc(eff)} |`);
    }
    L.push('');
  }
  return L.join('\n');
}

/**
 * Regenerate one of the two script-derived text artefacts.
 *
 * Shared by release_project_version's normal path and its no-change repair
 * path, so a repaired file is byte-identical to a freshly released one.
 * Appends a one-line outcome to `log` either way -- a skip is reported, never
 * silently swallowed.
 */
async function regenerateArtifact(
  artifact: 'library.md' | 'pou-dump.md',
  ctx: {
    projectDir: string;
    escaped: string;
    /** Version to stamp into library.md. Undefined leaves it to the renderer. */
    version?: string;
    scriptManager: ScriptManager;
    executor: ScriptExecutor;
    log: string[];
  }
): Promise<void> {
  const { projectDir, escaped, version, scriptManager, executor, log } = ctx;
  const spec =
    artifact === 'library.md'
      ? { script: 'list_project_libraries', start: '### LIBRARIES_START ###', end: '### LIBRARIES_END ###' }
      : { script: 'get_all_pou_code', start: '### ALL_POU_CODE_START ###', end: '### ALL_POU_CODE_END ###' };

  try {
    const prepared = scriptManager.prepareScriptWithHelpers(
      spec.script, { PROJECT_FILE_PATH: escaped }, ['ensure_project_open']
    );
    const res = await executor.executeScript(prepared);
    const sIdx = res.output.indexOf(spec.start);
    const eIdx = res.output.indexOf(spec.end);
    if (sIdx < 0 || eIdx <= sIdx) {
      log.push(`${artifact}: skipped (markers not found in output)`);
      return;
    }
    const payload = res.output.substring(sIdx + spec.start.length, eIdx).trim();

    if (artifact === 'library.md') {
      const libs: LibrariesData = JSON.parse(payload);
      const target = path.join(projectDir, 'library.md');
      let rendered = renderLibraryMd(libs, version);
      let preservedNote = '';
      if (fs.existsSync(target)) {
        const custom = extractCustomLibraryMdSections(fs.readFileSync(target, 'utf-8'));
        if (custom) {
          rendered = rendered.replace(/\s*$/, '\n\n') + custom + '\n';
          preservedNote = ', custom sections preserved';
        }
      }
      fs.writeFileSync(target, rendered, 'utf-8');
      log.push(`library.md: ${libs.total_references} refs${preservedNote}`);
    } else {
      const pou: PouEntry[] = JSON.parse(payload);
      const projName = path.basename(escaped, '.project');
      fs.writeFileSync(path.join(projectDir, 'pou-dump.md'), renderPouDumpMd(pou, projName), 'utf-8');
      log.push(`pou-dump.md: ${pou.length} POUs`);
    }
  } catch (e) {
    log.push(`${artifact}: skipped (${e instanceof Error ? e.message : String(e)})`);
  }
}

/**
 * Pull the current version out of library.md's "Project Information.Version"
 * row, so a repair can stamp the version that is already released rather than
 * inventing a new one. Returns null when the file or row is absent.
 */
function readProjectVersionFromLibraryMd(projectDir: string): string | null {
  try {
    const md = fs.readFileSync(path.join(projectDir, 'library.md'), 'utf-8');
    const m = /Project Information\.Version\s*\|\s*`([^`]+)`/.exec(md);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Commit regenerated artefacts. No tag -- the version did not move. */
function gitCommitArtifactRepair(projectDir: string, repairLog: string[]): void {
  execSync(`git -C "${projectDir}" add "library.md" "pou-dump.md"`, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const msg =
    'Regenerate text artefact(s) missed by an earlier release\n\n' +
    repairLog.map((l) => `  - ${l}`).join('\n') + '\n';
  execSync(`git -C "${projectDir}" commit -m ${JSON.stringify(msg)}`, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function renderPouDumpMd(pou: PouEntry[], projectName: string): string {
  pou.sort((a, b) => a.path.localeCompare(b.path));
  const slugs: string[] = [];
  const seen = new Map<string, number>();
  for (const e of pou) {
    const base = gfmSlug(e.path);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.push(n === 0 ? base : `${base}-${n}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const L: string[] = [];
  L.push(`# POU dump - ${projectName}`);
  L.push('');
  L.push(`Generated ${today} from the live CODESYS instance via the [\`phobicdotno/Codesys-MCP-SP21-plus\`](https://github.com/phobicdotno/Codesys-MCP-SP21-plus) fork.`);
  L.push('');
  L.push(`**Total:** ${pou.length} objects with textual code.`);
  L.push('');
  L.push('## Index');
  L.push('');
  for (let i = 0; i < pou.length; i++) L.push(`- [${pou[i].path}](#${slugs[i]})`);
  L.push(''); L.push('---'); L.push('');
  for (const e of pou) {
    L.push(`## ${e.path}`);
    L.push('');
    if (e.declaration) { L.push('### Declaration'); L.push('```iecst'); L.push(e.declaration.replace(/\r\n/g, '\n').trimEnd()); L.push('```'); L.push(''); }
    if (e.implementation) { L.push('### Implementation'); L.push('```iecst'); L.push(e.implementation.replace(/\r\n/g, '\n').trimEnd()); L.push('```'); L.push(''); }
    L.push('');
  }
  return L.join('\n');
}

/**
 * First-run seed helper: when Project Information.Version is still empty but
 * the project's git repo already has v* release tags, seeding at 1.0.0.0
 * jumps out of the established series (observed: repo tagged v0.8.0.0, bump
 * seeded 1.0.0.0). Instead derive the seed by bumping the latest v* tag at
 * the requested level. Returns '' when there is no usable tag (then the
 * Python side falls back to the classic 1.0.0.0 seed).
 */
function seedVersionFromLatestTag(projectDir: string, level: string): string {
  let tag = '';
  try {
    tag = execSync(`git -C "${projectDir}" describe --tags --abbrev=0 --match "v*"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
  const m = tag.match(/^v(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return '';
  let [maj, min, rev, bld] = m.slice(1, 5).map(Number);
  switch (level) {
    case 'major':
      maj += 1; min = 0; rev = 0; bld = 0;
      break;
    case 'minor':
      min += 1; rev = 0; bld = 0;
      break;
    case 'revision':
      rev += 1; bld = 0;
      break;
    default:
      bld += 1;
      break;
  }
  return `${maj}.${min}.${rev}.${bld}`;
}

function classifyMcpMirrorChanges(projectDir: string, mirrorDirName: string = 'mcp-mirror'): ClassifyResult {
  const evidence: string[] = [];
  // Pathspec for git: posix-style with trailing slash. Caller passes a bare
  // directory name (relative to projectDir, no separators) so we don't need
  // to normalise; the multi-project case is e.g. 'ProjectA_mcp_mirror'.
  const pathspec = `${mirrorDirName}/`;

  const isGit = (() => {
    try {
      return (
        execSync(`git -C "${projectDir}" rev-parse --is-inside-work-tree`, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() === 'true'
      );
    } catch {
      return false;
    }
  })();
  if (!isGit) {
    evidence.push(`'${projectDir}' is not a git repo -- can't classify, treating as first-run`);
    return { kind: 'first-run', evidence };
  }

  let baseRef = '';
  try {
    baseRef = execSync(
      `git -C "${projectDir}" describe --tags --abbrev=0 --match "v*"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    evidence.push('no v* tag found -- first-run');
    return { kind: 'first-run', evidence };
  }
  evidence.push(`baseline: tag ${baseRef}`);

  let raw = '';
  try {
    // --ignore-cr-at-eol: ignore CRLF<->LF normalisation noise. CODESYS
    // lives on Windows, the share lives on Linux/Samba, and git
    // autocrlf settings can flip line endings on every checkout. Without
    // this flag the classifier reported every .st file as M after a fresh
    // checkout even though the content was identical, triggering a
    // phantom release on X33 (commit 6c23e38, reverted in 3e6f12f).
    // -w: also ignore whitespace-only changes (defensive; phantom releases
    // shouldn't fire on a stray blank line either).
    raw = execSync(
      `git -C "${projectDir}" diff --name-status --ignore-cr-at-eol -w -M50% ${baseRef} -- ${pathspec}`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch {
    evidence.push(`git diff against ${baseRef} failed -- treating as no-changes`);
    return { kind: 'no-changes', evidence };
  }

  // git diff only reports TRACKED changes. New files that mirror_export just
  // wrote are untracked from git's POV until added, and would otherwise be
  // invisible to the classifier (they wouldn't trigger a 'minor' bump even
  // though they're new public symbols). Pull them in via ls-files --others.
  // Surfaced on MCPTest2 today: adding FB_Position + FB_Random5s via
  // create_pou caused the classifier to see only 1 modified file (PLC_PRG)
  // and classify as 'revision' instead of 'minor'. The added FBs were
  // untracked at classify time.
  let untracked = '';
  try {
    untracked = execSync(
      `git -C "${projectDir}" ls-files --others --exclude-standard -- ${pathspec}`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch {
    // ls-files failure shouldn't block classification on tracked diff alone
  }

  if (!raw.trim() && !untracked.trim()) {
    evidence.push(`no changes in ${pathspec} since baseline`);
    return { kind: 'no-changes', evidence };
  }

  let hasDelete = false;
  let hasRename = false;
  let hasAdd = false;
  let hasModify = false;
  for (const line of raw.split('\n').filter((l) => l.trim())) {
    const status = line[0];
    const tab = line.indexOf('\t');
    const rest = tab >= 0 ? line.substring(tab + 1) : '';
    if (status === 'D') {
      hasDelete = true;
      evidence.push(`deleted: ${rest}`);
    } else if (status === 'R') {
      hasRename = true;
      evidence.push(`renamed: ${rest}`);
    } else if (status === 'A') {
      hasAdd = true;
      evidence.push(`added: ${rest}`);
    } else if (status === 'M') {
      hasModify = true;
      evidence.push(`modified: ${rest}`);
    }
  }
  for (const line of untracked.split('\n').filter((l) => l.trim())) {
    hasAdd = true;
    evidence.push(`added (untracked): ${line}`);
  }

  if (hasDelete || hasRename) return { kind: 'bump', level: 'major', evidence };
  if (hasAdd) return { kind: 'bump', level: 'minor', evidence };
  if (hasModify) return { kind: 'bump', level: 'revision', evidence };
  return { kind: 'no-changes', evidence };
}

/**
 * IEC 61131-3 identifiers that are reserved for time-literal suffixes or
 * standard-block I/O conventions. Using these as variable names produces
 * red-underlined warnings or compile errors in CODESYS.
 *
 *   s/t/d/m/h/ms/us/ns -> time-literal suffixes (T#5s, T#100ms, etc.)
 *   S/R                -> SR/RS flip-flop input names
 *
 * The set is lowercased separately from the original casing -- we check
 * exact-match (case-sensitive) so we catch both 's' and 'S' separately.
 */
const RESERVED_IEC_IDENTIFIERS = new Set([
  's', 't', 'd', 'm', 'h', 'ms', 'us', 'ns',
  'S', 'R',
]);

/**
 * IEC 61131-3 ST reserved KEYWORDS -- these are rejected by the CODESYS
 * compiler when used as variable names, case-INSENSITIVELY (IEC identifiers
 * and keywords are case-insensitive; `by`, `By`, and `BY` are all the FOR-loop
 * step keyword). Found the hard way 2026-07-16: `by : BYTE;` fails to compile.
 *
 * Sources: IEC 61131-3 (3rd ed.) keyword tables; CODESYS export-format keyword
 * list (content.helpme-codesys.com _cds_keywords.html). Compiler OPERATOR
 * names (SIN, DIV, MIN, MAX, ...) live in CODESYS_OPERATOR_KEYWORDS below;
 * they were excluded here until 2026-09-07, when 'sIn' and 'diV' proved the
 * compiler rejects them too. Extend only with words the compiler provably
 * refuses.
 */
const RESERVED_IEC_KEYWORDS = new Set([
  // Control flow
  'IF', 'THEN', 'ELSE', 'ELSIF', 'END_IF',
  'CASE', 'OF', 'END_CASE',
  'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE',
  'REPEAT', 'UNTIL', 'END_REPEAT',
  'RETURN', 'EXIT', 'CONTINUE', 'JMP',
  // Boolean / arithmetic operator keywords
  'AND', 'OR', 'XOR', 'NOT', 'MOD', 'AND_THEN', 'OR_ELSE',
  // POU / scope structure
  'PROGRAM', 'END_PROGRAM',
  'FUNCTION', 'END_FUNCTION',
  'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
  'METHOD', 'END_METHOD',
  'PROPERTY', 'END_PROPERTY',
  'INTERFACE', 'END_INTERFACE',
  'ACTION', 'END_ACTION',
  'STRUCT', 'END_STRUCT',
  'TYPE', 'END_TYPE',
  'UNION', 'END_UNION',
  'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL',
  'VAR_TEMP', 'VAR_STAT', 'VAR_EXTERNAL', 'VAR_ACCESS', 'VAR_CONFIG',
  'END_VAR',
  'CONSTANT', 'RETAIN', 'PERSISTENT', 'AT',
  'READ_ONLY', 'READ_WRITE',
  // Elementary / generic types
  'BOOL', 'BIT', 'BYTE', 'WORD', 'DWORD', 'LWORD',
  'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT',
  'REAL', 'LREAL', 'STRING', 'WSTRING',
  'TIME', 'LTIME', 'DATE', 'LDATE', 'TIME_OF_DAY', 'TOD', 'DATE_AND_TIME', 'DT',
  'ARRAY', 'POINTER', 'REFERENCE',
  'ANY', 'ANY_BIT', 'ANY_DATE', 'ANY_INT', 'ANY_NUM', 'ANY_REAL', 'ANY_STRING',
  // Literals / OOP
  'TRUE', 'FALSE',
  'EXTENDS', 'IMPLEMENTS', 'THIS', 'SUPER', 'ABSTRACT',
  'PUBLIC', 'PRIVATE', 'PROTECTED', 'INTERNAL',
  // CODESYS operators that are keywords in declarations/expressions
  'ADR', 'SIZEOF', 'BITADR', '__NEW', '__DELETE', '__TRY', '__CATCH', '__FINALLY', '__ENDTRY',
]);

/**
 * CODESYS compiler OPERATORS (implemented in the compiler, not in a library).
 * IEC identifiers are case-insensitive, so ANY casing of these collides:
 * found the hard way 2026-09-07 - a method input named 'sIn' parsed as the
 * SIN operator and a local 'diV' as DIV, producing a 34-error cascade in
 * SP21 P5. Library functions (LEN, MID, CONCAT, ...) are deliberately NOT
 * listed: they are ordinary POUs that can be shadowed, not compiler tokens.
 */
const CODESYS_OPERATOR_KEYWORDS = new Set([
  // Arithmetic
  'ADD', 'SUB', 'MUL', 'DIV', 'MOVE', 'INDEXOF',
  // Math
  'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN',
  'EXP', 'EXPT', 'LN', 'LOG', 'SQRT', 'ABS', 'TRUNC',
  // Bit shift
  'SHL', 'SHR', 'ROL', 'ROR',
  // Selection
  'SEL', 'MAX', 'MIN', 'LIMIT', 'MUX',
]);

/**
 * Scan an IEC declarationCode block for VAR declarations whose variable
 * name collides with a reserved identifier. Returns one warning string
 * per offending name. Empty list if the input is empty/safe.
 *
 * Pattern matches lines of the form `<name> : <type>` and is line-anchored
 * so it ignores struct member access (`fb.s`) and similar non-declarations.
 * Catches the first name in each line; multi-name lists like
 * `s, t : BOOL;` only catch the last comma-separated name (rare but
 * worth a future tightening).
 */
export function findReservedIecIdentifiers(declarationCode: string | undefined): string[] {
  if (!declarationCode) return [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  // Match declaration lines `<name>[, <name>...] [AT %XX] : <type>` and check
  // EVERY comma-separated name, not just the first/last one.
  const pattern = /^\s*((?:[A-Za-z_][A-Za-z0-9_]*\s*,\s*)*[A-Za-z_][A-Za-z0-9_]*)\s*(?:AT\s+%[\w.]+\s*)?:\s*[A-Za-z_]/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(declarationCode)) !== null) {
    for (const rawName of match[1].split(',')) {
      const name = rawName.trim();
      if (!name || seen.has(name)) continue;
      if (RESERVED_IEC_KEYWORDS.has(name.toUpperCase())) {
        seen.add(name);
        warnings.push(
          `'${name}' is an IEC 61131-3 reserved keyword (keywords are case-insensitive: ` +
          `'by'/'By'/'BY' are all the FOR-loop step keyword) and cannot be a variable name. ` +
          `Rename it (e.g. '${name}Val', or a Hungarian-style prefix like 'st'/'fb'/'b'/'n').`
        );
      } else if (CODESYS_OPERATOR_KEYWORDS.has(name.toUpperCase())) {
        seen.add(name);
        warnings.push(
          `'${name}' collides with the CODESYS compiler operator '${name.toUpperCase()}' ` +
          `(IEC identifiers are case-insensitive: 'sIn' IS the SIN operator, 'diV' IS DIV). ` +
          `Operators are compiler tokens and cannot be identifiers. ` +
          `Rename it (e.g. '${name}Val', 'sText' instead of 'sIn').`
        );
      } else if (RESERVED_IEC_IDENTIFIERS.has(name)) {
        seen.add(name);
        warnings.push(
          `Reserved IEC identifier '${name}' used as variable name. ` +
          `Single-letter names like s/t/d/m/h/ms/us/ns are time-literal suffixes (T#5s, T#100ms); ` +
          `S/R conflict with SR/RS flip-flop semantics. ` +
          `Rename to a meaningful identifier (e.g. '${name}Inst', '${name}Sample', or use a Hungarian-style prefix like 'st'/'fb'/'b'/'n').`
        );
      }
    }
  }
  return warnings;
}

// Zod enums for POU tools
const PouTypeEnum = z.enum(['Program', 'FunctionBlock', 'Function']);
const ImplementationLanguageEnum = z.enum([
  'ST', 'LD', 'FBD', 'SFC', 'IL', 'CFC',
  'StructuredText', 'LadderDiagram', 'FunctionBlockDiagram',
  'SequentialFunctionChart', 'InstructionList', 'ContinuousFunctionChart',
]);

/** Resolve a file path to an absolute normalized path */
function resolvePath(filePath: string, workspaceDir: string): string {
  return path.normalize(
    path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath)
  );
}

/** Sanitize a POU path (forward slashes, no leading/trailing slashes) */
function sanitizePouPath(pouPath: string): string {
  return pouPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * Escape an arbitrary string into a double-quoted Python string literal,
 * for interpolating user-supplied values (expressions, values) into
 * script templates as list/tuple elements.
 */
function pyStringLiteral(s: string): string {
  return '"' + s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n') + '"';
}

/** Python boolean literal from a JS boolean. */
function pyBool(b: boolean): string {
  return b ? 'True' : 'False';
}

/** Shared description for the optional applicationPath argument (multi-device projects). */
const APP_PATH_DESC =
  "Multi-device projects only: which application to act on, given as the full path ('Master/Plc Logic/Application'), " +
  "the device name ('Master'), or a unique application name. It becomes the project's active application before the tool runs. " +
  "Omit for single-device projects or to use the current active application. See list_applications.";

/** Python literal for the APPLICATION_PATH placeholder of the select_application helper. */
function appPathLiteral(applicationPath: string | undefined): string {
  return pyStringLiteral((applicationPath ?? '').trim());
}

/** Format an IpcResult into an MCP tool response */
function formatToolResponse(
  result: IpcResult,
  successMessage: string
): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  const success = result.success && result.output.includes('SCRIPT_SUCCESS');
  return {
    content: [
      {
        type: 'text' as const,
        text: success
          ? successMessage
          : `Operation failed. Output:\n${result.output}${result.error ? '\nError: ' + result.error : ''}`,
      },
    ],
    isError: !success,
  };
}

/**
 * Auto-mirror context threaded through tools that modify the project.
 * When --auto-mirror is on, every successful edit triggers a follow-up
 * mirror_export so an external editor watching <projectDir>/mcp-mirror/
 * sees the change immediately. Best-effort VSCode integration also opens
 * the mirror dir in the user's active VSCode window once per project.
 */
interface MirrorCtx {
  autoMirror: boolean;
  scriptManager: ScriptManager;
  executor: ScriptExecutor;
  workspaceDir: string;
  /** Mirror dirs already added to VSCode this session (per absolute path). */
  openedInVscode: Set<string>;
  /** Absolute path to the VSCode `code` CLI shim, or null if not found. */
  vscodeCli: string | null;
}

/**
 * Locate the VSCode CLI shim on Windows. The shim (code.cmd) is what you
 * want to call from a script -- the bare code.exe is the GUI binary and
 * doesn't behave the same way for --add / --reuse-window flags.
 *
 * Returns absolute path to the .cmd shim, or null if not found.
 * Best-effort, no error -- the auto-mirror feature still works without
 * VSCode integration; the user just doesn't get the auto-pop into the
 * Source Control panel.
 */
function findVscodeCli(): string | null {
  if (process.platform !== 'win32') return null;
  const candidates = [
    path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Microsoft VS Code', 'bin', 'code.cmd'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft VS Code', 'bin', 'code.cmd'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Best-effort: add <projectDir>/mcp-mirror to the user's active VSCode
 * window so they see the source-control diff appear after each edit.
 * No-op if VSCode CLI wasn't found, if we've already opened this dir
 * this session, or if the spawn itself fails. Never blocks the tool
 * response: spawned detached + unref'd.
 */
function maybeOpenMirrorInVscode(projectFilePath: string, ctx: MirrorCtx): void {
  if (!ctx.vscodeCli) return;
  // Resolve via the same rule the CODESYS-side mirror_export.py uses, so
  // the dir we ask VSCode to open is the dir mirror_export actually wrote
  // to (single-project parents stay on the legacy mcp-mirror/ path; multi-
  // project parents get a per-project <basename>_mcp_mirror/ path).
  const mirrorDir = resolveMirrorRoot(projectFilePath);
  const key = mirrorDir.toLowerCase();
  if (ctx.openedInVscode.has(key)) return;
  if (!fs.existsSync(mirrorDir)) return; // mirror_export hasn't created it yet on this call
  ctx.openedInVscode.add(key);
  try {
    // --add appends the folder to the last active window's workspace, which
    // makes it show up in Explorer + Source Control without opening a new
    // window. Detached + unref so the launcher doesn't hold a handle to
    // VSCode after the spawn returns.
    const child = require('child_process').spawn(
      ctx.vscodeCli,
      ['--add', mirrorDir],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    child.unref();
  } catch {
    // Swallow -- VSCode integration is a UX enhancement, never a blocker.
  }
}

/**
 * Guards every tool that opens a .project against a CODESYS version mismatch.
 *
 * The `open_project` pre-flight in src/preflight.ts was meant to do this, but
 * it depends on src/inspect.ts reading the version out of the project ZIP --
 * and a .project is not a ZIP, so inspection always throws and the pre-flight
 * proceeds anyway. src/version-pin.ts reads the version from the repo instead.
 *
 * Returns an error response to return verbatim, or a (possibly empty) warning
 * prefix for the success message.
 */
function enforceVersionPin(
  projectFilePath: string,
  opts: { saves: boolean; allowUpgrade?: boolean; profileName: string }
): { error?: { content: { type: 'text'; text: string }[]; isError: true }; warning: string } {
  try {
    const serverProfile = parseProfileName(opts.profileName) ?? undefined;
    const pin = resolveVersionPin(projectFilePath);
    const decision = decideVersionPin(pin, serverProfile, {
      saves: opts.saves,
      allowUpgrade: opts.allowUpgrade,
      projectFilePath,
    });
    if (decision.action === 'refuse') {
      return {
        error: { content: [{ type: 'text' as const, text: decision.message }], isError: true },
        warning: '',
      };
    }
    if (decision.action === 'proceed-with-warning') {
      return { warning: decision.message + '\n' };
    }
    return { warning: '' };
  } catch (e) {
    // A broken guard must never block legitimate work; log and fall through.
    serverLog.warn(
      `version-pin check failed (proceeding): ${e instanceof Error ? e.message : String(e)}`
    );
    return { warning: '' };
  }
}

async function maybeAutoMirror(
  projectFilePath: string,
  editResult: IpcResult,
  ctx: MirrorCtx
): Promise<string> {
  if (!ctx.autoMirror) return '';
  // Don't mirror after a failed edit -- nothing to refresh, and the error
  // will already dominate the response.
  const editSucceeded = editResult.success && editResult.output.includes('SCRIPT_SUCCESS');
  if (!editSucceeded) return '';
  try {
    const script = ctx.scriptManager.prepareScriptWithHelpers(
      'mirror_export',
      { PROJECT_FILE_PATH: projectFilePath, MIRROR_ROOT: '' },
      ['ensure_project_open']
    );
    const mirrorResult = await ctx.executor.executeScript(script);
    const mirrorOk = mirrorResult.success && mirrorResult.output.includes('SCRIPT_SUCCESS');
    if (mirrorOk) {
      maybeOpenMirrorInVscode(projectFilePath, ctx);
      return '\n(auto-mirror: refreshed)';
    }
    return `\n(auto-mirror: FAILED -- ${mirrorResult.error ?? 'see CODESYS log'})`;
  } catch (err) {
    return `\n(auto-mirror: FAILED -- ${(err as Error).message})`;
  }
}

/**
 * Like formatToolResponse but additionally runs maybeAutoMirror so the
 * response carries a one-line auto-mirror status when --auto-mirror is on.
 * Use for tools that modify the .project file. Tools that only read should
 * keep using formatToolResponse directly.
 */
async function formatModifyingResponse(
  result: IpcResult,
  successMessage: string,
  projectFilePath: string,
  mirrorCtx: MirrorCtx
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }> {
  const mirrorNote = await maybeAutoMirror(projectFilePath, result, mirrorCtx);
  return formatToolResponse(result, successMessage + mirrorNote);
}

/** Check if a file exists (async) */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    fs.statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function buildGetUserSelectionResponse(stateFilePath: string) {
  const r = await readSelection(stateFilePath);
  if (r.status === 'ok') {
    const lines = [
      `User is currently looking at:`,
      `  Device:  ${r.payload.device}`,
      `  POU:     ${r.payload.selection.name} (${r.payload.selection.kind})`,
      `  Path:    ${r.payload.selection.path}`,
      `  AbsPath: ${r.payload.selection.abs_path}`,
      `  Project: ${r.payload.project_dir}`,
      `  Viewer line: ${r.payload.viewer_line}`,
      `  Updated: ${r.payload.updated_at}`,
    ];
    return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: false };
  }
  if (r.status === 'invalid') {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Invalid TUI state file: ${r.reason}. No active selection.`,
        },
      ],
      isError: false,
    };
  }
  return {
    content: [{ type: 'text' as const, text: 'No active selection (TUI not running or stale).' }],
    isError: false,
  };
}

function defaultStateDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      return path.join(os.homedir(), 'AppData', 'Local', 'codesys-mcp');
    }
    return path.join(localAppData, 'codesys-mcp');
  }
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg ?? path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'codesys-mcp');
}

function defaultStateFilePath(): string {
  return path.join(defaultStateDir(), 'tui-state.json');
}

function defaultLiveValuesFilePath(): string {
  return path.join(defaultStateDir(), 'tui-live-values.json');
}

export async function startMcpServer(config: ServerConfig): Promise<void> {
  // Set log level
  if (config.debug) setLogLevel('debug');
  else if (config.verbose) setLogLevel('info');

  serverLog.info(`Starting CODESYS Persistent MCP Server v0.1.0`);
  serverLog.info(`Mode: ${config.mode}`);
  serverLog.info(`Live values: ${config.liveValues ? 'ON' : 'off'}`);
  serverLog.info(`CODESYS Path: ${config.codesysPath}`);
  serverLog.info(`Profile: ${config.profileName}`);
  serverLog.info(`Workspace: ${config.workspaceDir}`);

  // Validate CODESYS path
  if (!fs.existsSync(config.codesysPath)) {
    throw new Error(`CODESYS executable not found: ${config.codesysPath}`);
  }

  // Initialize executor based on mode
  let executor: ScriptExecutor;
  let launcher: CodesysLauncher | null = null;
  let executionMode: ExecutionMode = config.mode;

  if (config.mode === 'persistent') {
    launcher = new CodesysLauncher(config);
    // In persistent mode the executor is ALWAYS the lazy wrapper: it
    // launches the visible IDE on the first tool call that needs it and
    // relaunches after shutdown_codesys / a crashed instance. There is no
    // silent --noUI fallback in persistent mode (headless spawns pop
    // invisible dialogs, hold project locks and orphan CODESYS.exe).
    executor = new LazyPersistentExecutor(launcher);

    if (config.autoLaunch) {
      try {
        await launcher.launch();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string } | undefined)?.code;
        serverLog.error(`Persistent launch failed: ${errMsg}`);
        if (code === 'CODESYS_LAUNCH_CONFLICT') {
          // Don't kill the server over a stray same-install CODESYS process
          // -- the model can resolve this from chat by calling launch_codesys
          // with killExisting=true. The lazy executor keeps the server useful
          // and surfaces the conflict verbatim on the next tool call.
          serverLog.warn(
            'Staying connected despite launch conflict; call launch_codesys with killExisting=true to resolve.'
          );
        } else if (config.fallbackHeadless) {
          serverLog.warn(
            'Falling back to headless mode (--fallback-headless given). ' +
            'Headless spawns are invisible: dialogs abort silently and project locks linger.'
          );
          executor = new HeadlessExecutor(config);
          executionMode = 'headless';
        } else {
          throw err;
        }
      }
    }
    // --no-auto-launch under persistent: nothing to do here. The lazy
    // executor launches the visible IDE on first use; executionMode stays
    // 'persistent' so get_codesys_status reflects the configured intent.
  } else {
    executor = new HeadlessExecutor(config);
  }

  const scriptManager = new ScriptManager();

  // Auto-mirror context shared by every modifying tool. When --auto-mirror
  // is enabled, formatModifyingResponse triggers a follow-up mirror_export
  // after each successful edit, and (best-effort) opens the resulting
  // <projectDir>/mcp-mirror/ folder in VSCode so the user sees the diff
  // in the Source Control panel immediately. The set tracks which mirror
  // dirs we've already opened in VSCode this session so we don't spam.
  const mirrorCtx: MirrorCtx = {
    autoMirror: config.autoMirror,
    scriptManager,
    executor,
    workspaceDir: config.workspaceDir,
    openedInVscode: new Set<string>(),
    vscodeCli: findVscodeCli(),
  };
  const workspaceDir = config.workspaceDir;

  // Create MCP server
  const server = new McpServer(
    {
      name: 'CODESYS Persistent MCP Server',
      version: '0.1.0',
    },
    {
      capabilities: {
        resources: { listChanged: true },
        tools: { listChanged: true },
      },
    }
  );

  // Note: using 'as any' cast on server for tool() calls to work around
  // TS2589 deep type instantiation with MCP SDK generics + Zod.
  const s = server as any;

  // ─── Editor-view pressure guard ──────────────────────────────────────
  // Every scripted textual edit / object creation opens an editor view in
  // the visible IDE, and the ScriptEngine has NO API to close views
  // (ScriptCommands is lookup-only; editors are invisible to UIA). After
  // ~40-60 edits the IDE runs out of UI resources ("Please close some
  // views") and every script call starts timing out. Mitigation: before
  // the Nth edit since the last flush, close+reopen the project (disposes
  // all views, ~seconds). Threshold via CODESYS_EDITOR_FLUSH_THRESHOLD
  // (default 20; 0 disables).
  let editorViewEdits = 0;
  const editorFlushThreshold = (() => {
    const raw = process.env.CODESYS_EDITOR_FLUSH_THRESHOLD;
    if (raw === undefined || raw === '') return 20;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 20;
  })();
  const maybeFlushEditorViews = async (): Promise<string> => {
    editorViewEdits++;
    if (editorFlushThreshold === 0 || editorViewEdits < editorFlushThreshold) return '';
    const script = scriptManager.prepareScript('flush_editor_views', {});
    const res = await executor.executeScript(script, 120_000);
    editorViewEdits = 0;
    if (res.success) {
      serverLog.info(`editor-view flush: project closed+reopened after ${editorFlushThreshold} edits.`);
      return `NOTE: editor views flushed (project close/reopen) to prevent IDE UI-resource exhaustion.\n`;
    }
    serverLog.warn(`editor-view flush failed (continuing): ${res.error ?? 'unknown'}`);
    return `WARN: editor-view flush failed -- if the IDE warns about low UI resources, run shutdown_codesys and retry.\n`;
  };

  // ─── Management Tools ────────────────────────────────────────────────

  s.tool(
    'launch_codesys',
    "Manually launch CODESYS with UI. Use when --no-auto-launch was set, or when auto-launch was blocked by a same-install conflict (the server stays connected and surfaces the conflict via get_codesys_status so this tool can resolve it).",
    {
      killExisting: z.boolean().optional().describe("If true, taskkill any same-install CODESYS.exe processes (typically orphans from a prior MCP session) before launching. Default false -- the launcher refuses to spawn alongside a foreign same-install instance it can't IPC into. Only same-install PIDs are killed; other CODESYS installs are unaffected."),
    },
    async (args: { killExisting?: boolean }) => {
      if (!launcher) {
        return {
          content: [{ type: 'text' as const, text: 'Persistent mode not configured. Use --mode persistent.' }],
          isError: true,
        };
      }
      try {
        await launcher.launch({ killExisting: args.killExisting === true });
        executionMode = 'persistent';
        return {
          content: [{ type: 'text' as const, text: 'CODESYS launched successfully in persistent mode.' }],
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Launch failed: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  s.tool(
    'launch_codesys_with_project',
    "Launch a (potentially different) CODESYS install and open a project in it -- detached from this MCP. Useful for cross-version inspection (e.g. opening an SP22-saved project in an SP21 IDE for a SIM workflow), or for opening a project in an install this MCP isn't bound to. The launched IDE is NOT managed by this server: no IPC, no watcher, no shutdown_codesys. This is intentional -- the goal is just to hand the user a running IDE on a chosen install.",
    {
      projectFilePath: z.string().describe("Path to the .project file to open. Forward or back slashes both work."),
      codesysPath: z.string().optional().describe("Optional override for the CODESYS.exe to launch. Defaults to this server's configured --codesys-path. Use to launch a DIFFERENT install (e.g. SP21 while this server runs SP22)."),
      profileName: z.string().optional().describe("Optional --Profile= value for the launched IDE (e.g. 'CODESYS V3.5 SP21 Patch 5'). Omit to let CODESYS pick the project's saved profile or its install default. Mismatched profiles will pop the IDE's profile-conversion dialog -- which is sometimes exactly what you want."),
    },
    async (args: { projectFilePath: string; codesysPath?: string; profileName?: string }) => {
      const targetExe = (args.codesysPath ?? config.codesysPath).trim();
      const projectPath = resolvePath(args.projectFilePath, workspaceDir);
      if (!fs.existsSync(targetExe)) {
        return { content: [{ type: 'text' as const, text: `CODESYS executable not found: ${targetExe}` }], isError: true };
      }
      // Strip the surrounding single-quotes that resolvePath() adds for use as
      // a Python string literal. The shell spawn below quotes argv itself.
      const cleanProjectPath = projectPath.replace(/^'|'$/g, '');
      const uncErr = uncPathError(cleanProjectPath);
      if (uncErr) {
        return { content: [{ type: 'text' as const, text: uncErr }], isError: true };
      }
      if (!fs.existsSync(cleanProjectPath)) {
        return { content: [{ type: 'text' as const, text: `Project file not found: ${cleanProjectPath}` }], isError: true };
      }
      try {
        const { spawn } = require('child_process') as typeof import('child_process');
        const argv: string[] = [];
        if (args.profileName) argv.push(`--Profile=${args.profileName}`);
        argv.push(cleanProjectPath);
        const child = spawn(targetExe, argv, { detached: true, stdio: 'ignore' });
        child.unref();
        const profileHint = args.profileName ? ` --Profile="${args.profileName}"` : '';
        return {
          content: [{
            type: 'text' as const,
            text: `Launched ${targetExe}${profileHint} with project ${cleanProjectPath}. PID ${child.pid ?? 'unknown'}. The IDE is detached -- this MCP does not manage its lifecycle.`,
          }],
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Launch failed: ${msg}` }], isError: true };
      }
    }
  );

  s.tool(
    'shutdown_codesys',
    'Shut down the persistent CODESYS instance.',
    async () => {
      if (!launcher) {
        return {
          content: [{ type: 'text' as const, text: 'No persistent CODESYS instance to shut down.' }],
          isError: true,
        };
      }
      try {
        await launcher.shutdown();
        // Executor stays the lazy persistent wrapper: the next tool call
        // relaunches the visible IDE. Never degrade to headless here --
        // that silently spawned invisible CODESYS.exe per command.
        return {
          content: [{ type: 'text' as const, text: 'CODESYS shut down successfully. The next tool call will relaunch the IDE.' }],
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Shutdown failed: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  s.tool(
    'get_codesys_status',
    'Get the current status of the CODESYS instance (state, PID, mode).',
    async () => {
      const status = launcher ? launcher.getStatus() : {
        state: 'stopped',
        pid: null,
        sessionId: null,
        ipcDir: null,
        startedAt: null,
        lastError: null,
      };
      const text = [
        `State: ${status.state}`,
        `Mode: ${executionMode}`,
        `PID: ${status.pid ?? 'N/A'}`,
        `Session: ${status.sessionId ?? 'N/A'}`,
        `Started: ${status.startedAt ? new Date(status.startedAt).toISOString() : 'N/A'}`,
        status.lastError ? `Last Error: ${status.lastError}` : null,
      ].filter(Boolean).join('\n');
      return {
        content: [{ type: 'text' as const, text }],
        isError: false,
      };
    }
  );

  s.tool(
    'get_user_selection',
    'Get the POU the user is currently looking at in the phobiCS-tui browser, if any. Returns a freshness-checked snapshot from the TUI state file. Useful for grounding modifying tool calls in what the user has selected.',
    async () => buildGetUserSelectionResponse(defaultStateFilePath())
  );

  // ─── Project Tools ───────────────────────────────────────────────────

  s.tool(
    'open_project',
    'Opens an existing CODESYS project file.',
    {
      filePath: z.string().describe("Path to the project file (e.g., 'C:/Projects/MyPLC.project')."),
    },
    async (args: { filePath: string }) => {
      const escaped = resolvePath(args.filePath, workspaceDir);

      const uncErr = uncPathError(escaped);
      if (uncErr) {
        return { content: [{ type: 'text' as const, text: uncErr }], isError: true };
      }

      // Pre-flight: compare the project's saved profile against this
      // server's configured profile. Refuses on SP mismatch, warns on
      // patch mismatch, silent on exact match. Falls through silently
      // (logs only) if anything in the chain fails -- the existing open
      // path then surfaces CODESYS's native error.
      let preflightWarning = '';
      try {
        const serverProfile = parseProfileName(config.profileName);
        if (serverProfile) {
          const insp = await inspectProjectFile(escaped);
          const decision = decideOpenProjectPreflight(
            { sp: insp.sp, patch: insp.patch, profileName: insp.profileName, profileVersion: insp.profileVersion },
            serverProfile,
            escaped
          );
          if (decision.action === 'refuse') {
            return {
              content: [{ type: 'text' as const, text: decision.message ?? 'Refused' }],
              isError: true,
            };
          }
          if (decision.action === 'proceed-with-warning' && decision.message) {
            preflightWarning = decision.message + '\n';
          }
        }
        // serverProfile null -> non-standard profile name, can't compare; fall through.
      } catch (e) {
        serverLog.warn(
          `open_project pre-flight inspection failed (proceeding anyway): ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }

      const script = scriptManager.prepareScriptWithHelpers(
        'open_project', { PROJECT_FILE_PATH: escaped }, ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(
        result,
        `${preflightWarning}Project opened: ${args.filePath}`,
        escaped,
        mirrorCtx
      );
    }
  );

  s.tool(
    'create_project',
    "Creates a new CODESYS project from the standard template. Optional `deviceName` -- if supplied, the script swaps the template's default device for the device whose display name matches (substring + highest-version match). Use this when the template's default target (typically PLCWinNT) isn't installed on the host machine and you want, e.g., 'CODESYS Control Win V3 x64' instead. The swap uses ScriptDeviceObject.update() which preserves the Application/POU/library subtree underneath. Empty/omitted = keep the template default.",
    {
      filePath: z.string().describe("Path where the new project file should be created."),
      deviceName: z.string().optional().describe("Optional. Substring of the device display name (e.g. 'CODESYS Control Win V3 x64'). Highest-version match wins. Omit to keep the template's default device."),
    },
    async (args: { filePath: string; deviceName?: string }) => {
      const absPath = path.normalize(
        path.isAbsolute(args.filePath) ? args.filePath : path.join(workspaceDir, args.filePath)
      );

      const uncErr = uncPathError(absPath);
      if (uncErr) {
        return { content: [{ type: 'text' as const, text: uncErr }], isError: true };
      }

      // Find template project
      let templatePath = '';
      try {
        const baseDir = path.dirname(path.dirname(config.codesysPath));
        templatePath = path.normalize(path.join(baseDir, 'Templates', 'Standard.project'));
        if (!(await fileExists(templatePath))) {
          const programData = process.env.ALLUSERSPROFILE || process.env.ProgramData || 'C:\\ProgramData';
          const pd1 = path.normalize(path.join(programData, 'CODESYS', 'CODESYS', config.profileName, 'Templates', 'Standard.project'));
          if (await fileExists(pd1)) {
            templatePath = pd1;
          } else {
            const pd2 = path.normalize(path.join(programData, 'CODESYS', 'Templates', 'Standard.project'));
            if (await fileExists(pd2)) {
              templatePath = pd2;
            } else {
              throw new Error('Standard template project file not found.');
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text' as const, text: `Template Error: ${msg}` }],
          isError: true,
        };
      }

      const script = scriptManager.prepareScript('create_project', {
        PROJECT_FILE_PATH: absPath,
        TEMPLATE_PROJECT_PATH: templatePath,
        DEVICE_NAME: (args.deviceName ?? '').trim(),
      });
      const result = await executor.executeScript(script);
      const deviceNote = args.deviceName ? ` (device set to '${args.deviceName.trim()}')` : '';
      return await formatModifyingResponse(result, `Project created from template: ${absPath}${deviceNote}`, absPath, mirrorCtx);
    }
  );

  s.tool(
    'save_project',
    'Saves the currently open CODESYS project.',
    {
      projectFilePath: z.string().describe("Path to the project file to ensure is open before saving."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const uncErr = uncPathError(escaped);
      if (uncErr) {
        return { content: [{ type: 'text' as const, text: uncErr }], isError: true };
      }
      const script = scriptManager.prepareScriptWithHelpers(
        'save_project', { PROJECT_FILE_PATH: escaped }, ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(result, `Project saved: ${args.projectFilePath}`, escaped, mirrorCtx);
    }
  );

  // ─── POU Tools ───────────────────────────────────────────────────────

  s.tool(
    'create_pou',
    'Creates a new Program, Function Block, or Function POU within the specified CODESYS project. Pass declarationCode/implementationCode to set the POU body in the same call (otherwise the POU is created with the IDE default stub and needs a follow-up set_pou_code).',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      name: z.string().describe("Name for the new POU (must be a valid IEC identifier)."),
      type: z.string().describe("Type of POU: Program, FunctionBlock, or Function."),
      language: z.string().describe("Implementation language: ST, LD, FBD, SFC, IL, or CFC."),
      parentPath: z.string().describe("Relative path under project root or application (e.g., 'Application')."),
      declarationCode: z.string().optional().describe("Full declaration part (PROGRAM/FUNCTION_BLOCK ... VAR...END_VAR) to apply after creation. ST only."),
      implementationCode: z.string().optional().describe("Implementation logic to apply after creation. ST only."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; name: string; type: string; language: string; parentPath: string; declarationCode?: string; implementationCode?: string }) => {
      // Same reserved-identifier gate as set_pou_code: refuse before touching the project.
      const reservedWarnings = findReservedIecIdentifiers(args.declarationCode);
      if (reservedWarnings.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Refused: declarationCode contains IEC reserved identifier(s). POU NOT created. Fix and retry.\n\n  - ${reservedWarnings.join('\n  - ')}`,
          }],
          isError: true,
        };
      }
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanParentPath = sanitizePouPath(args.parentPath);
      const sanDecl = (args.declarationCode ?? '').replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
      const sanImpl = (args.implementationCode ?? '').replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
      const script = scriptManager.prepareScriptWithHelpers(
        'create_pou',
        {
          PROJECT_FILE_PATH: escProjPath, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          POU_NAME: args.name.trim(),
          POU_TYPE_STR: args.type,
          IMPL_LANGUAGE_STR: args.language,
          PARENT_PATH: sanParentPath,
          DECLARATION_CONTENT: sanDecl,
          IMPLEMENTATION_CONTENT: sanImpl,
          SET_DECLARATION: args.declarationCode !== undefined ? 'True' : 'False',
          SET_IMPLEMENTATION: args.implementationCode !== undefined ? 'True' : 'False',
        },
        ['ensure_project_open', 'select_application', 'find_object_by_path']
      );
      const flushNote = await maybeFlushEditorViews();
      const result = await executor.executeScript(script);
      const withCode = (args.declarationCode !== undefined || args.implementationCode !== undefined) ? ' Code applied.' : '';
      return await formatModifyingResponse(
        result,
        `${flushNote}POU '${args.name}' created in '${sanParentPath}' of ${args.projectFilePath}.${withCode} Project saved.`,
        escProjPath,
        mirrorCtx
      );
    }
  );

  s.tool(
    'set_pou_code',
    'Sets the declaration and/or implementation code for a specific POU, Method, or Property.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      pouPath: z.string().describe("Full relative path to the target object (e.g., 'Application/MyPOU')."),
      declarationCode: z.string().optional().describe("Code for the declaration part (VAR...END_VAR). If omitted, not changed."),
      implementationCode: z.string().optional().describe("Code for the implementation logic. If omitted, not changed."),
    },
    async (args: { projectFilePath: string; pouPath: string; declarationCode?: string; implementationCode?: string }) => {
      if (args.declarationCode === undefined && args.implementationCode === undefined) {
        return {
          content: [{ type: 'text' as const, text: 'Error: At least one of declarationCode or implementationCode must be provided.' }],
          isError: true,
        };
      }
      // Block on IEC reserved identifiers in declarationCode BEFORE
      // touching the project. Better to refuse than to half-set then
      // surface a soft warning the caller might miss.
      const reservedWarnings = findReservedIecIdentifiers(args.declarationCode);
      if (reservedWarnings.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Refused: declarationCode contains IEC reserved identifier(s). Project NOT modified. Fix and retry.\n\n  - ${reservedWarnings.join('\n  - ')}`,
          }],
          isError: true,
        };
      }
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanPouPath = sanitizePouPath(args.pouPath);
      // Escape for triple-quoted Python strings
      const sanDecl = (args.declarationCode ?? '').replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
      const sanImpl = (args.implementationCode ?? '').replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
      // Distinguish "argument provided" from "argument is empty string". An
      // omitted declaration must NOT reach decl_obj.replace('') -- doing so
      // wipes the POU's PROGRAM/VAR...END_VAR block, leaving an UNKNOWN POU.
      const setDecl = args.declarationCode !== undefined ? 'True' : 'False';
      const setImpl = args.implementationCode !== undefined ? 'True' : 'False';
      const script = scriptManager.prepareScriptWithHelpers(
        'set_pou_code',
        {
          PROJECT_FILE_PATH: escProjPath,
          POU_FULL_PATH: sanPouPath,
          DECLARATION_CONTENT: sanDecl,
          IMPLEMENTATION_CONTENT: sanImpl,
          SET_DECLARATION: setDecl,
          SET_IMPLEMENTATION: setImpl,
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const flushNote = await maybeFlushEditorViews();
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(
        result,
        `${flushNote}Code set for '${sanPouPath}' in ${args.projectFilePath}. Project saved.`,
        escProjPath,
        mirrorCtx
      );
    }
  );

  s.tool(
    'create_property',
    'Creates a new Property within a specific Function Block POU.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      parentPouPath: z.string().describe("Relative path to the parent Function Block POU (e.g., 'Application/MyFB')."),
      propertyName: z.string().describe("Name for the new property (must be a valid IEC identifier)."),
      propertyType: z.string().describe("Data type of the property (e.g., 'BOOL', 'INT', 'MyDUT')."),
    },
    async (args: { projectFilePath: string; parentPouPath: string; propertyName: string; propertyType: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanParentPath = sanitizePouPath(args.parentPouPath);
      const script = scriptManager.prepareScriptWithHelpers(
        'create_property',
        {
          PROJECT_FILE_PATH: escProjPath,
          PARENT_POU_FULL_PATH: sanParentPath,
          PROPERTY_NAME: args.propertyName.trim(),
          PROPERTY_TYPE: args.propertyType.trim(),
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const flushNote = await maybeFlushEditorViews();
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(
        result,
        `${flushNote}Property '${args.propertyName}' created under '${sanParentPath}' in ${args.projectFilePath}. Project saved.`,
        escProjPath,
        mirrorCtx
      );
    }
  );

  s.tool(
    'create_method',
    'Creates a new Method within a specific Function Block POU. Pass declarationCode/implementationCode to set the method body in the same call (otherwise the method is created empty and needs a follow-up set_pou_code).',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      parentPouPath: z.string().describe("Relative path to the parent Function Block POU (e.g., 'Application/MyFB')."),
      methodName: z.string().describe("Name of the new method (must be a valid IEC identifier)."),
      returnType: z.string().optional().describe("Return type (e.g., 'BOOL', 'INT'). Leave empty or omit for no return value."),
      declarationCode: z.string().optional().describe("Full declaration part (METHOD ... VAR...END_VAR) to apply after creation. If omitted, the IDE default stub is kept."),
      implementationCode: z.string().optional().describe("Implementation logic to apply after creation. If omitted, the body is left empty."),
    },
    async (args: { projectFilePath: string; parentPouPath: string; methodName: string; returnType?: string; declarationCode?: string; implementationCode?: string }) => {
      // Same reserved-identifier gate as set_pou_code: refuse before touching the project.
      const reservedWarnings = findReservedIecIdentifiers(args.declarationCode);
      if (reservedWarnings.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Refused: declarationCode contains IEC reserved identifier(s). Method NOT created. Fix and retry.\n\n  - ${reservedWarnings.join('\n  - ')}`,
          }],
          isError: true,
        };
      }
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanParentPath = sanitizePouPath(args.parentPouPath);
      const sanDecl = (args.declarationCode ?? '').replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
      const sanImpl = (args.implementationCode ?? '').replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
      const script = scriptManager.prepareScriptWithHelpers(
        'create_method',
        {
          PROJECT_FILE_PATH: escProjPath,
          PARENT_POU_FULL_PATH: sanParentPath,
          METHOD_NAME: args.methodName.trim(),
          RETURN_TYPE: (args.returnType ?? '').trim(),
          DECLARATION_CONTENT: sanDecl,
          IMPLEMENTATION_CONTENT: sanImpl,
          SET_DECLARATION: args.declarationCode !== undefined ? 'True' : 'False',
          SET_IMPLEMENTATION: args.implementationCode !== undefined ? 'True' : 'False',
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const flushNote = await maybeFlushEditorViews();
      const result = await executor.executeScript(script);
      const withCode = (args.declarationCode !== undefined || args.implementationCode !== undefined) ? ' Code applied.' : '';
      return await formatModifyingResponse(
        result,
        `${flushNote}Method '${args.methodName}' created under '${sanParentPath}' in ${args.projectFilePath}.${withCode} Project saved.`,
        escProjPath,
        mirrorCtx
      );
    }
  );

  // Shared compile runner. Used by the compile_project tool and as an
  // auto-follow-up by symbol-config-modifying tools (Symbol Configuration is
  // only emitted as a side effect of code generation, so any symbol edit
  // needs a build to actually land in the artifacts).
  const runCompile = async (
    escaped: string,
    projectFilePath: string,
    applicationPath?: string
  ): Promise<{ message: string; isError: boolean }> => {
    const script = scriptManager.prepareScriptWithHelpers(
      'compile_project',
      { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(applicationPath) },
      ['ensure_project_open', 'select_application']
    );
    const result = await executor.executeScript(script, 120_000);

    const success = result.success && result.output.includes('SCRIPT_SUCCESS');

    let compileMessages: Array<{ severity: string; text: string; object?: string; line?: number }> = [];
    const msgStartMarker = '### COMPILE_MESSAGES_START ###';
    const msgEndMarker = '### COMPILE_MESSAGES_END ###';
    const msgStartIdx = result.output.indexOf(msgStartMarker);
    const msgEndIdx = result.output.indexOf(msgEndMarker);
    if (msgStartIdx !== -1 && msgEndIdx !== -1 && msgStartIdx < msgEndIdx) {
      try {
        const jsonStr = result.output.substring(msgStartIdx + msgStartMarker.length, msgEndIdx).trim();
        compileMessages = JSON.parse(jsonStr);
      } catch {
        // JSON parse failed, ignore
      }
    }

    let message: string;
    let isError = !success;

    if (!success) {
      message = `Failed initiating compilation for ${projectFilePath}. Output:\n${result.output}`;
    } else if (compileMessages.length > 0) {
      const errors = compileMessages.filter((m) => m.severity === 'error');
      const warnings = compileMessages.filter((m) => m.severity === 'warning');
      const formatMsg = (m: { severity: string; text: string; object?: string; line?: number }) => {
        const loc = m.object ? (m.line != null ? ` [${m.object}:${m.line}]` : ` [${m.object}]`) : '';
        return `${m.severity.toUpperCase()}: ${m.text}${loc}`;
      };

      message = `Compilation complete for ${projectFilePath}.\n`;
      message += `${errors.length} error(s), ${warnings.length} warning(s).\n`;
      if (errors.length > 0) {
        message += '\nErrors:\n' + errors.map(formatMsg).join('\n');
        isError = true;
      }
      if (warnings.length > 0) {
        message += '\nWarnings:\n' + warnings.map(formatMsg).join('\n');
      }
    } else {
      message = `Compilation initiated for ${projectFilePath}.`;
      const hasCompileErrors =
        result.output.includes('Compile complete --') &&
        !/ 0 error\(s\),/.test(result.output);
      if (hasCompileErrors) {
        message += ' WARNING: Build command reported errors. Use get_compile_messages for details.';
        isError = true;
      }
    }

    return { message, isError };
  };

  // Append an auto-compile follow-up to a successful symbol-config edit.
  // Symbol changes only land in the .app/.crc/XSD after the next build, so
  // we run one immediately and surface its outcome in the same response.
  const withAutoCompile = async (
    initial: { content: Array<{ type: 'text'; text: string }>; isError: boolean },
    escaped: string,
    projectFilePath: string
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }> => {
    if (initial.isError) return initial;
    const { message, isError } = await runCompile(escaped, projectFilePath);
    const prefix = isError ? '[auto-compile FAILED]' : '[auto-compile]';
    const combined = `${initial.content[0]?.text ?? ''}\n\n${prefix} ${message}`;
    return {
      content: [{ type: 'text' as const, text: combined }],
      isError: isError,
    };
  };

  s.tool(
    'compile_project',
    'Compiles (Builds) the active application within a CODESYS project (pass applicationPath to pick one in a multi-device project). Returns structured compiler messages (errors, warnings) when available.',
    {
      projectFilePath: z.string().describe("Path to the project file containing the application to compile."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
    },
    async (args: { applicationPath?: string; projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const { message, isError } = await runCompile(escaped, args.projectFilePath, args.applicationPath);
      return { content: [{ type: 'text' as const, text: message }], isError };
    }
  );

  s.tool(
    'get_compile_messages',
    'Retrieves the last compiler messages (errors, warnings) without triggering a new build. Useful after editing code to check remaining errors.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
    },
    async (args: { applicationPath?: string; projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'get_compile_messages', { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath) }, ['ensure_project_open', 'select_application']
      );
      const result = await executor.executeScript(script);

      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }

      // Parse structured messages
      let compileMessages: Array<{ severity: string; text: string; object?: string; line?: number }> = [];
      const msgStartMarker = '### COMPILE_MESSAGES_START ###';
      const msgEndMarker = '### COMPILE_MESSAGES_END ###';
      const msgStartIdx = result.output.indexOf(msgStartMarker);
      const msgEndIdx = result.output.indexOf(msgEndMarker);
      if (msgStartIdx !== -1 && msgEndIdx !== -1 && msgStartIdx < msgEndIdx) {
        try {
          const jsonStr = result.output.substring(msgStartIdx + msgStartMarker.length, msgEndIdx).trim();
          compileMessages = JSON.parse(jsonStr);
        } catch {
          // JSON parse failed
        }
      }

      if (compileMessages.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No compile messages found. The message API may not be available in this CODESYS version.' }],
          isError: false,
        };
      }

      const errors = compileMessages.filter((m) => m.severity === 'error');
      const warnings = compileMessages.filter((m) => m.severity === 'warning');
      const formatMsg = (m: { severity: string; text: string; object?: string; line?: number }) => {
        const loc = m.object ? (m.line != null ? ` [${m.object}:${m.line}]` : ` [${m.object}]`) : '';
        return `${m.severity.toUpperCase()}: ${m.text}${loc}`;
      };

      let message = `${errors.length} error(s), ${warnings.length} warning(s), ${compileMessages.length} total message(s).\n`;
      if (errors.length > 0) {
        message += '\nErrors:\n' + errors.map(formatMsg).join('\n');
      }
      if (warnings.length > 0) {
        message += '\nWarnings:\n' + warnings.map(formatMsg).join('\n');
      }
      const others = compileMessages.filter((m) => m.severity !== 'error' && m.severity !== 'warning');
      if (others.length > 0) {
        message += '\nOther:\n' + others.map(formatMsg).join('\n');
      }

      return {
        content: [{ type: 'text' as const, text: message }],
        isError: errors.length > 0,
      };
    }
  );

  // ─── Project Structure Tools ──────────────────────────────────────────

  s.tool(
    'create_dut',
    'Creates a new Data Unit Type (DUT) — structure, enumeration, union, or alias — within the specified CODESYS project.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      name: z.string().describe("Name for the new DUT (must be a valid IEC identifier)."),
      dutType: z.string().describe("Type of DUT: Structure, Enumeration, Union, or Alias."),
      parentPath: z.string().describe("Relative path under project root or application (e.g., 'Application')."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; name: string; dutType: string; parentPath: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanParentPath = sanitizePouPath(args.parentPath);
      const script = scriptManager.prepareScriptWithHelpers(
        'create_dut',
        {
          PROJECT_FILE_PATH: escProjPath, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          DUT_NAME: args.name.trim(),
          DUT_TYPE_STR: args.dutType,
          PARENT_PATH: sanParentPath,
        },
        ['ensure_project_open', 'select_application', 'find_object_by_path']
      );
      const flushNote = await maybeFlushEditorViews();
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(
        result,
        `${flushNote}DUT '${args.name}' (${args.dutType}) created in '${sanParentPath}' of ${args.projectFilePath}. Project saved.`,
        escProjPath,
        mirrorCtx
      );
    }
  );

  s.tool(
    'create_gvl',
    'Creates a new Global Variable List (GVL) within the specified CODESYS project.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      name: z.string().describe("Name for the new GVL (must be a valid IEC identifier)."),
      parentPath: z.string().describe("Relative path under project root or application (e.g., 'Application')."),
      declarationCode: z.string().optional().describe("Optional initial declaration code for the GVL (VAR_GLOBAL...END_VAR)."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; name: string; parentPath: string; declarationCode?: string }) => {
      // Block on IEC reserved identifiers in declarationCode BEFORE
      // creating the GVL. Refuse rather than create a broken GVL.
      const reservedWarnings = findReservedIecIdentifiers(args.declarationCode);
      if (reservedWarnings.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Refused: declarationCode contains IEC reserved identifier(s). GVL NOT created. Fix and retry.\n\n  - ${reservedWarnings.join('\n  - ')}`,
          }],
          isError: true,
        };
      }
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanParentPath = sanitizePouPath(args.parentPath);
      const sanDecl = (args.declarationCode ?? '').replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
      const script = scriptManager.prepareScriptWithHelpers(
        'create_gvl',
        {
          PROJECT_FILE_PATH: escProjPath, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          GVL_NAME: args.name.trim(),
          PARENT_PATH: sanParentPath,
          DECLARATION_CONTENT: sanDecl,
        },
        ['ensure_project_open', 'select_application', 'find_object_by_path']
      );
      const flushNote = await maybeFlushEditorViews();
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(
        result,
        `${flushNote}GVL '${args.name}' created in '${sanParentPath}' of ${args.projectFilePath}. Project saved.`,
        escProjPath,
        mirrorCtx
      );
    }
  );

  s.tool(
    'create_folder',
    'Creates an organizational folder within the CODESYS project tree.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      folderName: z.string().describe("Name for the new folder."),
      parentPath: z.string().describe("Relative path under project root or application (e.g., 'Application')."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; folderName: string; parentPath: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanParentPath = sanitizePouPath(args.parentPath);
      const script = scriptManager.prepareScriptWithHelpers(
        'create_folder',
        {
          PROJECT_FILE_PATH: escProjPath, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          FOLDER_NAME: args.folderName.trim(),
          PARENT_PATH: sanParentPath,
        },
        ['ensure_project_open', 'select_application', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(
        result,
        `Folder '${args.folderName}' created in '${sanParentPath}' of ${args.projectFilePath}. Project saved.`,
        escProjPath,
        mirrorCtx
      );
    }
  );

  s.tool(
    'list_tasks',
    "Lists the tasks in the project's Task Configuration: each task's name, best-effort properties (priority/interval/type where the SP exposes them), and its ordered POU call list. Read-only.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
    },
    async (args: { applicationPath?: string; projectFilePath: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'list_tasks',
        { PROJECT_FILE_PATH: escProjPath, APPLICATION_PATH: appPathLiteral(args.applicationPath) },
        ['ensure_project_open', 'select_application']
      );
      const result = await executor.executeScript(script);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const startMarker = '### TASKS_START ###';
      const endMarker = '### TASKS_END ###';
      const startIdx = result.output.indexOf(startMarker);
      const endIdx = result.output.indexOf(endMarker);
      const text = (startIdx >= 0 && endIdx > startIdx)
        ? result.output.substring(startIdx + startMarker.length, endIdx).trim()
        : result.output;
      return { content: [{ type: 'text' as const, text }], isError: false };
    }
  );

  s.tool(
    'add_pou_to_task',
    "Adds (appends) or inserts a Program POU into a task's call list in the project's Task Configuration. Wraps the ScriptEngine task.pous.add / .insert API. Omit index to append; pass a 0-based index to insert. The POU must be a PROGRAM that already exists in the project. NOTE: editing the task configuration is blocked while logged into a device -- disconnect first.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      taskName: z.string().describe("Name of the target task in the Task Configuration (e.g., 'MainTask', 'Can1_N2k')."),
      pouName: z.string().describe("Name of the Program POU to add to the task's call list (e.g., 'Can2_N2k')."),
      index: z.number().int().optional().describe("Optional 0-based position to insert at. Omit to append at the end."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; taskName: string; pouName: string; index?: number }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'add_pou_to_task',
        {
          PROJECT_FILE_PATH: escProjPath, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          TASK_NAME: args.taskName.trim(),
          POU_NAME: args.pouName.trim(),
          INSERT_INDEX: args.index === undefined ? '' : String(args.index),
        },
        ['ensure_project_open', 'select_application']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(
        result,
        `POU '${args.pouName}' added to task '${args.taskName}'. Project saved.`,
        escProjPath,
        mirrorCtx
      );
    }
  );

  s.tool(
    'remove_pou_from_task',
    "Removes a Program POU from a task's call list in the project's Task Configuration. Removes only the call in that task; does not delete the POU object itself. Blocked while logged into a device -- disconnect first.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      taskName: z.string().describe("Name of the task in the Task Configuration."),
      pouName: z.string().describe("Name of the Program POU to remove from the task's call list."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; taskName: string; pouName: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'remove_pou_from_task',
        {
          PROJECT_FILE_PATH: escProjPath, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          TASK_NAME: args.taskName.trim(),
          POU_NAME: args.pouName.trim(),
        },
        ['ensure_project_open', 'select_application']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(
        result,
        `POU '${args.pouName}' removed from task '${args.taskName}'. Project saved.`,
        escProjPath,
        mirrorCtx
      );
    }
  );

  s.tool(
    'delete_object',
    'Deletes a project object (POU, DUT, GVL, folder, etc.) from the CODESYS project. WARNING: This is destructive and cannot be undone.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      objectPath: z.string().describe("Full relative path to the object to delete (e.g., 'Application/MyPOU')."),
    },
    async (args: { projectFilePath: string; objectPath: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanObjPath = sanitizePouPath(args.objectPath);
      const script = scriptManager.prepareScriptWithHelpers(
        'delete_object',
        {
          PROJECT_FILE_PATH: escProjPath,
          OBJECT_PATH: sanObjPath,
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(
        result,
        `Object '${sanObjPath}' deleted from ${args.projectFilePath}. Project saved.`,
        escProjPath,
        mirrorCtx
      );
    }
  );

  s.tool(
    'rename_object',
    "Renames a project object (POU, DUT, GVL, folder, etc.) in the CODESYS project. By default also updates references in every other POU/DUT/GVL by word-boundary regex (\\bOldName\\b -> NewName) so the rename behaves like the IDE's Rename refactor. Pass updateReferences=false to opt out (keep the legacy minimal-rename behaviour, which leaves callers stale and breaks compilation when renaming a type/FB).",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      objectPath: z.string().describe("Full relative path to the object to rename (e.g., 'Application/MyPOU')."),
      newName: z.string().describe("New name for the object (must be a valid IEC identifier)."),
      updateReferences: z.boolean().optional().describe("If true (default), regex-replace \\bOldName\\b -> NewName in every other POU/DUT/GVL declaration AND implementation. False: rename target only -- callers will be stale and the project may stop compiling."),
    },
    async (args: { projectFilePath: string; objectPath: string; newName: string; updateReferences?: boolean }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanObjPath = sanitizePouPath(args.objectPath);
      // Default updateReferences=true (the safer behaviour). Caller must
      // explicitly pass false to disable.
      const updateRefs = args.updateReferences === false ? false : true;
      const script = scriptManager.prepareScriptWithHelpers(
        'rename_object',
        {
          PROJECT_FILE_PATH: escProjPath,
          OBJECT_PATH: sanObjPath,
          NEW_NAME: args.newName.trim(),
          UPDATE_REFERENCES: updateRefs ? '1' : '0',
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(
        result,
        `Object '${sanObjPath}' renamed to '${args.newName}' in ${args.projectFilePath}. Project saved.`,
        escProjPath,
        mirrorCtx
      );
    }
  );

  s.tool(
    'update_device_type',
    "Change a project's PLC device type in-place, preserving the Application / POU / library subtree underneath. Wraps ScriptObject.update(device_id) per the CODESYS Forge snippet (forge.codesys.com/tol/scripting/snippets/20/). Used for retargeting between device families (e.g. WAGO PFC200 -> CODESYS Control for Raspberry Pi MC SL when porting a project to a Linux PLC). NOT a fallback to remove+add: if the in-place update raises, the tool fails loud rather than destroying the subtree.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      targetDeviceName: z.string().describe("Substring of the target device's display name in the CODESYS device repository (e.g. 'CODESYS Control for Raspberry Pi MC SL', 'CODESYS Control for Linux ARM64 SL', 'CODESYS Control Win V3 x64'). Required."),
      devicePath: z.string().optional().describe("Slash-separated path under the project root to the device to update (e.g. 'MainPLC'). Omit to auto-pick the first device with a configured gateway+address (the deployed PLC on every MR project), falling back to the first top-level device if no routes are configured yet."),
      targetVersion: z.string().optional().describe("Exact target device version (e.g. '4.13.0.0'). Omit to use the latest installed version of the matching device."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; targetDeviceName: string; devicePath?: string; targetVersion?: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'update_device_type',
        {
          PROJECT_FILE_PATH: escProjPath, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          DEVICE_PATH: (args.devicePath ?? '').trim(),
          TARGET_NAME: args.targetDeviceName.trim(),
          TARGET_VERSION: (args.targetVersion ?? '').trim(),
        },
        ['ensure_project_open', 'select_application']
      );
      const result = await executor.executeScript(script, 120_000);
      return await formatModifyingResponse(
        result,
        `Device updated to '${args.targetDeviceName}'${args.targetVersion ? ` (${args.targetVersion})` : ''} in ${args.projectFilePath}. Application/POU/library subtree preserved.`,
        escProjPath,
        mirrorCtx
      );
    }
  );

  s.tool(
    'add_device',
    "Add a new child device under an existing parent device in the project tree. Wraps ScriptDeviceObject.add(name, device_id) per the CODESYS scripting API. Used to attach communication-stack sub-devices to a PLC (e.g. 'Modbus TCP Server' under an Ethernet adapter, 'Ethernet' under the top-level PLC). Idempotent: if a child with the same deviceName already exists under the parent, no-ops with a confirmation message rather than creating a duplicate. Refuses if the device repository has no match for targetDeviceName -- inspect Tools > Device Repository for installed device descriptors before retrying.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      parentPath: z.string().describe("Slash-separated path to the parent device under which the new child device should be added (e.g. 'MainPLC' to add an Ethernet adapter under the PLC, or 'MainPLC/Ethernet1' to add a Modbus TCP Server under an Ethernet)."),
      deviceName: z.string().describe("Name for the new device node in the project tree (e.g. 'OBS', 'GPIOs_A_B'). This name becomes the auto-generated global variable for IO mapping, so match the references in your code (e.g. if FB_PLCStatus.st reads 'OBS.uiClientConnections', name the device 'OBS')."),
      targetDeviceName: z.string().describe("Substring of the target device's display name in the CODESYS device repository (e.g. 'Modbus TCP Server', 'Ethernet', 'Modbus TCP Slave Device' for older installs). Required. Inspect Tools > Device Repository if unsure."),
      targetVersion: z.string().optional().describe("Exact target device version (e.g. '4.5.0.0'). Omit to use the highest-version match."),
    },
    async (args: { projectFilePath: string; parentPath: string; deviceName: string; targetDeviceName: string; targetVersion?: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'add_device',
        {
          PROJECT_FILE_PATH: escProjPath,
          PARENT_PATH: args.parentPath.trim(),
          DEVICE_NAME: args.deviceName.trim(),
          TARGET_NAME: args.targetDeviceName.trim(),
          TARGET_VERSION: (args.targetVersion ?? '').trim(),
        },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script, 120_000);
      return await formatModifyingResponse(
        result,
        `Device '${args.deviceName}' (type '${args.targetDeviceName}'${args.targetVersion ? `, version ${args.targetVersion}` : ''}) added under '${args.parentPath}' in ${args.projectFilePath}.`,
        escProjPath,
        mirrorCtx
      );
    }
  );

  s.tool(
    'get_all_pou_code',
    'Reads the declaration and implementation code of every POU/DUT/GVL in the project. Returns all code in a single response for bulk review.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'get_all_pou_code', { PROJECT_FILE_PATH: escaped }, ['ensure_project_open']
      );
      const result = await executor.executeScript(script, 120_000); // 120s for large projects

      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }

      // Parse the JSON output
      const codeStartMarker = '### ALL_POU_CODE_START ###';
      const codeEndMarker = '### ALL_POU_CODE_END ###';
      const startIdx = result.output.indexOf(codeStartMarker);
      const endIdx = result.output.indexOf(codeEndMarker);

      if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
        return {
          content: [{ type: 'text' as const, text: 'Could not parse POU code output.' }],
          isError: true,
        };
      }

      try {
        const jsonStr = result.output.substring(startIdx + codeStartMarker.length, endIdx).trim();
        const allCode: Array<{ path: string; type: string; declaration?: string; implementation?: string }> = JSON.parse(jsonStr);

        if (allCode.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No POUs with code found in the project.' }],
            isError: false,
          };
        }

        // Format output
        const sections = allCode.map((item) => {
          let section = `\n=== ${item.path} (${item.type}) ===`;
          if (item.declaration) {
            section += `\n// ----- Declaration -----\n${item.declaration}`;
          }
          if (item.implementation) {
            section += `\n// ----- Implementation -----\n${item.implementation}`;
          }
          return section;
        });

        return {
          content: [{ type: 'text' as const, text: `${allCode.length} object(s) with code:\n${sections.join('\n')}` }],
          isError: false,
        };
      } catch {
        return {
          content: [{ type: 'text' as const, text: 'Failed to parse POU code JSON.' }],
          isError: true,
        };
      }
    }
  );

  // ─── Online/Runtime Tools ─────────────────────────────────────────────

  s.tool(
    'connect_to_device',
    'Connects (logs in) to the PLC runtime for the active application. Requires a configured device/gateway in the project. AGENT BEHAVIOUR REQUIRED: BEFORE calling this tool, the agent MUST announce in user-facing chat what it is about to do AND warn that a modal "Device User Login" dialog may pop in the CODESYS IDE (the agent cannot see or dismiss it). The user must be ready to click. Pass deviceUser+devicePassword (or set CODESYS_DEVICE_USER/CODESYS_DEVICE_PASSWORD env vars in the MCP server config) to pre-register credentials via ScriptOnline.set_default_credentials and skip the dialog entirely.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      loginWaitSeconds: z.number().int().min(0).max(600).optional().describe("Seconds to wait for the application state to stabilise after login() returns. Default: 10. Range 0-600. Keep this short -- if the user has to fill a dialog, they will do it within seconds, not minutes. Increase only when explicitly diagnosing a slow-login case."),
      deviceUser: z.string().optional().describe("Device user account name. Pre-registered via set_default_credentials so the modal Device User Login dialog is suppressed. Falls back to env var CODESYS_DEVICE_USER. If neither is set, the dialog will pop (current behaviour)."),
      devicePassword: z.string().optional().describe("Device user password. Same fallback chain as deviceUser via env CODESYS_DEVICE_PASSWORD."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; loginWaitSeconds?: number; deviceUser?: string; devicePassword?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const waitSec = args.loginWaitSeconds ?? 10;
      const deviceUser = args.deviceUser ?? process.env.CODESYS_DEVICE_USER ?? '';
      const devicePassword = args.devicePassword ?? process.env.CODESYS_DEVICE_PASSWORD ?? '';
      const script = scriptManager.prepareScriptWithHelpers(
        'connect_to_device',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          LOGIN_WAIT_SECONDS: String(waitSec),
          DEVICE_USER: pyStringLiteral(deviceUser),
          DEVICE_PASSWORD: pyStringLiteral(devicePassword),
        },
        ['register_device_credentials', 'ensure_project_open', 'select_application', 'ensure_online_connection']
      );
      // Tool-side timeout = wait window + 30s headroom for actual login work
      const ipcTimeoutMs = (waitSec + 30) * 1000;
      const result = await executor.executeScript(script, ipcTimeoutMs);
      return formatToolResponse(result, `Connected to device for ${args.projectFilePath}.`);
    }
  );

  s.tool(
    'disconnect_from_device',
    'Disconnects (logs out) from the PLC runtime.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
    },
    async (args: { applicationPath?: string; projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'disconnect_from_device', { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath) },
        ['ensure_project_open', 'select_application', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, `Disconnected from device for ${args.projectFilePath}.`);
    }
  );

  s.tool(
    'get_application_state',
    'Gets the current state of the PLC application (running, stopped, exception, etc.).',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
    },
    async (args: { applicationPath?: string; projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'get_application_state', { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath) },
        ['ensure_project_open', 'select_application', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script);

      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }

      // Parse state from output
      const stateMatch = result.output.match(/State:\s*(.+)/);
      const loggedInMatch = result.output.match(/Logged In:\s*(.+)/);
      const appMatch = result.output.match(/Application:\s*(.+)/);

      const text = [
        `Application: ${appMatch ? appMatch[1].trim() : 'Unknown'}`,
        `State: ${stateMatch ? stateMatch[1].trim() : 'Unknown'}`,
        `Logged In: ${loggedInMatch ? loggedInMatch[1].trim() : 'Unknown'}`,
      ].join('\n');

      return {
        content: [{ type: 'text' as const, text }],
        isError: false,
      };
    }
  );

  s.tool(
    'read_variable',
    'Reads the current value of a variable from the running PLC application. Must be connected first.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      variablePath: z.string().describe("Variable path (e.g., 'PLC_PRG.bMotorRunning', 'GVL.nCounter')."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; variablePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'read_variable',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          VARIABLE_PATH: args.variablePath.trim(),
        },
        ['ensure_project_open', 'select_application', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script);

      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }

      const valueMatch = result.output.match(/Value:\s*(.+)/);
      const typeMatch = result.output.match(/Type:\s*(.+)/);
      const text = `${args.variablePath} = ${valueMatch ? valueMatch[1].trim() : 'N/A'} (${typeMatch ? typeMatch[1].trim() : 'unknown'})`;

      return {
        content: [{ type: 'text' as const, text }],
        isError: false,
      };
    }
  );

  s.tool(
    'write_variable',
    'Writes a value to a variable in the running PLC application. Must be connected first.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      variablePath: z.string().describe("Variable path (e.g., 'PLC_PRG.bMotorRunning')."),
      value: z.string().describe("Value to write (e.g., 'TRUE', '42', '3.14')."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; variablePath: string; value: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'write_variable',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          VARIABLE_PATH: args.variablePath.trim(),
          VARIABLE_VALUE: args.value,
        },
        ['ensure_project_open', 'select_application', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `Variable '${args.variablePath}' set to '${args.value}'.`
      );
    }
  );

  // ─── Online Runtime Tools (SP21 coverage phase 1) ────────────────────
  // API: SP21 ScriptOnline.pyi (ScriptOnlineApplication / ScriptOnlineDevice),
  // semantics: helpme-codesys.com/en/ScriptingEngine/ScriptOnline.html

  // Extract the text between marker lines; raw output if markers missing.
  const extractMarkerText = (output: string, startMarker: string, endMarker: string): string => {
    const startIdx = output.indexOf(startMarker);
    const endIdx = output.indexOf(endMarker);
    return (startIdx >= 0 && endIdx > startIdx)
      ? output.substring(startIdx + startMarker.length, endIdx).trim()
      : output.trim();
  };

  const ONLINE_HELPERS = ['ensure_project_open', 'select_application', 'ensure_online_connection'];

  s.tool(
    'reset_application',
    "Resets the online application. 'warm' keeps retain variables, 'cold' clears retains but keeps persistents, 'origin' (ResetOption.Original) erases all variables AND the application from the device — destructive, ask the user before using 'origin'. Clears all breakpoints. Must be connected first (connect_to_device).",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      level: z.enum(['warm', 'cold', 'origin']).describe("Reset level: warm (keep retains), cold (clear retains), origin (erase application from device)."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; level: 'warm' | 'cold' | 'origin' }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'reset_application',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath), RESET_LEVEL: args.level },
        ONLINE_HELPERS
      );
      const result = await executor.executeScript(script, 120_000);
      return formatToolResponse(result, `Application reset (${args.level}) executed.`);
    }
  );

  s.tool(
    'read_variables',
    "Reads the current values of MULTIPLE variables from the running PLC application in one call (online_app.read_values). Much cheaper than repeated read_variable calls. Must be connected first.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      expressions: z.array(z.string()).min(1).describe("Variable expressions, e.g. ['PLC_PRG.bRun', 'GVL.nCounter']."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; expressions: string[] }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'read_variables',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          EXPRESSIONS_PY: '[' + args.expressions.map((e) => pyStringLiteral(e.trim())).join(', ') + ']',
        },
        ONLINE_HELPERS
      );
      const result = await executor.executeScript(script);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const text = extractMarkerText(result.output, '### VALUES_START ###', '### VALUES_END ###');
      return { content: [{ type: 'text' as const, text }], isError: false };
    }
  );

  s.tool(
    'write_variables',
    "Writes MULTIPLE variables to the running PLC application in one batch (set_prepared_value xN + one write_prepared_values commit, so all values land in the same cycle). Must be connected first.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      assignments: z.array(z.object({
        expression: z.string().describe("Variable expression, e.g. 'PLC_PRG.bRun'."),
        value: z.string().describe("Value to write, e.g. 'TRUE', '42', '3.14'."),
      })).min(1).describe("Expression/value pairs to write as one batch."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; assignments: Array<{ expression: string; value: string }> }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const assignmentsPy = '[' + args.assignments
        .map((a) => `(${pyStringLiteral(a.expression.trim())}, ${pyStringLiteral(a.value)})`)
        .join(', ') + ']';
      const script = scriptManager.prepareScriptWithHelpers(
        'write_variables',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath), ASSIGNMENTS_PY: assignmentsPy },
        ONLINE_HELPERS
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, `Wrote ${args.assignments.length} variable(s) in one batch.`);
    }
  );

  s.tool(
    'force_variables',
    "FORCES variables in the running PLC application (set_prepared_value xN + force_prepared_values): the values are pinned against task writes until unforced (unforce_variables). Forces survive until unforce or application reset. Must be connected first.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      assignments: z.array(z.object({
        expression: z.string().describe("Variable expression, e.g. 'PLC_PRG.bOverride'."),
        value: z.string().describe("Value to force, e.g. 'TRUE', '42'."),
      })).min(1).describe("Expression/value pairs to force."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; assignments: Array<{ expression: string; value: string }> }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const assignmentsPy = '[' + args.assignments
        .map((a) => `(${pyStringLiteral(a.expression.trim())}, ${pyStringLiteral(a.value)})`)
        .join(', ') + ']';
      const script = scriptManager.prepareScriptWithHelpers(
        'force_variables',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath), ASSIGNMENTS_PY: assignmentsPy },
        ONLINE_HELPERS
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, `Forced ${args.assignments.length} variable(s).`);
    }
  );

  s.tool(
    'unforce_variables',
    "Removes forces from variables in the running PLC application. Omit 'expressions' to unforce ALL forced values (unforce_all_values). With 'expressions', stages set_unforce_value per expression and commits via force_prepared_values. Must be connected first.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      expressions: z.array(z.string()).optional().describe("Expressions to unforce. Omit to unforce ALL."),
      restore: z.boolean().optional().describe("If true, restore the value from before forcing (only with explicit expressions). Default false."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; expressions?: string[]; restore?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'unforce_variables',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          EXPRESSIONS_PY: '[' + (args.expressions ?? []).map((e) => pyStringLiteral(e.trim())).join(', ') + ']',
          RESTORE: pyBool(args.restore ?? false),
        },
        ONLINE_HELPERS
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        args.expressions?.length
          ? `Unforced ${args.expressions.length} variable(s).`
          : 'Unforced ALL forced variables.'
      );
    }
  );

  s.tool(
    'list_forced_variables',
    "Lists all currently FORCED expressions (and staged/prepared expressions) on the online application, including ones forced by other clients/editors. Read-only. Must be connected first.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
    },
    async (args: { applicationPath?: string; projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'list_forced_variables',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath) },
        ONLINE_HELPERS
      );
      const result = await executor.executeScript(script);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const body = extractMarkerText(result.output, '### FORCED_START ###', '### FORCED_END ###');
      const counts = result.output.match(/Forced Count:\s*\d+|Prepared Count:\s*\d+/g)?.join(', ') ?? '';
      return { content: [{ type: 'text' as const, text: body ? `${body}\n(${counts})` : `No forced or prepared expressions. (${counts})` }], isError: false };
    }
  );

  s.tool(
    'create_boot_application',
    "Creates a boot application. online=true: creates it directly ON the connected device (survives reboot). online=false (default): writes an offline .app boot file (outputPath, or '<application>.app' next to the project) — requires the project to be compiled first (compile_project).",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      online: z.boolean().optional().describe("true = create on the connected device; false/omitted = write offline .app file."),
      outputPath: z.string().optional().describe("Offline only: where to write the .app file. Relative paths resolve against the project directory. Omit for '<application>.app' next to the project."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; online?: boolean; outputPath?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const outPath = args.outputPath ?? '';
      const uncErr = outPath ? uncPathError(outPath) : null;
      if (uncErr) {
        return { content: [{ type: 'text' as const, text: uncErr }], isError: true };
      }
      const script = scriptManager.prepareScriptWithHelpers(
        'create_boot_application',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          ONLINE_MODE: pyBool(args.online ?? false),
          OUTPUT_PATH: outPath,
        },
        ONLINE_HELPERS
      );
      const result = await executor.executeScript(script, 180_000);
      return formatToolResponse(
        result,
        args.online
          ? 'Boot application created on device.'
          : `Offline boot application file created${outPath ? `: ${outPath}` : ' (default location next to project)'}.`
      );
    }
  );

  s.tool(
    'source_download',
    "Downloads the project SOURCE archive onto the connected PLC (online_device.download_source), so the source can later be recovered from the device. compact=true stores only the current device's PLC + applications. Must be connected first.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      compact: z.boolean().optional().describe("true = only the current device's PLC and applications; false/omitted = all PLCs and applications in the project."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; compact?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'source_download',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath), COMPACT: pyBool(args.compact ?? false) },
        ONLINE_HELPERS
      );
      const result = await executor.executeScript(script, 300_000);
      return formatToolResponse(result, 'Source archive downloaded to device.');
    }
  );

  s.tool(
    'source_upload',
    "Uploads the SOURCE archive stored on the connected PLC and saves it locally as a project archive (usually .prj). Must be connected first; the device must contain a source download (see source_download).",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      archivePath: z.string().describe("Local path to save the uploaded project archive to (e.g. 'C:/temp/uploaded.prj')."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; archivePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const escArchive = resolvePath(args.archivePath, workspaceDir);
      const uncErr = uncPathError(escArchive);
      if (uncErr) {
        return { content: [{ type: 'text' as const, text: uncErr }], isError: true };
      }
      const script = scriptManager.prepareScriptWithHelpers(
        'source_upload',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath), ARCHIVE_PATH: escArchive },
        ONLINE_HELPERS
      );
      const result = await executor.executeScript(script, 300_000);
      return formatToolResponse(result, `Source archive uploaded from device to: ${escArchive}`);
    }
  );

  s.tool(
    'plc_file_list',
    "Lists files and directories in a directory on the connected PLC's filesystem (get_file_list_of_directory). Returns kind/name/size/mtime rows. Read-only. Must be connected first.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      plcDirectory: z.string().optional().describe("Remote directory on the PLC (e.g. 'PlcLogic'). Omit/empty for the PLC's root file area."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; plcDirectory?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'plc_file_list',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath), PLC_DIRECTORY: pyStringLiteral(args.plcDirectory ?? '') },
        ONLINE_HELPERS
      );
      const result = await executor.executeScript(script, 60_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const body = extractMarkerText(result.output, '### FILES_START ###', '### FILES_END ###');
      const header = `PLC directory '${args.plcDirectory || '<root>'}' (kind\tname\tsize\tmodified):`;
      return { content: [{ type: 'text' as const, text: body ? `${header}\n${body}` : `${header}\n<empty>` }], isError: false };
    }
  );

  s.tool(
    'plc_file_transfer',
    "Transfers a single file between the local machine and the connected PLC's filesystem. direction 'to_plc' copies localPath onto the PLC (CODESYS download_file); 'from_plc' copies plcPath to the local machine (upload_file). Must be connected first.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      direction: z.enum(['to_plc', 'from_plc']).describe("'to_plc' = local file onto PLC; 'from_plc' = PLC file to local machine."),
      localPath: z.string().describe("Local file path (source for to_plc, destination for from_plc)."),
      plcPath: z.string().describe("Remote path on the PLC (destination for to_plc, source for from_plc)."),
      forceOverwrite: z.boolean().optional().describe("Overwrite the destination if it already exists. Default false."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; direction: 'to_plc' | 'from_plc'; localPath: string; plcPath: string; forceOverwrite?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const escLocal = resolvePath(args.localPath, workspaceDir);
      const uncErr = uncPathError(escLocal);
      if (uncErr) {
        return { content: [{ type: 'text' as const, text: uncErr }], isError: true };
      }
      const script = scriptManager.prepareScriptWithHelpers(
        'plc_file_transfer',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          DIRECTION: args.direction,
          LOCAL_PATH: escLocal,
          PLC_PATH: pyStringLiteral(args.plcPath),
          FORCE_OVERWRITE: pyBool(args.forceOverwrite ?? false),
        },
        ONLINE_HELPERS
      );
      const result = await executor.executeScript(script, 300_000);
      return formatToolResponse(
        result,
        args.direction === 'to_plc'
          ? `File transferred to PLC: ${escLocal} -> ${args.plcPath}`
          : `File transferred from PLC: ${args.plcPath} -> ${escLocal}`
      );
    }
  );

  s.tool(
    'plc_file_delete',
    "Deletes a file (or directory) on the connected PLC's filesystem. DESTRUCTIVE — confirm with the user before deleting anything you did not create. Must be connected first.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      plcPath: z.string().describe("Remote path on the PLC to delete."),
      isDirectory: z.boolean().optional().describe("true if plcPath is a directory. Default false (file)."),
      recursive: z.boolean().optional().describe("Directories only: delete recursively. Default false."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; plcPath: string; isDirectory?: boolean; recursive?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'plc_file_delete',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          PLC_PATH: pyStringLiteral(args.plcPath),
          IS_DIRECTORY: pyBool(args.isDirectory ?? false),
          RECURSIVE: pyBool(args.recursive ?? false),
        },
        ONLINE_HELPERS
      );
      const result = await executor.executeScript(script, 60_000);
      return formatToolResponse(result, `Deleted on PLC: ${args.plcPath}`);
    }
  );

  // ─── Project Lifecycle & Interop Tools (SP21 coverage phase 2) ───────
  // API: SP21 ScriptProject.pyi; semantics:
  // helpme-codesys.com/en/ScriptingEngine/ScriptProjects.html

  s.tool(
    'close_project',
    "Closes the currently open project. saveFirst=true (default) saves unsaved changes before closing; saveFirst=false DISCARDS unsaved changes. After this, the next project tool call re-opens whatever project it targets.",
    {
      projectFilePath: z.string().describe("Path to the project file to close."),
      saveFirst: z.boolean().optional().describe("Save unsaved changes before closing. Default true. false discards changes."),
    },
    async (args: { projectFilePath: string; saveFirst?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'close_project',
        { PROJECT_FILE_PATH: escaped, SAVE_FIRST: pyBool(args.saveFirst ?? true) },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, `Project closed: ${args.projectFilePath}`);
    }
  );

  s.tool(
    'save_project_as',
    "Saves the project under a new filename (project.save_as). Optionally sets a new encryption password, or disables encryption. The IDE's open project switches to the new path.",
    {
      projectFilePath: z.string().describe("Path to the currently open project file."),
      newPath: z.string().describe("New path to save the project as."),
      password: z.string().optional().describe("New encryption password. Omit to keep encryption as-is; pass empty string '' to DISABLE encryption."),
    },
    async (args: { projectFilePath: string; newPath: string; password?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const escNew = resolvePath(args.newPath, workspaceDir);
      const uncErr = uncPathError(escNew);
      if (uncErr) {
        return { content: [{ type: 'text' as const, text: uncErr }], isError: true };
      }
      const password = args.password === undefined ? '' : (args.password === '' ? '__DISABLE__' : args.password);
      const script = scriptManager.prepareScriptWithHelpers(
        'save_project_as',
        { PROJECT_FILE_PATH: escaped, NEW_PATH: escNew, PASSWORD: pyStringLiteral(password) },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script, 120_000);
      return formatToolResponse(result, `Project saved as: ${escNew}`);
    }
  );

  s.tool(
    'save_project_archive',
    "Saves the project as a .projectarchive (project.save_archive) with the default additional categories — the standard way to hand a complete project (incl. libraries/devices) to someone else.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      archivePath: z.string().describe("Path to write the .projectarchive to."),
      comment: z.string().optional().describe("Optional archive comment."),
    },
    async (args: { projectFilePath: string; archivePath: string; comment?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const escArchive = resolvePath(args.archivePath, workspaceDir);
      const uncErr = uncPathError(escArchive);
      if (uncErr) {
        return { content: [{ type: 'text' as const, text: uncErr }], isError: true };
      }
      const script = scriptManager.prepareScriptWithHelpers(
        'save_project_archive',
        { PROJECT_FILE_PATH: escaped, ARCHIVE_PATH: escArchive, COMMENT: pyStringLiteral(args.comment ?? '') },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script, 300_000);
      return formatToolResponse(result, `Project archive saved: ${escArchive}`);
    }
  );

  s.tool(
    'save_as_compiled_library',
    "Saves the primary project as a .compiled_library (project.save_as_compiled_library). Omit destination for '<project>.compiled_library' next to the project. The project should compile cleanly first (compile_project).",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      destination: z.string().optional().describe("Destination file or existing directory. Omit for '<project>.compiled_library' next to the project."),
    },
    async (args: { projectFilePath: string; destination?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const escDest = args.destination ? resolvePath(args.destination, workspaceDir) : '';
      const uncErr = escDest ? uncPathError(escDest) : null;
      if (uncErr) {
        return { content: [{ type: 'text' as const, text: uncErr }], isError: true };
      }
      const script = scriptManager.prepareScriptWithHelpers(
        'save_as_compiled_library',
        { PROJECT_FILE_PATH: escaped, DESTINATION: escDest },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script, 300_000);
      return formatToolResponse(result, `Compiled library saved${escDest ? `: ${escDest}` : ' (default location next to project)'}.`);
    }
  );

  s.tool(
    'export_plcopen_xml',
    "Exports project objects to a PLCopenXML file (project.export_xml) — the vendor-neutral interchange format. Omit objectPath to export all top-level objects; pass it to export one subtree. Non-exportable objects (device tree etc.) are skipped by the engine.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      exportPath: z.string().describe("Path to write the PLCopenXML file to."),
      objectPath: z.string().optional().describe("Subtree to export (e.g. 'Application/MyPOU'). Omit for all top-level objects."),
      recursive: z.boolean().optional().describe("Include exportable children recursively. Default true."),
    },
    async (args: { projectFilePath: string; exportPath: string; objectPath?: string; recursive?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const escExport = resolvePath(args.exportPath, workspaceDir);
      const uncErr = uncPathError(escExport);
      if (uncErr) {
        return { content: [{ type: 'text' as const, text: uncErr }], isError: true };
      }
      const script = scriptManager.prepareScriptWithHelpers(
        'export_plcopen_xml',
        {
          PROJECT_FILE_PATH: escaped,
          EXPORT_PATH: escExport,
          OBJECT_PATH: args.objectPath ? sanitizePouPath(args.objectPath) : '',
          RECURSIVE: pyBool(args.recursive ?? true),
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script, 120_000);
      return formatToolResponse(result, `PLCopenXML exported to: ${escExport}`);
    }
  );

  s.tool(
    'import_plcopen_xml',
    "Imports a PLCopenXML file into the top level of the project (project.import_xml) and saves. importFolderStructure=true recreates the folder structure from the file.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      importPath: z.string().describe("Path of the PLCopenXML file to import."),
      importFolderStructure: z.boolean().optional().describe("Recreate folder structure from the XML. Default false."),
    },
    async (args: { projectFilePath: string; importPath: string; importFolderStructure?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const escImport = resolvePath(args.importPath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'import_plcopen_xml',
        {
          PROJECT_FILE_PATH: escaped,
          IMPORT_PATH: escImport,
          IMPORT_FOLDER_STRUCTURE: pyBool(args.importFolderStructure ?? false),
        },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script, 120_000);
      return await formatModifyingResponse(result, `PLCopenXML imported from: ${escImport}. Project saved.`, escaped, mirrorCtx);
    }
  );

  s.tool(
    'export_native',
    "Exports project objects in the CODESYS NATIVE export format (project.export_native) — lossless for CODESYS-to-CODESYS transfer (unlike PLCopenXML). Omit objectPath to export all top-level objects.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      destination: z.string().describe("Destination export file path."),
      objectPath: z.string().optional().describe("Subtree to export. Omit for all top-level objects."),
      recursive: z.boolean().optional().describe("Include children recursively. Default true."),
    },
    async (args: { projectFilePath: string; destination: string; objectPath?: string; recursive?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const escDest = resolvePath(args.destination, workspaceDir);
      const uncErr = uncPathError(escDest);
      if (uncErr) {
        return { content: [{ type: 'text' as const, text: uncErr }], isError: true };
      }
      const script = scriptManager.prepareScriptWithHelpers(
        'export_native',
        {
          PROJECT_FILE_PATH: escaped,
          DESTINATION: escDest,
          OBJECT_PATH: args.objectPath ? sanitizePouPath(args.objectPath) : '',
          RECURSIVE: pyBool(args.recursive ?? true),
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script, 120_000);
      return formatToolResponse(result, `Native export written to: ${escDest}`);
    }
  );

  s.tool(
    'import_native',
    "Imports a CODESYS native export file and saves. Pass parentObjectPath to import UNDER that object (ScriptObject.import_native) -- e.g. 'Application/MRLib' to land a library subtree inside an application. Omit it to import at the project top level (the POU pool) -- note that root-level objects CANNOT be moved into an application afterwards, so pick the right parent up front.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      importPath: z.string().describe("Path of the native export file to import."),
      parentObjectPath: z.string().optional().describe("Object path to import under (e.g. 'Application/MRLib'). Omit for project top level."),
    },
    async (args: { projectFilePath: string; importPath: string; parentObjectPath?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const escImport = resolvePath(args.importPath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'import_native',
        {
          PROJECT_FILE_PATH: escaped,
          IMPORT_PATH: escImport,
          PARENT_OBJECT_PATH: args.parentObjectPath ? sanitizePouPath(args.parentObjectPath) : '',
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script, 120_000);
      return await formatModifyingResponse(result, `Native import from: ${escImport}. Project saved.`, escaped, mirrorCtx);
    }
  );

  s.tool(
    'get_project_info',
    "Reads the Project Information object: company, title, version, author, description, plus all custom properties (library properties etc.). Read-only.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const pinCheck = enforceVersionPin(escaped, {
        saves: false,
        profileName: config.profileName,
      });
      if (pinCheck.error) return pinCheck.error;
      const script = scriptManager.prepareScriptWithHelpers(
        'get_project_info',
        { PROJECT_FILE_PATH: escaped },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const text = extractMarkerText(result.output, '### PROJECT_INFO_START ###', '### PROJECT_INFO_END ###');
      return { content: [{ type: 'text' as const, text: pinCheck.warning + text }], isError: false };
    }
  );

  s.tool(
    'set_project_info',
    "Sets fields on the Project Information object (company/title/version/author/description) and saves the project. Only provided fields are changed. NOTE: prefer bump_project_version for version bumps — it also maintains the _MCP_PROJECT_VERSION GVL.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      company: z.string().optional().describe("Company field."),
      title: z.string().optional().describe("Title field."),
      version: z.string().optional().describe("Version field (e.g. '1.2.3.4')."),
      author: z.string().optional().describe("Author field."),
      description: z.string().optional().describe("Description field."),
    },
    async (args: { projectFilePath: string; company?: string; title?: string; version?: string; author?: string; description?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      if (!args.company && !args.title && !args.version && !args.author && !args.description) {
        return { content: [{ type: 'text' as const, text: 'Error: provide at least one field to set.' }], isError: true };
      }
      const script = scriptManager.prepareScriptWithHelpers(
        'set_project_info',
        {
          PROJECT_FILE_PATH: escaped,
          COMPANY: pyStringLiteral(args.company ?? ''),
          TITLE: pyStringLiteral(args.title ?? ''),
          VERSION: pyStringLiteral(args.version ?? ''),
          AUTHOR: pyStringLiteral(args.author ?? ''),
          DESCRIPTION: pyStringLiteral(args.description ?? ''),
        },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(result, 'Project info updated and saved.', escaped, mirrorCtx);
    }
  );

  s.tool(
    'get_compiler_version',
    "Reads the project's compiler version (project.get_compilerversion, scripting API 4.2.0.0+). Read-only.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'get_compiler_version',
        { PROJECT_FILE_PATH: escaped },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const m = result.output.match(/Compiler Version:\s*(.+)/);
      return { content: [{ type: 'text' as const, text: `Compiler version: ${m ? m[1].trim() : 'unknown'}` }], isError: false };
    }
  );

  s.tool(
    'set_compiler_version_to_newest',
    "Sets the project's compiler version to the newest available on this CODESYS install (project.set_compilerversion_to_newest, scripting API 4.2.0.0+) and saves. Changes code generation — recompile and retest afterwards.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'set_compiler_version_to_newest',
        { PROJECT_FILE_PATH: escaped },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(result, 'Compiler version set to newest. Project saved.', escaped, mirrorCtx);
    }
  );

  s.tool(
    'clean_all',
    "Performs 'Clean All' (project.clean_all): removes compile info for all applications. Next compile/download is from scratch; online change is no longer possible until a full download.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'clean_all',
        { PROJECT_FILE_PATH: escaped },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script, 120_000);
      return formatToolResponse(result, 'Clean All executed.');
    }
  );

  // ─── Application Build & Object Tools (SP21 coverage phase 3) ────────
  // API: SP21 ScriptApplication.pyi / ScriptObject.pyi.

  // ─── Multi-device projects: application selection ────────────────────
  // CODESYS has ONE active application per project; build/online/version
  // tools act on it. These tools make the choice explicit in projects with
  // several devices (e.g. a master and a slave PLC in one .project).

  s.tool(
    'list_applications',
    "Lists every application in the project (one per device in multi-device projects) with its hosting device, full path and whether it is the ACTIVE application. Read-only. Use the 'path' (or device name) with set_active_application or the applicationPath argument of build/online/version tools.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'list_applications',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral('') },
        ['ensure_project_open', 'select_application']
      );
      const result = await executor.executeScript(script);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const startMarker = '### APPLICATIONS_START ###';
      const endMarker = '### APPLICATIONS_END ###';
      const a = result.output.indexOf(startMarker);
      const b = result.output.indexOf(endMarker);
      let apps: Array<{ name: string; path: string; device: string; device_type: string; is_active: boolean }> = [];
      if (a !== -1 && b !== -1 && a < b) {
        try {
          apps = JSON.parse(result.output.substring(a + startMarker.length, b).trim());
        } catch {
          // fall through to raw output
        }
      }
      if (apps.length === 0) {
        return { content: [{ type: 'text' as const, text: `No applications found in ${args.projectFilePath}.` }], isError: false };
      }
      const lines = apps.map((x) =>
        `- ${x.path}${x.is_active ? '  (ACTIVE)' : ''}` +
        `${x.device ? `  device='${x.device}'` : ''}${x.device_type ? ` [${x.device_type}]` : ''}`
      );
      return {
        content: [{ type: 'text' as const, text: `${apps.length} application(s) in ${args.projectFilePath}:\n${lines.join('\n')}` }],
        isError: false,
      };
    }
  );

  s.tool(
    'set_active_application',
    "Makes one application the project's ACTIVE application (project.active_application) and saves the project, so every following build/online/version tool acts on it. Only needed in multi-device projects. Accepts the full path ('Master/Plc Logic/Application'), the device name ('Master') or a unique application name; use list_applications to see the candidates. Alternatively pass applicationPath directly to the individual tools.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().describe("Application to activate: full path, device name, or unique application name."),
    },
    async (args: { projectFilePath: string; applicationPath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'set_active_application',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath) },
        ['ensure_project_open', 'select_application']
      );
      const result = await executor.executeScript(script);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const m = result.output.match(/Active application:\s*(.+)/);
      return {
        content: [{ type: 'text' as const, text: `Active application: ${m ? m[1].trim() : args.applicationPath}. Project saved.` }],
        isError: false,
      };
    }
  );

  // ─── Network Variable Lists (NVL) via the Automation Platform API ─────
  // The scripting API has no NVL support. These tools use the AP interfaces
  // (GVLObject.dll IGVLObject2/INetVarProperties, NVLObject.dll INVLObject)
  // from inside the IDE's IronPython, reflected from the SP21 P5 assemblies.

  s.tool(
    'set_nvl_sender',
    "Turns an existing GVL into a Network Variable List SENDER (UDP) or updates its network properties: list identifier, task, cyclic interval, broadcast address, port, pack/checksum/acknowledge flags. Uses the IDE's Automation Platform API (no scripting-API equivalent exists). Saves the project. Multi-device projects: pass applicationPath or a full gvlPath ('Master/Plc Logic/Application/GVL_NvlTx').",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      gvlPath: z.string().describe("Path of the GVL to make a sender (e.g. 'Application/GVL_NvlTx' or 'Master/Plc Logic/Application/GVL_NvlTx')."),
      listIdentifier: z.number().int().min(1).describe("NVL list identifier (COB-ID), unique per sender on the network."),
      taskName: z.string().describe("Task that sends the list (e.g. 'MainTask')."),
      port: z.number().int().optional().describe("UDP port. Default 1202."),
      broadcastAddress: z.string().optional().describe("UDP broadcast address. Default '255.255.255.255'."),
      interval: z.string().optional().describe("Cyclic transmission interval as IEC TIME literal. Default 'T#100ms'."),
      minGap: z.string().optional().describe("Minimum gap for on-change transmission. Default 'T#20ms'."),
      cyclic: z.boolean().optional().describe("Cyclic transmission. Default true."),
      onChange: z.boolean().optional().describe("Transmit on change. Default false."),
      packVariables: z.boolean().optional().describe("Pack variables. Default true."),
      checksum: z.boolean().optional().describe("Transmit checksum. Default false."),
      acknowledge: z.boolean().optional().describe("Acknowledgement. Default false."),
    },
    async (args: { projectFilePath: string; applicationPath?: string; gvlPath: string; listIdentifier: number; taskName: string; port?: number; broadcastAddress?: string; interval?: string; minGap?: string; cyclic?: boolean; onChange?: boolean; packVariables?: boolean; checksum?: boolean; acknowledge?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'set_nvl_sender',
        {
          PROJECT_FILE_PATH: escaped,
          APPLICATION_PATH: appPathLiteral(args.applicationPath),
          GVL_PATH: pyStringLiteral(sanitizePouPath(args.gvlPath)),
          LIST_IDENTIFIER: String(args.listIdentifier),
          TASK_NAME: pyStringLiteral(args.taskName),
          PORT: String(args.port ?? 1202),
          BROADCAST_ADDRESS: pyStringLiteral(args.broadcastAddress ?? '255.255.255.255'),
          INTERVAL: pyStringLiteral(args.interval ?? 'T#100ms'),
          MIN_GAP: pyStringLiteral(args.minGap ?? 'T#20ms'),
          CYCLIC: pyBool(args.cyclic ?? true),
          ON_CHANGE: pyBool(args.onChange ?? false),
          PACK_VARIABLES: pyBool(args.packVariables ?? true),
          CHECKSUM: pyBool(args.checksum ?? false),
          ACKNOWLEDGE: pyBool(args.acknowledge ?? false),
        },
        ['ensure_project_open', 'select_application', 'find_object_by_path']
      );
      const result = await executor.executeScript(script, 120_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const a = result.output.indexOf('### NVL_SENDER_START ###');
      const b = result.output.indexOf('### NVL_SENDER_END ###');
      const summary = a !== -1 && b !== -1 && a < b ? result.output.substring(a + 24, b).trim() : '';
      return { content: [{ type: 'text' as const, text: `NVL sender configured on '${args.gvlPath}' (list ${args.listIdentifier}, task ${args.taskName}). Project saved.${summary ? `\n${summary}` : ''}` }], isError: false };
    }
  );

  s.tool(
    'create_nvl_receiver',
    "Adds a 'Network Variable List (Receiver)' object under an application (or updates an existing one with that name) and binds it to a sender GVL: sender, task, list identifier, UDP port/broadcast. Uses the Automation Platform API. Saves the project. If the object factory call is rejected on this CODESYS build, the error lists the object manager's members so the tool can be adjusted.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      receiverName: z.string().describe("Name of the receiver object (e.g. 'NVL_Rx_Node1')."),
      parentPath: z.string().describe("Where to create it (e.g. 'Master/Plc Logic/Application')."),
      senderGvlPath: z.string().describe("Path of the sender GVL in this project (e.g. 'Slave/Plc Logic/Application/GVL_NvlTx')."),
      taskName: z.string().describe("Task that receives the list (e.g. 'MainTask')."),
      listIdentifier: z.number().int().min(1).describe("List identifier of the sender."),
      port: z.number().int().optional().describe("UDP port. Default 1202."),
      broadcastAddress: z.string().optional().describe("UDP broadcast address. Default '255.255.255.255'."),
    },
    async (args: { projectFilePath: string; applicationPath?: string; receiverName: string; parentPath: string; senderGvlPath: string; taskName: string; listIdentifier: number; port?: number; broadcastAddress?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'create_nvl_receiver',
        {
          PROJECT_FILE_PATH: escaped,
          APPLICATION_PATH: appPathLiteral(args.applicationPath),
          RECEIVER_NAME: pyStringLiteral(args.receiverName),
          PARENT_PATH: pyStringLiteral(sanitizePouPath(args.parentPath)),
          SENDER_GVL_PATH: pyStringLiteral(sanitizePouPath(args.senderGvlPath)),
          TASK_NAME: pyStringLiteral(args.taskName),
          LIST_IDENTIFIER: String(args.listIdentifier),
          PORT: String(args.port ?? 1202),
          BROADCAST_ADDRESS: pyStringLiteral(args.broadcastAddress ?? '255.255.255.255'),
        },
        ['ensure_project_open', 'select_application', 'find_object_by_path']
      );
      const result = await executor.executeScript(script, 120_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const a = result.output.indexOf('### NVL_RECEIVER_START ###');
      const b = result.output.indexOf('### NVL_RECEIVER_END ###');
      const summary = a !== -1 && b !== -1 && a < b ? result.output.substring(a + 26, b).trim() : '';
      return { content: [{ type: 'text' as const, text: `NVL receiver '${args.receiverName}' under '${args.parentPath}' bound to '${args.senderGvlPath}' (list ${args.listIdentifier}, task ${args.taskName}). Project saved.${summary ? `\n${summary}` : ''}` }], isError: false };
    }
  );

  s.tool(
    'application_build',
    "Runs a build action on the active application: 'generate_code' (full code generation, what F11 does), 'rebuild' (clean + build), or 'clean' (remove compile info for this application). For a plain incremental build use compile_project. Check results with get_compile_messages.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      action: z.enum(['generate_code', 'rebuild', 'clean']).describe("Build action to run."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; action: 'generate_code' | 'rebuild' | 'clean' }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'application_build_action',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath), ACTION: args.action },
        ['ensure_project_open', 'select_application']
      );
      const result = await executor.executeScript(script, 300_000);
      return formatToolResponse(result, `${args.action} executed. Use get_compile_messages for details.`);
    }
  );

  s.tool(
    'check_online_change',
    "Checks whether an ONLINE CHANGE is currently possible for the active application (app.is_online_change_possible) — i.e. whether download_to_device would do an online change instead of a full download. Read-only.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
    },
    async (args: { applicationPath?: string; projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'check_online_change',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath) },
        ['ensure_project_open', 'select_application']
      );
      const result = await executor.executeScript(script);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const m = result.output.match(/Online Change Possible:\s*(.+)/);
      return { content: [{ type: 'text' as const, text: `Online change possible: ${m ? m[1].trim() : 'unknown'}` }], isError: false };
    }
  );

  s.tool(
    'move_object',
    "Moves an object to a new parent in the project tree (obj.move) and saves. Pass an empty/omitted newParentPath to move to the project top level.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      objectPath: z.string().describe("Path of the object to move (e.g. 'Application/MyPOU')."),
      newParentPath: z.string().optional().describe("Path of the new parent (e.g. 'Application/Folder1'). Omit for project top level."),
      newIndex: z.number().int().optional().describe("Index within the new parent. Default -1 (append)."),
    },
    async (args: { projectFilePath: string; objectPath: string; newParentPath?: string; newIndex?: number }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'move_object',
        {
          PROJECT_FILE_PATH: escaped,
          OBJECT_PATH: sanitizePouPath(args.objectPath),
          NEW_PARENT_PATH: args.newParentPath ? sanitizePouPath(args.newParentPath) : '',
          NEW_INDEX: String(args.newIndex ?? -1),
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(
        result,
        `Object '${args.objectPath}' moved to '${args.newParentPath || '<project root>'}'. Project saved.`,
        escaped,
        mirrorCtx
      );
    }
  );

  s.tool(
    'get_signature_crc',
    "Reads the signature CRC of a POU (obj.get_signature_crc) — changes when the POU's public interface changes, useful for API-compatibility checks. Requires a successful build first (compile_project). Read-only.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      objectPath: z.string().describe("Path of the POU (e.g. 'Application/MyFB')."),
    },
    async (args: { projectFilePath: string; objectPath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'get_signature_crc',
        { PROJECT_FILE_PATH: escaped, OBJECT_PATH: sanitizePouPath(args.objectPath) },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const m = result.output.match(/Signature CRC:\s*(.+)/);
      return { content: [{ type: 'text' as const, text: `${args.objectPath} signature CRC: ${m ? m[1].trim() : 'unknown'}` }], isError: false };
    }
  );

  s.tool(
    'set_exclude_from_build',
    "Sets or clears the 'Exclude from build' flag on an object (obj.exclude_from_build) and saves. Excluded objects are ignored by the compiler. Note a parent's true value overrides a child's false.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      objectPath: z.string().describe("Path of the object (e.g. 'Application/TestPOU')."),
      exclude: z.boolean().describe("true = exclude from build; false = include."),
    },
    async (args: { projectFilePath: string; objectPath: string; exclude: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'set_exclude_from_build',
        {
          PROJECT_FILE_PATH: escaped,
          OBJECT_PATH: sanitizePouPath(args.objectPath),
          EXCLUDE: pyBool(args.exclude),
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(
        result,
        `exclude_from_build=${args.exclude} set on '${args.objectPath}'. Project saved.`,
        escaped,
        mirrorCtx
      );
    }
  );

  // ─── Device Config & Task Config Tools (SP21 coverage phase 4) ───────
  // API: SP21 ScriptDeviceObject.pyi / ScriptDeviceParameters.pyi /
  // ScriptTaskConfigObject.pyi.

  const DEVICE_HELPERS = ['ensure_project_open', 'find_object_by_path', 'find_device_object'];

  s.tool(
    'list_device_parameters',
    "Lists all device parameters of a device (device.device_parameters + each connector's parameters): scope, id, name, value, unit. Omit devicePath for the first device in the project. Read-only.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      devicePath: z.string().optional().describe("Tree path of the device. Omit for the first device in the project."),
    },
    async (args: { projectFilePath: string; devicePath?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'list_device_parameters',
        { PROJECT_FILE_PATH: escaped, DEVICE_PATH: args.devicePath ? sanitizePouPath(args.devicePath) : '' },
        DEVICE_HELPERS
      );
      const result = await executor.executeScript(script, 60_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const body = extractMarkerText(result.output, '### PARAMS_START ###', '### PARAMS_END ###');
      return { content: [{ type: 'text' as const, text: `Device parameters (scope\tid\tname\tvalue\tunit):\n${body || '<none>'}` }], isError: false };
    }
  );

  s.tool(
    'get_device_parameter',
    "Reads one device parameter's current value, found by name or id (see list_device_parameters). Read-only.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      devicePath: z.string().optional().describe("Tree path of the device. Omit for the first device."),
      parameterName: z.string().optional().describe("Parameter name (matches name or visible_name)."),
      parameterId: z.number().int().optional().describe("Parameter id (unique within its parameter list)."),
    },
    async (args: { projectFilePath: string; devicePath?: string; parameterName?: string; parameterId?: number }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      if (!args.parameterName && args.parameterId === undefined) {
        return { content: [{ type: 'text' as const, text: 'Error: provide parameterName or parameterId.' }], isError: true };
      }
      const script = scriptManager.prepareScriptWithHelpers(
        'set_device_parameter',
        {
          PROJECT_FILE_PATH: escaped,
          DEVICE_PATH: args.devicePath ? sanitizePouPath(args.devicePath) : '',
          PARAM_NAME: pyStringLiteral(args.parameterName ?? ''),
          PARAM_ID: args.parameterId !== undefined ? String(args.parameterId) : '',
          NEW_VALUE: pyStringLiteral(''),
          GET_ONLY: 'True',
          ELEMENT_INDEX: '',
        },
        DEVICE_HELPERS
      );
      const result = await executor.executeScript(script, 60_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const m = result.output.match(/Parameter:\s*(.+)\r?\nValue:\s*(.+)/);
      // Array/struct parameters carry their data in sub-elements; show them.
      const subs = result.output.match(/SubElements:[\s\S]*?(?=SCRIPT_SUCCESS)/);
      const scalar = m ? `${m[1].trim()} = ${m[2].trim()}` : result.output;
      return { content: [{ type: 'text' as const, text: subs ? `${scalar}\n${subs[0].trimEnd()}` : scalar }], isError: false };
    }
  );

  s.tool(
    'set_device_parameter',
    "Writes a device parameter's value (offline, in the project) and saves. Find the parameter by name or id (see list_device_parameters). Array/struct parameters: pass value as '[v0, v1, ...]' to write all elements, or set elementIndex to write one. Takes effect on the PLC after the next download.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      devicePath: z.string().optional().describe("Tree path of the device. Omit for the first device."),
      parameterName: z.string().optional().describe("Parameter name (matches name or visible_name)."),
      parameterId: z.number().int().optional().describe("Parameter id."),
      value: z.string().describe("New value (string form, e.g. '1', 'true', '230'; or '[1, 2, 3]' for a whole array parameter)."),
      elementIndex: z.number().int().min(0).optional().describe("For array/struct parameters: write only this sub-element (0-based). Omit for scalar parameters or whole-array writes."),
    },
    async (args: { projectFilePath: string; devicePath?: string; parameterName?: string; parameterId?: number; value: string; elementIndex?: number }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      if (!args.parameterName && args.parameterId === undefined) {
        return { content: [{ type: 'text' as const, text: 'Error: provide parameterName or parameterId.' }], isError: true };
      }
      const script = scriptManager.prepareScriptWithHelpers(
        'set_device_parameter',
        {
          PROJECT_FILE_PATH: escaped,
          DEVICE_PATH: args.devicePath ? sanitizePouPath(args.devicePath) : '',
          PARAM_NAME: pyStringLiteral(args.parameterName ?? ''),
          PARAM_ID: args.parameterId !== undefined ? String(args.parameterId) : '',
          NEW_VALUE: pyStringLiteral(args.value),
          GET_ONLY: 'False',
          ELEMENT_INDEX: args.elementIndex !== undefined ? String(args.elementIndex) : '',
        },
        DEVICE_HELPERS
      );
      const result = await executor.executeScript(script, 60_000);
      return await formatModifyingResponse(
        result,
        `Device parameter ${args.parameterName ?? args.parameterId}${args.elementIndex !== undefined ? `[${args.elementIndex}]` : ''} set to '${args.value}'. Project saved.`,
        escaped,
        mirrorCtx
      );
    }
  );

  s.tool(
    'export_io_mappings_csv',
    "Exports a device's IO variable mappings to a CSV file (device.export_io_mappings_as_csv) — the standard way to review/edit IO mapping in bulk. Read-only on the project.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      csvPath: z.string().describe("Absolute path to write the CSV to."),
      devicePath: z.string().optional().describe("Tree path of the device. Omit for the first device."),
    },
    async (args: { projectFilePath: string; csvPath: string; devicePath?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const escCsv = resolvePath(args.csvPath, workspaceDir);
      const uncErr = uncPathError(escCsv);
      if (uncErr) {
        return { content: [{ type: 'text' as const, text: uncErr }], isError: true };
      }
      const script = scriptManager.prepareScriptWithHelpers(
        'io_mappings_csv',
        {
          PROJECT_FILE_PATH: escaped,
          DEVICE_PATH: args.devicePath ? sanitizePouPath(args.devicePath) : '',
          CSV_PATH: escCsv,
          DIRECTION: 'export',
        },
        DEVICE_HELPERS
      );
      const result = await executor.executeScript(script, 60_000);
      return formatToolResponse(result, `IO mappings exported to: ${escCsv}`);
    }
  );

  s.tool(
    'import_io_mappings_csv',
    "Imports a device's IO variable mappings from a CSV file (device.import_io_mappings_from_csv) and saves. Usually a round-trip partner of export_io_mappings_csv.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      csvPath: z.string().describe("Absolute path of the CSV to import."),
      devicePath: z.string().optional().describe("Tree path of the device. Omit for the first device."),
    },
    async (args: { projectFilePath: string; csvPath: string; devicePath?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const escCsv = resolvePath(args.csvPath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'io_mappings_csv',
        {
          PROJECT_FILE_PATH: escaped,
          DEVICE_PATH: args.devicePath ? sanitizePouPath(args.devicePath) : '',
          CSV_PATH: escCsv,
          DIRECTION: 'import',
        },
        DEVICE_HELPERS
      );
      const result = await executor.executeScript(script, 60_000);
      return await formatModifyingResponse(result, `IO mappings imported from: ${escCsv}. Project saved.`, escaped, mirrorCtx);
    }
  );

  s.tool(
    'set_device_state',
    "Changes a device's state in the project and saves: 'enable'/'disable' (included in download or not) or 'simulation_on'/'simulation_off' (device runs in simulation mode).",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      action: z.enum(['enable', 'disable', 'simulation_on', 'simulation_off']).describe("State change to apply."),
      devicePath: z.string().optional().describe("Tree path of the device. Omit for the first device."),
    },
    async (args: { projectFilePath: string; action: 'enable' | 'disable' | 'simulation_on' | 'simulation_off'; devicePath?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'set_device_state',
        {
          PROJECT_FILE_PATH: escaped,
          DEVICE_PATH: args.devicePath ? sanitizePouPath(args.devicePath) : '',
          ACTION: args.action,
        },
        DEVICE_HELPERS
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(result, `Device state changed: ${args.action}. Project saved.`, escaped, mirrorCtx);
    }
  );

  s.tool(
    'get_device_identification',
    "Reads a device's identification (type/id/version from the device description) plus device_name, address, enabled and simulation state. Read-only.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      devicePath: z.string().optional().describe("Tree path of the device. Omit for the first device."),
    },
    async (args: { projectFilePath: string; devicePath?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'get_device_identification',
        { PROJECT_FILE_PATH: escaped, DEVICE_PATH: args.devicePath ? sanitizePouPath(args.devicePath) : '' },
        DEVICE_HELPERS
      );
      const result = await executor.executeScript(script);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const text = extractMarkerText(result.output, '### DEVICE_ID_START ###', '### DEVICE_ID_END ###');
      return { content: [{ type: 'text' as const, text }], isError: false };
    }
  );

  s.tool(
    'create_task',
    "Creates a new task in the Task Configuration (task_config.create_task) and saves. Refuses duplicate names. Follow up with configure_task (kind/priority/interval) and add_pou_to_task.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      taskName: z.string().describe("Name for the new task (valid IEC identifier)."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; taskName: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'create_task',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath), TASK_NAME: args.taskName.trim() },
        ['ensure_project_open', 'select_application']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(result, `Task '${args.taskName}' created. Project saved.`, escaped, mirrorCtx);
    }
  );

  s.tool(
    'configure_task',
    "Sets properties on an existing task and saves: kind (cyclic/freewheeling/event/external_event/status), priority (0-31), interval + intervalUnit (for cyclic/external_event), event POU (for event kind). Only provided fields change. Use list_tasks to inspect.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      taskName: z.string().describe("Name of the task to configure."),
      kind: z.enum(['cyclic', 'freewheeling', 'event', 'external_event', 'status']).optional().describe("Task kind (KindOfTask)."),
      priority: z.string().optional().describe("Task priority, e.g. '1' (0 = highest)."),
      interval: z.string().optional().describe("Cycle interval value, e.g. 't#20ms' or '20' (depends on unit)."),
      intervalUnit: z.string().optional().describe("Interval unit, e.g. 'ms' or 'us'."),
      event: z.string().optional().describe("Event to trigger the task (for kind=event)."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; taskName: string; kind?: string; priority?: string; interval?: string; intervalUnit?: string; event?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      if (!args.kind && !args.priority && !args.interval && !args.intervalUnit && !args.event) {
        return { content: [{ type: 'text' as const, text: 'Error: provide at least one property to configure.' }], isError: true };
      }
      const script = scriptManager.prepareScriptWithHelpers(
        'configure_task',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          TASK_NAME: args.taskName.trim(),
          KIND: args.kind ?? '',
          PRIORITY: args.priority ?? '',
          INTERVAL: args.interval ?? '',
          INTERVAL_UNIT: args.intervalUnit ?? '',
          EVENT: pyStringLiteral(args.event ?? ''),
        },
        ['ensure_project_open', 'select_application']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(result, `Task '${args.taskName}' configured. Project saved.`, escaped, mirrorCtx);
    }
  );

  // ─── Project Users & Misc Object Tools (SP21 coverage phase 5) ───────
  // API: SP21 ScriptUserManagement.pyi / ScriptTextListObject.pyi /
  // ScriptImagePoolObject.pyi / ScriptExternalFileObject.pyi.

  s.tool(
    'list_project_users',
    "Lists the PROJECT user management's users and groups (project.user_management — access protection on the project file, distinct from device users). Read-only.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'list_project_users',
        { PROJECT_FILE_PATH: escaped },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const body = extractMarkerText(result.output, '### USERS_START ###', '### USERS_END ###');
      return { content: [{ type: 'text' as const, text: body || 'No project users or groups defined.' }], isError: false };
    }
  );

  s.tool(
    'add_project_user',
    "Creates a user in the PROJECT user management (project access protection, not device users — for those use add_device_user). Optionally sets full name and password. Saves the project.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      userName: z.string().describe("Name for the new user (unique)."),
      fullName: z.string().optional().describe("Informative full name."),
      password: z.string().optional().describe("Initial password."),
      adminUser: z.string().optional().describe("User-management account to log in as before modifying. Default 'Owner'."),
      adminPassword: z.string().optional().describe("Password for adminUser. Default empty (the CODESYS default for Owner)."),
    },
    async (args: { projectFilePath: string; userName: string; fullName?: string; password?: string; adminUser?: string; adminPassword?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'add_project_user',
        {
          PROJECT_FILE_PATH: escaped,
          USER_NAME: args.userName.trim(),
          FULL_NAME: pyStringLiteral(args.fullName ?? ''),
          PASSWORD: pyStringLiteral(args.password ?? ''),
          ADMIN_USER: pyStringLiteral(args.adminUser ?? ''),
          ADMIN_PASSWORD: pyStringLiteral(args.adminPassword ?? ''),
        },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(result, `Project user '${args.userName}' created. Project saved.`, escaped, mirrorCtx);
    }
  );

  s.tool(
    'remove_project_user',
    "Removes a user from the PROJECT user management and saves. DESTRUCTIVE for that user's access — confirm with the user first if you did not just create it.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      userName: z.string().describe("Name (or id) of the user to remove."),
      adminUser: z.string().optional().describe("User-management account to log in as before modifying. Default 'Owner'."),
      adminPassword: z.string().optional().describe("Password for adminUser. Default empty (the CODESYS default for Owner)."),
    },
    async (args: { projectFilePath: string; userName: string; adminUser?: string; adminPassword?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'remove_project_user',
        {
          PROJECT_FILE_PATH: escaped,
          USER_NAME: args.userName.trim(),
          ADMIN_USER: pyStringLiteral(args.adminUser ?? ''),
          ADMIN_PASSWORD: pyStringLiteral(args.adminPassword ?? ''),
        },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(result, `Project user '${args.userName}' removed. Project saved.`, escaped, mirrorCtx);
    }
  );

  s.tool(
    'create_text_list',
    "Creates a Text List object (for visualization texts / translations) under the given parent (or project root) and saves. Fill it via import_text_list_file.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      name: z.string().describe("Name for the new text list."),
      parentPath: z.string().optional().describe("Parent path. Omit for project top level."),
    },
    async (args: { projectFilePath: string; name: string; parentPath?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'create_text_list',
        {
          PROJECT_FILE_PATH: escaped,
          LIST_NAME: args.name.trim(),
          PARENT_PATH: args.parentPath ? sanitizePouPath(args.parentPath) : '',
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(result, `Text list '${args.name}' created. Project saved.`, escaped, mirrorCtx);
    }
  );

  s.tool(
    'import_text_list_file',
    "Imports entries into an existing text list from a text-list export file (textlist.importfile — same format as the IDE's import/export dialog) and saves.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      textListPath: z.string().describe("Tree path of the text list object."),
      importFile: z.string().describe("Path of the text list file to import."),
    },
    async (args: { projectFilePath: string; textListPath: string; importFile: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const escImport = resolvePath(args.importFile, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'import_text_list_file',
        {
          PROJECT_FILE_PATH: escaped,
          TEXTLIST_PATH: sanitizePouPath(args.textListPath),
          IMPORT_FILE: escImport,
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(result, `Text list entries imported from: ${escImport}. Project saved.`, escaped, mirrorCtx);
    }
  );

  s.tool(
    'create_image_pool',
    "Creates an Image Pool object (for visualization images) under the given parent (or project root) and saves.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      name: z.string().describe("Name for the new image pool."),
      parentPath: z.string().optional().describe("Parent path. Omit for project top level."),
    },
    async (args: { projectFilePath: string; name: string; parentPath?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'create_image_pool',
        {
          PROJECT_FILE_PATH: escaped,
          POOL_NAME: args.name.trim(),
          PARENT_PATH: args.parentPath ? sanitizePouPath(args.parentPath) : '',
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(result, `Image pool '${args.name}' created. Project saved.`, escaped, mirrorCtx);
    }
  );

  s.tool(
    'add_external_file',
    "Adds an external file to the project as an External File object (embed/link/link_and_embed) and saves. Useful for shipping docs, configs or certificates inside the .project.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      filePath: z.string().describe("Path of the file to add."),
      name: z.string().optional().describe("Object name. Omit to use the file's base name."),
      parentPath: z.string().optional().describe("Parent path. Omit for project top level."),
      referenceMode: z.enum(['embed', 'link', 'link_and_embed']).optional().describe("How the file is referenced. Default 'embed'."),
      autoUpdateMode: z.enum(['always', 'prompt', 'never']).optional().describe("How changes on the physical file propagate. Default 'never'."),
    },
    async (args: { projectFilePath: string; filePath: string; name?: string; parentPath?: string; referenceMode?: string; autoUpdateMode?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const escFile = resolvePath(args.filePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'add_external_file',
        {
          PROJECT_FILE_PATH: escaped,
          FILE_PATH: escFile,
          OBJECT_NAME: args.name ?? '',
          PARENT_PATH: args.parentPath ? sanitizePouPath(args.parentPath) : '',
          REFERENCE_MODE: args.referenceMode ?? 'embed',
          AUTO_UPDATE_MODE: args.autoUpdateMode ?? 'never',
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return await formatModifyingResponse(result, `External file added: ${escFile}. Project saved.`, escaped, mirrorCtx);
    }
  );

  // Extract a JSON block between marker lines and pretty-print it; if no
  // markers found, return the raw output. Used by the device tools so the
  // agent actually sees the scan results / reachability candidates.
  const extractMarkerJson = (output: string, startMarker: string, endMarker: string): string => {
    const startIdx = output.indexOf(startMarker);
    const endIdx = output.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
      return output.trim();
    }
    const raw = output.substring(startIdx + startMarker.length, endIdx).trim();
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  };

  s.tool(
    'scan_network_devices',
    "Drive the gateway's Scan Network on the project's configured device. Returns the list of physical CODESYS targets currently visible to the gateway (device_name, type_name, vendor_name, address, device_id). Useful when the cached device address is stale and you need to find where the PLC actually is now. Set useCache=true to return the gateway's last scan result without re-scanning (cheap polling).",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      useCache: z.boolean().optional().describe("If true, return the gateway's cached scan result if available. Default false (live scan)."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; useCache?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'scan_network_devices',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath), USE_CACHE: args.useCache ? '1' : '0' },
        ['ensure_project_open', 'select_application', 'find_target_device']
      );
      const result = await executor.executeScript(script, 60_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const json = extractMarkerJson(result.output, '### NETWORK_SCAN_START ###', '### NETWORK_SCAN_END ###');
      return { content: [{ type: 'text' as const, text: `Network scan for ${args.projectFilePath}:\n${json}` }], isError: false };
    }
  );

  s.tool(
    'verify_device_reachable',
    "Pre-flight check for download/connect: scans the gateway and reports whether the project's cached device address actually matches a live target. Returns reachable=true if the cached address is in the scan results, false otherwise (with the full candidate list so the caller can rebind). The download_to_device tool runs this automatically; you only need to call it directly when you want to know the state without committing to a download.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
    },
    async (args: { applicationPath?: string; projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'verify_device_reachable',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath) },
        ['ensure_project_open', 'select_application', 'find_target_device']
      );
      const result = await executor.executeScript(script, 60_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const json = extractMarkerJson(result.output, '### DEVICE_REACHABILITY_START ###', '### DEVICE_REACHABILITY_END ###');
      return { content: [{ type: 'text' as const, text: `Reachability for ${args.projectFilePath}:\n${json}` }], isError: false };
    }
  );

  s.tool(
    'rebind_device_to_scan_result',
    "Re-bind the project's configured device to a fresh scan result (typically same PLC, new gateway address after reboot/DHCP). Match priority: (1) matchName (exact, case-insensitive); (2) matchDeviceId; (3) matchAddress (forced, no scan); (4) single scan candidate. If multiple ambiguous matches exist, refuses and returns the candidate list. On success, calls device.set_gateway_and_address() and saves the project.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      matchName: z.string().optional().describe("Match by device_name from the scan (exact, case-insensitive). E.g. 'codesys-pi'."),
      matchDeviceId: z.string().optional().describe("Match by device_id from the scan."),
      matchAddress: z.string().optional().describe("Force a specific address. Either a router address (e.g. '0301.3053') or an IP-form address 'ip[:port]' (e.g. '127.0.0.1:11740' for an SSH-tunnelled PLC) -- IP form binds via set_gateway_and_ip_address, no UDP discovery needed. Skips the scan step entirely."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; matchName?: string; matchDeviceId?: string; matchAddress?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'rebind_device_to_scan',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          MATCH_NAME: args.matchName ?? '',
          MATCH_DEVICE_ID: args.matchDeviceId ?? '',
          MATCH_ADDRESS: args.matchAddress ?? '',
        },
        ['ensure_project_open', 'select_application', 'find_target_device']
      );
      const result = await executor.executeScript(script, 60_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const json = extractMarkerJson(result.output, '### REBIND_RESULT_START ###', '### REBIND_RESULT_END ###');
      return { content: [{ type: 'text' as const, text: `Rebind for ${args.projectFilePath}:\n${json}` }], isError: false };
    }
  );

  s.tool(
    'grant_object_access',
    "Set Access Control permissions on a project object for a user group. Maps to the IDE's 'Properties -> Access Control' Groups/Actions/Permissions matrix (the dialog reachable via right-click -> Properties on any project object). Required for the Symbol Configuration object before a downloaded OPC UA server will expose any UserIdentityToken policies -- if the group has no View/Modify on the Symbol Configuration, the server has nothing to expose. Common usage: grant 'Everyone' View+Modify on 'CodesysRpi/Plc Logic/Application/Symbols' to enable OPC UA reads/writes for any authenticated user. Saves the project.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      objectPath: z.string().describe("Slash-separated path to the target object, e.g. 'CodesysRpi/Plc Logic/Application/Symbols' for the Symbol Configuration."),
      groupName: z.string().describe("Group whose permission to set (e.g. 'Everyone', 'Owner'). Use 'Everyone' for anonymous-OPC-UA scenarios."),
      permissions: z.array(z.enum(['View', 'Modify', 'Remove', 'AddRemoveChildren'])).optional().describe("Which permissions to apply. Omit or pass empty to apply all four."),
      state: z.enum(['Granted', 'Denied', 'Default']).optional().describe("Granted (default) explicitly allows. Denied explicitly blocks. Default clears the override and falls back to inheritance / default."),
    },
    async (args: {
      projectFilePath: string;
      objectPath: string;
      groupName: string;
      permissions?: Array<'View' | 'Modify' | 'Remove' | 'AddRemoveChildren'>;
      state?: 'Granted' | 'Denied' | 'Default';
    }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const perms = (args.permissions && args.permissions.length > 0)
        ? args.permissions.join(',')
        : 'View,Modify,Remove,AddRemoveChildren';
      const script = scriptManager.prepareScriptWithHelpers(
        'grant_object_access',
        {
          PROJECT_FILE_PATH: escaped,
          OBJECT_PATH: args.objectPath,
          GROUP_NAME: args.groupName,
          PERMISSIONS: perms,
          STATE: args.state ?? 'Granted',
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script, 120_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const json = extractMarkerJson(result.output, '### GRANT_ACCESS_RESULT_START ###', '### GRANT_ACCESS_RESULT_END ###');
      return { content: [{ type: 'text' as const, text: `Access for ${args.projectFilePath}:\n${json}` }], isError: false };
    }
  );

  s.tool(
    'add_device_user',
    "Add (or update password of) a user in the PLC runtime's live User Management. Required for OPC UA authentication on CODESYS Control SP16+ -- the OPC UA server reads its UserIdentityToken policies from this database, NOT from CODESYSControl.cfg. Without at least one user, UaExpert/OPC UA clients get BadIdentityTokenInvalid. Requires an active device session; the script ensures one is open before calling create_live_user_management().",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      userName: z.string().describe("User name to add (or whose password to update if user already exists)."),
      userPassword: z.string().describe("Password for the user."),
      canChangePassword: z.boolean().optional().describe("If true (default), the user can change their own password."),
      mustChangePassword: z.boolean().optional().describe("If true, the user must change their password on next login. Default false."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; userName: string; userPassword: string; canChangePassword?: boolean; mustChangePassword?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'add_device_user',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          USER_NAME: args.userName,
          USER_PASSWORD: args.userPassword,
          CAN_CHANGE_PASSWORD: args.canChangePassword === false ? '0' : '1',
          MUST_CHANGE_PASSWORD: args.mustChangePassword === true ? '1' : '0',
        },
        ['ensure_project_open', 'select_application']
      );
      const result = await executor.executeScript(script, 30_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }
      const json = extractMarkerJson(result.output, '### DEVICE_USER_ADDED_START ###', '### DEVICE_USER_ADDED_END ###');
      return { content: [{ type: 'text' as const, text: `Device user for ${args.projectFilePath}:\n${json}` }], isError: false };
    }
  );

  s.tool(
    'download_to_device',
    'Downloads the compiled application to the PLC device. Attempts online change first, falls back to full download. PRE-FLIGHT: this tool automatically runs verify_device_reachable BEFORE attempting login(), and refuses to proceed if the cached device address is not in the live scan results -- the user must rebind (call rebind_device_to_scan_result) or set skipReachabilityCheck=true to force. AGENT BEHAVIOUR REQUIRED: BEFORE calling this tool, the agent MUST announce in user-facing chat what it is about to do AND warn that a modal "Device User Login" dialog may pop in the CODESYS IDE (the agent cannot see or dismiss it). The user must be ready to click. Same credential-injection support as connect_to_device: pass deviceUser+devicePassword (or set CODESYS_DEVICE_USER/CODESYS_DEVICE_PASSWORD env vars on the MCP) to suppress the dialog that the IDE otherwise pops on every download.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      loginWaitSeconds: z.number().int().min(0).max(600).optional().describe("Seconds to wait for application state to stabilise after login() returns. Default: 10. Range 0-600. Keep this short -- a dialog gets clicked in seconds, not minutes."),
      deviceUser: z.string().optional().describe("Device user account. Pre-registered via set_default_credentials so the modal Device User Login dialog is suppressed. Falls back to env CODESYS_DEVICE_USER."),
      devicePassword: z.string().optional().describe("Device user password. Falls back to env CODESYS_DEVICE_PASSWORD."),
      skipReachabilityCheck: z.boolean().optional().describe("If true, skip the verify_device_reachable pre-flight and go straight to login()/download(). Only use when the gateway/cache lookup is itself broken (e.g. CODESYS doesn't expose the gateway list on this SP). Default false."),
    },
    async (args: { applicationPath?: string;
      projectFilePath: string;
      loginWaitSeconds?: number;
      deviceUser?: string;
      devicePassword?: string;
      skipReachabilityCheck?: boolean;
    }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const waitSec = args.loginWaitSeconds ?? 10;
      const deviceUser = args.deviceUser ?? process.env.CODESYS_DEVICE_USER ?? '';
      const devicePassword = args.devicePassword ?? process.env.CODESYS_DEVICE_PASSWORD ?? '';

      // Pre-flight: scan the gateway and confirm the cached device address
      // matches a live target. Stale binding is the #1 cause of "download
      // silently hangs" because the IDE waits on a UI dialog the agent can't
      // see. Fail fast instead with a clear hint to rebind.
      if (!args.skipReachabilityCheck) {
        const verifyScript = scriptManager.prepareScriptWithHelpers(
          'verify_device_reachable',
          { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath) },
          ['ensure_project_open', 'select_application', 'find_target_device']
        );
        const verifyResult = await executor.executeScript(verifyScript, 60_000);
        const verifySuccess = verifyResult.success && verifyResult.output.includes('SCRIPT_SUCCESS');
        if (!verifySuccess) {
          return formatToolResponse(verifyResult, `Pre-flight verify_device_reachable failed for ${args.projectFilePath}. Pass skipReachabilityCheck=true to bypass.`);
        }
        const startMarker = '### DEVICE_REACHABILITY_START ###';
        const endMarker = '### DEVICE_REACHABILITY_END ###';
        const startIdx = verifyResult.output.indexOf(startMarker);
        const endIdx = verifyResult.output.indexOf(endMarker);
        if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
          try {
            const json = JSON.parse(verifyResult.output.substring(startIdx + startMarker.length, endIdx).trim());
            if (json.reachable !== true) {
              const candidateList = (json.candidates ?? [])
                .map((c: { device_name?: string; address?: string }) => `  - ${c.device_name ?? '?'} @ ${c.address ?? '?'}`)
                .join('\n');
              return {
                content: [{
                  type: 'text' as const,
                  text: `Pre-flight FAILED: device at cached address '${json.cached_address}' is not reachable. ` +
                    `Scan returned ${json.candidate_count ?? 0} candidate(s):\n${candidateList}\n\n` +
                    `Call rebind_device_to_scan_result (typically with matchName='${json.scanned_device_name || json.target_device_name || ''}') to update the binding, then retry. ` +
                    `Or pass skipReachabilityCheck=true to force the download anyway.`,
                }],
                isError: true,
              };
            }
          } catch {
            // JSON parse failed -- don't block download on a parse error.
          }
        }
      }

      const script = scriptManager.prepareScriptWithHelpers(
        'download_to_device',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          LOGIN_WAIT_SECONDS: String(waitSec),
          DEVICE_USER: pyStringLiteral(deviceUser),
          DEVICE_PASSWORD: pyStringLiteral(devicePassword),
        },
        ['register_device_credentials', 'ensure_project_open', 'select_application', 'ensure_online_connection']
      );
      // Tool-side timeout = wait window + 120s headroom for the actual download
      const ipcTimeoutMs = (waitSec + 120) * 1000;
      const result = await executor.executeScript(script, ipcTimeoutMs);
      return formatToolResponse(result, `Application downloaded to device for ${args.projectFilePath}.`);
    }
  );

  s.tool(
    'start_stop_application',
    'Starts or stops the PLC application on the connected device.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      action: z.string().describe("Action to perform: 'start' or 'stop'."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; action: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'start_stop_application',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          APP_ACTION: args.action.trim(),
        },
        ['ensure_project_open', 'select_application', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `Application ${args.action} executed for ${args.projectFilePath}.`
      );
    }
  );

  // ─── Library Management Tools ─────────────────────────────────────────

  s.tool(
    'list_project_libraries',
    "Lists every library referenced anywhere in the CODESYS project AND captures project-level metadata above the library list: Project Information (version, title, company, author), CODESYS Development System version (from IronPython sys.version), and every device's offline target identification triple (type / id / version) -- the offline 'firmware' the project is built against. The library list itself walks the project tree, finds every ScriptLibManObjectContainer (the project + each Application), gets the Library Manager via container.get_library_manager(), and enumerates lm.references for structured per-reference info (name, namespace, system/placeholder/managed flags, effective resolution). Per the helpme-codesys.com docs and the local SP22 stub Stubs/scriptengine/ScriptLibManObject.pyi.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const pinCheck = enforceVersionPin(escaped, {
        saves: false,
        profileName: config.profileName,
      });
      if (pinCheck.error) return pinCheck.error;
      const script = scriptManager.prepareScriptWithHelpers(
        'list_project_libraries', { PROJECT_FILE_PATH: escaped }, ['ensure_project_open']
      );
      const result = await executor.executeScript(script);

      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }

      // Parse libraries JSON
      const libStartMarker = '### LIBRARIES_START ###';
      const libEndMarker = '### LIBRARIES_END ###';
      const startIdx = result.output.indexOf(libStartMarker);
      const endIdx = result.output.indexOf(libEndMarker);

      if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
        return {
          content: [{ type: 'text' as const, text: 'Could not parse libraries output.' }],
          isError: true,
        };
      }

      try {
        const jsonStr = result.output.substring(startIdx + libStartMarker.length, endIdx).trim();
        type LibRef = {
          id?: string;
          name?: string;
          namespace?: string;
          is_placeholder?: boolean;
          is_managed?: boolean;
          system_library?: boolean;
          qualified_only?: boolean;
          optional?: boolean;
          placeholder_name?: string;
          effective_resolution?: string;
          default_resolution?: string;
          is_redirected?: boolean;
          resolution_info?: string;
          source?: string;
        };
        type Container = { container_name: string; libman_name: string; references: LibRef[] };
        type ProjectInfo = { version?: string | null; title?: string | null; company?: string | null; author?: string | null };
        type Device = { path: string; name?: string; device_id_type?: string; device_id_id?: string; device_id_version?: string };
        const parsed: {
          project?: string;
          project_info?: ProjectInfo;
          ide_version?: string;
          compiler_version?: string | null;
          devices?: Device[];
          containers: Container[];
          total_references: number;
        } = JSON.parse(jsonStr);

        if (!parsed.containers || parsed.containers.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  'No library managers found in the project tree. ' +
                  'Either the project really has none, or the libman discovery failed -- ' +
                  'check the script DEBUG output for a tree dump.',
              },
            ],
            isError: false,
          };
        }

        if (parsed.total_references === 0) {
          const containerNames = parsed.containers.map((c) => c.container_name).join(', ');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Found ${parsed.containers.length} library manager(s) (${containerNames}) but 0 library references in any of them.`,
              },
            ],
            isError: false,
          };
        }

        // Group output by container so the user can see which Application
        // owns which libraries.
        const sections: string[] = [];
        for (const c of parsed.containers) {
          const header = `${c.container_name} (libman: ${c.libman_name}) — ${c.references.length} reference(s)`;
          const lines = c.references.map((ref) => {
            const flags: string[] = [];
            if (ref.system_library) flags.push('system');
            if (ref.is_placeholder) flags.push('placeholder');
            if (ref.is_managed) flags.push('managed');
            if (ref.optional) flags.push('optional');
            if (ref.is_redirected) flags.push('redirected');
            const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
            const ns = ref.namespace ? ` ns=${ref.namespace}` : '';
            const eff = ref.effective_resolution ? ` -> ${ref.effective_resolution}` : '';
            return `  - ${ref.name ?? '?'}${flagStr}${ns}${eff}`;
          });
          sections.push(`${header}\n${lines.join('\n')}`);
        }

        // Header section: project version (from Project Information),
        // CODESYS Development System version (from IronPython sys.version
        // inside CODESYS), and every device's offline target id triple.
        const headerLines: string[] = [];
        const pi = parsed.project_info ?? {};
        if (pi.version || pi.title || pi.company) {
          headerLines.push('Project info:');
          if (pi.version) headerLines.push(`  Version: ${pi.version}`);
          if (pi.title) headerLines.push(`  Title:   ${pi.title}`);
          if (pi.company) headerLines.push(`  Company: ${pi.company}`);
          if (pi.author) headerLines.push(`  Author:  ${pi.author}`);
        }
        if (parsed.ide_version) {
          headerLines.push(`IDE: ${parsed.ide_version.replace(/\s+/g, ' ').trim()}`);
        }
        if (parsed.compiler_version) {
          headerLines.push(`Compiler version: ${parsed.compiler_version}`);
        }
        if (parsed.devices && parsed.devices.length > 0) {
          headerLines.push(`Devices (${parsed.devices.length}):`);
          for (const d of parsed.devices) {
            const idStr = [d.device_id_type, d.device_id_id, d.device_id_version]
              .filter(Boolean)
              .join(' / ');
            headerLines.push(`  ${d.path}${idStr ? '  [' + idStr + ']' : ''}`);
          }
        }

        const summary =
          `Project: ${parsed.project ?? '?'} — ${parsed.total_references} library reference(s) across ${parsed.containers.length} container(s).`;
        const blocks: string[] = [summary];
        if (headerLines.length > 0) blocks.push(headerLines.join('\n'));
        blocks.push(sections.join('\n\n'));
        return {
          content: [{ type: 'text' as const, text: blocks.join('\n\n') }],
          isError: false,
        };
      } catch (e) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to parse libraries JSON: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  s.tool(
    'add_library',
    "Adds a library reference to the CODESYS project. **Refuses upfront** if the library name does not resolve in the installed library repository (Tools > Library Repository) -- this prevents the silent-broken-placeholder bug where add_placeholder() creates a hollow reference that bricks the next project open with 'placeholder library X could not be resolved'. Install the library first (Library Repository for stock libs, CODESYS Installer for SL/add-on packages), or pass allowUnresolved=true to opt into the dangerous behaviour. Default add path is add_placeholder() for the modern '<Name>, * (System)' convention; pass direct=true for the legacy specific-version pin. Pre-checks lm.references and no-ops with a confirmation message if a reference with the same name already exists, unless force=true.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      libraryName: z.string().describe("Name of the library to add (e.g., 'Standard', 'Util', 'CAA Memory'). Must match exactly an installed library in the CODESYS Library Repository unless allowUnresolved=true."),
      direct: z.boolean().optional().describe("If true, use direct add_library() (specific-version pin) instead of the default add_placeholder() (resolves at compile)."),
      force: z.boolean().optional().describe("If true, add even if a reference with the same name already exists (creates a duplicate). Default: dedup -- silently no-op with a confirmation message."),
      allowUnresolved: z.boolean().optional().describe("DANGEROUS. If true, skip the pre-flight 'is this library installed?' check and add a placeholder anyway. Will brick the next project open if the library is genuinely not installed. Only use when you intentionally want a placeholder for a not-yet-installed library."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; libraryName: string; direct?: boolean; force?: boolean; allowUnresolved?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'add_library',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          LIBRARY_NAME: args.libraryName.trim(),
          USE_DIRECT: args.direct ? '1' : '0',
          FORCE_DUP: args.force ? '1' : '0',
          ALLOW_UNRESOLVED: args.allowUnresolved ? '1' : '0',
        },
        ['ensure_project_open', 'select_application']
      );
      const result = await executor.executeScript(script);
      // Pick wording from the script's branch (dedup vs add) instead of
      // always saying "added" -- script emits "Library Already Present"
      // on the dedup no-op path and "Library Added" on actual add.
      const dedupHit = result.output.includes('Library Already Present:');
      const successMessage = dedupHit
        ? `Library '${args.libraryName}' already referenced in ${args.projectFilePath}. No-op (use force=true to add a duplicate).`
        : `Library '${args.libraryName}' added to ${args.projectFilePath}. Project saved.`;
      return await formatModifyingResponse(result, successMessage, escaped, mirrorCtx);
    }
  );

  s.tool(
    'remove_library',
    "Removes a library reference from the CODESYS project's Library Manager. Idempotent: if the named library is not currently referenced, the tool succeeds with a no-op confirmation rather than an error. Accepts either the bare library name (e.g. 'Standard') or the fully-qualified 'Name, Version (Company)' form. Verifies removal in lm.references before saving. Per helpme-codesys.com ScriptLibManObject docs and the local SP22 stub Stubs/scriptengine/ScriptLibManObject.pyi.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      libraryName: z.string().describe("Bare name of the library to remove (e.g. 'Standard', 'Util'). Must match a reference currently present in the project's Library Manager."),
      libraryFqnOrName: z.string().optional().describe("Optional fully-qualified name 'Name, Version (Company)' to target a specific version when multiple references with the same bare name exist. Falls back to libraryName when omitted."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; libraryName: string; libraryFqnOrName?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const fqn = (args.libraryFqnOrName || args.libraryName).trim();
      const script = scriptManager.prepareScriptWithHelpers(
        'remove_library',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          LIBRARY_NAME: args.libraryName.trim(),
          LIBRARY_FQN_OR_NAME: fqn,
        },
        ['ensure_project_open', 'select_application']
      );
      const result = await executor.executeScript(script);
      // Script emits "Library Not Present:" on the idempotent no-op path
      // and "Library Removed:" on actual removal.
      const noopHit = result.output.includes('Library Not Present:');
      const successMessage = noopHit
        ? `Library '${args.libraryName}' not referenced in ${args.projectFilePath}. No-op.`
        : `Library '${args.libraryName}' removed from ${args.projectFilePath}. Project saved.`;
      return await formatModifyingResponse(result, successMessage, escaped, mirrorCtx);
    }
  );

  // ─── Symbol Configuration Tools ───────────────────────────────────────
  //
  // Wraps ScriptSymbolConfigObject (since CODESYS 3.5.10.0). The Symbol
  // Configuration object controls which IEC variables / FBs / methods are
  // exposed to OPC UA, web visualisations, and other external clients.
  // Reference: helpme-codesys.com/en/ScriptingEngine/ScriptSymbolConfigObject.html
  // and SP22 stub Stubs/scriptengine/ScriptSymbolConfigObject.pyi.

  // Bitmask members of SymbolConfigContentFeatureFlags (per the SP22 stub).
  const CONTENT_FEATURE_FLAG_VALUES: Record<string, number> = {
    None: 0,
    SupportOPCUA: 1,
    IncludeComments: 2,
    IncludeAttributes: 4,
    IncludeTypeNodeAttributes: 8,
    IncludeExecutables: 16,
    UseEmptyNamespaceByDefault: 32,
    XmlIncludeNodeFlags: 1 << 16,
    XmlIncludeComments: 2 << 16,
    XmlIncludeAttributes: 4 << 16,
    XmlIncludeTypeNodeAttributes: 8 << 16,
    XmlIncludeExecutables: 16 << 16,
  };

  function combineContentFeatureFlags(names: string[] | undefined): number | null {
    if (!names || names.length === 0) return null;
    let bits = 0;
    for (const n of names) {
      const trimmed = n.trim();
      if (!(trimmed in CONTENT_FEATURE_FLAG_VALUES)) {
        throw new Error(
          `Unknown contentFeatureFlag '${trimmed}'. Allowed: ${Object.keys(CONTENT_FEATURE_FLAG_VALUES).join(', ')}`
        );
      }
      bits |= CONTENT_FEATURE_FLAG_VALUES[trimmed];
    }
    return bits;
  }

  const SYMCONF_HELPERS = ['ensure_project_open', 'select_application', 'select_application', 'find_symbol_config_object'];

  s.tool(
    'find_symbol_config',
    "Locate the Symbol Configuration object(s) in a CODESYS project. Walks the project tree and reports every node where is_symbol_config==True (one per Application typically). Returns object name, slash-separated path, and id. If no Symbol Configuration exists, the tool returns count=0 and hints at create_symbol_config. Read-only.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
    },
    async (args: { applicationPath?: string; projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'find_symbol_config',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath) },
        SYMCONF_HELPERS
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, result.output);
    }
  );

  s.tool(
    'list_all_signatures',
    "List every signature (POU / FunctionBlock / Method / Function) the Symbol Configuration could potentially export. Wraps ScriptSymbolConfigObject.get_all_signatures(compile=bool). Default compile=false returns the cached list (may be empty if the application has not been built since opening). Pass compile=true to force application.build() first -- authoritative but slow on large projects.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      compile: z.boolean().optional().describe("If true, build the application before generating the list (slow but authoritative). Default false uses the cached list."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; compile?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'list_all_signatures',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          COMPILE_FLAG: args.compile ? '1' : '0',
        },
        SYMCONF_HELPERS
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, result.output);
    }
  );

  s.tool(
    'list_all_datatypes',
    "List every data type (struct / enum / alias / union) the Symbol Configuration could potentially export. Wraps ScriptSymbolConfigObject.get_all_datatypes(compile=bool). Same compile=true semantics as list_all_signatures.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      compile: z.boolean().optional().describe("If true, build the application before generating the list. Default false uses the cached list."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; compile?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'list_all_datatypes',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          COMPILE_FLAG: args.compile ? '1' : '0',
        },
        SYMCONF_HELPERS
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, result.output);
    }
  );

  s.tool(
    'list_configured_symbols',
    "List the signatures + datatypes that are CURRENTLY configured for export by the Symbol Configuration (i.e. the user has ticked them in the IDE grid, or set_symbol_access has set their configured_access). For each variable: configured_access (what's set), maximal_access (the upper bound), effective_access (post-clamp), and exported_via_attribute (true if the export was driven by a {attribute 'symbol' := ...} pragma). Read-only.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
    },
    async (args: { applicationPath?: string; projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'list_configured_symbols',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath) },
        SYMCONF_HELPERS
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, result.output);
    }
  );

  s.tool(
    'get_symbol_config_settings',
    "Read every knob on the Symbol Configuration object: content_feature_flags (OPC UA / IncludeComments / IncludeAttributes / IncludeExecutables / etc.), symbol_attribute_filter_type and _data, symbol_comment_filter_type, enable_direct_io_access (plus any obstacles that would block enabling it), and the client-side layout calculator. Both 'configured' and 'effective' values are reported where the API distinguishes them. Read-only.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
    },
    async (args: { applicationPath?: string; projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'get_symbol_config_settings',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath) },
        SYMCONF_HELPERS
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, result.output);
    }
  );

  s.tool(
    'create_symbol_config',
    "Add a Symbol Configuration object under an Application. Wraps ScriptApplicationSymbolConfigExtension.create_symbol_config(export_comments_to_xml, support_opc_ua, layout_guid). IDEMPOTENT: if a Symbol Configuration already exists anywhere in the project tree, the tool no-ops with success and returns the existing object's path -- it does NOT add a duplicate. Saves the project on actual creation. AUTO-COMPILE: on success the tool runs compile_project automatically (symbol artifacts only land in the .app/.crc after a build), and appends the build outcome to the response.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe("Slash-separated path to the Application (e.g. 'CodesysRpi/Plc Logic/Application'), or just 'Application'. Empty/omitted = use the project's active application."),
      exportCommentsToXml: z.boolean().optional().describe("Pass to the API's export_comments_to_xml flag. Default true."),
      supportOpcUa: z.boolean().optional().describe("Pass to the API's support_opc_ua flag. Default true."),
      layoutCalculator: z.enum(['compatibility', 'optimized']).optional().describe("Which client-side layout calculator to register. 'compatibility' (default) uses Guid.Empty (always available). 'optimized' uses {0141eb75-141b-4ea1-9a8c-75f952b22a6c} (V3.5.7.0+, requires compiler version 3.5.7.0+)."),
    },
    async (args: {
      projectFilePath: string;
      applicationPath?: string;
      exportCommentsToXml?: boolean;
      supportOpcUa?: boolean;
      layoutCalculator?: 'compatibility' | 'optimized';
    }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'create_symbol_config',
        {
          PROJECT_FILE_PATH: escaped,
          APPLICATION_PATH: (args.applicationPath ?? '').trim(),
          EXPORT_COMMENTS_TO_XML: args.exportCommentsToXml === false ? '0' : '1',
          SUPPORT_OPC_UA: args.supportOpcUa === false ? '0' : '1',
          LAYOUT_CALCULATOR: args.layoutCalculator ?? 'compatibility',
        },
        [...SYMCONF_HELPERS, 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      const initial = await formatModifyingResponse(
        result,
        `Symbol Configuration ensured under '${args.applicationPath ?? '<active application>'}' in ${args.projectFilePath}.`,
        escaped,
        mirrorCtx
      );
      return await withAutoCompile(initial, escaped, args.projectFilePath);
    }
  );

  s.tool(
    'set_symbol_config_settings',
    "Partial-update of any subset of Symbol Configuration knobs. Only fields you supply are written; others are left alone. Saves the project after applying changes. Refuses to enable direct I/O access if check_effective_direct_io_access reports obstacles. AUTO-COMPILE: on success the tool runs compile_project automatically so the new settings land in the symbol artifacts.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      contentFeatureFlags: z.array(z.string()).optional().describe("Bitmask members to combine into content_feature_flags. Allowed members: SupportOPCUA, IncludeComments, IncludeAttributes, IncludeTypeNodeAttributes, IncludeExecutables, UseEmptyNamespaceByDefault, XmlIncludeNodeFlags, XmlIncludeComments, XmlIncludeAttributes, XmlIncludeTypeNodeAttributes, XmlIncludeExecutables. Pass [] or omit to leave unchanged. Pass ['None'] to clear all flags."),
      attributeFilterType: z.enum(['None', 'All', 'SimpleIdentifiers', 'Prefix', 'Regex']).optional().describe("symbol_attribute_filter_type. None disables, All matches every attribute, SimpleIdentifiers matches single IEC identifiers, Prefix/Regex use attributeFilterData."),
      attributeFilterData: z.string().optional().describe("Filter pattern for attributeFilterType=Prefix or Regex. Ignored for None/All/SimpleIdentifiers."),
      commentFilterType: z.enum(['None', 'NormalComments', 'DocuComments', 'Both', 'PreferNormalComments', 'PreferDocuComments']).optional().describe("symbol_comment_filter_type. NormalComments = // and (* *) only. DocuComments = /// only. Both = combine. Prefer* picks one with the other as fallback."),
      enableDirectIoAccess: z.boolean().optional().describe("enable_direct_io_access. Refused if obstacles exist (compiler version too old, or symbol config is configured as a child object)."),
      layoutCalculator: z.enum(['compatibility', 'optimized']).optional().describe("Which client-side layout calculator GUID to set."),
    },
    async (args: { applicationPath?: string;
      projectFilePath: string;
      contentFeatureFlags?: string[];
      attributeFilterType?: 'None' | 'All' | 'SimpleIdentifiers' | 'Prefix' | 'Regex';
      attributeFilterData?: string;
      commentFilterType?: 'None' | 'NormalComments' | 'DocuComments' | 'Both' | 'PreferNormalComments' | 'PreferDocuComments';
      enableDirectIoAccess?: boolean;
      layoutCalculator?: 'compatibility' | 'optimized';
    }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);

      const cffInt = combineContentFeatureFlags(args.contentFeatureFlags);
      const applyContentFlags = cffInt !== null;

      const script = scriptManager.prepareScriptWithHelpers(
        'set_symbol_config_settings',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          APPLY_CONTENT_FLAGS: applyContentFlags ? '1' : '0',
          CONTENT_FLAGS_INT: applyContentFlags ? String(cffInt) : '0',
          APPLY_ATTR_FILTER_TYPE: args.attributeFilterType !== undefined ? '1' : '0',
          ATTR_FILTER_TYPE: args.attributeFilterType ?? 'None',
          APPLY_ATTR_FILTER_DATA: args.attributeFilterData !== undefined ? '1' : '0',
          ATTR_FILTER_DATA: args.attributeFilterData ?? '',
          APPLY_COMMENT_FILTER_TYPE: args.commentFilterType !== undefined ? '1' : '0',
          COMMENT_FILTER_TYPE: args.commentFilterType ?? 'None',
          APPLY_DIRECT_IO: args.enableDirectIoAccess !== undefined ? '1' : '0',
          DIRECT_IO: args.enableDirectIoAccess ? '1' : '0',
          APPLY_LAYOUT: args.layoutCalculator !== undefined ? '1' : '0',
          LAYOUT_CALCULATOR: args.layoutCalculator ?? 'compatibility',
        },
        SYMCONF_HELPERS
      );
      const result = await executor.executeScript(script);
      const initial = await formatModifyingResponse(
        result,
        `Symbol Configuration settings updated for ${args.projectFilePath}.`,
        escaped,
        mirrorCtx
      );
      return await withAutoCompile(initial, escaped, args.projectFilePath);
    }
  );

  s.tool(
    'set_symbol_access',
    "Set the configured_access for a single variable inside one signature. Locates the signature by full-qualified name (FQN), e.g. 'Application.PLC_PRG'. If the signature isn't yet in the configured set the tool tries the all-signatures view too -- so you can use this to TICK a not-yet-exported variable. Saves the project. AUTO-COMPILE: on success the tool runs compile_project automatically so the new access lands in the symbol artifacts.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      signatureFqn: z.string().describe("Full-qualified name of the signature, e.g. 'Application.PLC_PRG' or 'Standard.TON'."),
      variableName: z.string().describe("The variable's name as it appears in sig.variables, e.g. 'nCounter'."),
      access: z.enum(['None', 'ReadOnly', 'WriteOnly', 'ReadWrite']).describe("Desired access. None=hide. ReadOnly=expose for read. WriteOnly=expose for write. ReadWrite=both."),
      libraryId: z.string().optional().describe("Optional library_id to disambiguate when the FQN exists in multiple namespaces."),
    },
    async (args: { applicationPath?: string;
      projectFilePath: string;
      signatureFqn: string;
      variableName: string;
      access: 'None' | 'ReadOnly' | 'WriteOnly' | 'ReadWrite';
      libraryId?: string;
    }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'set_symbol_access',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          SIGNATURE_FQN: args.signatureFqn,
          VARIABLE_NAME: args.variableName,
          ACCESS: args.access,
          LIBRARY_ID: args.libraryId ?? '',
          ENSURE_CONFIGURED: '1',
        },
        SYMCONF_HELPERS
      );
      const result = await executor.executeScript(script);
      const initial = await formatModifyingResponse(
        result,
        `Symbol access set: ${args.signatureFqn}.${args.variableName} = ${args.access}.`,
        escaped,
        mirrorCtx
      );
      return await withAutoCompile(initial, escaped, args.projectFilePath);
    }
  );

  s.tool(
    'set_signature_access_bulk',
    "Set configured_access for EVERY variable inside a signature to the same value. Variables whose maximal_access doesn't permit the requested level are skipped (reported in the response). Useful for 'expose all of PLC_PRG as ReadWrite' in one shot. AUTO-COMPILE: on success the tool runs compile_project automatically so the new access lands in the symbol artifacts.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      signatureFqn: z.string().describe("Full-qualified name of the signature, e.g. 'Application.PLC_PRG'."),
      access: z.enum(['None', 'ReadOnly', 'WriteOnly', 'ReadWrite']).describe("Access level to apply to every variable."),
      libraryId: z.string().optional().describe("Optional library_id to disambiguate."),
    },
    async (args: { applicationPath?: string;
      projectFilePath: string;
      signatureFqn: string;
      access: 'None' | 'ReadOnly' | 'WriteOnly' | 'ReadWrite';
      libraryId?: string;
    }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'set_signature_access_bulk',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          SIGNATURE_FQN: args.signatureFqn,
          ACCESS: args.access,
          LIBRARY_ID: args.libraryId ?? '',
        },
        SYMCONF_HELPERS
      );
      const result = await executor.executeScript(script);
      const initial = await formatModifyingResponse(
        result,
        `Signature ${args.signatureFqn} bulk access set to ${args.access}.`,
        escaped,
        mirrorCtx
      );
      return await withAutoCompile(initial, escaped, args.projectFilePath);
    }
  );

  s.tool(
    'export_symbol_xsd',
    "Write the Symbol Configuration XSD schema (the bytes returned by get_symbol_configuration_xsd()) to a file. The schema describes the XML the runtime emits at download. Use it to validate downstream symbol XML in CI. Refuses if the parent directory of outputFilePath doesn't exist.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      outputFilePath: z.string().describe("Where to write the XSD bytes (UTF-8). Parent directory must exist."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; outputFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const outEscaped = resolvePath(args.outputFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'export_symbol_xsd',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          OUTPUT_FILE_PATH: outEscaped,
        },
        SYMCONF_HELPERS
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `Symbol Configuration XSD written to ${args.outputFilePath}.`
      );
    }
  );

  // ─── Project metadata ────────────────────────────────────────────────

  s.tool(
    'bump_project_version',
    "Bumps one part of the 4-part Project Information.Version field of the primary project (Major.Minor.Revision.Build) and saves the project. Also maintains a `_MCP_PROJECT_VERSION` GVL under Application with the new version as `sVersion : STRING := '<X.Y.Z.W>'` so the running PLC carries the version at a known address (read it via the read_running_version_online tool). The GVL is created on first bump and updated in place thereafter. Convention: major = incompatible API break (rename FB / change public signature / remove method); minor = backward-compatible feature add (new FB / GVL / method); revision = bug fix only; build = internal counter, often 0 for hand-released versions. Bumping a higher part resets all lower parts to 0. FIRST-RUN: if no version is set yet (None/empty/0.0.0.0), seeds at 1.0.0.0 regardless of level so a first-time bump gives a canonical starting point instead of 0.0.0.1. AUTO MODE: if level='auto', the tool diffs the project's mcp-mirror/ folder against the latest v* git tag and classifies the change (deletion/rename -> major; addition -> minor; modification -> revision; no changes -> short-circuits with no bump; first-run -> seed at 1.0.0.0).",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
      level: z.enum(['major', 'minor', 'revision', 'build', 'auto']).describe("Which part of the 4-part version to bump. Major = incompatible API break. Minor = backward-compatible feature add. Revision = bug fix only. Build = internal / CI counter. AUTO classifies via git diff of mcp-mirror/ against the latest v* tag."),
      allowVersionUpgrade: z.boolean().optional().describe("Override the CODESYS version-pin guard. The guard refuses to save when this server's install differs from the project's pinned version (.codesys-version, else library.md's 'CODESYS Development System' row), because saving converts the project. Only set true when the conversion is deliberate."),
    },
    async (args: { applicationPath?: string; projectFilePath: string; level: 'major' | 'minor' | 'revision' | 'build' | 'auto'; allowVersionUpgrade?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      // This tool saves the .project -- guard before anything else.
      const pinCheck = enforceVersionPin(escaped, {
        saves: true,
        allowUpgrade: args.allowVersionUpgrade === true,
        profileName: config.profileName,
      });
      if (pinCheck.error) return pinCheck.error;

      if (args.level === 'auto') {
        const projectDir = path.dirname(escaped);
        const r = classifyMcpMirrorChanges(projectDir);

        // Short-circuit: nothing to bump.
        if (r.kind === 'no-changes') {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `bump_project_version (auto): no version change.\n\n` +
                  r.evidence.map((e) => `  - ${e}`).join('\n'),
              },
            ],
            isError: false,
          };
        }

        // First-run resolves to 'build' on the Python side, where seed-at-1.0.0.0
        // kicks in if Project Information.Version is None / empty / 0.0.0.0.
        const resolvedLevel: 'major' | 'minor' | 'revision' | 'build' =
          r.kind === 'first-run' ? 'build' : r.level;

        const script = scriptManager.prepareScriptWithHelpers(
          'bump_project_version',
          {
            PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
            LEVEL: resolvedLevel,
            SEED_VERSION: seedVersionFromLatestTag(projectDir, resolvedLevel),
          },
          ['ensure_project_open', 'select_application']
        );
        const result = await executor.executeScript(script);

        // Append Changelog entry (soft-fails internally).
        if (result.success && result.output.includes('SCRIPT_SUCCESS')) {
          const { from, to } = parseBumpedVersion(result.output);
          if (to) {
            const levelLabel = r.kind === 'first-run' ? 'seed' : `auto: ${resolvedLevel}`;
            appendChangelogEntry(projectDir, from, to, levelLabel, r.evidence);
          }
        }

        const tag = r.kind === 'first-run' ? 'first-run -> seed' : `auto -> ${resolvedLevel}`;
        return formatToolResponse(
          result,
          `bump_project_version (${tag}) complete for ${args.projectFilePath}.\n\nClassification:\n${r.evidence
            .map((e) => `  - ${e}`)
            .join('\n')}`
        );
      }

      const script = scriptManager.prepareScriptWithHelpers(
        'bump_project_version',
        {
          PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath),
          LEVEL: args.level,
          SEED_VERSION: seedVersionFromLatestTag(path.dirname(escaped), args.level),
        },
        ['ensure_project_open', 'select_application']
      );
      const result = await executor.executeScript(script);

      // Append Changelog entry for manual bumps too.
      if (result.success && result.output.includes('SCRIPT_SUCCESS')) {
        const { from, to } = parseBumpedVersion(result.output);
        if (to) {
          const projectDir = path.dirname(escaped);
          appendChangelogEntry(projectDir, from, to, `manual: ${args.level}`, []);
        }
      }

      return formatToolResponse(
        result,
        `bump_project_version (${args.level}) complete for ${args.projectFilePath}.`
      );
    }
  );

  s.tool(
    'release_project_version',
    "ONE-SHOT release pipeline. Runs the full sync from a CODESYS code change all the way to a tagged + pushed git commit, with no manual orchestration in between. Sequence: (1) mirror_export refreshes mcp-mirror/; (2) classifier diffs the new mirror against the latest v* tag; (3) if no changes, short-circuits with 'no version change'; (4) otherwise bump_project_version with the resolved level; (5) regenerate library.md as markdown; (6) regenerate pou-dump.md as markdown; (7) regex-replace the version reference in README.md; (8) Changelog.md auto-appended with the new entry (timestamp + classification evidence); (9) git add the controlled paths only (mcp-mirror, the four .md files, .gitignore, the .project binary); (10) git commit; (11) git tag v<new>; (12) git push --follow-tags. Standard workflow: ask Claude to run release_project_version after every confirmed change in CODESYS. Requires the project's parent dir to be a git repo with a configured remote.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      push: z.boolean().optional().describe("Push to origin after commit/tag. Default true."),
      allowVersionUpgrade: z.boolean().optional().describe("Override the CODESYS version-pin guard. The guard refuses to save when this server's install differs from the project's pinned version (.codesys-version, else library.md's 'CODESYS Development System' row), because saving converts the project and the committed binary stops matching what runs on the device. Only set true when the conversion is deliberate."),
    },
    async (args: { projectFilePath: string; push?: boolean; allowVersionUpgrade?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      // Guard FIRST: this pipeline saves the .project, and a save on a
      // mismatched install converts it. A converted binary that has already
      // been committed and tagged is expensive to unwind.
      const pinCheck = enforceVersionPin(escaped, {
        saves: true,
        allowUpgrade: args.allowVersionUpgrade === true,
        profileName: config.profileName,
      });
      if (pinCheck.error) return pinCheck.error;
      const projectDir = path.dirname(escaped);
      const doPush = args.push !== false;
      const log: string[] = [];

      // 0. SHA fingerprints (BEFORE mirror_export overwrites the mirror).
      // Two SHAs tracked per release in the v* tag's annotated body:
      //   - project-sha256 = sha of the .project binary
      //   - mirror-sha256  = sha of the mcp-mirror/ tree (sorted file walk)
      // Comparing the current SHAs against the latest tag's stored SHAs lets
      // us detect three classes of change:
      //   (a) binary changed AND mirror unchanged (working tree, before re-export)
      //       -> normal "user edited via IDE" path; classifier handles it.
      //   (b) binary unchanged AND mirror changed (working tree, before re-export)
      //       -> user edited mirror files DIRECTLY (text editor on .st files).
      //          The mirror_export below is about to overwrite those edits.
      //          Surface a WARNING so it's at least visible in the log.
      //          (Future: a mirror_import tool could push these back into the
      //          binary; until then, mirror is one-way.)
      //   (c) binary changed AND mirror UNCHANGED *after* re-export
      //       -> non-textual binary change (device tree / library refs / task
      //          config / visu / Save() touch). Classifier sees no diff but
      //          binary SHA flipped. Classify as build-level bump so the
      //          version still ticks and the change isn't silently dropped.
      // Resolve the mirror dir via the same rule mirror_export.py uses, so
      // multi-project parent dirs land in <basename>_mcp_mirror/ and we
      // SHA-fingerprint / classify / git-add the right tree (legacy single-
      // project layouts continue to use mcp-mirror/, preserving v* tag
      // history).
      const mirrorDir = resolveMirrorRoot(escaped);
      const mirrorDirName = path.basename(mirrorDir);
      const projectShaNow = (() => {
        try { return sha256OfFile(escaped); } catch { return ''; }
      })();
      const mirrorShaBeforeExport = sha256OfDirectory(mirrorDir);
      let priorTag = '';
      try {
        priorTag = execSync(
          `git -C "${projectDir}" describe --tags --abbrev=0 --match "v*"`,
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim();
      } catch { /* first-run; no prior tag */ }
      const priorShas = readTagShas(projectDir, priorTag);
      if (priorTag) {
        log.push(`prior tag: ${priorTag} (project-sha256: ${priorShas.project ? priorShas.project.slice(0, 12) + '...' : '(none)'}, mirror-sha256: ${priorShas.mirror ? priorShas.mirror.slice(0, 12) + '...' : '(none)'})`);
      }
      // (b) detection: mirror was edited directly while binary stood still.
      const mirrorEditedDirectly =
        priorShas.mirror !== undefined &&
        mirrorShaBeforeExport !== '' &&
        mirrorShaBeforeExport !== priorShas.mirror &&
        priorShas.project !== undefined &&
        projectShaNow === priorShas.project;

      // 1. Mirror export
      const mirrorScript = scriptManager.prepareScriptWithHelpers(
        'mirror_export',
        { PROJECT_FILE_PATH: escaped, MIRROR_ROOT: mirrorDir },
        ['ensure_project_open']
      );
      const mirrorRes = await executor.executeScript(mirrorScript);
      if (!mirrorRes.success || !mirrorRes.output.includes('SCRIPT_SUCCESS')) {
        return formatToolResponse(mirrorRes, 'release_project_version: mirror_export failed');
      }
      log.push('mirror_export: OK');
      if (mirrorEditedDirectly) {
        log.push(`WARNING: ${mirrorDirName}/ tree differed from the last tag's mirror-sha256 BEFORE mirror_export ran, while the .project binary did not change. This usually means you edited .st files in the mirror directly. mirror_export has now overwritten those edits with the current binary state. (mirror_import is not yet implemented; for now, make code changes via the IDE or set_pou_code so they reach the binary first.)`);
      }

      // 2. Classify mirror diff vs latest v* tag
      let classification = classifyMcpMirrorChanges(projectDir, mirrorDirName);
      // SHA fallback (case c): mirror diff is empty but the project binary
      // SHA changed. Promote a 'no-changes' classification to a build-level
      // bump so non-textual changes still tick the version.
      let shaPromotedToBuild = false;
      if (classification.kind === 'no-changes' && priorShas.project !== undefined && projectShaNow !== priorShas.project) {
        shaPromotedToBuild = true;
        const evidence = [
          ...classification.evidence,
          `binary .project SHA changed (${priorShas.project.slice(0, 12)}... -> ${projectShaNow.slice(0, 12)}...) but no mirror diff: likely device-tree / library refs / task config / visu / Save() touch -- classifying as build bump`,
        ];
        classification = { kind: 'bump', level: 'build', evidence };
      }
      if (classification.kind === 'no-changes') {
        // Nothing to bump -- but an earlier release may have logged
        // "library.md/pou-dump.md: skipped" and still committed+tagged. That
        // leaves the repo permanently short an artefact: the next release
        // short-circuits here too, so the gap can never close on its own.
        // Regenerate whatever is missing (at the CURRENT version, since the
        // version isn't moving) and commit it as a repair.
        const repairLog: string[] = [];
        const currentVersion = readProjectVersionFromLibraryMd(projectDir) ?? undefined;
        for (const artifact of ['library.md', 'pou-dump.md'] as const) {
          if (fs.existsSync(path.join(projectDir, artifact))) continue;
          try {
            await regenerateArtifact(artifact, {
              projectDir,
              escaped,
              version: currentVersion,
              scriptManager,
              executor,
              log: repairLog,
            });
          } catch (e) {
            repairLog.push(`${artifact}: repair failed (${e instanceof Error ? e.message : String(e)})`);
          }
        }

        if (repairLog.length > 0) {
          try {
            gitCommitArtifactRepair(projectDir, repairLog);
            repairLog.push('git: committed the regenerated artefact(s) (no new tag -- the version did not move)');
            if (args.push !== false) {
              execSync(`git -C "${projectDir}" push`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
              repairLog.push('git: pushed');
            }
          } catch (e) {
            repairLog.push(`git: repair commit failed (${e instanceof Error ? e.message : String(e)})`);
          }
        }

        return {
          content: [{ type: 'text' as const, text:
            `release_project_version: no version change -- ${mirrorDirName}/ matches latest v* tag and project-sha256 is unchanged.\n\n` +
            classification.evidence.map((e) => `  - ${e}`).join('\n') +
            (repairLog.length > 0
              ? `\n\nRepaired missing text artefact(s):\n` + repairLog.map((e) => `  - ${e}`).join('\n')
              : '')
          }],
          isError: false,
        };
      }
      const resolvedLevel = classification.kind === 'first-run' ? 'build' : classification.level;
      const levelLabel = classification.kind === 'first-run' ? 'seed' : `auto: ${resolvedLevel}${shaPromotedToBuild ? ' (sha-fallback)' : ''}`;
      log.push(`classifier: ${levelLabel} (${classification.evidence.length} evidence item(s))`);

      // 3. Bump
      const bumpScript = scriptManager.prepareScriptWithHelpers(
        'bump_project_version',
        { PROJECT_FILE_PATH: escaped, LEVEL: resolvedLevel },
        ['ensure_project_open']
      );
      const bumpRes = await executor.executeScript(bumpScript);
      if (!bumpRes.success || !bumpRes.output.includes('SCRIPT_SUCCESS')) {
        return formatToolResponse(bumpRes, 'release_project_version: bump_project_version failed');
      }
      const { from, to: newVersion } = parseBumpedVersion(bumpRes.output);
      if (!newVersion) {
        return { content: [{ type: 'text' as const, text: 'release_project_version: bump succeeded but new version could not be parsed' }], isError: true };
      }
      log.push(`bump: ${from ?? '(none)'} -> ${newVersion}`);

      // 3a. SANITY CHECK: the new version MUST be strictly greater than the
      // latest v* tag. Defensive guard against silent version regressions
      // caused by stale in-memory CODESYS state.
      //
      // The version values consumed by bump_project_version (Project
      // Information.Version and _MCP_PROJECT_VERSION.sVersion) are read from
      // CODESYS's in-memory project tree, NOT directly from the .project
      // binary on disk. If the IDE has a stale tree from a prior session, the
      // script's pi-vs-GVL cross-check fix can be defeated -- both sides come
      // from the same stale source. Two observed regressions on the MCPTest2
      // sandbox were undetected by the in-script check:
      //   - 2026-04-26 v1.0.4.0 (script saw 1.0.3.0, on-disk was 1.2.0.0)
      //   - 2026-04-26 v1.1.0.0 (script saw 1.0.0.0, on-disk was 1.2.1.0)
      // In both cases the orchestrator went on to call git tag, which
      // either failed (tag exists) or wrote a wrong-direction tag.
      //
      // This guard catches *any* cause of misread (in-memory drift, regex
      // edge case, future fork bug we haven't seen yet) at the orchestrator
      // boundary, before any git commit / tag / push lands. The .project
      // binary on disk has already been written with the bad value at this
      // point -- recovery is a manual step (shutdown + relaunch + retry, or
      // explicit bump_project_version calls until > tag), but no permanent
      // damage was published.
      let latestTag = '';
      try {
        latestTag = execSync(
          `git -C "${projectDir}" describe --tags --abbrev=0 --match "v*"`,
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim();
      } catch {
        // No prior v* tag -- true first-run; skip the check.
      }
      if (latestTag) {
        const tagV = latestTag.replace(/^v/, '');
        const cmpVersion = (a: string, b: string): number => {
          const A = a.split('.').map((n) => parseInt(n, 10) || 0);
          const B = b.split('.').map((n) => parseInt(n, 10) || 0);
          while (A.length < 4) A.push(0);
          while (B.length < 4) B.push(0);
          for (let i = 0; i < 4; i++) {
            if (A[i] !== B[i]) return A[i] - B[i];
          }
          return 0;
        };
        if (cmpVersion(newVersion, tagV) <= 0) {
          return {
            content: [{ type: 'text' as const, text:
              `release_project_version: SANITY CHECK FAILED -- new version ${newVersion} is not greater than the latest v* tag (${latestTag}).\n\n` +
              `This usually means CODESYS's in-memory project tree was stale when bump_project_version ran -- the version values read by the script (Project Information.Version and/or _MCP_PROJECT_VERSION.sVersion) reflect a prior session's state, not the on-disk binary. The bump computed a value that would silently regress the version sequence.\n\n` +
              `The .project binary on disk has been saved with the regressed value (${newVersion}) -- to recover:\n` +
              `  1. shutdown_codesys -- clears the stale in-memory tree.\n` +
              `  2. launch_codesys + open_project -- reload the binary fresh from disk.\n` +
              `  3. Re-run release_project_version -- bump_project_version will now see the correct on-disk values.\n` +
              `  4. If the issue persists after a fresh open, the binary itself has the wrong value (the recovery from a previous failed run wrote it). Run bump_project_version with explicit level=minor (or major/revision per your taste) repeatedly until the version exceeds ${tagV}, then re-run release_project_version.\n\n` +
              `Pipeline state at abort:\n` +
              log.map((l) => `  ${l}`).join('\n') + '\n' +
              `  bump (rejected): ${from ?? '(none)'} -> ${newVersion}  (must be > ${tagV})\n\n` +
              `No commit / no tag / no push made. Mirror, library.md, pou-dump.md, README.md, Changelog.md were NOT regenerated for the rejected version.`
            }],
            isError: true,
          };
        }
        log.push(`sanity check: ${newVersion} > ${tagV} (latest tag) -- OK`);
      } else {
        log.push('sanity check: skipped (no v* tag baseline)');
      }

      // 3b. Re-run mirror_export AFTER the bump. The pre-bump mirror
      // captured the old _MCP_PROJECT_VERSION.sVersion value and (when
      // applicable) the old Project Information.Version. After the bump,
      // those values changed in CODESYS in-memory and got saved to the
      // .project binary. The mirror needs to reflect the post-bump state
      // or the next 'release' call will see _MCP_PROJECT_VERSION.st as
      // a real diff vs the just-tagged release and bump again. Surfaced
      // on MCPTest2 v1.1.0.0 (commit 8d79193): the binary GVL was
      // 1.0.2.0 while the docs said 1.1.0.0 because mirror_export
      // didn't re-run after the bump.
      try {
        const mirrorScript2 = scriptManager.prepareScriptWithHelpers(
          'mirror_export',
          { PROJECT_FILE_PATH: escaped, MIRROR_ROOT: mirrorDir },
          ['ensure_project_open']
        );
        const mirror2 = await executor.executeScript(mirrorScript2);
        if (mirror2.success && mirror2.output.includes('SCRIPT_SUCCESS')) {
          log.push('mirror_export (post-bump): OK');
        } else {
          log.push('mirror_export (post-bump): WARNING -- post-bump mirror may be stale');
        }
      } catch (e) {
        log.push(`mirror_export (post-bump): WARNING -- ${e instanceof Error ? e.message : String(e)}`);
      }

      // 4. Append Changelog (the manual-bump path doesn't auto-append; do it here)
      // The success message is only printed once the write is verified by
      // re-reading the file (see appendChangelogEntry) -- a silent no-op
      // must never be reported as a success.
      const changelogUpdate = appendChangelogEntry(projectDir, from, newVersion, levelLabel, classification.evidence);
      if (changelogUpdate.status === 'written') {
        log.push(`Changelog.md: appended v${newVersion} (${changelogUpdate.style} style, verified on disk)`);
      } else {
        log.push(`Changelog.md: NOT appended -- ${changelogUpdate.reason}`);
      }

      // 5-6. Refresh library.md + pou-dump.md
      const artifactCtx = { projectDir, escaped, version: newVersion, scriptManager, executor, log };
      await regenerateArtifact('library.md', artifactCtx);
      await regenerateArtifact('pou-dump.md', artifactCtx);

      // 7. Update README.md version header (anchored -- see updateReadmeVersion
      // for why this is no longer a blanket vX.Y.Z.W sweep over the whole file)
      const readmePath = path.join(projectDir, 'README.md');
      if (fs.existsSync(readmePath)) {
        try {
          const before = fs.readFileSync(readmePath, 'utf-8');
          const readmeResult = updateReadmeVersion(before, newVersion);
          if (readmeResult.changed) {
            fs.writeFileSync(readmePath, readmeResult.content, 'utf-8');
            log.push(`README.md: bumped to v${newVersion} (${readmeResult.detail})`);
          } else {
            log.push(`README.md: unchanged -- ${readmeResult.detail}`);
          }
        } catch (e) {
          log.push(`README.md: skipped (${e instanceof Error ? e.message : String(e)})`);
        }
      }

      // 8. Git add / commit / tag / push
      try {
        const projName = path.basename(escaped);
        const candidatePaths = [mirrorDirName, 'library.md', 'pou-dump.md', 'README.md', resolveChangelogName(projectDir), '.gitignore', projName];
        const addPaths = candidatePaths.filter((p) => fs.existsSync(path.join(projectDir, p)));
        const addArgs = addPaths.map((p) => `"${p}"`).join(' ');
        execSync(`git -C "${projectDir}" add ${addArgs}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

        const summary = classification.evidence.slice(0, 5).join('; ').slice(0, 200);
        const commitMsg = `release v${newVersion} (${levelLabel})\n\n${summary}\n`;
        execSync(`git -C "${projectDir}" commit -m ${JSON.stringify(commitMsg)}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

        // Compute the post-commit SHAs and embed them in the annotated tag.
        // These represent the state at this released version: any future
        // release_project_version call reads them via readTagShas() to
        // detect whether the .project binary or the mirror tree has changed
        // since this release. The post-bump mirror_export at step 3b
        // refreshed the mirror to match the new GVL value, and the bump
        // saved the binary; both reads here should reflect the v<new>
        // post-bump state.
        const newProjectSha = (() => {
          try { return sha256OfFile(escaped); } catch { return ''; }
        })();
        const newMirrorSha = sha256OfDirectory(mirrorDir);
        const tagBody =
          `v${newVersion} (${levelLabel})\n\n` +
          `project-sha256: ${newProjectSha}\n` +
          `mirror-sha256: ${newMirrorSha}\n`;
        // Write the tag body via -F <tempfile> so real LF newlines are
        // preserved verbatim. Earlier versions used `-m JSON.stringify(body)`
        // which the shell passed through with literal "\n" sequences,
        // breaking the multiline regex in readTagShas() on the read side.
        const tagBodyFile = path.join(os.tmpdir(), `codesys-mcp-tagbody-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.txt`);
        fs.writeFileSync(tagBodyFile, tagBody, 'utf-8');
        try {
          execSync(`git -C "${projectDir}" tag -a v${newVersion} -F "${tagBodyFile}" --cleanup=verbatim`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        } finally {
          try { fs.unlinkSync(tagBodyFile); } catch { /* best-effort cleanup */ }
        }
        log.push(`git: committed + tagged v${newVersion} (project-sha256: ${newProjectSha.slice(0, 12)}..., mirror-sha256: ${newMirrorSha.slice(0, 12)}...)`);

        if (doPush) {
          execSync(`git -C "${projectDir}" push --follow-tags`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
          log.push('git: pushed --follow-tags');
        }
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text:
            `release_project_version: bumped to v${newVersion} but git ops failed.\n\n` +
            log.map((l) => `  ${l}`).join('\n') +
            `\n\ngit error: ${e instanceof Error ? e.message : String(e)}`
          }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text:
          `release_project_version: v${from ?? '(none)'} -> v${newVersion} (${levelLabel})\n\n` +
          log.map((l) => `  ${l}`).join('\n')
        }],
        isError: false,
      };
    }
  );

  s.tool(
    'read_running_version_online',
    "Reads the running project's version from a connected PLC over the CODESYS online protocol (port 11740 / gateway). Returns the value of `_MCP_PROJECT_VERSION.sVersion` -- the runtime anchor that bump_project_version maintains automatically. Use this to confirm what version the live PLC is actually running, independently of whatever's in the .project file or the mcp-mirror/. Provides actionable error messages when the GVL is missing (project never bumped) or the boot application is stale (downloaded before the last bump). Implementation: ensure_project_open + ensure_online_connection + read_value('_MCP_PROJECT_VERSION.sVersion').",
    {
      projectFilePath: z.string().describe("Path to the project file. The tool opens it if not already primary, connects to its configured device, and reads the version anchor."),
      applicationPath: z.string().optional().describe(APP_PATH_DESC),
    },
    async (args: { applicationPath?: string; projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'read_running_version_online',
        { PROJECT_FILE_PATH: escaped, APPLICATION_PATH: appPathLiteral(args.applicationPath) },
        ['ensure_project_open', 'select_application', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script);
      // Pull the version out of the script's RUNNING_VERSION line
      const match = /RUNNING_VERSION: (\S+)/.exec(result.output || '');
      const version = match ? match[1] : '?';
      return formatToolResponse(
        result,
        `Running version on PLC: ${version}\n(read from _MCP_PROJECT_VERSION.sVersion via CODESYS online protocol)`
      );
    }
  );

  s.tool(
    'read_running_version_ssh',
    "Reads the running project version from a CODESYS Control Linux PLC via SSH, by extracting the X.Y.Z.W literal of `_MCP_PROJECT_VERSION.sVersion` from the boot application binary. Bypasses CODESYS entirely -- no IDE running, no project lock, no online protocol. Requires SSH key auth (one-time setup, see error message if you don't have it) and passwordless sudo on the PLC for `strings`. Linux PLCs only (CODESYS Control on Raspberry Pi, IPC, etc.).",
    {
      host: z.string().describe('Hostname or IP of the CODESYS Control Linux PLC.'),
      user: z.string().optional().describe('SSH user. Defaults to "karstein".'),
      bootAppPath: z.string().optional().describe('Path to the boot application binary on the PLC. Defaults to "/var/opt/codesys/PlcLogic/Application/Application.app".'),
    },
    async (args: { host: string; user?: string; bootAppPath?: string }) => {
      try {
        const res = await readRunningVersionSsh({
          host: args.host,
          user: args.user,
          bootAppPath: args.bootAppPath,
        });
        return {
          content: [{ type: 'text' as const, text: formatSshVersionResult(res) }],
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: msg }],
          isError: true,
        };
      }
    }
  );

  s.tool(
    'restart_runtime_ssh',
    "Restart the CODESYS Control runtime on a Linux PLC (default: codesys-pi.local) via SSH. Uses password auth and feeds the sudo password to `sudo -S`, so it works in environments where pubkey auth is broken (e.g. Pi sshd 10.x signature-rejection bug) or sudoers NOPASSWD isn't configured. After issuing `systemctl restart`, polls `ss -tln` for the runtime's listen port (default 11740) until it comes up or the liveness window expires -- this is the real liveness signal, since `systemctl is-active` reports 'active' even after the runtime binary has died from license-demo expiry. Defaults match the only Pi we currently target (codesys-pi.local / karstein / codesys123 / service codesyscontrol); every field is overridable for other deployments.",
    {
      host: z.string().optional().describe('Hostname or IP of the PLC. Default: codesys-pi.local.'),
      port: z.number().optional().describe('SSH port. Default: 22.'),
      user: z.string().optional().describe('SSH user. Default: karstein.'),
      password: z.string().optional().describe('SSH password. Default: codesys123. Also used as the sudo password if sudoPassword is omitted.'),
      sudoPassword: z.string().optional().describe('Override the sudo password if it differs from the SSH password.'),
      service: z.string().optional().describe('systemd unit to restart. Default: codesyscontrol.'),
      livenessWaitSeconds: z.number().optional().describe('How long to poll for the runtime listen port to come up after restart. 0 disables the check. Default: 30.'),
      livenessPort: z.number().optional().describe('TCP port to probe after restart. Default: 11740 (CODESYS gateway).'),
      connectTimeoutMs: z.number().optional().describe('SSH connect/exec timeout per attempt. Default: 15000.'),
    },
    async (args: {
      host?: string;
      port?: number;
      user?: string;
      password?: string;
      sudoPassword?: string;
      service?: string;
      livenessWaitSeconds?: number;
      livenessPort?: number;
      connectTimeoutMs?: number;
    }) => {
      const host = args.host ?? 'codesys-pi.local';
      const service = args.service ?? 'codesyscontrol';
      try {
        const res = await restartCodesysRuntime(args);
        const ok = res.restartExitCode === 0 && (res.listening === true || res.listening === null);
        return {
          content: [{ type: 'text' as const, text: formatRestartRuntimeResult(res) }],
          isError: !ok,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: msg }],
          isError: true,
        };
      }
    }
  );

  // ─── Filesystem mirror (Phase 1: read-only export) ────────────────────

  s.tool(
    'mirror_export',
    "Walks the CODESYS project tree and writes one .st file per code-bearing object into a filesystem mirror, preserving the project tree as nested directories. Programs / Function Blocks / Functions / Methods / Properties / DUTs / GVLs / Interfaces all become text files; structural nodes (Devices, Applications, Folders) become directories. Each file carries a header comment with its original CODESYS project path so a future write-back tool can map it back to set_pou_code's pouPath. Read-only -- does NOT modify the CODESYS project. UTF-8 output. If mirrorRoot is omitted, defaults to '<projectDir>/mcp-mirror' (or '<projectDir>/<projectname>_mcp_mirror' when several .project files share the parent dir).",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      mirrorRoot: z.string().optional().describe("Filesystem path where the mirror tree gets written. If omitted, defaults to '<projectDir>/mcp-mirror' (or '<projectDir>/<projectname>_mcp_mirror' when several .project files share the parent dir). Created automatically if missing; existing files at the same paths are overwritten."),
    },
    async (args: { projectFilePath: string; mirrorRoot?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const pinCheck = enforceVersionPin(escaped, {
        saves: false,
        profileName: config.profileName,
      });
      if (pinCheck.error) return pinCheck.error;
      const mirrorRoot = args.mirrorRoot
        ? resolvePath(args.mirrorRoot, workspaceDir)
        : resolveMirrorRoot(escaped);
      const script = scriptManager.prepareScriptWithHelpers(
        'mirror_export',
        {
          PROJECT_FILE_PATH: escaped,
          MIRROR_ROOT: mirrorRoot,
        },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `${pinCheck.warning}mirror_export complete for ${args.projectFilePath} -> ${mirrorRoot}.`
      );
    }
  );

  // ─── Resources ───────────────────────────────────────────────────────

  server.resource(
    'project-status',
    'codesys://project/status',
    async (uri) => {
      try {
        const script = scriptManager.loadTemplate('check_status');
        const result = await executor.executeScript(script);

        const outputLines = result.output.split(/[\r\n]+/).filter((l) => l.trim());
        const statusData: Record<string, string> = {};
        outputLines.forEach((line) => {
          const match = line.match(/^([^:]+):\s*(.*)$/);
          if (match) statusData[match[1].trim()] = match[2].trim();
        });

        const statusText = [
          'CODESYS Status:',
          ` - Scripting OK: ${statusData['Scripting OK'] ?? 'Unknown'}`,
          ` - Project Open: ${statusData['Project Open'] ?? 'Unknown'}`,
          ` - Project Name: ${statusData['Project Name'] ?? 'Unknown'}`,
          ` - Project Path: ${statusData['Project Path'] ?? 'N/A'}`,
        ].join('\n');

        const isError =
          !result.success ||
          statusData['Scripting OK']?.toLowerCase() !== 'true';

        return {
          contents: [{ uri: uri.href, text: statusText, contentType: 'text/plain' }],
          isError,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          contents: [{ uri: uri.href, text: `Failed status check: ${msg}`, contentType: 'text/plain' }],
          isError: true,
        };
      }
    }
  );

  const projectStructureTemplate = new ResourceTemplate(
    'codesys://project/{+project_path}/structure',
    { list: undefined }
  );

  server.resource(
    'project-structure',
    projectStructureTemplate,
    async (uri, params) => {
      const projectPath = params.project_path as string;
      if (!projectPath) {
        return {
          contents: [{ uri: uri.href, text: 'Error: Project path missing.', contentType: 'text/plain' }],
          isError: true,
        };
      }
      try {
        const escaped = resolvePath(projectPath, workspaceDir);
        const script = scriptManager.prepareScriptWithHelpers(
          'get_project_structure', { PROJECT_FILE_PATH: escaped }, ['ensure_project_open']
        );
        const result = await executor.executeScript(script);

        let structureText = `Error retrieving structure.\n\n${result.output}`;
        let isError = !result.success;

        if (result.success && result.output.includes('SCRIPT_SUCCESS')) {
          const startMarker = '--- PROJECT STRUCTURE START ---';
          const endMarker = '--- PROJECT STRUCTURE END ---';
          const startIdx = result.output.indexOf(startMarker);
          const endIdx = result.output.indexOf(endMarker);
          if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
            structureText = result.output
              .substring(startIdx + startMarker.length, endIdx)
              .replace(/\\n/g, '\n')
              .trim();
          } else {
            structureText = `Could not parse structure markers.\n\nOutput:\n${result.output}`;
            isError = true;
          }
        }

        return {
          contents: [{ uri: uri.href, text: structureText, contentType: 'text/plain' }],
          isError,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          contents: [{ uri: uri.href, text: `Failed: ${msg}`, contentType: 'text/plain' }],
          isError: true,
        };
      }
    }
  );

  const pouCodeTemplate = new ResourceTemplate(
    'codesys://project/{+project_path}/pou/{+pou_path}/code',
    { list: undefined }
  );

  server.resource(
    'pou-code',
    pouCodeTemplate,
    async (uri, params) => {
      const projectPath = params.project_path as string;
      const pouPath = params.pou_path as string;
      if (!projectPath || !pouPath) {
        return {
          contents: [{ uri: uri.href, text: 'Error: Project or POU path missing.', contentType: 'text/plain' }],
          isError: true,
        };
      }
      try {
        const escProjPath = resolvePath(projectPath, workspaceDir);
        const sanPouPath = sanitizePouPath(pouPath);
        const script = scriptManager.prepareScriptWithHelpers(
          'get_pou_code',
          { PROJECT_FILE_PATH: escProjPath, POU_FULL_PATH: sanPouPath },
          ['ensure_project_open', 'find_object_by_path']
        );
        const result = await executor.executeScript(script);

        let codeText = `Error retrieving code.\n\n${result.output}`;
        let isError = !result.success;

        if (result.success && result.output.includes('SCRIPT_SUCCESS')) {
          const declStart = '### POU DECLARATION START ###';
          const declEnd = '### POU DECLARATION END ###';
          const implStart = '### POU IMPLEMENTATION START ###';
          const implEnd = '### POU IMPLEMENTATION END ###';

          let declaration = '/* Declaration not found */';
          let implementation = '/* Implementation not found */';

          const ds = result.output.indexOf(declStart);
          const de = result.output.indexOf(declEnd);
          if (ds !== -1 && de !== -1 && ds < de) {
            declaration = result.output.substring(ds + declStart.length, de).replace(/\\n/g, '\n').trim();
          }

          const is_ = result.output.indexOf(implStart);
          const ie = result.output.indexOf(implEnd);
          if (is_ !== -1 && ie !== -1 && is_ < ie) {
            implementation = result.output.substring(is_ + implStart.length, ie).replace(/\\n/g, '\n').trim();
          }

          codeText = `// ----- Declaration -----\n${declaration}\n\n// ----- Implementation -----\n${implementation}`;
        }

        return {
          contents: [{ uri: uri.href, text: codeText, contentType: 'text/plain' }],
          isError,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          contents: [{ uri: uri.href, text: `Failed: ${msg}`, contentType: 'text/plain' }],
          isError: true,
        };
      }
    }
  );

  // ─── CODESYS IDE bridge passthrough (opt-in via --ide-bridge) ───────
  // When the CODESYS-shipped bridge plugin is loaded inside the running IDE
  // (SP22+), it exposes a named pipe at \\.\pipe\codesys-mcp-bridge with its
  // own MCP server. We attach to that pipe, fetch its tools/list, and
  // re-register each tool under an `ide_` prefix. The bridge's authoring
  // tools mutate the live project graph and the editor view picks the change
  // up immediately, which our IronPython watcher can't do.
  // Tracked so the shutdown handler can reap the bridge shim it spawned —
  // otherwise CodesysMCPBridge.exe orphans every time the orchestrator exits.
  let ideBridgeClient: IdeBridgeClient | null = null;
  if (config.ideBridge !== 'off') {
    ideBridgeClient = await registerIdeBridgeTools(s, config.ideBridge, config.codesysPath);
  }

  // ─── Connect ─────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  serverLog.info('Connecting MCP server via stdio...');
  server.connect(transport);
  serverLog.info('MCP Server connected and listening.');

  // ─── Live values pump (opt-in) ───────────────────────────────────────

  let liveValuesPump: LiveValuesPump | null = null;
  if (config.liveValues) {
    liveValuesPump = new LiveValuesPump(
      {
        stateFilePath: defaultStateFilePath(),
        liveValuesFilePath: defaultLiveValuesFilePath(),
        intervalMs: config.liveValuesIntervalMs ?? 500,
      },
      {
        readSelection,
        readPouFile: (absPath) => fs.promises.readFile(absPath, 'utf8'),
        // Best-effort recursive walk of the device root looking for
        // <typeName>.st. The mirror layout puts every code-bearing object
        // (POU, FB, DUT) at a stable filename matching its declared name,
        // so this is a clean lookup even though the directory tree is
        // arbitrary nesting under "Plc Logic/Application/...".
        resolveTypeMirror: async (typeName, deviceRoot) => {
          const target = `${typeName}.st`;
          const walk = async (dir: string): Promise<string | null> => {
            let entries: import('fs').Dirent[];
            try {
              entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
              return null;
            }
            for (const e of entries) {
              const full = path.join(dir, e.name);
              if (e.isFile() && e.name === target) {
                try {
                  return await fs.promises.readFile(full, 'utf8');
                } catch {
                  return null;
                }
              }
            }
            for (const e of entries) {
              if (!e.isDirectory()) continue;
              const found = await walk(path.join(dir, e.name));
              if (found !== null) return found;
            }
            return null;
          };
          return walk(deviceRoot);
        },
        readVariable: async (projectFilePath, variablePath) => {
          // Reuse the existing read_variable script. Returns the value as
          // a string captured from script stdout. Errors throw.
          const script = scriptManager.prepareScriptWithHelpers(
            'read_variable',
            { PROJECT_FILE_PATH: projectFilePath, VARIABLE_PATH: variablePath },
            ['ensure_project_open', 'ensure_online_connection']
          );
          const result = await executor.executeScript(script);
          if (!result.success || !result.output.includes('SCRIPT_SUCCESS')) {
            throw new Error(result.error || 'read_variable failed');
          }
          // The script prints `Value: <value>` on the success line.
          const m = /Value:\s*(.*)$/m.exec(result.output);
          return m ? m[1].trim() : '';
        },
        writeLiveValues,
      }
    );
    liveValuesPump.start();
    serverLog.info(`Live-values pump started (${config.liveValuesIntervalMs ?? 500}ms)`);
  }

  // ─── Graceful Shutdown ───────────────────────────────────────────────

  const shutdown = async () => {
    serverLog.info('Shutdown signal received');
    if (liveValuesPump) {
      liveValuesPump.stop();
    }
    if (ideBridgeClient) {
      // Reap the bridge shim we spawned so it doesn't orphan.
      try {
        ideBridgeClient.close();
      } catch {
        serverLog.warn('IDE bridge close failed during signal handler');
      }
    }
    if (launcher) {
      try {
        await launcher.shutdown();
      } catch {
        serverLog.warn('Launcher shutdown failed during signal handler');
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Last-ditch synchronous safety net: if we exit by a path that bypasses the
  // async shutdown() above (e.g. stdin EOF from the MCP client, or an
  // uncaught fatal), still force-kill the bridge shim so it can't orphan.
  process.on('exit', () => {
    const pid = ideBridgeClient?.pid;
    if (pid && process.platform === 'win32') {
      try {
        execSync(`taskkill /F /PID ${pid}`, { timeout: 5000, stdio: 'ignore' });
      } catch {
        /* best effort */
      }
    }
  });
  process.on('unhandledRejection', (reason) => {
    serverLog.error(`Unhandled rejection: ${reason}`);
  });
}

/**
 * Probe the CODESYS IDE bridge's named pipe and republish its tools under the
 * `ide_` prefix on our own server. Quietly skips when the bridge plugin isn't
 * present (SP19/SP21, or SP22+ before the user opens CODESYS) under mode='auto';
 * fails loudly under mode='on'.
 */
async function registerIdeBridgeTools(
  s: any,
  mode: 'on' | 'auto',
  codesysPath: string
): Promise<IdeBridgeClient | null> {
  // Before spawning our own bridge, reap any bridge shims left orphaned by a
  // prior session that exited without reaping them (hard kill, or a stale
  // `codesys-ide` direct-server bridge whose MCP client has closed). Only
  // shims with a dead parent are touched, so live sessions are never disturbed.
  const reaped = killOrphanedBridges();
  if (reaped.length > 0) {
    serverLog.info(`Reaped ${reaped.length} orphaned bridge shim(s) at startup (PIDs: ${reaped.join(', ')}).`);
  }

  const exe = IdeBridgeClient.defaultExePath(codesysPath);
  if (!exe) {
    if (mode === 'on') {
      throw new Error(
        `--ide-bridge=on but no CodesysMCPBridge.exe found next to ${codesysPath} ` +
          '(this CODESYS install does not ship the bridge — SP22.10+ required).'
      );
    }
    serverLog.info('IDE bridge shim not present on this CODESYS install; skipping (auto).');
    return null;
  }
  const client = new IdeBridgeClient(exe);
  try {
    await client.connect(5000);
    await client.initialize();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (mode === 'on') {
      throw new Error(`--ide-bridge=on but failed to attach: ${msg}`);
    }
    serverLog.info(`IDE bridge not attached (auto): ${msg}`);
    client.close();
    return null;
  }
  let tools;
  try {
    tools = await client.listTools();
  } catch (err) {
    serverLog.warn(`IDE bridge listTools failed: ${err instanceof Error ? err.message : err}`);
    client.close();
    return null;
  }
  serverLog.info(`IDE bridge attached. Registering ${tools.length} passthrough tool(s) with 'ide_' prefix.`);
  for (const tool of tools) {
    const prefixed = `ide_${tool.name}`;
    const shape = bridgeSchemaToZodShape(tool.inputSchema);
    const description = tool.description ?? `Passthrough to CODESYS IDE bridge tool '${tool.name}'.`;
    s.tool(prefixed, description, shape, async (args: Record<string, unknown>) => {
      try {
        const result = await client.callTool(tool.name, args ?? {});
        // The bridge returns an MCP result envelope ({ content: [...], isError }).
        // Pass it through verbatim so the client sees exactly what the bridge sent.
        return result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Bridge call '${tool.name}' failed: ${msg}` }],
          isError: true,
        };
      }
    });
  }
  return client;
}
