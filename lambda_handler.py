"""AWS Lambda entry point for the data updater (deployed by .github/workflows/deploy-updater.yml).

Lambda has no persistent disk, so each run:
  1. mirrors s3://$DATA_BUCKET/$DATA_PREFIX into /tmp,
  2. runs the same fetchers server.py runs locally (update_data.update_all),
  3. uploads files that changed and deletes files the fetchers pruned.

Event: {} runs every tool; {"tools": ["essences"]} runs only those.
Env:   DATA_BUCKET (required), DATA_PREFIX (default "data/").

boto3 ships with the Lambda Python runtime, so the deploy zip is just this file and update_data.py.
"""

import hashlib
import mimetypes
import os
import shutil
from concurrent.futures import ThreadPoolExecutor

import boto3

import update_data

BUCKET = os.environ.get("DATA_BUCKET", "")
PREFIX = os.environ.get("DATA_PREFIX", "data/")
WORK = "/tmp/data"
# Pages fetch with cache: "no-cache", so browsers always revalidate; this only bounds CloudFront's copy.
CACHE_CONTROL = "public, max-age=60"
THREADS = 16

s3 = boto3.client("s3")


def md5(path):
    with open(path, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def list_remote():
    """{relative path: ETag} for every object under PREFIX."""
    remote = {}
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=PREFIX):
        for obj in page.get("Contents", []):
            rel = obj["Key"][len(PREFIX):]
            if rel and not rel.endswith("/"):
                remote[rel] = obj["ETag"].strip('"')
    return remote


def local_path(rel):
    path = os.path.normpath(os.path.join(WORK, rel))
    if not path.startswith(WORK + os.sep):
        raise ValueError(f"refusing to write outside {WORK}: {rel!r}")
    return path


def download(remote):
    shutil.rmtree(WORK, ignore_errors=True)  # warm containers keep /tmp between runs
    os.makedirs(WORK)

    def fetch(rel):
        dest = local_path(rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        s3.download_file(BUCKET, PREFIX + rel, dest)

    with ThreadPoolExecutor(THREADS) as pool:
        list(pool.map(fetch, remote))


def list_local():
    files = {}
    for root, _, names in os.walk(WORK):
        for name in names:
            if name.endswith(".tmp"):  # leftovers from an interrupted write_json
                continue
            path = os.path.join(root, name)
            files[os.path.relpath(path, WORK).replace(os.sep, "/")] = path
    return files


def upload(remote):
    """Push changed files and delete pruned ones. Returns (uploaded, deleted)."""
    local = list_local()
    # Single-part uploads with SSE-S3 have ETag == MD5, so unchanged files are skipped.
    changed = [rel for rel, path in local.items() if remote.get(rel) != md5(path)]
    gone = [rel for rel in remote if rel not in local]

    def put(rel):
        content_type = mimetypes.guess_type(rel)[0] or "application/octet-stream"
        s3.upload_file(local[rel], BUCKET, PREFIX + rel,
                       ExtraArgs={"ContentType": content_type, "CacheControl": CACHE_CONTROL})

    with ThreadPoolExecutor(THREADS) as pool:
        list(pool.map(put, changed))
    for i in range(0, len(gone), 1000):
        s3.delete_objects(Bucket=BUCKET, Delete={
            "Objects": [{"Key": PREFIX + rel} for rel in gone[i:i + 1000]], "Quiet": True})
    return len(changed), len(gone)


def handler(event, context):
    if not BUCKET:
        raise RuntimeError("DATA_BUCKET is not set")
    tools = (event or {}).get("tools")
    remote = list_remote()
    download(remote)
    print(f"downloaded {len(remote)} files")
    failed = update_data.update_all(WORK, tools=tools, log=print)
    # Upload even after partial failures: tools that worked should still publish.
    uploaded, deleted = upload(remote)
    print(f"uploaded {uploaded}, deleted {deleted}")
    if failed:
        # Fail the invocation so it shows up in the Lambda Errors metric (and the alarm).
        raise RuntimeError(f"{failed} update(s) failed; see the log above")
    return {"uploaded": uploaded, "deleted": deleted}
