## Releases
- **[issue-1968] Release checks run in the workflows** — a new version without its release notes now fails the Release workflow before any tag is created, and the image publish fails unless both linux/amd64 and linux/arm64 are in the pushed manifest.
