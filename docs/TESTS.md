# Testing ReplayBox

How to run the automated tests and the conventions to follow when adding new ones.

See the [README](../README.md) for the project overview and [BUILD.md](BUILD.md) for production builds.

## Running tests

All commands assume the repository root unless noted.

### Frontend (Vitest)

Requires Node dependencies (`npm install`).

```bash
npm test              # single run
npm run test:watch    # watch mode
```

Tests live next to source under `src/**/*.test.ts` and `src/**/*.test.tsx`.

### Backend (Cargo)

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Or from `src-tauri/`:

```bash
cd src-tauri && cargo test
```

Rust unit tests use in-module `#[cfg(test)]` blocks (for example in `settings.rs`, `db.rs`, `ffmpeg.rs`). Filesystem-backed cases use the `tempfile` dev-dependency.

### What is covered today

| Layer | Runner | Focus |
|-------|--------|--------|
| TypeScript helpers / views | Vitest | Pure `src/lib/*` logic (incl. `queueHelpers`); QueuesView/JobBar/VideoPlayer preparing/EditorView busy with mocks; Settings watch-folder UX |
| Rust library | `cargo test` | Path/settings validation, catalog helpers, FFmpeg path/JSON parse helpers, SQLite CRUD, tool resolution, `job_queue` / `preview_queue` FIFO APIs |

Not covered by unit tests (intentionally): live FFmpeg jobs, full Tauri command integration, Playwright-style E2E.

---

## Guidelines

### Goals

1. Prefer **fast, deterministic unit tests** over brittle end-to-end suites.
2. Test **behavior and contracts**, not implementation noise.
3. Keep new production and test code in **English** (names, assertions, failure messages).
4. Avoid mid-function comments; document public helpers/commands only when the contract needs it.

### What to unit-test

**Do test**

- Pure functions (formatting, sorting, folder grouping, path helpers, JSON parsers).
- Validation and persistence round-trips that can use temp dirs/DBs (`validate_watch_dir`, settings load/save, SQLite CRUD).
- UI flows that matter for safety when dependencies are mocked (e.g. Settings refuse inaccessible folders).

**Do not unit-test (or defer)**

- Thin `invoke` wrappers that only forward to Tauri.
- OS-heavy code: tray/autostart edge cases, media HTTP server under load.
- Full FFmpeg encode/decode pipelines (prefer extracting parse/helpers and testing those).

### Frontend conventions

| Rule | Detail |
|------|--------|
| Framework | Vitest (+ jsdom). Use Testing Library for React components. |
| Location | Co-locate: `foo.ts` → `foo.test.ts`; `Foo.tsx` → `Foo.test.tsx`. |
| Isolation | Mock `@tauri-apps/api`, plugins (`dialog`, etc.), and `src/lib/api` when testing views. |
| Cleanup | Call `cleanup()` from Testing Library in `afterEach` (or a shared setup file) so renders do not stack. |
| Pure code | Prefer small modules without Tauri imports (e.g. `format.ts`) so unit tests need no mocks. |
| Assertions | Prefer clear expected values over brittle full-DOM snapshots. |

### Rust conventions

| Rule | Detail |
|------|--------|
| Location | Prefer `#[cfg(test)] mod tests { ... }` in the same file as the code under test. |
| I/O | Use `tempfile` for directories and DB files; never depend on the developer’s real watch folder or home paths. |
| Visibility | Keep helpers `pub(crate)` or test them in-module; extract parsers from subprocess spawn when you need coverage without binaries. |
| Permissions | Platform-specific cases (e.g. unreadable dirs via `chmod`) are fine on Linux; skip or `cfg` if they cannot work elsewhere. |
| Scope | One concern per test name (`validate_watch_dir_rejects_missing`, not `test_everything`). |

### Adding a new test (checklist)

1. Prefer extracting pure logic if the code is tightly coupled to Tauri, FFmpeg spawn, or UI state.
2. Place the test next to the module (TS) or in `#[cfg(test)]` (Rust).
3. Cover success and the important failure paths (empty path, missing dir, permission denied, etc.).
4. Run `npm test` and/or `cargo test --manifest-path src-tauri/Cargo.toml` before considering the change done.

### Out of scope for this document

Integration and system tests (real FFmpeg jobs, E2E) may be added later under a separate harness. Until then, keep unit tests focused and do not expand scope into those layers without an explicit project decision.
