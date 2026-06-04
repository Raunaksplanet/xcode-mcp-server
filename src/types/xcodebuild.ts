export interface BuildIssue {
  type: 'error' | 'warning' | 'note' | 'analyzer-warning';
  message: string;
  file?: string;
  line?: number;
  column?: number;
  fixIt?: string;
}

export interface BuildResult {
  success: boolean;
  scheme: string;
  configuration: string;
  destination?: string;
  buildTimeSeconds: number;
  errors: BuildIssue[];
  warnings: BuildIssue[];
  outputPath?: string;
  outputLog: string;
}

export interface TestResult {
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationSeconds: number;
  failures: TestFailure[];
  outputLog: string;
}

export interface TestFailure {
  testName: string;
  className: string;
  file?: string;
  line?: number;
  message: string;
  diff?: string;
}

export interface CoverageReport {
  overallPercentage: number;
  files: CoverageFile[];
}

export interface CoverageFile {
  file: string;
  percentage: number;
  functions: CoverageFunction[];
}

export interface CoverageFunction {
  name: string;
  percentage: number;
  line: number;
}

export interface ArchiveResult {
  success: boolean;
  archivePath?: string;
  exportPath?: string;
  errors: BuildIssue[];
  warnings: BuildIssue[];
}

export interface AnalyzerIssue {
  category: string;
  file: string;
  line: number;
  column: number;
  description: string;
  pathToTrigger?: string[];
}

export interface XCTraceResult {
  outputPath: string;
  durationSeconds: number;
  hotspots: string[];
  template: string;
}

export interface BuildLogEntry {
  time: string;
  message: string;
  file?: string;
  line?: number;
}

export interface BuildSettings {
  [key: string]: string;
}
