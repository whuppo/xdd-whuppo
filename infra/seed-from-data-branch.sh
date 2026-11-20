#!/usr/bin/env bash
# One-time migration: copy the price history from the old `data` branch (written by the
# previous GitHub Actions setup) into the updater's S3 bucket, so the 90-day history carries over.
#
# Usage:  infra/seed-from-data-branch.sh <DataBucketName output>
# Needs git and the AWS CLI, logged in to the account that holds the stack. Safe to re-run.
set -euo pipefail

bucket=${1:?usage: $0 <bucket-name>}
work=$(mktemp -d)
trap 'git worktree remove --force "$work/data" 2>/dev/null || true; rm -rf "$work"' EXIT

git fetch --depth 1 origin data
git worktree add --detach "$work/data" FETCH_HEAD
aws s3 sync "$work/data" "s3://$bucket/data/" \
  --exclude ".git" --exclude ".git/*" \
  --content-type application/json --cache-control "public, max-age=60"
echo "Seeded s3://$bucket/data/ from the data branch."
