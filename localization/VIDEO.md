# Claude of Duty localized listing video

Outcome: show the current game’s market-street movement, aiming down sights, firing and real enemy takedowns, with each locale’s actual interface.

Evidence: the existing 12.1-second Matt Shumer source cut includes English HUD feedback. Canvas-only video would omit the current DOM HUD rather than localize it. The old demo harness stages enemies, changes health/timing, and makes a separate soundtrack; it is not used for these normal-play recordings.

Delete: no new portrait format, identity opening, generated scenes, copy plates, synthetic sound, or gameplay-specific recording hooks.

Simplest solution: record only the active game tab in isolated Chromium at native 1280x720 and 30 fps, including its DOM interface. Capture the live game mixer into the same recording. The external driver supplies movement, look, aim and fire inputs to the normal input layer. Enemy spawns, health, ammunition, collision, recoil, waves, clock and difficulty remain the shipped game’s behavior. Select one to three action ranges from the same normal run, omit quiet travel, and finish on real combat payoff.

Not building: a new gameplay preview mode, an invulnerable bot, staged combat, new controls, a platform recording pipeline, or translated editorial overlays.

Protected identity: title, icon and hero art are not included or modified. Visible copy is only the real localized HUD. Captures target fr, de, es, pt-BR, id, ja, ko, zh-Hans and zh-Hant, in the existing landscape listing slot.

Export: uniform 1.5x scale to 1920x1080, no crop, normal speed, H.264 yuv420p 30fps SAR1:1, x264 medium/CRF28, AAC 192kbps stereo 48kHz. Final cuts are 7.5 to 11.74 seconds, with localized listing copy describing real movement, aiming, firing and enemy takedowns. Keep all localized video exports under 70MiB in aggregate so the full upload can fit the platform’s 200MiB cap.

Reproduction: build and serve the final runtime; run `VIDEO_URL=http://127.0.0.1:4173/ node tools/localization-video.mjs LOCALE`. This installs the test-only PlayDrop host contract with the selected locale, then captures normal play. Raw WebM sources, runtime hash, input times and state/event samples are retained under ignored `evidence/localization-video/raw/LOCALE`. The recorder refuses to replace a recorded take. Select an exact verified range with `node tools/localization-video-render.mjs LOCALE START_SECONDS END_SECONDS [START_SECONDS END_SECONDS]`.

Validation: inspect the complete timeline plus full-size first, action/poster and last frames. Compare raw and output geometry and text. Verify readable movement, ADS, firing and authentic kills without menus/restarts. Check full decoding, black intervals, codecs, dimensions, frame rate, SAR and actual audible synchronized effects. Review interaction timestamps from the same raw take. Keep cut/range evidence and final technical results under ignored `evidence/localization-video/review/LOCALE`; record the final handoff here after acceptance.

Later: campaign-specific graphics only if requested separately.

## Completed delivery

All nine localized landscape videos passed. The original English trailer is unchanged. Final files are `assets/marketing/playdrop/locales/<locale>/video/gameplay.mp4`. The exact edit ranges are saved in `localization/video-edits.json`; final hashes, sizes, technical checks, runtime hash and genuine takedown counts are in `localization/video-validation.json`.

Localized videos total 46,406,641 bytes. Including the original English trailer, all listing videos total 65,065,003 bytes (62.05 MiB).

| Locale | Seconds | Bytes | Ending |
|---|---:|---:|---|
| fr | 8.20 | 3,966,509 | wave-clear |
| de | 11.73 | 6,561,696 | wave-clear |
| es | 8.10 | 4,811,576 | enemy-takedown |
| pt-BR | 8.10 | 4,511,718 | wave-clear |
| id | 10.63 | 6,217,666 | wave-clear |
| ja | 11.70 | 6,237,024 | wave-clear |
| ko | 7.50 | 4,119,216 | enemy-takedown |
| zh-Hans | 8.30 | 3,602,705 | wave-clear |
| zh-Hant | 9.87 | 6,378,531 | enemy-takedown |

Each final is real normal-play footage. No enemies were staged and no health, difficulty, clocks, recoil, ammunition or outcomes were changed. The external driver controls the existing input layer. All nine captures report zero browser errors and the same finalized runtime hash. The recorder was tested by nine successful complete runs; both maintained scripts also pass Node syntax validation.

The game suspends its live audio context on wave victory. Encoded result holds preserve that natural silence instead of truncating the video when its audio source ends. Full decoding, audio presence/levels, black-interval checks and output format checks passed for every final. Complete timelines, exact input/cut sheets, first/poster/last frames and delivery composites were reviewed. Spanish, Korean and Traditional Chinese end on actual enemy-takedown feedback; the other six end on actual wave-clear results. The short cuts remain understandable with sound muted.

Poster candidates use output time 2.0 seconds. First and last frame checks bracket the full selected edit; all segments run at normal speed.

Review composites use row-major locale order fr, de, es, pt-BR, id, ja, ko, zh-Hans, zh-Hant. Raw sources and detailed review files stay in ignored evidence/localization-video. The parent task owns final package checks, commit, upload and live verification.
