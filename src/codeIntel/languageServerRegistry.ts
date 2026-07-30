import { access } from 'node:fs/promises';
import path from 'node:path';

import type { LanguageServerCapability, LanguageServerDefinition } from './types.js';

export class LanguageServerRegistry {
  private readonly definitions: LanguageServerDefinition[];

  constructor(definitions: LanguageServerDefinition[] = []) {
    this.definitions = definitions.map(definition => ({
      ...definition,
      languages: [...definition.languages],
      extensions: definition.extensions.map(extension =>
        extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
      ),
      args: [...(definition.args ?? [])],
    }));
  }

  list(): LanguageServerDefinition[] {
    return this.definitions.map(definition => structuredClone(definition));
  }

  forFile(filePath: string): LanguageServerDefinition | undefined {
    const extension = path.extname(filePath).toLowerCase();
    return this.definitions.find(definition => definition.extensions.includes(extension));
  }

  async capabilities(): Promise<LanguageServerCapability[]> {
    return Promise.all(this.definitions.map(async definition => {
      const available = await commandAvailable(definition.command);
      return {
        id: definition.id,
        languages: [...definition.languages],
        available,
        ...(!available ? { reason: `Configured command is unavailable: ${definition.command}` } : {}),
      };
    }));
  }
}

async function commandAvailable(command: string): Promise<boolean> {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return access(command).then(() => true, () => false);
  }
  const pathValue = process.env.PATH ?? '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of pathValue.split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (await access(candidate).then(() => true, () => false)) return true;
    }
  }
  return false;
}
