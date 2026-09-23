#!/usr/bin/env bash
# Полная сборка шорта -> out/
#   ./build.sh          — с текущей озвучкой (build/vo + src/vo_timing.js)
#   ./build.sh tts      — сначала перегенерировать черновой голос из script.md
#   ./build.sh audio    — только пересвести звук (музыка + SFX + голос), без рендера кадров
set -e
cd "$(dirname "$0")"
# reuse this project's review server if it runs, otherwise start one (it picks a free port)
STARTED=""
PORT=$(python review_server.py port)
if [ -z "$PORT" ]; then
  rm -f build/.review_port
  python review_server.py >/dev/null 2>&1 &
  STARTED=$!
  for i in $(seq 50); do [ -s build/.review_port ] && break; sleep 0.2; done
  PORT=$(cat build/.review_port)
fi
export REVIEW_PORT=$PORT
trap '[ -n "$STARTED" ] && kill $STARTED 2>/dev/null || true' EXIT

[ "$1" = "tts" ] && python tts.py
node render.js sfx
python audio.py
[ "$1" = "audio" ] && { echo "OK -> build/mix.wav"; exit 0; }
node render.js frames ${FPS:-60} 6
mkdir -p out
NAME=$(basename "$PWD" | tr ' ' '_')
ffmpeg -v error -y -framerate ${FPS:-60} -i build/frames/%05d.png -i build/mix.wav -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest -movflags +faststart "out/${NAME}.mp4"
ffmpeg -v error -y -i "out/${NAME}.mp4" -i build/mix_no_vo.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest "out/${NAME}_NO_VO.mp4"
cp build/mix_no_vo.wav out/music_sfx_no_vo.wav
echo "OK -> out/${NAME}.mp4"
