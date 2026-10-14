# React → SolidJS 2.0 (RC) migration plan

Status: **complete.** React is fully removed; the app runs on
`solid-js@2.0.0-rc.15`, typechecks clean, builds, and all tests pass.

Verified:
- `bunx tsc --noEmit` — 0 errors
- `bun test --conditions=browser` — 187/187 pass
- `bunx vite build` — succeeds
- `biome check .` — clean apart from two pre-existing `public/logo_*.svg`
  a11y findings (untouched by this migration)
- No `react` framework references remain in `src/`

Goal: replace React completely with **SolidJS 2.0 RC**, keeping behavior,
styling and all non-UI logic (youtube/lyrics/services/Tauri/Rust) unchanged.

## Stack

| Concern | Before | After |
| --- | --- | --- |
| Framework | react 19 / react-dom | `solid-js@2.0.0-rc.15` + `@solidjs/web` |
| JSX types | `react-jsx` | `"jsxImportSource": "@solidjs/web"` |
| Vite | `@vitejs/plugin-react` | `@solidjs/vite-plugin@3.0.0-next.50` |
| Routing | react-router-dom (HashRouter) | `@solidjs/router@2.0.0-next.39` |
| Icons | lucide-react | `@lucide/solid@1.57.0` (direct imports, no wrapper) |
| Dialog/Menus/Popover | @base-ui/react | `@kobalte/core@2.0.0-alpha.2` (verified on rc.15) |
| Virtualizer | @tanstack/react-virtual | `@tanstack/virtual-core` + local adapter |
| Tests | default | `bun test --conditions=browser` (bun resolves Solid's server build otherwise) |

## Solid 2.0 porting conventions (apply everywhere)

| React | Solid 2.0 |
| --- | --- |
| `useState` | `createSignal` (accessor + setter) |
| `useMemo` | `createMemo` |
| `useEffect(fn)` | `createEffect(compute, apply)` — split phases; never a single arg |
| `useLayoutEffect` | `createEffect` (runs after DOM mutation) |
| `onMount` | `onSettled` (cleanup = returned function) |
| cleanup | `onCleanup`, or return from effect apply / `onSettled` |
| `useRef` | plain variable, or `{ current }` holder for imperative handoff |
| DOM ref | `let el!: T; <div ref={el} />` |
| context | `createContext<T>()` + `<Ctx value={...}>`; `useContext` returns `T` (throws if unprovided) |
| `useSyncExternalStore` | module-level signal/store |
| `className` | `class` (arrays/objects allowed) |
| `onChange` | `onInput` for text/range inputs |
| `.map()` lists | `<For>`; `Index` → `<For keyed={false}>` |
| `key={}` remount tricks | keyed `<Show>`/`<Match>` |
| capture handlers | `ref` + `addEventListener(..., true)` (`on:`/`oncapture:` are gone) |
| `mergeProps`/`splitProps` | `merge`/`omit` |
| `unwrap` | `snapshot` |

**2.0 rules (from solid's reactivity-diagnostics SKILL.md):**
- No signal/store writes in component bodies or compute phases
  (`REACTIVE_WRITE_IN_OWNED_SCOPE`); writes belong in event handlers or
  effect **apply** phases. Writes inside owned scopes are held until the
  flush continuation — don't read-after-write there.
- No primitives (memo/effect) inside effect callbacks; hoist to component body.
- Store setters are draft-first and must be synchronous.
- `flush()` is not allowed inside effects/`onSettled`/actions.
- Reading reactive values at a component's top level (incl. destructured
  props) warns `STRICT_READ_UNTRACKED` — read inside JSX/memos.
- Destructuring a reactive object field captures a snapshot; call sites keep
  the object and read fields where they update (JSX).

## Function inventory (API shape decisions)

- `usePlayer()` → object of accessors (`currentSong()`, `queue()`, …) + stable
  action functions; `videoElementRef` becomes `videoElement()`; drop the
  always-null `videoContainerRef`.
- `usePlayerControls()` / `usePlayerVolume()` → same shape (accessors).
- `useSettings()` → `[settingsStore, updateSettings]` (store proxy keeps
  field access reactive; tuple destructuring stays as-is).
- `usePinnedPlaylists()` → `{ get pinned, isPinned, togglePinned, unpin }`
  (keep object; don't destructure `pinned`).
- `useSongVersionReplacements()` → `{ get(id) }` reading a store.
- `useDownloads()` → reactive snapshot store (fields read in JSX).
- `useMediaTime(...)` → `{ currentTime(), duration() }` accessors; inputs
  become accessors (`() => songId`).
- `useAmbientColor(url)` → takes accessor, returns accessor.
- `useDisplayTitle()` / `useFormatTitle()` → plain functions reading settings.
- `useRomanizedLines(lines, enabled)` → accessors in, accessor out.
- Motion hooks: refs stay as holders; effects split; `showLyrics`/`open`
  become accessors.

## Waves

1. ✅ Toolchain + verification harness (smoke page + playwright runner; all 18 checks pass).
2. ✅ **State/logic modules** — `lib/player/player-ui.ts`,
   `lib/stores/{settings,pinned,toast,song-versions}.ts`,
   `lib/downloads/downloads.ts`, `lib/utils/hooks.ts`, `lib/utils/title.ts`
   (hook tails), `lib/lyrics/romanize.ts`, `lib/motion/*.ts`.
3. ✅ **Player core** — `contexts/player-context.tsx` (accessor-based context;
   dead `videoContainerRef` dropped).
4. ✅ **UI primitives** — button/input/card/alert on native elements;
   `scroll-area.tsx` deleted (plain overflow divs at call sites).
   Kobalte is used directly at dialog/menu/popover call sites.
5. ✅ **Components** — all ported (incl. lyrics, search-results, home-feed).
6. 🔄 **Pages** — `home` ✅, `artist` ✅, `playlists` ✅, `now-playing` ✅;
   remaining: `settings`.
7. **Shell** — `app.tsx` root `render()` + `HashRouter` root/route structure,
   sync components (Discord/MediaSession/ListenBrainz/Ambient).
8. **Verification & cleanup** — user tests manually (no smoke harness);
   final `tsc --noEmit`, `bun test --conditions=browser`, `vite build`,
   `biome check`.

## Hazards checklist

- `onChange` → `onInput`: search fields, playlist editors, settings sliders.
- Capture-phase gestures → ref + addEventListener (swipe/now-playing motions).
- Remount tricks: `animate-page-in` per pathname, per-song entrance
  animations, `SearchResults key={query}`, `PinnedThumbnail key={thumbnail}`.
- Virtualizer port: `virtual-core` + measureElement + scrollToIndex parity.
- `inert` boolean attr, `style` objects with CSS custom properties (`--np-*`).
- Kobalte data attributes (`data-expanded`, `data-highlighted`) vs Base UI's.
- Module-scope localStorage access stays guarded for bun tests.
- Dialog/menu/popover markup ports from Base UI → Kobalte (Portal/Content).
