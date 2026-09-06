# Claude of Duty 1.0.1 localization

Game-only update for `mattshumer_/claude_of_duty`: English plus French, German,
Spanish, Brazilian Portuguese, Indonesian, Japanese, Korean, Simplified Chinese,
and Traditional Chinese. The existing slug, creator attribution, license,
controls, procedural art, combat, waves and supported surfaces are preserved.

The runtime uses 84 translated keys and the PlayDrop host locale. The listing has
nine complete translated snapshots, 36 translated promotional screenshots,
eight Asian-language heroes and nine real-gameplay landscape videos at 30 fps.
Latin-script titles and their heroes retain Claude of Duty. The text-free icon
and original English listing media are retained. See `image-copy.json`,
`media-manifest.json`, `VIDEO.md` and `video-validation.json` for media details.

Validation passed: clean npm install, production build, dictionary and parameter
parity, browser checks for all ten languages, desktop/touch/controller actions,
pause and resume, wave results and reset, and both CLI surface tapes with visual
review. One initial visible-window mobile check ended paused; the instrumented
touch replay and the final isolated CLI repeat both ended in active play. No
runtime change was needed for that transient test result.

The prepared upload contains 76 files totaling 133,362,981 bytes against the
209,715,200-byte limit. Listing assets upload separately; `.playdropignore`
excludes their duplicate copies from the source archive, reducing that archive
to approximately 3.1 MB. Account storage was sufficient without a plan change.

Source listing hash:
`a95bd4368311c89b01151873d8b24fe214dcbd6d1417c93690a5c0bdd9c7348d`.

No PlayDrop platform files or account settings were changed.

Published to production as version 1.0.1 on 2026-09-06 UTC from commit `ded14c7`.
The upload's hosted zero-input/full-tape gameplay comparison passed. Public API
verification then matched all ten listings to the release and confirmed all 61
unique media URLs returned HTTP 200 with the expected file sizes (121,530,139
bytes total). Detailed responses are retained in the local ignored
`output/localization/live-verification.json`.

Final live-page inspection was limited by repeated Chrome/CDP connection
timeouts, including after reconnecting. The previously reported platform
host-locale issue therefore remains unverified here; this release makes no
claim that the platform issue is fixed. All ten game locales passed the local
hosted browser harness before publishing.
