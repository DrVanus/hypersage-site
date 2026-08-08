#!/usr/bin/env python3
"""Run the static-site auditor once per site in this repo.

hypersage.ai is not one site. It is the studio site at the origin root plus one
folded-in product site per subfolder, and each of those owns its own canonical
URL, its own legal surface, and its own site-audit-contract.json. The auditor in
the no-build-marketing-site skill audits ONE site: point it at this repo root and
it walks every subfolder, judges eleven products' pages against the studio's
contract, and reports failures that belong to nobody. That is where the "~73
failures" figure in the 2026-08-08 fleet review came from.

This runner audits each site against its own contract instead:

    root        audited with site-audit-contract.json, subsites excluded
    <product>/  audited with <product>/site-audit-contract.json

Excluded subsites stay on disk, so a link from the studio page into a product
page still resolves; they are simply not judged by the studio's contract.

The auditor itself is NOT vendored here. It lives in the harness skill and is
found at run time (see find_auditor) so this repo cannot drift from the version
the rest of the fleet gates on.

    python3 tools/audit_sites.py              # every site, human-readable
    python3 tools/audit_sites.py rowan alder  # named sites only
    python3 tools/audit_sites.py --json       # machine-readable
    python3 tools/audit_sites.py --warnings   # include WARN findings

Exit status is 1 if any audited site has a FAIL finding, else 0.
"""

import argparse
import importlib.util
import json
import os
import sys

REPO = os.path.dirname(os.path.abspath(os.path.dirname(__file__)))

# In preference order. The skill symlink comes first: it is the path the rest of
# the harness resolves, so gating on it means this repo and the fleet gate agree.
AUDITOR_CANDIDATES = (
    os.path.expanduser("~/.claude/skills/no-build-marketing-site/site_audit.py"),
    os.path.expanduser(
        "~/Developer/DrVanus/gamedev-harness/appdev/no-build-marketing-site/site_audit.py"
    ),
)


def find_auditor(explicit=None):
    candidates = [explicit] if explicit else []
    if os.environ.get("SITE_AUDIT_PY"):
        candidates.append(os.environ["SITE_AUDIT_PY"])
    candidates.extend(AUDITOR_CANDIDATES)
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    raise SystemExit(
        "cannot find site_audit.py.\n"
        "It ships with the no-build-marketing-site skill and is deliberately not\n"
        "vendored into this repo. Point at it with --auditor PATH or SITE_AUDIT_PY,\n"
        "or restore the skill. Looked in:\n  "
        + "\n  ".join(path for path in candidates if path)
    )


def load_auditor(path):
    spec = importlib.util.spec_from_file_location("site_audit", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not hasattr(module, "SiteAudit"):
        raise SystemExit("%s does not define SiteAudit" % path)
    return module


def discover_sites(repo):
    """Root plus every immediate subdirectory that ships its own index.html."""
    subsites = sorted(
        name
        for name in os.listdir(repo)
        if not name.startswith(".")
        and os.path.isdir(os.path.join(repo, name))
        and os.path.isfile(os.path.join(repo, name, "index.html"))
    )
    return ["."] + subsites


def audit_site(module, repo, site, subsites):
    root = repo if site == "." else os.path.join(repo, site)
    # Only the root audit needs exclusions; a subsite has no nested sites.
    exclude = subsites if site == "." else []
    audit = module.SiteAudit(root, None, exclude)
    findings = audit.run()
    return {
        "site": site,
        "contract": os.path.isfile(os.path.join(root, "site-audit-contract.json")),
        "failures": [item for item in findings if item["level"] == "FAIL"],
        "warnings": [item for item in findings if item["level"] == "WARN"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("sites", nargs="*", help="audit only these sites ('.' is the studio root)")
    parser.add_argument("--auditor", help="path to site_audit.py")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    parser.add_argument("--warnings", action="store_true", help="print WARN findings too")
    args = parser.parse_args()

    module = load_auditor(find_auditor(args.auditor))
    all_sites = discover_sites(REPO)
    subsites = [name for name in all_sites if name != "."]

    selected = args.sites or all_sites
    unknown = [name for name in selected if name.rstrip("/") not in all_sites]
    if unknown:
        raise SystemExit("unknown site(s): %s\nknown: %s" % (", ".join(unknown), ", ".join(all_sites)))
    selected = [name.rstrip("/") for name in selected]

    results = [audit_site(module, REPO, site, subsites) for site in selected]
    total = sum(len(item["failures"]) for item in results)

    if args.json:
        print(json.dumps({
            "schema": "hypersage-site-audit/v1",
            "repo": REPO,
            "ok": total == 0,
            "failures": total,
            "sites": results,
        }, indent=2))
        return 1 if total else 0

    for item in results:
        label = "root" if item["site"] == "." else item["site"]
        mark = "ok  " if not item["failures"] else "FAIL"
        contract = "" if item["contract"] else "   [no contract]"
        print("%s %-12s %2d failure(s), %2d warning(s)%s"
              % (mark, label, len(item["failures"]), len(item["warnings"]), contract))
        for finding in item["failures"]:
            print("       FAIL %-26s %s" % (finding["scope"], finding["message"]))
        if args.warnings:
            for finding in item["warnings"]:
                print("       WARN %-26s %s" % (finding["scope"], finding["message"]))

    print("\n%d site(s) audited, %d failure(s)" % (len(results), total))
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
