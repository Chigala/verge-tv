#!/usr/bin/env python3
"""Write deployment-only public runtime settings without logging their values."""

import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def load_env_file(path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip("'\"")
        if key and value and not os.environ.get(key):
            os.environ[key] = value


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: build_runtime_config.py OUTPUT_PATH")

    load_env_file(ROOT / ".env")
    # This is only the public Worker entry point. The sensitive upstream
    # trailer template belongs exclusively in a Cloudflare Worker secret.
    trailer_api = os.environ.get("TRAILER_API_URL", "").strip()
    if not trailer_api:
        sys.exit("TRAILER_API_URL is not configured")

    output = Path(sys.argv[1])
    output.parent.mkdir(parents=True, exist_ok=True)

    # Older catalogs may still contain the former embedded setting. Remove it
    # from the deployment copy without ever printing its value.
    home = output.parent / "home.json"
    if home.exists():
        catalog = json.loads(home.read_text(encoding="utf-8"))
        if "trailer" in catalog:
            del catalog["trailer"]
            home_temporary = home.with_suffix(home.suffix + ".tmp")
            home_temporary.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            home_temporary.replace(home)

    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps({"trailerApi": trailer_api}, separators=(",", ":")), encoding="utf-8")
    temporary.replace(output)
    print("wrote runtime configuration")


if __name__ == "__main__":
    main()
