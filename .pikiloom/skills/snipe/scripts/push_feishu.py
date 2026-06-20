#!/usr/bin/env python3
"""DEPRECATED shim — moved to the shared core at _promo/push_feishu.py.
Kept so any stale reference keeps working. New callers should use:
    python3 .pikiloom/skills/_promo/push_feishu.py ...
"""
import runpy
import sys
from pathlib import Path

_canonical = Path(__file__).resolve().parents[2] / "_promo" / "push_feishu.py"
sys.argv[0] = str(_canonical)
runpy.run_path(str(_canonical), run_name="__main__")
