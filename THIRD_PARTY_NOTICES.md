# Third-party notices

This repository vendors no third-party source in its own tree. The one
third-party runtime an extension archive carries is Prettier, from the version
pinned in `package.json` and `bun.lock`: `scripts/vendor_prettier.py` copies it
into `com.mypaste.code-edit`'s runtime as `engines/prettier/`, and
`scripts/build-surfaces.mjs` bundles its standalone build with the babel and
estree plugins into `com.mypaste.json`'s page (`preview.html`).

## Prettier

- Version: 3.6.2 (pinned in `devDependencies.prettier`)
- Project: https://github.com/prettier/prettier
- License: MIT
- Files copied: `standalone.mjs`, `LICENSE`, and the parser plugins each
  package names — `plugins/postcss.mjs`, `plugins/yaml.mjs` for code-edit;
  `plugins/babel.mjs`, `plugins/estree.mjs` for json. Code-edit's archive also
  carries a generated `VERSION` file naming the version and project address.
- Purpose: CSS and YAML formatting inside code-edit's private runtime, and JSON
  formatting inside the JSON package's page. Both avoid depending on a
  formatter installed on the user's machine; code-edit still needs Node to run
  its vendored build, while json's build is compiled into the page and runs
  with no Node at all.

The MIT license text travels with code-edit as `engines/prettier/LICENSE`, and
is embedded in the head of json's `preview.html` as an HTML comment because the
page is the whole archive. The same text is reproduced here.

```text
Copyright © James Long and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
