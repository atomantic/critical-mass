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

## Creating a New Changelog

1. Create changelog file: `.changelogs/v{version}.md`
2. Update `package.json` version
3. Commit both together

## Best Practices

- Use clear, descriptive headings
- Group related changes
- Explain the "why" not just the "what"
- Include technical details where helpful
