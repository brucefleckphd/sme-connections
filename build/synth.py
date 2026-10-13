"""Seeded synthetic competitor trials (PRD R4, R5, revised 2026-10-13).

Competitor trials are the ONLY synthetic data. Physician names and every other
attribute come from the workbook. Trial names are fictional on purpose, so no
real physician is tied to a real competitor study.

The trials double as connection fillers. Physicians with no real shared
institution or study are more likely to receive one, and trials are kept small
(TARGET_GROUP members on average) so none of them becomes a hub that makes
everyone look one hop apart.
"""
import math
import random

SEED = 42
P_ISOLATED = 0.6     # chance for a physician with no real peer
P_CONNECTED = 0.3    # chance for a physician who already has a real peer
P_SECOND = 0.25      # chance of a second trial
TARGET_GROUP = 10


def _letters(n):
    """A..Z, then AA, AB... for trial n (0-based)."""
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _real_peers(smes):
    groups = {}
    for s in smes:
        for a in s["institutions"] + s["studies"]:
            groups.setdefault(a["id"], set()).add(s["id"])
    return {i for g in groups.values() if len(g) > 1 for i in g}


def apply(data):
    """Mutate the dataset in place, adding competitor trials. Deterministic."""
    rng = random.Random(SEED)
    connected = _real_peers(data["smes"])

    # Pass 1. Decide who takes part, and in which therapeutic area.
    picks = {}  # sme id -> [ta ids]
    for sme in data["smes"]:  # sorted by smeId
        if not sme["tas"]:
            continue
        p = P_CONNECTED if sme["id"] in connected else P_ISOLATED
        if rng.random() < p:
            tas = [rng.choice(sme["tas"])]
            if rng.random() < P_SECOND:
                tas.append(rng.choice(sme["tas"]))
            picks[sme["id"]] = tas

    # Pass 2. Size each area's trial set so groups stay near TARGET_GROUP.
    demand = {}
    for tas in picks.values():
        for t in tas:
            demand[t] = demand.get(t, 0) + 1
    trials, by_ta = [], {}
    for ta in data["therapeuticAreas"]:
        n = max(2, math.ceil(demand.get(ta["id"], 0) / TARGET_GROUP))
        for _ in range(n):
            trial = {"id": f"CT{len(trials) + 1}",
                     "name": f"Competitor Trial {_letters(len(trials))} ({ta['name']})",
                     "ta": ta["id"], "synthetic": True}
            trials.append(trial)
            by_ta.setdefault(ta["id"], []).append(trial["id"])
    data["competitorTrials"] = trials

    # Pass 3. Deal participants into trials, filling the emptiest first.
    size = {t["id"]: 0 for t in trials}
    for sme in data["smes"]:
        chosen = []
        for t in picks.get(sme["id"], []):
            options = [c for c in by_ta[t] if c not in chosen]
            low = min(size[c] for c in options)
            c = rng.choice([c for c in options if size[c] == low])
            size[c] += 1
            chosen.append(c)
        sme["competitorTrials"] = sorted(chosen, key=lambda c: int(c[2:]))
    return data
