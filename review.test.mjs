import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  alpinePackages,
  buildReview,
  fileLimitMessage,
  isOverFileLimit,
  parseAgentStream,
  parseChangedFiles,
  parseMaxFiles,
  publishReview,
  repoRelativePath,
  repositoryGitUrl,
  resolveActionEnv,
  reviewFailed,
  scriptMatchesEntry,
} from './review.mjs'

test('asks Alpine for curl, git, and openssl only when they are missing', () => {
  assert.deepEqual(alpinePackages({ hasCurl: true, hasGit: true, hasOpenssl: true }), [])
  assert.deepEqual(alpinePackages({ hasCurl: false, hasGit: true, hasOpenssl: true }), ['curl', 'ca-certificates'])
  assert.deepEqual(alpinePackages({ hasCurl: true, hasGit: false, hasOpenssl: true }), ['git'])
  assert.deepEqual(alpinePackages({ hasCurl: true, hasGit: true, hasOpenssl: false }), ['openssl'])
})

test('counts changed files and allows the 150 file cap', () => {
  assert.deepEqual(parseChangedFiles('src/a.js\nsrc/b.js\n\n'), ['src/a.js', 'src/b.js'])
  assert.equal(isOverFileLimit(150, 150), false)
  assert.equal(isOverFileLimit(151, 150), true)
  assert.match(fileLimitMessage(151, 150), /151 files/)
  assert.match(fileLimitMessage(151, 150), /was not run/)
})

test('reads the node action inputs and the pull request event', () => {
  const settings = resolveActionEnv(
    {
      INPUT_CODERABBIT_API_KEY: 'key',
      INPUT_FORGEJO_TOKEN: 'tok',
      INPUT_MAX_FILES: '10',
      GITHUB_API_URL: 'https://git.example/api/v1',
      GITHUB_REPOSITORY: 'acme/app',
      GITHUB_SERVER_URL: 'https://git.example',
      GITHUB_RUN_ID: '9',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_TOKEN: 'actions-token',
    },
    { pull_request: { number: 4, head: { sha: 'abc' }, base: { ref: 'main' } } },
  )
  assert.equal(settings.CODERABBIT_API_KEY, 'key')
  assert.equal(settings.CODERABBIT_TOKEN, 'tok')
  assert.equal(settings.PR_NUMBER, '4')
  assert.equal(settings.HEAD_SHA, 'abc')
  assert.equal(settings.BASE_REF, 'main')
  assert.equal(settings.RUN_URL, 'https://git.example/acme/app/actions/runs/9')
  assert.equal(settings.HISTORY_TOKEN, 'actions-token')
  assert.equal(repositoryGitUrl(settings.SERVER_URL, settings.REPOSITORY), 'https://git.example/acme/app.git')
})

test('rejects a bad file cap', () => {
  assert.throws(() => parseMaxFiles('nope'), /positive integer/)
  assert.equal(parseMaxFiles('150'), 150)
})

test('parses agent findings and ignores other events', () => {
  const stream = [
    JSON.stringify({ type: 'heartbeat' }),
    JSON.stringify({ type: 'finding', severity: 'minor', fileName: 'b.js', startLine: 2, title: 'Later' }),
    JSON.stringify({
      type: 'finding',
      severity: 'critical',
      fileName: 'a.js',
      startLine: 9,
      endLine: 11,
      title: 'First',
      comment: 'Fix it',
    }),
    'not json',
    JSON.stringify({ type: 'complete', status: 'review_completed', outcome: 'completed' }),
  ].join('\n')
  const parsed = parseAgentStream(stream)
  assert.equal(parsed.findings[0].severity, 'critical')
  assert.equal(parsed.findings[1].title, 'Later')
  assert.equal(reviewFailed(parsed.complete, null, 0), false)
  assert.equal(reviewFailed(parsed.complete, null, 1), true)
  assert.equal(reviewFailed({ outcome: 'completed', unreviewedFileCount: 2 }, null, 0), true)
})

test('builds inline comments on the new file line', () => {
  const review = buildReview(
    [
      {
        severity: 'major',
        fileName: 'D:/repo/src/app.js',
        startLine: 4,
        endLine: 6,
        title: 'Leak',
        comment: 'Close the handle.',
      },
    ],
    { workspace: 'D:/repo', runUrl: 'https://git.example/run/1' },
  )
  assert.equal(review.comments.length, 1)
  assert.equal(review.comments[0].path, 'src/app.js')
  assert.equal(review.comments[0].new_position, 4)
  assert.equal(review.comments[0].extra_lines_count, 2)
  assert.match(review.comments[0].body, /Close the handle/)
  assert.match(review.body, /src\/app\.js:4/)
  assert.match(review.body, /Job log/)
  assert.doesNotMatch(review.body, /Close the handle/)
})

test('keeps findings without a line in the review body', () => {
  const review = buildReview([{ severity: 'info', fileName: 'README.md', title: 'Docs', comment: 'Add a note.' }])
  assert.equal(review.comments.length, 0)
  assert.match(review.body, /Add a note/)
})

test('posts a Forgejo review as a comment', async () => {
  const calls = []
  await publishReview({
    request: async (method, path, body) => {
      calls.push({ method, path, body })
      return { id: 1 }
    },
    repo: 'shark5060/CodeRabbit',
    pr: '4',
    body: 'hello',
    comments: [{ path: 'a.js', body: 'x', new_position: 1 }],
    commitId: 'abc',
  })
  assert.equal(calls[0].path, '/repos/shark5060/CodeRabbit/pulls/4/reviews')
  assert.equal(calls[0].body.event, 'COMMENT')
  assert.equal(calls[0].body.commit_id, 'abc')
  assert.equal(calls[0].body.comments[0].new_position, 1)
})

test('omits the comments field when there is nothing to put on a line', async () => {
  let payload
  await publishReview({
    request: async (_method, _path, body) => {
      payload = body
      return { id: 2 }
    },
    repo: 'shark5060/CodeRabbit',
    pr: '4',
    body: 'summary',
    comments: [],
    commitId: 'abc',
  })
  assert.equal(Object.hasOwn(payload, 'comments'), false)
})

test('treats a path through a directory link as this script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coderabbit-'))
  const realDir = join(dir, 'run')
  const linkDir = join(dir, 'var-run')
  mkdirSync(realDir)
  const file = join(realDir, 'review.mjs')
  writeFileSync(file, '')
  symlinkSync(realDir, linkDir, 'junction')
  assert.equal(scriptMatchesEntry(join(linkDir, 'review.mjs'), file), true)
  assert.equal(scriptMatchesEntry(join(dir, 'missing.mjs'), file), false)
  rmSync(dir, { recursive: true, force: true })
})

test('strips the checkout prefix from finding paths', () => {
  assert.equal(repoRelativePath('D:/repo/src/a.js', 'D:/repo'), 'src/a.js')
  assert.equal(repoRelativePath('./src/a.js'), 'src/a.js')
})
