"""Tests for the SME Connections data build (PRD R1 to R7)."""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "build"))

from build_data import DEFAULT_XLSX, build_dataset, load_workbook, to_js  # noqa: E402

XLSX = Path(os.environ.get("SME_XLSX", DEFAULT_XLSX))


@unittest.skipUnless(XLSX.exists(), f"workbook not found at {XLSX}")
class BuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sheets = load_workbook(XLSX)
        cls.data = build_dataset(cls.sheets)

    # R1 reader
    def test_reader_returns_named_sheets_as_dict_rows(self):
        self.assertIn("SME", self.sheets)
        self.assertEqual(len(self.sheets["SME"]), 520)
        self.assertTrue(all(isinstance(row, dict) for row in self.sheets["SME"]))
        self.assertTrue(any(row.get("LastName") for row in self.sheets["SME"]))

    # R2 counts and joins
    def test_entity_counts_match_workbook(self):
        d = self.data
        self.assertEqual(len(d["smes"]), 520)
        self.assertEqual(len(d["institutions"]), 411)
        self.assertEqual(len(d["studies"]), 49)
        self.assertEqual(len(d["therapeuticAreas"]), 7)

    def test_bridges_are_joined_onto_smes(self):
        example = next(s for s in self.data["smes"] if s["specialty"] and s["region"] and s["topics"] and s["tas"])
        source = next(r for r in self.sheets["SME"] if int(float(r["SMEID"])) == example["smeId"])
        specialty = next(r for r in self.sheets["Specialty"] if r["SpecialtyID"] == source["SpecialtyID"])
        region = next(r for r in self.sheets["Region"] if r["RegionID"] == source["RegionID"])
        self.assertEqual(example["specialty"], specialty["SpecialtyName"])
        self.assertEqual(example["region"], region["RegionName"])
        self.assertTrue(example["topics"])
        self.assertTrue(example["tas"])
        roles = {st["role"] for s in self.data["smes"] for st in s["studies"]}
        self.assertIn("PI", roles)

    def test_foreign_keys_resolve(self):
        d = self.data
        inst = {i["id"] for i in d["institutions"]}
        studies = {s["id"] for s in d["studies"]}
        tas = {t["id"] for t in d["therapeuticAreas"]}
        topics = {t["id"] for t in d["topics"]}
        cts = {c["id"] for c in d["competitorTrials"]}
        for s in d["smes"]:
            for a in s["institutions"]:
                self.assertIn(a["id"], inst)
            for st in s["studies"]:
                self.assertIn(st["id"], studies)
            for t in s["tas"]:
                self.assertIn(t, tas)
            for t in s["topics"]:
                self.assertIn(t, topics)
            for c in s["competitorTrials"]:
                self.assertIn(c, cts)

    # R3 topic dedupe
    def test_embolization_spellings_collapse(self):
        names = {t["name"] for t in self.data["topics"]}
        self.assertIn("Embolization", names)
        self.assertNotIn("Embolisation", names)
        self.assertNotIn("Emoblization", names)

    # R4 determinism and flags
    def test_build_is_deterministic(self):
        again = build_dataset(load_workbook(XLSX))
        self.assertEqual(to_js(self.data), to_js(again))

    def test_only_competitor_trials_are_synthetic(self):
        self.assertEqual(self.data["meta"]["syntheticFields"], ["competitorTrials"])
        for c in self.data["competitorTrials"]:
            self.assertTrue(c["synthetic"])
        for s in self.data["smes"]:
            for k in ("credentials", "yearsInPractice", "careerStage"):
                self.assertNotIn(k, s)

    # R5 competitor trials fill connection gaps without becoming hubs
    def test_competitor_trials_are_fictional_and_in_sme_area(self):
        pat = re.compile(r"^Competitor Trial [A-Z]+ \(.+\)$")
        cts = {c["id"]: c for c in self.data["competitorTrials"]}
        for c in cts.values():
            self.assertRegex(c["name"], pat)
        for s in self.data["smes"]:
            for c in s["competitorTrials"]:
                self.assertIn(cts[c]["ta"], s["tas"])

    def test_competitor_trials_fill_connection_gaps(self):
        groups = {}
        for s in self.data["smes"]:
            for key in [a["id"] for a in s["institutions"]] + [a["id"] for a in s["studies"]] + s["competitorTrials"]:
                groups.setdefault(key, set()).add(s["id"])
        connected = {i for g in groups.values() if len(g) > 1 for i in g}
        self.assertGreaterEqual(len(connected) / len(self.data["smes"]), 0.6)
        ct_sizes = [len(g) for k, g in groups.items() if k.startswith("CT")]
        self.assertLessEqual(max(ct_sizes), 20)

    # R7 engagements keep real evidence, invent nothing
    def test_engagements_keep_source_evidence(self):
        engs = [e for s in self.data["smes"] for e in s["engagements"]]
        self.assertEqual(len(engs), len(self.sheets["Engagement"]))
        source_notes = {(r.get("NotesOutcome") or "").strip() for r in self.sheets["Engagement"]}
        source_notes = {note for note in source_notes if note and note.lower() not in {"yes", "y"}}
        notes = {e["notes"] for e in engs if e.get("notes")}
        self.assertEqual(notes, source_notes)
        self.assertTrue(all("type" not in e or e["type"] is None for e in engs))
        self.assertEqual({e["source"] for e in engs}, {r.get("SourceColumn") for r in self.sheets["Engagement"]})
        self.assertEqual({e.get("year") for e in engs}, {r.get("SourceYear") for r in self.sheets["Engagement"]})

    def test_topic_aliases_keep_original_ids(self):
        emb = next(t for t in self.data["topics"] if t["name"] == "Embolization")
        self.assertEqual(sorted(a["name"] for a in emb["aliases"]), ["Embolisation", "Emoblization"])
        self.assertTrue(all(a["id"].startswith("T") for a in emb["aliases"]))

    def test_meta_fingerprints_the_workbook(self):
        m = self.data["meta"]
        self.assertEqual(m["workbookGenerated"], "2026-09-22 16:42 UTC")
        self.assertRegex(m["sourceSha"], r"^[0-9a-f]{12}$")

    # R1 output format
    def test_js_output_assigns_global(self):
        js = to_js(self.data)
        self.assertTrue(js.startswith("window.SME_DATA = "))
        json.loads(js[len("window.SME_DATA = "):].rstrip().rstrip(";"))


class CliTests(unittest.TestCase):
    def test_missing_workbook_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = subprocess.run(
                [sys.executable, str(ROOT / "build" / "build_data.py"),
                 str(Path(tmp) / "nope.xlsx"), "--out", str(Path(tmp) / "g.js")],
                capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not found", r.stderr.lower())


if __name__ == "__main__":
    unittest.main()
