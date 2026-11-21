import re
import subprocess
import unittest
import urllib.parse
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


def tracked_text_files():
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
    )
    for relative_path in result.stdout.decode("utf-8").split("\0"):
        if not relative_path:
            continue
        path = REPOSITORY_ROOT / relative_path
        try:
            yield relative_path, path.read_text(encoding="utf-8")
        except FileNotFoundError:
            # Unstaged deletions still appear in the index.
            if path.is_symlink():
                raise
        except UnicodeDecodeError:
            continue


class RepositoryPrivacyTests(unittest.TestCase):
    def test_tracked_text_files_contain_no_personal_home_paths(self):
        personal_home = re.compile(
            r"(?:/(?:Users|home)/[A-Za-z0-9._-]+/|"
            r"[A-Za-z]:\\Users\\[^\\\s]+\\)"
        )
        violations = [
            relative_path
            for relative_path, content in tracked_text_files()
            if personal_home.search(content)
        ]

        self.assertEqual(violations, [])

    def test_tracked_karakeep_urls_use_reserved_example_hosts(self):
        violations = []
        for relative_path, content in tracked_text_files():
            for raw_url in re.findall(r"https?://[^\s`)'\"<>]+", content):
                hostname = urllib.parse.urlsplit(raw_url).hostname or ""
                if "karakeep" not in hostname.lower():
                    continue
                if hostname.endswith((".example", ".example.com")):
                    continue
                violations.append(relative_path)

        self.assertEqual(sorted(set(violations)), [])
