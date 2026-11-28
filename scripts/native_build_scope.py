"""Choose native verification from NUL-delimited changed paths on stdin."""
import os
import re
import sys


def native_build_scope(paths):
    android = ios = False
    for path in paths:
        path = path.replace("\\", "/")
        if path.startswith("apps/mobile/android/"):
            android = True
        elif path.startswith("apps/mobile/ios/"):
            ios = True
        elif path.startswith("apps/mobile/plugins/"):
            # Shared plugins may change either platform regardless of their filename.
            if path.startswith("apps/mobile/plugins/android/"):
                android = True
            elif path.startswith("apps/mobile/plugins/ios/"):
                ios = True
            else:
                android = ios = True
        elif path.startswith("apps/mobile/") and re.search(r"\.(?:c|cc|cpp|cxx|h|hpp|hh)$", path, re.I):
            android = ios = True
        elif path.startswith("apps/mobile/") and re.search(r"\.(?:kt|java|gradle|kts|aidl)$", path, re.I):
            android = True
        elif path.startswith("apps/mobile/") and re.search(r"\.(?:swift|m|mm|xcodeproj|pbxproj|plist|entitlements|podspec)$", path, re.I):
            ios = True
        elif (path in {
            "apps/mobile/package.json", "apps/mobile/package-lock.json", "apps/mobile/app.json",
            "apps/mobile/eas.json", "scripts/native_build_scope.py", "code_checks/native_build_scope_test.py",
            ".github/workflows/assurance.yml", ".github/workflows/native-checks.yml",
        } or path.startswith(("apps/mobile/app.config.", "apps/mobile/assets/", "apps/mobile/vendor/"))):
            android = ios = True
        elif path in {
            "security/install-android-ndk.sh", "security/maven-central-mirror.init.gradle",
            "security/android-smoke.sh", ".github/workflows/android-development-apk.yml",
            ".github/workflows/android-test-apk.yml", ".github/workflows/android-play-aab.yml",
        }:
            android = True
    return "both" if android and ios else "android" if android else "ios" if ios else "none"


if __name__ == "__main__":
    # os.fsdecode preserves unusual filenames; git diff uses -z and --no-renames.
    changed_paths = [os.fsdecode(path) for path in sys.stdin.buffer.read().split(b"\0") if path]
    print(native_build_scope(changed_paths))
