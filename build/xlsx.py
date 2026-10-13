"""Minimal .xlsx reader using only the standard library.

Returns {sheet_name: [ {header: value, ...}, ... ]} using row 1 as headers.
Values come back as strings; blank cells are omitted from the row dict.
"""
import re
import zipfile
import xml.etree.ElementTree as ET

M = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_COL = re.compile(r"[A-Z]+")


def _shared_strings(z):
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    return ["".join(t.text or "" for t in si.iter(M + "t")) for si in root.findall(M + "si")]


def _cell_value(c, strings):
    t = c.get("t")
    if t == "inlineStr":
        return "".join(x.text or "" for x in c.iter(M + "t"))
    v = c.find(M + "v")
    if v is None or v.text is None:
        return ""
    if t == "s":
        return strings[int(v.text)]
    return v.text


def read_xlsx(path):
    with zipfile.ZipFile(path) as z:
        strings = _shared_strings(z)
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        targets = {r.get("Id"): r.get("Target") for r in rels}
        sheets = {}
        for s in wb.find(M + "sheets"):
            target = targets[s.get(R + "id")].lstrip("/")
            if not target.startswith("xl/"):
                target = "xl/" + target
            root = ET.fromstring(z.read(target))
            rows = []
            for row in root.iter(M + "row"):
                rows.append({_COL.match(c.get("r")).group(): _cell_value(c, strings)
                             for c in row.findall(M + "c")})
            if not rows:
                sheets[s.get("name")] = []
                continue
            header = {col: name for col, name in rows[0].items() if name}
            table = []
            for r in rows[1:]:
                rec = {header[col]: val for col, val in r.items() if col in header and val != ""}
                if rec:
                    table.append(rec)
            sheets[s.get("name")] = table
        return sheets
