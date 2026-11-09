"""Unit tests for the timestamp extension's parser and formatters.

The package's pure module (`src/parse.ts`) is bundled with the same esbuild the
surface build uses and executed under Node with a fixed local zone, so every
local-time expectation is reproducible on any machine. No clipboard text or
real user content is involved: all fixtures are synthetic.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "plugins" / "com.mypaste.timestamp"
ESBUILD = ROOT / "node_modules" / ".bin" / "esbuild"
NODE = shutil.which("node")
# Every expectation below that names local time assumes this zone.
LOCAL_ZONE = "Asia/Shanghai"

RUNNER = r"""
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const work = process.argv[2];
const mod = await import(pathToFileURL(path.join(work, "parse.mjs")).href);
const {
  parseTimestamp, buildRows, formatInZone, isoWeek, relativeTime,
} = mod;

const checks = [];
const utc = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) =>
  Date.UTC(y, mo - 1, d, h, mi, s, ms);
const local = (y, mo, d, h = 0, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).getTime();

function whole(text, expected) {
  const result = parseTimestamp(text);
  assert.equal(result.ok, true, `${text} should parse`);
  assert.equal(result.source, "whole", text);
  assert.equal(result.ms, expected, text);
}

function embedded(text, expected) {
  const result = parseTimestamp(text);
  assert.equal(result.ok, true, `${text} should parse`);
  assert.equal(result.source, "embedded", text);
  assert.equal(result.ms, expected, text);
  return result;
}

function rejects(text, reason) {
  const result = parseTimestamp(text);
  assert.equal(result.ok, false, `${text} should not parse`);
  assert.equal(result.reason, reason, text);
}

// Unix in all three widths, plus a millisecond value that is not on a second.
whole("1893456000", utc(2030, 1, 1));
whole("1893456000000", utc(2030, 1, 1));
whole("1893456000000000", utc(2030, 1, 1));
whole("1893456000123", utc(2030, 1, 1, 0, 0, 0, 123));
checks.push("unix seconds, milliseconds and microseconds");

// ISO 8601 / RFC 3339: Z, numeric offsets with and without a colon, fraction,
// and the local datetime form without a zone.
whole("2030-01-01T12:34:56Z", utc(2030, 1, 1, 12, 34, 56));
whole("2030-01-01T12:34:56.789+08:00", utc(2030, 1, 1, 4, 34, 56, 789));
whole("2030-01-01T12:34:56-0530", utc(2030, 1, 1, 18, 4, 56));
whole("2030-01-01 12:34:56", local(2030, 1, 1, 12, 34, 56));
whole("2030-01-01", local(2030, 1, 1));
checks.push("iso 8601 with optional fraction and offset");

whole("2030/1/2", local(2030, 1, 2));
whole("2030/01/02 03:04:05", local(2030, 1, 2, 3, 4, 5));
whole("20300102030405", local(2030, 1, 2, 3, 4, 5));
whole("2030年1月2日", local(2030, 1, 2));
whole("2030年1月2日 03:04:05", local(2030, 1, 2, 3, 4, 5));
checks.push("slashed, compact and chinese dates");

whole("Tue, 01 Jan 2030 12:00:00 +0000", utc(2030, 1, 1, 12));
whole("01 Jan 2030 12:00:00 GMT", utc(2030, 1, 1, 12));
whole("Tue, 01 Jan 2030 12:00:00 +0800", utc(2030, 1, 1, 4));
checks.push("rfc 2822 with numeric and named zones");

rejects("", "empty");
rejects("   ", "empty");
rejects("hello world", "unrecognized");
rejects("2030-02-30", "invalid-date");
rejects("2030-13-01", "invalid-date");
rejects("1969-12-31", "out-of-range");
rejects("2101-01-01", "out-of-range");
rejects("9999999999", "out-of-range");
rejects("9999999999999", "out-of-range");
checks.push("empty, unrecognised, impossible and out-of-range input");

const isoEmbedded = embedded(
  "会议记录 2030-01-01T12:00:00Z 结束", utc(2030, 1, 1, 12));
assert.equal(isoEmbedded.matched, "2030-01-01T12:00:00Z");
const secondEmbedded = embedded("订单 1893456000 已创建", utc(2030, 1, 1));
assert.equal(secondEmbedded.matched, "1893456000");
embedded("编号 1893456000123 结束", utc(2030, 1, 1, 0, 0, 0, 123));
checks.push("one bounded scan finds an embedded time and names the match");

const rows = buildRows(utc(2030, 1, 1), utc(2030, 1, 1, 3));
assert.equal(rows.length, 16);
const byId = Object.fromEntries(rows.map((row) => [row.id, row.value]));
assert.equal(byId.local, "2030-01-01 08:00:00");
assert.equal(byId.utc, "2030-01-01 00:00:00 UTC");
assert.equal(byId.iso, "2030-01-01T08:00:00+08:00");
assert.equal(byId.rfc, "Tue, 01 Jan 2030 08:00:00 +0800");
assert.equal(byId.unix, "1893456000");
assert.equal(byId["unix-ms"], "1893456000000");
assert.equal(byId.date, "2030-01-01");
assert.equal(byId.time, "08:00:00");
assert.equal(byId.weekday, "星期二");
assert.equal(byId["iso-week"], "2030-W01-2");
assert.equal(byId.relative, "3 小时前");
assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
for (const row of rows) {
  assert.ok(row.label !== "", row.id);
  assert.ok(row.value !== "", row.id);
}
for (const zone of [
  "UTC", "Asia/Shanghai", "America/New_York", "Europe/London", "Asia/Tokyo",
]) {
  assert.ok(rows.some((row) => row.id === `zone-${zone}`), zone);
}
checks.push("every display row is filled and the zones are all present");

assert.equal(
  formatInZone(utc(2030, 1, 1), "UTC"), "2030-01-01 00:00:00 (UTC)");
assert.equal(
  formatInZone(utc(2030, 1, 1), "Asia/Shanghai"),
  "2030-01-01 08:00:00 (UTC+8)");
assert.equal(
  formatInZone(utc(2030, 1, 1), "America/New_York"),
  "2029-12-31 19:00:00 (UTC-5)");
assert.equal(
  formatInZone(utc(2030, 1, 1), "Europe/London"),
  "2030-01-01 00:00:00 (UTC)");
assert.equal(
  formatInZone(utc(2030, 1, 1), "Asia/Tokyo"),
  "2030-01-01 09:00:00 (UTC+9)");
checks.push("the same instant renders in five zones");

assert.equal(isoWeek(utc(2030, 1, 1)), "2030-W01-2");
assert.equal(isoWeek(utc(2029, 12, 31)), "2030-W01-1");
checks.push("iso week and weekday");

assert.equal(relativeTime(utc(2030, 1, 1, 9), utc(2030, 1, 1, 12)), "3 小时前");
assert.equal(relativeTime(utc(2030, 1, 3, 12), utc(2030, 1, 1, 12)), "2 天后");
assert.equal(relativeTime(utc(2030, 1, 1, 12), utc(2030, 1, 1, 12)), "刚刚");
assert.equal(
  relativeTime(utc(2030, 1, 1, 11, 59, 30), utc(2030, 1, 1, 12)), "30 秒前");
checks.push("relative time in the past, future and around now");

console.log(JSON.stringify(checks));
"""


class TimestampParseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if NODE is None or not ESBUILD.exists():
            raise unittest.SkipTest("node and esbuild are needed for the timestamp test")
        cls.temp = tempfile.TemporaryDirectory()
        work = Path(cls.temp.name)
        built = subprocess.run(
            [
                str(ESBUILD),
                str(PACKAGE / "src" / "parse.ts"),
                "--bundle",
                "--format=esm",
                "--platform=neutral",
                "--log-level=error",
                f"--outfile={work / 'parse.mjs'}",
            ],
            capture_output=True,
            text=True,
        )
        if built.returncode != 0:
            raise AssertionError(f"esbuild failed: {built.stderr}")
        runner = work / "runner.mjs"
        runner.write_text(RUNNER, encoding="utf-8")
        environment = dict(os.environ)
        environment["TZ"] = LOCAL_ZONE
        cls.result = subprocess.run(
            [str(NODE), str(runner), str(work)],
            capture_output=True,
            text=True,
            timeout=60,
            env=environment,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp.cleanup()

    def test_parser_and_formatters(self) -> None:
        self.assertEqual(
            self.result.returncode,
            0,
            self.result.stdout + self.result.stderr,
        )
        checks = json.loads(self.result.stdout)
        self.assertGreaterEqual(len(checks), 10)
        self.assertIn("unix seconds, milliseconds and microseconds", checks)
        self.assertIn("iso 8601 with optional fraction and offset", checks)
        self.assertIn("one bounded scan finds an embedded time and names the match", checks)
        self.assertIn("the same instant renders in five zones", checks)


if __name__ == "__main__":
    unittest.main()
