"""Feed metadata every index entry carries, owned by one module.

The marketplace index is the host's only description of a package before it is
installed. Some of that description belongs to the repository as a whole rather
than to a single package — where the project lives — so the two builders read it
from here instead of each repeating it.

Only the index carries these values. They never enter a package manifest: the
host validates manifests strictly, so a manifest field an older host does not
know would make the whole package invalid there.
"""

from urllib.parse import urlsplit

# Where this repository lives. The marketplace detail page shows it and opens
# it in the user's browser, so it must be the repository root rather than one
# package's directory: a reader wants the sources, the issues and the release
# notes in one place.
REPOSITORY = "https://github.com/zhang152603/mypaste-code-extensions"

# The host refuses an entry whose address is longer than this.
MAX_REPOSITORY = 300


def repository() -> str:
    """Return the project address every index entry declares.

    The host rejects the whole feed over one malformed address, so the value is
    checked here as well: a typo should fail the build, not the marketplace.
    """
    if len(REPOSITORY) > MAX_REPOSITORY:
        raise ValueError(f"repository address is too long: {REPOSITORY}")
    parsed = urlsplit(REPOSITORY)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError(f"repository address must be https: {REPOSITORY}")
    if parsed.username or parsed.password:
        raise ValueError(f"repository address must not carry credentials: {REPOSITORY}")
    if parsed.query or parsed.fragment:
        raise ValueError(f"repository address must not carry a query or fragment: {REPOSITORY}")
    return REPOSITORY
