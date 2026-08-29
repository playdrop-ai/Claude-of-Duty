# Hosting-fork performance analysis

## Outcome

Make Claude of Duty responsive on large Retina-class game surfaces while preserving its authored scene, lighting, materials, effects, UI, controls, and gameplay.

## Evidence

The reported PlayDrop route rendered a 3117 x 1753 canvas and the same-size internal 3D pipeline, or 5.46 megapixels through a multi-pass HDR renderer. The in-game overlay showed 12.4 FPS. A deterministic 240-frame reproduction measured 87.6 ms p50, 91.9 ms p95, and 11 FPS p50 with no runtime errors.

Pass-isolation runs found the workload was fill-rate bound. Screen-space ambient occlusion, reflections, contact shadows, volumetrics, and the repeated full-resolution HDR passes dominated frame time. All four shadow cascades together cost only about 6 ms, despite contributing most of the draw calls, so a geometry rewrite or WebGPU port was not the first useful move.

The optimized renderer keeps the 3117 x 1753 presentation buffer and crisp DOM HUD while limiting only the internal 3D pipeline to 1.2 megapixels on oversized displays. It also runs temporally filtered ambient occlusion, reflections, and volumetric lighting at quarter resolution, contact shadows at half resolution, and the first-person MSAA target at two samples. The final full-resolution composite applies scale-aware sharpening and avoids one redundant HDR texture fetch.

At the reported canvas size, three final active-game profiles used a 1460 x 821 internal buffer and measured 18.3 to 18.5 ms p50, 21.1 to 22.8 ms p95, and 54 to 55 FPS p50 across 240 post-warm frames per run. They recorded zero hitches, zero programs compiled during play, zero heap growth, and zero page errors. A separate real click-to-start playtest reported 65 FPS.

That is a 4.9x to 5x median frame-rate improvement and a 78.9% to 79.1% reduction in median frame time relative to the reproduced full-resolution baseline.

The uploaded PlayDrop v1.0.3 route was profiled separately through the complete local host shell. At the same 3117 x 1753 presentation size it measured 22.0 ms p50, 27.4 ms p95, and 45 FPS p50 over 240 active frames with no page errors. After extended firing produced a deliberately heavier frame containing smoke, decals, and 12 AI actors, the live overlay still showed 30.9 FPS.

## Delete

- No WebGPU rewrite. The measurements identify multi-pass pixel cost, not WebGL API overhead, as the primary constraint.
- No gameplay, AI count, world geometry, materials, lighting design, assets, or store-media changes.
- No reduction to the full-resolution canvas, DOM HUD, tone mapping, LUT, grain, vignette, or final presentation pass.

## Simplest solution

Bound the expensive internal pixel workload only when the display would otherwise exceed the measured budget, then spend full resolution on final presentation and UI. Keep the existing temporal renderer and lower the source resolution of effects that already accumulate or blur their output.

## Not building

- A new renderer backend.
- User-facing graphics settings or quality menus.
- Dynamic frame-by-frame resolution oscillation.
- Asset baking, world simplification, reduced enemy count, or altered game rules.

## Validation

- Five deterministic scenes covering daylight, fine detail, combat, ADS, and night were captured before and after. Manual side-by-side inspection found the same composition, geometry, lighting, materials, effects, weapon, and HUD with no missing or newly visible elements.
- The focused gameplay test passed the click-to-start gate, moved 3.79 metres over 50 frames, emitted nine weapon-fire events, found zero invalid transforms, and reported no console errors.
- The exact large-display route showed a 1460 x 821 internal buffer inside the unchanged 3117 x 1753 presentation buffer, and the Command+Shift+D overlay toggled on and off correctly.
- The uploaded iframe URL resolved to v1.0.3, reached the click-to-start gate, focused the canvas, started the engine, and completed the hosted profile without console or page errors.

## Later

Only pursue deeper scene or shader changes if real hosted-device evidence shows 30 FPS is still insufficient. The next experiment should isolate the forward material shader on affected hardware before changing visible quality.
