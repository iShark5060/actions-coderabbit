import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
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

function requireEnv(name) {
  const value = process.env[name]
  if (!value || !value.trim()) {
    throw new Error(`${name} is empty.`)
  }
  return value.trim()
}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

function changedFileCount(baseRef) {
  execFileSync('git', ['fetch', '--no-tags', 'origin', `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`], {
    stdio: 'inherit',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  const diff = git(['diff', '--name-only', `origin/${baseRef}...HEAD`])
  return parseChangedFiles(diff).length
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
  if (process.platform === 'win32') {
    throw new Error('This action runs on the Linux runners (light-node26).')
  }
  if (process.env.EVENT_NAME && process.env.EVENT_NAME !== 'pull_request') {
    throw new Error('This action only runs on pull requests.')
  }

  const apiKey = requireEnv('CODERABBIT_API_KEY')
  const forgejoToken = requireEnv('CODERABBIT_TOKEN')
  const apiUrl = requireEnv('FORGEJO_API_URL').replace(/\/$/, '')
  const repo = requireEnv('REPOSITORY')
  const pr = requireEnv('PR_NUMBER')
  const baseRef = requireEnv('BASE_REF')
  const headSha = requireEnv('HEAD_SHA')
  const runUrl = process.env.RUN_URL || ''
  const maxFiles = parseMaxFiles(process.env.MAX_FILES || '150')

  await ensureAlpineTools()
  const count = changedFileCount(baseRef)
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
