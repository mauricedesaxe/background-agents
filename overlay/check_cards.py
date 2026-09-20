from __future__ import annotations

import re
import sys
from pathlib import Path


CARD_DIR = Path(__file__).parent / "cards"
REQUIRED_KEYS = {"id", "title", "type", "priority", "placement", "depends_on", "origin"}
OPTIONAL_KEYS = {"migrations"}
ALLOWED_TYPES = {"rebuild", "config-verify", "runbook-step"}
ALLOWED_PRIORITIES = {"high", "medium", "low"}
ALLOWED_PLACEMENTS = {
    "ci-config",
    "deployment-config",
    "managed-skills",
    "plan-time-guard",
    "runbook",
    "sandbox-image",
    "snapshot",
    "upstream-code",
    "upstream-doc",
}
REQUIRED_HEADINGS = ["Outcome", "Observable behavior", "Durable constraints"]


def parse_frontmatter(path: Path, text: str) -> tuple[dict[str, object], str]:
    if not text.startswith("---\n"):
        raise ValueError("missing frontmatter")
    frontmatter, separator, body = text[4:].partition("\n---\n")
    if not separator:
        raise ValueError("unterminated frontmatter")

    values: dict[str, object] = {}
    for line in frontmatter.splitlines():
        key, separator, raw_value = line.partition(":")
        if not separator:
            raise ValueError(f"invalid frontmatter line: {line}")
        if key in values:
            raise ValueError(f"duplicate metadata key: {key}")
        value = raw_value.strip()
        if value.startswith("["):
            if not value.endswith("]"):
                raise ValueError(f"invalid list: {line}")
            items = [item.strip().strip("'\"") for item in value[1:-1].split(",")]
            values[key] = [int(item) if item.isdigit() else item for item in items if item]
        else:
            values[key] = value
    return values, body


def check_card(path: Path, active_ids: set[str]) -> list[str]:
    errors: list[str] = []
    try:
        metadata, body = parse_frontmatter(path, path.read_text())
    except (SyntaxError, ValueError) as error:
        return [f"{path}: {error}"]

    card_id = metadata.get("id")
    if card_id != path.stem:
        errors.append(f"{path}: id must match filename")
    if not isinstance(card_id, str) or not re.fullmatch(
        r"\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*", card_id
    ):
        errors.append(f"{path}: id must use the NN-kebab-case form")

    keys = set(metadata)
    if missing := REQUIRED_KEYS - keys:
        errors.append(f"{path}: missing metadata: {', '.join(sorted(missing))}")
    if extra := keys - REQUIRED_KEYS - OPTIONAL_KEYS:
        errors.append(f"{path}: unsupported metadata: {', '.join(sorted(extra))}")
    for key in REQUIRED_KEYS - {"depends_on"}:
        if metadata.get(key) == "":
            errors.append(f"{path}: {key} must not be empty")

    if metadata.get("type") not in ALLOWED_TYPES:
        errors.append(f"{path}: unsupported type {metadata.get('type')!r}")
    if metadata.get("priority") not in ALLOWED_PRIORITIES:
        errors.append(f"{path}: unsupported priority {metadata.get('priority')!r}")
    if metadata.get("placement") not in ALLOWED_PLACEMENTS:
        errors.append(f"{path}: unsupported placement {metadata.get('placement')!r}")

    dependencies = metadata.get("depends_on")
    if not isinstance(dependencies, list):
        errors.append(f"{path}: depends_on must be a one-line list")
    else:
        if len(dependencies) != len(set(dependencies)):
            errors.append(f"{path}: dependencies must be unique")
        for dependency in dependencies:
            if not isinstance(dependency, str):
                errors.append(f"{path}: dependencies must be card IDs")
                continue
            if dependency == card_id:
                errors.append(f"{path}: a card cannot depend on itself")
            if dependency not in active_ids:
                errors.append(f"{path}: dependency {dependency!r} is not an active card")

    migrations = metadata.get("migrations", [])
    if not isinstance(migrations, list) or any(
        not isinstance(migration, int) or migration < 9000 for migration in migrations
    ):
        errors.append(f"{path}: migrations must be a one-line list of IDs at or above 9000")
    elif len(migrations) != len(set(migrations)):
        errors.append(f"{path}: migrations must be unique")

    headings = re.findall(r"^## (.+)$", body, flags=re.MULTILINE)
    if headings != REQUIRED_HEADINGS:
        errors.append(f"{path}: headings must be {REQUIRED_HEADINGS!r}")
    else:
        sections = re.split(r"^## .+$", body, flags=re.MULTILINE)[1:]
        for heading, section in zip(REQUIRED_HEADINGS, sections, strict=True):
            if not section.strip():
                errors.append(f"{path}: {heading} must not be empty")

    return errors


def check_dependency_cycles(paths: list[Path]) -> list[str]:
    dependencies = {
        path.stem: parse_frontmatter(path, path.read_text())[0].get("depends_on", [])
        for path in paths
    }
    visited: set[str] = set()
    visiting: set[str] = set()

    def visit(card_id: str) -> str | None:
        if card_id in visiting:
            return card_id
        if card_id in visited:
            return None
        visiting.add(card_id)
        for dependency in dependencies.get(card_id, []):
            if dependency in dependencies and (cycle := visit(dependency)):
                return cycle
        visiting.remove(card_id)
        visited.add(card_id)
        return None

    for card_id in dependencies:
        if cycle := visit(card_id):
            return [f"{CARD_DIR}: dependency cycle includes {cycle}"]
    return []


def check_migration_ids(paths: list[Path]) -> list[str]:
    owners: dict[int, str] = {}
    errors: list[str] = []
    for path in paths:
        metadata, _ = parse_frontmatter(path, path.read_text())
        for migration in metadata.get("migrations", []):
            if owner := owners.get(migration):
                errors.append(
                    f"{path}: migration {migration} is already owned by {owner}"
                )
            else:
                owners[migration] = path.stem
    return errors


def main() -> int:
    paths = sorted(CARD_DIR.glob("*.md"))
    if not paths:
        print(f"{CARD_DIR}: no overlay cards found", file=sys.stderr)
        return 1
    active_ids = {path.stem for path in paths}
    errors = [error for path in paths for error in check_card(path, active_ids)]
    if not errors:
        errors.extend(check_dependency_cycles(paths))
        errors.extend(check_migration_ids(paths))
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Validated {len(paths)} overlay cards.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
