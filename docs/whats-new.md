# What's new in this fork

Relative to upstream [luke-harriman/Codesys-MCP](https://github.com/luke-harriman/Codesys-MCP).

## Compatibility fixes (the headline)

- **SP21+/SP22 compatibility.** The watcher was rewritten as single-threaded on the primary thread, yielding to the IDE via `system.delay()`. No background thread, no marshaling. Works on SP19, SP21, and SP22+. Full rationale in [migration-sp21-plus.md](migration-sp21-plus.md).
- **Cancel-link hardening.** The watcher catches `KeyboardInterrupt` (which is not a subclass of `Exception` in IronPython 2.7) at three layers, so clicking *"Click here to CANCEL this operation"* in CODESYS no longer pops the modal traceback dialog or kills the watcher. v0.17.1 adds an outer guard around the whole poll loop: a Cancel that landed between the per-iteration handlers (inside `_log`, `os.listdir` or an `except` block) used to unwind the watcher with "KeyboardInterrupt outside main loop" and leave every later tool call timing out.

## Upstream tool fixes

- **`create_folder`** - upstream passed `name=` as a kwarg the API doesn't accept; fixed to use positional `foldername=` with an `SV_POU` fallback for SP21+, then walks children to detect success since the API returns void.
- **`compile_project` / `get_compile_messages`** - upstream choked on Python `long` values that `json.dumps` can't serialize on IronPython 2.7. Coerced to `int` before dumping.
- **`connect_to_device`** - upstream used the wrong `LoginMode` signature. Fixed, plus the online tools now **auto-login** if you haven't already, instead of silently returning empty results.
- **`ensure_project_open`** - fixed the cross-project switch path so opening a second project no longer leaves the watcher pinned to the first. Since v0.17.0 it also **refuses to switch away from a project with unsaved changes** instead of silently saving it (a silent save once rewrote a template project that was only being read).
- **`set_pou_code`** - upstream wiped the *other* half of the POU when only declaration or only implementation was passed. Now an omitted field is left intact.
- **`add_library`** - pre-resolves via `library_manager.find_library` and prefers the managed-library overload. **Refuses to save** if the resulting reference is an unresolvable placeholder, which would otherwise brick the next project open.
- **`list_project_libraries`** - switched to the `ScriptLibManObjectContainer` API (the previous one no longer exists), and now also captures IDE version, devices, and per-Application compiler version.

## New tools (not in upstream)

- **SP21 full API coverage (v0.11.0-v0.12.0)** - 46 tools across 5 phases closing the gap to the SP21 ScriptEngine API: online/runtime ops (reset, force/unforce, bulk read/write, boot application, source up/download, PLC file transfer), project lifecycle (PLCopenXML + native export/import, project archive, compiled library, project info, compiler version), application build actions, device parameters + IO-mapping CSV + task configuration, and project user management. Per-category tables in [tools.md](tools.md); plan + status in [superpowers/plans/2026-06-12-sp21-api-coverage.md](superpowers/plans/2026-06-12-sp21-api-coverage.md). SVN, Application Composer and Automation Server scripting are deliberately out of scope (license-gated / addon products).
- **`mirror_export`** - walks the project tree and writes one `.st` file per code-bearing object into `<projectDir>/mcp-mirror/`, preserving the project tree. Foundation for source-controlled CODESYS projects. Since v0.17.0 it prunes stale files of deleted/renamed objects and empty directories (signature-guarded, skipped on walk errors).
- **`bump_project_version`** - bumps one part of the 4-part `Project Information.Version` (major / minor / revision / build / **auto**) and maintains a `_MCP_PROJECT_VERSION` GVL inside the project so the running PLC carries its source version. `auto` mode classifies via mirror diff vs the latest `v*` git tag (deletion/rename = major; addition = minor; modification = revision; first-run seeds at 1.0.0.0). Auto-maintains `Changelog.md` alongside the bump.
- **`release_project_version`** - one-shot release pipeline: `mirror_export`, classify, `bump_project_version`, regenerate library.md/pou-dump.md/README.md/Changelog.md, `git add` controlled paths, `git commit`, `git tag v<new>`, `git push --follow-tags`. Tag annotation embeds dual SHAs (project-sha256 + mirror-sha256) so the binary-changed-without-source-diff case still gets a build-bump with provenance. Hand-maintained library.md sections survive regeneration (v0.15.3).
- **`read_running_version_online` / `read_running_version_ssh`** - read `_MCP_PROJECT_VERSION.sVersion` from the running PLC, over the CODESYS online protocol or straight off the boot-application binary via SSH.
- **NVL tools (v0.16.0)** - `set_nvl_sender` / `create_nvl_receiver` via the IDE's Automation Platform API (the scripting API has no NVL support), proven live on a two-device project.
- **Multi-device projects (v0.16.0)** - `list_applications` shows every application in a project with its device and which one is ACTIVE; `set_active_application` switches `project.active_application` and saves. 50 application-scoped tools take an optional `applicationPath` and activate it before acting; Task Configuration, Library Manager and Symbol Configuration are resolved under the active application first; `bump_project_version` maintains `_MCP_PROJECT_VERSION` in EVERY application so each PLC of a master/slave project carries the project version.
- **Device network / access management** - `scan_network_devices`, `verify_device_reachable`, `rebind_device_to_scan_result`, `add_device_user`, `grant_object_access`, `restart_runtime_ssh`.
- **Device tree ops** - `add_device` (child devices, idempotent), `update_device_type` (in-place retarget preserving the Application subtree).
- **Struct device parameters (v0.17.1)** - `set_device_parameter` / `get_device_parameter` handle SP21 `ScriptCompoundDeviceParameter` values (a .NET list of child elements): the children are found by iteration or `Count` + indexer, so a struct such as the CC100 751-9402 channel mode (`AI Setup` id 2003161 / `AO Setup` id 2003178, element 0 = 100 0..10 V, 101 +-10 V, 120 0..20 mA, 121 4..20 mA, 122 3.6..21 mA; AO 200/201/202 V, 220/221/223 mA) is written with `elementIndex: 0`. `update_device_type` also works on channel objects, e.g. X6_1 `Single AI` -> `Single AO`.

## Reliability fixes

- **`launcher`** refuses to spawn a 2nd instance of the **same** CODESYS install (would conflict on the project file lock). Different installs (SP21 + SP22) coexist fine. Filters by `--codesys-path`, not just by image name, so multi-install setups work.
- **`shutdown_codesys`** kills orphan `CODESYS.exe` of the configured install when the launcher has no tracked PID (e.g. after a crashed parent). Other installs are left alone.
- **Template interpolation hardening (v0.12.1)** - `$`-sequences in tool-arg values (IEC string literals like `'$R$N'`) are no longer mangled by regex replacement; user-arbitrary values (passwords, comments, PLC paths, device parameter values) are escaped into Python string literals instead of being pasted raw into `r"..."` templates; `find_object_by_path` accepts dot-separated paths all the way through its final name check; the build cleans `dist/scripts` so deleted templates don't ship in the npm tarball.
- **Version pin (v0.14.0)** - `bump_project_version` / `release_project_version` refuse to save a project on a mismatched CODESYS install; see [installs-and-profiles.md](installs-and-profiles.md).
- **Sjobjorn seed fixes (v0.17.0)** - `ensure_project_open` dirty-switch refusal; `mirror_export` stale-file pruning; `remove_pou_from_task` verifies removal on a freshly re-walked task object; `set_device_parameter` writes array/struct parameters element-wise (`elementIndex`) or whole (`'[v0, v1, ...]'`).

## Verification

The verified state of every tool is recorded in [function-test-2026-04-25.md](function-test-2026-04-25.md) (and the 2026-04-28 re-verification in [function-test-2026-04-28.md](function-test-2026-04-28.md)). Open issues (mostly online-API drift) are tracked in [open-bugs-cross-reference.md](open-bugs-cross-reference.md).
