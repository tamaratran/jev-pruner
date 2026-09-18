"""Resolve public Docker Hub tags without pulling layers or creating compute."""

import hashlib
import json
import re
from urllib.request import Request, urlopen

ACCEPT = ", ".join(
    (
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    )
)


def checked_digest(data: bytes, expected: str | None = None) -> str:
    digest = "sha256:" + hashlib.sha256(data).hexdigest()
    if expected is not None and digest != expected:
        raise ValueError("Registry content digest mismatch")
    return digest


def resolve_image(reference: str) -> dict:
    match = re.fullmatch(r"([\w.-]+/[\w.-]+):([\w.-]+)", reference)
    if not match:
        raise ValueError("This pinned dataset requires public Docker Hub image tags")
    repository, tag = match.groups()
    with urlopen(
        f"https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repository}:pull",
        timeout=30,
    ) as response:
        token = json.load(response)["token"]

    def fetch(kind: str, value: str, expected: str | None = None) -> tuple[dict, str]:
        request = Request(
            f"https://registry-1.docker.io/v2/{repository}/{kind}/{value}",
            headers={"Accept": ACCEPT, "Authorization": f"Bearer {token}"},
        )
        with urlopen(request, timeout=30) as response:
            data = response.read()
            digest = checked_digest(data, expected)
            if header := response.headers.get("Docker-Content-Digest"):
                checked_digest(data, header)
            return json.loads(data), digest

    manifest, tag_digest = fetch("manifests", tag)
    platform_digest = tag_digest
    if "manifests" in manifest:
        matches = [
            entry
            for entry in manifest["manifests"]
            if entry.get("platform", {}).get("os") == "linux"
            and entry["platform"].get("architecture") == "amd64"
            and not entry["platform"].get("variant")
        ]
        if len(matches) != 1:
            raise ValueError("Expected exactly one Linux amd64 image")
        platform_digest = matches[0]["digest"]
        manifest, _ = fetch("manifests", platform_digest, platform_digest)
    config_digest = manifest["config"]["digest"]
    config, _ = fetch("blobs", config_digest, config_digest)
    if config.get("architecture") != "amd64" or config.get("os") != "linux":
        raise ValueError("Image platform differs from Linux amd64")
    return {
        "tag": reference,
        "tag_digest": tag_digest,
        "platform_digest": platform_digest,
        "config_digest": config_digest,
        "oci_reference": f"docker.io/{repository}@{platform_digest}",
        "platform": "linux/amd64",
    }
