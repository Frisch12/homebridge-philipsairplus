#!/usr/bin/env python3
"""
One-shot `/sys/dev/info` query for a Philips NEW2 device.

Used by the homebridge plugin for auto-detection. Unlike status / observe,
the info endpoint is a plain CoAP GET that the device always answers,
making it a reliable way to obtain device_id, modelid and name without
having to wait for a state change.

Prints a single JSON object to stdout on success, exits non-zero on
failure with a short error on stderr.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys


async def fetch_info(host: str, port: int) -> dict:
    try:
        from phipsair.coap.client import Client  # type: ignore
    except Exception as exc:  # pragma: no cover
        sys.stderr.write(f"phipsair import failed: {exc}\n")
        sys.exit(2)

    client = await Client.create(host=host, port=port)
    try:
        return await asyncio.wait_for(client.info(), timeout=10)
    finally:
        try:
            await client.shutdown()
        except Exception:
            pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=5683)
    args = ap.parse_args()

    try:
        info = asyncio.run(fetch_info(args.host, args.port))
    except asyncio.TimeoutError:
        sys.stderr.write("info request timed out\n")
        return 3
    except Exception as exc:
        sys.stderr.write(f"info request failed: {exc}\n")
        return 4

    json.dump(info, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
