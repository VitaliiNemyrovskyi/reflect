#!/bin/sh
# Container entrypoint: apply the schema, then start the API.
#
# `prisma db push --accept-data-loss` happily DROPS columns/tables, but it
# refuses to ADD a required column (no default) to a table that already has
# rows — it demands `--force-reset`, which would wipe the ENTIRE database
# (users, sessions, characters, everything). We never do that.
#
# The courses feature moved from a flat SkillPath → Step layout to a real
# Course → Module → Step hierarchy, which adds the required
# `SkillPathStep.moduleId` column. The legacy course tables hold only
# regenerated seed content + nascent (pre-launch) progress, so the safe fix is
# a ONE-TIME drop of just those four tables. `db push` then recreates them in
# the new shape and CoursesService re-seeds them on boot.
#
# A marker on the persistent /data volume makes this run exactly once across
# both API replicas — never again, so real course progress is safe afterwards.
set -e

SCHEMA="prisma/schema.prisma"
MARKER="/data/.courses_v2_migrated"

if [ ! -f "$MARKER" ]; then
  echo "[entrypoint] courses v2 migration: dropping legacy course tables (one-time)…"
  if printf '%s\n' \
      'DROP TABLE IF EXISTS "UserStepCompletion";' \
      'DROP TABLE IF EXISTS "SkillPathStep";' \
      'DROP TABLE IF EXISTS "SkillPathModule";' \
      'DROP TABLE IF EXISTS "SkillPath";' \
      | npx prisma db execute --stdin --schema "$SCHEMA"; then
    touch "$MARKER"
    echo "[entrypoint] legacy course tables dropped; marker written."
  else
    echo "[entrypoint] legacy drop failed — will retry on next boot." >&2
  fi
fi

npx prisma db push --skip-generate --accept-data-loss
exec node dist/main.js
