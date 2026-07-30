export interface LanguageServerDefinition {
  id: string;
  languages: string[];
  extensions: string[];
  command: string;
  args?: string[];
  initializationOptions?: unknown;
}

export interface CodeLocation {
  uri: string;
  line: number;
  character: number;
  endLine?: number;
  endCharacter?: number;
}

export interface WorkspaceSymbol {
  name: string;
  kind?: number;
  containerName?: string;
  location: CodeLocation;
}

export interface CodeDiagnostic {
  uri: string;
  message: string;
  severity?: number;
  source?: string;
  code?: string | number;
  range: CodeLocation;
}

export interface LanguageServerCapability {
  id: string;
  languages: string[];
  available: boolean;
  reason?: string;
}
