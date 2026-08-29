#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'Usage: %s SOURCE_VIDEO OUTPUT_VIDEO\n' "$0" >&2
  exit 64
fi

source_video="$1"
output_video="$2"

if [[ ! -f "$source_video" ]]; then
  printf 'Source video not found: %s\n' "$source_video" >&2
  exit 66
fi

mkdir -p "$(dirname "$output_video")"

ffmpeg -hide_banner -loglevel error -y \
  -i "$source_video" \
  -filter_complex "\
    [0:v]trim=start=6.500:end=14.800,setpts=PTS-STARTPTS,scale=1920:946:flags=lanczos,fps=60,setsar=1[v0];\
    [0:a]atrim=start=6.500:end=14.800,asetpts=PTS-STARTPTS[a0];\
    [0:v]trim=start=22.000:end=25.800,setpts=PTS-STARTPTS,scale=1920:946:flags=lanczos,fps=60,setsar=1[v1];\
    [0:a]atrim=start=22.000:end=25.800,asetpts=PTS-STARTPTS[a1];\
    [v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]" \
  -map '[v]' \
  -map '[a]' \
  -c:v libx264 \
  -preset slow \
  -crf 18 \
  -pix_fmt yuv420p \
  -c:a aac \
  -b:a 192k \
  -ar 48000 \
  -ac 2 \
  -movflags +faststart \
  "$output_video"
