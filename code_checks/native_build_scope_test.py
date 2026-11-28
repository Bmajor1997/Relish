import unittest

from scripts.native_build_scope import native_build_scope


class NativeBuildScopeTest(unittest.TestCase):
    def test_fast_only_changes(self):
        for path in ("data/recipes/src/meals-01.txt", "data/curated-photos/one.jpg",
                     "apps/mobile/src/app/recipe.tsx", "server/app.js", "README.md"):
            with self.subTest(path=path):
                self.assertEqual(native_build_scope([path]), "none")

    def test_platform_specific_changes(self):
        for path in ("apps/mobile/android/app/build.gradle", "apps/mobile/plugins/android/plugin.js",
                     "security/android-smoke.sh", "apps/mobile/src/native/Foo.kt"):
            with self.subTest(path=path):
                self.assertEqual(native_build_scope([path]), "android")
        for path in ("apps/mobile/ios/App/App.swift", "apps/mobile/plugins/ios/plugin.js",
                     "apps/mobile/src/native/Foo.swift"):
            with self.subTest(path=path):
                self.assertEqual(native_build_scope([path]), "ios")

    def test_shared_native_inputs(self):
        for path in ("apps/mobile/package-lock.json", "apps/mobile/app.config.js",
                     "apps/mobile/plugins/with-revenuecat.js", "apps/mobile/plugins/with-android.js",
                     "apps/mobile/src/native/Foo.h", "apps/mobile/assets/icon.png",
                     ".github/workflows/native-checks.yml", "scripts/native_build_scope.py"):
            with self.subTest(path=path):
                self.assertEqual(native_build_scope([path]), "both")

    def test_combined_and_deleted_or_renamed_paths(self):
        self.assertEqual(native_build_scope(["apps/mobile/android/build.gradle", "apps/mobile/ios/a.swift"]), "both")
        # Git supplies both old and new paths for renames with --no-renames.
        self.assertEqual(native_build_scope(["apps/mobile/plugins/native.js", "docs/native.md"]), "both")
        self.assertEqual(native_build_scope([]), "none")


if __name__ == "__main__":
    unittest.main()
