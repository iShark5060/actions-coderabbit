import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REVIEW_MARKER = '<!-- coderabbit-review -->'
const FINDING_MARKER = '<!-- coderabbit-finding -->'
const SEVERITY_ORDER = ['critical', 'major', 'minor', 'trivial', 'info', 'none']

export function parseChangedFiles(diffText) {
  return String(diffText)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function isOverFileLimit(count, maxFiles) {
  return count > maxFiles
}

export function alpinePackages({ hasCurl, hasGit }) {
  const packages = []
  if (!hasCurl) packages.push('curl', 'ca-certificates')
  if (!hasGit) packages.push('git')
  return packages
}

export function fileLimitMessage(count, maxFiles) {
  const fileWord = count === 1 ? 'file' : 'files'
  return `CodeRabbit was not run. This pull request changes ${count} ${fileWord}, which is over the ${maxFiles} file limit.`
}

function pick(env, ...keys) {
  for (const key of keys) {
    const value = env[key]
    if (value != null && String(value).trim()) return String(value).trim()
  }
  return ''
}

export function resolveActionEnv(env, event = {}) {
  const pr = event.pull_request || {}
  const server = pick(env, 'GITHUB_SERVER_URL').replace(/\/$/, '')
  const repo = pick(env, 'REPOSITORY', 'GITHUB_REPOSITORY')
  const runId = pick(env, 'GITHUB_RUN_ID')
  const apiUrl = pick(env, 'FORGEJO_API_URL', 'GITHUB_API_URL').replace(/\/$/, '')
  const runUrl = pick(env, 'RUN_URL')
  return {
    CODERABBIT_API_KEY: pick(env, 'CODERABBIT_API_KEY', 'INPUT_CODERABBIT_API_KEY'),
    CODERABBIT_TOKEN: pick(env, 'CODERABBIT_TOKEN', 'INPUT_FORGEJO_TOKEN'),
    MAX_FILES: pick(env, 'MAX_FILES', 'INPUT_MAX_FILES') || '150',
    FORGEJO_API_URL: apiUrl,
    REPOSITORY: repo,
    PR_NUMBER: pick(env, 'PR_NUMBER') || (pr.number == null ? '' : String(pr.number)),
    BASE_REF: pick(env, 'BASE_REF', 'GITHUB_BASE_REF') || pr.base?.ref || '',
    HEAD_SHA: pick(env, 'HEAD_SHA') || pr.head?.sha || pick(env, 'GITHUB_SHA'),
    RUN_URL: runUrl || (server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : ''),
    EVENT_NAME: pick(env, 'EVENT_NAME', 'GITHUB_EVENT_NAME'),
    SERVER_URL: server || apiUrl.replace(/\/api\/v1$/, ''),
    HISTORY_TOKEN: pick(env, 'GITHUB_TOKEN', 'CODERABBIT_TOKEN', 'INPUT_FORGEJO_TOKEN'),
  }
}

export function repositoryGitUrl(serverUrl, repo) {
  return `${String(serverUrl).replace(/\/$/, '')}/${repo}.git`
}

export function parseMaxFiles(value) {
  const maxFiles = Number.parseInt(String(value), 10)
  if (!Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new Error(`max_files must be a positive integer, got ${value}`)
  }
  return maxFiles
}

export function repoRelativePath(fileName, workspace) {
  if (!fileName) return ''
  const normalized = String(fileName).replaceAll('\\', '/').replace(/^\.\//, '')
  if (!workspace) return normalized
  const prefix = String(workspace).replaceAll('\\', '/').replace(/\/$/, '') + '/'
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
}

export function parseAgentStream(text) {
  const findings = []
  let error = null
  let complete = null
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event.type === 'finding') findings.push(event)
    else if (event.type === 'error') error = event
    else if (event.type === 'complete') complete = event
  }
  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
  return { findings, error, complete }
}

export function reviewFailed(complete, error, exitCode) {
  if (error) return true
  if (exitCode !== 0) return true
  if (complete?.outcome === 'failed') return true
  if (Number(complete?.unreviewedFileCount) > 0) return true
  return false
}

export function errorText(event) {
  if (!event) return 'CodeRabbit review failed.'
  return (
    event.message ||
    event.error ||
    event.msg ||
    event.errorType ||
    'CodeRabbit review failed.'
  )
}

export function buildReview(findings, { full = false, runUrl = '', workspace = '' } = {}) {
  const inline = []
  const lines = [REVIEW_MARKER, '']
  if (findings.length === 0) {
    lines.push('**CodeRabbit** reviewed this pull request and found no issues.')
  } else {
    const issueWord = findings.length === 1 ? 'issue' : 'issues'
    lines.push(`**CodeRabbit** found ${findings.length} ${issueWord}.`)
    lines.push('')
    for (const finding of findings) {
      lines.push(summaryLine(finding, workspace))
      const line = lineNumber(finding)
      const filePath = repoRelativePath(finding.fileName, workspace)
      if (!full && filePath && line) {
        inline.push(inlineComment(finding, filePath, line))
      } else {
        const detail = findingDetail(finding)
        if (detail) {
          lines.push('', detail, '')
        }
      }
    }
  }
  if (runUrl) {
    lines.push('', `[Job log](${runUrl})`)
  }
  return { body: capBody(lines.join('\n').trim() + '\n'), comments: inline }
}

export function buildFailureReview(message, runUrl = '') {
  const lines = [REVIEW_MARKER, '', '**CodeRabbit** did not finish this review.', '', message]
  if (runUrl) lines.push('', `[Job log](${runUrl})`)
  return capBody(lines.join('\n').trim() + '\n')
}

export async function publishReview({ request, repo, pr, body, comments, commitId }) {
  const payload = {
    event: 'COMMENT',
    body,
    commit_id: commitId,
  }
  if (comments.length > 0) payload.comments = comments
  return request('POST', `/repos/${repo}/pulls/${pr}/reviews`, payload)
}

function summaryLine(finding, workspace) {
  const severity = finding.severity || 'info'
  const where = location(finding, workspace)
  const title = oneLine(finding.title || finding.comment || finding.codegenInstructions || 'Finding')
  return where ? `- **${severity}** ${where} ${title}` : `- **${severity}** ${title}`
}

function location(finding, workspace) {
  const filePath = repoRelativePath(finding.fileName, workspace)
  if (!filePath) return ''
  const line = lineNumber(finding)
  return line ? `\`${filePath}:${line}\`` : `\`${filePath}\``
}

function lineNumber(finding) {
  const line = Number(finding.startLine)
  return Number.isInteger(line) && line > 0 ? line : 0
}

function inlineComment(finding, path, line) {
  const end = Number(finding.endLine)
  const extra = Number.isInteger(end) && end > line ? end - line : 0
  const comment = {
    path,
    body: [FINDING_MARKER, '', findingBody(finding)].join('\n'),
    new_position: line,
  }
  if (extra > 0) comment.extra_lines_count = extra
  return comment
}

function findingBody(finding) {
  const severity = finding.severity || 'info'
  const title = oneLine(finding.title || 'Finding')
  const detail = findingDetail(finding)
  const parts = [`**${severity}** ${title}`]
  if (detail && detail !== title) parts.push('', detail)
  return parts.join('\n')
}

function findingDetail(finding) {
  const comment = String(finding.comment || '').trim()
  const instructions = String(finding.codegenInstructions || '').trim()
  const text = comment || instructions
  const suggestion = suggestionText(finding.suggestions)
  return [text, suggestion].filter(Boolean).join('\n\n')
}

function suggestionText(suggestions) {
  if (!suggestions) return ''
  if (typeof suggestions === 'string') return suggestions.trim()
  if (!Array.isArray(suggestions)) return ''
  return suggestions
    .map((suggestion) => {
      if (typeof suggestion === 'string') return suggestion.trim()
      if (suggestion && typeof suggestion === 'object') {
        return String(suggestion.snippet || suggestion.command || suggestion.text || '').trim()
      }
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function oneLine(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity)
  return index === -1 ? SEVERITY_ORDER.length : index
}

function capBody(text, limit = 60000) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\nThe review comment was cut here. The rest is in the job log.\n`
}

function annotation(level, message) {
  const text = String(message).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
  console.log(`::${level}::${text}`)
}

function gitArgs(args, token) {
  return token ? ['-c', `http.extraHeader=AUTHORIZATION: token ${token}`, ...args] : args
}

function git(args, token) {
  return execFileSync('git', gitArgs(args, token), {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

function runGit(args, token) {
  execFileSync('git', gitArgs(args, token), {
    stdio: 'inherit',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

function changedFileCount(baseRef, token) {
  runGit(['fetch', '--no-tags', 'origin', `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`], token)
  const diff = git(['diff', '--name-only', `origin/${baseRef}...HEAD`], token)
  return parseChangedFiles(diff).length
}

function loadEvent() {
  const path = process.env.GITHUB_EVENT_PATH
  if (!path || !existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function ensureHistory(settings) {
  if (existsSync('.git')) return
  if (!settings.HEAD_SHA || !settings.BASE_REF || !settings.REPOSITORY || !settings.SERVER_URL) {
    throw new Error('The checkout has no git history, and the pull request ref is missing.')
  }
  console.log('The checkout has no git history. Fetching the pull request.')
  const token = settings.HISTORY_TOKEN
  runGit(['init'], token)
  runGit(['remote', 'add', 'origin', repositoryGitUrl(settings.SERVER_URL, settings.REPOSITORY)], token)
  runGit(
    [
      'fetch',
      '--no-tags',
      'origin',
      settings.HEAD_SHA,
      `+refs/heads/${settings.BASE_REF}:refs/remotes/origin/${settings.BASE_REF}`,
    ],
    token,
  )
  runGit(['checkout', '--force', '--detach', settings.HEAD_SHA], token)
}

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      if (capture) stdout += chunk
      else process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      process.stderr.write(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function forgejoRequest(apiUrl, token, method, path, body) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  if (!response.ok) {
    const error = new Error(`${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`)
    error.status = response.status
    throw error
  }
  return text ? JSON.parse(text) : null
}

function commandExists(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function ensureAlpineTools() {
  if (!existsSync('/etc/alpine-release')) return
  const packages = alpinePackages({
    hasCurl: commandExists('curl'),
    hasGit: commandExists('git'),
  })
  if (packages.length === 0) return
  const install = await run('apk', ['add', '--no-cache', ...packages])
  if (install.code !== 0) {
    throw new Error(`Could not install ${packages.join(' ')} on Alpine.`)
  }
}

async function coderabbitBin() {
  const install = await run('sh', ['-c', 'curl -fsSL https://cli.coderabbit.ai/install.sh | sh'])
  if (install.code !== 0) {
    throw new Error('CodeRabbit CLI install failed.')
  }
  return join(homedir(), '.local', 'bin', 'coderabbit')
}

async function main() {
  const settings = resolveActionEnv(process.env, loadEvent())
  if (process.platform === 'win32') {
    throw new Error('This action runs on the Linux runners (light-node26).')
  }
  if (settings.EVENT_NAME && settings.EVENT_NAME !== 'pull_request') {
    throw new Error('This action only runs on pull requests.')
  }

  const apiKey = settings.CODERABBIT_API_KEY
  const forgejoToken = settings.CODERABBIT_TOKEN
  const apiUrl = settings.FORGEJO_API_URL
  const repo = settings.REPOSITORY
  const pr = settings.PR_NUMBER
  const baseRef = settings.BASE_REF
  const headSha = settings.HEAD_SHA
  const runUrl = settings.RUN_URL
  for (const [name, value] of [
    ['CODERABBIT_API_KEY', apiKey],
    ['CODERABBIT_TOKEN', forgejoToken],
    ['FORGEJO_API_URL', apiUrl],
    ['REPOSITORY', repo],
    ['PR_NUMBER', pr],
    ['BASE_REF', baseRef],
    ['HEAD_SHA', headSha],
  ]) {
    if (!value) throw new Error(`${name} is empty.`)
  }
  const maxFiles = parseMaxFiles(settings.MAX_FILES)

  await ensureAlpineTools()
  await ensureHistory(settings)
  const count = changedFileCount(baseRef, settings.HISTORY_TOKEN)
  console.log(`Changed files: ${count}`)
  if (count === 0) {
    console.log('No changed files. Skipping CodeRabbit.')
    return
  }
  if (isOverFileLimit(count, maxFiles)) {
    const message = fileLimitMessage(count, maxFiles)
    annotation('warning', message)
    const failure = new Error(message)
    failure.warning = true
    throw failure
  }

  const bin = await coderabbitBin()
  const login = await run(bin, ['auth', 'login', '--api-key', apiKey])
  if (login.code !== 0) {
    throw new Error('CodeRabbit authentication failed.')
  }

  const review = await run(bin, ['review', '--agent', '--base', `origin/${baseRef}`], { capture: true })
  const parsed = parseAgentStream(review.stdout)
  const request = (method, path, body) => forgejoRequest(apiUrl, forgejoToken, method, path, body)
  const failed = reviewFailed(parsed.complete, parsed.error, review.code)

  if (parsed.complete?.status === 'review_skipped' && !failed) {
    console.log('CodeRabbit found no changes to review.')
    return
  }

  if (failed && parsed.findings.length === 0) {
    const message = errorText(parsed.error || parsed.complete) || review.stderr.trim() || 'CodeRabbit review failed.'
    try {
      await publishReview({
        request,
        repo,
        pr,
        commitId: headSha,
        body: buildFailureReview(message, runUrl),
        comments: [],
      })
    } catch (postErr) {
      annotation('warning', `Could not post the CodeRabbit failure on the pull request. ${postErr.message}`)
    }
    throw new Error(message)
  }

  const workspace = process.env.GITHUB_WORKSPACE || ''
  const compact = buildReview(parsed.findings, { runUrl, workspace })
  const full = buildReview(parsed.findings, { full: true, runUrl, workspace })
  try {
    await publishReview({
      request,
      repo,
      pr,
      commitId: headSha,
      body: compact.comments.length ? compact.body : full.body,
      comments: compact.comments,
    })
  } catch (err) {
    const inlineRejected = compact.comments.length > 0 && err.status >= 400 && err.status < 500
    if (!inlineRejected) throw err
    annotation('warning', `Inline comments were rejected. Posting the summary only. ${err.message}`)
    await publishReview({
      request,
      repo,
      pr,
      commitId: headSha,
      body: full.body,
      comments: [],
    })
  }

  if (failed) {
    throw new Error(errorText(parsed.error || parsed.complete))
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main().catch((err) => {
    if (!err.warning) annotation('error', err.message)
    console.error(err.message)
    process.exit(1)
  })
}
