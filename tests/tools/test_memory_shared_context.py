"""Shared-memory contract for Jagan's profiles.

A non-isolated profile may inherit the default profile's curated memory as a
READ-ONLY base. Its own MEMORY.md / USER.md remain the only writable store, so
profile-specific facts survive and a profile can never mutate the shared base.
`harshitha` and `sandbox` must resolve to their own store even if a config tries
to set `memory.shared_home`.
"""

from pathlib import Path

import pytest

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from tools.memory_tool import get_shared_memory_dir
from tools.memory_tool_store import ENTRY_DELIMITER, MemoryStore

JAGAN_PROFILES = (
    "briefing",
    "content",
    "deals",
    "email",
    "finance",
    "india",
    "jobhunt",
    "research",
    "wellness",
    "work",
)
ISOLATED_PROFILES = ("harshitha", "sandbox")


def _write_entries(directory: Path, filename: str, entries: tuple[str, ...]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / filename).write_text(ENTRY_DELIMITER.join(entries), encoding="utf-8")


def _store_with_dirs(monkeypatch, local_dir: Path, shared_dir: Path | None) -> MemoryStore:
    local_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr("tools.memory_tool.get_memory_dir", lambda: local_dir)
    monkeypatch.setattr("tools.memory_tool.get_shared_memory_dir", lambda: shared_dir)
    store = MemoryStore(memory_char_limit=4500, user_char_limit=2500)
    store.load_from_disk()
    return store


def _write_home(root: Path, name: str | None, shared_home: str = "") -> Path:
    home = root if name is None else root / "profiles" / name
    (home / "memories").mkdir(parents=True, exist_ok=True)
    # Raw YAML: the test environment intentionally carries no PyYAML dependency.
    (home / "config.yaml").write_text(
        f"_config_version: 52\nmemory:\n  shared_home: {shared_home!r}\n", encoding="utf-8")
    return home


class TestMemoryStoreSharedBase:
    def test_jagan_profile_reads_shared_default_and_keeps_local(self, tmp_path, monkeypatch):
        local = tmp_path / "work" / "memories"
        shared = tmp_path / "default" / "memories"
        _write_entries(local, "MEMORY.md", ("work local fact",))
        _write_entries(local, "USER.md", ("work local user fact",))
        _write_entries(shared, "MEMORY.md", ("default shared fact",))
        _write_entries(shared, "USER.md", ("default shared user fact",))

        store = _store_with_dirs(monkeypatch, local, shared)

        assert store.shared_entries("memory") == ["default shared fact"]
        assert store.shared_entries("user") == ["default shared user fact"]
        assert store.memory_entries == ["work local fact"]
        assert store.user_entries == ["work local user fact"]

        prompt = store.format_for_system_prompt("memory") or ""
        assert "default shared fact" in prompt
        assert "work local fact" in prompt
        assert "shared read-only" in prompt

    def test_profile_writes_stay_local_and_never_mutate_shared(self, tmp_path, monkeypatch):
        local = tmp_path / "work" / "memories"
        shared = tmp_path / "default" / "memories"
        _write_entries(local, "MEMORY.md", ("local before",))
        _write_entries(shared, "MEMORY.md", ("default shared fact",))

        store = _store_with_dirs(monkeypatch, local, shared)
        result = store.add("memory", "local after")

        assert result["success"] is True
        assert "local after" in (local / "MEMORY.md").read_text(encoding="utf-8")
        assert "local after" not in (shared / "MEMORY.md").read_text(encoding="utf-8")
        assert (shared / "MEMORY.md").read_text(encoding="utf-8") == "default shared fact"

    def test_shared_entries_are_read_only_to_the_profile(self, tmp_path, monkeypatch):
        local = tmp_path / "work" / "memories"
        shared = tmp_path / "default" / "memories"
        _write_entries(local, "MEMORY.md", ("local fact",))
        _write_entries(shared, "MEMORY.md", ("default shared fact",))

        store = _store_with_dirs(monkeypatch, local, shared)

        patch_result = store.patch("memory", old_text="default shared fact", new_text="hacked")
        remove_result = store.remove("memory", old_text="default shared fact")

        assert patch_result["success"] is False
        assert remove_result["success"] is False
        assert (shared / "MEMORY.md").read_text(encoding="utf-8") == "default shared fact"

    def test_profile_without_shared_base_reads_only_local(self, tmp_path, monkeypatch):
        local = tmp_path / "solo" / "memories"
        _write_entries(local, "MEMORY.md", ("solo fact",))

        store = _store_with_dirs(monkeypatch, local, None)

        assert store.shared_entries("memory") == []
        prompt = store.format_for_system_prompt("memory") or ""
        assert "solo fact" in prompt
        assert "shared read-only" not in prompt

    def test_store_never_reads_an_isolated_profile_directory(self, tmp_path, monkeypatch):
        local = tmp_path / "work" / "memories"
        shared = tmp_path / "default" / "memories"
        isolated = tmp_path / "profiles" / "harshitha" / "memories"
        _write_entries(local, "MEMORY.md", ("work fact",))
        _write_entries(shared, "MEMORY.md", ("default fact",))
        _write_entries(isolated, "MEMORY.md", ("harshitha secret",))

        store = _store_with_dirs(monkeypatch, local, shared)
        prompt = store.format_for_system_prompt("memory") or ""

        assert "default fact" in prompt
        assert "harshitha secret" not in prompt
        assert store.shared_entries("memory") == ["default fact"]


class TestSharedMemoryResolution:
    @pytest.mark.parametrize("profile", JAGAN_PROFILES)
    def test_jagan_profiles_resolve_to_default_memories(self, tmp_path, profile):
        root = tmp_path / "default"
        _write_home(root, None)
        home = _write_home(root, profile, shared_home=str(root))
        token = set_hermes_home_override(home)
        try:
            assert get_shared_memory_dir() == root / "memories"
        finally:
            reset_hermes_home_override(token)

    @pytest.mark.parametrize("profile", ISOLATED_PROFILES)
    def test_isolated_profiles_ignore_shared_home(self, tmp_path, profile):
        root = tmp_path / "default"
        _write_home(root, None)
        home = _write_home(root, profile, shared_home=str(root))
        token = set_hermes_home_override(home)
        try:
            assert get_shared_memory_dir() is None
        finally:
            reset_hermes_home_override(token)

    def test_default_profile_has_no_shared_base(self, tmp_path):
        root = tmp_path / "default"
        home = _write_home(root, None)
        token = set_hermes_home_override(home)
        try:
            assert get_shared_memory_dir() is None
        finally:
            reset_hermes_home_override(token)

    def test_shared_home_equal_to_own_home_is_ignored(self, tmp_path):
        root = tmp_path / "default"
        home = _write_home(root, "work", shared_home=str(tmp_path / "default" / "profiles" / "work"))
        token = set_hermes_home_override(home)
        try:
            assert get_shared_memory_dir() is None
        finally:
            reset_hermes_home_override(token)

    def test_empty_shared_home_means_local_only(self, tmp_path):
        root = tmp_path / "default"
        home = _write_home(root, "work", shared_home="")
        token = set_hermes_home_override(home)
        try:
            assert get_shared_memory_dir() is None
        finally:
            reset_hermes_home_override(token)

    def test_jagan_profile_cannot_point_shared_home_at_isolated_profile(self, tmp_path):
        root = tmp_path / "default"
        _write_home(root, None)
        home = _write_home(root, "work", shared_home=str(root / "profiles" / "harshitha"))
        token = set_hermes_home_override(home)
        try:
            assert get_shared_memory_dir() is None
        finally:
            reset_hermes_home_override(token)
