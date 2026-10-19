"""Keep credential/state artifacts outside Git worktrees and the Nix store."""

from pathlib import Path


def _git_worktree(directory: Path) -> bool:
    marker = directory / ".git"
    if marker.is_file():
        try:
            reference = marker.read_text().strip()
        except OSError:
            return True
        if not reference.startswith("gitdir:"):
            return False
        marker = directory / reference.removeprefix("gitdir:").strip()
    return (marker / "HEAD").is_file()


def require_private_path(path: Path) -> None:
    resolved = path.resolve()
    if resolved.is_relative_to(Path("/nix/store")) or any(
        _git_worktree(parent) for parent in [resolved, *resolved.parents]
    ):
        raise ValueError("private files must stay outside Git and the Nix store")
