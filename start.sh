#!/usr/bin/env sh
set -eu
if [ ! -d ".venv" ]; then
    echo "No virtual environment found. Please create one using 'python -m venv .venv' and install dependencies."
    exit 1
fi
source .venv/Scripts/activate

: "${SOUVENIR_MEDIA_HOME:?SOUVENIR_MEDIA_HOME must point to the media library}"
#npm run build
exec python -m server --host 0.0.0.0 --port "${SOUVENIR_PORT:-8000}" --https
