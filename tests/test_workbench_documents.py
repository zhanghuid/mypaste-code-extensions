"""A workbench document must contain every element its script looks up.

The defect this guards against shipped twice (0.20.2): `src/main.ts` ran
`one("[data-action=close]")` at module top level while the markup only had
`id="doc-close"`. The lookup threw before `onItem(render)` was registered, so
the document stayed on its static placeholder with no visible error: the bridge
had already said `ready`, the host had already sent the item, and nothing
listened. A missing element is a startup failure, not a missing feature, so the
build output is checked rather than trusted.

Only the selector forms the documents actually use are understood: `#id`,
`[attr]`, `[attr=value]` and a bare tag name. Anything else fails the test
instead of being skipped, so a new shape has to be taught here deliberately.
"""

from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"

# `one("#x")` is the packages' helper; `querySelector` calls use the same
# literal forms. `querySelector<T>(selector)` with a variable is not a literal
# and is not what this test is about.
ONE_CALL = re.compile(r"""\bone(?:<[^>]*>)?\(\s*"([^"]+)"\s*\)""")
QUERY_CALL = re.compile(r"""\bquerySelector(?!All)(?:<[^>]*>)?\(\s*"([^"]+)"\s*[,)]""")
QUERY_ALL_CALL = re.compile(r"""\bquerySelectorAll(?:<[^>]*>)?\(\s*"([^"]+)"\s*[,)]""")

ID_SELECTOR = re.compile(r"^#([A-Za-z_][\w-]*)$")
ATTR_SELECTOR = re.compile(
    r"""^\[\s*([A-Za-z_:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]$"""
)
TAG_SELECTOR = re.compile(r"^[A-Za-z][A-Za-z0-9-]*$")


class Element:
    def __init__(self, tag: str, attrs: dict[str, str | None]) -> None:
        self.tag = tag
        self.attrs = attrs


class ElementCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.elements: list[Element] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.elements.append(Element(tag, dict(attrs)))

    handle_startendtag = handle_starttag


def selectors_in(script: str) -> list[str]:
    found = ONE_CALL.findall(script)
    found += QUERY_CALL.findall(script)
    found += QUERY_ALL_CALL.findall(script)
    # Keep the document's own reading order; one repeated lookup is one fact.
    return list(dict.fromkeys(found))


def elements_in(document: str) -> list[Element]:
    collector = ElementCollector()
    collector.feed(document)
    collector.close()
    return collector.elements


def matches(selector: str, elements: list[Element]) -> bool:
    by_id = ID_SELECTOR.match(selector)
    if by_id:
        return any(element.attrs.get("id") == by_id.group(1) for element in elements)
    by_attr = ATTR_SELECTOR.match(selector)
    if by_attr:
        name = by_attr.group(1).lower()
        value = next(
            (part for part in by_attr.groups()[1:] if part is not None), None)
        if value is None:
            return any(name in element.attrs for element in elements)
        return any(element.attrs.get(name) == value for element in elements)
    if TAG_SELECTOR.match(selector):
        return any(element.tag == selector.lower() for element in elements)
    raise ValueError(
        f"selector {selector!r} is not one of #id, [attr], [attr=value] or a tag name")


class WorkbenchDocumentTests(unittest.TestCase):
    def test_every_selector_a_workbench_queries_exists_in_its_document(self) -> None:
        packages = sorted(
            path for path in PLUGINS.iterdir()
            if (path / "src" / "main.ts").is_file()
            and (path / "src" / "workbench.html").is_file()
        )
        # Four documents ship today; fewer means discovery broke, not that the
        # rule stopped applying.
        self.assertGreaterEqual(len(packages), 4)
        for package in packages:
            with self.subTest(package=package.name):
                script = (package / "src" / "main.ts").read_text(encoding="utf-8")
                selectors = selectors_in(script)
                self.assertTrue(selectors, f"{package.name} 没有可检查的选择器")
                built = package / "workbench.html"
                self.assertTrue(
                    built.is_file(),
                    f"{package.name} 缺少构建产物 workbench.html，请先运行 "
                    "node scripts/build-workbenches.mjs --all",
                )
                document = built.read_text(encoding="utf-8")
                self.assertNotIn(
                    "<!--bundle-->", document,
                    f"{package.name} 的 workbench.html 是未注入脚本的模板")
                elements = elements_in(document)
                missing = [
                    selector for selector in selectors
                    if not matches(selector, elements)
                ]
                self.assertEqual(
                    missing, [],
                    f"{package.name} 的 workbench.html 缺少脚本查询的元素："
                    + "、".join(missing),
                )


if __name__ == "__main__":
    unittest.main()
