/**
 * @brainpilot/skills — bundled Agent Skills content package.
 *
 * This package is pure CONTENT: the `skills/` directory holds the built-in
 * education-research, neuroscience, cognitive-science, and writing skills as
 * `SKILL.md` files (with YAML frontmatter `name` / `description`), laid out as
 * `<category>/<skill>/SKILL.md`.
 *
 * At deploy time the runtime/CLI materialize files into user-editable skill
 * libraries. Meta-skills load through Pi's native skill pipeline; domain
 * skills are found and read on demand through `skill_search`. The runtime
 * profile selects education skills by default and exposes neuroscience
 * skills when explicitly selected.
 *
 * The only thing this module exports is the absolute path to the bundled
 * `skills/` directory, so the runtime/CLI can locate it for materialization via
 * `require.resolve("@brainpilot/skills")` regardless of install layout
 * (workspace symlink, flat npm node_modules, or Docker image).
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the bundled skills/ directory. Lives at the package root,
 * one level above the compiled `dist/` (or `src/`) dir.
 */
export const BUNDLED_SKILLS_DIR = resolve(join(__dirname, "..", "skills"));
