import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: ["main.js", "node_modules/**", "*.mjs"],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      // The recommended obsidianmd set flags a few intentional, guideline-permitted
      // patterns. Disable each here with a justification, the way Easy-Git turns off
      // "obsidianmd/ui/sentence-case" and "obsidianmd/rule-custom-message".

      // Settings names and the failure Notice are deliberate product copy
      // ("Hub Sidebar", the literal outline header "ON THIS PAGE", "Graph /
      // Incoming / Outgoing"). Forcing sentence-case would mangle those.
      "obsidianmd/ui/sentence-case": "off",

      // The plugin drives outline-tier limiting through a class on `document.body`
      // and cleans up `.hub-switcher` nodes with `document.querySelectorAll`. The
      // body class is a single window-global toggle (CSS does the per-pane hiding),
      // so `activeDocument` would be wrong here, not an improvement.
      "obsidianmd/prefer-active-doc": "off",
    },
  },
]);
