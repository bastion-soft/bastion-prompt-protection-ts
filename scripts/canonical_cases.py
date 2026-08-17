"""Cross-language fixture for the canonical JSON serializer.

The license signature is computed over this exact byte sequence, so the TS
implementation must reproduce Python's
`json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)` exactly.
"""

import json
import pathlib

from bastion_prompt_protection.license import _canonical_json

cases = [
    {"b": 1, "a": 2},
    {"z": {"y": 1, "x": [3, 2, 1]}, "a": "str"},
    {"company": "Ærø Systems ApS", "city": "København"},
    {"unicode": "日本語 🎉 emoji", "rtl": "مرحبا"},
    {"nested": {"deep": {"deeper": {"k": True, "j": None, "i": False}}}},
    {"list_of_dicts": [{"b": 1, "a": 2}, {"d": 3, "c": 4}]},
    {"escapes": 'quote" backslash\\ newline\n tab\t'},
    {"control": "\x01\x02\x1f"},
    {"int": 42, "negative": -7, "zero": 0},
    {"empty_obj": {}, "empty_list": [], "empty_str": ""},
    {"solidus": "a/b", "unicode_key_Æ": 1, "Zed": 2, "apple": 3},
    {
        "license_id": "BSN-2026-0042",
        "tier": "enterprise",
        "customer": {"company_name": "Acme A/S", "contact": "jev@example.com"},
        "valid_until": "2027-01-01T00:00:00+00:00",
        "seats": 25,
    },
]

out = [{"obj": c, "canonical": _canonical_json(c).decode("utf-8")} for c in cases]
pathlib.Path("canonical_cases.json").write_text(
    json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8"
)
print(f"wrote {len(out)} canonical-json cases")
for o in out[:4]:
    print("  ", o["canonical"])
