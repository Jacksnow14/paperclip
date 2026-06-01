---
name: github-pr
description: >
  Open, list, or merge GitHub pull requests from an agent heartbeat using the
  `gh` CLI. Use when an issue requires creating a PR from the current branch,
  checking PR status, or merging after CI passes. Auth is pre-configured via the
  system git credential store — no token handling required.
---

# GitHub PR Skill

`gh` CLI is installed at `/usr/bin/gh` and authenticated via the system git credential store (username: Jacksnow14, repo: github.com/Jacksnow14/paperclip).

**Never echo or log the token.** Auth is handled transparently by `gh`; you do not need to set `GH_TOKEN` manually.

## Create a PR

```bash
# From the feature branch, one command:
gh pr create \
  --base master \
  --title "feat: your title here" \
  --body "$(cat <<'EOF'
## Summary
- What changed and why

## Test plan
- [ ] Tests pass

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

The command prints the PR URL on success. Capture it and link it in the issue comment.

## Check PR status

```bash
gh pr status            # PRs relevant to current branch
gh pr view              # details for current branch's PR
gh pr checks            # CI check status
```

## Merge a PR

```bash
# Merge after CI passes (squash recommended):
gh pr merge --squash --delete-branch
```

## Full reference

```
gh pr --help
gh pr create --help
gh pr merge --help
```

## Workflow pattern for a heartbeat

```bash
# 1. Ensure branch is pushed
git push -u origin HEAD

# 2. Create PR (capture URL)
PR_URL=$(gh pr create --base master --title "..." --body "..." 2>&1 | tail -1)

# 3. Link URL in the issue comment via Paperclip API
# POST /api/issues/{issueId}/comments  { "body": "PR opened: $PR_URL" }
```

## Notes

- The repo remote is `https://github.com/Jacksnow14/paperclip`
- `gh` version 2.4.0 — `gh pr merge --auto` is **not** available in this version; check CI and merge explicitly
- If auth fails (e.g. token expired), re-run: `printf 'protocol=https\nhost=github.com\n' | git credential fill | grep password | cut -d= -f2 | gh auth login --with-token`
