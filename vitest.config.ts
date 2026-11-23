import { configDefaults, defineConfig } from "vitest/config";

// Alleen de eigen tests van deze repo. Zonder deze config verzamelt vitest ook
// elke test in de geneste worktrees (.worktrees/ en .claude/worktrees/ in een
// primaire checkout): 261 bestanden in plaats van de 55 onder test/. Dat liet
// een lokale release falen, want die testte vóór de versiebump.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".worktrees/**", ".claude/worktrees/**"],
  },
});
