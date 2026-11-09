"""A secondary profile may only turn its OWN files (and explicitly shared folders) into model input.

The multiplexed gateway reads media off the owner's filesystem, so a path the process can open is
not a path the profile is entitled to. These tests pin the confinement in tools/image_source.py.

The module is imported inside each test: other suites reload ``tools.image_source``, and a
module-level import would then hold a stale ``SourceUnsafe`` class identity.
"""
import asyncio
import tempfile
from pathlib import Path

import pytest

from hermes_constants import reset_hermes_home_override, set_hermes_home_override

# 1x1 transparent PNG — real bytes so the resolver's magic-byte sniff accepts it.
PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00"
       b"\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4"
       b"\x00\x00\x00\x00IEND\xaeB`\x82")


@pytest.fixture
def scoped(tmp_path, monkeypatch):
    """Owner home + a secondary profile home with one shared folder."""
    owner = tmp_path / "owner-home"
    secondary = tmp_path / "secondary-home"
    shared = tmp_path / "shared-with-secondary"
    outside = tmp_path / "owner-private"
    for d in (owner, secondary, shared, outside):
        d.mkdir()
        (d / "pic.png").write_bytes(PNG)
    (secondary / "config.yaml").write_text(
        "terminal:\n  docker_volumes:\n"
        f"    - {shared}:/workspace:rw\n")
    # get_hermes_home() is the LAUNCH home (owner); the override is the served profile.
    monkeypatch.setattr("hermes_constants.get_process_hermes_home", lambda: owner, raising=False)
    token = set_hermes_home_override(secondary)
    try:
        yield {"owner": owner, "secondary": secondary, "shared": shared, "outside": outside}
    finally:
        reset_hermes_home_override(token)


def _resolve(path: Path):
    from tools import image_source as isrc
    return asyncio.run(isrc.resolve_image_source(str(path), isrc.ResolveContext()))


def test_owner_profile_is_unconfined(tmp_path):
    """No override (the owner serving its own turns) keeps full access."""
    from tools import image_source as isrc
    (tmp_path / "pic.png").write_bytes(PNG)
    assert isrc._profile_media_roots() is None
    assert isrc._profile_media_confine_error(tmp_path / "pic.png") is None
    assert _resolve(tmp_path / "pic.png").origin == "file"


def test_secondary_reads_its_own_home(scoped):
    assert _resolve(scoped["secondary"] / "pic.png").origin == "file"


def test_secondary_reads_explicitly_shared_folder(scoped):
    assert _resolve(scoped["shared"] / "pic.png").origin == "file"


def test_secondary_cannot_read_owner_files(scoped):
    from tools import image_source as isrc
    with pytest.raises(isrc.SourceUnsafe) as exc:
        _resolve(scoped["outside"] / "pic.png")
    assert "outside this profile's allowed roots" in str(exc.value)


def test_secondary_cannot_escape_via_symlink(scoped):
    from tools import image_source as isrc
    link = scoped["secondary"] / "innocent.png"
    link.symlink_to(scoped["outside"] / "pic.png")
    with pytest.raises(isrc.SourceUnsafe):
        _resolve(link)


def test_secondary_cannot_read_owner_media_cache(scoped):
    from tools import image_source as isrc
    cache = scoped["owner"] / "cache" / "images"
    cache.mkdir(parents=True)
    (cache / "leak.png").write_bytes(PNG)
    assert isrc._profile_media_confine_error(cache / "leak.png") is not None
    with pytest.raises(isrc.SourceUnsafe):
        _resolve(cache / "leak.png")


def test_video_materialize_is_confined(scoped):
    """video_analyze's local-file branch passes through the same guard."""
    from tools import vision_tools

    vid = scoped["outside"] / "clip.mp4"
    vid.write_bytes(b"\x00\x00\x00\x18ftypmp42")
    temp_paths: list = []
    with pytest.raises(PermissionError):
        asyncio.run(vision_tools._materialize_video(str(vid), None, temp_paths))
    assert temp_paths == []


def test_present_override_always_confines(tmp_path, monkeypatch):
    """A served profile is confined even when its home has no config yet."""
    from tools import image_source as isrc
    home = tmp_path / "h"
    home.mkdir()
    monkeypatch.setattr("hermes_constants.get_process_hermes_home", lambda: tmp_path / "owner", raising=False)
    token = set_hermes_home_override(home)
    try:
        roots = isrc._profile_media_roots()
        assert roots is not None
        assert any(r.resolve() == home.resolve() for r in roots)
    finally:
        reset_hermes_home_override(token)
