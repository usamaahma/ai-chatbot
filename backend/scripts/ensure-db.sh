#!/usr/bin/env bash
# Starts the local MongoDB (~/mongodb7, port 27017) if it isn't already running.
# Runs automatically before `npm run dev`. Does nothing when MONGODB_URI points
# somewhere else (e.g. Atlas).
#
# Local MongoDB is 7.0 in the home folder because the system MongoDB 8.0 refuses
# to start on Linux kernel 6.19+ (SERVER-121912).

cd "$(dirname "$0")/.." || exit 1

URI=$(grep -E '^MONGODB_URI=' .env 2>/dev/null | cut -d= -f2-)
case "$URI" in
  *127.0.0.1*|*localhost*) ;;
  *) exit 0 ;;
esac

if (echo > /dev/tcp/127.0.0.1/27017) 2>/dev/null; then
  echo "MongoDB: already running on 127.0.0.1:27017"
  exit 0
fi

MONGO_HOME="$HOME/mongodb7"
if [ ! -x "$MONGO_HOME/bin/mongod" ]; then
  echo "MongoDB: not found at $MONGO_HOME/bin/mongod - start your database manually." >&2
  exit 1
fi

mkdir -p "$MONGO_HOME/data" "$MONGO_HOME/log"
echo "MongoDB: starting local server..."
if "$MONGO_HOME/bin/mongod" --dbpath "$MONGO_HOME/data" --port 27017 --bind_ip 127.0.0.1 \
    --logpath "$MONGO_HOME/log/mongod.log" --logappend --fork > /dev/null; then
  echo "MongoDB: started on 127.0.0.1:27017"
else
  echo "MongoDB: failed to start - see $MONGO_HOME/log/mongod.log" >&2
  exit 1
fi
