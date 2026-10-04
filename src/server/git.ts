import { execFile } from 'node:child_process'
import path from 'node:path'

// Read-only git plumbing for repo-backed files. Every call is scoped to the
// directory of the file it concerns, so linked worktrees and submodules work.

export interface Commit {
  sha: string
  short: string
  author: string
  date: string
  subject: string
  /** The file's path (relative to the repo root) at that commit, which --follow tracks across renames. */
  path: string
}

export interface GitFileStatus {
  /** Repo toplevel, or null when the file isn't inside a git work tree. */
  root: string | null
  branch: string | null
  /** Path relative to the repo root. */
  rel: string
  state: 'clean' | 'modified' | 'untracked' | 'unversioned'
}

function git(cwd: string, args: string[], binary = false): Promise<Buffer | string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 256 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim()))
        else resolve(stdout)
      },
    )
  })
}

// SAFETY: git defaults to utf8 encoding so stdout resolves as a string.
const text = (cwd: string, args: string[]) => git(cwd, args) as Promise<string>

export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return (await text(dir, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return null
  }
}

export async function fileStatus(file: string): Promise<GitFileStatus> {
  const dir = path.dirname(file)
  const root = await repoRoot(dir)

  if (!root) return { root: null, branch: null, rel: path.basename(file), state: 'unversioned' }
  const rel = path.relative(root, file).split(path.sep).join('/')

  const [branch, porcelain] = await Promise.all([
    text(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).then(
      (s) => s.trim(),
      () => null,
    ),
    text(root, ['status', '--porcelain', '--', rel]).catch(() => ''),
  ])

  const code = porcelain.slice(0, 2)
  const state = !porcelain ? 'clean' : code === '??' ? 'untracked' : 'modified'

  return { root, branch: branch === 'HEAD' ? null : branch, rel, state }
}

/** Commits that touched the file, newest first. */
export async function fileLog(file: string, limit = 50): Promise<Commit[]> {
  const root = await repoRoot(path.dirname(file))

  if (!root) return []
  const rel = path.relative(root, file).split(path.sep).join('/')
  let out: string

  try {
    out = await text(root, [
      'log',
      '--follow',
      `-n${limit}`,
      '--name-only',
      '--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s',
      '--',
      rel,
    ])
  } catch {
    return [] // no commits yet
  }

  return out
    .split('\x1e')
    .filter((s) => s.trim())
    .map((chunk) => {
      const [head, ...rest] = chunk.split('\n')
      const [sha, short, author, date, subject] = head.split('\x1f')

      return { sha, short, author, date, subject, path: rest.find((l) => l.trim())?.trim() ?? rel }
    })
}

/** Resolve a revision ("HEAD", "main", "abc123", "HEAD~2") to a full sha. */
export async function resolveRev(dir: string, rev: string): Promise<string> {
  if (!/^[\w./~^@{}-]+$/.test(rev) || rev.startsWith('-'))
    throw new Error(`Invalid revision "${rev}"`)

  try {
    return (await text(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim()
  } catch {
    throw new Error(`Unknown revision "${rev}"`)
  }
}

/** A file's contents at a commit; `rel` is relative to the repo root. Null when it didn't exist there. */
export async function showFile(root: string, sha: string, rel: string): Promise<Buffer | null> {
  try {
    // SAFETY: git is called with binary=true so stdout resolves as a Buffer.
    return (await git(root, ['show', `${sha}:${rel}`], true)) as Buffer
  } catch {
    return null
  }
}

export interface Worktree {
  path: string
  /** Short branch name, null when detached. */
  branch: string | null
  head: string
  /** The repo's main checkout (the first entry of `git worktree list`). */
  main: boolean
}

/** Every checkout of the repo: the main one first, then linked worktrees. */
export async function worktrees(dir: string): Promise<Worktree[]> {
  let out: string

  try {
    out = await text(dir, ['worktree', 'list', '--porcelain'])
  } catch {
    return []
  }

  return out
    .split('\n\n')
    .filter((b) => b.startsWith('worktree '))
    .filter((b) => !/^prunable/m.test(b))
    .map((block, i) => {
      const field = (k: string) => block.match(new RegExp(`^${k} (.*)$`, 'm'))?.[1] ?? null
      const branch = field('branch')

      return {
        path: field('worktree')!,
        branch: branch?.replace(/^refs\/heads\//, '') ?? null,
        head: field('HEAD') ?? '',
        main: i === 0,
      }
    })
}

/** Local branches, most recently committed first. */
export async function branches(dir: string): Promise<{ name: string; date: string }[]> {
  try {
    const out = await text(dir, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)%1f%(committerdate:iso-strict)',
      'refs/heads',
    ])

    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, date] = l.split('\x1f')

        return { name, date }
      })
  } catch {
    return []
  }
}

/** Files under `dir` (repo-relative) at a revision. */
export async function listTree(root: string, rev: string, dir: string): Promise<string[]> {
  try {
    return (await text(root, ['ls-tree', '-r', '--name-only', rev, '--', dir]))
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

/** When a revision was committed (ISO). */
export async function commitDate(root: string, rev: string): Promise<string> {
  try {
    return (await text(root, ['log', '-1', '--format=%cI', rev])).trim()
  } catch {
    return ''
  }
}

/** Who commits in this checkout, per git config. */
export async function gitUser(dir: string): Promise<{ name: string; email: string }> {
  const get = (key: string) =>
    text(dir, ['config', key]).then(
      (s) => s.trim(),
      () => '',
    )

  const [name, email] = await Promise.all([get('user.name'), get('user.email')])

  return { name, email }
}

export interface FileChange {
  status: 'added' | 'modified' | 'deleted'
  path: string
  from: string
}

export async function mergeBase(root: string, a: string, b: string): Promise<string> {
  try {
    return (await text(root, ['merge-base', a, b])).trim()
  } catch {
    return a
  }
}

export async function changedFiles(
  root: string,
  base: string,
  head: string | null,
  pathspec: string,
): Promise<FileChange[]> {
  const out = await text(root, [
    'diff',
    '--name-status',
    '-z',
    '-M',
    base,
    ...(head ? [head] : []),
    '--',
    pathspec,
  ])

  const parts = out.split('\0')
  const changes: FileChange[] = []

  for (let i = 0; i < parts.length - 1;) {
    const code = parts[i++]

    if (code.startsWith('R') || code.startsWith('C')) {
      const from = parts[i++]
      const to = parts[i++]
      changes.push({ status: code.startsWith('R') ? 'modified' : 'added', path: to, from })
    } else {
      const file = parts[i++]
      const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified'
      changes.push({ status, path: file, from: file })
    }
  }

  if (!head)
    for (const file of (
      await text(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', pathspec])
    ).split('\0'))
      if (file) changes.push({ status: 'added', path: file, from: file })

  return changes
}

export async function hasGitHubRemote(dir: string): Promise<boolean> {
  try {
    return /github\.com[:/]/.test(await text(dir, ['remote', '-v']))
  } catch {
    return false
  }
}
