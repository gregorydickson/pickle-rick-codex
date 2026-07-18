# CI helper provenance

`validate_plugin.py` is an unmodified copy of the validator shipped with Codex's built-in `plugin-creator` skill. CI runs the same validator against both the source plugin and the isolated installed runtime. Update this copy from the built-in skill when Codex changes its ingestion contract; do not replace it with a weaker manifest-shape assertion.
