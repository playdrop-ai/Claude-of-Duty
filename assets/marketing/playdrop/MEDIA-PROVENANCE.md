# PlayDrop listing media provenance

## Identity art

The icon and both heroes were generated for this PlayDrop listing on 2026-08-25 with OpenAI's built-in image-generation tool. A fresh real upstream game capture and Matt Shumer's launch footage were used as truth references. The art is limited to the game's real first-person rifle, AI soldier, and procedural concrete market environment.

Final delivery files:

- `icon.png`: 512 x 512, full-bleed, no text.
- `hero/hero-landscape.png`: 1920 x 1080, exact title `CLAUDE OF DUTY`.
- `hero/hero-portrait.png`: 1024 x 1536, exact title `CLAUDE OF DUTY`.

## Creator gameplay video

- Creator post: <https://x.com/mattshumer_/status/2081054356405731740>
- Original media: <https://video.twimg.com/amplify_video/2081053076681621504/vid/avc1/2192x1080/v0qQL-HvczyoP7yH.mp4?tag=29>
- Published by Matt Shumer on 2026-07-25.
- `video/creator-store-gameplay.mp4` is a 12.1-second editorial cut using 00:06.500-00:14.800 and 00:22.000-00:25.800 from the same real run. It preserves the synchronized game audio, has no generated frames or feature-altering edits, and ends on the second visible enemy elimination.
- The delivery file is 1920 x 946, H.264 at 60 FPS with square pixels, with AAC stereo audio at 48 kHz.
- `video/project/render-store-trailer.sh` deterministically rebuilds the delivery file from the original creator media.
- Matt Shumer's original gameplay footage is approved by PlayDrop for use as the production listing trailer.

## Promotional screenshots

The four landscape screenshots were generated on 2026-08-25 with OpenAI's built-in image-generation tool. Real game captures and the protected identity art were used as strict truth references. These are promotional composites, not literal gameplay captures. They do not claim multiplayer, vehicles, an editor, or mechanics absent from the game.

Final delivery files are 1920 x 1080 palette-optimized PNGs, selected to stay within PlayDrop's 2 MB per-image listing limit:

- `screenshots/landscape/01-enter-the-firefight.png`: first-person firefight and one AI target.
- `screenshots/landscape/02-outthink-the-enemy.png`: aiming down sights at AI soldiers using cover.
- `screenshots/landscape/03-generated-in-code.png`: wireframe-to-render metaphor for the real procedural asset pipeline.
- `screenshots/landscape/04-the-gauntlet-original.png`: firefight with abstract iteration and review motifs representing the Gauntlet Loop.

The original generated images remain in Codex's generated-image store. `screenshots/manifest.json` records their source paths and the truth references used for each composition.
