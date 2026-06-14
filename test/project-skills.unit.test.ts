import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bot } from '../src/bot/bot.ts';
import { collapseSkillPrompt, getProjectSkillPaths, initializeProjectSkills } from '../src/agent/index.ts';
import { resolveSkillPrompt } from '../src/bot/commands.ts';
import { captureEnv, makeTmpDir, restoreEnv } from './support/env.ts';

const envSnapshot = captureEnv(['PIKILOOP_CONFIG', 'PIKILOOP_WORKDIR']);

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeSkill(root: string, name: string, body: string) {
  writeFile(path.join(root, name, 'SKILL.md'), body);
}

beforeEach(() => {
  restoreEnv(envSnapshot);
  process.env.PIKILOOP_CONFIG = path.join(makeTmpDir('pikiloop-config-'), 'setting.json');
});

afterEach(() => {
  restoreEnv(envSnapshot);
});

describe('project skills', () => {
  it('resolves skill paths, routes per-agent, merges legacy roots, and collapses shorthand', () => {
    // resolves claude skills with canonical project paths and injects context
    {
      const workdir = makeTmpDir('pikiloop-claude-skill-');
      writeSkill(path.join(workdir, '.pikiloop', 'skills'), 'install', '---\nlabel: Install\ndescription: shared\n---\n');
      writeSkill(path.join(workdir, '.claude', 'skills'), 'install', '---\nlabel: Install\ndescription: claude\n---\n');

      const bot = new Bot();
      bot.switchWorkdir(workdir, { persist: false });
      bot.chat(1).agent = 'claude';

      expect(getProjectSkillPaths(workdir, 'install')).toEqual({
        sharedSkillFile: path.join(workdir, '.pikiloop', 'skills', 'install', 'SKILL.md'),
        claudeSkillFile: path.join(workdir, '.claude', 'skills', 'install', 'SKILL.md'),
        agentsSkillFile: path.join(workdir, '.agents', 'skills', 'install', 'SKILL.md'),
      });

      const resolved = resolveSkillPrompt(bot, 1, 'sk_install', 'ship it');
      expect(resolved).not.toBeNull();
      expect(resolved!.skillName).toBe('install');
      expect(resolved!.prompt).toContain(workdir);
      expect(resolved!.prompt).toContain('.claude/skills/install/SKILL.md');
      expect(resolved!.prompt).toContain('Additional context: ship it');
    }

    // routes codex skills to project skill files instead of hard-coding .claude paths
    {
      const workdir = makeTmpDir('pikiloop-codex-skill-');
      writeSkill(path.join(workdir, '.pikiloop', 'skills'), 'fixup', '---\nlabel: Fixup\ndescription: shared\n---\n');
      writeSkill(path.join(workdir, '.agents', 'skills'), 'fixup', '---\nlabel: Fixup\ndescription: agents\n---\n');

      const bot = new Bot();
      bot.switchWorkdir(workdir, { persist: false });
      bot.chat(2).agent = 'codex';

      const resolved = resolveSkillPrompt(bot, 2, 'sk_fixup', '');
      expect(resolved).not.toBeNull();
      expect(resolved!.skillName).toBe('fixup');
      expect(resolved!.prompt).toContain(workdir);
      expect(resolved!.prompt).toContain('.claude/skills/fixup/SKILL.md');
    }

    // merges legacy skill roots into .pikiloop/skills and links .claude/.agents back to canonical
    {
      const workdir = makeTmpDir('pikiloop-migrate-skill-');
      writeSkill(path.join(workdir, '.pikiloop', 'skills'), 'ship', '---\nlabel: Ship\ndescription: shared\n---\n');
      writeFile(path.join(workdir, '.pikiloop', 'skills', 'ship', 'references', 'shared.txt'), 'shared\n');
      writeSkill(path.join(workdir, '.claude', 'skills'), 'ship', '---\nlabel: Ship\ndescription: claude\n---\n');
      writeFile(path.join(workdir, '.claude', 'skills', 'ship', 'references', 'claude.txt'), 'preserved\n');
      writeSkill(path.join(workdir, '.agents', 'skills'), 'package', '---\nlabel: Package\ndescription: agents\n---\n');

      initializeProjectSkills(workdir);

      // .pikiloop/skills becomes the canonical real directory
      expect(fs.lstatSync(path.join(workdir, '.pikiloop', 'skills')).isSymbolicLink()).toBe(false);
      // Canonical content keeps existing shared files and merges in legacy ones
      expect(fs.readFileSync(path.join(workdir, '.pikiloop', 'skills', 'ship', 'SKILL.md'), 'utf8')).toContain('description: shared');
      expect(fs.existsSync(path.join(workdir, '.pikiloop', 'skills', 'ship', 'references', 'shared.txt'))).toBe(true);
      expect(fs.existsSync(path.join(workdir, '.pikiloop', 'skills', 'ship', 'references', 'claude.txt'))).toBe(true);
      expect(fs.existsSync(path.join(workdir, '.pikiloop', 'skills', 'package', 'SKILL.md'))).toBe(true);
      // .claude and .agents both become symlinks to canonical
      expect(fs.lstatSync(path.join(workdir, '.claude', 'skills')).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(workdir, '.agents', 'skills')).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(path.join(workdir, '.claude', 'skills'))).toBe(fs.realpathSync(path.join(workdir, '.pikiloop', 'skills')));
      expect(fs.realpathSync(path.join(workdir, '.agents', 'skills'))).toBe(fs.realpathSync(path.join(workdir, '.pikiloop', 'skills')));
    }

    // collapses canonical skill expansions back to the slash command shorthand
    {
      const workdir = makeTmpDir('pikiloop-collapse-skill-');
      writeSkill(path.join(workdir, '.pikiloop', 'skills'), 'install', '---\nlabel: Install\n---\n');
      const bot = new Bot();
      bot.switchWorkdir(workdir, { persist: false });
      bot.chat(7).agent = 'claude';

      // Round-trip: produce the expansion, then verify the inverse returns `/install`.
      const noArgs = resolveSkillPrompt(bot, 7, 'sk_install', '');
      expect(noArgs).not.toBeNull();
      expect(collapseSkillPrompt(noArgs!.prompt)).toBe('/install');

      const withArgs = resolveSkillPrompt(bot, 7, 'sk_install', 'ship it now');
      expect(withArgs).not.toBeNull();
      expect(collapseSkillPrompt(withArgs!.prompt)).toBe('/install ship it now');

      // The claude driver collapses interior whitespace before surfacing user
      // messages. Make sure we still recognize that single-space variant.
      const flattened = noArgs!.prompt.replace(/\s+/g, ' ').trim();
      expect(collapseSkillPrompt(flattened)).toBe('/install');

      // Free-form text and partial matches should not collapse.
      expect(collapseSkillPrompt('hello world')).toBeNull();
      expect(collapseSkillPrompt('')).toBeNull();
      expect(collapseSkillPrompt(null)).toBeNull();
      expect(collapseSkillPrompt('[Project directory: /tmp]\n\nbuild the app')).toBeNull();
    }
  });
});
