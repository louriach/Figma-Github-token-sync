import type { GitProvider, FileEntry, FileContent } from './provider';

export class GitLabProvider implements GitProvider {
  private readonly base = 'https://gitlab.com/api/v4';
  private readonly projectId: string;

  constructor(
    private token: string,
    private owner: string,
    private repo: string,
    private branch: string
  ) {
    this.projectId = encodeURIComponent(`${owner}/${repo}`);
  }

  private headers(): HeadersInit {
    return {
      'PRIVATE-TOKEN': this.token,
      'Content-Type': 'application/json',
    };
  }

  async validateToken(): Promise<{ login: string }> {
    const res = await fetch(`${this.base}/user`, { headers: this.headers() });
    if (!res.ok) throw new Error(`GitLab auth failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return { login: data.username };
  }

  async listRepos(): Promise<string[]> {
    const repos: string[] = [];
    let page = 1;
    while (true) {
      const res = await fetch(
        `${this.base}/projects?membership=true&per_page=100&page=${page}&order_by=last_activity_at`,
        { headers: this.headers() }
      );
      if (!res.ok) throw new Error(`GitLab list repos failed: ${res.status} ${res.statusText}`);
      const data: Array<{ path_with_namespace: string }> = await res.json();
      if (data.length === 0) break;
      repos.push(...data.map((r) => r.path_with_namespace));
      if (data.length < 100) break;
      page++;
    }
    return repos;
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const branches: string[] = [];
    let page = 1;
    while (true) {
      const res = await fetch(
        `${this.base}/projects/${projectId}/repository/branches?per_page=100&page=${page}`,
        { headers: this.headers() }
      );
      if (!res.ok) throw new Error(`GitLab list branches failed: ${res.status} ${res.statusText}`);
      const data: Array<{ name: string }> = await res.json();
      if (data.length === 0) break;
      branches.push(...data.map((b) => b.name));
      if (data.length < 100) break;
      page++;
    }
    return branches;
  }

  async ensureBranch(owner: string, repo: string, branch: string): Promise<boolean> {
    const projectId = encodeURIComponent(`${owner}/${repo}`);

    // Check if branch exists
    const checkRes = await fetch(
      `${this.base}/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`,
      { headers: this.headers() }
    );
    if (checkRes.ok) return false;

    // Get default branch
    const projectRes = await fetch(`${this.base}/projects/${projectId}`, { headers: this.headers() });
    if (!projectRes.ok) throw new Error(`Cannot read project info: ${projectRes.status}`);
    const projectData = await projectRes.json();
    const defaultBranch: string = projectData.default_branch;

    // Create branch from default
    const createRes = await fetch(`${this.base}/projects/${projectId}/repository/branches`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ branch, ref: defaultBranch }),
    });
    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({ message: createRes.statusText }));
      throw new Error(`GitLab create branch failed: ${createRes.status} – ${err.message}`);
    }
    return true;
  }

  async listFiles(dirPath: string): Promise<FileEntry[]> {
    const path = dirPath.replace(/\/$/, '');
    const url = new URL(`${this.base}/projects/${this.projectId}/repository/tree`);
    url.searchParams.set('path', path);
    url.searchParams.set('ref', this.branch);
    url.searchParams.set('per_page', '100');

    const res = await fetch(url.toString(), { headers: this.headers() });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`GitLab list failed: ${res.status} ${res.statusText}`);

    const data = await res.json();
    return (data as Array<{ type: string; name: string; path: string; id: string }>)
      .filter((f) => f.type === 'blob' && f.name.endsWith('.json'))
      .map((f) => ({ name: f.name, path: f.path, sha: f.id }));
  }

  async getFile(filePath: string): Promise<FileContent | null> {
    const encodedPath = encodeURIComponent(filePath);
    const res = await fetch(
      `${this.base}/projects/${this.projectId}/repository/files/${encodedPath}?ref=${this.branch}`,
      { headers: this.headers() }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitLab get failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const bytes = Uint8Array.from(atob(data.content), (c) => c.charCodeAt(0));
    return { content: new TextDecoder().decode(bytes), sha: data.content_sha256 };
  }

  async putFile(
    filePath: string,
    content: string,
    message: string,
    _sha?: string
  ): Promise<void> {
    const encodedPath = encodeURIComponent(filePath);
    const existingFile = await this.getFile(filePath);
    const method = existingFile ? 'PUT' : 'POST';

    const res = await fetch(
      `${this.base}/projects/${this.projectId}/repository/files/${encodedPath}`,
      {
        method,
        headers: this.headers(),
        body: JSON.stringify({
          branch: this.branch,
          content,
          commit_message: message,
          encoding: 'text',
        }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`GitLab put failed: ${res.status} – ${err.message}`);
    }
  }
}
