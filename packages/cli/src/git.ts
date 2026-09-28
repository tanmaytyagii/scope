/**
 * Git and CI facts recorded on each run, so results can be traced back to the code that
 * produced them. Every lookup is best-effort: SCOPE works outside git repositories.
 */
import { execFileSync } from 'node:child_process';
import type { GitInfo, RunTrigger } from '@scope-ai/core';

function git(args: string[], cwd: string): string | null {
  try {
    return (
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

export function detectTrigger(env: NodeJS.ProcessEnv = process.env): RunTrigger {
  return env.CI === 'true' || env.CI === '1' || env.GITHUB_ACTIONS === 'true' ? 'ci' : 'cli';
}

export function collectGitInfo(cwd: string, env: NodeJS.ProcessEnv = process.env): GitInfo | null {
  if (env.GITHUB_ACTIONS === 'true') {
    const pr = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '');
    return {
      commit: env.GITHUB_SHA ?? git(['rev-parse', 'HEAD'], cwd),
      branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || null,
      dirty: null,
      pullRequest: pr ? Number(pr[1]) : null,
      repository: env.GITHUB_REPOSITORY ?? null,
    };
  }
  const commit = git(['rev-parse', 'HEAD'], cwd);
  if (!commit) return null;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const status = git(['status', '--porcelain', '--untracked-files=no'], cwd);
  const remote = git(['config', '--get', 'remote.origin.url'], cwd);
  const repository = remote ? (/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1] ?? null) : null;
  return {
    commit,
    branch: branch === 'HEAD' ? null : branch,
    dirty: status !== null,
    pullRequest: null,
    repository,
  };
}
