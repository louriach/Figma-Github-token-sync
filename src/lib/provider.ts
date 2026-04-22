export interface FileEntry {
  name: string;
  path: string;
  sha: string;
}

export interface FileContent {
  content: string;
  sha: string;
}

export interface GitProvider {
  validateToken(): Promise<{ login: string }>;
  listRepos(): Promise<string[]>;
  listBranches(owner: string, repo: string): Promise<string[]>;
  /** Creates the branch if it doesn't exist. Returns true if it was created. */
  ensureBranch(owner: string, repo: string, branch: string): Promise<boolean>;
  listFiles(dirPath: string): Promise<FileEntry[]>;
  getFile(filePath: string): Promise<FileContent | null>;
  putFile(filePath: string, content: string, message: string, sha?: string): Promise<void>;
}
