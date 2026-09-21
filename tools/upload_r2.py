"""Upload the audio to the Cloudflare R2 bucket norsk-app (S3-compatible API).

Layout in the bucket (same as the local audio/ folder):
  <voice>/w/<slug>.mp3      words and forms
  <voice>/s100 … s055/<id>.mp3  sentences at 100 / 85 / 70 / 55 %
  <voice>/verb/<id>.mp3     verb drills (French then Norwegian)

Credentials are read from ../../.norsk-keys.env (outside the repository):
  R2_ACCOUNT=…  R2_KEY=…  R2_SECRET=…
Only files missing in the bucket (or with a different size) are sent, so the script can be re-run.
Usage: python upload_r2.py [--test]
"""
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import boto3
from botocore.config import Config

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT.parent.parent / ".norsk-keys.env"
if not ENV.exists():                     # former name
    ENV = ROOT.parent.parent / ".norsk-r2.env"
BUCKET = "norsk-app"
# local folder -> sub-folders sent from it
SOURCES = [(ROOT / "audio", ("w", "s100", "s085", "s070", "s055", "verb"))]
VOICES = ("pernille", "finn")


def client():
    env = dict(line.strip().split("=", 1) for line in ENV.read_text(encoding="utf-8").splitlines() if "=" in line)
    return boto3.client("s3", endpoint_url=f"https://{env['R2_ACCOUNT']}.r2.cloudflarestorage.com",
                        aws_access_key_id=env["R2_KEY"], aws_secret_access_key=env["R2_SECRET"],
                        region_name="auto", config=Config(retries={"max_attempts": 8, "mode": "adaptive"},
                                                          max_pool_connections=32))


def local_files():
    for base, dirs in SOURCES:
        for v in VOICES:
            for d in dirs:
                for f in (base / v / d).glob("*.mp3"):
                    yield f"{v}/{d}/{f.name}", f


def remote_sizes(s3):
    sizes, token = {}, None
    while True:
        kw = {"Bucket": BUCKET, "MaxKeys": 1000}
        if token:
            kw["ContinuationToken"] = token
        r = s3.list_objects_v2(**kw)
        for o in r.get("Contents", []):
            sizes[o["Key"]] = o["Size"]
        if not r.get("IsTruncated"):
            return sizes
        token = r["NextContinuationToken"]


def main():
    s3 = client()
    files = list(local_files())
    if "--test" in sys.argv:
        files = files[:1]
    remote = remote_sizes(s3)
    todo = [(k, f) for k, f in files if remote.get(k) != f.stat().st_size]
    print(f"{len(files)} local files, {len(remote)} already in the bucket, {len(todo)} to send", flush=True)
    done, failed = 0, []

    def send(key, path):
        s3.upload_file(str(path), BUCKET, key, ExtraArgs={"ContentType": "audio/mpeg",
                                                          "CacheControl": "public, max-age=31536000"})
    with ThreadPoolExecutor(max_workers=24) as pool:
        futs = {pool.submit(send, k, f): k for k, f in todo}
        for fut in as_completed(futs):
            try:
                fut.result()
                done += 1
            except Exception as e:
                failed.append(f"{futs[fut]}: {e}")
            if done % 2000 == 0 and done:
                print(f"  {done}/{len(todo)}", flush=True)
    print(f"sent {done}, failed {len(failed)}")
    for f in failed[:20]:
        print("  FAIL", f)


if __name__ == "__main__":
    main()
