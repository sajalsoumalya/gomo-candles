# GoMo story — AI video shot list

The goal is one evening in one home, shot as **5 clips of 5–8 seconds each**. Together they become the scroll film on `/story/`.

## Which tool
- **Kling 2.x / Veo 3 / Runway Gen-4**: use **image-to-video** and upload a product photo as the start frame or reference, so the products stay accurate.
- Make every clip **16:9, 1080p or higher, 24 fps**, with **no music and no on-screen text**.
- **Slow, steady camera**: no fast cuts, no shaky handheld. Scroll scrubbing looks best when motion is smooth and continuous.
- Make 3–4 versions of each clip and keep the one where the product looks most like the real thing.

## Shared look (paste at the start of every prompt)
> Cinematic, photorealistic, warm Indian home interior in Kolkata, soft natural light, wooden furniture, cream walls, earthy terracotta and sage tones, shallow depth of field, 35mm film look, slow smooth dolly camera movement, calm and peaceful mood, no text, no logos except on the product.

Use the same person in every clip. Example: a woman in her late 20s, simple cotton kurta, hair tied back. Generate one portrait first and use it as a character reference so she looks the same in every clip.

---

## Clip 1 · Coming home → open the wardrobe (Sachet)
**Reference images:** `assets/images/evil_eye_sachet.jpg`, `assets/images/evil_eye_sachet_2.jpg`
> [Shared look] Early evening, golden sunset light through the window. A young Indian woman walks into her bedroom after work, puts her bag down and opens a wooden wardrobe with both hands. Inside, among neatly hung clothes, a round blue glass Evil Eye charm hangs on a yellow ribbon. She leans in, closes her eyes and breathes in softly, smiling. Faint wisps of fragrance drift out. Camera slowly pushes in toward the Evil Eye charm.

## Clip 2 · Light the candle
**Reference images:** `assets/images/evil_eye_candle.jpg`, `assets/images/evil_eye_candle_2.jpg`
> [Shared look] Dusk, the room getting darker. Close-up: her hand strikes a matchstick and lights the two wicks of a round wooden bowl candle. The wax top has a large blue-and-white Evil Eye pattern. Both flames catch and grow; warm amber candlelight spreads across the table and her face. Camera slowly orbits around the candle.

## Clip 3 · Enjoy the evening
**Reference image:** `assets/images/evil_eye_candle_2.jpg`
> [Shared look] Evening, the room lit mainly by warm candlelight. The Evil Eye wooden bowl candle glows in the centre of a dining table set with simple Indian home food: dal, rice, roti, steam rising. Family laughter, a book and a cup of tea nearby. Relaxed, cosy, unhurried. Camera slowly pulls back from the candle to reveal the table.

## Clip 4 · Mist the pillow (Linen Mist)
**Reference images:** `assets/images/bed_mist.jpg`, `assets/images/bed_mist_2.jpg`
> [Shared look] Night, a bedside lamp on, deep blue night outside the window. She sits on the edge of a bed with white linen, holds an amber glass spray bottle with a white "Dutch Lavender" label and black pump, and sprays it twice over the pillow. A fine mist catches the lamp light and settles on the pillow. Camera slowly moves closer to the pillow.

## Clip 5 · Deep sleep
> [Shared look] Late night, moonlight through sheer curtains, the bedside lamp off. She sleeps peacefully, face relaxed, under a soft sage-green blanket. A small blue Evil Eye charm is visible on the bedside table. Very slow camera drift upward and away, the scene gently darkening.

---

## When you have the clips
1. Name them `01.mp4` … `05.mp4` and put them in a folder, for example `~/Desktop/gomo-clips/`.
2. Run:
   ```bash
   bash tools/story-frames.sh ~/Desktop/gomo-clips
   ```
   This joins the clips with short crossfades, cuts the result into WebP frames in `story/frames/`, and writes `story/frames/manifest.json`.
3. Open `/story/`. The page switches automatically from the illustrated version to your footage.

You can also change the caption text and timing in `story/frames/manifest.json` → `captions`.
