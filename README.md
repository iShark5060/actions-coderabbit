# CodeRabbit

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/iShark5060/actions-coderabbit/ci.yml?style=flat-square&label=CI)](https://github.com/iShark5060/actions-coderabbit/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/Node-%3E%3D26-339933?logo=node.js&logoColor=white&style=flat-square)
[![Cursor](https://img.shields.io/badge/Cursor-IDE-141414?logo=cursor&logoColor=white&style=flat-square)](https://cursor.com)

Review a Forgejo pull request with the CodeRabbit CLI and post the findings as a review. The calling workflow decides when it runs. This repo only supplies the action.

```yaml
name: CodeRabbit

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled]

jobs:
  review:
    if: contains(github.event.pull_request.labels.*.name, 'coderabbit')
    runs-on: build-node26
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0

      - name: Install unzip
        run: apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y openssl unzip

      - uses: iShark5060/actions-coderabbit@v1
        with:
          coderabbit_api_key: ${{ secrets.CODERABBIT_API_KEY }}
          forgejo_token: ${{ secrets.CODERABBIT_TOKEN }}
```

Inputs live in `action.yml`.

## Gotchas

- Reference a **published tag** (`@v1`). Publishing a GitHub release runs the same build-and-tag flow as the other actions and moves `v1` to that release.
- `CODERABBIT_API_KEY` is a CodeRabbit Agentic API key. `CODERABBIT_TOKEN` is the Forgejo token for the account that should own the review, same pattern as `SAYORI_TOKEN`. That account needs Write on the repo.
- The job fails with a warning when the pull request changes more than 150 files, and CodeRabbit is not called. 150 files still runs.
- Use `build-node26`. The CLI is a glibc binary, and `light-node26` is Alpine. The binary asks for `/lib64/ld-linux-x86-64.so.2`, which that image does not have. A gcompat shim can start it, and the process then aborts. `build-node26` already has git and curl. The installer also needs the `unzip` and `openssl` commands, so install those before the action.

## License

MIT. See [LICENSE](LICENSE).
