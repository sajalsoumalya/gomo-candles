#!/usr/bin/env bash
# Turn the AI video clips for /story/ into a scroll-scrubbed frame sequence.
# Usage: bash tools/story-frames.sh <folder-with-clips> [max-frames=240]
# Clips are joined in filename order (01.mp4, 02.mp4 …) with a short crossfade.
# Output: story/frames/{lg,sm}/0001.webp … and story/frames/manifest.json
set -euo pipefail

SRC="${1:?usage: bash tools/story-frames.sh <clips-folder> [max-frames]}"
MAX="${2:-240}"
XF=0.6   # crossfade seconds between clips
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/story/frames"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

command -v ffmpeg >/dev/null || { echo "ffmpeg is required (brew install ffmpeg)"; exit 1; }
command -v cwebp  >/dev/null || { echo "cwebp is required (brew install webp)"; exit 1; }

CLIPS=()
while IFS= read -r f; do CLIPS+=("$f"); done < <(find "$SRC" -maxdepth 1 -type f \( -iname '*.mp4' -o -iname '*.mov' -o -iname '*.webm' \) | sort)
N=${#CLIPS[@]}
[ "$N" -gt 0 ] || { echo "No .mp4/.mov/.webm clips found in $SRC"; exit 1; }
echo "→ $N clip(s)"

# 1. normalise every clip to 1920x1080 @ 24 fps, no audio
DUR=()
for i in "${!CLIPS[@]}"; do
  ffmpeg -loglevel error -y -i "${CLIPS[$i]}" -an \
    -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=24,format=yuv420p" \
    -c:v libx264 -crf 16 -preset fast "$TMP/n$i.mp4"
  DUR+=("$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TMP/n$i.mp4")")
done

# 2. join with crossfades
if [ "$N" -eq 1 ]; then
  cp "$TMP/n0.mp4" "$TMP/joined.mp4"
else
  inputs=(); for i in "${!CLIPS[@]}"; do inputs+=(-i "$TMP/n$i.mp4"); done
  filter=""; acc="${DUR[0]}"; prev="0:v"
  for ((i = 1; i < N; i++)); do
    off=$(awk -v a="$acc" -v x="$XF" 'BEGIN{printf "%.3f", a - x}')
    filter+="[$prev][$i:v]xfade=transition=fade:duration=$XF:offset=$off[v$i];"
    prev="v$i"
    acc=$(awk -v a="$acc" -v d="${DUR[$i]}" -v x="$XF" 'BEGIN{printf "%.3f", a + d - x}')
  done
  ffmpeg -loglevel error -y "${inputs[@]}" -filter_complex "${filter%;}" -map "[$prev]" -c:v libx264 -crf 16 -preset fast "$TMP/joined.mp4"
fi
TOTAL=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TMP/joined.mp4")
FPS=$(awk -v m="$MAX" -v t="$TOTAL" 'BEGIN{f = m / t; if (f > 24) f = 24; printf "%.4f", f}')
echo "→ ${TOTAL}s total, sampling at ${FPS} fps"

# 3. frames → webp, two sizes
rm -rf "$OUT/lg" "$OUT/sm"; mkdir -p "$OUT/lg" "$OUT/sm" "$TMP/png"
ffmpeg -loglevel error -y -i "$TMP/joined.mp4" -vf "fps=$FPS" -frames:v "$MAX" "$TMP/png/%04d.png"
COUNT=0
for f in "$TMP"/png/*.png; do
  b=$(basename "$f" .png)
  cwebp -quiet -q 74 -resize 1600 900 "$f" -o "$OUT/lg/$b.webp"
  cwebp -quiet -q 70 -resize 960 540 "$f" -o "$OUT/sm/$b.webp"
  COUNT=$((COUNT + 1))
done

# 4. manifest — one caption per clip, shown in the middle of that clip's share of the scroll
TITLES=("Open the wardrobe" "Light the candle" "Enjoy the evening" "Mist the pillow" "Sleep deeply")
SUBS=("Evil Eye Sachet" "Evil Eye Candle" "Dinner, music, a good book" "Dutch Lavender Linen Mist" "Wake lighter, calmer, ready")
caps=""; start=0
for ((i = 0; i < N && i < 5; i++)); do
  len=$(awk -v d="${DUR[$i]}" -v x="$XF" -v i="$i" -v n="$N" 'BEGIN{ if (i > 0) d -= x/2; if (i < n-1) d -= x/2; printf "%.4f", d }')
  win=$(awk -v s="$start" -v l="$len" -v t="$TOTAL" 'BEGIN{a=s/t; b=(s+l)/t; w=b-a; printf "%.3f,%.3f,%.3f,%.3f", a+w*.12, a+w*.25, b-w*.25, b-w*.08}')
  [ "$i" -eq $((N - 1)) ] && win="${win%,*,*},1.1,1.2"
  caps+="{\"win\":[$win],\"title\":\"${TITLES[$i]}\",\"sub\":\"${SUBS[$i]}\"},"
  start=$(awk -v s="$start" -v l="$len" 'BEGIN{printf "%.4f", s + l}')
done
cat > "$OUT/manifest.json" <<JSON
{
  "count": $COUNT,
  "lg": "/story/frames/lg/{n}.webp",
  "sm": "/story/frames/sm/{n}.webp",
  "captions": [${caps%,}]
}
JSON
echo "✓ $COUNT frames → story/frames/  ($(du -sh "$OUT" | cut -f1))"
