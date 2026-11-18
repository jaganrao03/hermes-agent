"""Value checks for single config sections (voice, timezone, web backends), run by
``hermes_cli.config.validate_config_structure`` for doctor and the startup warnings."""

from typing import Any

from hermes_cli.config_issues import ConfigIssue, _issue


def _validate_voice(config: dict[str, Any], issues: list[ConfigIssue]) -> None:
    voice_cfg = config.get("voice")
    if not (isinstance(voice_cfg, dict) and "submit_mode" in voice_cfg):
        return
    submit_mode = voice_cfg.get("submit_mode")
    normalized = submit_mode.strip().lower() if isinstance(submit_mode, str) else None
    if normalized not in {"direct", "draft"}:
        _issue(issues, "error", f"voice.submit_mode must be 'direct' or 'draft', got {submit_mode!r}",
               "Set voice.submit_mode to direct (submit immediately) or draft (edit before sending)")


def _validate_timezone(config: dict[str, Any], issues: list[ConfigIssue]) -> None:
    """``timezone`` must be an IANA name the runtime can load.

    ``hermes_time._get_zoneinfo()`` swallows an invalid name behind a single WARNING in the
    gateway log, then runs the agent clock AND every cron schedule on server-local time.
    Surface it here, where doctor and the startup check both look. Silent when the
    interpreter has no tz database at all (bare Windows without ``tzdata``) — nothing can be
    judged there.
    """
    if "timezone" not in config:
        return
    tz = config.get("timezone")
    hint = ("Use an IANA zone name such as America/New_York or Asia/Tokyo (see "
            "`timedatectl list-timezones`). With an invalid value the agent clock and cron "
            "schedules silently fall back to server-local time. HERMES_TIMEZONE overrides "
            "this key when set.")
    if tz is not None and not isinstance(tz, str):
        _issue(issues, "error", f"timezone must be an IANA zone name string, got {tz!r}", hint)
        return
    if not (isinstance(tz, str) and tz.strip()):
        return
    name = tz.strip()
    try:
        import zoneinfo
        zoneinfo.ZoneInfo("UTC")  # is a tz database available at all?
    except Exception:
        return
    try:
        zoneinfo.ZoneInfo(name)
    except Exception:
        _issue(issues, "error", f"timezone {name!r} is not a valid IANA zone name", hint)


def _validate_web_backends(config: dict[str, Any], issues: list[ConfigIssue]) -> None:
    """A stale web backend selection otherwise fails only at the first web_search/web_extract
    call with a generic "no registered provider" error; warn at startup instead."""
    # See #99199.
    web_cfg = config.get("web")
    if not isinstance(web_cfg, dict):
        return
    try:
        from tools.tool_backend_helpers import removed_backend_note
    except Exception:
        return
    seen: set = set()
    for _key in ("backend", "search_backend", "extract_backend"):
        _val = str(web_cfg.get(_key) or "").strip().lower()
        if not _val or _val in seen:
            continue
        seen.add(_val)
        note = removed_backend_note("web", _val)
        if note:
            _issue(issues, "warning",
                   f"web.{_key} is set to '{_val}', but {note} — "
                   "web_search/web_extract will fail until it is changed",
                   "Run 'hermes tools' and pick a different Web Search & Extract provider")


def _container_slots() -> dict[str, str]:
    """Dotted key -> ``"list"``/``"mapping"`` for every slot the schema fixes to a container:
    ``DEFAULT_CONFIG`` (sections included) plus the known-container table for roots it omits."""
    from hermes_cli.config import _KNOWN_CONTAINER_TYPES, DEFAULT_CONFIG  # late: the facade imports this module
    slots: dict[str, str] = {}

    def walk(node: dict[str, Any], prefix: str) -> None:
        for key, value in node.items():
            path = f"{prefix}.{key}" if prefix else key
            if isinstance(value, dict):
                slots[path] = "mapping"
                walk(value, path)
            elif isinstance(value, list):
                slots[path] = "list"

    walk(DEFAULT_CONFIG, "")
    slots.update(_KNOWN_CONTAINER_TYPES)
    return slots


def _validate_quoted_containers(config: dict[str, Any], issues: list[ConfigIssue]) -> None:
    """A container slot holding ONE quoted string (``enabled: '["a","b"]'``) is skipped by every
    isinstance-gated reader while ``config get`` echoes it back, so plugins silently unmount and
    exclusions silently lapse (#83308, #105706). Finding only — the file is never rewritten."""
    import shlex

    import hermes_yaml as yaml
    from hermes_cli.config import _SCALAR_AS_ONE_ITEM_LIST_KEYS, _looks_structured_value, cfg_get
    for key, kind in _container_slots().items():
        # ``parse_config_string_list`` readers accept the quoted form; nothing is ignored there.
        if key in _SCALAR_AS_ONE_ITEM_LIST_KEYS:
            continue
        value = cfg_get(config, *key.split("."))
        if not isinstance(value, str) or not _looks_structured_value(value):
            continue
        try:
            parsed = yaml.safe_load(value)
        except yaml.YAMLError:
            continue
        if isinstance(parsed, (list, dict)):
            _issue(issues, "warning",
                   f"{key} is the quoted string {value!r} — Hermes expects a YAML {kind} here "
                   "and every reader ignores the string",
                   f"Run: hermes config set {key} {shlex.quote(value)}  (stores a real {kind}), "
                   "or remove the quotes in config.yaml")


def _model_provider_pairs(config: dict[str, Any]) -> list[tuple[str, Any, Any]]:
    """Every ``(where, provider, model)`` pair config asks Hermes to send, in resolution order."""
    pairs: list[tuple[str, Any, Any]] = []
    model_cfg = config.get("model")
    if isinstance(model_cfg, dict):
        pairs.append(("model.default", model_cfg.get("provider"), model_cfg.get("default")))
    for key in ("fallback_providers", "fallback_model"):
        entries = config.get(key)
        if isinstance(entries, dict):
            entries = [entries]
        if not isinstance(entries, list):
            continue
        for index, entry in enumerate(entries):
            if isinstance(entry, dict):
                pairs.append((f"{key}[{index}]", entry.get("provider"), entry.get("model")))
    return pairs


def _single_vendor(provider: str) -> str | None:
    """The one vendor a first-party provider natively serves, or None when it is not single-vendor.

    Aggregators (``nous``, ``openrouter``) and custom/local endpoints re-expose several vendors or
    none, so no pair against them can be called wrong; ``None`` skips them.
    """
    from hermes_cli.model_normalize import detect_vendor
    from hermes_cli.models import _PROVIDER_MODELS, normalize_provider

    vendors = {detect_vendor(mid) for mid in _PROVIDER_MODELS.get(normalize_provider(provider), ())}
    vendors.discard(None)
    return next(iter(vendors)) if len(vendors) == 1 else None


def _validate_model_provider_pairs(config: dict[str, Any], issues: list[ConfigIssue]) -> None:
    """Reject a provider/model pair no endpoint can serve (``openai-codex`` + ``claude-sonnet-5``).

    Such a pair is not a typo Hermes recovers from: the request goes to the named provider's
    endpoint, which answers 401/429 for a model it does not host, and the resulting fallback notice
    names a route that never existed — so one provider's quota error reads like another's outage.

    Only provable mismatches are flagged, from shipped catalog data alone (no credentials, no
    network): the provider must natively serve exactly one vendor and the model must classify to a
    different one. An id the classifier cannot place, a pair inside the provider's own catalog, and
    any aggregator / custom / local route all stay silent.
    """
    from hermes_cli.model_normalize import detect_vendor

    for where, provider, model in _model_provider_pairs(config):
        if not (isinstance(provider, str) and provider.strip()):
            continue
        if not (isinstance(model, str) and model.strip()):
            continue
        vendor = detect_vendor(model.strip())
        if not vendor or not (native := _single_vendor(provider.strip())):
            continue
        if vendor == native:
            continue
        _issue(issues, "error",
               f"{where}: model '{model.strip()}' is served by the {vendor} vendor, but provider "
               f"'{provider.strip()}' only serves {native} — the request goes to an endpoint that "
               "cannot serve it",
               f"Set provider to a {vendor} provider for '{model.strip()}', or use a {native} model "
               f"with '{provider.strip()}'. Left as-is, the first request 401/429s and the fallback "
               "notice names a route that never existed.")

