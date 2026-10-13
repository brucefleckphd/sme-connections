#!/usr/bin/env python3
"""Build data/graph.js from the Global CP Advocates workbook.

Usage:
    python3 build/build_data.py [path/to/workbook.xlsx] [--out data/graph.js]
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import synth  # noqa: E402
from xlsx import read_xlsx  # noqa: E402

DEFAULT_XLSX = HERE.parent / "source" / "Global CP Advocates Reformatted.xlsx"
DEFAULT_OUT = HERE.parent / "data" / "graph.js"

# R3. Spelling variants collapse onto one canonical topic name. Source names and IDs survive as aliases.
TOPIC_CANONICAL = {
    "Embolisation": "Embolization",
    "Emoblization": "Embolization",
    "Surgical Apects": "Surgical Aspects",
    "Complex Aaa And Taaa": "Complex AAA and TAAA",
}
# Engagement notes that only say "yes" carry no event name.
_BARE_YES = {"yes", "y"}


def _int(v):
    return int(float(v))


def load_workbook(path):
    """Read every sheet. The workbook fingerprint rides along under the "__meta__" key."""
    sheets = read_xlsx(path)
    sheets["__meta__"] = {"sha": hashlib.sha256(Path(path).read_bytes()).hexdigest()[:12]}
    return sheets


def _workbook_generated(sheets):
    for r in sheets.get("_ReadMe", []):
        for v in r.values():
            if v.startswith("Generated "):
                return v[len("Generated "):].split(" by ")[0]
    return None


def _lookup(sheets, sheet, id_col, name_col):
    return {_int(r[id_col]): r[name_col] for r in sheets.get(sheet, []) if id_col in r}


def build_dataset(sheets):
    warnings = 0
    specialty = _lookup(sheets, "Specialty", "SpecialtyID", "SpecialtyName")
    region = _lookup(sheets, "Region", "RegionID", "RegionName")
    country = _lookup(sheets, "Country", "CountryID", "CountryName")
    advocate = _lookup(sheets, "AdvocateClassification", "AdvocateClassificationID",
                       "AdvocateClassificationName")
    rel_type = _lookup(sheets, "RelationshipType", "RelationshipTypeID", "RelationshipTypeName")
    program = _lookup(sheets, "EducationProgram", "EducationProgramID", "EducationProgramName")
    eng_type = _lookup(sheets, "EngagementType", "EngagementTypeID", "EngagementTypeName")

    tas = [{"id": f"TA{_int(r['TherapeuticAreaID'])}", "name": r["TherapeuticAreaName"]}
           for r in sheets["TherapeuticArea"]]

    # Topics, with duplicate spellings folded onto the canonical record.
    raw_topics = {_int(r["ExpertiseTopicID"]): r["ExpertiseTopicName"] for r in sheets["ExpertiseTopic"]}
    canon_id_by_name = {}
    # A record already spelled canonically owns the ID; otherwise the lowest variant ID does.
    for tid in sorted(raw_topics, key=lambda t: (raw_topics[t] in TOPIC_CANONICAL, t)):
        name = TOPIC_CANONICAL.get(raw_topics[tid], raw_topics[tid])
        canon_id_by_name.setdefault(name, f"T{tid}")
    topic_id = {tid: canon_id_by_name[TOPIC_CANONICAL.get(n, n)] for tid, n in raw_topics.items()}
    topics = []
    for name, cid in sorted(canon_id_by_name.items(), key=lambda x: int(x[1][1:])):
        aliases = [{"id": f"T{tid}", "name": n} for tid, n in sorted(raw_topics.items())
                   if topic_id[tid] == cid and (n != name or f"T{tid}" != cid)]
        topics.append({"id": cid, "name": name, "aliases": aliases})

    institutions = []
    for r in sheets["Institution"]:
        inst = {"id": f"I{_int(r['InstitutionID'])}", "name": r["InstitutionName"]}
        loc = ", ".join(x for x in (r.get("City"), r.get("State")) if x)
        if loc:
            inst["location"] = loc
        institutions.append(inst)
    studies = [{"id": f"CS{_int(r['ClinicalStudyID'])}", "name": r["ClinicalStudyName"]}
               for r in sheets["ClinicalStudy"]]
    inst_ids = {i["id"] for i in institutions}
    study_ids = {s["id"] for s in studies}
    ta_ids = {t["id"] for t in tas}

    smes = {}
    for r in sorted(sheets["SME"], key=lambda r: _int(r["SMEID"])):
        sid = _int(r["SMEID"])
        first, last = r.get("FirstName", ""), r.get("LastName", "")
        smes[sid] = {
            "id": f"S{sid}", "smeId": sid, "first": first, "last": last,
            "name": f"{first} {last}".strip(),
            "specialty": specialty.get(_int(r["SpecialtyID"])) if "SpecialtyID" in r else None,
            "region": region.get(_int(r["RegionID"])) if "RegionID" in r else None,
            "country": country.get(_int(r["CountryID"])) if "CountryID" in r else None,
            "advocate": advocate.get(_int(r["AdvocateClassificationID"]))
            if "AdvocateClassificationID" in r else None,
            "isCookAdvocate": r.get("IsCookAdvocate"),
            "institutions": [], "studies": [], "tas": [], "topics": [],
            "programs": [], "relTypes": [], "engagements": [],
        }

    def sme_for(row):
        nonlocal warnings
        s = smes.get(_int(row["SMEID"]))
        if s is None:
            warnings += 1
        return s

    for r in sheets["brSMEAffiliation"]:
        s = sme_for(r)
        iid = f"I{_int(r['InstitutionID'])}"
        if s is None or iid not in inst_ids:
            warnings += s is not None
            continue
        a = {"id": iid, "current": r.get("IsCurrent") == "Y"}
        if r.get("RoleTitle"):
            a["role"] = r["RoleTitle"]
        s["institutions"].append(a)

    for r in sheets["brSMEClinicalStudy"]:
        s = sme_for(r)
        cid = f"CS{_int(r['ClinicalStudyID'])}"
        if s is None or cid not in study_ids:
            warnings += s is not None
            continue
        s["studies"].append({"id": cid, "role": r.get("InvestigatorRole")})

    for r in sheets["brSMETherapeuticArea"]:
        s = sme_for(r)
        tid = f"TA{_int(r['TherapeuticAreaID'])}"
        if s is not None and tid in ta_ids and tid not in s["tas"]:
            s["tas"].append(tid)

    for r in sheets["brSMEExpertiseTopic"]:
        s = sme_for(r)
        t = topic_id.get(_int(r["ExpertiseTopicID"]))
        if s is not None and t and t not in s["topics"]:
            s["topics"].append(t)

    for r in sheets["brSMEProgram"]:
        s = sme_for(r)
        p = program.get(_int(r["EducationProgramID"]))
        if s is not None and p and p not in s["programs"]:
            s["programs"].append(p)

    for r in sheets["brSMERelationshipType"]:
        s = sme_for(r)
        t = rel_type.get(_int(r["RelationshipTypeID"]))
        if s is not None and t and t not in s["relTypes"]:
            s["relTypes"].append(t)

    for r in sheets["Engagement"]:
        s = sme_for(r)
        if s is None:
            continue
        # R7. Keep the source evidence verbatim. Never invent a type.
        e = {"year": r.get("SourceYear"), "source": r.get("SourceColumn"),
             "unspecified": r.get("IsUnspecified") == "Y"}
        if "EngagementTypeID" in r:
            e["type"] = eng_type.get(_int(r["EngagementTypeID"]))
        note = (r.get("NotesOutcome") or "").strip()
        if note and note.lower() not in _BARE_YES:
            e["notes"] = note
        if r.get("EngagementDate"):
            e["date"] = r["EngagementDate"]
        s["engagements"].append(e)

    data = {
        "meta": {
            "source": "Global CP Advocates Reformatted.xlsx",
            "workbookGenerated": _workbook_generated(sheets),
            "sourceSha": sheets.get("__meta__", {}).get("sha"),
            "seed": synth.SEED,
            "syntheticFields": ["competitorTrials"],
            "warnings": warnings,
        },
        "therapeuticAreas": tas,
        "topics": topics,
        "institutions": institutions,
        "studies": studies,
        "smes": [smes[k] for k in sorted(smes)],
    }
    synth.apply(data)
    data["meta"]["counts"] = {k: len(data[k]) for k in
                              ("smes", "institutions", "studies", "therapeuticAreas", "topics",
                               "competitorTrials")}
    return data


def to_js(data):
    return "window.SME_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("xlsx", nargs="?", default=str(DEFAULT_XLSX))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args(argv)
    src = Path(args.xlsx).expanduser()
    if not src.exists():
        print(f"Error: workbook not found at {src}", file=sys.stderr)
        return 2
    data = build_dataset(load_workbook(src))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(to_js(data), encoding="utf-8")
    c = data["meta"]["counts"]
    print(f"Wrote {out} ({out.stat().st_size:,} bytes). " +
          ", ".join(f"{k} {v}" for k, v in c.items()) +
          f". Skipped bridge rows {data['meta']['warnings']}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
