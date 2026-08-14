import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import turboPlugin from "eslint-plugin-turbo";
import tseslint from "typescript-eslint";
import onlyWarn from "eslint-plugin-only-warn";
import type { Linter } from "eslint";

/** The plugin object shape eslint's flat config expects (from @eslint/core). */
type FlatPlugin = NonNullable<Linter.Config["plugins"]>[string];

/**
 * A shared ESLint configuration for the repository.
 */
export const config: Linter.Config[] = [
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  {
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
    },
  },
  {
    plugins: {
      // only-warn's own types don't match eslint's Plugin shape; the runtime
      // shape is correct, so cast at the boundary.
      onlyWarn: onlyWarn as unknown as FlatPlugin,
    },
  },
  {
    ignores: ["dist/**"],
  },
];
