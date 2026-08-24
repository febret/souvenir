#!/usr/bin/env sh
set -eu
: "${SOUVENIR_MEDIA_HOME:?SOUVENIR_MEDIA_HOME must point to the media library}"
exec python -m server --host 0.0.0.0 --port "${SOUVENIR_PORT:-8000}" --https
