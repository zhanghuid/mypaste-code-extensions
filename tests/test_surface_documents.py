"""A surface page must contain every element its script looks up.

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


class SurfaceDocumentTests(unittest.TestCase):
    def test_code_edit_has_no_command_button_row(self) -> None:
        # D-1069 follow-up: composition lives in two labelled dropdowns (语言
        # and 格式化) behind their own toggles, not a footer of capability
        # buttons and not an icon 功能区 panel. A footer of capability buttons
        # was the old shape and must not return; the ambiguous 操作 menu and the
        # 高亮 picker are gone too.
        package = PLUGINS / "com.mypaste.code-edit"
        for document in (package / "src" / "preview.html", package / "preview.html"):
            text = document.read_text(encoding="utf-8")
            self.assertNotIn("doc-commands", text, document)
            self.assertNotIn('id="doc-actions"', text, document)
            self.assertNotIn('id="doc-highlight"', text, document)
            self.assertNotIn('id="doc-format"', text, document)
            self.assertIn('id="doc-language-toggle"', text, document)
            self.assertIn('id="doc-language-menu"', text, document)
            self.assertIn('id="doc-format-toggle"', text, document)
            self.assertIn('id="doc-format-menu"', text, document)
            self.assertEqual(
                len(re.findall(r'<button[^>]*data-action="', text)), 2, document)

    def surface_packages(self) -> list[Path]:
        return sorted(
            path for path in PLUGINS.iterdir()
            if (path / "src" / "main.ts").is_file()
            and (path / "src" / "preview.html").is_file()
        )

    def test_every_selector_a_surface_queries_exists_in_its_document(self) -> None:
        packages = self.surface_packages()
        # Six documents ship today; fewer means discovery broke, not that the
        # rule stopped applying.
        self.assertGreaterEqual(len(packages), 6)
        for package in packages:
            with self.subTest(package=package.name):
                script = (package / "src" / "main.ts").read_text(encoding="utf-8")
                selectors = selectors_in(script)
                self.assertTrue(selectors, f"{package.name} 没有可检查的选择器")
                built = package / "preview.html"
                self.assertTrue(
                    built.is_file(),
                    f"{package.name} 缺少构建产物 preview.html，请先运行 "
                    "node scripts/build-surfaces.mjs --all",
                )
                document = built.read_text(encoding="utf-8")
                self.assertNotIn(
                    "<!--bundle-->", document,
                    f"{package.name} 的 preview.html 是未注入脚本的模板")
                elements = elements_in(document)
                missing = [
                    selector for selector in selectors
                    if not matches(selector, elements)
                ]
                self.assertEqual(
                    missing, [],
                    f"{package.name} 的 preview.html 缺少脚本查询的元素："
                    + "、".join(missing),
                )

    def test_closing_belongs_to_the_host_card(self) -> None:
        # The studio card already draws a close control. A second one inside the
        # document duplicated it and sat beside it in the same corner. Escape
        # still reaches the bridge; that is not a second control. The two
        # editing documents are the ones this contract covers today.
        for plugin_id in ("com.mypaste.diff-view", "com.mypaste.code-edit"):
            with self.subTest(package=plugin_id):
                package = PLUGINS / plugin_id
                elements = elements_in(
                    (package / "preview.html").read_text(encoding="utf-8"))
                self.assertFalse(
                    matches("[data-action=close]", elements),
                    f"{plugin_id} 画了第二个关闭按钮；关闭由宿主卡片负责",
                )
                self.assertFalse(
                    matches("#doc-close", elements),
                    f"{plugin_id} 的文档里还留着 #doc-close",
                )

    def test_bridges_mirror_host_tokens_as_mp_variables(self) -> None:
        # The two documents that paint a full surface consume the tokens; the
        # export card and the image editor keep their own fixed palettes.
        for plugin_id in ("com.mypaste.diff-view", "com.mypaste.code-edit"):
            bridge = PLUGINS / plugin_id / "src" / "bridge.ts"
            with self.subTest(package=plugin_id):
                self.assertTrue(bridge.is_file(), plugin_id)
                script = bridge.read_text(encoding="utf-8")
                self.assertIn('setProperty(`--mp-${name}`', script)
                self.assertIn("data.tokens", script)
                self.assertIn('typeof value === "string"', script)


if __name__ == "__main__":
    unittest.main()
