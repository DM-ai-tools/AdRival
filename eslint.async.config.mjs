import tseslint from "typescript-eslint";

// Type-aware async-safety rules only. Run with `npm run lint:async`.
export default tseslint.config(
  { ignores: ["**/node_modules/**", ".next/**", "canvases/**"] },
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "off" },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
);
