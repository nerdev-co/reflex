import type { Linter } from "eslint";
import { nextJsConfig } from "@repo/eslint-config/next-js";

export const eslintConfig: Linter.Config[] = nextJsConfig;

export default eslintConfig;
