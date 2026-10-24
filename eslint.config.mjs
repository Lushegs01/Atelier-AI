import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: [
      "src/components/ui.tsx",
      "src/features/workspace/**/*.tsx",
      "src/features/try-on/**/*.tsx",
    ],
    // Private signed media and local customer previews must bypass Next's shared public optimizer.
    rules: { "@next/next/no-img-element": "off" },
  },
  globalIgnores([
    ".next/**",
    "node_modules/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);
