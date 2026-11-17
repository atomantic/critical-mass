# Release Changelogs

This directory contains detailed release notes for each version of Critical Mass.

## Structure

Each version has its own markdown file:

```
v{major}.{minor}.{patch}.md
```

## Format

```markdown
# Release v{version} - {Descriptive Title}

Released: YYYY-MM-DD

## Overview

Brief summary of the release.

## New Features

- Feature description

## Bug Fixes

- Fix description

## Improvements

- Improvement description
```

## Per-PR fragments

Every PR adds exactly one fragment, `.changelogs/next-<slug>.md` (`next-issue-<N>.md` for issue work), holding its user-facing bullet(s) written for a user of the app. Nothing else in a PR touches a shared changelog file (`CHANGELOG.md` carries no entries), so PRs never conflict on it. At release time `node scripts/fold-changelog.js X.Y.Z` folds all fragments into a draft `v{version}.md` and deletes them; the releaser then groups and edits it.

## Creating a New Changelog

See [the release procedure](../docs/RELEASING.md) for the complete PR, CI, and publication workflow.

1. Run `node scripts/fold-changelog.js {version}` to create `.changelogs/v{version}.md` from the fragments, then edit it
2. Update `package.json` version
3. Commit both together

## Best Practices

- Use clear, descriptive headings
- Group related changes
- Explain the "why" not just the "what"
- Include technical details where helpful
