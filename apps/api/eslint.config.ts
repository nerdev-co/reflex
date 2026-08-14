import type { Linter } from "eslint";
import { config } from "@repo/eslint-config/base";

export const eslintConfig: Linter.Config[] = config;

export default eslintConfig;