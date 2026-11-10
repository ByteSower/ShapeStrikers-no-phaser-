# Visual Effects Workflow

Use the smallest rendering approach that fits the effect. Keep presentation separate from combat rules so visual iteration cannot change battle results.

## Choose the right layer

- **Persistent themes** such as grid skins belong in `style.css`, with a selectable class managed by `src/gridStyles.js`.
- **Live grid effects** such as flames belong in `src/gridFx.js`: a canvas over the grid runs a particle effect described as data (rate, lifetime, size, colour ramp). A grid style opts in with its `effect` field. `src/gridFxGl.js` can supply a WebGL shader version of an effect for per-pixel looks (mist, frost, glow); Canvas 2D stays the default and the fallback. Switch between them from the dev tools panel.
- **Short-lived combat effects** belong in `src/vfx.js`; attach pooled particles to their tile or grid and expose a focused effect function.
- **Unit movement and action animation** belong with the grid presentation helpers in `src/grid.js`. Keep logical movement and battle state authoritative in the game/battle flow.
- **Sound** should use the existing audio layer in `src/audio.js`, triggered alongside the visual event rather than from CSS.
- Prefer CSS gradients and simple DOM shapes for scalable effects. Use authored, optimized sprite frames only when the look needs detailed hand-drawn motion.

## Add an effect

1. **Describe the moment.** Specify the gameplay trigger, visual subject, duration, intensity, and whether the effect repeats. Keep a looping ambient effect distinct from one-shot feedback.
2. **Find the event boundary.** Connect the effect to the existing attack, hit, status, placement, or movement event. Do not put presentation side effects inside deterministic calculations.
3. **Implement a focused visual primitive.** Reuse `VFX` helpers where possible. For transient DOM particles, use the existing pool and reset inline styles when releasing nodes. Keep motion on `transform` and `opacity` when practical.
4. **Make lifetime explicit.** Remove or recycle nodes on `animationend`/`transitionend`, and provide a bounded timeout fallback so interrupted animations cannot leave stale elements. Avoid unbounded intervals and per-frame work for simple effects.
5. **Account for accessibility and layout.** Respect `prefers-reduced-motion`, avoid obscuring units or controls, and check small-screen grid sizes and stacking contexts.
6. **Verify both presentation and rules.** Test the trigger in the browser, confirm the effect cleans up after completion and interruption, run the focused tests, and run determinism checks when touching battle or movement integration. Confirm that disabling/reducing motion does not change game outcomes.

## Existing patterns

- Pooled projectiles and ability particles: `src/vfx.js`
- Unit movement and tracked battle animations: `src/grid.js`
- Battle event integration: `src/game.js`
- Grid themes and unlockable previews: `src/gridStyles.js` and `src/ui.js`
- Canvas particle effects around the grid: `src/gridFx.js`

For externally sourced or generated art, record its source and license, keep it in the appropriate asset directory, and size/optimize it for the grid before wiring it into an effect.
