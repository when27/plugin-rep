// plugin-launcher — Host half.
//
// The launcher is a pure web-client surface: its button lives in
// `sidebar.footer.action` and its modal in `shell.overlay`. The bundle still
// needs a Host entry because the profile row resolves the package `main`; this
// half deliberately provides no services, routes or events.

export const name = 'plugin-launcher'

export function apply() {
  // No Host-side wiring. Kept so the bundle row mounts cleanly.
}
